// tests/unit/app-manifest-connections.spec.ts
import { describe, expect, it } from "vitest";
import { MAX_APP_CONNECTIONS, connectionChanges, connectionsChanged, validateAppManifest } from "../../src/apps/manifest.js";

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

describe("connectionChanges", () => {
  const m = (c?: unknown) => (c ? withConns(c) : validateAppManifest(base));
  it("marks each declared connection as added, widened or neither, the same way connectionsChanged decides", () => {
    const current = m([{ name: "keep" }, { name: "wide" }, { name: "narrow", access: "read-write" }, { name: "gone" }]);
    const target = m([{ name: "keep" }, { name: "wide", access: "read-write" }, { name: "narrow" }, { name: "new" }]);
    expect(connectionChanges(current, target)).toEqual([
      { name: "keep", access: "read", added: false, widened: false },
      { name: "wide", access: "read-write", added: false, widened: true },
      { name: "narrow", access: "read", added: false, widened: false },
      { name: "new", access: "read", added: true, widened: false },
    ]);
    expect(connectionsChanged(current, target)).toBe(true);
    expect(connectionChanges(null, m([{ name: "a", access: "read-write" }]))).toEqual([{ name: "a", access: "read-write", added: true, widened: false }]);
    expect(connectionChanges(m([{ name: "a" }]), m())).toEqual([]);
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
