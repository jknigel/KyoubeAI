import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { oneYearFrom } from "../src/dates.js";
import { verifyLicense } from "../src/key.js";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const exec = promisify(execFile);
let home: string;

beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), "kyoube-license-home-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const run = (script: string, args: string[]) =>
  exec(process.execPath, [path.join(SCRIPTS, script), ...args], { env: { ...process.env, KYOUBE_LICENSE_HOME: home } });

async function keygen(kid: string): Promise<string> {
  const { stdout } = await run("keygen.mjs", [kid]);
  const line = stdout.split("\n").find((entry) => entry.trim().startsWith(JSON.stringify(kid)));
  if (!line) throw new Error(`no trusted-keys line in:\n${stdout}`);
  return JSON.parse(line.trim().replace(/^"[^"]+":\s*/, "").replace(/,$/, "")) as string;
}

describe("keygen", () => {
  it("writes the private key with mode 600 and prints the public key line", async () => {
    const publicPem = await keygen("ci1");
    expect(publicPem).toContain("-----BEGIN PUBLIC KEY-----");
    expect((await stat(path.join(home, "keys", "ci1.pem"))).mode & 0o777).toBe(0o600);
  });
  it("refuses a kid that already exists, and a kid with odd characters", async () => {
    await keygen("ci1");
    await expect(run("keygen.mjs", ["ci1"])).rejects.toMatchObject({ code: 1 });
    await expect(run("keygen.mjs", ["Bad Kid"])).rejects.toMatchObject({ code: 1 });
  });
});

describe("sign", () => {
  it("issues a key that verifies against the keygen public key", async () => {
    const publicPem = await keygen("ci1");
    const { stdout } = await run("sign.mjs", ["--kid", "ci1", "--customer", "KyoubeAI CI", "--seats", "7", "--perpetual"]);
    const key = stdout.trim();
    const result = verifyLicense(key, { trustedKeys: { ci1: publicPem }, instanceId: null, now: new Date() });
    expect(result.code).toBe("valid");
    expect(result.payload).toMatchObject({ customer: "KyoubeAI CI", seats: 7, expiresAt: null, instanceId: null });
    expect(result.payload?.id).toMatch(/^lic_[A-Za-z0-9_-]{12}$/);
  });
  it("defaults to one year from today, binds to an instance on request, and tolerates a stray --", async () => {
    const publicPem = await keygen("ci1");
    const { stdout } = await run("sign.mjs", ["--", "--kid", "ci1", "--customer", "Acme", "--seats", "3", "--instance", "inst-1"]);
    const result = verifyLicense(stdout.trim(), { trustedKeys: { ci1: publicPem }, instanceId: "inst-1", now: new Date() });
    const today = new Date().toISOString().slice(0, 10);
    expect(result.payload).toMatchObject({ expiresAt: oneYearFrom(today), instanceId: "inst-1", issuedAt: today });
  });
  it("refuses bad input", async () => {
    await keygen("ci1");
    await expect(run("sign.mjs", ["--kid", "ci1", "--customer", "Acme", "--seats", "0"])).rejects.toMatchObject({ code: 1 });
    await expect(run("sign.mjs", ["--kid", "ci1", "--seats", "5"])).rejects.toMatchObject({ code: 1 });
    await expect(run("sign.mjs", ["--kid", "nope", "--customer", "Acme", "--seats", "5"])).rejects.toMatchObject({ code: 1 });
    await expect(run("sign.mjs", ["--kid", "ci1", "--customer", "Acme", "--seats", "5", "--perpetual", "--expires", "2030-01-01"])).rejects.toMatchObject({ code: 1 });
  });
});
