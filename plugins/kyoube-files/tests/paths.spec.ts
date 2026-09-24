import { describe, expect, it } from "vitest";
import { baseName, isWithin, joinRelative, looksLikeText, normalizeRelativePath, parentOf, validateEntryName } from "../src/paths.js";

describe("normalizeRelativePath", () => {
  it("canonicalises ordinary relative paths", () => {
    expect(normalizeRelativePath("")).toBe("");
    expect(normalizeRelativePath(undefined)).toBe("");
    expect(normalizeRelativePath(".")).toBe("");
    expect(normalizeRelativePath("./")).toBe("");
    expect(normalizeRelativePath("a")).toBe("a");
    expect(normalizeRelativePath("a/b/")).toBe("a/b");
    expect(normalizeRelativePath("./a//b/./c")).toBe("a/b/c");
    expect(normalizeRelativePath("a/b/../c")).toBe("a/c");
  });
  it("refuses anything that could leave the folder", () => {
    expect(() => normalizeRelativePath("/etc/passwd")).toThrow("invalid");
    expect(() => normalizeRelativePath("..")).toThrow("invalid");
    expect(() => normalizeRelativePath("../x")).toThrow("invalid");
    expect(() => normalizeRelativePath("a/../../x")).toThrow("invalid");
    expect(() => normalizeRelativePath("a\\b")).toThrow("invalid");
    expect(() => normalizeRelativePath("a\0b")).toThrow("invalid");
    expect(() => normalizeRelativePath(42)).toThrow("invalid");
  });
});

describe("validateEntryName", () => {
  it("accepts a plain name and rejects separators, dots and padding", () => {
    expect(validateEntryName("notes.md")).toBe("notes.md");
    expect(validateEntryName(".env")).toBe(".env");
    for (const bad of ["", "a/b", "a\\b", ".", "..", " x", "x ", "a\0", "x".repeat(256)]) {
      expect(() => validateEntryName(bad), JSON.stringify(bad)).toThrow("invalid");
    }
  });
});

describe("path helpers", () => {
  it("join, parent, base and containment", () => {
    expect(joinRelative("", "a")).toBe("a");
    expect(joinRelative("a/b", "c")).toBe("a/b/c");
    expect(parentOf("a/b/c")).toBe("a/b");
    expect(parentOf("a")).toBe("");
    expect(baseName("a/b/c.txt")).toBe("c.txt");
    expect(isWithin("", "anything")).toBe(true);
    expect(isWithin("a", "a")).toBe(true);
    expect(isWithin("a", "a/b")).toBe(true);
    expect(isWithin("a", "ab")).toBe(false);
  });
});

describe("looksLikeText", () => {
  it("treats UTF-8 as text and NUL bytes or invalid UTF-8 as binary", () => {
    expect(looksLikeText(new TextEncoder().encode("hello\nwörld"))).toBe(true);
    expect(looksLikeText(new Uint8Array())).toBe(true);
    expect(looksLikeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe(false);
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(false);
  });
});
