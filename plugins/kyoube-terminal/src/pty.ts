import * as nodePty from "@lydell/node-pty";
import type { PtySpawner } from "./sessions.js";

/** Real PTY spawner. Shells are login shells so /etc/profile PATH additions apply. */
export function createNodePtySpawner(opts: { cwd: string; env: Record<string, string> }): PtySpawner {
  return ({ shell, cols, rows, args }) => {
    // Only the health probe passes `args` (a one-shot command); every session is a login shell.
    const proc = nodePty.spawn(shell, args ?? ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: opts.cwd,
      // Sessions may spawn a shell other than the one buildShellEnv was configured with at
      // plugin setup, so SHELL must reflect the shell actually being spawned for this request.
      env: { ...opts.env, SHELL: shell },
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
