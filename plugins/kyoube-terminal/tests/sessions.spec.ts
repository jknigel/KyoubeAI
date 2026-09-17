import { describe, expect, it } from "vitest";
import { MAX_EVENT_BYTES, OUTPUT_FLUSH_MS, SessionManager, type TerminalStreamEvent } from "../src/sessions.js";
import { fakeSpawner } from "./fake-pty.js";

function setup(opts: { scrollbackBytes?: number; exitOnKill?: boolean; deadRetentionMs?: number } = {}) {
  let now = 1_000_000;
  let counter = 0;
  const spawner = fakeSpawner({ exitOnKill: opts.exitOnKill });
  // Every timer is injected so a test decides exactly when one fires: `flush()` runs every
  // scheduled callback, `fire(ms)` only those armed with that delay (the output-coalescing
  // window vs a wait's timeout), `pendingTimers()` proves none was left armed.
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 1;
  const manager = new SessionManager({
    spawn: spawner.spawn,
    scrollbackBytes: opts.scrollbackBytes,
    deadRetentionMs: opts.deadRetentionMs,
    now: () => now,
    randomId: () => `id${++counter}`,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });
  const open = (ownerUserId = "u1", companyId = "c1") =>
    manager.open({ ownerUserId, companyId, cols: 80, rows: 24, shell: "/bin/bash", idleTimeoutMs: 60_000, maxSessionsPerUser: 2 });
  const flush = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const { fn } of due) fn();
  };
  const fire = (ms: number) => {
    for (const [id, timer] of [...timers]) {
      if (timer.ms !== ms) continue;
      timers.delete(id);
      timer.fn();
    }
  };
  return {
    manager,
    spawner,
    open,
    flush,
    fire,
    pendingTimers: () => timers.size,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("SessionManager", () => {
  it("opens a session and spawns a pty with the request", () => {
    const { open, spawner } = setup();
    const { session } = open();
    expect(session).toMatchObject({ id: "term-id1", ownerUserId: "u1", companyId: "c1", cols: 80, rows: 24, alive: true, exitCode: null });
    expect(spawner.ptys[0]?.request).toEqual({ shell: "/bin/bash", cols: 80, rows: 24 });
  });

  it("records sequenced output events and replays them on attach", () => {
    const { open, spawner, manager, flush } = setup();
    const { session } = open();
    spawner.ptys[0]!.emitData("hello ");
    flush(); // each coalescing window becomes one event, so close one between the two writes
    spawner.ptys[0]!.emitData("world");
    flush();
    expect(manager.attach(session.id, "u1", "c1", 0).events).toEqual([
      { seq: 1, type: "output", data: "hello " },
      { seq: 2, type: "output", data: "world" },
    ]);
    const attached = manager.attach(session.id, "u1", "c1", 1);
    expect(attached.events).toEqual([{ seq: 2, type: "output", data: "world" }]);
    expect(attached.truncated).toBe(false);
  });

  it("coalesces output written inside one window into a single event", () => {
    const { open, spawner, manager, flush, pendingTimers } = setup();
    const { session } = open();
    const events = () => manager.attach(session.id, "u1", "c1", 0).events;
    spawner.ptys[0]!.emitData("hello ");
    spawner.ptys[0]!.emitData("world");
    expect(pendingTimers()).toBe(1); // one window is open for both writes
    flush();
    expect(events()).toEqual([{ seq: 1, type: "output", data: "hello world" }]);
    spawner.ptys[0]!.emitData("!");
    flush();
    expect(events()).toEqual([
      { seq: 1, type: "output", data: "hello world" },
      { seq: 2, type: "output", data: "!" },
    ]);
  });

  it("splits a coalesced burst larger than MAX_EVENT_BYTES into ordered events", () => {
    const { open, spawner, manager, flush } = setup();
    const { session } = open();
    const head = "a".repeat(MAX_EVENT_BYTES - 5);
    const tail = "b".repeat(15);
    spawner.ptys[0]!.emitData(head);
    spawner.ptys[0]!.emitData(tail);
    flush();
    const events = manager.attach(session.id, "u1", "c1", 0).events as Array<TerminalStreamEvent & { data: string }>;
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events.map((e) => e.data.length)).toEqual([MAX_EVENT_BYTES, 10]);
    expect(events.map((e) => e.data).join("")).toBe(head + tail);
  });

  it("flushes pending output before an exit event and leaves no timer armed", () => {
    const { open, spawner, manager, pendingTimers } = setup();
    const { session } = open();
    spawner.ptys[0]!.emitData("bye");
    spawner.ptys[0]!.emitExit(0); // real pty exit path
    expect(manager.attach(session.id, "u1", "c1", 0).events).toEqual([
      { seq: 1, type: "output", data: "bye" },
      { seq: 2, type: "exit", exitCode: 0 },
    ]);
    expect(pendingTimers()).toBe(0);
  });

  it("flushes pending output before a terminate()-synthesised exit", () => {
    const { open, spawner, manager, pendingTimers } = setup({ exitOnKill: false });
    const { session } = open();
    spawner.ptys[0]!.emitData("bye");
    manager.close(session.id, "u1", "c1");
    expect(manager.attach(session.id, "u1", "c1", 0).events).toEqual([
      { seq: 1, type: "output", data: "bye" },
      { seq: 2, type: "exit", exitCode: -1 },
    ]);
    expect(pendingTimers()).toBe(0);
  });

  it("attach flushes pending output so a replay never misses buffered bytes", () => {
    const { open, spawner, manager } = setup();
    const { session } = open();
    spawner.ptys[0]!.emitData("pending");
    // No flush(): the window is still open, yet the bytes must already be part of the replay.
    expect(manager.attach(session.id, "u1", "c1", 0).events).toEqual([{ seq: 1, type: "output", data: "pending" }]);
  });

  it("splits large output into events no bigger than MAX_EVENT_BYTES", () => {
    const { open, spawner, manager, flush } = setup();
    const { session } = open();
    spawner.ptys[0]!.emitData("x".repeat(MAX_EVENT_BYTES + 10));
    flush();
    const sizes = manager.attach(session.id, "u1", "c1", 0).events.map((e) => (e as { data: string }).data.length);
    expect(sizes).toEqual([MAX_EVENT_BYTES, 10]);
  });

  it("splits multibyte output by UTF-8 byte size without breaking a surrogate pair", () => {
    const { open, spawner, manager, flush } = setup();
    const { session } = open();
    const emoji = "\u{1F600}"; // grinning face: 4 UTF-8 bytes, a UTF-16 surrogate pair
    const count = Math.floor(MAX_EVENT_BYTES / 4) + 3;
    const input = emoji.repeat(count);
    spawner.ptys[0]!.emitData(input);
    flush();
    const parts = manager.attach(session.id, "u1", "c1", 0).events.map((e) => (e as { data: string }).data);
    // The first part fills exactly to the byte cap; the remaining 3 emoji (12 bytes) spill into a second part.
    expect(parts.map((part) => Buffer.byteLength(part, "utf8"))).toEqual([MAX_EVENT_BYTES, 12]);
    for (const part of parts) {
      expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(MAX_EVENT_BYTES);
      expect(/[\uD800-\uDBFF]$/.test(part)).toBe(false); // never ends on a lone high surrogate
      expect(/^[\uDC00-\uDFFF]/.test(part)).toBe(false); // never starts on a lone low surrogate
    }
    expect(parts.join("")).toBe(input);
  });

  it("trims the scrollback buffer and reports truncation", () => {
    const { open, spawner, manager, flush } = setup({ scrollbackBytes: 10 });
    const { session } = open();
    for (const text of ["12345", "67890", "abcde"]) {
      spawner.ptys[0]!.emitData(text);
      flush();
    }
    const attached = manager.attach(session.id, "u1", "c1", 0);
    expect(attached.events.map((e) => (e as { data: string }).data)).toEqual(["67890", "abcde"]);
    expect(attached.truncated).toBe(true);
  });

  it("honours a per-session scrollback cap over the manager default", () => {
    const { manager, spawner, flush } = setup(); // manager-wide default is 256 KiB here
    const { session } = manager.open({
      ownerUserId: "u1",
      companyId: "c1",
      cols: 80,
      rows: 24,
      shell: "/bin/bash",
      idleTimeoutMs: 60_000,
      maxSessionsPerUser: 2,
      scrollbackBytes: 10,
    });
    for (const text of ["12345", "67890", "abcde"]) {
      spawner.ptys[0]!.emitData(text);
      flush();
    }
    const attached = manager.attach(session.id, "u1", "c1", 0);
    expect(attached.events.map((e) => (e as { data: string }).data)).toEqual(["67890", "abcde"]);
    expect(attached.truncated).toBe(true);
  });

  it("forwards input and resize to the pty and rejects other users", () => {
    const { open, spawner, manager } = setup();
    const { session } = open();
    manager.input(session.id, "u1", "c1", "ls\n");
    manager.resize(session.id, "u1", "c1", 120, 40);
    expect(spawner.ptys[0]!.written).toEqual(["ls\n"]);
    expect(spawner.ptys[0]!.resizes).toEqual([[120, 40]]);
    expect(() => manager.input(session.id, "u2", "c1", "rm -rf /\n")).toThrow("forbidden");
    expect(() => manager.attach(session.id, "u2", "c1", 0)).toThrow("forbidden");
    expect(() => manager.input("nope", "u1", "c1", "x")).toThrow("not_found");
  });

  it("hides a session from another company", () => {
    const { open, manager } = setup();
    const { session } = open("u1", "c1");
    // Same owner, wrong company: indistinguishable from a session that does not exist.
    expect(() => manager.attach(session.id, "u1", "c2", 0)).toThrow("not_found");
    expect(() => manager.input(session.id, "u1", "c2", "x")).toThrow("not_found");
    expect(() => manager.resize(session.id, "u1", "c2", 100, 40)).toThrow("not_found");
    expect(() => manager.close(session.id, "u1", "c2")).toThrow("not_found");
    expect(() => manager.kill(session.id, "c2")).toThrow("not_found");
    expect(manager.attach(session.id, "u1", "c1", 0).session).toMatchObject({ alive: true });
  });

  it("enforces the per-user session limit only for live sessions", () => {
    const { open, manager } = setup();
    const first = open();
    open();
    expect(() => open()).toThrow("limit");
    manager.close(first.session.id, "u1", "c1");
    expect(() => open()).not.toThrow();
  });

  it("marks exit, records an exit event, and refuses further input", () => {
    const { open, spawner, manager } = setup();
    const { session } = open();
    spawner.ptys[0]!.emitExit(0);
    const attached = manager.attach(session.id, "u1", "c1", 0);
    expect(attached.events.at(-1)).toEqual({ seq: 1, type: "exit", exitCode: 0 });
    expect(attached.session).toMatchObject({ alive: false, exitCode: 0 });
    expect(() => manager.input(session.id, "u1", "c1", "x")).toThrow("closed");
  });

  it("drops pty output and ignores a late real exit once a session has been terminated", () => {
    // Model a real pty: kill() does not report exit synchronously, so terminate() must
    // synthesize the exit itself (as it already does) and any output/exit that arrives
    // afterwards from the still-dying process must be ignored.
    const { manager, spawner, open, flush } = setup({ exitOnKill: false });
    const { session } = open();
    const events = () => manager.attach(session.id, "u1", "c1", 0).events;

    manager.close(session.id, "u1", "c1");

    // Exactly one synthetic exit event was pushed.
    expect(events()).toEqual([{ seq: 1, type: "exit", exitCode: -1 }]);

    // The session is dead immediately: count() and the per-user limit both see it as closed.
    expect(manager.count()).toBe(0);
    expect(() => open()).not.toThrow();
    expect(() => open()).not.toThrow();
    expect(() => open()).toThrow("limit");

    // The real pty has not actually exited yet, so it can still deliver trailing output.
    // That output must be dropped, not appended after the exit event — not even once a
    // coalescing window closes.
    spawner.ptys[0]!.emitData("late");
    flush();
    expect(events()).toEqual([{ seq: 1, type: "exit", exitCode: -1 }]);

    // The real exit eventually arrives; it must not re-fire an exit event, and the session
    // must keep the exit code terminate() already recorded.
    spawner.ptys[0]!.emitExit(0);
    expect(events()).toHaveLength(1);
    expect(manager.attach(session.id, "u1", "c1", 0).session).toMatchObject({ alive: false, exitCode: -1 });
  });

  it("kills idle sessions during sweeps and lists per company", () => {
    const { open, manager, advance, spawner } = setup();
    const a = open("u1", "c1");
    open("u2", "c2");
    advance(30_000);
    manager.input(a.session.id, "u1", "c1", "x");
    advance(45_000);
    expect(manager.sweepIdle()).toEqual({ closed: ["term-id2"], pruned: [] });
    expect(spawner.ptys[1]!.killed).toBe("SIGHUP");
    expect(manager.list("c1").map((s) => s.id)).toEqual([a.session.id]);
    expect(manager.list("c2")[0]).toMatchObject({ alive: false });
  });

  it("keeps a dead session listable and attachable until the retention window passes, then prunes it", () => {
    const { open, manager, advance } = setup({ deadRetentionMs: 60_000 });
    const dead = open("u1", "c1");
    const live = open("u2", "c1");
    manager.close(dead.session.id, "u1", "c1");

    advance(59_000);
    manager.input(live.session.id, "u2", "c1", "x"); // keep the live session out of the idle sweep
    expect(manager.sweepIdle()).toEqual({ closed: [], pruned: [] });
    expect(manager.list("c1").map((s) => s.id)).toEqual([dead.session.id, live.session.id]);
    expect(manager.attach(dead.session.id, "u1", "c1", 0).session).toMatchObject({ alive: false });

    advance(2_000);
    expect(manager.sweepIdle()).toEqual({ closed: [], pruned: [dead.session.id] });
    // Pruned: gone from list(), and attaching to it is a not_found like any unknown id.
    expect(manager.list("c1").map((s) => s.id)).toEqual([live.session.id]);
    expect(() => manager.attach(dead.session.id, "u1", "c1", 0)).toThrow("not_found");
    // The live session and the per-user limit are untouched by the prune.
    expect(manager.count()).toBe(1);
    expect(() => open("u1", "c1")).not.toThrow();
    expect(() => open("u1", "c1")).not.toThrow();
    expect(() => open("u1", "c1")).toThrow("limit");
  });

  it("does not prune a session the same sweep killed for idleness", () => {
    const { open, manager, advance } = setup({ deadRetentionMs: 60_000 });
    const { session } = open();
    advance(60_000);
    expect(manager.sweepIdle()).toEqual({ closed: [session.id], pruned: [] });
    expect(manager.list("c1").map((s) => s.id)).toEqual([session.id]); // retention starts at the kill
    advance(60_000);
    expect(manager.sweepIdle()).toEqual({ closed: [], pruned: [session.id] });
  });

  it("shutdown kills every live session and flushes their pending output first", () => {
    const { open, manager, spawner, pendingTimers } = setup();
    const first = open("u1");
    open("u2");
    spawner.ptys[0]!.emitData("tail");
    manager.shutdown();
    expect(spawner.ptys.every((pty) => pty.killed !== null)).toBe(true);
    expect(manager.count()).toBe(0);
    expect(manager.attach(first.session.id, "u1", "c1", 0).events).toEqual([
      { seq: 1, type: "output", data: "tail" },
      { seq: 2, type: "exit", exitCode: 129 },
    ]);
    expect(pendingTimers()).toBe(0);
  });
});

/**
 * `wait` is the long-poll behind the page's output loop: it answers like `attach` as soon as
 * there is anything past `afterSeq`, and otherwise parks until the next event (output or exit)
 * or its timeout. Upstream never wired its plugin SSE bridge (the stream route answers 501 and
 * the host drops the worker's asynchronous emits), so this is the only way output reaches a tab.
 */
describe("SessionManager.wait", () => {
  const WAIT_MS = 10_000;

  it("answers at once with the events past afterSeq when some already exist", async () => {
    const { open, spawner, manager, flush, pendingTimers } = setup();
    const { session } = open();
    spawner.ptys[0]!.emitData("hello");
    flush();
    const result = await manager.wait(session.id, "u1", "c1", 0, WAIT_MS);
    expect(result.events).toEqual([{ seq: 1, type: "output", data: "hello" }]);
    expect(result.session).toMatchObject({ alive: true });
    expect(result.truncated).toBe(false);
    expect(pendingTimers()).toBe(0); // nothing to wait for, so no timeout was armed
  });

  it("flushes output still inside the coalescing window before answering", async () => {
    const { open, spawner, manager } = setup();
    const { session } = open();
    spawner.ptys[0]!.emitData("pending");
    const result = await manager.wait(session.id, "u1", "c1", 0, WAIT_MS);
    expect(result.events).toEqual([{ seq: 1, type: "output", data: "pending" }]);
  });

  it("parks until the next output event when nothing is past afterSeq", async () => {
    const { open, spawner, manager, fire, pendingTimers } = setup();
    const { session } = open();
    let settled = false;
    const waiting = manager.wait(session.id, "u1", "c1", 0, WAIT_MS).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(pendingTimers()).toBe(1); // the wait's own timeout
    spawner.ptys[0]!.emitData("late");
    fire(OUTPUT_FLUSH_MS);
    const result = await waiting;
    expect(result.events).toEqual([{ seq: 1, type: "output", data: "late" }]);
    expect(pendingTimers()).toBe(0); // the timeout was disarmed by the answer
  });

  it("answers every parked waiter with the same event", async () => {
    const { open, spawner, manager, flush, fire } = setup();
    const { session } = open();
    spawner.ptys[0]!.emitData("one");
    flush();
    const first = manager.wait(session.id, "u1", "c1", 1, WAIT_MS);
    const second = manager.wait(session.id, "u1", "c1", 1, WAIT_MS);
    spawner.ptys[0]!.emitData("two");
    fire(OUTPUT_FLUSH_MS);
    expect((await first).events).toEqual([{ seq: 2, type: "output", data: "two" }]);
    expect((await second).events).toEqual([{ seq: 2, type: "output", data: "two" }]);
  });

  it("answers with the exit event when the shell exits", async () => {
    const { open, spawner, manager, pendingTimers } = setup();
    const { session } = open();
    const waiting = manager.wait(session.id, "u1", "c1", 0, WAIT_MS);
    spawner.ptys[0]!.emitExit(3);
    const result = await waiting;
    expect(result.events).toEqual([{ seq: 1, type: "exit", exitCode: 3 }]);
    expect(result.session).toMatchObject({ alive: false, exitCode: 3 });
    expect(pendingTimers()).toBe(0);
  });

  it("answers when the owner closes the session", async () => {
    const { open, manager } = setup();
    const { session } = open();
    const waiting = manager.wait(session.id, "u1", "c1", 0, WAIT_MS);
    manager.close(session.id, "u1", "c1");
    expect((await waiting).events).toEqual([{ seq: 1, type: "exit", exitCode: 129 }]);
  });

  it("answers with nothing once the timeout elapses", async () => {
    const { open, manager, fire, pendingTimers } = setup();
    const { session } = open();
    const waiting = manager.wait(session.id, "u1", "c1", 0, 5_000);
    fire(5_000);
    const result = await waiting;
    expect(result.events).toEqual([]);
    expect(result.session).toMatchObject({ alive: true });
    expect(pendingTimers()).toBe(0);
  });

  it("answers at once with a zero timeout, exactly like attach", async () => {
    const { open, manager, pendingTimers } = setup();
    const { session } = open();
    const result = await manager.wait(session.id, "u1", "c1", 0, 0);
    expect(result.events).toEqual([]);
    expect(pendingTimers()).toBe(0);
  });

  it("answers a dead session at once instead of parking", async () => {
    const { open, spawner, manager, pendingTimers } = setup();
    const { session } = open();
    spawner.ptys[0]!.emitExit(0);
    const result = await manager.wait(session.id, "u1", "c1", 1, WAIT_MS); // the caller already saw the exit
    expect(result.events).toEqual([]);
    expect(result.session).toMatchObject({ alive: false, exitCode: 0 });
    expect(pendingTimers()).toBe(0);
  });

  it("reports truncation like attach when afterSeq predates the scrollback", async () => {
    const { open, spawner, manager, flush } = setup({ scrollbackBytes: 10 });
    const { session } = open();
    for (const text of ["12345", "67890", "abcde"]) {
      spawner.ptys[0]!.emitData(text);
      flush();
    }
    const result = await manager.wait(session.id, "u1", "c1", 0, WAIT_MS);
    expect(result.events.map((e) => (e as { data: string }).data)).toEqual(["67890", "abcde"]);
    expect(result.truncated).toBe(true);
  });

  it("does not count as activity for the idle timeout", async () => {
    const { open, manager, advance, fire } = setup();
    const { session } = open(); // idle timeout 60 s
    advance(59_000);
    const waiting = manager.wait(session.id, "u1", "c1", 0, 5_000);
    fire(5_000);
    await waiting;
    advance(1_000);
    expect(manager.sweepIdle().closed).toEqual([session.id]);
  });

  it("rejects other users and other companies like attach", async () => {
    const { open, manager } = setup();
    const { session } = open();
    await expect(manager.wait(session.id, "u2", "c1", 0, WAIT_MS)).rejects.toThrow("forbidden");
    await expect(manager.wait(session.id, "u1", "c2", 0, WAIT_MS)).rejects.toThrow("not_found");
    await expect(manager.wait("nope", "u1", "c1", 0, WAIT_MS)).rejects.toThrow("not_found");
  });

  it("is answered by the sweep that kills the session for idleness", async () => {
    const { open, manager, advance } = setup();
    const { session } = open();
    const waiting = manager.wait(session.id, "u1", "c1", 0, WAIT_MS);
    advance(60_000);
    manager.sweepIdle();
    expect((await waiting).session).toMatchObject({ alive: false });
  });

  it("is answered by shutdown and leaves no timer armed", async () => {
    const { open, manager, pendingTimers } = setup();
    const { session } = open();
    const waiting = manager.wait(session.id, "u1", "c1", 0, WAIT_MS);
    manager.shutdown();
    expect((await waiting).events).toEqual([{ seq: 1, type: "exit", exitCode: 129 }]);
    expect(pendingTimers()).toBe(0);
  });
});
