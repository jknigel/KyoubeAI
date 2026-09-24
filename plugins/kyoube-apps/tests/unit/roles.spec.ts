import { describe, expect, it } from "vitest";
import { RoleResolver, type AccessMemberRow } from "../../src/roles.js";

const C = "company-1";

/** A members source that answers from `roles` and counts how often it was asked. */
function members(roles: Record<string, string>) {
  const source = {
    calls: 0,
    roles,
    async list(): Promise<AccessMemberRow[]> {
      source.calls += 1;
      return Object.entries(source.roles).map(([principalId, membershipRole]) => ({ principalType: "user", principalId, status: "active", membershipRole }));
    },
  };
  return source;
}

describe("RoleResolver", () => {
  it("caches a company's roles for the cache window", async () => {
    const source = members({ "user-1": "owner" });
    let clock = 1000;
    const resolver = new RoleResolver(source, { cacheMs: 30_000, now: () => clock });
    expect(await resolver.resolveRole(C, "user-1")).toBe("owner");
    source.roles = { "user-1": "viewer" };
    expect(await resolver.resolveRole(C, "user-1")).toBe("owner");
    expect(source.calls).toBe(1);
    clock += 30_001;
    expect(await resolver.resolveRole(C, "user-1")).toBe("viewer");
    expect(source.calls).toBe(2);
  });

  it("resolveFresh bypasses the cache and refreshes it for later readers (P4-R13)", async () => {
    const source = members({ "user-1": "owner" });
    let clock = 1000;
    const resolver = new RoleResolver(source, { cacheMs: 30_000, now: () => clock });
    expect(await resolver.resolveRole(C, "user-1")).toBe("owner");
    source.roles = { "user-1": "viewer" };
    // Still inside the cache window, but a fresh lookup asks the host again.
    expect(await resolver.resolveFresh(C, "user-1")).toBe("viewer");
    expect(source.calls).toBe(2);
    // …and what it read is what the cached path now answers, without another call.
    expect(await resolver.resolveRole(C, "user-1")).toBe("viewer");
    expect(source.calls).toBe(2);
  });

  it("reports a user the fresh lookup no longer finds", async () => {
    const source = members({ "user-1": "owner" });
    const resolver = new RoleResolver(source);
    expect(await resolver.resolveRole(C, "user-1")).toBe("owner");
    source.roles = {};
    expect(await resolver.resolveFresh(C, "user-1")).toBeNull();
  });

  it("does not poison the cache when the host lookup fails", async () => {
    const source = members({ "user-1": "owner" });
    const failing = { list: async () => { throw new Error("host down"); } };
    const resolver = new RoleResolver(failing);
    await expect(resolver.resolveFresh(C, "user-1")).rejects.toThrow("host down");
    const working = new RoleResolver(source);
    expect(await working.resolveFresh(C, "user-1")).toBe("owner");
  });

  it("invalidate drops the cached entry", async () => {
    const source = members({ "user-1": "owner" });
    const resolver = new RoleResolver(source);
    expect(await resolver.resolveRole(C, "user-1")).toBe("owner");
    source.roles = { "user-1": "viewer" };
    resolver.invalidate(C);
    expect(await resolver.resolveRole(C, "user-1")).toBe("viewer");
    expect(source.calls).toBe(2);
  });
});
