import { describe, expect, it } from "vitest";
import { HELLO_ATTEMPTS, HELLO_RETRY_MS, startHello, type HelloTimers } from "../src/handshake.js";

/**
 * A fake clock: `run()` fires whatever is scheduled, so the retry schedule is
 * exercised without waiting on real time (and without a DOM — `sdk.ts` installs
 * itself on import and needs a window, which is why the scheduling lives apart
 * from it).
 */
function fakeTimers() {
  let next = 1;
  const scheduled = new Map<number, { fn: () => void; ms: number }>();
  const cleared: number[] = [];
  const timers: HelloTimers = {
    setTimeout: (fn, ms) => { const handle = next++; scheduled.set(handle, { fn, ms }); return handle; },
    clearTimeout: (handle) => { scheduled.delete(handle as number); cleared.push(handle as number); },
  };
  /** Fires every timer currently scheduled (each fires at most once, as a real one does). */
  const run = () => {
    for (const [handle, entry] of [...scheduled]) {
      scheduled.delete(handle);
      entry.fn();
    }
  };
  return { timers, run, cleared, pending: () => scheduled.size, delays: () => [...scheduled.values()].map((entry) => entry.ms) };
}

describe("startHello", () => {
  it("posts once immediately and then on the retry interval", () => {
    const clock = fakeTimers();
    let sent = 0;
    startHello(() => { sent += 1; }, clock.timers);
    // Ruling P4-R29: the first hello still goes out synchronously at install,
    // exactly as it did before — the retries are a backstop, not a delay.
    expect(sent).toBe(1);
    expect(clock.delays()).toEqual([HELLO_RETRY_MS]);
    clock.run();
    expect(sent).toBe(2);
    clock.run();
    expect(sent).toBe(3);
  });

  it("stops the moment the host answers, and cancels the pending retry", () => {
    const clock = fakeTimers();
    let sent = 0;
    const answered = startHello(() => { sent += 1; }, clock.timers);
    clock.run();
    expect(sent).toBe(2);
    answered();
    expect(clock.pending()).toBe(0);
    expect(clock.cleared).toHaveLength(1);
    // Nothing more is posted, however long the page lives.
    clock.run();
    clock.run();
    expect(sent).toBe(2);
  });

  it("gives up after a bounded number of attempts", () => {
    const clock = fakeTimers();
    let sent = 0;
    startHello(() => { sent += 1; }, clock.timers);
    for (let i = 0; i < HELLO_ATTEMPTS + 10; i += 1) clock.run();
    // A frame nobody is listening to falls silent rather than posting for the
    // life of the page; `ready()` simply stays pending, as it always has.
    expect(sent).toBe(HELLO_ATTEMPTS);
    expect(clock.pending()).toBe(0);
    // The whole schedule is a few seconds — far longer than a listener takes to
    // attach, and short enough that a dead frame stops quickly.
    expect(HELLO_ATTEMPTS * HELLO_RETRY_MS).toBeGreaterThanOrEqual(3_000);
    expect(HELLO_ATTEMPTS * HELLO_RETRY_MS).toBeLessThanOrEqual(10_000);
  });

  it("is safe to answer twice, and after the attempts have run out", () => {
    const clock = fakeTimers();
    let sent = 0;
    const answered = startHello(() => { sent += 1; }, clock.timers);
    answered();
    answered();
    expect(clock.cleared).toHaveLength(1);
    for (let i = 0; i < HELLO_ATTEMPTS; i += 1) clock.run();
    expect(sent).toBe(1);
    expect(() => answered()).not.toThrow();
  });
});
