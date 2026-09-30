import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractSetupToken, isSignInAttemptDir, renderCredentials, writeCredentials } from "../src/claude-token.js";

const TOKEN = "sk-ant-oat01-AbCdEf0123456789_-AbCdEf0123456789_-xyz";
const BEFORE = "Your OAuth token (valid for 1 year):";
const AFTER = "Store this token securely. You won't be able to see it again.";

describe("extractSetupToken", () => {
  it("reads a plain success screen", () => {
    expect(extractSetupToken(`Login successful\n\n${BEFORE}\n\n${TOKEN}\n\n${AFTER}\n`)).toBe(TOKEN);
  });

  it("strips colours, carriage returns and cursor codes, and rejoins a wrapped token", () => {
    const wrapped = `${TOKEN.slice(0, 20)}\r\n${TOKEN.slice(20, 40)}\r\n${TOKEN.slice(40)}`;
    const screen = `\x1b[32m✓\x1b[39m Login successful\r\n\r\n\x1b[1m${BEFORE}\x1b[22m\r\n\r\n\x1b[?25l${wrapped}\r\n\r\n${AFTER}\r\n`;
    expect(extractSetupToken(screen)).toBe(TOKEN);
  });

  it("uses the last success block when the screen was redrawn", () => {
    const stale = `${BEFORE}\nsk-ant-oat01-stale\n${AFTER}\n`;
    expect(extractSetupToken(`${stale}${BEFORE}\n${TOKEN}\n${AFTER}\n`)).toBe(TOKEN);
  });

  it("returns null without both anchors or for something that is not a token", () => {
    expect(extractSetupToken(`${BEFORE}\n${TOKEN}\n`)).toBeNull();
    expect(extractSetupToken(`${TOKEN}\n${AFTER}\n`)).toBeNull();
    expect(extractSetupToken(`${BEFORE}\nsk-ant-api03-notanoauthtoken0123456789\n${AFTER}\n`)).toBeNull();
    expect(extractSetupToken(`${BEFORE}\nsk-ant-oat01-short\n${AFTER}\n`)).toBeNull();
  });

  const REAL = new URL("./fixtures/setup-token-real.txt", import.meta.url);
  it.runIf(existsSync(REAL))("reads a real (redacted) `claude setup-token` transcript", async () => {
    const token = extractSetupToken(await readFile(REAL, "utf8"));
    expect(token).toMatch(/^sk-ant-oat01-X{20,}$/);
  });
});

describe("isSignInAttemptDir", () => {
  it("accepts only a Connections sign-in folder under the home", () => {
    expect(isSignInAttemptDir("/kyoubeai/instances/default/ai-local-logins/2f1c", "/kyoubeai")).toBe(true);
    expect(isSignInAttemptDir("/kyoubeai/instances/default/ai-local-logins/2f1c/", "/kyoubeai")).toBe(true);
    expect(isSignInAttemptDir("/kyoubeai/.claude", "/kyoubeai")).toBe(false);
    expect(isSignInAttemptDir("/kyoubeai/instances/default/ai-local-logins", "/kyoubeai")).toBe(false);
    expect(isSignInAttemptDir("/kyoubeai/instances/default/ai-local-logins/a/b", "/kyoubeai")).toBe(false);
    expect(isSignInAttemptDir("/kyoubeai/instances/default/ai-local-logins/../../../.claude", "/kyoubeai")).toBe(false);
    expect(isSignInAttemptDir("/tmp/instances/default/ai-local-logins/x", "/kyoubeai")).toBe(false);
    expect(isSignInAttemptDir("", "/kyoubeai")).toBe(false);
  });
});

describe("credentials file", () => {
  it("has the shape the core's Connect step reads, valid for a year", () => {
    const now = Date.UTC(2026, 9, 1);
    expect(JSON.parse(renderCredentials(TOKEN, now))).toEqual({
      claudeAiOauth: { accessToken: TOKEN, refreshToken: null, expiresAt: now + 365 * 24 * 60 * 60 * 1000, scopes: ["user:inference"] },
    });
  });

  it("is written atomically with mode 600, replacing an earlier one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "connect-"));
    await writeFile(path.join(dir, ".credentials.json"), "old");
    await writeCredentials(dir, TOKEN, 0);
    const file = path.join(dir, ".credentials.json");
    expect(JSON.parse(await readFile(file, "utf8")).claudeAiOauth.accessToken).toBe(TOKEN);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
