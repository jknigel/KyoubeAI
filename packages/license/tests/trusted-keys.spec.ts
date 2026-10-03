import { createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TRUSTED_KEYS } from "../src/trusted-keys.js";

describe("TRUSTED_KEYS", () => {
  it("ships the production signing key 2026a as an Ed25519 public key", () => {
    expect(Object.keys(TRUSTED_KEYS)).toContain("2026a");
    expect(createPublicKey(TRUSTED_KEYS["2026a"]!).asymmetricKeyType).toBe("ed25519");
  });
  it("can't be changed at runtime", () => {
    expect(Object.isFrozen(TRUSTED_KEYS)).toBe(true);
  });
  it("holds no private key", () => {
    for (const pem of Object.values(TRUSTED_KEYS)) expect(pem).not.toMatch(/PRIVATE KEY/);
  });
});
