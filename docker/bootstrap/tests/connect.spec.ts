import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CANCELLED, runCaptured, runConnect, type CaptureHost, type ConnectDeps } from "../src/commands/connect.js";

const TOKEN = "sk-ant-oat01-AbCdEf0123456789_-AbCdEf0123456789_-xyz";
const SCREEN = `Your OAuth token (valid for 1 year):\n${TOKEN}\nStore this token securely. You won't be able to see it again.\n`;

async function attemptDir() {
  const home = await mkdtemp(path.join(tmpdir(), "kyoube-home-"));
  const dir = path.join(home, "instances", "default", "ai-local-logins", "a1");
  await mkdir(dir, { recursive: true });
  return { home, dir };
}

function deps(overrides: Partial<ConnectDeps> = {}) {
  const lines: string[] = [];
  const calls: string[] = [];
  const d: ConnectDeps = {
    async claudeOnPath() { return true; },
    async runSetupToken(dir) { calls.push(`setup-token ${dir}`); return { code: 0, transcript: SCREEN }; },
    async promptToken() { calls.push("prompt"); return ""; },
    now: () => 0,
    log: (line) => { lines.push(line); },
    ...overrides,
  };
  return { d, lines, calls };
}

describe("kyoube connect claude", () => {
  it("writes the setup-token into the sign-in folder named by CLAUDE_CONFIG_DIR", async () => {
    const { home, dir } = await attemptDir();
    const { d, lines, calls } = deps();
    expect(await runConnect(["claude"], {}, { PAPERCLIP_HOME: home, CLAUDE_CONFIG_DIR: dir }, d)).toBe(0);
    expect(calls).toEqual([`setup-token ${dir}`]);
    expect(JSON.parse(await readFile(path.join(dir, ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe(TOKEN);
    expect(lines.at(-1)).toBe("Done. The token is valid for a year. Click Connect in the browser to finish.");
  });

  it("accepts --dir instead of CLAUDE_CONFIG_DIR", async () => {
    const { home, dir } = await attemptDir();
    expect(await runConnect(["claude"], { dir }, { PAPERCLIP_HOME: home }, deps().d)).toBe(0);
  });

  it("asks for the token when it cannot read it off the screen", async () => {
    const { home, dir } = await attemptDir();
    const { d, calls } = deps({ async runSetupToken() { return { code: 0, transcript: "garbled" }; }, async promptToken() { return `  ${TOKEN}\n`; } });
    expect(await runConnect(["claude"], {}, { PAPERCLIP_HOME: home, CLAUDE_CONFIG_DIR: dir }, d)).toBe(0);
    expect(calls).toEqual([]);
  });

  it("refuses to run outside a Connections sign-in, and writes nothing", async () => {
    const { home } = await attemptDir();
    const { d, lines, calls } = deps();
    expect(await runConnect(["claude"], {}, { PAPERCLIP_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude") }, d)).toBe(1);
    expect(await runConnect(["claude"], {}, { PAPERCLIP_HOME: home }, d)).toBe(1);
    expect(calls).toEqual([]);
    expect(lines[0]).toContain("Connections");
  });

  it("refuses a sign-in folder that no longer exists (expired attempt)", async () => {
    const { home } = await attemptDir();
    const gone = path.join(home, "instances", "default", "ai-local-logins", "expired");
    const { d, lines } = deps();
    expect(await runConnect(["claude"], {}, { PAPERCLIP_HOME: home, CLAUDE_CONFIG_DIR: gone }, d)).toBe(1);
    expect(lines[0]).toContain("expired");
  });

  it("says how to install Claude Code when it is missing", async () => {
    const { home, dir } = await attemptDir();
    const { d, lines } = deps({ async claudeOnPath() { return false; } });
    expect(await runConnect(["claude"], {}, { PAPERCLIP_HOME: home, CLAUDE_CONFIG_DIR: dir }, d)).toBe(1);
    expect(lines[0]).toContain("kyoube harness install claude");
  });

  it("passes on setup-token's own failure and rejects a pasted non-token", async () => {
    const { home, dir } = await attemptDir();
    expect(await runConnect(["claude"], {}, { PAPERCLIP_HOME: home, CLAUDE_CONFIG_DIR: dir }, deps({ async runSetupToken() { return { code: 1, transcript: "" }; } }).d)).toBe(1);
    const bad = deps({ async runSetupToken() { return { code: 0, transcript: "" }; }, async promptToken() { return "not-a-token"; } });
    expect(await runConnect(["claude"], {}, { PAPERCLIP_HOME: home, CLAUDE_CONFIG_DIR: dir }, bad.d)).toBe(1);
  });

  it("says a cancelled sign-in saved nothing, and does not ask for a token", async () => {
    const { home, dir } = await attemptDir();
    const { d, lines, calls } = deps({ async runSetupToken() { return { code: CANCELLED, transcript: "" }; } });
    expect(await runConnect(["claude"], {}, { PAPERCLIP_HOME: home, CLAUDE_CONFIG_DIR: dir }, d)).toBe(CANCELLED);
    expect(lines.at(-1)).toMatch(/^Cancelled; nothing was saved/);
    expect(calls).not.toContain("prompt");
    expect(existsSync(path.join(dir, ".credentials.json"))).toBe(false);
  });

  it("knows only claude", async () => {
    expect(await runConnect(["codex"], {}, {}, deps().d)).toBe(2);
  });
});

/** A stand-in for Node: records signal handlers and exits, and lets each test play out the run. */
function fakeHost(play: (run: { capture: string; child: EventEmitter; signal(name: NodeJS.Signals): void }) => void) {
  const handlers = new Map<NodeJS.Signals, () => void>();
  const exits: number[] = [];
  const spawned: { command: string; args: string[]; mode: number }[] = [];
  const host: CaptureHost = {
    spawn(command, args) {
      const capture = args[args.length - 1] ?? "";
      spawned.push({ command, args, mode: statSync(capture).mode & 0o777 });
      const child = new EventEmitter();
      setImmediate(() => play({ capture, child, signal: (name) => handlers.get(name)?.() }));
      return child as unknown as ReturnType<CaptureHost["spawn"]>;
    },
    on(signal, listener) { handlers.set(signal, listener); },
    off(signal, listener) { if (handlers.get(signal) === listener) handlers.delete(signal); },
    exit(code) { exits.push(code); },
  };
  return { host, handlers, exits, spawned };
}

describe("runCaptured (the screen copy of claude setup-token)", () => {
  async function capturePath() {
    return path.join(await mkdtemp(path.join(tmpdir(), "kyoube-attempt-")), ".setup-token.typescript");
  }

  it("runs claude under script, with the copy readable by its owner only, and removes the copy afterwards", async () => {
    const capture = await capturePath();
    const fake = fakeHost(async ({ capture: file, child }) => { await writeFile(file, SCREEN); child.emit("close", 0); });
    const result = await runCaptured(capture, {}, fake.host);
    expect(fake.spawned).toEqual([{ command: "script", args: ["-q", "-f", "-e", "-c", "claude setup-token", capture], mode: 0o600 }]);
    expect(result).toEqual({ code: 0, transcript: SCREEN });
    expect(existsSync(capture)).toBe(false);
    expect(fake.handlers.size).toBe(0);
  });

  it("waits out Ctrl+C, then removes the copy and reports a cancel", async () => {
    const capture = await capturePath();
    const fake = fakeHost(({ child, signal }) => { signal("SIGINT"); child.emit("close", 0); });
    expect((await runCaptured(capture, {}, fake.host)).code).toBe(CANCELLED);
    expect(existsSync(capture)).toBe(false);
    expect(fake.exits).toEqual([]);
    expect(fake.handlers.size).toBe(0);
  });

  it("keeps a token that was printed before the Ctrl+C", async () => {
    const capture = await capturePath();
    const fake = fakeHost(async ({ capture: file, child, signal }) => { await writeFile(file, SCREEN); signal("SIGINT"); child.emit("close", 0); });
    expect(await runCaptured(capture, {}, fake.host)).toEqual({ code: 0, transcript: SCREEN });
  });

  it("removes the copy before exiting when the Terminal session hangs up or is killed", async () => {
    for (const [signal, code] of [["SIGHUP", 129], ["SIGTERM", 143]] as const) {
      const capture = await capturePath();
      let goneAtExit = false;
      const fake = fakeHost(async ({ capture: file, signal: send }) => { await writeFile(file, SCREEN); send(signal); });
      fake.host.exit = (status) => { goneAtExit = !existsSync(capture); fake.exits.push(status); };
      void runCaptured(capture, {}, fake.host);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fake.exits).toEqual([code]);
      expect(goneAtExit).toBe(true);
    }
  });

  it("settles once when script cannot start", async () => {
    const capture = await capturePath();
    const fake = fakeHost(({ child }) => { child.emit("error"); child.emit("close", null); });
    expect((await runCaptured(capture, {}, fake.host)).code).toBe(127);
    expect(existsSync(capture)).toBe(false);
  });
});
