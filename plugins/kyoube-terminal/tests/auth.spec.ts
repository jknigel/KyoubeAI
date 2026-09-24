import { describe, expect, it } from "vitest";
import { RoleResolver } from "../src/auth.js";

function members(rows: Array<{ principalType?: string; principalId: string; status?: string; membershipRole: string | null; companyId?: string }>) {
  let calls = 0;
  return {
    calls: () => calls,
    list: async ({ companyId }: { companyId: string }) => {
      calls += 1;
      return rows
        .filter((row) => (row.companyId ?? "c1") === companyId)
        .map((row) => ({ principalType: row.principalType ?? "user", principalId: row.principalId, status: row.status ?? "active", membershipRole: row.membershipRole }));
    },
  };
}

describe("RoleResolver", () => {
  it("resolves the active human member's role and caches the company listing", async () => {
    const source = members([{ principalId: "u1", membershipRole: "admin" }, { principalId: "u2", membershipRole: "member" }]);
    const resolver = new RoleResolver(source, { cacheMs: 30_000, now: () => 0 });
    expect(await resolver.resolveRole("c1", "u1")).toBe("admin");
    expect(await resolver.resolveRole("c1", "u2")).toBe("member");
    expect(source.calls()).toBe(1);
  });

  it("ignores agents, suspended members, and other companies", async () => {
    const source = members([
      { principalId: "u1", membershipRole: "owner", status: "suspended" },
      { principalId: "a1", principalType: "agent", membershipRole: "owner" },
      { principalId: "u3", membershipRole: "owner", companyId: "c2" },
    ]);
    const resolver = new RoleResolver(source);
    expect(await resolver.resolveRole("c1", "u1")).toBeNull();
    expect(await resolver.resolveRole("c1", "a1")).toBeNull();
    expect(await resolver.resolveRole("c1", "u3")).toBeNull();
  });

  it("expires the cache and can be invalidated", async () => {
    let now = 0;
    const source = members([{ principalId: "u1", membershipRole: "admin" }]);
    const resolver = new RoleResolver(source, { cacheMs: 1000, now: () => now });
    await resolver.resolveRole("c1", "u1");
    now = 999;
    await resolver.resolveRole("c1", "u1");
    expect(source.calls()).toBe(1);
    now = 1001;
    await resolver.resolveRole("c1", "u1");
    expect(source.calls()).toBe(2);
    resolver.invalidate("c1");
    await resolver.resolveRole("c1", "u1");
    expect(source.calls()).toBe(3);
  });

  it("resolveFresh ignores the cache window and refreshes it for later readers (P4-R36)", async () => {
    let now = 0;
    const rows = [{ principalId: "u1", membershipRole: "admin" as string | null }];
    const source = members(rows);
    const resolver = new RoleResolver(source, { cacheMs: 30_000, now: () => now });
    expect(await resolver.resolveRole("c1", "u1")).toBe("admin");
    rows[0]!.membershipRole = "member";
    // Still inside the window: the cached answer is the old one, a fresh read is not.
    expect(await resolver.resolveRole("c1", "u1")).toBe("admin");
    expect(await resolver.resolveFresh("c1", "u1")).toBe("member");
    expect(source.calls()).toBe(2);
    // And the fresh read left the cache holding the new answer.
    expect(await resolver.resolveRole("c1", "u1")).toBe("member");
    expect(source.calls()).toBe(2);
  });

  it("assertAllowed takes the fresh path when asked, and the cache otherwise (P4-R36)", async () => {
    const rows = [{ principalId: "u1", membershipRole: "admin" as string | null }];
    const source = members(rows);
    const resolver = new RoleResolver(source, { cacheMs: 30_000, now: () => 0 });
    expect(await resolver.assertAllowed("c1", "u1", ["admin"])).toBe("admin");
    rows[0]!.membershipRole = "member";
    expect(await resolver.assertAllowed("c1", "u1", ["admin"])).toBe("admin");
    expect(source.calls()).toBe(1);
    await expect(resolver.assertAllowed("c1", "u1", ["admin"], { fresh: true })).rejects.toThrow("forbidden");
    expect(source.calls()).toBe(2);
  });

  it("assertAllowed returns the role or throws forbidden", async () => {
    const source = members([{ principalId: "u1", membershipRole: "admin" }, { principalId: "u2", membershipRole: "member" }]);
    const resolver = new RoleResolver(source);
    expect(await resolver.assertAllowed("c1", "u1", ["owner", "admin"])).toBe("admin");
    await expect(resolver.assertAllowed("c1", "u2", ["owner", "admin"])).rejects.toThrow("forbidden");
    await expect(resolver.assertAllowed("c1", "nobody", ["owner"])).rejects.toThrow("forbidden");
  });

  it("shares one in-flight listing for concurrent calls to the same company", async () => {
    let calls = 0;
    let resolve: (value: any) => void;
    const listPromise = new Promise((r) => {
      resolve = r;
    });

    const source = {
      calls: () => calls,
      list: async () => {
        calls += 1;
        await listPromise;
        return [{ principalType: "user", principalId: "u1", status: "active", membershipRole: "admin" }];
      },
    };

    const resolver = new RoleResolver(source);
    const p1 = resolver.resolveRole("c1", "u1");
    const p2 = resolver.resolveRole("c1", "u1");

    expect(source.calls()).toBe(1);

    resolve!(undefined);
    expect(await p1).toBe("admin");
    expect(await p2).toBe("admin");
    expect(source.calls()).toBe(1);
  });

  it("retries after list() rejection and does not cache the error", async () => {
    let calls = 0;
    let shouldReject = true;

    const source = {
      calls: () => calls,
      list: async () => {
        calls += 1;
        if (shouldReject) {
          throw new Error("network error");
        }
        return [{ principalType: "user", principalId: "u1", status: "active", membershipRole: "admin" }];
      },
    };

    const resolver = new RoleResolver(source);
    await expect(resolver.resolveRole("c1", "u1")).rejects.toThrow("network error");
    expect(source.calls()).toBe(1);

    shouldReject = false;
    expect(await resolver.resolveRole("c1", "u1")).toBe("admin");
    expect(source.calls()).toBe(2);
  });
});
