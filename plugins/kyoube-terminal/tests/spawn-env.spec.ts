import { describe, expect, it } from "vitest";
import { buildShellEnv, userFirstPath } from "../src/spawn-env.js";

describe("userFirstPath", () => {
  it("puts <home>/.local/bin first, exactly once", () => {
    expect(userFirstPath("/kyoubeai", "/usr/local/bin:/usr/bin")).toBe("/kyoubeai/.local/bin:/usr/local/bin:/usr/bin");
    expect(userFirstPath("/kyoubeai", "/usr/bin:/kyoubeai/.local/bin:/bin")).toBe("/kyoubeai/.local/bin:/usr/bin:/bin");
    expect(userFirstPath("/kyoubeai", "/kyoubeai/.local/bin:/usr/bin::")).toBe("/kyoubeai/.local/bin:/usr/bin");
  });

  it("falls back to the core image's PATH", () => {
    for (const base of [undefined, ""]) {
      expect(userFirstPath("/kyoubeai", base)).toBe("/kyoubeai/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    }
  });
});

describe("buildShellEnv", () => {
  it("builds a minimal, explicit environment for the shell", () => {
    const env = buildShellEnv({ home: "/kyoubeai", hermesHome: "/kyoubeai/.hermes", shell: "/bin/bash", path: "/usr/local/bin:/usr/bin" });
    expect(env).toEqual({
      PATH: "/kyoubeai/.local/bin:/usr/local/bin:/usr/bin",
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

  it("allows extra variables without letting them replace HOME, PATH or the telemetry switches", () => {
    const env = buildShellEnv({
      home: "/kyoubeai", hermesHome: "/x", shell: "/bin/sh",
      extra: { FOO: "bar", HOME: "/evil", PATH: "/evil/bin", DO_NOT_TRACK: "0", DISABLE_TELEMETRY: "" },
    });
    expect(env.FOO).toBe("bar");
    expect(env.HOME).toBe("/kyoubeai");
    expect(env.PATH).toBe("/kyoubeai/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    expect(env.DO_NOT_TRACK).toBe("1");
    expect(env.DISABLE_TELEMETRY).toBe("1");
  });

  it("carries nothing it was not given", () => {
    const env = buildShellEnv({ home: "/kyoubeai", hermesHome: "/x", shell: "/bin/bash" });
    expect(Object.keys(env).sort()).toEqual([
      "COLORTERM", "DISABLE_TELEMETRY", "DO_NOT_TRACK", "HERMES_HOME", "HOME", "KYOUBE_TERMINAL",
      "LANG", "LOGNAME", "PAPERCLIP_HOME", "PATH", "SHELL", "TERM", "USER",
    ]);
  });
});
