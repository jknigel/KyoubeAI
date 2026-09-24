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
  /**
   * Arguments for the shell. Sessions leave this unset and get a login shell; the health probe
   * asks for a one-shot command instead, so it can prove the pty layer works without paying for
   * `/etc/profile`. `SessionManager` never sets it.
   */
  args?: string[];
}

export type PtySpawner = (request: SpawnRequest) => PtyLike;

export type TerminalStreamEvent =
  | { seq: number; type: "output"; data: string }
  | { seq: number; type: "exit"; exitCode: number };

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
  /** Per-session scrollback cap in bytes; falls back to the manager-wide default when omitted. */
  scrollbackBytes?: number;
}

export interface AttachResult {
  session: SessionSummary;
  events: TerminalStreamEvent[];
  truncated: boolean;
}

export const MAX_EVENT_BYTES = 65_536;
const DEFAULT_SCROLLBACK_BYTES = 256 * 1024;
/** Dead sessions stay listable/attachable this long after exit, then `sweepIdle()` prunes them. */
const DEFAULT_DEAD_RETENTION_MS = 10 * 60_000;
/**
 * Output coalescing window (spec §7: "coalesce output to ≤ 60 frames/s"). Chunks the pty
 * produces inside one window are merged into a single `output` event, so a chatty command
 * cannot turn every read() into its own event for the page to apply.
 */
export const OUTPUT_FLUSH_MS = 16;

/** Opaque handle returned by the injected timer (a `NodeJS.Timeout` for the real one). */
export type TimerHandle = unknown;

/** One parked `wait()` call: answered by the next event pushed to its session, or by its timeout. */
interface Waiter {
  afterSeq: number;
  resolve: (result: AttachResult) => void;
  timer: TimerHandle | null;
}

interface SessionState {
  summary: SessionSummary;
  pty: PtyLike;
  idleTimeoutMs: number;
  /** This session's own scrollback cap in bytes (manager default, or its `open()` override). */
  scrollbackBytes: number;
  buffer: TerminalStreamEvent[];
  bufferBytes: number;
  droppedSeq: number; // highest seq trimmed out of the buffer
  nextSeq: number;
  lastActivityMs: number;
  /** When the session stopped being alive, for the dead-session retention sweep; null while alive. */
  diedAtMs: number | null;
  /** Output received since the last flush, still to be merged into one `output` event. */
  pendingOutput: string[];
  /** Handle of the scheduled flush, or null when nothing is pending. */
  flushHandle: TimerHandle | null;
  /** `wait()` calls parked until this session's next event. */
  waiters: Waiter[];
}

function defaultRandomId(): string {
  return randomBytes(24).toString("base64url");
}

function eventBytes(event: TerminalStreamEvent): number {
  return event.type === "output" ? Buffer.byteLength(event.data, "utf8") : 16;
}

/**
 * Split `data` into parts whose UTF-8 encoding is at most MAX_EVENT_BYTES bytes each,
 * so a single stream event never exceeds the 64 KiB event-size limit. Splitting on
 * `string.length` alone would over-count multibyte text (a `.length` of MAX_EVENT_BYTES
 * can be far more than MAX_EVENT_BYTES bytes) and could sever a UTF-16 surrogate pair
 * mid-character; iterating the string with `for...of` walks whole Unicode code points
 * (a surrogate pair is one step), so a chunk boundary never lands inside one.
 */
function chunk(data: string): string[] {
  if (Buffer.byteLength(data, "utf8") <= MAX_EVENT_BYTES) return [data];
  const parts: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const codePoint of data) {
    const bytes = Buffer.byteLength(codePoint, "utf8");
    if (currentBytes + bytes > MAX_EVENT_BYTES) {
      parts.push(current.join(""));
      current = [];
      currentBytes = 0;
    }
    current.push(codePoint);
    currentBytes += bytes;
  }
  if (current.length > 0) parts.push(current.join(""));
  return parts;
}

export interface SessionManagerDeps {
  spawn: PtySpawner;
  scrollbackBytes?: number;
  /** How long a dead session stays listable/attachable before `sweepIdle()` prunes it. */
  deadRetentionMs?: number;
  now?: () => number;
  randomId?: () => string;
  /** Schedules the output flush; defaults to an unref'd `setTimeout` (injectable for tests). */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly spawn: PtySpawner;
  private readonly scrollbackBytes: number;
  private readonly deadRetentionMs: number;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  constructor(deps: SessionManagerDeps) {
    this.spawn = deps.spawn;
    this.scrollbackBytes = deps.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;
    this.deadRetentionMs = deps.deadRetentionMs ?? DEFAULT_DEAD_RETENTION_MS;
    this.now = deps.now ?? (() => Date.now());
    this.randomId = deps.randomId ?? defaultRandomId;
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.(); // a pending flush must never hold the worker process open
        return handle;
      });
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  open(input: OpenSessionInput): { session: SessionSummary } {
    const live = [...this.sessions.values()].filter(
      (state) => state.summary.alive && state.summary.ownerUserId === input.ownerUserId && state.summary.companyId === input.companyId,
    );
    if (live.length >= input.maxSessionsPerUser) {
      throw new TerminalError("limit", `at most ${input.maxSessionsPerUser} open sessions per user; close one first`);
    }
    const id = `term-${this.randomId()}`;
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const pty = this.spawn({ shell: input.shell, cols: input.cols, rows: input.rows });
    const state: SessionState = {
      summary: { id, ownerUserId: input.ownerUserId, companyId: input.companyId, createdAt: nowIso, lastActivityAt: nowIso, cols: input.cols, rows: input.rows, alive: true, exitCode: null },
      pty,
      idleTimeoutMs: input.idleTimeoutMs,
      scrollbackBytes: input.scrollbackBytes ?? this.scrollbackBytes,
      buffer: [],
      bufferBytes: 0,
      droppedSeq: 0,
      nextSeq: 1,
      lastActivityMs: nowMs,
      diedAtMs: null,
      pendingOutput: [],
      flushHandle: null,
      waiters: [],
    };
    this.sessions.set(id, state);
    pty.onData((data) => {
      // Once terminate() has synthesized an exit (the common case for a real pty, whose
      // process-exit event arrives asynchronously), the session is dead; any output still
      // trickling in from the dying process must be dropped rather than pushed after the exit event.
      if (!state.summary.alive) return;
      state.pendingOutput.push(data);
      this.scheduleFlush(state);
    });
    pty.onExit(({ exitCode }) => {
      if (!state.summary.alive) return;
      // Everything the shell wrote before it died belongs *before* the exit event.
      this.flushOutput(state);
      state.summary.alive = false;
      state.summary.exitCode = exitCode;
      state.diedAtMs = this.now();
      this.push(state, { seq: state.nextSeq++, type: "exit", exitCode });
    });
    return { session: { ...state.summary } };
  }

  attach(sessionId: string, ownerUserId: string, companyId: string, afterSeq: number): AttachResult {
    const state = this.owned(sessionId, ownerUserId, companyId);
    // Flush first: output buffered for the coalescing window is already part of this
    // session's scrollback as far as the client is concerned, so a replay must not miss it.
    this.flushOutput(state);
    return this.snapshot(state, afterSeq);
  }

  /**
   * The long-poll behind the page's output loop: answers like `attach` as soon as anything is
   * past `afterSeq` (or the session is dead, so nothing more can come), and otherwise parks
   * until the next event or `timeoutMs`, whichever is first. A timeout answers with no events.
   * Waiting is not activity: a tab left open must not keep an idle shell alive.
   */
  async wait(sessionId: string, ownerUserId: string, companyId: string, afterSeq: number, timeoutMs: number): Promise<AttachResult> {
    const state = this.owned(sessionId, ownerUserId, companyId);
    this.flushOutput(state);
    const immediate = this.snapshot(state, afterSeq);
    if (immediate.events.length > 0 || !state.summary.alive || timeoutMs <= 0) return immediate;
    return await new Promise<AttachResult>((resolve) => {
      const waiter: Waiter = { afterSeq, resolve, timer: null };
      waiter.timer = this.setTimer(() => {
        waiter.timer = null;
        state.waiters = state.waiters.filter((other) => other !== waiter);
        resolve(this.snapshot(state, afterSeq));
      }, timeoutMs);
      state.waiters.push(waiter);
    });
  }

  input(sessionId: string, ownerUserId: string, companyId: string, data: string): void {
    const state = this.owned(sessionId, ownerUserId, companyId);
    this.assertAlive(state);
    this.touch(state);
    state.pty.write(data);
  }

  resize(sessionId: string, ownerUserId: string, companyId: string, cols: number, rows: number): void {
    const state = this.owned(sessionId, ownerUserId, companyId);
    this.assertAlive(state);
    state.summary.cols = cols;
    state.summary.rows = rows;
    state.pty.resize(cols, rows);
  }

  close(sessionId: string, ownerUserId: string, companyId: string): void {
    const state = this.owned(sessionId, ownerUserId, companyId);
    this.terminate(state);
  }

  /** Company-scoped kill (any allowed role may kill another user's session in the same company). */
  kill(sessionId: string, companyId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.summary.companyId !== companyId) throw new TerminalError("not_found", `no session ${sessionId}`);
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

  /**
   * One maintenance pass: kills live sessions idle past their timeout (`closed`), then forgets
   * sessions that died more than `deadRetentionMs` ago (`pruned`) so neither the map nor their
   * scrollback grows without bound. The two lists are returned separately because they mean
   * different things to the caller — a `closed` session was just killed and its owner may still
   * attach to read the exit; a `pruned` one is gone (`list()` omits it, `attach` → `not_found`).
   * A session killed by this same pass is never pruned by it: its retention starts now.
   */
  sweepIdle(): { closed: string[]; pruned: string[] } {
    const nowMs = this.now();
    const closed: string[] = [];
    const pruned: string[] = [];
    for (const state of this.sessions.values()) {
      if (state.summary.alive) {
        if (nowMs - state.lastActivityMs >= state.idleTimeoutMs) {
          this.terminate(state);
          closed.push(state.summary.id);
        }
        continue;
      }
      if (state.diedAtMs !== null && nowMs - state.diedAtMs >= this.deadRetentionMs) {
        this.forget(state);
        pruned.push(state.summary.id);
      }
    }
    return { closed, pruned };
  }

  shutdown(): void {
    for (const state of this.sessions.values()) {
      if (state.summary.alive) this.terminate(state);
      else this.flushOutput(state); // clears any timer a dead session still holds
    }
  }

  private owned(sessionId: string, ownerUserId: string, companyId: string): SessionState {
    const state = this.sessions.get(sessionId);
    // A session in another company must be indistinguishable from one that does not exist,
    // so the company check reports `not_found` and runs before the owner check.
    if (!state || state.summary.companyId !== companyId) throw new TerminalError("not_found", `no session ${sessionId}`);
    if (state.summary.ownerUserId !== ownerUserId) throw new TerminalError("forbidden", "this session belongs to another user");
    return state;
  }

  private forget(state: SessionState): void {
    this.flushOutput(state); // releases the flush timer, if the session somehow still holds one
    this.answerWaiters(state); // a dead session never parks a waiter, but nothing may outlive the prune
    state.buffer = [];
    state.bufferBytes = 0;
    this.sessions.delete(state.summary.id);
  }

  private snapshot(state: SessionState, afterSeq: number): AttachResult {
    const events = state.buffer.filter((event) => event.seq > afterSeq);
    return { session: { ...state.summary }, events, truncated: afterSeq < state.droppedSeq };
  }

  /** Answers every parked `wait()` with its own view of the buffer and disarms their timeouts. */
  private answerWaiters(state: SessionState): void {
    if (state.waiters.length === 0) return;
    const waiters = state.waiters;
    state.waiters = [];
    for (const waiter of waiters) {
      if (waiter.timer !== null) {
        this.clearTimer(waiter.timer);
        waiter.timer = null;
      }
      waiter.resolve(this.snapshot(state, waiter.afterSeq));
    }
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
      this.flushOutput(state); // buffered output belongs before the exit event
      state.summary.alive = false;
      state.summary.exitCode = state.summary.exitCode ?? -1;
      state.diedAtMs = this.now();
      this.push(state, { seq: state.nextSeq++, type: "exit", exitCode: state.summary.exitCode });
    }
  }

  /** Arms the coalescing window; a window already open keeps its deadline (no timer churn). */
  private scheduleFlush(state: SessionState): void {
    if (state.flushHandle !== null) return;
    state.flushHandle = this.setTimer(() => {
      state.flushHandle = null;
      this.flushOutput(state);
    }, OUTPUT_FLUSH_MS);
  }

  /**
   * Emits everything buffered since the last flush as one `output` event — split only where the
   * 64 KiB event cap forces it — and cancels the pending timer. Safe to call at any time; call it
   * before an exit event, before a replay, and on shutdown so no bytes are stranded in the buffer.
   */
  private flushOutput(state: SessionState): void {
    if (state.flushHandle !== null) {
      this.clearTimer(state.flushHandle);
      state.flushHandle = null;
    }
    if (state.pendingOutput.length === 0) return;
    const data = state.pendingOutput.join("");
    state.pendingOutput = [];
    // Nothing may follow the exit event, so late bytes are dropped (see `onData`).
    if (!state.summary.alive) return;
    for (const part of chunk(data)) this.push(state, { seq: state.nextSeq++, type: "output", data: part });
  }

  private push(state: SessionState, event: TerminalStreamEvent): void {
    state.buffer.push(event);
    state.bufferBytes += eventBytes(event);
    while (state.bufferBytes > state.scrollbackBytes && state.buffer.length > 1) {
      const dropped = state.buffer.shift()!;
      state.bufferBytes -= eventBytes(dropped);
      state.droppedSeq = dropped.seq;
    }
    // Answered per event, not per flush: a burst split across several events answers the
    // waiters with the first, and their next poll finds the rest already buffered.
    this.answerWaiters(state);
  }
}
