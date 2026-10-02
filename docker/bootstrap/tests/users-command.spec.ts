import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { licensePaths, readUserSnapshot, type SnapshotUser } from "@kyoube/license";
import { runUsers, type UsersCoreApi, type UsersDeps } from "../src/commands/users.js";
import type { CoreUsersDb } from "../src/license/core-db.js";

const user = (n: number, admin = false): SnapshotUser => ({ id: `u${n}`, email: `u${n}@x.test`, name: `User ${n}`, createdAt: "2026-10-01T00:00:00.000Z", isInstanceAdmin: admin });

class FakeDb implements CoreUsersDb {
  deleted: string[] = [];
  constructor(public users: SnapshotUser[]) {}
  async listUsers() { return [...this.users]; }
  async deleteUser(id: string) { this.deleted.push(id); const before = this.users.length; this.users = this.users.filter((u) => u.id !== id); return this.users.length < before; }
  async close() {}
}

class FakeApi implements UsersCoreApi {
  calls: string[] = [];
  async setUserCompanyAccess(userId: string, companyIds: string[]) { this.calls.push(`access ${userId} [${companyIds.join(",")}]`); }
  async demoteInstanceAdmin(userId: string) { this.calls.push(`demote ${userId}`); }
}

let dir: string;
let lines: string[];
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "kyoube-users-cmd-")); lines = []; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function deps(db: FakeDb, api: FakeApi, extra: Partial<UsersDeps> = {}): Partial<UsersDeps> {
  return {
    dir: async () => dir,
    openDb: () => db,
    coreApi: async () => api,
    boardKeyUserId: async () => "u1",
    confirm: async () => true,
    now: () => new Date("2026-10-03T12:00:00Z"),
    trustedKeys: {},
    log: (line) => lines.push(line),
    ...extra,
  };
}

describe("kyoube users list", () => {
  it("lists everyone counted and the total against the limit", async () => {
    expect(await runUsers(["list"], {}, {}, deps(new FakeDb([user(1, true), user(2)]), new FakeApi()))).toBe(0);
    expect(lines).toEqual([
      "u1@x.test  User 1  created 1 Oct 2026  instance admin",
      "u2@x.test  User 2  created 1 Oct 2026",
      "2 of 5 users",
    ]);
  });
});

describe("kyoube users remove", () => {
  it("archives the memberships, then deletes the account, then refreshes the snapshot", async () => {
    const db = new FakeDb([user(1, true), user(2)]);
    const api = new FakeApi();
    expect(await runUsers(["remove", "U2@x.test"], { yes: true }, {}, deps(db, api))).toBe(0);
    expect(api.calls).toEqual(["access u2 []"]);
    expect(db.deleted).toEqual(["u2"]);
    expect((await readUserSnapshot(licensePaths(dir).users))?.users.map((u) => u.id)).toEqual(["u1"]);
    expect(lines.at(-1)).toBe("kyoube: removed u2@x.test. 1 of 5 users.");
  });

  it("demotes an instance admin before deleting them, while another admin remains", async () => {
    const db = new FakeDb([user(1, true), user(2, true)]);
    const api = new FakeApi();
    expect(await runUsers(["remove", "u2@x.test"], { yes: true }, {}, deps(db, api))).toBe(0);
    expect(api.calls).toEqual(["access u2 []", "demote u2"]);
  });

  it("refuses to remove the last instance admin", async () => {
    const db = new FakeDb([user(1), user(2, true)]);
    expect(await runUsers(["remove", "u2@x.test"], { yes: true }, {}, deps(db, new FakeApi(), { boardKeyUserId: async () => null }))).toBe(1);
    expect(db.deleted).toEqual([]);
    expect(lines.join("\n")).toContain("the last instance admin");
  });

  it("refuses to remove the user who owns the stored board key", async () => {
    const db = new FakeDb([user(1, true), user(2, true)]);
    expect(await runUsers(["remove", "u1@x.test"], { yes: true }, {}, deps(db, new FakeApi()))).toBe(1);
    expect(db.deleted).toEqual([]);
    expect(lines.join("\n")).toContain("owns the board API key kyoube uses");
  });

  it("stops when the person says no", async () => {
    const db = new FakeDb([user(1, true), user(2)]);
    expect(await runUsers(["remove", "u2@x.test"], {}, {}, deps(db, new FakeApi(), { confirm: async () => false }))).toBe(1);
    expect(db.deleted).toEqual([]);
  });

  it("says so when no one has that email", async () => {
    expect(await runUsers(["remove", "nobody@x.test"], { yes: true }, {}, deps(new FakeDb([user(1, true)]), new FakeApi()))).toBe(1);
    expect(lines.join("\n")).toContain("no user with the email nobody@x.test");
  });

  it("deletes nothing when archiving the memberships fails", async () => {
    const db = new FakeDb([user(1, true), user(2)]);
    const api = new FakeApi();
    api.setUserCompanyAccess = async () => { throw new Error("403 forbidden"); };
    await expect(runUsers(["remove", "u2@x.test"], { yes: true }, {}, deps(db, api))).rejects.toThrow("403 forbidden");
    expect(db.deleted).toEqual([]);
  });
});
