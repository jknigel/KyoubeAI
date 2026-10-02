import path from "node:path";
import {
  ensureInstanceId, formatDate, licensePaths, licenseStatus, readTrimmed, removeLicenseKey, TRUSTED_KEYS, verifyLicense, verifyMessage,
  writeLicenseKey, writeUserSnapshot, type LicenseStatus, type TrustedKeys, type UserSnapshot,
} from "@kyoube/license";
import { readConfig, resolveConfigPath } from "../config.js";
import { coreDatabaseUrl, openCoreUsersDb, type CoreUsersDb } from "../license/core-db.js";

export const SNAPSHOT_INTERVAL_MS = 60_000;
const USAGE = "usage: kyoube license [show] | set <key> | clear | refresh | --watch";

export interface LicenseDeps {
  /** /kyoubeai/kyoube, from config.json's home. */
  dir: () => Promise<string>;
  openDb: () => CoreUsersDb;
  now: () => Date;
  trustedKeys: TrustedKeys;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Ends --watch after this many passes; tests only. */
  maxPasses?: number;
}

export async function kyoubeDir(env: NodeJS.ProcessEnv): Promise<string> {
  const config = await readConfig(resolveConfigPath(env));
  return path.posix.join(config.home, "kyoube");
}

function defaults(env: NodeJS.ProcessEnv): LicenseDeps {
  return {
    dir: () => kyoubeDir(env),
    openDb: () => openCoreUsersDb(coreDatabaseUrl(env)),
    now: () => new Date(),
    trustedKeys: TRUSTED_KEYS,
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export async function refreshSnapshot(db: CoreUsersDb, file: string, now: Date): Promise<UserSnapshot> {
  const snapshot = { at: now.toISOString(), users: await db.listUsers() };
  await writeUserSnapshot(file, snapshot);
  return snapshot;
}

/** The status as the CLI prints it, one `Label: value` line each. */
export function statusLines(status: LicenseStatus, instanceId: string | null): string[] {
  const lines = [`Licence:      ${status.summary}`];
  if (status.licenceId) lines.push(`Licence ID:   ${status.licenceId} (${status.instanceBound ? "this instance only" : "any instance"})`);
  lines.push(`Instance ID:  ${instanceId ?? "not created yet (the container creates it at start)"}`);
  if (status.problem) lines.push(`Problem:      ${status.problem}`);
  const attention: string[] = [];
  if (status.expiringSoon && status.daysLeft !== null && status.expiresAt) attention.push(`expires in ${status.daysLeft} ${status.daysLeft === 1 ? "day" : "days"} (${formatDate(status.expiresAt)})`);
  if (status.overLimit) attention.push(`over the user limit: no new user can be added`);
  else if (status.atLimit) attention.push(`at the user limit: the next sign-up is refused`);
  if (attention.length > 0) lines.push(`Attention:    ${attention.join("; ")}`);
  return lines;
}

async function withDb<T>(deps: LicenseDeps, run: (db: CoreUsersDb) => Promise<T>): Promise<T> {
  const db = deps.openDb();
  try {
    return await run(db);
  } finally {
    await db.close();
  }
}

export async function runLicense(positionals: string[], flags: Record<string, string | true>, env: NodeJS.ProcessEnv, overrides: Partial<LicenseDeps> = {}): Promise<number> {
  const deps = { ...defaults(env), ...overrides };
  const dir = await deps.dir();
  const paths = licensePaths(dir);

  if (flags.watch === true) {
    let lastCount: number | null = null;
    let lastError: string | null = null;
    for (let pass = 1; deps.maxPasses === undefined || pass <= deps.maxPasses; pass += 1) {
      try {
        const snapshot = await withDb(deps, (db) => refreshSnapshot(db, paths.users, deps.now()));
        if (snapshot.users.length !== lastCount) deps.log(`kyoube: licence: ${snapshot.users.length} users as of ${snapshot.at}`);
        lastCount = snapshot.users.length;
        lastError = null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastError) deps.log(`kyoube: licence: could not read the users: ${message}`);
        lastError = message;
      }
      if (deps.maxPasses !== undefined && pass === deps.maxPasses) break;
      await deps.sleep(SNAPSHOT_INTERVAL_MS);
    }
    return 0;
  }

  const [sub = "show", arg] = positionals;
  switch (sub) {
    case "show": {
      const [key, instanceId] = await Promise.all([readTrimmed(paths.key), readTrimmed(paths.instanceId)]);
      const users = await withDb(deps, (db) => db.listUsers());
      statusLines(licenseStatus({ key, instanceId, userCount: users.length, now: deps.now(), trustedKeys: deps.trustedKeys }), instanceId).forEach((line) => deps.log(line));
      return 0;
    }
    case "set": {
      if (!arg) {
        deps.log(USAGE);
        return 1;
      }
      const instanceId = await ensureInstanceId(paths.instanceId);
      const result = verifyLicense(arg, { trustedKeys: deps.trustedKeys, instanceId, now: deps.now() });
      if (result.code !== "valid") {
        deps.log(`kyoube: licence key not applied: ${verifyMessage(result)}`);
        return 1;
      }
      await writeLicenseKey(paths.key, arg);
      const users = await withDb(deps, (db) => db.listUsers());
      statusLines(licenseStatus({ key: arg, instanceId, userCount: users.length, now: deps.now(), trustedKeys: deps.trustedKeys }), instanceId).forEach((line) => deps.log(line));
      return 0;
    }
    case "clear":
      await removeLicenseKey(paths.key);
      deps.log("kyoube: licence key removed; the free limit of 5 users applies.");
      return 0;
    case "refresh": {
      const snapshot = await withDb(deps, (db) => refreshSnapshot(db, paths.users, deps.now()));
      deps.log(`kyoube: licence: ${snapshot.users.length} users as of ${snapshot.at}`);
      return 0;
    }
    default:
      deps.log(USAGE);
      return 1;
  }
}
