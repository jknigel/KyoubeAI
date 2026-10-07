import { createDecipheriv, createECDH, createHmac, randomBytes, type ECDH } from "node:crypto";

export interface TestDevice {
  ecdh: ECDH;
  auth: Buffer;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
}

let counter = 0;

/** A browser-side push subscription with its private key, so tests can decrypt what the worker sends. */
export function makeDevice(endpoint = `https://fcm.googleapis.com/fcm/send/device-${++counter}`): TestDevice {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } } };
}

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

/** The user agent's side of RFC 8291: returns the plaintext the application server encrypted. */
export function decryptBody(body: Uint8Array, device: Pick<TestDevice, "ecdh" | "auth">): string {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const idlen = buf[20]!;
  const keyid = buf.subarray(21, 21 + idlen);
  const ciphertext = buf.subarray(21 + idlen);
  const uaPublic = device.ecdh.getPublicKey();
  const prkKey = hmac(device.auth, device.ecdh.computeSecret(keyid));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, keyid, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  if (padded[end] !== 2) throw new Error("missing the last-record delimiter");
  return padded.subarray(0, end).toString("utf8");
}

export interface Sent { url: string; headers: Record<string, string>; body: Uint8Array }

/** A push transport that records every request and answers with the given statuses in turn (default 201). */
export function fakeTransport(statuses: Array<number | Error> = []) {
  const sent: Sent[] = [];
  const transport = async (url: string, init: { method: "POST"; headers: Record<string, string>; body: Uint8Array }) => {
    sent.push({ url, headers: init.headers, body: init.body });
    const next = statuses.shift() ?? 201;
    if (next instanceof Error) throw next;
    return { status: next };
  };
  return { sent, transport };
}
