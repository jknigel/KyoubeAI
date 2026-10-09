// tests/unit/app-manifest-connections.spec.ts
import { describe, expect, it } from "vitest";
import { MAX_APP_CONNECTIONS, connectionsChanged, validateAppManifest } from "../../src/apps/manifest.js";

const base = { name: "Pay", slug: "pay", tables: [{ name: "tickets" }] };
const withConns = (connections: unknown) => validateAppManifest({ ...base, connections });

describe("connections in the manifest", () => {
  it("normalises access to read", () => {
    expect(withConns([{ name: "stripe" }, { name: "crm", access: "read-write" }]).connections)
      .toEqual([{ name: "stripe", access: "read" }, { name: "crm", access: "read-write" }]);
  });
  it("leaves a manifest without connections as before", () => {
    expect(validateAppManifest(base)).not.toHaveProperty("connections");
    expect(withConns([])).not.toHaveProperty("connections");
  });
  it("rejects bad names, unknown keys, bad access, duplicates and more than the limit", () => {
    expect(() => withConns([{ name: "Stripe" }])).toThrow("invalid");
    expect(() => withConns([{ name: "stripe", url: "x" }])).toThrow("invalid");
    expect(() => withConns([{ name: "stripe", access: "write" }])).toThrow("invalid");
    expect(() => withConns([{ name: "stripe" }, { name: "stripe" }])).toThrow('duplicate connection "stripe"');
    const many = Array.from({ length: MAX_APP_CONNECTIONS + 1 }, (_, i) => ({ name: `c${i}` }));
    expect(() => withConns(many)).toThrow("invalid");
    expect(withConns(many.slice(0, MAX_APP_CONNECTIONS)).connections).toHaveLength(MAX_APP_CONNECTIONS);
  });
});

describe("connectionsChanged", () => {
  const m = (c?: unknown) => (c ? withConns(c) : validateAppManifest(base));
  it("is true when a connection is added or widened", () => {
    expect(connectionsChanged(null, m([{ name: "stripe" }]))).toBe(true);
    expect(connectionsChanged(m(), m([{ name: "stripe" }]))).toBe(true);
    expect(connectionsChanged(m([{ name: "stripe" }]), m([{ name: "stripe" }, { name: "crm" }]))).toBe(true);
    expect(connectionsChanged(m([{ name: "stripe" }]), m([{ name: "stripe", access: "read-write" }]))).toBe(true);
  });
  it("is false when unchanged, reordered, removed or narrowed", () => {
    expect(connectionsChanged(m([{ name: "a" }, { name: "b" }]), m([{ name: "b" }, { name: "a" }]))).toBe(false);
    expect(connectionsChanged(m([{ name: "a" }, { name: "b" }]), m([{ name: "a" }]))).toBe(false);
    expect(connectionsChanged(m([{ name: "a", access: "read-write" }]), m([{ name: "a" }]))).toBe(false);
    expect(connectionsChanged(m([{ name: "a" }]), m())).toBe(false);
    expect(connectionsChanged(null, m())).toBe(false);
  });
});
