import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** KyoubeAI's own folder on the home volume (config.json and board-key.json live here too). */
export const KYOUBE_DIR = "/kyoubeai/kyoube";

export interface LicensePaths {
  key: string;
  instanceId: string;
  users: string;
}

export function licensePaths(dir: string = KYOUBE_DIR): LicensePaths {
  return { key: path.join(dir, "license.key"), instanceId: path.join(dir, "instance-id"), users: path.join(dir, "license-users.json") };
}

/** The file's trimmed text; null when it is missing, unreadable or blank. */
export async function readTrimmed(file: string): Promise<string | null> {
  try {
    const text = (await readFile(file, "utf8")).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** Writes through a temporary file and a rename, mode 600, so a reader never sees half a file. */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
}

export async function writeLicenseKey(file: string, key: string): Promise<void> {
  await writeAtomic(file, `${key.trim()}\n`);
}

export async function removeLicenseKey(file: string): Promise<void> {
  await rm(file, { force: true });
}

/** The instance ID, created once (a random UUID) if the file is missing or blank. */
export async function ensureInstanceId(file: string, newId: () => string = randomUUID): Promise<string> {
  const existing = await readTrimmed(file);
  if (existing) return existing;
  const id = newId();
  await writeAtomic(file, `${id}\n`);
  return id;
}

export interface SnapshotUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  isInstanceAdmin: boolean;
}

/** Every counted user, as `kyoube license --watch` last read them from the core database. */
export interface UserSnapshot {
  at: string;
  users: SnapshotUser[];
}

function isSnapshotUser(value: unknown): value is SnapshotUser {
  if (typeof value !== "object" || value === null) return false;
  const user = value as Record<string, unknown>;
  return typeof user.id === "string" && typeof user.email === "string" && typeof user.name === "string" && typeof user.createdAt === "string" && typeof user.isInstanceAdmin === "boolean";
}

/** The snapshot, or null when it is missing, not JSON, or not the expected shape. */
export async function readUserSnapshot(file: string): Promise<UserSnapshot | null> {
  const text = await readTrimmed(file);
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw.at !== "string" || !Array.isArray(raw.users) || !raw.users.every(isSnapshotUser)) return null;
    return { at: raw.at, users: raw.users };
  } catch {
    return null;
  }
}

export async function writeUserSnapshot(file: string, snapshot: UserSnapshot): Promise<void> {
  await writeAtomic(file, `${JSON.stringify(snapshot, null, 2)}\n`);
}
