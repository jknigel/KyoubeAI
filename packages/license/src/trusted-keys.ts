import type { TrustedKeys } from "./key.js";

/**
 * The public halves of KyoubeAI's licence signing keys, by kid. A key signed
 * with a kid that isn't here verifies as `unknown_kid`.
 *
 * Adding a key: `pnpm --filter @kyoube/license keygen <kid>` prints the entry.
 * A new kid only takes effect in the release that ships it. Remove an old kid
 * only when no customer key signed with it should keep working.
 *
 * Nothing at runtime adds to this list: no environment variable, file or flag.
 * That would let anyone trust a key of their own.
 */
export const TRUSTED_KEYS: TrustedKeys = Object.freeze({
  "2026a": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAs8wGbgdKwNuUCc1NmM4XNjckBu1S+a+Sg7H8Y0S0KmU=\n-----END PUBLIC KEY-----\n",
});
