#!/usr/bin/env node
/**
 * The smoke test's Web Push receiver and checker. No browser and no Apple or
 * Google: the smoke test registers a subscription whose endpoint is this
 * receiver, with keys this script made, so it can decrypt what kyoube.notify
 * sends and check the VAPID signature, proving the whole chain end to end.
 *
 *   node push-live-check.mjs receiver <port> <requests.jsonl>   # inside the container
 *   node push-live-check.mjs keys                                # → {"p256dh","auth","privateKey"}
 *   node push-live-check.mjs decrypt <requests.jsonl> <keys.json> <endpoint>
 *       → one JSON payload per line; exit 1 if any request is malformed or badly signed
 */
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const [command, ...args] = process.argv.slice(2);
const b64u = (s) => Buffer.from(s, "base64url");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

if (command === "receiver") {
  const [port, file] = args;
  createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      appendFileSync(file, `${JSON.stringify({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("base64") })}\n`);
      res.writeHead(201).end();
    });
  }).listen(Number(port), "127.0.0.1");
} else if (command === "keys") {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  console.log(JSON.stringify({ p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url"), privateKey: ecdh.getPrivateKey().toString("base64url") }));
} else if (command === "decrypt") {
  const [file, keysFile, endpoint] = args;
  const keys = JSON.parse(readFileSync(keysFile, "utf8"));
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(b64u(keys.privateKey));
  let bad = 0;
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const request = JSON.parse(line);
    try {
      const auth = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(request.headers.authorization ?? "");
      if (!auth) throw new Error("no VAPID authorization header");
      const claims = JSON.parse(b64u(auth[2]).toString());
      if (claims.aud !== new URL(endpoint).origin) throw new Error(`aud ${claims.aud} is not ${new URL(endpoint).origin}`);
      if (claims.exp * 1000 < Date.now()) throw new Error("token already expired");
      const point = b64u(auth[4]);
      const key = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") } });
      if (!verify("sha256", Buffer.from(`${auth[1]}.${auth[2]}`), { key, dsaEncoding: "ieee-p1363" }, b64u(auth[3]))) throw new Error("bad VAPID signature");
      if (request.headers["content-encoding"] !== "aes128gcm") throw new Error("not aes128gcm");
      const body = Buffer.from(request.body, "base64");
      const salt = body.subarray(0, 16);
      const keyid = body.subarray(21, 21 + body[20]);
      const ciphertext = body.subarray(21 + body[20]);
      const prkKey = hmac(b64u(keys.auth), ecdh.computeSecret(keyid));
      const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), keyid, Buffer.from([1])]));
      const prk = hmac(salt, ikm);
      const decipher = createDecipheriv("aes-128-gcm", hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12));
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
      console.log(padded.subarray(0, padded.lastIndexOf(2)).toString("utf8"));
    } catch (error) {
      bad += 1;
      console.error(`push-live-check: bad request: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  process.exitCode = bad > 0 ? 1 : 0;
} else {
  console.error("usage: push-live-check.mjs receiver <port> <file> | keys | decrypt <file> <keys.json> <endpoint>");
  process.exitCode = 2;
}
