import { createECDH, createPrivateKey, sign } from "node:crypto";

/** The instance's application server key pair, base64url: a 65-byte uncompressed P-256 point and a 32-byte scalar. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** How long one signed token is valid. 12 hours is what the `web-push` library uses with every push service. */
const TOKEN_LIFETIME_S = 12 * 3600;

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const raw = ecdh.getPrivateKey();
  // getPrivateKey drops leading zero bytes; a JWK `d` must be exactly 32.
  const scalar = Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
  return { publicKey: ecdh.getPublicKey(null, "uncompressed").toString("base64url"), privateKey: scalar.toString("base64url") };
}

const b64json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** The `Authorization` header value for one push request (RFC 8292): an ES256 JWT for the endpoint's origin, and the public key. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowSeconds: number): string {
  const header = b64json({ typ: "JWT", alg: "ES256" });
  const claims = b64json({ aud: new URL(endpoint).origin, exp: nowSeconds + TOKEN_LIFETIME_S, sub: subject });
  const point = Buffer.from(keys.publicKey, "base64url");
  const key = createPrivateKey({
    format: "jwk",
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33, 65).toString("base64url") },
  });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${signature.toString("base64url")}, k=${keys.publicKey}`;
}

/**
 * The JWT `sub` claim: the instance's own https origin, which push services
 * use to contact an operator. Push only works on a secure origin anyway; a
 * non-https URL (a LAN test) falls back to a mailto the services accept.
 */
export function vapidSubject(publicUrl: string | null): string {
  if (publicUrl && /^https:\/\//i.test(publicUrl)) return new URL(publicUrl).origin;
  return "mailto:notifications@kyoube.invalid";
}
