import { describe, expect, it } from "vitest";
import { assertLevel, levelAllows, parseLevel, roleToLevel } from "../../src/data/permissions.js";

describe("permissions", () => {
  it("orders levels and checks operations", () => {
    expect(levelAllows("none", "read")).toBe(false);
    expect(levelAllows("read", "read")).toBe(true);
    expect(levelAllows("read", "write")).toBe(false);
    expect(levelAllows("write", "write")).toBe(true);
    expect(levelAllows("write", "schema")).toBe(false);
    expect(levelAllows("schema", "schema")).toBe(true);
  });
  it("maps company roles to levels", () => {
    expect(roleToLevel("owner")).toBe("schema");
    expect(roleToLevel("admin")).toBe("schema");
    expect(roleToLevel("operator")).toBe("write");
    expect(roleToLevel("member")).toBe("write");
    expect(roleToLevel("viewer")).toBe("read");
    expect(roleToLevel(null)).toBe("none");
    expect(roleToLevel("weird")).toBe("none");
  });
  it("parses and asserts", () => {
    expect(parseLevel("write")).toBe("write");
    expect(() => parseLevel("root")).toThrow("invalid");
    expect(() => assertLevel("read", "write", "insert rows")).toThrow("forbidden: insert rows requires write access (you have read)");
    expect(() => assertLevel("schema", "read", "x")).not.toThrow();
  });
});
