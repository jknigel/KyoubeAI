import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { signLicense, type LicensePayload } from "@kyoube/license";
import { describe, expect, it } from "vitest";
import { fileLicenceGate } from "../../src/groups/licence.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const trustedKeys = { test1: publicKey.export({ type: "spki", format: "pem" }).toString() };
const PRIVATE = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const BASE: LicensePayload = { v: 1, kid: "test1", id: "lic_test0001", customer: "Acme", seats: 20, issuedAt: "2019-01-01", expiresAt: "2099-01-01", instanceId: null };
// `now` drives both the cache clock and the expiry check, so tests pin it to a real date.
const NOW = Date.parse("2026-10-09T12:00:00Z");

const keyFor = (patch: Partial<LicensePayload> = {}) => signLicense({ ...BASE, ...patch }, PRIVATE);

async function dirWith(key: string | null): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "kyoube-licence-"));
  if (key !== null) await writeFile(path.join(dir, "license.key"), `${key}\n`);
  return dir;
}

describe("fileLicenceGate", () => {
  it("is locked without a key", async () => {
    expect(await fileLicenceGate({ dir: await dirWith(null), trustedKeys }).unlocked()).toBe(false);
  });

  it("is unlocked by a valid key and locked by an expired one", async () => {
    const now = () => new Date(NOW);
    expect(await fileLicenceGate({ dir: await dirWith(keyFor()), trustedKeys, now }).unlocked()).toBe(true);
    expect(await fileLicenceGate({ dir: await dirWith(keyFor({ expiresAt: "2020-01-01" })), trustedKeys, now }).unlocked()).toBe(false);
  });

  it("is locked by a key signed by an untrusted key", async () => {
    const other = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const key = signLicense(BASE, other);
    expect(await fileLicenceGate({ dir: await dirWith(key), trustedKeys, now: () => new Date(NOW) }).unlocked()).toBe(false);
  });

  it("caches the answer for cacheMs", async () => {
    let t = NOW;
    const dir = await dirWith(keyFor());
    const gate = fileLicenceGate({ dir, trustedKeys, cacheMs: 1000, now: () => new Date(t) });
    expect(await gate.unlocked()).toBe(true);
    await writeFile(path.join(dir, "license.key"), "garbage\n");
    t = NOW + 500;
    expect(await gate.unlocked()).toBe(true);
    t = NOW + 1500;
    expect(await gate.unlocked()).toBe(false);
  });
});
