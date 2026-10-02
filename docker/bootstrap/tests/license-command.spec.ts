import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { licensePaths, readUserSnapshot, signLicense, type LicensePayload, type SnapshotUser } from "@kyoube/license";
import { refreshSnapshot, runLicense, type LicenseDeps } from "../src/commands/license.js";
import type { CoreUsersDb } from "../src/license/core-db.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const TRUSTED = { test1: publicKey.export({ type: "spki", format: "pem" }).toString() };
const PRIVATE = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PAYLOAD: LicensePayload = { v: 1, kid: "test1", id: "lic_test0001", customer: "Acme Ltd", seats: 10, issuedAt: "2026-10-03", expiresAt: "2027-10-03", instanceId: null };
const NOW = new Date("2026-10-03T12:00:00Z");

const user = (n: number, admin = false): SnapshotUser => ({ id: `u${n}`, email: `u${n}@x.test`, name: `User ${n}`, createdAt: "2026-10-01T00:00:00.000Z", isInstanceAdmin: admin });

class FakeDb implements CoreUsersDb {
  closed = 0;
  constructor(public users: SnapshotUser[], public fail = false) {}
  async listUsers() { if (this.fail) throw new Error("db down"); return [...this.users]; }
  async deleteUser(id: string) { const before = this.users.length; this.users = this.users.filter((u) => u.id !== id); return this.users.length < before; }
  async close() { this.closed += 1; }
}

let dir: string;
let lines: string[];
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "kyoube-license-cmd-")); lines = []; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function deps(db: FakeDb, extra: Partial<LicenseDeps> = {}): Partial<LicenseDeps> {
  return { dir: async () => dir, openDb: () => db, now: () => NOW, trustedKeys: TRUSTED, log: (line) => lines.push(line), sleep: async () => {}, ...extra };
}

describe("refreshSnapshot", () => {
  it("writes every user with the time it read them", async () => {
    const snapshot = await refreshSnapshot(new FakeDb([user(1, true), user(2)]), licensePaths(dir).users, NOW);
    expect(snapshot).toEqual({ at: NOW.toISOString(), users: [user(1, true), user(2)] });
    expect(await readUserSnapshot(licensePaths(dir).users)).toEqual(snapshot);
  });
});

describe("kyoube license", () => {
  it("shows the free status and the instance ID by default", async () => {
    await writeFile(licensePaths(dir).instanceId, "inst-1\n");
    expect(await runLicense([], {}, {}, deps(new FakeDb([user(1, true), user(2)])))).toBe(0);
    expect(lines.join("\n")).toContain("Licence:      Free: 2 of 5 users");
    expect(lines.join("\n")).toContain("Instance ID:  inst-1");
  });

  it("sets a valid key and shows the licensed status", async () => {
    const db = new FakeDb([user(1, true)]);
    expect(await runLicense(["set", signLicense(PAYLOAD, PRIVATE)], {}, {}, deps(db))).toBe(0);
    expect(await readFile(licensePaths(dir).key, "utf8")).toBe(`${signLicense(PAYLOAD, PRIVATE)}\n`);
    expect(lines.join("\n")).toContain("Licensed to Acme Ltd: 1 of 10 users · expires 3 Oct 2027");
    expect(db.closed).toBe(1);
  });

  it("creates the instance ID when setting a key on an instance that has none yet", async () => {
    await runLicense(["set", signLicense(PAYLOAD, PRIVATE)], {}, {}, deps(new FakeDb([user(1, true)])));
    expect((await readFile(licensePaths(dir).instanceId, "utf8")).trim()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("never writes a key that isn't valid, and says why", async () => {
    expect(await runLicense(["set", signLicense({ ...PAYLOAD, expiresAt: "2026-01-01" }, PRIVATE)], {}, {}, deps(new FakeDb([user(1)])))).toBe(1);
    expect(lines.join("\n")).toContain("kyoube: licence key not applied: This key expired on 1 Jan 2026.");
    await expect(readFile(licensePaths(dir).key, "utf8")).rejects.toThrow();
  });

  it("refuses set without a key", async () => {
    expect(await runLicense(["set"], {}, {}, deps(new FakeDb([])))).toBe(1);
  });

  it("clears the key", async () => {
    await writeFile(licensePaths(dir).key, "x\n");
    expect(await runLicense(["clear"], {}, {}, deps(new FakeDb([])))).toBe(0);
    await expect(readFile(licensePaths(dir).key, "utf8")).rejects.toThrow();
    expect(lines.join("\n")).toContain("the free limit of 5 users applies");
  });

  it("refreshes the snapshot once", async () => {
    expect(await runLicense(["refresh"], {}, {}, deps(new FakeDb([user(1, true), user(2)])))).toBe(0);
    expect((await readUserSnapshot(licensePaths(dir).users))?.users).toHaveLength(2);
    expect(lines).toEqual([`kyoube: licence: 2 users as of ${NOW.toISOString()}`]);
  });

  it("--watch refreshes every pass, logs only changes and failures, and survives a failing database", async () => {
    const db = new FakeDb([user(1, true)]);
    let pass = 0;
    const sleep = async () => {
      pass += 1;
      if (pass === 1) db.fail = true;
      if (pass === 2) { db.fail = false; db.users.push(user(2)); }
    };
    expect(await runLicense([], { watch: true }, {}, deps(db, { sleep, maxPasses: 4 }))).toBe(0);
    expect(lines).toEqual([
      `kyoube: licence: 1 users as of ${NOW.toISOString()}`,
      "kyoube: licence: could not read the users: db down",
      `kyoube: licence: 2 users as of ${NOW.toISOString()}`,
    ]);
  });

  it("prints usage for an unknown subcommand", async () => {
    expect(await runLicense(["frobnicate"], {}, {}, deps(new FakeDb([])))).toBe(1);
    expect(lines.join("\n")).toContain("usage: kyoube license");
  });
});
