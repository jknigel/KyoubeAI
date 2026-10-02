import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureInstanceId, licensePaths, readTrimmed, readUserSnapshot, removeLicenseKey, writeLicenseKey, writeUserSnapshot, type UserSnapshot } from "../src/files.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "kyoube-license-files-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const SNAPSHOT: UserSnapshot = { at: "2026-10-03T12:00:00.000Z", users: [{ id: "u1", email: "a@x.test", name: "A", createdAt: "2026-10-01T00:00:00.000Z", isInstanceAdmin: true }] };

describe("licensePaths", () => {
  it("names the three files under /kyoubeai/kyoube by default", () => {
    expect(licensePaths()).toEqual({ key: "/kyoubeai/kyoube/license.key", instanceId: "/kyoubeai/kyoube/instance-id", users: "/kyoubeai/kyoube/license-users.json" });
  });
});

describe("readTrimmed", () => {
  it("is null for a missing, empty or blank file and trimmed otherwise", async () => {
    const file = path.join(dir, "f");
    expect(await readTrimmed(file)).toBeNull();
    await writeFile(file, "  \n");
    expect(await readTrimmed(file)).toBeNull();
    await writeFile(file, "  KYB1.a.b\n");
    expect(await readTrimmed(file)).toBe("KYB1.a.b");
  });
  it("is null when the path is a directory", async () => {
    expect(await readTrimmed(dir)).toBeNull();
  });
});

describe("writeLicenseKey and removeLicenseKey", () => {
  it("writes the trimmed key with mode 600, and removing twice is fine", async () => {
    const { key } = licensePaths(dir);
    await writeLicenseKey(key, "  KYB1.a.b  ");
    expect(await readFile(key, "utf8")).toBe("KYB1.a.b\n");
    expect((await stat(key)).mode & 0o777).toBe(0o600);
    await removeLicenseKey(key);
    await removeLicenseKey(key);
    expect(await readTrimmed(key)).toBeNull();
  });
});

describe("ensureInstanceId", () => {
  it("creates the ID once and keeps it", async () => {
    const { instanceId } = licensePaths(dir);
    expect(await ensureInstanceId(instanceId, () => "first")).toBe("first");
    expect(await ensureInstanceId(instanceId, () => "second")).toBe("first");
  });
  it("replaces an empty file", async () => {
    const { instanceId } = licensePaths(dir);
    await writeFile(instanceId, "");
    expect(await ensureInstanceId(instanceId, () => "fresh")).toBe("fresh");
  });
  it("creates the folder when it doesn't exist", async () => {
    expect(await ensureInstanceId(path.join(dir, "deeper", "instance-id"), () => "x")).toBe("x");
  });
});

describe("the user snapshot", () => {
  it("round-trips", async () => {
    const { users } = licensePaths(dir);
    await writeUserSnapshot(users, SNAPSHOT);
    expect(await readUserSnapshot(users)).toEqual(SNAPSHOT);
    expect((await stat(users)).mode & 0o777).toBe(0o600);
  });
  it("is null when missing, not JSON, or the wrong shape", async () => {
    const { users } = licensePaths(dir);
    expect(await readUserSnapshot(users)).toBeNull();
    await writeFile(users, "{not json");
    expect(await readUserSnapshot(users)).toBeNull();
    await writeFile(users, JSON.stringify({ at: "x", users: "nope" }));
    expect(await readUserSnapshot(users)).toBeNull();
    await writeFile(users, JSON.stringify({ at: "x", users: [{ id: "u1", email: "a", name: "A", createdAt: "c" }] }));
    expect(await readUserSnapshot(users)).toBeNull();
  });
});
