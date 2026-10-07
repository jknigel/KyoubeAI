import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";

/** One record of 4096 octets (RFC 8188), which every push service accepts. */
export const RECORD_SIZE = 4096;
/** The most plaintext one record carries: 4096 less the 86-octet header, the delimiter and the 16-octet tag, rounded down for safety. */
export const MAX_PLAINTEXT = 3900;

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

/**
 * Encrypts one push message for one browser subscription (RFC 8291, the
 * `aes128gcm` content coding of RFC 8188): ECDH with a fresh server key, the
 * subscription's auth secret mixed in, AES-128-GCM over the plaintext plus the
 * 0x02 last-record delimiter. Returns the whole request body: salt, record
 * size, the server's public key, then the ciphertext and tag.
 *
 * `asPrivate` and `salt` are test seams for the RFC's worked example; real
 * sends leave both out so every message gets a fresh key and salt.
 */
export function encryptPayload(input: { plaintext: Buffer; uaPublic: Buffer; authSecret: Buffer; asPrivate?: Buffer; salt?: Buffer }): Buffer {
  const { plaintext, uaPublic, authSecret } = input;
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("the browser key must be an uncompressed P-256 point");
  if (authSecret.length !== 16) throw new Error("the auth secret must be 16 bytes");
  if (plaintext.length > MAX_PLAINTEXT) throw new Error(`push message too large (${plaintext.length} bytes)`);
  const salt = input.salt ?? randomBytes(16);
  const ecdh = createECDH("prime256v1");
  if (input.asPrivate) ecdh.setPrivateKey(input.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(null, "uncompressed");
  const prkKey = hmac(authSecret, ecdh.computeSecret(uaPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, ciphertext]);
}
