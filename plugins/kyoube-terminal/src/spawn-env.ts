import path from "node:path";

/** The core image's PATH, used when the worker was started without one. */
const CORE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * `<home>/.local/bin` first, then `base` without it. That directory on the home volume is where
 * harnesses people install from the Terminal land (npm's prefix, Claude's and Codex's native
 * installers, Hermes as a normal user, uv, pip --user), and the image puts it first on the server's
 * PATH too, so a shell finds exactly what an agent run finds. A login shell's /etc/profile resets
 * PATH; /etc/profile.d/kyoube.sh (docker/system/kyoube-profile.sh) puts it back first.
 */
export function userFirstPath(home: string, base: string | undefined): string {
  const bin = path.posix.join(home, ".local", "bin");
  const rest = (base && base.length > 0 ? base : CORE_PATH).split(":").filter((entry) => entry.length > 0 && entry !== bin);
  return [bin, ...rest].join(":");
}

/**
 * The shell gets an explicit environment: node-pty takes this object as the shell's *complete*
 * environment, so nothing the container has reaches a session unless it is named here. That keeps
 * database credentials, the board key's path and every provider key out of a shell. It is also why
 * the image's `ENV DO_NOT_TRACK=1 DISABLE_TELEMETRY=1` would not otherwise arrive, hence the fixed
 * pair below, on every session (ruling P4-R42). The core starts plugin workers with a stripped
 * environment of its own, so there is nothing further to pass through from the container.
 */
export function buildShellEnv(input: {
  home: string;
  hermesHome: string;
  shell: string;
  path?: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  return {
    // Spread first, so everything below wins: a caller's `extra` cannot redirect HOME, weaken the
    // telemetry switches, or replace PATH.
    ...(input.extra ?? {}),
    PATH: userFirstPath(input.home, input.path),
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
    DO_NOT_TRACK: "1",
    DISABLE_TELEMETRY: "1",
  };
}
