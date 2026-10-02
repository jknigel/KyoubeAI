import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatDate, oneYearFrom } from "../src/dates.js";
import { KEY_PREFIX, parsePayload, signLicense, verifyLicense, type LicensePayload, type TrustedKeys } from "../src/key.js";
import { verifyMessage } from "../src/messages.js";

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const TEST = keyPair();
const STRANGER = keyPair();
const TRUSTED: TrustedKeys = { test1: TEST.publicPem };
const NOW = new Date("2026-10-03T12:00:00Z");
const PAYLOAD: LicensePayload = { v: 1, kid: "test1", id: "lic_test0001", customer: "Acme Ltd", seats: 10, issuedAt: "2026-10-03", expiresAt: "2027-10-03", instanceId: null };

const check = (key: string, opts: { now?: Date; instanceId?: string | null } = {}) =>
  verifyLicense(key, { trustedKeys: TRUSTED, instanceId: opts.instanceId === undefined ? "inst-1" : opts.instanceId, now: opts.now ?? NOW });

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

describe("signLicense and verifyLicense", () => {
  it("verifies a key it signed and returns the payload unchanged", () => {
    const key = signLicense(PAYLOAD, TEST.privatePem);
    expect(key.startsWith(`${KEY_PREFIX}.`)).toBe(true);
    expect(key.split(".")).toHaveLength(3);
    expect(check(key)).toEqual({ code: "valid", payload: PAYLOAD });
  });

  it("accepts a pasted key with spaces and line breaks around it", () => {
    expect(check(`  ${signLicense(PAYLOAD, TEST.privatePem)}\r\n`).code).toBe("valid");
  });

  it("never verifies a key with any one character changed", () => {
    const key = signLicense(PAYLOAD, TEST.privatePem);
    for (let i = 0; i < key.length; i += 1) {
      if (key[i] === ".") continue;
      const changed = key.slice(0, i) + (key[i] === "A" ? "B" : "A") + key.slice(i + 1);
      expect(check(changed).code, `position ${i}`).not.toBe("valid");
    }
  });

  it("calls a re-encoded payload with more seats bad_signature", () => {
    const [prefix, , signature] = signLicense(PAYLOAD, TEST.privatePem).split(".");
    expect(check([prefix, encode({ ...PAYLOAD, seats: 1000 }), signature].join(".")).code).toBe("bad_signature");
  });

  it("calls a key signed by another private key bad_signature, even when it names a trusted kid", () => {
    expect(check(signLicense(PAYLOAD, STRANGER.privatePem)).code).toBe("bad_signature");
  });

  it("calls a kid this build doesn't trust unknown_kid, including the names of Object's own members", () => {
    for (const kid of ["2099z", "toString", "__proto__", "constructor", "hasOwnProperty"]) {
      expect(check(signLicense({ ...PAYLOAD, kid }, TEST.privatePem)).code, kid).toBe("unknown_kid");
    }
  });

  it("is valid through the whole expiry day (UTC) and expired from the next", () => {
    const key = signLicense(PAYLOAD, TEST.privatePem);
    expect(check(key, { now: new Date("2027-10-03T23:59:59Z") }).code).toBe("valid");
    expect(check(key, { now: new Date("2027-10-04T00:00:00Z") }).code).toBe("expired");
  });

  it("never expires a perpetual key", () => {
    expect(check(signLicense({ ...PAYLOAD, expiresAt: null }, TEST.privatePem), { now: new Date("2099-01-01T00:00:00Z") }).code).toBe("valid");
  });

  it("binds a key with an instanceId to that instance only", () => {
    const key = signLicense({ ...PAYLOAD, instanceId: "inst-1" }, TEST.privatePem);
    expect(check(key, { instanceId: "inst-1" }).code).toBe("valid");
    expect(check(key, { instanceId: "inst-2" }).code).toBe("wrong_instance");
    expect(check(key, { instanceId: null }).code).toBe("wrong_instance");
  });

  it("lets an unbound key work anywhere, even where the instance ID is unknown", () => {
    expect(check(signLicense(PAYLOAD, TEST.privatePem), { instanceId: null }).code).toBe("valid");
  });

  it("calls anything that isn't a KYB1 key malformed", () => {
    const [, payloadPart, signature] = signLicense(PAYLOAD, TEST.privatePem).split(".");
    const bad = [
      "",
      "hello",
      `KYB2.${payloadPart}.${signature}`,
      `KYB1.${payloadPart}`,
      `KYB1.${payloadPart}.${signature}.x`,
      `KYB1.!!!.${signature}`,
      `KYB1.${encode("not an object")}.${signature}`,
      `KYB1.${encode({ ...PAYLOAD, v: 2 })}.${signature}`,
      `KYB1.${Buffer.from("{not json", "utf8").toString("base64url")}.${signature}`,
    ];
    for (const key of bad) expect(check(key), key).toEqual({ code: "malformed", payload: null });
  });

  it("refuses to sign an incomplete payload", () => {
    expect(() => signLicense({ ...PAYLOAD, seats: 0 }, TEST.privatePem)).toThrow(/incomplete/);
  });
});

describe("parsePayload", () => {
  it("accepts a complete payload", () => expect(parsePayload(PAYLOAD)).toEqual(PAYLOAD));
  it("drops fields it doesn't know", () => expect(parsePayload({ ...PAYLOAD, extra: 1 })).toEqual(PAYLOAD));
  it.each([
    ["no seats", { ...PAYLOAD, seats: undefined }],
    ["zero seats", { ...PAYLOAD, seats: 0 }],
    ["fractional seats", { ...PAYLOAD, seats: 2.5 }],
    ["an empty customer", { ...PAYLOAD, customer: " " }],
    ["a written-out issue date", { ...PAYLOAD, issuedAt: "3 Oct 2026" }],
    ["an impossible expiry date", { ...PAYLOAD, expiresAt: "2027-02-31" }],
    ["no expiresAt at all", { ...PAYLOAD, expiresAt: undefined }],
    ["an empty instanceId", { ...PAYLOAD, instanceId: "" }],
    ["an array", [PAYLOAD]],
    ["null", null],
  ])("rejects %s", (_name, value) => expect(parsePayload(value)).toBeNull());
});

describe("verifyMessage", () => {
  it("has the spec's sentence for every result but valid", () => {
    const bound = signLicense({ ...PAYLOAD, instanceId: "inst-1" }, TEST.privatePem);
    expect(verifyMessage(check(bound))).toBeNull();
    expect(verifyMessage(check("hello"))).toBe("This doesn't look like a KyoubeAI licence key. Check it was copied in full.");
    expect(verifyMessage(check(signLicense(PAYLOAD, STRANGER.privatePem)))).toBe("This key isn't valid. It may have been changed after it was issued.");
    expect(verifyMessage(check(signLicense({ ...PAYLOAD, kid: "2099z" }, TEST.privatePem)))).toBe("This key was issued by a newer KyoubeAI signing key. Update KyoubeAI, then apply it again.");
    expect(verifyMessage(check(bound, { now: new Date("2028-01-01T00:00:00Z") }))).toBe("This key expired on 3 Oct 2027.");
    expect(verifyMessage(check(bound, { instanceId: "inst-2" }))).toBe("This key is for a different KyoubeAI instance (inst-1).");
  });
});

describe("dates", () => {
  it("formats a date the way the licence page shows it", () => {
    expect(formatDate("2027-10-03")).toBe("3 Oct 2027");
    expect(formatDate("2026-01-31")).toBe("31 Jan 2026");
  });
  it("adds a year, keeping the day, and lands on 28 Feb from 29 Feb", () => {
    expect(oneYearFrom("2026-10-03")).toBe("2027-10-03");
    expect(oneYearFrom("2028-02-29")).toBe("2029-02-28");
  });
});
