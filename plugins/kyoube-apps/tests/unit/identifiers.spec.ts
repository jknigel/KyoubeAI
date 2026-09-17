import { describe, expect, it } from "vitest";
import { assertIdentifier, quoteIdent, quoteLiteral } from "../../src/data/identifiers.js";

describe("assertIdentifier", () => {
  it("accepts lowercase snake_case names", () => {
    expect(assertIdentifier("contacts", "table")).toBe("contacts");
    expect(assertIdentifier("deal_stage_2", "field")).toBe("deal_stage_2");
  });
  it("rejects bad shapes, reserved prefixes, system columns, and reserved words", () => {
    for (const bad of ["Contacts", "1abc", "a-b", "", "x".repeat(64), "kyoube_x", "pg_x", "_trash_a", "id", "created_at", "select", "user", "table", "when"]) {
      expect(() => assertIdentifier(bad, "name")).toThrow("invalid");
    }
    expect(() => assertIdentifier(42, "name")).toThrow("invalid");
  });
});

describe("quoting", () => {
  it("quotes identifiers and literals safely", () => {
    expect(quoteIdent("contacts")).toBe('"contacts"');
    expect(() => quoteIdent('bad"name')).toThrow("invalid");
    expect(quoteLiteral("it's")).toBe("'it''s'");
  });
});
