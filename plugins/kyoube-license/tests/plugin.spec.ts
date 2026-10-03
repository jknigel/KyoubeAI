import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { licensePaths, signLicense, writeUserSnapshot, type LicensePayload, type SnapshotUser } from "@kyoube/license";
import manifest from "../src/manifest.js";
import { createLicensePlugin } from "../src/plugin.js";
import type { ApplyAnswer, LicenceStatusAnswer, LicenceView } from "../src/shared.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const TRUSTED = { test1: publicKey.export({ type: "spki", format: "pem" }).toString() };
const PRIVATE = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PAYLOAD: LicensePayload = { v: 1, kid: "test1", id: "lic_test0001", customer: "Acme Ltd", seats: 10, issuedAt: "2026-10-03", expiresAt: "2027-10-03", instanceId: null };
const ADMIN = { type: "user" as const, userId: "u1" };
const MEMBER = { type: "user" as const, userId: "u2" };
const user = (n: number, admin = false): SnapshotUser => ({ id: `u${n}`, email: `u${n}@x.test`, name: `User ${n}`, createdAt: "2026-10-01T00:00:00.000Z", isInstanceAdmin: admin });

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "kyoube-license-plugin-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function setup(users: SnapshotUser[] | null = [user(1, true), user(2)]) {
  if (users) await writeUserSnapshot(licensePaths(dir).users, { at: "2026-10-03T11:59:00.000Z", users });
  await writeFile(licensePaths(dir).instanceId, "inst-1\n");
  const harness = createTestHarness({ manifest, config: {} });
  const plugin = createLicensePlugin({ dir, now: () => new Date("2026-10-03T12:00:00Z"), trustedKeys: TRUSTED });
  await plugin.definition.setup(harness.ctx);
  const act = <T,>(key: string, params: Record<string, unknown> = {}, actor: { type: "user"; userId: string } = ADMIN) =>
    harness.performAction<T>(key, params, { actor, companyId: null });
  return { act };
}

describe("license.status", () => {
  it("shows an instance admin the status, the instance ID and everyone counted", async () => {
    const { act } = await setup();
    const answer = await act<LicenceStatusAnswer>("license.status");
    expect(answer.visible).toBe(true);
    const view = answer as LicenceView;
    expect(view.status.summary).toBe("Free: 2 of 5 users");
    expect(view.instanceId).toBe("inst-1");
    expect(view.snapshotAt).toBe("2026-10-03T11:59:00.000Z");
    expect(view.users.map((u) => [u.email, u.removeCommand])).toEqual([["u1@x.test", "kyoube users remove 'u1@x.test'"], ["u2@x.test", "kyoube users remove 'u2@x.test'"]]);
  });

  it("shows nothing to someone who isn't an instance admin", async () => {
    const { act } = await setup();
    expect(await act("license.status", {}, MEMBER)).toEqual({ visible: false, reason: "not_admin" });
  });

  it("answers no_snapshot while the user list hasn't been read, and when it is corrupt", async () => {
    const { act } = await setup(null);
    expect(await act("license.status")).toEqual({ visible: false, reason: "no_snapshot" });
    await writeFile(licensePaths(dir).users, "{corrupt");
    expect(await act("license.status")).toEqual({ visible: false, reason: "no_snapshot" });
    expect(await act<ApplyAnswer>("license.apply", { key: signLicense(PAYLOAD, PRIVATE) })).toEqual({ ok: false, message: "KyoubeAI is still reading the user list. Try again in a minute." });
  });
});

describe("license.apply and license.clear", () => {
  it("writes a valid key and answers the new status", async () => {
    const { act } = await setup();
    const key = signLicense(PAYLOAD, PRIVATE);
    const answer = await act<ApplyAnswer>("license.apply", { key: `  ${key}\n` });
    expect(answer.ok).toBe(true);
    expect(answer.ok && answer.view.status.summary).toBe("Licensed to Acme Ltd: 2 of 10 users · expires 3 Oct 2027");
    expect(await readFile(licensePaths(dir).key, "utf8")).toBe(`${key}\n`);
  });

  it("never writes a key that isn't valid, and says why", async () => {
    const { act } = await setup();
    expect(await act("license.apply", { key: "KYB1.nope.nope" })).toEqual({ ok: false, message: "This doesn't look like a KyoubeAI licence key. Check it was copied in full." });
    await expect(readFile(licensePaths(dir).key, "utf8")).rejects.toThrow();
  });

  it("refuses a non-admin", async () => {
    const { act } = await setup();
    await expect(act("license.apply", { key: signLicense(PAYLOAD, PRIVATE) }, MEMBER)).rejects.toThrow(/^forbidden:/);
    await expect(act("license.clear", {}, MEMBER)).rejects.toThrow(/^forbidden:/);
  });

  it("clears the key back to Free", async () => {
    const { act } = await setup();
    await act("license.apply", { key: signLicense(PAYLOAD, PRIVATE) });
    const answer = await act<ApplyAnswer>("license.clear");
    expect(answer.ok && answer.view.status.summary).toBe("Free: 2 of 5 users");
  });
});
