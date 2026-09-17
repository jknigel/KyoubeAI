import { describe, expect, it } from "vitest";
import { compileQuery, compileWhere, type FieldTypeMap } from "../../src/data/filter.js";

const fields: FieldTypeMap = { id: "system", created_at: "system", name: "text", amount: "decimal", stage: "select", tags: "multi_select", active: "boolean" };

describe("compileWhere", () => {
  it("compiles simple and nested conditions with positional params", () => {
    const params: unknown[] = [];
    const sql = compileWhere({ and: [{ field: "name", op: "contains", value: "ac%me" }, { or: [{ field: "amount", op: "gte", value: 10 }, { field: "stage", op: "in", value: ["new", "won"] }] }, { not: { field: "active", op: "eq", value: false } }] }, fields, params);
    expect(sql).toBe('(("name" ILIKE $1 ESCAPE \'\\\') AND (("amount" >= $2) OR ("stage" = ANY($3))) AND (NOT ("active" = $4)))');
    expect(params).toEqual(["%ac\\%me%", 10, ["new", "won"], false]);
  });
  it("handles null checks, array contains, and starts_with", () => {
    const params: unknown[] = [];
    expect(compileWhere({ field: "name", op: "is_null" }, fields, params)).toBe('("name" IS NULL)');
    expect(compileWhere({ field: "tags", op: "contains", value: "vip" }, fields, params)).toBe('($1 = ANY("tags"))');
    expect(compileWhere({ field: "name", op: "starts_with", value: "A_" }, fields, params)).toBe('("name" ILIKE $2 ESCAPE \'\\\')');
    expect(params).toEqual(["vip", "A\\_%"]);
  });
  it("compiles eq/neq against null to IS NULL / IS NOT NULL (P2-R31)", () => {
    const params: unknown[] = [];
    expect(compileWhere({ field: "name", op: "eq", value: null }, fields, params)).toBe('("name" IS NULL)');
    expect(compileWhere({ field: "name", op: "neq", value: null }, fields, params)).toBe('("name" IS NOT NULL)');
    expect(compileWhere({ or: [{ field: "name", op: "eq", value: null }, { field: "stage", op: "eq", value: "won" }] }, fields, params))
      .toBe('(("name" IS NULL) OR ("stage" = $1))');
    // No parameter is bound for either null comparison, so the placeholders stay in step.
    expect(params).toEqual(["won"]);
  });
  it("leaves every other operator's null handling to SQL", () => {
    const params: unknown[] = [];
    expect(compileWhere({ field: "amount", op: "gt", value: null }, fields, params)).toBe('("amount" > $1)');
    expect(compileWhere({ field: "amount", op: "lte", value: null }, fields, params)).toBe('("amount" <= $2)');
    expect(params).toEqual([null, null]);
    expect(() => compileWhere({ field: "name", op: "eq" }, fields, [])).toThrow("needs a value");
  });
  it("rejects unknown fields, unknown ops, bad shapes, and excessive nesting", () => {
    expect(() => compileWhere({ field: "nope", op: "eq", value: 1 }, fields, [])).toThrow("unknown field");
    expect(() => compileWhere({ field: "name", op: "like", value: 1 }, fields, [])).toThrow("unknown operator");
    expect(() => compileWhere({ field: "name", op: "in", value: "x" }, fields, [])).toThrow("array");
    expect(() => compileWhere({ and: "x" }, fields, [])).toThrow("invalid");
    let deep: unknown = { field: "name", op: "eq", value: "x" };
    for (let i = 0; i < 9; i += 1) deep = { not: deep };
    expect(() => compileWhere(deep, fields, [])).toThrow("depth");
  });
  it("returns an empty string for no filter", () => {
    expect(compileWhere(undefined, fields, [])).toBe("");
    expect(compileWhere({}, fields, [])).toBe("");
  });
  it("rejects inherited/prototype property names as fields", () => {
    expect(() => compileWhere({ field: "constructor", op: "eq", value: 1 }, fields, [])).toThrow("unknown field");
    expect(() => compileWhere({ field: "__proto__", op: "eq", value: 1 }, fields, [])).toThrow("unknown field");
  });
  it("rejects malformed in/contains value shapes", () => {
    expect(() => compileWhere({ field: "stage", op: "in", value: [] }, fields, [])).toThrow("array");
    expect(() => compileWhere({ field: "stage", op: "in", value: ["new", { bad: true }] }, fields, [])).toThrow("array");
    expect(() => compileWhere({ field: "tags", op: "contains", value: 123 }, fields, [])).toThrow("string");
  });
});

describe("compileQuery", () => {
  it("builds a full SELECT with ordering, limit, and offset clamped", () => {
    const query = compileQuery("deals", fields, { where: { field: "stage", op: "eq", value: "won" }, orderBy: [{ field: "amount", direction: "desc" }, { field: "created_at" }], limit: 5000, offset: 10, fields: ["id", "name"] });
    expect(query.sql).toBe('SELECT "id", "name" FROM "deals" WHERE ("stage" = $1) ORDER BY "amount" DESC, "created_at" ASC LIMIT 1000 OFFSET 10');
    expect(query.params).toEqual(["won"]);
    expect(query.limit).toBe(1000);
  });
  it("defaults to all fields ordered by created_at with limit 50", () => {
    const query = compileQuery("deals", fields, {});
    expect(query.sql).toBe('SELECT * FROM "deals" ORDER BY "created_at" ASC LIMIT 50 OFFSET 0');
  });
  it("rejects unknown order/select fields", () => {
    expect(() => compileQuery("deals", fields, { orderBy: [{ field: "nope" }] })).toThrow("unknown field");
    expect(() => compileQuery("deals", fields, { fields: ["nope"] })).toThrow("unknown field");
  });
  it("falls back to default limit/offset when given non-finite numbers", () => {
    const byLimit = compileQuery("deals", fields, { limit: Number.NaN });
    expect(byLimit.sql).toBe('SELECT * FROM "deals" ORDER BY "created_at" ASC LIMIT 50 OFFSET 0');
    expect(byLimit.limit).toBe(50);
    const byOffset = compileQuery("deals", fields, { offset: Number.POSITIVE_INFINITY });
    expect(byOffset.sql).toBe('SELECT * FROM "deals" ORDER BY "created_at" ASC LIMIT 50 OFFSET 0');
    expect(byOffset.offset).toBe(0);
  });
});
