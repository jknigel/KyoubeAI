const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Ruling P4-R42: variables the container's own environment may contribute to a terminal shell, and
 * the only ones — the list is an allowlist, not a fallback, so a value here is passed through when
 * the operator set it on the `app` service and is absent otherwise. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
 * is the documented opt-in (SECURITY.md § Telemetry); without this passthrough, setting it on the
 * service would have had no effect on the shells where `claude` actually runs.
 */
const PASSTHROUGH_KEYS = ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] as const;

/**
 * The shell gets an explicit environment: plugin workers are started without
 * HOME or provider variables, and the terminal must write harness credentials
 * under the persisted KyoubeAI home.
 *
 * node-pty takes this object as the shell's *complete* environment, so nothing the container has
 * reaches a session unless it is named here. That is what keeps database credentials, the board
 * key's path and every provider key out of a shell; it is also why the image's own
 * `ENV DO_NOT_TRACK=1 DISABLE_TELEMETRY=1` would not otherwise arrive — hence the fixed pair below,
 * on every session, and the narrow `source` passthrough above.
 */
export function buildShellEnv(input: {
  home: string;
  hermesHome: string;
  shell: string;
  path?: string;
  /** The container's environment (`process.env` at the call site), read only for `PASSTHROUGH_KEYS`. */
  source?: Record<string, string | undefined>;
  extra?: Record<string, string>;
}): Record<string, string> {
  const passthrough: Record<string, string> = {};
  for (const key of PASSTHROUGH_KEYS) {
    const value = input.source?.[key];
    if (typeof value === "string" && value.length > 0) passthrough[key] = value;
  }
  return {
    // Spread first, so everything below wins: neither a caller's `extra` nor a passthrough key can
    // redirect HOME, weaken the telemetry switches, or replace PATH.
    ...(input.extra ?? {}),
    ...passthrough,
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
    DO_NOT_TRACK: "1",
    DISABLE_TELEMETRY: "1",
  };
}
