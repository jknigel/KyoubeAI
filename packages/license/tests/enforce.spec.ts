import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHECK_FAILED_CODE, CHECK_FAILED_MESSAGE, checkSeat, SEAT_LIMIT_CODE, seatLimitMessage } from "../src/enforce.js";
import { licensePaths } from "../src/files.js";
import { signLicense, type LicensePayload } from "../src/key.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const TRUSTED = { test1: publicKey.export({ type: "spki", format: "pem" }).toString() };
const PRIVATE = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PAYLOAD: LicensePayload = { v: 1, kid: "test1", id: "lic_test0001", customer: "Acme Ltd", seats: 10, issuedAt: "2026-10-03", expiresAt: "2027-10-03", instanceId: null };
const NOW = () => new Date("2026-10-03T12:00:00Z");
const quiet = () => {};

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "kyoube-enforce-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const seat = (count: number | (() => Promise<number>)) =>
  checkSeat({ countUsers: typeof count === "number" ? async () => count : count, trustedKeys: TRUSTED, dir, now: NOW, log: quiet });

describe("checkSeat", () => {
  it("lets the first five accounts in and refuses the sixth without a key", async () => {
    expect(await seat(0)).toEqual({ ok: true, count: 0, limit: 5 });
    expect(await seat(4)).toEqual({ ok: true, count: 4, limit: 5 });
    expect(await seat(5)).toEqual({ ok: false, status: "BAD_REQUEST", code: SEAT_LIMIT_CODE, message: seatLimitMessage(5, 5), count: 5, limit: 5 });
  });

  it("words the refusal as the spec does", () => {
    expect(seatLimitMessage(5, 5)).toBe("This KyoubeAI instance has reached its user limit (5 of 5). An instance admin can add a licence key under Settings → Plugins → KyoubeAI Licence.");
  });

  it("raises the limit to the key's seats", async () => {
    await writeFile(licensePaths(dir).key, signLicense(PAYLOAD, PRIVATE));
    expect(await seat(9)).toMatchObject({ ok: true, limit: 10 });
    expect(await seat(10)).toMatchObject({ ok: false, code: SEAT_LIMIT_CODE, limit: 10 });
  });

  it("goes back to 5 after the key expires, without touching anyone already in", async () => {
    await writeFile(licensePaths(dir).key, signLicense({ ...PAYLOAD, expiresAt: "2026-09-01" }, PRIVATE));
    expect(await seat(7)).toMatchObject({ ok: false, code: SEAT_LIMIT_CODE, count: 7, limit: 5 });
  });

  it("honours an instance-bound key only on its instance", async () => {
    await writeFile(licensePaths(dir).key, signLicense({ ...PAYLOAD, instanceId: "inst-1" }, PRIVATE));
    await writeFile(licensePaths(dir).instanceId, "inst-2\n");
    expect(await seat(5)).toMatchObject({ ok: false, limit: 5 });
    await writeFile(licensePaths(dir).instanceId, "inst-1\n");
    expect(await seat(5)).toMatchObject({ ok: true, limit: 10 });
  });

  it("treats an unreadable key file as no key", async () => {
    await mkdir(licensePaths(dir).key);
    expect(await seat(4)).toMatchObject({ ok: true, limit: 5 });
  });

  it("fails closed when counting fails or gives nonsense", async () => {
    const failed = { ok: false, status: "INTERNAL_SERVER_ERROR", code: CHECK_FAILED_CODE, message: CHECK_FAILED_MESSAGE };
    expect(await seat(async () => { throw new Error("db down"); })).toEqual(failed);
    expect(await seat(async () => Number.NaN)).toEqual(failed);
    expect(await seat(async () => -1)).toEqual(failed);
  });
});

describe("the built enforce.mjs", () => {
  it("exports checkSeat bound to the shipped trusted keys", async () => {
    const built = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "dist", "enforce.mjs");
    const module = (await import(pathToFileURL(built).href)) as { checkSeat: (deps: { countUsers: () => Promise<number> }) => Promise<{ ok: boolean; limit?: number }> };
    // /kyoubeai/kyoube does not exist outside the container, so this is the free tier.
    expect(await module.checkSeat({ countUsers: async () => 4 })).toMatchObject({ ok: true, limit: 5 });
    expect(await module.checkSeat({ countUsers: async () => 5 })).toMatchObject({ ok: false });
  });
});
