import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signLicense, type LicensePayload } from "../src/key.js";
import { effectiveLimit, licenseStatus } from "../src/status.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const TRUSTED = { test1: publicKey.export({ type: "spki", format: "pem" }).toString() };
const PRIVATE = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PAYLOAD: LicensePayload = { v: 1, kid: "test1", id: "lic_test0001", customer: "Acme Ltd", seats: 10, issuedAt: "2026-10-03", expiresAt: "2027-10-03", instanceId: null };
const NOW = new Date("2026-10-03T12:00:00Z");

const status = (key: string | null, userCount: number, now = NOW, instanceId: string | null = "inst-1") =>
  licenseStatus({ key, instanceId, userCount, now, trustedKeys: TRUSTED });

describe("effectiveLimit", () => {
  it("is 5 without a licence and never below 5 with one", () => {
    expect(effectiveLimit(null)).toBe(5);
    expect(effectiveLimit(3)).toBe(5);
    expect(effectiveLimit(10)).toBe(10);
  });
});

describe("licenseStatus", () => {
  it("is Free with room to spare and needs no attention", () => {
    expect(status(null, 3)).toMatchObject({ state: "free", limit: 5, userCount: 3, summary: "Free: 3 of 5 users", atLimit: false, needsAttention: false, verify: null, problem: null });
  });

  it("needs attention at the free limit", () => {
    expect(status(null, 5)).toMatchObject({ atLimit: true, overLimit: false, needsAttention: true });
  });

  it("shows the customer, the seats and the expiry date for a valid key", () => {
    const s = status(signLicense(PAYLOAD, PRIVATE), 7);
    expect(s).toMatchObject({ state: "licensed", limit: 10, customer: "Acme Ltd", seats: 10, licenceId: "lic_test0001", expiresAt: "2027-10-03", instanceBound: false, needsAttention: false });
    expect(s.summary).toBe("Licensed to Acme Ltd: 7 of 10 users · expires 3 Oct 2027");
  });

  it("says perpetual for a key with no expiry", () => {
    const s = status(signLicense({ ...PAYLOAD, expiresAt: null }, PRIVATE), 7);
    expect(s.summary).toBe("Licensed to Acme Ltd: 7 of 10 users · perpetual");
    expect(s.daysLeft).toBeNull();
  });

  it("never gives fewer than 5 seats", () => {
    expect(status(signLicense({ ...PAYLOAD, seats: 3 }, PRIVATE), 4).limit).toBe(5);
  });

  it("warns within 30 days of expiry, and counts the last day as 0 days left", () => {
    expect(status(signLicense(PAYLOAD, PRIVATE), 2, new Date("2027-09-10T00:00:00Z"))).toMatchObject({ daysLeft: 23, expiringSoon: true, needsAttention: true });
    expect(status(signLicense(PAYLOAD, PRIVATE), 2, new Date("2027-10-03T09:00:00Z")).daysLeft).toBe(0);
    expect(status(signLicense(PAYLOAD, PRIVATE), 2, new Date("2027-08-01T00:00:00Z")).expiringSoon).toBe(false);
  });

  it("falls back to 5 once the key has expired, and says so", () => {
    const s = status(signLicense(PAYLOAD, PRIVATE), 7, new Date("2027-10-04T00:00:00Z"));
    expect(s).toMatchObject({ state: "expired", limit: 5, overLimit: true, needsAttention: true, verify: "expired", customer: null, expiresAt: "2027-10-03" });
    expect(s.summary).toBe("Licence for Acme Ltd expired on 3 Oct 2027: free limit, 7 of 5 users");
    expect(s.problem).toBe("This key expired on 3 Oct 2027.");
  });

  it("treats a stored key that isn't valid as Free, with the reason", () => {
    const s = status("KYB1.nonsense.x", 3);
    expect(s).toMatchObject({ state: "invalid", limit: 5, verify: "malformed", needsAttention: true });
    expect(s.summary).toBe("Free: 3 of 5 users (the stored licence key isn't valid)");
    expect(s.problem).toMatch(/doesn't look like a KyoubeAI licence key/);
  });

  it("treats a key bound to another instance as not valid here", () => {
    const s = status(signLicense({ ...PAYLOAD, instanceId: "inst-9" }, PRIVATE), 2);
    expect(s).toMatchObject({ state: "invalid", verify: "wrong_instance", limit: 5 });
  });

  it("reports an instance-bound key as bound", () => {
    expect(status(signLicense({ ...PAYLOAD, instanceId: "inst-1" }, PRIVATE), 2).instanceBound).toBe(true);
  });
});
