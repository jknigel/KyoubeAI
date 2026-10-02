import { checkSeat as check, type SeatCheck } from "./enforce.js";
import { TRUSTED_KEYS } from "./trusted-keys.js";

/**
 * What the core's sign-up hook calls (built to dist/enforce.mjs, shipped at
 * /opt/kyoube/license/enforce.mjs). Bound to the shipped trusted keys and the
 * default folder: nothing about the check is configurable from outside.
 */
export function checkSeat(deps: { countUsers: () => Promise<number> }): Promise<SeatCheck> {
  return check({ countUsers: deps.countUsers, trustedKeys: TRUSTED_KEYS });
}
