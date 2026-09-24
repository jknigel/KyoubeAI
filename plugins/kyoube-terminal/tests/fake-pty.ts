import type { PtyLike, PtySpawner, SpawnRequest } from "../src/sessions.js";

export class FakePty implements PtyLike {
  static nextPid = 100;
  readonly pid = FakePty.nextPid++;
  readonly written: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed: string | null = null;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number }) => void> = [];

  constructor(
    readonly request: SpawnRequest,
    /** Set false to model a real pty, whose process-exit event arrives asynchronously (not from `kill()` itself). */
    private readonly exitOnKill: boolean = true,
  ) {}
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.resizes.push([cols, rows]); }
  kill(signal?: string) {
    this.killed = signal ?? "SIGHUP";
    if (this.exitOnKill) this.emitExit(129);
  }
  onData(listener: (data: string) => void) { this.dataListeners.push(listener); }
  onExit(listener: (event: { exitCode: number }) => void) { this.exitListeners.push(listener); }
  /** Test helper: simulate the child writing to the terminal. */
  emitData(data: string) { for (const listener of this.dataListeners) listener(data); }
  /** Test helper: simulate the child exiting. */
  emitExit(exitCode: number) { const listeners = this.exitListeners; this.exitListeners = []; for (const listener of listeners) listener({ exitCode }); }
}

/**
 * `probeExit` models what a one-shot spawn (`args` set — the health probe's `-c exit 0`, never a
 * session) does: a real shell runs the command and exits on its own. `null` models a pty layer
 * that wedges instead, so the probe's timeout is what answers.
 */
export function fakeSpawner(opts: { exitOnKill?: boolean; probeExit?: number | null } = {}): { spawn: PtySpawner; ptys: FakePty[] } {
  const ptys: FakePty[] = [];
  const probeExit = opts.probeExit === undefined ? 0 : opts.probeExit;
  return {
    ptys,
    spawn: (request) => {
      const pty = new FakePty(request, opts.exitOnKill);
      ptys.push(pty);
      // Deferred: the caller registers its exit listener after `spawn()` returns.
      if (request.args && probeExit !== null) queueMicrotask(() => pty.emitExit(probeExit));
      return pty;
    },
  };
}
