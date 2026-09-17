# Phase 1 — Terminal Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Company owners/admins get a browser terminal inside the KyoubeAI container (a `Terminal` page in the Paperclip UI) to run `claude login`, `pi`, `hermes setup`, `paperclipai …`, and `kyoube doctor`; sessions are server-gated, audited, resumable after a page reload, and idle-expired.

**Architecture:** The `@kyoube/plugin-terminal` worker owns PTY sessions (`@lydell/node-pty`) in a `SessionManager` with a bounded, sequence-numbered scrollback buffer. Keystrokes reach the worker through plugin **actions** (`terminal.input`), output reaches the browser through the plugin **SSE stream** on a per-session random channel, and the UI reconnects/replays through `terminal.attach`. Every action re-checks the caller's company role through `ctx.access.members`.

**Tech Stack:** `@paperclipai/plugin-sdk@2026.831.1` (worker + `/ui` + `/testing`), `@lydell/node-pty@1.1.0` (prebuilt native PTY), `@xterm/xterm@6.0.0` + `@xterm/addon-fit@0.11.0`, React 19 (host-provided at runtime), esbuild, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-05-kyoubeai-architecture-design.md` §7, §10, §13 Phase 1. Builds on the Phase 0 plan (`2026-09-05-phase-0-foundation.md`).

> **Post-execution notes (2026-09-06).** Phase 1 is implemented; where the code differs from the snippets below, the code and the rulings P1-R1..R19 recorded during execution are authoritative. Substantive deviations: output events are byte-bounded (UTF-8, no split surrogate pairs) and coalesced on a 16 ms timer (spec §7's frame cap, which this plan had dropped); `OpenSessionInput.scrollbackBytes` carries the `scrollbackKb` setting per session; dead sessions are pruned 10 minutes after exit; `terminate()` output after a synthetic exit is dropped; the role cache memoises in-flight listings; `minimumHostVersion` stays omitted because upstream never passes its version into the plugin loader (defaults to 0.0.0); the UI reads action functions through refs, reports stream state, mounts the terminal regardless of when `companyId` hydrates, replays on the pump's connect with live events buffered while a replay is pending, and keeps a per-session output tracker; the UI error parser finds the first known code token anywhere in the message; the smoke proves the shell evaluates a command (`echo $MARK-$((6*7))` → `-42`), asserts the UI bundle (by plugin UUID — upstream's UI asset route 500s on a plugin key), the `can_open` data key, and the activity audit; actions verify the session's company and cap `terminal.input` at 1 MiB.

> **Post-release note (2026-09-10).** The SSE stream this plan is built on does not work on Paperclip 2026.831.1 (nor on upstream master at that date): the host never constructs its `PluginStreamBus`, so `GET /api/plugins/:id/bridge/stream/:channel` answers `501 Plugin stream bridge is not enabled` and `usePluginStream` reports "Failed to connect to plugin stream"; independently, the worker manager drops `streams.emit` notifications that carry no invocation id while any RPC is in flight. Output now reaches the page through a new `terminal.wait` long-poll action (answers on the next event past `afterSeq`, on exit, or after a bounded timeout) driven by `src/ui/output-loop.ts`; `StreamPump`, `usePluginStream`, `replay-buffer.ts`, the `channel` field, and `ctx.streams` are gone, and `session-stream.ts` keeps only the generation and seq de-duplication. Plugin version 0.2.1. See the spec §7 (revised) and the CHANGELOG.

## Global Constraints

- Same as Phase 0: SDK pinned to `2026.831.1`; ESM + TypeScript strict + NodeNext (`.js` in relative imports); Conventional Commits.
- Plugin id `kyoube.terminal`; page route `/:companyPrefix/terminal`; action keys are `terminal.open`, `terminal.attach`, `terminal.input`, `terminal.resize`, `terminal.close`, `terminal.list`, `terminal.kill`; data key `terminal.can_open`.
- Worker code never reads `process.env` for configuration except `PATH` and the optional `KYOUBE_CONFIG_PATH`; everything else comes from `/paperclip/kyoube/config.json` (written by the Phase 0 entrypoint) and the plugin's `instanceConfigSchema`.
- Shells are spawned with an explicit environment (`HOME=<config.home>`, `HERMES_HOME=<config.hermesHome>`, `TERM=xterm-256color`, `LANG=C.UTF-8`) and `cwd=<config.home>`; keystrokes and output are never written to logs or the activity log.
- Default gate: company role `owner` or `admin` (configurable via `allowedRoles`); every denial is recorded in the activity log.
- Stream event contract (worker → UI): `{ seq: number; type: "output"; data: string } | { seq: number; type: "exit"; exitCode: number }`; a single event never exceeds 64 KiB of data.
- Errors thrown from actions use the message form `<code>: <human message>` with codes `forbidden | not_found | limit | closed | invalid` so the UI can branch on them.

---

## File structure

```
plugins/kyoube-terminal/
├─ package.json                # + deps: @lydell/node-pty; devDeps: xterm, react; paperclipPlugin.ui
├─ build.mjs                   # + browser UI bundle (dist/ui/index.js), css as text
├─ src/manifest.ts             # capabilities, ui slots, instanceConfigSchema
├─ src/errors.ts               # TerminalError { code }
├─ src/settings.ts             # resolveSettings(raw) with defaults
├─ src/sessions.ts             # SessionManager (pure; PTY + stream injected)
├─ src/auth.ts                 # RoleResolver over ctx.access.members
├─ src/spawn-env.ts            # buildShellEnv()
├─ src/kyoube-config.ts        # reads /paperclip/kyoube/config.json
├─ src/pty.ts                  # createNodePtySpawner() over @lydell/node-pty
├─ src/plugin.ts               # createTerminalPlugin(deps): actions/data/health wiring
├─ src/worker.ts               # default export = createTerminalPlugin(real deps); runWorker()
├─ src/ui/index.tsx            # exports TerminalPage, SidebarEntry
├─ src/ui/SidebarEntry.tsx
├─ src/ui/TerminalPage.tsx     # xterm + stream pump + actions
├─ src/ui/output-tracker.ts    # seq de-duplication (pure)
├─ src/ui/xterm-styles.ts      # injects xterm.css once
├─ src/ui/css.d.ts             # `*.css` module typing
└─ tests/
   ├─ fake-pty.ts              # FakePty + fakeSpawner used by sessions + plugin tests
   ├─ sessions.spec.ts · auth.spec.ts · spawn-env.spec.ts · settings.spec.ts
   ├─ plugin.spec.ts           # replaces the Phase 0 skeleton test
   ├─ output-tracker.spec.ts · sidebar-entry.spec.tsx
docker/Dockerfile              # + native module load check
scripts/smoke.sh               # + terminal round-trip
README.md                      # + Terminal section
```

---

### Task 1: Errors, settings, and the session manager

**Files:**
- Create: `plugins/kyoube-terminal/src/errors.ts`, `plugins/kyoube-terminal/src/settings.ts`, `plugins/kyoube-terminal/src/sessions.ts`, `plugins/kyoube-terminal/tests/fake-pty.ts`
- Test: `plugins/kyoube-terminal/tests/settings.spec.ts`, `plugins/kyoube-terminal/tests/sessions.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  // errors.ts
  export type TerminalErrorCode = "forbidden" | "not_found" | "limit" | "closed" | "invalid";
  export class TerminalError extends Error { readonly code: TerminalErrorCode; constructor(code, message) } // message = `${code}: ${message}`
  // settings.ts
  export interface TerminalSettings { idleTimeoutMinutes: number; maxSessionsPerUser: number; allowedRoles: string[]; shell: string; scrollbackKb: number }
  export const DEFAULT_SETTINGS: TerminalSettings; // 30, 3, ["owner","admin"], "/bin/bash", 256
  export function resolveSettings(raw: Record<string, unknown> | null | undefined): TerminalSettings;
  // sessions.ts
  export interface PtyLike { readonly pid: number; write(data: string): void; resize(cols: number, rows: number): void; kill(signal?: string): void; onData(listener: (data: string) => void): void; onExit(listener: (event: { exitCode: number }) => void): void }
  export interface SpawnRequest { shell: string; cols: number; rows: number }
  export type PtySpawner = (request: SpawnRequest) => PtyLike;
  export type TerminalStreamEvent = { seq: number; type: "output"; data: string } | { seq: number; type: "exit"; exitCode: number };
  export interface StreamEmitter { open(channel: string, companyId: string): void; emit(channel: string, event: unknown): void; close(channel: string): void }
  export interface SessionSummary { id: string; ownerUserId: string; companyId: string; createdAt: string; lastActivityAt: string; cols: number; rows: number; alive: boolean; exitCode: number | null }
  export interface OpenSessionInput { ownerUserId: string; companyId: string; cols: number; rows: number; shell: string; idleTimeoutMs: number; maxSessionsPerUser: number }
  export interface AttachResult { session: SessionSummary; channel: string; events: TerminalStreamEvent[]; truncated: boolean }
  export const MAX_EVENT_BYTES = 65_536;
  export class SessionManager {
    constructor(deps: { spawn: PtySpawner; streams: StreamEmitter; scrollbackBytes?: number; now?: () => number; randomId?: () => string });
    open(input: OpenSessionInput): { session: SessionSummary; channel: string };
    attach(sessionId: string, ownerUserId: string, afterSeq: number): AttachResult;
    input(sessionId: string, ownerUserId: string, data: string): void;
    resize(sessionId: string, ownerUserId: string, cols: number, rows: number): void;
    close(sessionId: string, ownerUserId: string): void;
    kill(sessionId: string): void;                 // no owner check (admin)
    list(companyId: string): SessionSummary[];
    count(): number;
    sweepIdle(): string[];                          // returns closed session ids
    shutdown(): void;
  }
  ```

- [ ] **Step 1: Write the fake PTY used by the tests**

`plugins/kyoube-terminal/tests/fake-pty.ts`:
```ts
import type { PtyLike, PtySpawner, SpawnRequest } from "../src/sessions.js";

export class FakePty implements PtyLike {
  static nextPid = 100;
  readonly pid = FakePty.nextPid++;
  readonly written: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed: string | null = null;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number }) => void> = [];

  constructor(readonly request: SpawnRequest) {}
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.resizes.push([cols, rows]); }
  kill(signal?: string) { this.killed = signal ?? "SIGHUP"; this.emitExit(129); }
  onData(listener: (data: string) => void) { this.dataListeners.push(listener); }
  onExit(listener: (event: { exitCode: number }) => void) { this.exitListeners.push(listener); }
  /** Test helper: simulate the child writing to the terminal. */
  emitData(data: string) { for (const listener of this.dataListeners) listener(data); }
  /** Test helper: simulate the child exiting. */
  emitExit(exitCode: number) { const listeners = this.exitListeners; this.exitListeners = []; for (const listener of listeners) listener({ exitCode }); }
}

export function fakeSpawner(): { spawn: PtySpawner; ptys: FakePty[] } {
  const ptys: FakePty[] = [];
  return {
    ptys,
    spawn: (request) => { const pty = new FakePty(request); ptys.push(pty); return pty; },
  };
}

export function fakeStreams() {
  const events: Array<{ channel: string; event: unknown }> = [];
  const opened: string[] = [];
  const closed: string[] = [];
  return {
    events,
    opened,
    closed,
    streams: {
      open(channel: string) { opened.push(channel); },
      emit(channel: string, event: unknown) { events.push({ channel, event }); },
      close(channel: string) { closed.push(channel); },
    },
  };
}
```

- [ ] **Step 2: Write the failing settings and session tests**

`plugins/kyoube-terminal/tests/settings.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, resolveSettings } from "../src/settings.js";

describe("resolveSettings", () => {
  it("returns defaults for empty config", () => {
    expect(resolveSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(resolveSettings({})).toEqual(DEFAULT_SETTINGS);
  });
  it("accepts valid overrides and ignores invalid ones", () => {
    const settings = resolveSettings({ idleTimeoutMinutes: 5, maxSessionsPerUser: "9", allowedRoles: ["owner"], shell: "/bin/sh", scrollbackKb: -1 });
    expect(settings).toEqual({ idleTimeoutMinutes: 5, maxSessionsPerUser: 3, allowedRoles: ["owner"], shell: "/bin/sh", scrollbackKb: 256 });
  });
  it("normalises allowedRoles to lowercase strings", () => {
    expect(resolveSettings({ allowedRoles: ["Owner", 3, " admin "] }).allowedRoles).toEqual(["owner", "admin"]);
  });
});
```

`plugins/kyoube-terminal/tests/sessions.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MAX_EVENT_BYTES, SessionManager, type TerminalStreamEvent } from "../src/sessions.js";
import { fakeSpawner, fakeStreams } from "./fake-pty.js";

function setup(opts: { scrollbackBytes?: number } = {}) {
  let now = 1_000_000;
  let counter = 0;
  const spawner = fakeSpawner();
  const streams = fakeStreams();
  const manager = new SessionManager({
    spawn: spawner.spawn,
    streams: streams.streams,
    scrollbackBytes: opts.scrollbackBytes,
    now: () => now,
    randomId: () => `id${++counter}`,
  });
  const open = (ownerUserId = "u1", companyId = "c1") =>
    manager.open({ ownerUserId, companyId, cols: 80, rows: 24, shell: "/bin/bash", idleTimeoutMs: 60_000, maxSessionsPerUser: 2 });
  return { manager, spawner, streams, open, advance: (ms: number) => { now += ms; } };
}

describe("SessionManager", () => {
  it("opens a session, spawns a pty with the request, and opens a stream channel", () => {
    const { open, spawner, streams } = setup();
    const { session, channel } = open();
    expect(session).toMatchObject({ id: "term-id1", ownerUserId: "u1", companyId: "c1", cols: 80, rows: 24, alive: true, exitCode: null });
    expect(channel).toBe("term-id2");
    expect(spawner.ptys[0]?.request).toEqual({ shell: "/bin/bash", cols: 80, rows: 24 });
    expect(streams.opened).toEqual(["term-id2"]);
  });

  it("emits sequenced output events and replays them on attach", () => {
    const { open, spawner, streams, manager } = setup();
    const { session, channel } = open();
    spawner.ptys[0]!.emitData("hello ");
    spawner.ptys[0]!.emitData("world");
    expect(streams.events.map((e) => e.event)).toEqual([
      { seq: 1, type: "output", data: "hello " },
      { seq: 2, type: "output", data: "world" },
    ]);
    const attached = manager.attach(session.id, "u1", 1);
    expect(attached.channel).toBe(channel);
    expect(attached.events).toEqual([{ seq: 2, type: "output", data: "world" }]);
    expect(attached.truncated).toBe(false);
  });

  it("splits large output into events no bigger than MAX_EVENT_BYTES", () => {
    const { open, spawner, streams } = setup();
    open();
    spawner.ptys[0]!.emitData("x".repeat(MAX_EVENT_BYTES + 10));
    const sizes = streams.events.map((e) => (e.event as TerminalStreamEvent & { data: string }).data.length);
    expect(sizes).toEqual([MAX_EVENT_BYTES, 10]);
  });

  it("trims the scrollback buffer and reports truncation", () => {
    const { open, spawner, manager } = setup({ scrollbackBytes: 10 });
    const { session } = open();
    spawner.ptys[0]!.emitData("12345");
    spawner.ptys[0]!.emitData("67890");
    spawner.ptys[0]!.emitData("abcde");
    const attached = manager.attach(session.id, "u1", 0);
    expect(attached.events.map((e) => (e as { data: string }).data)).toEqual(["67890", "abcde"]);
    expect(attached.truncated).toBe(true);
  });

  it("forwards input and resize to the pty and rejects other users", () => {
    const { open, spawner, manager } = setup();
    const { session } = open();
    manager.input(session.id, "u1", "ls\n");
    manager.resize(session.id, "u1", 120, 40);
    expect(spawner.ptys[0]!.written).toEqual(["ls\n"]);
    expect(spawner.ptys[0]!.resizes).toEqual([[120, 40]]);
    expect(() => manager.input(session.id, "u2", "rm -rf /\n")).toThrow("forbidden");
    expect(() => manager.attach(session.id, "u2", 0)).toThrow("forbidden");
    expect(() => manager.input("nope", "u1", "x")).toThrow("not_found");
  });

  it("enforces the per-user session limit only for live sessions", () => {
    const { open, manager } = setup();
    const first = open();
    open();
    expect(() => open()).toThrow("limit");
    manager.close(first.session.id, "u1");
    expect(() => open()).not.toThrow();
  });

  it("marks exit, emits an exit event, closes the channel, and refuses further input", () => {
    const { open, spawner, streams, manager } = setup();
    const { session, channel } = open();
    spawner.ptys[0]!.emitExit(0);
    expect(streams.events.at(-1)?.event).toEqual({ seq: 1, type: "exit", exitCode: 0 });
    expect(streams.closed).toEqual([channel]);
    expect(manager.attach(session.id, "u1", 0).session).toMatchObject({ alive: false, exitCode: 0 });
    expect(() => manager.input(session.id, "u1", "x")).toThrow("closed");
  });

  it("kills idle sessions during sweeps and lists per company", () => {
    const { open, manager, advance, spawner } = setup();
    const a = open("u1", "c1");
    open("u2", "c2");
    advance(30_000);
    manager.input(a.session.id, "u1", "x");
    advance(45_000);
    expect(manager.sweepIdle()).toEqual(["term-id3"]);
    expect(spawner.ptys[1]!.killed).toBe("SIGHUP");
    expect(manager.list("c1").map((s) => s.id)).toEqual([a.session.id]);
    expect(manager.list("c2")[0]).toMatchObject({ alive: false });
  });

  it("shutdown kills every live session", () => {
    const { open, manager, spawner } = setup();
    open("u1");
    open("u2");
    manager.shutdown();
    expect(spawner.ptys.every((pty) => pty.killed !== null)).toBe(true);
    expect(manager.count()).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @kyoube/plugin-terminal test`
Expected: FAIL — `Cannot find module '../src/settings.js'` / `'../src/sessions.js'`

- [ ] **Step 4: Implement errors.ts and settings.ts**

`plugins/kyoube-terminal/src/errors.ts`:
```ts
export type TerminalErrorCode = "forbidden" | "not_found" | "limit" | "closed" | "invalid";

/** Thrown from actions; the message is `<code>: <text>` so the UI can branch on the code. */
export class TerminalError extends Error {
  readonly code: TerminalErrorCode;
  constructor(code: TerminalErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "TerminalError";
    this.code = code;
  }
}
```

`plugins/kyoube-terminal/src/settings.ts`:
```ts
export interface TerminalSettings {
  idleTimeoutMinutes: number;
  maxSessionsPerUser: number;
  allowedRoles: string[];
  shell: string;
  scrollbackKb: number;
}

export const DEFAULT_SETTINGS: TerminalSettings = {
  idleTimeoutMinutes: 30,
  maxSessionsPerUser: 3,
  allowedRoles: ["owner", "admin"],
  shell: "/bin/bash",
  scrollbackKb: 256,
};

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveSettings(raw: Record<string, unknown> | null | undefined): TerminalSettings {
  const source = raw ?? {};
  const roles = Array.isArray(source.allowedRoles)
    ? source.allowedRoles
        .filter((role): role is string => typeof role === "string" && role.trim().length > 0)
        .map((role) => role.trim().toLowerCase())
    : DEFAULT_SETTINGS.allowedRoles;
  return {
    idleTimeoutMinutes: positiveNumber(source.idleTimeoutMinutes, DEFAULT_SETTINGS.idleTimeoutMinutes),
    maxSessionsPerUser: positiveNumber(source.maxSessionsPerUser, DEFAULT_SETTINGS.maxSessionsPerUser),
    allowedRoles: roles.length > 0 ? roles : DEFAULT_SETTINGS.allowedRoles,
    shell: typeof source.shell === "string" && source.shell.startsWith("/") ? source.shell : DEFAULT_SETTINGS.shell,
    scrollbackKb: positiveNumber(source.scrollbackKb, DEFAULT_SETTINGS.scrollbackKb),
  };
}
```

- [ ] **Step 5: Implement sessions.ts**

`plugins/kyoube-terminal/src/sessions.ts`:
```ts
import { randomBytes } from "node:crypto";
import { TerminalError } from "./errors.js";

export interface PtyLike {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
}

export interface SpawnRequest {
  shell: string;
  cols: number;
  rows: number;
}

export type PtySpawner = (request: SpawnRequest) => PtyLike;

export type TerminalStreamEvent =
  | { seq: number; type: "output"; data: string }
  | { seq: number; type: "exit"; exitCode: number };

export interface StreamEmitter {
  open(channel: string, companyId: string): void;
  emit(channel: string, event: unknown): void;
  close(channel: string): void;
}

export interface SessionSummary {
  id: string;
  ownerUserId: string;
  companyId: string;
  createdAt: string;
  lastActivityAt: string;
  cols: number;
  rows: number;
  alive: boolean;
  exitCode: number | null;
}

export interface OpenSessionInput {
  ownerUserId: string;
  companyId: string;
  cols: number;
  rows: number;
  shell: string;
  idleTimeoutMs: number;
  maxSessionsPerUser: number;
}

export interface AttachResult {
  session: SessionSummary;
  channel: string;
  events: TerminalStreamEvent[];
  truncated: boolean;
}

export const MAX_EVENT_BYTES = 65_536;
const DEFAULT_SCROLLBACK_BYTES = 256 * 1024;

interface SessionState {
  summary: SessionSummary;
  pty: PtyLike;
  channel: string;
  idleTimeoutMs: number;
  buffer: TerminalStreamEvent[];
  bufferBytes: number;
  droppedSeq: number; // highest seq trimmed out of the buffer
  nextSeq: number;
  lastActivityMs: number;
}

function defaultRandomId(): string {
  return randomBytes(24).toString("base64url");
}

function eventBytes(event: TerminalStreamEvent): number {
  return event.type === "output" ? Buffer.byteLength(event.data, "utf8") : 16;
}

function chunk(data: string): string[] {
  if (data.length <= MAX_EVENT_BYTES) return [data];
  const parts: string[] = [];
  for (let i = 0; i < data.length; i += MAX_EVENT_BYTES) parts.push(data.slice(i, i + MAX_EVENT_BYTES));
  return parts;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly spawn: PtySpawner;
  private readonly streams: StreamEmitter;
  private readonly scrollbackBytes: number;
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(deps: { spawn: PtySpawner; streams: StreamEmitter; scrollbackBytes?: number; now?: () => number; randomId?: () => string }) {
    this.spawn = deps.spawn;
    this.streams = deps.streams;
    this.scrollbackBytes = deps.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;
    this.now = deps.now ?? (() => Date.now());
    this.randomId = deps.randomId ?? defaultRandomId;
  }

  open(input: OpenSessionInput): { session: SessionSummary; channel: string } {
    const live = [...this.sessions.values()].filter(
      (state) => state.summary.alive && state.summary.ownerUserId === input.ownerUserId && state.summary.companyId === input.companyId,
    );
    if (live.length >= input.maxSessionsPerUser) {
      throw new TerminalError("limit", `at most ${input.maxSessionsPerUser} open sessions per user; close one first`);
    }
    const id = `term-${this.randomId()}`;
    const channel = `term-${this.randomId()}`;
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const pty = this.spawn({ shell: input.shell, cols: input.cols, rows: input.rows });
    const state: SessionState = {
      summary: { id, ownerUserId: input.ownerUserId, companyId: input.companyId, createdAt: nowIso, lastActivityAt: nowIso, cols: input.cols, rows: input.rows, alive: true, exitCode: null },
      pty,
      channel,
      idleTimeoutMs: input.idleTimeoutMs,
      buffer: [],
      bufferBytes: 0,
      droppedSeq: 0,
      nextSeq: 1,
      lastActivityMs: nowMs,
    };
    this.sessions.set(id, state);
    this.streams.open(channel, input.companyId);
    pty.onData((data) => {
      for (const part of chunk(data)) this.push(state, { seq: state.nextSeq++, type: "output", data: part });
    });
    pty.onExit(({ exitCode }) => {
      if (!state.summary.alive) return;
      state.summary.alive = false;
      state.summary.exitCode = exitCode;
      this.push(state, { seq: state.nextSeq++, type: "exit", exitCode });
      this.streams.close(channel);
    });
    return { session: { ...state.summary }, channel };
  }

  attach(sessionId: string, ownerUserId: string, afterSeq: number): AttachResult {
    const state = this.owned(sessionId, ownerUserId);
    const events = state.buffer.filter((event) => event.seq > afterSeq);
    return { session: { ...state.summary }, channel: state.channel, events, truncated: afterSeq < state.droppedSeq };
  }

  input(sessionId: string, ownerUserId: string, data: string): void {
    const state = this.owned(sessionId, ownerUserId);
    this.assertAlive(state);
    this.touch(state);
    state.pty.write(data);
  }

  resize(sessionId: string, ownerUserId: string, cols: number, rows: number): void {
    const state = this.owned(sessionId, ownerUserId);
    this.assertAlive(state);
    state.summary.cols = cols;
    state.summary.rows = rows;
    state.pty.resize(cols, rows);
  }

  close(sessionId: string, ownerUserId: string): void {
    const state = this.owned(sessionId, ownerUserId);
    this.terminate(state);
  }

  kill(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) throw new TerminalError("not_found", `no session ${sessionId}`);
    this.terminate(state);
  }

  list(companyId: string): SessionSummary[] {
    return [...this.sessions.values()]
      .filter((state) => state.summary.companyId === companyId)
      .map((state) => ({ ...state.summary }));
  }

  count(): number {
    return [...this.sessions.values()].filter((state) => state.summary.alive).length;
  }

  sweepIdle(): string[] {
    const nowMs = this.now();
    const closed: string[] = [];
    for (const state of this.sessions.values()) {
      if (!state.summary.alive) continue;
      if (nowMs - state.lastActivityMs >= state.idleTimeoutMs) {
        this.terminate(state);
        closed.push(state.summary.id);
      }
    }
    return closed;
  }

  shutdown(): void {
    for (const state of this.sessions.values()) {
      if (state.summary.alive) this.terminate(state);
    }
  }

  private owned(sessionId: string, ownerUserId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new TerminalError("not_found", `no session ${sessionId}`);
    if (state.summary.ownerUserId !== ownerUserId) throw new TerminalError("forbidden", "this session belongs to another user");
    return state;
  }

  private assertAlive(state: SessionState): void {
    if (!state.summary.alive) throw new TerminalError("closed", "the shell has exited");
  }

  private touch(state: SessionState): void {
    state.lastActivityMs = this.now();
    state.summary.lastActivityAt = new Date(state.lastActivityMs).toISOString();
  }

  private terminate(state: SessionState): void {
    if (!state.summary.alive) return;
    state.pty.kill("SIGHUP");
    if (state.summary.alive) {
      // The pty did not report exit synchronously; mark it ourselves so limits free up immediately.
      state.summary.alive = false;
      state.summary.exitCode = state.summary.exitCode ?? -1;
      this.push(state, { seq: state.nextSeq++, type: "exit", exitCode: state.summary.exitCode });
      this.streams.close(state.channel);
    }
  }

  private push(state: SessionState, event: TerminalStreamEvent): void {
    state.buffer.push(event);
    state.bufferBytes += eventBytes(event);
    while (state.bufferBytes > this.scrollbackBytes && state.buffer.length > 1) {
      const dropped = state.buffer.shift()!;
      state.bufferBytes -= eventBytes(dropped);
      state.droppedSeq = dropped.seq;
    }
    this.streams.emit(state.channel, event);
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @kyoube/plugin-terminal test`
Expected: PASS (settings + sessions; the Phase 0 skeleton test still passes)

- [ ] **Step 7: Commit**

```bash
git add plugins/kyoube-terminal/src/errors.ts plugins/kyoube-terminal/src/settings.ts plugins/kyoube-terminal/src/sessions.ts plugins/kyoube-terminal/tests
git commit -m "feat(terminal): session manager with sequenced scrollback and idle sweeps"
```

---

### Task 2: Role resolution against company memberships

**Files:**
- Create: `plugins/kyoube-terminal/src/auth.ts`
- Test: `plugins/kyoube-terminal/tests/auth.spec.ts`

**Interfaces:**
- Consumes: `ctx.access.members.list({ companyId })` → `PluginAccessMember[]` (`principalType: "user" | "agent"`, `principalId`, `status`, `membershipRole`), capability `access.members.read`.
- Produces:
  ```ts
  export interface AccessMembersLike { list(input: { companyId: string }): Promise<Array<{ principalType: string; principalId: string; status: string; membershipRole: string | null }>> }
  export class RoleResolver {
    constructor(members: AccessMembersLike, opts?: { cacheMs?: number; now?: () => number });
    resolveRole(companyId: string, userId: string): Promise<string | null>;   // active human member's role, cached per company
    assertAllowed(companyId: string, userId: string, allowedRoles: string[]): Promise<string>; // throws TerminalError("forbidden")
    invalidate(companyId?: string): void;
  }
  ```

- [ ] **Step 1: Write the failing tests**

`plugins/kyoube-terminal/tests/auth.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { RoleResolver } from "../src/auth.js";

function members(rows: Array<{ principalType?: string; principalId: string; status?: string; membershipRole: string | null; companyId?: string }>) {
  let calls = 0;
  return {
    calls: () => calls,
    list: async ({ companyId }: { companyId: string }) => {
      calls += 1;
      return rows
        .filter((row) => (row.companyId ?? "c1") === companyId)
        .map((row) => ({ principalType: row.principalType ?? "user", principalId: row.principalId, status: row.status ?? "active", membershipRole: row.membershipRole }));
    },
  };
}

describe("RoleResolver", () => {
  it("resolves the active human member's role and caches the company listing", async () => {
    const source = members([{ principalId: "u1", membershipRole: "admin" }, { principalId: "u2", membershipRole: "member" }]);
    const resolver = new RoleResolver(source, { cacheMs: 30_000, now: () => 0 });
    expect(await resolver.resolveRole("c1", "u1")).toBe("admin");
    expect(await resolver.resolveRole("c1", "u2")).toBe("member");
    expect(source.calls()).toBe(1);
  });

  it("ignores agents, suspended members, and other companies", async () => {
    const source = members([
      { principalId: "u1", membershipRole: "owner", status: "suspended" },
      { principalId: "a1", principalType: "agent", membershipRole: "owner" },
      { principalId: "u3", membershipRole: "owner", companyId: "c2" },
    ]);
    const resolver = new RoleResolver(source);
    expect(await resolver.resolveRole("c1", "u1")).toBeNull();
    expect(await resolver.resolveRole("c1", "a1")).toBeNull();
    expect(await resolver.resolveRole("c1", "u3")).toBeNull();
  });

  it("expires the cache and can be invalidated", async () => {
    let now = 0;
    const source = members([{ principalId: "u1", membershipRole: "admin" }]);
    const resolver = new RoleResolver(source, { cacheMs: 1000, now: () => now });
    await resolver.resolveRole("c1", "u1");
    now = 999;
    await resolver.resolveRole("c1", "u1");
    expect(source.calls()).toBe(1);
    now = 1001;
    await resolver.resolveRole("c1", "u1");
    expect(source.calls()).toBe(2);
    resolver.invalidate("c1");
    await resolver.resolveRole("c1", "u1");
    expect(source.calls()).toBe(3);
  });

  it("assertAllowed returns the role or throws forbidden", async () => {
    const source = members([{ principalId: "u1", membershipRole: "admin" }, { principalId: "u2", membershipRole: "member" }]);
    const resolver = new RoleResolver(source);
    expect(await resolver.assertAllowed("c1", "u1", ["owner", "admin"])).toBe("admin");
    await expect(resolver.assertAllowed("c1", "u2", ["owner", "admin"])).rejects.toThrow("forbidden");
    await expect(resolver.assertAllowed("c1", "nobody", ["owner"])).rejects.toThrow("forbidden");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kyoube/plugin-terminal test`
Expected: FAIL — `Cannot find module '../src/auth.js'`

- [ ] **Step 3: Implement auth.ts**

`plugins/kyoube-terminal/src/auth.ts`:
```ts
import { TerminalError } from "./errors.js";

export interface AccessMemberRow {
  principalType: string;
  principalId: string;
  status: string;
  membershipRole: string | null;
}

export interface AccessMembersLike {
  list(input: { companyId: string }): Promise<AccessMemberRow[]>;
}

interface CacheEntry {
  fetchedAt: number;
  roles: Map<string, string>; // userId -> role
}

export class RoleResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheMs: number;
  private readonly now: () => number;

  constructor(private readonly members: AccessMembersLike, opts: { cacheMs?: number; now?: () => number } = {}) {
    this.cacheMs = opts.cacheMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async resolveRole(companyId: string, userId: string): Promise<string | null> {
    const entry = await this.load(companyId);
    return entry.roles.get(userId) ?? null;
  }

  async assertAllowed(companyId: string, userId: string, allowedRoles: string[]): Promise<string> {
    const role = await this.resolveRole(companyId, userId);
    if (!role || !allowedRoles.includes(role)) {
      throw new TerminalError("forbidden", `the terminal is limited to company roles ${allowedRoles.join(", ")}`);
    }
    return role;
  }

  invalidate(companyId?: string): void {
    if (companyId) this.cache.delete(companyId);
    else this.cache.clear();
  }

  private async load(companyId: string): Promise<CacheEntry> {
    const cached = this.cache.get(companyId);
    if (cached && this.now() - cached.fetchedAt < this.cacheMs) return cached;
    const rows = await this.members.list({ companyId });
    const roles = new Map<string, string>();
    for (const row of rows) {
      if (row.principalType !== "user" || row.status !== "active" || !row.membershipRole) continue;
      roles.set(row.principalId, row.membershipRole.toLowerCase());
    }
    const entry = { fetchedAt: this.now(), roles };
    this.cache.set(companyId, entry);
    return entry;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kyoube/plugin-terminal test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/kyoube-terminal/src/auth.ts plugins/kyoube-terminal/tests/auth.spec.ts
git commit -m "feat(terminal): resolve company roles with a short cache"
```

---

### Task 3: Shell environment, Kyoube config reader, and the real PTY spawner

**Files:**
- Create: `plugins/kyoube-terminal/src/spawn-env.ts`, `plugins/kyoube-terminal/src/kyoube-config.ts`, `plugins/kyoube-terminal/src/pty.ts`
- Modify: `plugins/kyoube-terminal/package.json` (add dependency `@lydell/node-pty`)
- Test: `plugins/kyoube-terminal/tests/spawn-env.spec.ts`, `plugins/kyoube-terminal/tests/kyoube-config.spec.ts`

**Interfaces:**
- Consumes: `/paperclip/kyoube/config.json` shape from Phase 0 (`home`, `hermesHome`, `dataDatabaseUrl`, `publicUrl`, …).
- Produces:
  ```ts
  export function buildShellEnv(input: { home: string; hermesHome: string; shell: string; path?: string; extra?: Record<string, string> }): Record<string, string>;
  export const DEFAULT_KYOUBE_CONFIG_PATH = "/paperclip/kyoube/config.json";
  export interface KyoubeRuntimeConfig { home: string; hermesHome: string; dataDatabaseUrl: string; publicUrl: string; paperclipApiUrl: string }
  export async function readKyoubeConfig(filePath?: string): Promise<KyoubeRuntimeConfig>;
  export function createNodePtySpawner(opts: { cwd: string; env: Record<string, string> }): PtySpawner;
  ```

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @kyoube/plugin-terminal add @lydell/node-pty@1.1.0`
Expected: `package.json` gains `"@lydell/node-pty": "1.1.0"` under `dependencies`; install succeeds (prebuilt binary, no compiler needed).

- [ ] **Step 2: Write the failing tests**

`plugins/kyoube-terminal/tests/spawn-env.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildShellEnv } from "../src/spawn-env.js";

describe("buildShellEnv", () => {
  it("builds a minimal, explicit environment for the shell", () => {
    const env = buildShellEnv({ home: "/paperclip", hermesHome: "/paperclip/.hermes", shell: "/bin/bash", path: "/usr/local/bin:/usr/bin" });
    expect(env).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/paperclip",
      USER: "node",
      LOGNAME: "node",
      SHELL: "/bin/bash",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "C.UTF-8",
      HERMES_HOME: "/paperclip/.hermes",
      PAPERCLIP_HOME: "/paperclip",
      KYOUBE_TERMINAL: "1",
    });
  });

  it("falls back to a sane PATH and allows extra variables without overriding HOME", () => {
    const env = buildShellEnv({ home: "/paperclip", hermesHome: "/x", shell: "/bin/sh", extra: { FOO: "bar", HOME: "/evil" } });
    expect(env.PATH).toBe("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    expect(env.FOO).toBe("bar");
    expect(env.HOME).toBe("/paperclip");
  });
});
```

`plugins/kyoube-terminal/tests/kyoube-config.spec.ts`:
```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readKyoubeConfig } from "../src/kyoube-config.js";

describe("readKyoubeConfig", () => {
  it("reads the fields the plugin needs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-cfg-"));
    const file = path.join(dir, "config.json");
    await writeFile(file, JSON.stringify({ version: 1, home: "/paperclip", hermesHome: "/paperclip/.hermes", dataDatabaseUrl: "postgres://x", publicUrl: "http://localhost:3100", paperclipApiUrl: "http://127.0.0.1:3100", pluginRoot: "/opt/kyoube/plugins", imageVersion: "dev" }));
    expect(await readKyoubeConfig(file)).toEqual({ home: "/paperclip", hermesHome: "/paperclip/.hermes", dataDatabaseUrl: "postgres://x", publicUrl: "http://localhost:3100", paperclipApiUrl: "http://127.0.0.1:3100" });
  });

  it("fails loudly when a field is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-cfg-"));
    const file = path.join(dir, "config.json");
    await writeFile(file, JSON.stringify({ version: 1, home: "/paperclip" }));
    await expect(readKyoubeConfig(file)).rejects.toThrow("hermesHome");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @kyoube/plugin-terminal test`
Expected: FAIL — modules not found

- [ ] **Step 4: Implement the three modules**

`plugins/kyoube-terminal/src/spawn-env.ts`:
```ts
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * The shell gets an explicit environment: plugin workers are started without
 * HOME or provider variables, and the terminal must write harness credentials
 * under the persisted Paperclip home.
 */
export function buildShellEnv(input: {
  home: string;
  hermesHome: string;
  shell: string;
  path?: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  return {
    ...(input.extra ?? {}),
    PATH: input.path && input.path.length > 0 ? input.path : DEFAULT_PATH,
    HOME: input.home,
    USER: "node",
    LOGNAME: "node",
    SHELL: input.shell,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "C.UTF-8",
    HERMES_HOME: input.hermesHome,
    PAPERCLIP_HOME: input.home,
    KYOUBE_TERMINAL: "1",
  };
}
```

`plugins/kyoube-terminal/src/kyoube-config.ts`:
```ts
import { readFile } from "node:fs/promises";

export const DEFAULT_KYOUBE_CONFIG_PATH = "/paperclip/kyoube/config.json";

export interface KyoubeRuntimeConfig {
  home: string;
  hermesHome: string;
  dataDatabaseUrl: string;
  publicUrl: string;
  paperclipApiUrl: string;
}

const FIELDS: Array<keyof KyoubeRuntimeConfig> = ["home", "hermesHome", "dataDatabaseUrl", "publicUrl", "paperclipApiUrl"];

/** Reads the file the Kyoube entrypoint renders at container start (plugin workers receive no environment). */
export async function readKyoubeConfig(
  filePath: string = process.env.KYOUBE_CONFIG_PATH ?? DEFAULT_KYOUBE_CONFIG_PATH,
): Promise<KyoubeRuntimeConfig> {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  const config: Partial<KyoubeRuntimeConfig> = {};
  for (const field of FIELDS) {
    const value = raw[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`kyoube config ${filePath} is missing ${field}`);
    }
    config[field] = value;
  }
  return config as KyoubeRuntimeConfig;
}
```

`plugins/kyoube-terminal/src/pty.ts`:
```ts
import nodePty from "@lydell/node-pty";
import type { PtySpawner } from "./sessions.js";

/** Real PTY spawner. Shells are login shells so /etc/profile PATH additions apply. */
export function createNodePtySpawner(opts: { cwd: string; env: Record<string, string> }): PtySpawner {
  return ({ shell, cols, rows }) => {
    const proc = nodePty.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: opts.cwd,
      env: opts.env,
    });
    return {
      pid: proc.pid,
      write: (data) => proc.write(data),
      resize: (c, r) => proc.resize(c, r),
      kill: (signal) => proc.kill(signal),
      onData: (listener) => { proc.onData(listener); },
      onExit: (listener) => { proc.onExit(({ exitCode }) => listener({ exitCode })); },
    };
  };
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter @kyoube/plugin-terminal test && pnpm --filter @kyoube/plugin-terminal typecheck`
Expected: PASS; typecheck clean (if `@lydell/node-pty` lacks a default export type, change the import to `import * as nodePty from "@lydell/node-pty"` and keep `nodePty.spawn`).

- [ ] **Step 6: Commit**

```bash
git add plugins/kyoube-terminal pnpm-lock.yaml
git commit -m "feat(terminal): shell environment, kyoube config reader, node-pty spawner"
```

---

### Task 4: Plugin wiring — actions, data, audit, health

> **From Phase 0 rulings:** this task's manifest adds capabilities to the placeholder `["plugin.state.read"]`, so the first `ensure-plugins` run against an existing install takes the capability-escalation path (upgrade refused by upstream → soft uninstall + reinstall, ruling R15) — expected, and the smoke already rehearses it. Before adding `minimumHostVersion` (spec §9), confirm the version string the host actually reports in this image (`serverInfo`/`GET /api/health` with a board key); if it is not the CalVer `2026.831.1`, leave it out and record why (ruling R20).

**Files:**
- Create: `plugins/kyoube-terminal/src/plugin.ts`
- Modify: `plugins/kyoube-terminal/src/worker.ts`, `plugins/kyoube-terminal/src/manifest.ts`
- Test: `plugins/kyoube-terminal/tests/plugin.spec.ts` (replaces the Phase 0 skeleton test)

**Interfaces:**
- Consumes: Tasks 1–3; SDK `definePlugin`, `PluginContext`, `PluginPerformActionContext` (`actor: { type, userId, agentId, runId, companyId }`), harness `performAction(key, params, { actor, companyId })`, `seed({ accessMembers })`.
- Produces:
  ```ts
  export interface TerminalPluginDeps { createSpawner: (opts: { cwd: string; env: Record<string, string> }) => PtySpawner; loadKyoubeConfig: () => Promise<KyoubeRuntimeConfig>; now?: () => number; randomId?: () => string; sweepIntervalMs?: number }
  export function createTerminalPlugin(deps: TerminalPluginDeps): PaperclipPlugin;
  ```
  Action contracts (all require a signed-in user with an allowed company role):
  - `terminal.open { cols?, rows? } → { sessionId, channel, session }`
  - `terminal.attach { sessionId, afterSeq? } → { session, channel, events, truncated }`
  - `terminal.input { sessionId, data } → { ok: true }`
  - `terminal.resize { sessionId, cols, rows } → { ok: true }`
  - `terminal.close { sessionId } → { ok: true }`
  - `terminal.list {} → { sessions: SessionSummary[] }` (company-scoped)
  - `terminal.kill { sessionId } → { ok: true }`
  - data `terminal.can_open { companyId, userId } → { allowed, role }` (advisory; the UI uses it to show/hide the link)

- [ ] **Step 1: Replace the manifest with the full declaration**

`plugins/kyoube-terminal/src/manifest.ts`:
```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "kyoube.terminal";
export const PLUGIN_VERSION = "0.2.0";
export const PAGE_ROUTE = "terminal";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kyoube Terminal",
  description: "Browser terminal inside the KyoubeAI container for instance administration and agent harness login. Limited to company owners/admins.",
  author: "KyoubeAI",
  categories: ["workspace", "ui"],
  capabilities: [
    "ui.page.register",
    "ui.sidebar.register",
    "access.members.read",
    "activity.log.write",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      idleTimeoutMinutes: { type: "number", title: "Idle timeout (minutes)", default: 30, minimum: 1 },
      maxSessionsPerUser: { type: "number", title: "Max open sessions per user", default: 3, minimum: 1 },
      allowedRoles: {
        type: "array",
        title: "Company roles allowed to open a terminal",
        items: { type: "string", enum: ["owner", "admin", "operator", "member", "viewer"] },
        default: ["owner", "admin"],
      },
      shell: { type: "string", title: "Shell", default: "/bin/bash" },
      scrollbackKb: { type: "number", title: "Scrollback buffer (KiB)", default: 256, minimum: 16 },
    },
  },
  ui: {
    slots: [
      { type: "page", id: "terminal-page", displayName: "Terminal", exportName: "TerminalPage", routePath: PAGE_ROUTE },
      { type: "sidebar", id: "terminal-nav", displayName: "Terminal", exportName: "SidebarEntry" },
    ],
  },
};

export default manifest;
```

- [ ] **Step 2: Write the failing plugin tests**

`plugins/kyoube-terminal/tests/plugin.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createTerminalPlugin } from "../src/plugin.js";
import { fakeSpawner, fakeStreams, type FakePty } from "./fake-pty.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ADMIN = { type: "user" as const, userId: "admin-1" };
const MEMBER = { type: "user" as const, userId: "member-1" };

async function setup(config: Record<string, unknown> = {}) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    accessMembers: [
      { id: "m1", companyId: COMPANY, principalType: "user", principalId: "admin-1", status: "active", membershipRole: "admin", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
      { id: "m2", companyId: COMPANY, principalType: "user", principalId: "member-1", status: "active", membershipRole: "member", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    ],
  });
  const spawner = fakeSpawner();
  const streams = fakeStreams();
  const ctx = { ...harness.ctx, streams: streams.streams };
  let counter = 0;
  const plugin = createTerminalPlugin({
    createSpawner: () => spawner.spawn,
    loadKyoubeConfig: async () => ({ home: "/paperclip", hermesHome: "/paperclip/.hermes", dataDatabaseUrl: "postgres://x", publicUrl: "http://localhost:3100", paperclipApiUrl: "http://127.0.0.1:3100" }),
    randomId: () => `id${++counter}`,
    sweepIntervalMs: 0,
  });
  await plugin.definition.setup(ctx);
  const act = <T,>(key: string, params: Record<string, unknown>, actor = ADMIN) =>
    harness.performAction<T>(key, params, { actor, companyId: COMPANY });
  return { harness, plugin, spawner, streams, act, pty: () => spawner.ptys[0] as FakePty };
}

describe("kyoube.terminal actions", () => {
  it("opens a session for an allowed role, streams output, and attaches with replay", async () => {
    const { act, pty, streams } = await setup();
    const opened = await act<{ sessionId: string; channel: string }>("terminal.open", { cols: 100, rows: 30 });
    expect(opened.sessionId).toBe("term-id1");
    expect(pty().request).toEqual({ shell: "/bin/bash", cols: 100, rows: 30 });
    pty().emitData("$ ");
    expect(streams.events[0]).toEqual({ channel: opened.channel, event: { seq: 1, type: "output", data: "$ " } });
    await act("terminal.input", { sessionId: opened.sessionId, data: "ls\n" });
    expect(pty().written).toEqual(["ls\n"]);
    const attached = await act<{ events: unknown[]; truncated: boolean }>("terminal.attach", { sessionId: opened.sessionId, afterSeq: 0 });
    expect(attached.events).toEqual([{ seq: 1, type: "output", data: "$ " }]);
  });

  it("denies members, agents, and anonymous callers and audits denials", async () => {
    const { act, harness } = await setup();
    await expect(act("terminal.open", {}, MEMBER)).rejects.toThrow("forbidden");
    await expect(act("terminal.open", {}, { type: "agent" as const, agentId: "a1" } as never)).rejects.toThrow("forbidden");
    expect(harness.activity.some((entry) => entry.message.includes("denied"))).toBe(true);
  });

  it("honours allowedRoles from plugin config", async () => {
    const { act } = await setup({ allowedRoles: ["owner", "admin", "member"] });
    await expect(act("terminal.open", {}, MEMBER)).resolves.toMatchObject({ sessionId: expect.any(String) });
  });

  it("uses the configured shell and enforces the per-user limit", async () => {
    const { act, spawner } = await setup({ shell: "/bin/sh", maxSessionsPerUser: 1 });
    await act("terminal.open", {});
    expect(spawner.ptys[0]?.request.shell).toBe("/bin/sh");
    await expect(act("terminal.open", {})).rejects.toThrow("limit");
  });

  it("lists sessions for the company, closes own sessions, and lets admins kill any session", async () => {
    const { act, spawner } = await setup({ allowedRoles: ["admin", "member"] });
    const mine = await act<{ sessionId: string }>("terminal.open", {});
    const theirs = await act<{ sessionId: string }>("terminal.open", {}, MEMBER);
    const listed = await act<{ sessions: Array<{ id: string; ownerUserId: string }> }>("terminal.list", {});
    expect(listed.sessions.map((s) => s.ownerUserId).sort()).toEqual(["admin-1", "member-1"]);
    await expect(act("terminal.close", { sessionId: theirs.sessionId })).rejects.toThrow("forbidden");
    await act("terminal.kill", { sessionId: theirs.sessionId });
    await act("terminal.close", { sessionId: mine.sessionId });
    expect(spawner.ptys.every((pty) => pty.killed !== null)).toBe(true);
  });

  it("records session open and close in the activity log without content", async () => {
    const { act, harness } = await setup();
    const opened = await act<{ sessionId: string }>("terminal.open", {});
    await act("terminal.input", { sessionId: opened.sessionId, data: "secret\n" });
    await act("terminal.close", { sessionId: opened.sessionId });
    const messages = harness.activity.map((entry) => entry.message);
    expect(messages).toEqual(expect.arrayContaining([expect.stringContaining("opened"), expect.stringContaining("closed")]));
    expect(JSON.stringify(harness.activity)).not.toContain("secret");
  });

  it("answers can_open for the sidebar and reports health", async () => {
    const { harness, plugin } = await setup();
    expect(await harness.getData("terminal.can_open", { companyId: COMPANY, userId: "admin-1" })).toEqual({ allowed: true, role: "admin" });
    expect(await harness.getData("terminal.can_open", { companyId: COMPANY, userId: "member-1" })).toEqual({ allowed: false, role: "member" });
    expect(await plugin.definition.onHealth?.()).toMatchObject({ status: "ok", details: { liveSessions: 0 } });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @kyoube/plugin-terminal test`
Expected: FAIL — `Cannot find module '../src/plugin.js'`

- [ ] **Step 4: Implement plugin.ts and rewrite worker.ts**

`plugins/kyoube-terminal/src/plugin.ts`:
```ts
import { definePlugin, type PaperclipPlugin, type PluginContext } from "@paperclipai/plugin-sdk";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk/protocol";
import { RoleResolver } from "./auth.js";
import { TerminalError } from "./errors.js";
import type { KyoubeRuntimeConfig } from "./kyoube-config.js";
import { PLUGIN_ID } from "./manifest.js";
import { SessionManager, type PtySpawner } from "./sessions.js";
import { resolveSettings, type TerminalSettings } from "./settings.js";
import { buildShellEnv } from "./spawn-env.js";

export interface TerminalPluginDeps {
  createSpawner: (opts: { cwd: string; env: Record<string, string> }) => PtySpawner;
  loadKyoubeConfig: () => Promise<KyoubeRuntimeConfig>;
  now?: () => number;
  randomId?: () => string;
  /** 0 disables the periodic idle sweep (tests). */
  sweepIntervalMs?: number;
}

type Params = Record<string, unknown>;

function str(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw new TerminalError("invalid", `${key} is required`);
  return value;
}

function int(params: Params, key: string, fallback: number, min: number, max: number): number {
  const value = params[key];
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new TerminalError("invalid", `${key} must be a number`);
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function createTerminalPlugin(deps: TerminalPluginDeps): PaperclipPlugin {
  let manager: SessionManager | null = null;
  let sweeper: NodeJS.Timeout | null = null;

  return definePlugin({
    async setup(ctx: PluginContext) {
      const kyoube = await deps.loadKyoubeConfig();
      const roles = new RoleResolver(ctx.access.members, { now: deps.now });
      const spawner = deps.createSpawner({
        cwd: kyoube.home,
        env: buildShellEnv({ home: kyoube.home, hermesHome: kyoube.hermesHome, shell: "/bin/bash", path: process.env.PATH }),
      });
      const sessions = new SessionManager({ spawn: spawner, streams: ctx.streams, now: deps.now, randomId: deps.randomId });
      manager = sessions;

      const sweepMs = deps.sweepIntervalMs ?? 30_000;
      if (sweepMs > 0) {
        sweeper = setInterval(() => {
          for (const id of sessions.sweepIdle()) ctx.logger.info("terminal session closed after idle timeout", { sessionId: id });
        }, sweepMs);
        sweeper.unref();
      }

      async function authorize(context: PluginPerformActionContext, params: Params): Promise<{ companyId: string; userId: string; settings: TerminalSettings; role: string }> {
        const actor = context.actor;
        const companyId = context.companyId ?? (typeof params.companyId === "string" ? params.companyId : null);
        if (!companyId) throw new TerminalError("invalid", "companyId is required");
        const settings = resolveSettings(await ctx.config.get(companyId));
        if (actor.type !== "user" || !actor.userId) {
          await ctx.activity.log({ companyId, message: "Terminal access denied: not a signed-in user", entityType: "terminal", metadata: { actorType: actor.type } });
          throw new TerminalError("forbidden", "the terminal requires a signed-in user");
        }
        try {
          const role = await roles.assertAllowed(companyId, actor.userId, settings.allowedRoles);
          return { companyId, userId: actor.userId, settings, role };
        } catch (error) {
          await ctx.activity.log({ companyId, message: `Terminal access denied for user ${actor.userId}`, entityType: "terminal", metadata: { userId: actor.userId, allowedRoles: settings.allowedRoles } });
          throw error;
        }
      }

      ctx.data.register("terminal.can_open", async (params) => {
        const companyId = typeof params.companyId === "string" ? params.companyId : null;
        const userId = typeof params.userId === "string" ? params.userId : null;
        if (!companyId || !userId) return { allowed: false, role: null };
        const settings = resolveSettings(await ctx.config.get(companyId));
        const role = await roles.resolveRole(companyId, userId);
        return { allowed: role !== null && settings.allowedRoles.includes(role), role };
      });

      ctx.actions.register("terminal.open", async (params, context) => {
        const { companyId, userId, settings } = await authorize(context, params);
        const cols = int(params, "cols", 80, 20, 500);
        const rows = int(params, "rows", 24, 5, 200);
        const opened = sessions.open({
          ownerUserId: userId,
          companyId,
          cols,
          rows,
          shell: settings.shell,
          idleTimeoutMs: settings.idleTimeoutMinutes * 60_000,
          maxSessionsPerUser: settings.maxSessionsPerUser,
        });
        await ctx.activity.log({ companyId, message: `Terminal session opened by user ${userId}`, entityType: "terminal_session", entityId: opened.session.id, metadata: { userId, cols, rows } });
        return { sessionId: opened.session.id, channel: opened.channel, session: opened.session };
      });

      ctx.actions.register("terminal.attach", async (params, context) => {
        const { userId } = await authorize(context, params);
        const result = sessions.attach(str(params, "sessionId"), userId, int(params, "afterSeq", 0, 0, Number.MAX_SAFE_INTEGER));
        return result;
      });

      ctx.actions.register("terminal.input", async (params, context) => {
        const { userId } = await authorize(context, params);
        sessions.input(str(params, "sessionId"), userId, str(params, "data"));
        return { ok: true };
      });

      ctx.actions.register("terminal.resize", async (params, context) => {
        const { userId } = await authorize(context, params);
        sessions.resize(str(params, "sessionId"), userId, int(params, "cols", 80, 20, 500), int(params, "rows", 24, 5, 200));
        return { ok: true };
      });

      ctx.actions.register("terminal.close", async (params, context) => {
        const { companyId, userId } = await authorize(context, params);
        const sessionId = str(params, "sessionId");
        sessions.close(sessionId, userId);
        await ctx.activity.log({ companyId, message: `Terminal session closed by user ${userId}`, entityType: "terminal_session", entityId: sessionId, metadata: { userId } });
        return { ok: true };
      });

      ctx.actions.register("terminal.list", async (params, context) => {
        const { companyId } = await authorize(context, params);
        return { sessions: sessions.list(companyId) };
      });

      ctx.actions.register("terminal.kill", async (params, context) => {
        const { companyId, userId } = await authorize(context, params);
        const sessionId = str(params, "sessionId");
        const target = sessions.list(companyId).find((session) => session.id === sessionId);
        if (!target) throw new TerminalError("not_found", `no session ${sessionId} in this company`);
        sessions.kill(sessionId);
        await ctx.activity.log({ companyId, message: `Terminal session killed by user ${userId}`, entityType: "terminal_session", entityId: sessionId, metadata: { userId, ownerUserId: target.ownerUserId } });
        return { ok: true };
      });

      ctx.logger.info(`${PLUGIN_ID} worker ready`, { home: kyoube.home });
    },

    async onHealth() {
      return { status: "ok", message: `${PLUGIN_ID} ready`, details: { liveSessions: manager?.count() ?? 0 } };
    },

    async onShutdown() {
      if (sweeper) clearInterval(sweeper);
      manager?.shutdown();
    },
  });
}
```

`plugins/kyoube-terminal/src/worker.ts`:
```ts
import { runWorker } from "@paperclipai/plugin-sdk";
import { readKyoubeConfig } from "./kyoube-config.js";
import { createTerminalPlugin } from "./plugin.js";
import { createNodePtySpawner } from "./pty.js";

const plugin = createTerminalPlugin({
  createSpawner: createNodePtySpawner,
  loadKyoubeConfig: () => readKyoubeConfig(),
});

export default plugin;
runWorker(plugin, import.meta.url);
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter @kyoube/plugin-terminal test && pnpm --filter @kyoube/plugin-terminal typecheck`
Expected: PASS. If the harness rejects the `agent` actor test because `performAction` normalises unknown actor types, keep the assertion on `forbidden` — the plugin rejects any non-user actor.

- [ ] **Step 6: Commit**

```bash
git add plugins/kyoube-terminal
git commit -m "feat(terminal): actions, role gate, audit, and health wiring"
```

---

### Task 5: Browser UI — xterm page, stream pump, sidebar entry, UI build

**Files:**
- Create: `plugins/kyoube-terminal/src/ui/index.tsx`, `plugins/kyoube-terminal/src/ui/SidebarEntry.tsx`, `plugins/kyoube-terminal/src/ui/TerminalPage.tsx`, `plugins/kyoube-terminal/src/ui/output-tracker.ts`, `plugins/kyoube-terminal/src/ui/xterm-styles.ts`, `plugins/kyoube-terminal/src/ui/css.d.ts`
- Modify: `plugins/kyoube-terminal/package.json` (`paperclipPlugin.ui`, dev deps), `plugins/kyoube-terminal/build.mjs` (UI bundle)
- Test: `plugins/kyoube-terminal/tests/output-tracker.spec.ts`, `plugins/kyoube-terminal/tests/sidebar-entry.spec.tsx`

**Interfaces:**
- Consumes: `@paperclipai/plugin-sdk/ui` hooks `useHostContext`, `useHostNavigation`, `usePluginAction`, `usePluginData`, `usePluginStream(channel, { companyId })` (returns `{ events, lastEvent, connected, connecting, error, close }`); slot props `PluginPageProps`, `PluginSidebarProps`. The host provides `react`, `react-dom`, `react/jsx-runtime`, `@paperclipai/plugin-sdk/ui` as externals and serves `dist/ui/index.js`.
- Produces: `dist/ui/index.js` exporting `TerminalPage` and `SidebarEntry`; pure helper `createOutputTracker(startSeq?) → { lastSeq: number; accept(event: { seq: number }): boolean; reset(seq: number): void }`.

- [ ] **Step 1: Add UI dependencies and the UI build**

Run: `pnpm --filter @kyoube/plugin-terminal add -D @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 react@19.2.8 react-dom@19.2.8 @types/react@19.2.18 @types/react-dom@19.2.5`

Edit `plugins/kyoube-terminal/package.json`: add `"ui": "./dist/ui/"` inside `paperclipPlugin`, and `"peerDependencies": { "react": ">=18" }`.

Replace `plugins/kyoube-terminal/build.mjs`:
```js
import esbuild from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

// Worker-side bundles: dependencies stay external (shipped via pnpm deploy; native modules must not be bundled).
await esbuild.build({
  entryPoints: { manifest: "src/manifest.ts", worker: "src/worker.ts" },
  outdir: "dist",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: ["node24"],
  sourcemap: true,
  logLevel: "info",
});

// Browser bundle: everything bundled except what the Paperclip host provides.
await esbuild.build({
  entryPoints: { "ui/index": "src/ui/index.tsx" },
  outdir: "dist",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  external: ["react", "react-dom", "react/jsx-runtime", "@paperclipai/plugin-sdk/ui"],
  loader: { ".css": "text" },
  sourcemap: true,
  logLevel: "info",
});
```

- [ ] **Step 2: Write the failing tests**

`plugins/kyoube-terminal/tests/output-tracker.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createOutputTracker } from "../src/ui/output-tracker.js";

describe("createOutputTracker", () => {
  it("accepts strictly increasing sequence numbers once", () => {
    const tracker = createOutputTracker();
    expect(tracker.accept({ seq: 1 })).toBe(true);
    expect(tracker.accept({ seq: 2 })).toBe(true);
    expect(tracker.accept({ seq: 2 })).toBe(false);
    expect(tracker.accept({ seq: 1 })).toBe(false);
    expect(tracker.accept({ seq: 5 })).toBe(true);
    expect(tracker.lastSeq).toBe(5);
  });
  it("can be reset after a replay", () => {
    const tracker = createOutputTracker(10);
    expect(tracker.accept({ seq: 10 })).toBe(false);
    tracker.reset(3);
    expect(tracker.accept({ seq: 4 })).toBe(true);
  });
});
```

`plugins/kyoube-terminal/tests/sidebar-entry.spec.tsx`:
```tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarEntry } from "../src/ui/SidebarEntry.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> } };

function installBridge(canOpen: { allowed: boolean; role: string | null } | null) {
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      useHostContext: () => ({ companyId: "c1", companyPrefix: "acme", projectId: null, entityId: null, entityType: null, userId: "u1" }),
      useHostNavigation: () => ({
        resolveHref: (to: string) => `/acme${to}`,
        navigate: () => {},
        linkProps: (to: string) => ({ href: `/acme${to}`, onClick: () => {} }),
      }),
      usePluginData: () => ({ data: canOpen, loading: canOpen === null, error: null, refresh: () => {} }),
    },
  };
}

afterEach(() => { delete (globalThis as BridgeGlobal).__paperclipPluginBridge__; });

describe("SidebarEntry", () => {
  const context = { companyId: "c1", companyPrefix: "acme", projectId: null, entityId: null, entityType: null, userId: "u1" };
  it("renders a link to the terminal page for allowed users", () => {
    installBridge({ allowed: true, role: "admin" });
    const html = renderToStaticMarkup(createElement(SidebarEntry, { context }));
    expect(html).toContain('href="/acme/terminal"');
    expect(html).toContain("Terminal");
  });
  it("renders nothing for users who cannot open a terminal or while loading", () => {
    installBridge({ allowed: false, role: "member" });
    expect(renderToStaticMarkup(createElement(SidebarEntry, { context }))).toBe("");
    installBridge(null);
    expect(renderToStaticMarkup(createElement(SidebarEntry, { context }))).toBe("");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @kyoube/plugin-terminal test`
Expected: FAIL — modules under `../src/ui/` not found

- [ ] **Step 4: Implement the pure helpers and the sidebar entry**

`plugins/kyoube-terminal/src/ui/output-tracker.ts`:
```ts
/** De-duplicates stream events by sequence number (events may arrive twice after a reconnect + replay). */
export function createOutputTracker(startSeq = 0) {
  let lastSeq = startSeq;
  return {
    get lastSeq() {
      return lastSeq;
    },
    accept(event: { seq: number }): boolean {
      if (event.seq <= lastSeq) return false;
      lastSeq = event.seq;
      return true;
    },
    reset(seq: number) {
      lastSeq = seq;
    },
  };
}
```

`plugins/kyoube-terminal/src/ui/css.d.ts`:
```ts
declare module "*.css" {
  const css: string;
  export default css;
}
```

`plugins/kyoube-terminal/src/ui/xterm-styles.ts`:
```ts
import xtermCss from "@xterm/xterm/css/xterm.css";

let injected = false;

/** Injects xterm's stylesheet once; plugin UI bundles cannot load external CSS files. */
export function ensureXtermStyles(): void {
  if (injected || typeof document === "undefined") return;
  const style = document.createElement("style");
  style.setAttribute("data-kyoube-terminal", "");
  style.textContent = `${xtermCss}\n.kyoube-terminal-host { height: 100%; min-height: 480px; background: #0b0f14; padding: 8px; border-radius: 6px; }`;
  document.head.appendChild(style);
  injected = true;
}
```

`plugins/kyoube-terminal/src/ui/SidebarEntry.tsx`:
```tsx
import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { useHostContext, useHostNavigation, usePluginData } from "@paperclipai/plugin-sdk/ui";

export const PAGE_PATH = "/terminal";

export function SidebarEntry(_props: PluginSidebarProps) {
  const host = useHostContext();
  const navigation = useHostNavigation();
  const canOpen = usePluginData<{ allowed: boolean; role: string | null }>("terminal.can_open", {
    companyId: host.companyId,
    userId: host.userId,
  });
  if (canOpen.loading || !canOpen.data?.allowed) return null;
  return (
    <a
      {...navigation.linkProps(PAGE_PATH)}
      className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
    >
      <span aria-hidden="true">›_</span>
      <span>Terminal</span>
    </a>
  );
}
```

- [ ] **Step 5: Implement the terminal page**

`plugins/kyoube-terminal/src/ui/TerminalPage.tsx`:
```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginAction, usePluginStream } from "@paperclipai/plugin-sdk/ui";
import { createOutputTracker } from "./output-tracker.js";
import { ensureXtermStyles } from "./xterm-styles.js";

type StreamEvent = { seq: number; type: "output"; data: string } | { seq: number; type: "exit"; exitCode: number };
interface SessionSummary { id: string; ownerUserId: string; createdAt: string; lastActivityAt: string; alive: boolean; exitCode: number | null }
interface OpenResult { sessionId: string; channel: string }
interface AttachResult { session: SessionSummary; channel: string; events: StreamEvent[]; truncated: boolean }

const REMOUNT_EVERY = 2000; // the SSE hook accumulates events; remount the pump periodically and replay the gap
const INPUT_FLUSH_MS = 16;

const HELP: Array<[string, string]> = [
  ["claude login", "Claude Code OAuth login; credentials are stored under /paperclip/.claude"],
  ["pi", "pi coding agent; run `pi` and use /login or set provider keys in ~/.pi"],
  ["hermes setup", "Hermes Agent wizard (provider, model); data under /paperclip/.hermes"],
  ["kyoube doctor", "KyoubeAI health checks (config, databases, plugins, harness CLIs)"],
];

/** Subscribes to one session channel and forwards each new event to the parent. Remounted via `key` to bound memory. */
function StreamPump(props: { channel: string; companyId: string; onEvent: (event: StreamEvent) => void; onCount: (count: number) => void }) {
  const stream = usePluginStream<StreamEvent>(props.channel, { companyId: props.companyId });
  const { lastEvent, events } = stream;
  useEffect(() => {
    if (lastEvent) props.onEvent(lastEvent);
    props.onCount(events.length);
  }, [lastEvent, events.length]);
  return null;
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(":")[0]?.trim() ?? "error";
}

export function TerminalPage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? "";
  const open = usePluginAction("terminal.open");
  const attach = usePluginAction("terminal.attach");
  const input = usePluginAction("terminal.input");
  const resize = usePluginAction("terminal.resize");
  const close = usePluginAction("terminal.close");
  const list = usePluginAction("terminal.list");
  const kill = usePluginAction("terminal.kill");

  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const tracker = useMemo(() => createOutputTracker(), []);
  const pendingInput = useRef<string[]>([]);
  const flushTimer = useRef<number | null>(null);

  const [session, setSession] = useState<OpenResult | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [status, setStatus] = useState<string>("No session");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const result = (await list({})) as { sessions: SessionSummary[] };
      setSessions(result.sessions);
    } catch (err) {
      setError(errorCode(err));
    }
  }, [list]);

  const flushInput = useCallback(() => {
    flushTimer.current = null;
    const data = pendingInput.current.join("");
    pendingInput.current = [];
    if (!session || data.length === 0) return;
    input({ sessionId: session.sessionId, data }).catch((err) => setError(errorCode(err)));
  }, [input, session]);

  // Mount xterm once.
  useEffect(() => {
    ensureXtermStyles();
    if (!hostRef.current || termRef.current) return;
    const term = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000, theme: { background: "#0b0f14" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    return () => { term.dispose(); termRef.current = null; };
  }, []);

  // Wire keystrokes (batched) and resizes to the current session.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !session) return;
    const dataSub = term.onData((data) => {
      pendingInput.current.push(data);
      if (flushTimer.current === null) flushTimer.current = window.setTimeout(flushInput, INPUT_FLUSH_MS);
    });
    const observer = new ResizeObserver(() => {
      fitRef.current?.fit();
      resize({ sessionId: session.sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
    });
    if (hostRef.current) observer.observe(hostRef.current);
    return () => { dataSub.dispose(); observer.disconnect(); };
  }, [session, flushInput, resize]);

  const applyEvent = useCallback((event: StreamEvent) => {
    if (!tracker.accept(event)) return;
    if (event.type === "output") termRef.current?.write(event.data);
    else {
      termRef.current?.write(`\r\n[process exited with code ${event.exitCode}]\r\n`);
      setStatus(`Exited (${event.exitCode})`);
    }
  }, [tracker]);

  const replay = useCallback(async (sessionId: string) => {
    const result = (await attach({ sessionId, afterSeq: tracker.lastSeq })) as AttachResult;
    if (result.truncated && tracker.lastSeq === 0) termRef.current?.write("[… earlier output truncated …]\r\n");
    for (const event of result.events) applyEvent(event);
    return result;
  }, [attach, applyEvent, tracker]);

  const handleCount = useCallback((count: number) => {
    if (count >= REMOUNT_EVERY && session) {
      setEpoch((value) => value + 1);
      replay(session.sessionId).catch((err) => setError(errorCode(err)));
    }
  }, [session, replay]);

  const startSession = useCallback(async () => {
    setError(null);
    const term = termRef.current;
    fitRef.current?.fit();
    try {
      const opened = (await open({ cols: term?.cols ?? 100, rows: term?.rows ?? 30 })) as OpenResult;
      tracker.reset(0);
      term?.reset();
      setSession(opened);
      setEpoch((value) => value + 1);
      setStatus("Connected");
      term?.focus();
      await refreshList();
    } catch (err) {
      setError(errorCode(err));
    }
  }, [open, refreshList, tracker]);

  const resumeSession = useCallback(async (sessionId: string) => {
    setError(null);
    try {
      tracker.reset(0);
      termRef.current?.reset();
      const result = await replay(sessionId);
      setSession({ sessionId, channel: result.channel });
      setEpoch((value) => value + 1);
      setStatus(result.session.alive ? "Connected (resumed)" : `Exited (${result.session.exitCode})`);
      termRef.current?.focus();
    } catch (err) {
      setError(errorCode(err));
    }
  }, [replay, tracker]);

  const endSession = useCallback(async () => {
    if (!session) return;
    try {
      await close({ sessionId: session.sessionId });
    } catch (err) {
      setError(errorCode(err));
    }
    setSession(null);
    setStatus("No session");
    await refreshList();
  }, [close, session, refreshList]);

  // Action functions from usePluginAction are not guaranteed referentially stable; never list them as effect deps.
  useEffect(() => { refreshList().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!companyId) return <div className="p-4 text-sm">Select a company to use the terminal.</div>;

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <strong>Terminal</strong>
        <span className="text-foreground/60">{status}</span>
        {error === "forbidden" && <span className="text-red-600">Your company role cannot open a terminal.</span>}
        {error && error !== "forbidden" && <span className="text-red-600">Error: {error}</span>}
        <span className="flex-1" />
        <button type="button" className="rounded border px-2 py-1" onClick={() => { startSession().catch(() => {}); }}>New session</button>
        <button type="button" className="rounded border px-2 py-1" disabled={!session} onClick={() => { endSession().catch(() => {}); }}>Close session</button>
      </div>
      <div ref={hostRef} className="kyoube-terminal-host" />
      {session && <StreamPump key={epoch} channel={session.channel} companyId={companyId} onEvent={applyEvent} onCount={handleCount} />}
      <details className="text-xs text-foreground/70">
        <summary>Sessions in this company</summary>
        <ul className="mt-1 space-y-1">
          {sessions.map((item) => (
            <li key={item.id} className="flex items-center gap-2">
              <code>{item.id.slice(0, 12)}</code>
              <span>{item.alive ? "live" : `exited ${item.exitCode ?? ""}`}</span>
              <span>owner {item.ownerUserId.slice(0, 8)}</span>
              <button type="button" className="underline" onClick={() => { resumeSession(item.id).catch(() => {}); }}>attach</button>
              <button type="button" className="underline" onClick={() => { kill({ sessionId: item.id }).then(refreshList).catch((err) => setError(errorCode(err))); }}>kill</button>
            </li>
          ))}
          {sessions.length === 0 && <li>None</li>}
        </ul>
      </details>
      <details className="text-xs text-foreground/70">
        <summary>Authenticate the agent harnesses</summary>
        <ul className="mt-1 space-y-1">
          {HELP.map(([command, text]) => (
            <li key={command}><code>{command}</code> — {text}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
```

`plugins/kyoube-terminal/src/ui/index.tsx`:
```tsx
export { TerminalPage } from "./TerminalPage.js";
export { SidebarEntry } from "./SidebarEntry.js";
```

- [ ] **Step 6: Run tests, typecheck, build**

Run: `pnpm --filter @kyoube/plugin-terminal test && pnpm --filter @kyoube/plugin-terminal typecheck && pnpm --filter @kyoube/plugin-terminal build`
Expected: PASS; `dist/ui/index.js` exists and contains no `import "react"` other than the externals (check with `grep -c 'from "react"' plugins/kyoube-terminal/dist/ui/index.js` → at least 1) and includes the xterm CSS text (`grep -c 'xterm' plugins/kyoube-terminal/dist/ui/index.js` > 0).

- [ ] **Step 7: Commit**

```bash
git add plugins/kyoube-terminal pnpm-lock.yaml
git commit -m "feat(terminal): xterm page with resumable sessions and sidebar entry"
```

---

### Task 6: Container integration, smoke round-trip, docs

> **Carried over from the Phase 0 re-review (ruling R21), to land in this task because it rebuilds the image and re-runs the smoke:** (a) pass `KYOUBE_BOOTSTRAP_DISABLED: ${KYOUBE_BOOTSTRAP_DISABLED:-}` through the compose `app.environment` block (documented in `.env.example` but not plumbed); (b) add `--force-commit` next to `--commit` in the Hermes install line so the pin holds after upstream `main` advances (today the `rev-parse HEAD` assertion fails the build loudly instead); (c) `chown -R node:node /opt/cua-driver` — Hermes' CUA repair path writes a lock dir under `CUA_DRIVER_RS_HOME`; (d) `docker/entrypoint.sh` → `100755` in git (`git update-index --chmod=+x`); (e) in `docker/bootstrap/src/plugins.ts`, a row at the transient status `installed` must plan `skip` (reason: not ready yet, retried next cycle) rather than `upgrade`, because upstream's lifecycle only upgrades `ready`/`upgrade_pending` rows; add a unit test.

**Files:**
- Modify: `docker/Dockerfile`, `scripts/smoke.sh`, `README.md`

**Interfaces:**
- Consumes: bridge routes `POST /api/plugins/kyoube.terminal/actions/<key>` with body `{ companyId, params }` → `{ data }` (board API key auth; the caller must be a member of `companyId`).

- [ ] **Step 1: Add a native-module load check to the Dockerfile**

In `docker/Dockerfile`, after the `COPY --from=kyoube-build /out/plugins /opt/kyoube/plugins` line, add to the same `RUN` that chmods the wrappers:
```dockerfile
 && node -e "require('/opt/kyoube/plugins/terminal/node_modules/@lydell/node-pty'); console.log('node-pty ok')" \
```
(placed before the final `&& node /opt/kyoube/bootstrap/dist/kyoube.mjs --help >/dev/null`).

- [ ] **Step 2: Extend the smoke test with a terminal round-trip**

Append to `scripts/smoke.sh` before the `==> kyoube doctor` block:
```bash
echo "==> terminal: open, run a command, read it back, close"
bridge() { # key body-json
  curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -X POST "$BASE_URL/api/plugins/kyoube.terminal/actions/$1" --data "$2"
}
MARK="kyoube-smoke-$RANDOM"
SESSION_ID="$(bridge terminal.open "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"cols\":100,\"rows\":30}}" | jq -r '.data.sessionId')"
[[ -n "$SESSION_ID" && "$SESSION_ID" != "null" ]] || { echo "terminal.open failed" >&2; exit 1; }
bridge terminal.input "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"sessionId\":\"$SESSION_ID\",\"data\":\"echo $MARK\\n\"}}" >/dev/null
sleep 2
bridge terminal.attach "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"sessionId\":\"$SESSION_ID\",\"afterSeq\":0}}" \
  | jq -e --arg mark "$MARK" '[.data.events[] | select(.type == "output") | .data] | join("") | contains($mark)' >/dev/null
bridge terminal.close "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"sessionId\":\"$SESSION_ID\"}}" >/dev/null
echo "    terminal round-trip ok"
```

- [ ] **Step 3: Run the smoke test**

Run: `bash scripts/smoke.sh`
Expected: `terminal round-trip ok` and `smoke passed`. If `terminal.open` returns `forbidden`, the board key's user is not an owner/admin of the smoke company — companies created via the API by the instance admin make that user the owner; verify with `GET /api/companies/$COMPANY_ID/access/members` (or the equivalent members route) and adjust the smoke script's company creation if the role differs.

- [ ] **Step 4: Manual acceptance in the browser**

1. `docker compose up -d --build`, sign in as the admin, open **Terminal** in the sidebar, click **New session**, run `claude login`, complete the OAuth flow, then `claude --version`.
2. Reload the page, open **Sessions in this company**, click **attach** on the live session — the prior output is replayed.
3. `docker compose restart app`, then confirm `ls ~/.claude` in a new session still shows credentials.
4. Sign in as a user with the `member` role: the sidebar entry is absent and `POST …/actions/terminal.open` returns a `forbidden` error.

- [ ] **Step 5: Document and commit**

Add to `README.md` under a new `## Terminal` heading:
```markdown
## Terminal

Company owners and admins see a **Terminal** entry in the sidebar. It opens a shell inside the `app` container as the `node` user with `HOME=/paperclip` (the persisted volume), so `claude login`, `pi`, and `hermes setup` store credentials that survive restarts. Sessions are audited (open/close/kill, never content), idle sessions close after 30 minutes, and a session survives page reloads — use **attach** under *Sessions in this company*. Adjust roles, timeouts, and the shell under Settings → Plugins → Kyoube Terminal.

Security note: the terminal is equivalent to shell access to the whole instance (database credentials, every agent's tokens). Keep `allowedRoles` tight and use it only over private networks or TLS.
```

```bash
git add docker/Dockerfile scripts/smoke.sh README.md
git commit -m "feat(terminal): container load check, smoke round-trip, docs"
```

---

## Phase 1 exit checklist

- [ ] All plugin unit tests pass; `pnpm build` produces `dist/manifest.js`, `dist/worker.js`, `dist/ui/index.js`.
- [ ] `bash scripts/smoke.sh` passes, including the terminal round-trip.
- [ ] Manual acceptance (Task 6 Step 4) completed: all three harnesses authenticated from the browser; credentials survive `docker compose restart app`; members are denied.
- [ ] Activity log shows session open/close entries and no keystrokes.
