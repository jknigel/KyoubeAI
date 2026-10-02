import { licensePaths, readTrimmed } from "./files.js";
import type { TrustedKeys } from "./key.js";
import { licenseStatus } from "./status.js";

/** The comment the core patch leaves in the hook; the doctor looks for it in the served auth module. */
export const HOOK_MARKER = "kyoube-license-seat-limit";
/** Where the image ships the seat check (docker/Dockerfile). */
export const ENFORCE_MODULE_PATH = "/opt/kyoube/license/enforce.mjs";
/** The core module the hook is patched into. */
export const AUTH_MODULE_PATH = "/app/server/dist/auth/better-auth.js";
export const LICENCE_PAGE = "Settings → Plugins → KyoubeAI Licence";
export const SEAT_LIMIT_CODE = "SEAT_LIMIT_REACHED";
export const CHECK_FAILED_CODE = "LICENSE_CHECK_FAILED";
export const CHECK_FAILED_MESSAGE = "KyoubeAI could not check its user limit, so no account was created. An instance admin can run kyoube doctor to see why.";

export function seatLimitMessage(count: number, limit: number): string {
  return `This KyoubeAI instance has reached its user limit (${count} of ${limit}). An instance admin can add a licence key under ${LICENCE_PAGE}.`;
}

export type SeatCheck =
  | { ok: true; count: number; limit: number }
  | { ok: false; status: "BAD_REQUEST"; code: typeof SEAT_LIMIT_CODE; message: string; count: number; limit: number }
  | { ok: false; status: "INTERNAL_SERVER_ERROR"; code: typeof CHECK_FAILED_CODE; message: string };

export interface SeatCheckDeps {
  /** The number of rows in the core's `user` table. */
  countUsers: () => Promise<number>;
  trustedKeys: TrustedKeys;
  /** The folder holding license.key and instance-id; /kyoubeai/kyoube by default. */
  dir?: string;
  now?: () => Date;
  log?: (message: string, error: unknown) => void;
}

/**
 * Whether one more account fits. The `status` fields are Better Auth APIError
 * status names, which the hook passes straight on. Never throws: anything
 * unexpected refuses the sign-up, so a broken check can't hand out unlimited
 * seats.
 */
export async function checkSeat(deps: SeatCheckDeps): Promise<SeatCheck> {
  try {
    const paths = licensePaths(deps.dir);
    const [key, instanceId] = await Promise.all([readTrimmed(paths.key), readTrimmed(paths.instanceId)]);
    const count = Number(await deps.countUsers());
    if (!Number.isInteger(count) || count < 0) throw new Error(`the user count came back as ${count}`);
    const { limit } = licenseStatus({ key, instanceId, userCount: count, now: (deps.now ?? (() => new Date()))(), trustedKeys: deps.trustedKeys });
    if (count >= limit) return { ok: false, status: "BAD_REQUEST", code: SEAT_LIMIT_CODE, message: seatLimitMessage(count, limit), count, limit };
    return { ok: true, count, limit };
  } catch (error) {
    (deps.log ?? ((message, err) => console.error(message, err)))("[kyoube] licence check failed", error);
    return { ok: false, status: "INTERNAL_SERVER_ERROR", code: CHECK_FAILED_CODE, message: CHECK_FAILED_MESSAGE };
  }
}
