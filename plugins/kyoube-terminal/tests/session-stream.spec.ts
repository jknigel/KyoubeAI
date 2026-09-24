import { describe, expect, it } from "vitest";
import {
  createSessionStream,
  OUTPUT_GAP_NOTICE,
  SCROLLBACK_TRUNCATED_NOTICE,
  type ReplayResult,
  type TerminalStreamEvent,
} from "../src/ui/session-stream.js";

const out = (seq: number, data: string): TerminalStreamEvent => ({ seq, type: "output", data });
const replayed = (events: TerminalStreamEvent[], truncated = false): ReplayResult => ({ events, truncated });

function harness() {
  const applied: string[] = [];
  const notices: string[] = [];
  /** Both of the above, in the order the terminal receives them. */
  const written: string[] = [];
  const stream = createSessionStream({
    apply: (event) => {
      const text = event.type === "output" ? event.data : `exit:${event.exitCode}`;
      applied.push(text);
      written.push(text);
    },
    notice: (text) => {
      notices.push(text);
      written.push(text);
    },
  });
  return { applied, notices, written, stream };
}

/** A fetch whose answer the test releases by hand, so a session switch can land mid-flight. */
function deferred() {
  let release!: (result: ReplayResult) => void;
  const fetched: number[] = [];
  const fetch = (afterSeq: number) => {
    fetched.push(afterSeq);
    return new Promise<ReplayResult>((resolve) => {
      release = resolve;
    });
  };
  return { fetch, fetched, release: (result: ReplayResult) => release(result) };
}

describe("createSessionStream", () => {
  it("applies replayed events in order, starts the next fetch past the last seq, and de-duplicates", async () => {
    const { stream, applied } = harness();
    const generation = stream.beginSession();
    const fetched: number[] = [];
    const fetch = (events: TerminalStreamEvent[]) => async (afterSeq: number) => {
      fetched.push(afterSeq);
      return replayed(events);
    };
    await stream.replay(generation, fetch([out(1, "a"), out(2, "b")]));
    // The next answer overlaps on seq 2 (a resume replay and the first poll after it can share it).
    await stream.replay(generation, fetch([out(2, "b"), out(3, "c"), { seq: 4, type: "exit", exitCode: 0 }]));
    expect(applied).toEqual(["a", "b", "c", "exit:0"]);
    expect(fetched).toEqual([0, 2]);
    expect(stream.lastSeq).toBe(4);
  });

  it("answers the caller but applies nothing when the session moved on mid-flight", async () => {
    const { stream, applied } = harness();
    const first = stream.beginSession();
    const fetch = deferred();
    const pending = stream.replay(first, fetch.fetch);
    stream.beginSession(); // a resume retires the first session while its fetch is in flight
    fetch.release(replayed([out(1, "stale")]));
    const result = await pending;
    expect(result.events).toHaveLength(1); // the caller still gets the answer
    expect(applied).toEqual([]);
    expect(stream.lastSeq).toBe(0); // the new session's mark was not moved by the old answer
  });

  it("fetches from 0 for a generation that was already retired, and leaves the live mark alone", async () => {
    const { stream, applied } = harness();
    const first = stream.beginSession();
    const second = stream.beginSession();
    await stream.replay(second, async () => replayed([out(1, "live")]));
    const stale = deferred();
    const pending = stream.replay(first, stale.fetch);
    stale.release(replayed([out(9, "stale")]));
    await pending;
    expect(stale.fetched).toEqual([0]);
    expect(applied).toEqual(["live"]);
    expect(stream.lastSeq).toBe(1);
  });

  it("resets the seq mark for each new session", async () => {
    const { stream } = harness();
    const first = stream.beginSession();
    await stream.replay(first, async () => replayed([out(7, "x")]));
    expect(stream.lastSeq).toBe(7);
    const second = stream.beginSession();
    expect(second).toBe(first + 1);
    expect(stream.generation).toBe(second);
    expect(stream.lastSeq).toBe(0);
  });

  it("marks a fresh attach whose scrollback the worker had already trimmed", async () => {
    const { stream, notices } = harness();
    const generation = stream.beginSession();
    await stream.replay(generation, async () => replayed([out(9, "i")], true));
    expect(notices).toEqual([SCROLLBACK_TRUNCATED_NOTICE]);
    await stream.replay(generation, async () => replayed([out(10, "j")]));
    expect(notices).toEqual([SCROLLBACK_TRUNCATED_NOTICE]);
  });

  // `truncated` on a fetch from seq N means the worker trimmed events past N before the page got
  // to them: output between N and the oldest survivor is gone. With polling, the scrollback cap is
  // also the window between two polls, so a chatty command on a slow link can hit this mid-session;
  // the loss has to be visible where it happened, not a silent hole.
  it("marks output lost mid-session where the gap is, when the worker trimmed past the last seq applied", async () => {
    const { stream, notices, written } = harness();
    const generation = stream.beginSession();
    await stream.replay(generation, async () => replayed([out(1, "a")]));
    const fetched: number[] = [];
    await stream.replay(generation, async (afterSeq) => {
      fetched.push(afterSeq);
      return replayed([out(9, "i"), out(10, "j")], true);
    });
    expect(fetched).toEqual([1]);
    expect(notices).toEqual([OUTPUT_GAP_NOTICE]);
    expect(written).toEqual(["a", OUTPUT_GAP_NOTICE, "i", "j"]);
    // A later fetch that is not truncated says nothing more.
    await stream.replay(generation, async () => replayed([out(11, "k")]));
    expect(notices).toEqual([OUTPUT_GAP_NOTICE]);
  });
});
