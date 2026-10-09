import { describe, expect, it } from "vitest";
import { highestLevel, isManagerRole, isViewerRole, levelSource, parseGroupLevel } from "../../src/groups/levels.js";

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
  it("names where a person's level comes from; a viewer always shows their role (R19)", () => {
    expect(levelSource("viewer", ["Support"])).toBe("role: viewer (groups cannot raise a viewer)");
    expect(levelSource("Viewer", [])).toBe("role: viewer (groups cannot raise a viewer)");
    expect(levelSource("operator", ["Sales", "Support"])).toBe("group: Sales, Support");
    expect(levelSource("operator", [])).toBe("role: operator");
    expect(levelSource("admin", ["Sales"])).toBe("role: admin");
    expect(levelSource(null, [])).toBe("role: none");
  });
  it("recognises the viewer role in any case", () => {
    expect(isViewerRole("viewer")).toBe(true);
    expect(isViewerRole("VIEWER")).toBe(true);
    expect(isViewerRole("operator")).toBe(false);
    expect(isViewerRole(undefined)).toBe(false);
  });
  it("treats owner and admin as managers", () => {
    expect(isManagerRole("owner")).toBe(true);
    expect(isManagerRole("Admin")).toBe(true);
    expect(isManagerRole("operator")).toBe(false);
    expect(isManagerRole(null)).toBe(false);
  });
});
