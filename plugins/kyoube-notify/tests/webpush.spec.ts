import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptPayload } from "../src/webpush/encrypt.js";
import { generateVapidKeys, vapidAuthorization, vapidSubject } from "../src/webpush/vapid.js";
import { decryptBody, makeDevice } from "./helpers.js";

const b64u = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "base64url");

describe("encryptPayload (RFC 8291, aes128gcm)", () => {
  it("reproduces the worked example in RFC 8291 section 5 byte for byte", () => {
    // Inputs and expected output copied from RFC 8291 Appendix A.
    const body = encryptPayload({
      plaintext: Buffer.from("When I grow up, I want to be a watermelon"),
      uaPublic: b64u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
      authSecret: b64u("BTBZMqHH6r4Tts7J_aSIgg"),
      asPrivate: b64u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
      salt: b64u("DGv6ra1nlYgDCS1FRnbzlw"),
    });
    const header = b64u("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8");
    const ciphertext = b64u("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ");
    expect(body.equals(Buffer.concat([header, ciphertext]))).toBe(true);
    expect(body.length).toBe(144);
  });

  it("produces a body the browser can decrypt", () => {
    const device = makeDevice();
    const body = encryptPayload({ plaintext: Buffer.from('{"title":"hi"}'), uaPublic: device.ecdh.getPublicKey(), authSecret: device.auth });
    expect(decryptBody(body, device)).toBe('{"title":"hi"}');
  });

  it("uses a fresh salt and server key for every message", () => {
    const device = makeDevice();
    const a = encryptPayload({ plaintext: Buffer.from("x"), uaPublic: device.ecdh.getPublicKey(), authSecret: device.auth });
    const b = encryptPayload({ plaintext: Buffer.from("x"), uaPublic: device.ecdh.getPublicKey(), authSecret: device.auth });
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
  });

  it("refuses a malformed browser key, a short auth secret and an oversized message", () => {
    const device = makeDevice();
    expect(() => encryptPayload({ plaintext: Buffer.from("x"), uaPublic: Buffer.alloc(33, 2), authSecret: device.auth })).toThrow("uncompressed P-256");
    expect(() => encryptPayload({ plaintext: Buffer.from("x"), uaPublic: device.ecdh.getPublicKey(), authSecret: Buffer.alloc(8) })).toThrow("16 bytes");
    expect(() => encryptPayload({ plaintext: Buffer.alloc(4000), uaPublic: device.ecdh.getPublicKey(), authSecret: device.auth })).toThrow("too large");
  });
});

describe("VAPID (RFC 8292)", () => {
  it("generates a 65-byte public point and a 32-byte private scalar", () => {
    const keys = generateVapidKeys();
    expect(b64u(keys.publicKey).length).toBe(65);
    expect(b64u(keys.publicKey)[0]).toBe(4);
    expect(b64u(keys.privateKey).length).toBe(32);
  });

  it("signs an ES256 JWT for the push service's origin, valid for 12 hours", () => {
    const keys = generateVapidKeys();
    const value = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "https://kyoube.example.com", 1_800_000_000);
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(value);
    expect(match).not.toBeNull();
    const [, header, claims, signature, k] = match!;
    expect(JSON.parse(b64u(header!).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(b64u(claims!).toString())).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_800_000_000 + 12 * 3600, sub: "https://kyoube.example.com" });
    expect(k).toBe(keys.publicKey);
    const point = b64u(keys.publicKey);
    const key = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") } });
    expect(verify("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" }, b64u(signature!))).toBe(true);
  });

  it("uses the instance's https origin as the subject, and a mailto otherwise", () => {
    expect(vapidSubject("https://kyoube.example.com/some/path")).toBe("https://kyoube.example.com");
    expect(vapidSubject("http://192.168.1.10:3100")).toBe("mailto:notifications@kyoube.invalid");
    expect(vapidSubject(null)).toBe("mailto:notifications@kyoube.invalid");
  });
});
