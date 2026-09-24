import { describe, expect, it } from "vitest";
import { assertAppSource, validateAppManifest } from "../../src/apps/manifest.js";

describe("validateAppManifest", () => {
  it("normalises a valid manifest", () => {
    expect(validateAppManifest({ name: "Sales CRM", slug: "sales-crm", tables: [{ name: "contacts", access: "readwrite" }, { name: "deals" }] })).toEqual({
      name: "Sales CRM", slug: "sales-crm", description: null, icon: null, tables: [{ name: "contacts", access: "readwrite" }, { name: "deals", access: "read" }], surfaces: ["page"],
    });
  });
  it("rejects bad slugs, duplicate tables, and unknown surfaces", () => {
    expect(() => validateAppManifest({ name: "x", slug: "Bad Slug", tables: [] })).toThrow("slug");
    expect(() => validateAppManifest({ name: "x", slug: "ok", tables: [{ name: "a" }, { name: "a" }] })).toThrow("duplicate");
    expect(() => validateAppManifest({ name: "x", slug: "ok", tables: [], surfaces: ["widget"] })).toThrow("invalid");
  });
  it("rejects unknown keys at the top level and inside a table entry", () => {
    expect(() => validateAppManifest({ name: "x", slug: "ok", tables: [], typo: true })).toThrow("invalid");
    expect(() => validateAppManifest({ name: "x", slug: "ok", tables: [{ name: "a", bogus: true }] })).toThrow("invalid");
  });
  it("rejects table names that fail the shared identifier rule", () => {
    expect(() => validateAppManifest({ name: "x", slug: "ok", tables: [{ name: "Contacts" }] })).toThrow("invalid");
    expect(() => validateAppManifest({ name: "x", slug: "ok", tables: [{ name: "select" }] })).toThrow("invalid");
  });
});

describe("assertAppSource", () => {
  it("accepts HTML documents under 2 MiB and rejects others", () => {
    expect(assertAppSource("<!doctype html><html><body>hi</body></html>")).toContain("<body>");
    expect(() => assertAppSource("just text")).toThrow("HTML");
    expect(() => assertAppSource("<html>" + "x".repeat(2 * 1024 * 1024))).toThrow("2 MiB");
    expect(() => assertAppSource(42)).toThrow("string");
  });
});
