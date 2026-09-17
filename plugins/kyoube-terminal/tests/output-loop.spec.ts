import { describe, expect, it } from "vitest";
import { RETRY_BASE_MS, RETRY_MAX_MS, runOutputLoop, type OutputLoopState, type WaitResult } from "../src/ui/output-loop.js";
import { createSessionStream, OUTPUT_GAP_NOTICE, SCROLLBACK_TRUNCATED_NOTICE, type TerminalStreamEvent } from "../src/ui/session-stream.js";

/** Lets the pending microtasks and one macrotask run, so the loop reaches its next `wait`. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const output = (seq: number, data: string): TerminalStreamEvent => ({ seq, type: "output", data });
const alive = (events: TerminalStreamEvent[], truncated = false): WaitResult => ({ session: { alive: true, exitCode: null }, events, truncated });
const exited = (events: TerminalStreamEvent[], exitCode: number): WaitResult => ({ session: { alive: false, exitCode }, events, truncated: false });

/**
 * A scripted worker: every `wait` the loop issues is recorded with its `afterSeq` and parked
 * until the test answers or fails it, oldest first — the same shape as the real long-poll.
 */
function harness() {
  const written: string[] = [];
  const notices: string[] = [];
  const states: OutputLoopState[] = [];
  const sleeps: number[] = [];
  const calls: number[] = [];
  const parked: Array<{ resolve: (result: WaitResult) => void; reject: (error: unknown) => void }> = [];
  const stream = createSessionStream({
    apply: (event) => written.push(event.type === "output" ? event.data : `<exit ${event.exitCode}>`),
    notice: (text) => notices.push(text),
  });
  const generation = stream.beginSession();
  const start = (gen = generation) =>
    runOutputLoop({
      stream,
      generation: gen,
      wait: (afterSeq) =>
        new Promise<WaitResult>((resolve, reject) => {
          calls.push(afterSeq);
          parked.push({ resolve, reject });
        }),
      onState: (state) => states.push(state),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
  const answer = async (result: WaitResult) => {
    parked.shift()!.resolve(result);
    await tick();
  };
  const fail = async (error: unknown) => {
    parked.shift()!.reject(error);
    await tick();
  };
  return { stream, generation, start, answer, fail, written, notices, states, sleeps, calls, parked };
}

describe("runOutputLoop", () => {
  it("applies each poll's events in order and asks for the next from the last seq seen", async () => {
    const { start, answer, written, calls, states } = harness();
    start();
    expect(calls).toEqual([0]);
    await answer(alive([output(1, "a")]));
    expect(written).toEqual(["a"]);
    expect(calls).toEqual([0, 1]);
    await answer(alive([output(2, "b"), output(3, "c")]));
    expect(written).toEqual(["a", "b", "c"]);
    expect(calls).toEqual([0, 1, 3]);
    // Live is reported once, not once per poll.
    expect(states).toEqual([{ kind: "connecting" }, { kind: "live" }]);
  });

  it("polls again straight away after an empty answer, without sleeping", async () => {
    const { start, answer, calls, sleeps } = harness();
    start();
    await answer(alive([]));
    expect(calls).toEqual([0, 0]);
    expect(sleeps).toEqual([]);
  });

  it("surfaces the scrollback notice on the first poll and the gap notice when a later poll fell behind", async () => {
    const { start, answer, notices } = harness();
    start();
    await answer(alive([output(5, "tail")], true));
    expect(notices).toEqual([SCROLLBACK_TRUNCATED_NOTICE]);
    await answer(alive([output(6, "more")]));
    expect(notices).toEqual([SCROLLBACK_TRUNCATED_NOTICE]);
    await answer(alive([output(40, "late")], true));
    expect(notices).toEqual([SCROLLBACK_TRUNCATED_NOTICE, OUTPUT_GAP_NOTICE]);
  });

  it("stops after the exit event and reports ended", async () => {
    const { start, answer, written, states, calls } = harness();
    const loop = start();
    await answer(exited([output(1, "bye"), { seq: 2, type: "exit", exitCode: 0 }], 0));
    expect(written).toEqual(["bye", "<exit 0>"]);
    expect(states.at(-1)).toEqual({ kind: "ended" });
    expect(calls).toEqual([0]);
    await loop.done;
  });

  it("retries a transient failure with growing delays and recovers", async () => {
    const { start, answer, fail, states, sleeps, calls } = harness();
    start();
    await fail(new Error("Plugin action failed: TIMEOUT"));
    expect(states.at(-1)).toEqual({ kind: "retrying", error: "Plugin action failed: TIMEOUT", attempt: 1 });
    expect(sleeps).toEqual([RETRY_BASE_MS]);
    await fail(new Error("Plugin action failed: TIMEOUT"));
    expect(sleeps).toEqual([RETRY_BASE_MS, RETRY_BASE_MS * 2]);
    expect(calls).toEqual([0, 0, 0]);
    await answer(alive([output(1, "ok")]));
    expect(states.at(-1)).toEqual({ kind: "live" });
    // A success resets the backoff.
    await fail(new Error("Plugin action failed: TIMEOUT"));
    expect(sleeps).toEqual([RETRY_BASE_MS, RETRY_BASE_MS * 2, RETRY_BASE_MS]);
  });

  it("caps the retry delay", async () => {
    const { start, fail, sleeps } = harness();
    start();
    for (let i = 0; i < 8; i += 1) await fail(new Error("worker restarting"));
    expect(Math.max(...sleeps)).toBe(RETRY_MAX_MS);
    expect(sleeps.at(-1)).toBe(RETRY_MAX_MS);
  });

  it("gives up on a failure no retry can fix and reports it with its code", async () => {
    const { start, fail, states, calls } = harness();
    const loop = start();
    // The host rejects with a plain object, not an Error (see error-code.ts); WORKER_ERROR is
    // its code for "the worker's handler threw", so the message carries the worker's own code.
    await fail({ code: "WORKER_ERROR", message: "Plugin action failed: not_found: no session term-x" });
    expect(states.at(-1)).toEqual({ kind: "failed", error: "Plugin action failed: not_found: no session term-x", code: "not_found" });
    expect(calls).toEqual([0]);
    await loop.done;
  });

  it("keeps retrying when a crash message merely mentions a permanent code", async () => {
    const { start, fail, states, calls } = harness();
    start();
    // Not the worker's handler talking: the host reports the worker itself going away, and pads
    // the message with the worker's stderr — which may contain any word at all.
    await fail({ code: "WORKER_UNAVAILABLE", message: "Plugin worker exited: invalid memory access at 0x0" });
    expect(states.at(-1)).toMatchObject({ kind: "retrying", attempt: 1 });
    expect(calls).toEqual([0, 0]);
  });

  it("stop() ends the loop and a late answer is not written to the terminal", async () => {
    const { start, answer, written, calls, states } = harness();
    const loop = start();
    loop.stop();
    await answer(alive([output(1, "late")]));
    expect(written).toEqual([]);
    expect(calls).toEqual([0]);
    expect(states.at(-1)).toEqual({ kind: "connecting" }); // nothing reported after stop
    await loop.done;
  });

  it("ends when the session generation moves on and applies nothing from the old session", async () => {
    const { start, answer, stream, written, calls } = harness();
    const loop = start();
    stream.beginSession();
    await answer(alive([output(1, "old")]));
    expect(written).toEqual([]);
    expect(calls).toEqual([0]);
    await loop.done;
  });
});
