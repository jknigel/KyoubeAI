// tests/unit/app-manifest-decisions.spec.ts
import { describe, expect, it } from "vitest";
import { decisionSetsChanged, validateAppManifest } from "../../src/apps/manifest.js";

const urgent = { type: "check", statement: "The ticket needs a reply today." };
const base = { name: "Triage", slug: "triage", tables: [{ name: "tickets" }] };
const set = (overrides: Record<string, unknown> = {}) => ({ table: "tickets", fields: ["subject", "body"], questions: { urgent }, ...overrides });

describe("decision sets in the manifest", () => {
  it("normalises a set, defaulting advisory to false", () => {
    expect(validateAppManifest({ ...base, decisions: { triage: set() } }).decisions).toEqual({
      triage: { table: "tickets", fields: ["subject", "body"], advisory: false, questions: { urgent } },
    });
  });

  it("leaves a manifest without sets exactly as before", () => {
    expect(validateAppManifest(base)).not.toHaveProperty("decisions");
    expect(validateAppManifest({ ...base, decisions: {} })).not.toHaveProperty("decisions");
  });

  it("takes at most ten sets, keyed like question keys", () => {
    const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`s${i}`, set()]));
    expect(() => validateAppManifest({ ...base, decisions: eleven })).toThrow("invalid");
    expect(() => validateAppManifest({ ...base, decisions: { Triage: set() } })).toThrow("invalid");
  });

  it("needs the set's table to be declared by the manifest", () => {
    expect(() => validateAppManifest({ ...base, decisions: { triage: set({ table: "orders" }) } })).toThrow('uses table "orders", which the manifest does not declare');
  });

  it("checks the fields: identifiers, no repeats, 1 to 20", () => {
    expect(() => validateAppManifest({ ...base, decisions: { triage: set({ fields: ["subject", "subject"] }) } })).toThrow("twice");
    expect(() => validateAppManifest({ ...base, decisions: { triage: set({ fields: ["Subject"] }) } })).toThrow("invalid");
    expect(() => validateAppManifest({ ...base, decisions: { triage: set({ fields: ["id"] }) } })).toThrow("system column");
    expect(() => validateAppManifest({ ...base, decisions: { triage: set({ fields: [] }) } })).toThrow("invalid");
    expect(() => validateAppManifest({ ...base, decisions: { triage: set({ fields: Array.from({ length: 21 }, (_, i) => `f${i}`) }) } })).toThrow("invalid");
  });

  it("checks the questions with the decision contract and refuses unknown keys", () => {
    expect(() => validateAppManifest({ ...base, decisions: { triage: set({ questions: { urgent: { type: "check" } } }) } })).toThrow("invalid");
    expect(() => validateAppManifest({ ...base, decisions: { triage: set({ prompt: "free text" }) } })).toThrow("invalid");
  });
});

describe("decisionSetsChanged", () => {
  const withSets = validateAppManifest({ ...base, decisions: { triage: set() } });
  it("is false when the target declares no sets, even if the current one did", () => {
    expect(decisionSetsChanged(withSets, validateAppManifest(base))).toBe(false);
    expect(decisionSetsChanged(null, validateAppManifest(base))).toBe(false);
  });
  it("is true for new sets and for any change to a set", () => {
    expect(decisionSetsChanged(null, withSets)).toBe(true);
    expect(decisionSetsChanged(validateAppManifest(base), withSets)).toBe(true);
    expect(decisionSetsChanged(withSets, validateAppManifest({ ...base, decisions: { triage: set({ fields: ["subject"] }) } }))).toBe(true);
    expect(decisionSetsChanged(withSets, validateAppManifest({ ...base, decisions: { triage: set({ advisory: true }) } }))).toBe(true);
  });
  it("is false for the same sets written in a different key order", () => {
    const reordered = validateAppManifest({ ...base, decisions: { triage: { questions: { urgent: { statement: urgent.statement, type: "check" } }, fields: ["subject", "body"], table: "tickets" } } });
    expect(decisionSetsChanged(withSets, reordered)).toBe(false);
  });
});
