import { createInterface } from "node:readline/promises";
import { formatDate, licensePaths, licenseStatus, readTrimmed, TRUSTED_KEYS, type TrustedKeys } from "@kyoube/license";
import { readConfig, resolveConfigPath } from "../config.js";
import { createCoreClient } from "../core-api.js";
import { readBoardKey, resolveBoardApiKey, resolveBoardKeyPath } from "../key-store.js";
import { coreDatabaseUrl, openCoreUsersDb, type CoreUsersDb } from "../license/core-db.js";
import { kyoubeDir, refreshSnapshot } from "./license.js";

const USAGE = "usage: kyoube users list | remove <email> [--yes]";

export interface UsersCoreApi {
  setUserCompanyAccess(userId: string, companyIds: string[]): Promise<void>;
  demoteInstanceAdmin(userId: string): Promise<void>;
}

export interface UsersDeps {
  dir: () => Promise<string>;
  openDb: () => CoreUsersDb;
  coreApi: () => Promise<UsersCoreApi>;
  /** The user the stored board key (kyoube setup) belongs to, or null. */
  boardKeyUserId: () => Promise<string | null>;
  confirm: (question: string) => Promise<boolean>;
  now: () => Date;
  trustedKeys: TrustedKeys;
  log: (line: string) => void;
}

async function promptYes(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

function defaults(env: NodeJS.ProcessEnv): UsersDeps {
  return {
    dir: () => kyoubeDir(env),
    openDb: () => openCoreUsersDb(coreDatabaseUrl(env)),
    async coreApi() {
      const config = await readConfig(resolveConfigPath(env));
      const apiKey = await resolveBoardApiKey(env, resolveBoardKeyPath(config));
      if (!apiKey) throw new Error("removing a user needs the instance's board API key: run kyoube setup first");
      return createCoreClient({ apiBase: config.paperclipApiUrl, apiKey });
    },
    async boardKeyUserId() {
      const config = await readConfig(resolveConfigPath(env));
      return (await readBoardKey(resolveBoardKeyPath(config)))?.userId ?? null;
    },
    confirm: promptYes,
    now: () => new Date(),
    trustedKeys: TRUSTED_KEYS,
    log: (line) => console.log(line),
  };
}

export async function runUsers(positionals: string[], flags: Record<string, string | true>, env: NodeJS.ProcessEnv, overrides: Partial<UsersDeps> = {}): Promise<number> {
  const deps = { ...defaults(env), ...overrides };
  const [sub, email] = positionals;
  if (sub !== "list" && sub !== "remove") {
    deps.log(USAGE);
    return 1;
  }
  const paths = licensePaths(await deps.dir());
  const db = deps.openDb();
  try {
    const users = await db.listUsers();
    const limitFor = async (count: number) =>
      licenseStatus({ key: await readTrimmed(paths.key), instanceId: await readTrimmed(paths.instanceId), userCount: count, now: deps.now(), trustedKeys: deps.trustedKeys }).limit;

    if (sub === "list") {
      for (const user of users) {
        deps.log(`${user.email}  ${user.name}  created ${formatDate(user.createdAt.slice(0, 10))}${user.isInstanceAdmin ? "  instance admin" : ""}`);
      }
      deps.log(`${users.length} of ${await limitFor(users.length)} users`);
      return 0;
    }

    if (!email) {
      deps.log(USAGE);
      return 1;
    }
    const target = users.find((user) => user.email.toLowerCase() === email.toLowerCase());
    if (!target) {
      deps.log(`kyoube: no user with the email ${email} (kyoube users list shows everyone)`);
      return 1;
    }
    if (target.isInstanceAdmin && users.filter((user) => user.isInstanceAdmin).length === 1) {
      deps.log(`kyoube: ${target.email} is the last instance admin; make someone else an instance admin first`);
      return 1;
    }
    if ((await deps.boardKeyUserId()) === target.id) {
      deps.log(`kyoube: ${target.email} owns the board API key kyoube uses; removing them would delete it. Run kyoube setup signed in as another instance admin first`);
      return 1;
    }
    if (flags.yes !== true) {
      const question = `Remove ${target.email} (${target.name})? Their sessions, sign-in and API keys are deleted; comments they wrote stay, without an author. [y/N] `;
      if (!(await deps.confirm(question))) {
        deps.log("kyoube: nothing removed (add --yes to skip this question)");
        return 1;
      }
    }
    const api = await deps.coreApi();
    await api.setUserCompanyAccess(target.id, []);
    if (target.isInstanceAdmin) await api.demoteInstanceAdmin(target.id);
    await db.deleteUser(target.id);
    const snapshot = await refreshSnapshot(db, paths.users, deps.now());
    deps.log(`kyoube: removed ${target.email}. ${snapshot.users.length} of ${await limitFor(snapshot.users.length)} users.`);
    return 0;
  } finally {
    await db.close();
  }
}
