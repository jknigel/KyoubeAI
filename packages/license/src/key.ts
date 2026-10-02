import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { isIsoDate } from "./dates.js";

/** The first part of every licence key; the `1` is the format version. */
export const KEY_PREFIX = "KYB1";

export interface LicensePayload {
  v: 1;
  /** Which signing key signed it: a key of TRUSTED_KEYS. */
  kid: string;
  /** Unique licence ID (`lic_` + random), linking the key to KyoubeAI-Admin's ledger. */
  id: string;
  customer: string;
  seats: number;
  /** `YYYY-MM-DD`, UTC. */
  issuedAt: string;
  /** `YYYY-MM-DD`, UTC; the key is valid through this whole day. Null: perpetual. */
  expiresAt: string | null;
  /** Null: the key works on any instance. */
  instanceId: string | null;
}

/** kid -> Ed25519 public key (SPKI PEM). */
export type TrustedKeys = Readonly<Record<string, string>>;

export type VerifyCode = "valid" | "malformed" | "bad_signature" | "unknown_kid" | "expired" | "wrong_instance";

export type VerifyResult =
  | { code: "valid"; payload: LicensePayload }
  | { code: "malformed"; payload: null }
  | { code: "bad_signature" | "unknown_kid" | "expired" | "wrong_instance"; payload: LicensePayload };

export interface VerifyOptions {
  trustedKeys: TrustedKeys;
  instanceId: string | null;
  now: Date;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The payload's fields checked one by one; null when any is missing or of the wrong type. Unknown fields are dropped. */
export function parsePayload(value: unknown): LicensePayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1 || !nonEmpty(raw.kid) || !nonEmpty(raw.id) || !nonEmpty(raw.customer)) return null;
  if (typeof raw.seats !== "number" || !Number.isInteger(raw.seats) || raw.seats < 1) return null;
  if (!isIsoDate(raw.issuedAt)) return null;
  if (raw.expiresAt !== null && !isIsoDate(raw.expiresAt)) return null;
  if (raw.instanceId !== null && !nonEmpty(raw.instanceId)) return null;
  return {
    v: 1,
    kid: raw.kid,
    id: raw.id,
    customer: raw.customer,
    seats: raw.seats,
    issuedAt: raw.issuedAt,
    expiresAt: raw.expiresAt,
    instanceId: raw.instanceId,
  };
}

/**
 * Base64url text to bytes, or null unless re-encoding the bytes gives the same
 * text. Node's decoder ignores the unused bits of the last character, so without
 * this a key with its last character changed could decode to the same signature.
 */
function decodeCanonical(text: string): Buffer | null {
  if (!BASE64URL.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : null;
}

interface Parts {
  payloadPart: string;
  signature: Buffer;
  payload: LicensePayload;
}

function split(key: string): Parts | null {
  const parts = key.trim().split(".");
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) return null;
  const payloadPart = parts[1]!;
  const payloadBytes = decodeCanonical(payloadPart);
  const signature = decodeCanonical(parts[2]!);
  if (!payloadBytes || !signature) return null;
  let json: unknown;
  try {
    json = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return null;
  }
  const payload = parsePayload(json);
  return payload ? { payloadPart, signature, payload } : null;
}

/** Signs `payload` with an Ed25519 private key (PKCS#8 PEM). Throws on a payload `parsePayload` would reject. */
export function signLicense(payload: LicensePayload, privateKeyPem: string): string {
  if (!parsePayload(payload)) throw new Error("signLicense: the payload is incomplete or has a field of the wrong type");
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = sign(null, Buffer.from(payloadPart, "ascii"), createPrivateKey(privateKeyPem));
  return `${KEY_PREFIX}.${payloadPart}.${signature.toString("base64url")}`;
}

/** The last moment a key is valid: the end of its `expiresAt` day, UTC. */
export function expiryInstant(expiresAt: string): number {
  return Date.parse(`${expiresAt}T23:59:59.999Z`);
}

export function verifyLicense(key: string, opts: VerifyOptions): VerifyResult {
  const parts = split(key);
  if (!parts) return { code: "malformed", payload: null };
  const { payload } = parts;
  const pem = Object.hasOwn(opts.trustedKeys, payload.kid) ? opts.trustedKeys[payload.kid] : undefined;
  if (typeof pem !== "string") return { code: "unknown_kid", payload };
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(pem);
  } catch {
    return { code: "unknown_kid", payload };
  }
  let signed = false;
  try {
    signed = verify(null, Buffer.from(parts.payloadPart, "ascii"), publicKey, parts.signature);
  } catch {
    signed = false;
  }
  if (!signed) return { code: "bad_signature", payload };
  if (payload.expiresAt !== null && opts.now.getTime() > expiryInstant(payload.expiresAt)) return { code: "expired", payload };
  if (payload.instanceId !== null && payload.instanceId !== opts.instanceId) return { code: "wrong_instance", payload };
  return { code: "valid", payload };
}
