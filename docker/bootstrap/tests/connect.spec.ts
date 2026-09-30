import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runConnect, type ConnectDeps } from "../src/commands/connect.js";

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
    expect(await runConnect(["claude"], {}, { PAPERCLIP_HOME: home, CLAUDE_CONFIG_DIR: dir }, deps({ async runSetupToken() { return { code: 130, transcript: "" }; } }).d)).toBe(130);
    const bad = deps({ async runSetupToken() { return { code: 0, transcript: "" }; }, async promptToken() { return "not-a-token"; } });
    expect(await runConnect(["claude"], {}, { PAPERCLIP_HOME: home, CLAUDE_CONFIG_DIR: dir }, bad.d)).toBe(1);
  });

  it("knows only claude", async () => {
    expect(await runConnect(["codex"], {}, {}, deps().d)).toBe(2);
  });
});
