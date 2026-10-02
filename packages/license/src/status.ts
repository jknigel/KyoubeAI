import { formatDate } from "./dates.js";
import { expiryInstant, verifyLicense, type TrustedKeys, type VerifyCode } from "./key.js";
import { verifyMessage } from "./messages.js";

/** Users allowed without a licence, and the floor for any licence. */
export const FREE_SEATS = 5;
export const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 86_400_000;

export type LicenseState = "free" | "licensed" | "expired" | "invalid";

export interface LicenseStatus {
  state: LicenseState;
  /** Users this instance may have. */
  limit: number;
  userCount: number;
  /** The valid key's fields; null without one. */
  customer: string | null;
  seats: number | null;
  licenceId: string | null;
  /** The valid key's expiry, or the expired key's; null when perpetual or unlicensed. */
  expiresAt: string | null;
  /** Whole days left (0 on the last day); null when perpetual or unlicensed. */
  daysLeft: number | null;
  instanceBound: boolean;
  /** The stored key's verify result; null when there is no key. */
  verify: VerifyCode | null;
  /** The plain reason a stored key isn't valid. */
  problem: string | null;
  expiringSoon: boolean;
  /** At or over the limit: the next sign-up is refused. */
  atLimit: boolean;
  overLimit: boolean;
  /** What the attention chip and the doctor's WARN show for. */
  needsAttention: boolean;
  summary: string;
}

export interface StatusInput {
  key: string | null;
  instanceId: string | null;
  userCount: number;
  now: Date;
  trustedKeys: TrustedKeys;
}

export function effectiveLimit(seats: number | null): number {
  return seats === null ? FREE_SEATS : Math.max(seats, FREE_SEATS);
}

export function licenseStatus(input: StatusInput): LicenseStatus {
  const result = input.key === null ? null : verifyLicense(input.key, { trustedKeys: input.trustedKeys, instanceId: input.instanceId, now: input.now });
  const valid = result?.code === "valid" ? result.payload : null;
  const expired = result?.code === "expired" ? result.payload : null;
  const limit = effectiveLimit(valid?.seats ?? null);
  const count = input.userCount;
  const users = `${count} of ${limit} users`;
  const daysLeft = valid?.expiresAt ? Math.floor((expiryInstant(valid.expiresAt) - input.now.getTime()) / DAY_MS) : null;
  const expiringSoon = daysLeft !== null && daysLeft < EXPIRY_WARNING_DAYS;
  const state: LicenseState = valid ? "licensed" : result === null ? "free" : expired ? "expired" : "invalid";

  let summary = `Free: ${users}`;
  if (valid) summary = `Licensed to ${valid.customer}: ${users} · ${valid.expiresAt ? `expires ${formatDate(valid.expiresAt)}` : "perpetual"}`;
  else if (expired) summary = `Licence for ${expired.customer} expired on ${formatDate(expired.expiresAt ?? expired.issuedAt)}: free limit, ${users}`;
  else if (state === "invalid") summary = `Free: ${users} (the stored licence key isn't valid)`;

  const atLimit = count >= limit;
  return {
    state,
    limit,
    userCount: count,
    customer: valid?.customer ?? null,
    seats: valid?.seats ?? null,
    licenceId: valid?.id ?? null,
    expiresAt: valid?.expiresAt ?? expired?.expiresAt ?? null,
    daysLeft,
    instanceBound: valid !== null && valid.instanceId !== null,
    verify: result?.code ?? null,
    problem: result ? verifyMessage(result) : null,
    expiringSoon,
    atLimit,
    overLimit: count > limit,
    needsAttention: expiringSoon || state === "expired" || state === "invalid" || atLimit,
    summary,
  };
}
