import { describe, expect, it } from "vitest";
import { buildShellEnv } from "../src/spawn-env.js";

describe("buildShellEnv", () => {
  it("builds a minimal, explicit environment for the shell", () => {
    const env = buildShellEnv({ home: "/kyoubeai", hermesHome: "/kyoubeai/.hermes", shell: "/bin/bash", path: "/usr/local/bin:/usr/bin" });
    expect(env).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/kyoubeai",
      USER: "node",
      LOGNAME: "node",
      SHELL: "/bin/bash",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "C.UTF-8",
      HERMES_HOME: "/kyoubeai/.hermes",
      PAPERCLIP_HOME: "/kyoubeai",
      KYOUBE_TERMINAL: "1",
      DO_NOT_TRACK: "1",
      DISABLE_TELEMETRY: "1",
    });
  });

  it("falls back to a sane PATH and allows extra variables without overriding HOME", () => {
    const env = buildShellEnv({ home: "/kyoubeai", hermesHome: "/x", shell: "/bin/sh", extra: { FOO: "bar", HOME: "/evil" } });
    expect(env.PATH).toBe("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    expect(env.FOO).toBe("bar");
    expect(env.HOME).toBe("/kyoubeai");
  });

  /**
   * Ruling P4-R42: the image's `ENV DO_NOT_TRACK=1 DISABLE_TELEMETRY=1` reaches the server and the
   * `kyoube` CLI, but not a terminal shell — this function hands node-pty the *complete*
   * environment, from a closed allowlist with no `process.env` spread. A terminal shell is exactly
   * where `claude`, `pi` and `hermes` are authenticated and run, so the switches are set here too,
   * unconditionally.
   */
  it("sets both telemetry switches in every environment it builds", () => {
    for (const env of [
      buildShellEnv({ home: "/kyoubeai", hermesHome: "/x", shell: "/bin/bash" }),
      buildShellEnv({ home: "/kyoubeai", hermesHome: "/x", shell: "/bin/bash", path: "/usr/bin", source: {} }),
      // Not overridable: the fixed block wins over `extra`, as it does for HOME above.
      buildShellEnv({ home: "/kyoubeai", hermesHome: "/x", shell: "/bin/bash", extra: { DO_NOT_TRACK: "0", DISABLE_TELEMETRY: "" } }),
    ]) {
      expect(env.DO_NOT_TRACK).toBe("1");
      expect(env.DISABLE_TELEMETRY).toBe("1");
    }
  });

  it("passes CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC through only when the container sets it", () => {
    const on = buildShellEnv({ home: "/kyoubeai", hermesHome: "/x", shell: "/bin/bash", source: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
    expect(on.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    for (const source of [undefined, {}, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: undefined }, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "" }]) {
      expect(buildShellEnv({ home: "/kyoubeai", hermesHome: "/x", shell: "/bin/bash", source })).not.toHaveProperty("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC");
    }
  });

  it("leaks nothing else from the container environment", () => {
    const env = buildShellEnv({
      home: "/kyoubeai",
      hermesHome: "/x",
      shell: "/bin/bash",
      source: {
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ANTHROPIC_API_KEY: "sk-secret",
        POSTGRES_PASSWORD: "hunter2",
        BETTER_AUTH_SECRET: "secret",
        KYOUBE_DATABASE_URL: "postgres://kyoube:pw@db:5432/kyoube",
        PATH: "/evil/bin",
        HOME: "/evil",
      },
    });
    expect(Object.keys(env).sort()).toEqual([
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "COLORTERM",
      "DISABLE_TELEMETRY",
      "DO_NOT_TRACK",
      "HERMES_HOME",
      "HOME",
      "KYOUBE_TERMINAL",
      "LANG",
      "LOGNAME",
      "PAPERCLIP_HOME",
      "PATH",
      "SHELL",
      "TERM",
      "USER",
    ]);
    // The source is a passthrough allowlist, not a fallback: PATH and HOME still come from the
    // caller's own inputs.
    expect(env.PATH).toBe("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    expect(env.HOME).toBe("/kyoubeai");
    expect(JSON.stringify(env)).not.toContain("sk-secret");
  });
});
