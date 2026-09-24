import { describe, expect, it } from "vitest";
import { coerceValue, columnDefinition, normalizeFieldSpec } from "../../src/data/field-kinds.js";

describe("normalizeFieldSpec", () => {
  it("fills defaults and validates kind-specific options", () => {
    expect(normalizeFieldSpec({ name: "email", kind: "email" })).toEqual({ name: "email", displayName: "Email", description: null, kind: "email", required: false, options: {} });
    expect(normalizeFieldSpec({ name: "stage", kind: "select", options: { choices: ["new", "won"] }, required: true }).options).toEqual({ choices: ["new", "won"] });
    expect(() => normalizeFieldSpec({ name: "stage", kind: "select" })).toThrow("choices");
    expect(() => normalizeFieldSpec({ name: "owner", kind: "relation" })).toThrow("relationTable");
    expect(() => normalizeFieldSpec({ name: "x", kind: "blob" })).toThrow("invalid");
  });
});

describe("columnDefinition", () => {
  it("maps kinds to Postgres types with constraints", () => {
    const text = normalizeFieldSpec({ name: "title", kind: "text", required: true });
    expect(columnDefinition(text, "deals")).toBe('"title" text NOT NULL');
    const amount = normalizeFieldSpec({ name: "amount", kind: "decimal" });
    expect(columnDefinition(amount, "deals")).toBe('"amount" numeric');
    const stage = normalizeFieldSpec({ name: "stage", kind: "select", options: { choices: ["new", "it's"] } });
    expect(columnDefinition(stage, "deals")).toBe('"stage" text CONSTRAINT "deals_stage_choices" CHECK ("stage" IN (\'new\', \'it\'\'s\'))');
    const tags = normalizeFieldSpec({ name: "tags", kind: "multi_select", options: { choices: ["a", "b"] } });
    expect(columnDefinition(tags, "deals")).toBe('"tags" text[] CONSTRAINT "deals_tags_choices" CHECK ("tags" <@ ARRAY[\'a\', \'b\']::text[])');
    const contact = normalizeFieldSpec({ name: "contact", kind: "relation", options: { relationTable: "contacts" } });
    expect(columnDefinition(contact, "deals")).toBe('"contact" uuid REFERENCES "contacts" ("id") ON DELETE SET NULL');
    expect(columnDefinition(normalizeFieldSpec({ name: "occurred_at", kind: "datetime" }), "t")).toBe('"occurred_at" timestamptz');
  });
});

describe("coerceValue", () => {
  it("validates and normalises cell values by kind", () => {
    expect(coerceValue(normalizeFieldSpec({ name: "n", kind: "integer" }), "12")).toBe(12);
    expect(() => coerceValue(normalizeFieldSpec({ name: "n", kind: "integer" }), 1.5)).toThrow("integer");
    expect(coerceValue(normalizeFieldSpec({ name: "d", kind: "date" }), "2026-09-05")).toBe("2026-09-05");
    expect(() => coerceValue(normalizeFieldSpec({ name: "d", kind: "date" }), "05/09/2026")).toThrow("YYYY-MM-DD");
    expect(coerceValue(normalizeFieldSpec({ name: "t", kind: "datetime" }), "2026-09-05T10:00:00Z")).toBe("2026-09-05T10:00:00.000Z");
    expect(coerceValue(normalizeFieldSpec({ name: "b", kind: "boolean" }), "true")).toBe(true);
    expect(coerceValue(normalizeFieldSpec({ name: "s", kind: "select", options: { choices: ["a"] } }), "a")).toBe("a");
    expect(() => coerceValue(normalizeFieldSpec({ name: "s", kind: "select", options: { choices: ["a"] } }), "z")).toThrow("one of");
    expect(coerceValue(normalizeFieldSpec({ name: "m", kind: "multi_select", options: { choices: ["a", "b"] } }), ["b"])).toEqual(["b"]);
    expect(() => coerceValue(normalizeFieldSpec({ name: "e", kind: "email" }), "nope")).toThrow("email");
    expect(coerceValue(normalizeFieldSpec({ name: "u", kind: "url" }), "https://x.y")).toBe("https://x.y/");
    expect(coerceValue(normalizeFieldSpec({ name: "j", kind: "json" }), { a: 1 })).toEqual({ a: 1 });
    expect(coerceValue(normalizeFieldSpec({ name: "r", kind: "relation", options: { relationTable: "x" } }), "2f1d8e2a-1f0a-4c7b-9a2d-3b4c5d6e7f80")).toBe("2f1d8e2a-1f0a-4c7b-9a2d-3b4c5d6e7f80");
    expect(coerceValue(normalizeFieldSpec({ name: "x", kind: "text" }), null)).toBeNull();
    expect(() => coerceValue(normalizeFieldSpec({ name: "x", kind: "text", required: true }), null)).toThrow("required");
    expect(() => coerceValue(normalizeFieldSpec({ name: "t", kind: "text" }), [1])).toThrow("expects");
    expect(coerceValue(normalizeFieldSpec({ name: "t", kind: "text" }), 42)).toBe("42");
    expect(() => coerceValue(normalizeFieldSpec({ name: "i", kind: "integer" }), [5])).toThrow("integer");
    expect(() => coerceValue(normalizeFieldSpec({ name: "i", kind: "integer" }), true)).toThrow("integer");
    expect(coerceValue(normalizeFieldSpec({ name: "d", kind: "decimal" }), "1.5")).toBe(1.5);
    expect(() => coerceValue(normalizeFieldSpec({ name: "d", kind: "decimal" }), [])).toThrow("number");
    expect(() => coerceValue(normalizeFieldSpec({ name: "u", kind: "url" }), ["https://x.y"])).toThrow("URL");
  });
});
