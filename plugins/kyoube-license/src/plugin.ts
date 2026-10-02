import { definePlugin, type PaperclipPlugin } from "@paperclipai/plugin-sdk";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk/protocol";
import {
  KYOUBE_DIR, licensePaths, licenseStatus, readTrimmed, readUserSnapshot, removeLicenseKey, TRUSTED_KEYS, verifyLicense, verifyMessage,
  writeLicenseKey, type TrustedKeys, type UserSnapshot,
} from "@kyoube/license";
import { removeCommand, type ApplyAnswer, type LicenceStatusAnswer, type LicenceView } from "./shared.js";

export interface LicensePluginDeps {
  /** /kyoubeai/kyoube by default. */
  dir?: string;
  now?: () => Date;
  trustedKeys?: TrustedKeys;
}

const NO_SNAPSHOT_MESSAGE = "KyoubeAI is still reading the user list. Try again in a minute.";

/**
 * The Licence page's worker. It reads the licence key, the instance ID and the
 * user snapshot `kyoube license --watch` keeps (/kyoubeai/kyoube), and writes
 * only the key. Every action is for instance admins, and whether the caller is
 * one comes from the same snapshot (at most a minute old): the action context
 * carries the caller's user ID but not their instance role, and the plugin
 * never touches the core database (docs/architecture.md).
 */
export function createLicensePlugin(deps: LicensePluginDeps = {}): PaperclipPlugin {
  const paths = licensePaths(deps.dir ?? KYOUBE_DIR);
  const now = deps.now ?? (() => new Date());
  const trustedKeys = deps.trustedKeys ?? TRUSTED_KEYS;

  async function caller(context: PluginPerformActionContext): Promise<{ snapshot: UserSnapshot } | { denied: "not_admin" | "no_snapshot" }> {
    const { actor } = context;
    if (actor.type !== "user" || !actor.userId) return { denied: "not_admin" };
    const snapshot = await readUserSnapshot(paths.users);
    if (!snapshot) return { denied: "no_snapshot" };
    return snapshot.users.some((user) => user.id === actor.userId && user.isInstanceAdmin) ? { snapshot } : { denied: "not_admin" };
  }

  async function view(snapshot: UserSnapshot): Promise<LicenceView> {
    const [key, instanceId] = await Promise.all([readTrimmed(paths.key), readTrimmed(paths.instanceId)]);
    return {
      visible: true,
      status: licenseStatus({ key, instanceId, userCount: snapshot.users.length, now: now(), trustedKeys }),
      instanceId,
      snapshotAt: snapshot.at,
      users: snapshot.users.map((user) => ({ ...user, removeCommand: removeCommand(user.email) })),
    };
  }

  async function adminOnly(context: PluginPerformActionContext): Promise<UserSnapshot | ApplyAnswer> {
    const who = await caller(context);
    if ("denied" in who) {
      if (who.denied === "no_snapshot") return { ok: false, message: NO_SNAPSHOT_MESSAGE };
      throw new Error("forbidden: only instance admins can change the licence");
    }
    return who.snapshot;
  }

  return definePlugin({
    async setup(ctx) {
      ctx.actions.register("license.status", async (_params, context): Promise<LicenceStatusAnswer> => {
        const who = await caller(context);
        return "denied" in who ? { visible: false, reason: who.denied } : view(who.snapshot);
      });

      ctx.actions.register("license.apply", async (params, context): Promise<ApplyAnswer> => {
        const snapshot = await adminOnly(context);
        if (!("users" in snapshot)) return snapshot;
        const key = typeof params.key === "string" ? params.key.trim() : "";
        const result = verifyLicense(key, { trustedKeys, instanceId: await readTrimmed(paths.instanceId), now: now() });
        if (result.code !== "valid") return { ok: false, message: verifyMessage(result) ?? "This key isn't valid." };
        await writeLicenseKey(paths.key, key);
        return { ok: true, view: await view(snapshot) };
      });

      ctx.actions.register("license.clear", async (_params, context): Promise<ApplyAnswer> => {
        const snapshot = await adminOnly(context);
        if (!("users" in snapshot)) return snapshot;
        await removeLicenseKey(paths.key);
        return { ok: true, view: await view(snapshot) };
      });
    },
  });
}
