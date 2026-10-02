import { formatDate } from "./dates.js";
import type { VerifyResult } from "./key.js";

/** The plain sentence the licence page, the CLI and the doctor show for a key that isn't valid; null when it is. */
export function verifyMessage(result: VerifyResult): string | null {
  switch (result.code) {
    case "valid":
      return null;
    case "malformed":
      return "This doesn't look like a KyoubeAI licence key. Check it was copied in full.";
    case "bad_signature":
      return "This key isn't valid. It may have been changed after it was issued.";
    case "unknown_kid":
      return "This key was issued by a newer KyoubeAI signing key. Update KyoubeAI, then apply it again.";
    case "expired":
      return `This key expired on ${formatDate(result.payload.expiresAt ?? result.payload.issuedAt)}.`;
    case "wrong_instance":
      return `This key is for a different KyoubeAI instance (${result.payload.instanceId}).`;
  }
}
