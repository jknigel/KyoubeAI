import { KYOUBE_DIR, licensePaths, readTrimmed, TRUSTED_KEYS, verifyLicense, type TrustedKeys } from "@kyoube/license";

/** Whether this instance may manage groups (docs/groups.md): any valid licence. Enforcement never asks. */
export interface LicenceGate {
  unlocked(): Promise<boolean>;
}

export function fileLicenceGate(opts: { dir?: string; trustedKeys?: TrustedKeys; now?: () => Date; cacheMs?: number } = {}): LicenceGate {
  const paths = licensePaths(opts.dir ?? KYOUBE_DIR);
  const trustedKeys = opts.trustedKeys ?? TRUSTED_KEYS;
  const now = opts.now ?? (() => new Date());
  const cacheMs = opts.cacheMs ?? 60_000;
  let cached: { at: number; value: boolean } | null = null;
  return {
    async unlocked() {
      const at = now().getTime();
      if (cached && at - cached.at < cacheMs) return cached.value;
      const [key, instanceId] = await Promise.all([readTrimmed(paths.key), readTrimmed(paths.instanceId)]);
      const value = key !== null && verifyLicense(key, { trustedKeys, instanceId, now: now() }).code === "valid";
      cached = { at, value };
      return value;
    },
  };
}
