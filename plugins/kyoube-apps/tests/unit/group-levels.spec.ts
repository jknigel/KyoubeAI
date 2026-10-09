import { describe, expect, it } from "vitest";
import { highestLevel, isManagerRole, parseGroupLevel } from "../../src/groups/levels.js";

describe("group levels", () => {
  it("parses the three group levels and nothing else", () => {
    expect(parseGroupLevel("read")).toBe("read");
    expect(parseGroupLevel("schema")).toBe("schema");
    expect(parseGroupLevel(null)).toBeNull();
    expect(parseGroupLevel("")).toBeNull();
    expect(() => parseGroupLevel("none")).toThrow("invalid");
    expect(() => parseGroupLevel("admin")).toThrow("invalid");
  });
  it("picks the highest level", () => {
    expect(highestLevel(["read"])).toBe("read");
    expect(highestLevel(["write", "read", "schema"])).toBe("schema");
    expect(highestLevel(["read", "write"])).toBe("write");
  });
  it("treats owner and admin as managers", () => {
    expect(isManagerRole("owner")).toBe(true);
    expect(isManagerRole("Admin")).toBe(true);
    expect(isManagerRole("operator")).toBe(false);
    expect(isManagerRole(null)).toBe(false);
  });
});
