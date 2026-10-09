import { describe, expect, it } from "vitest";
import { SECRET_CACHE_MS, SecretCache } from "../../src/secrets/cache.js";

const REF = { type: "secret_ref", secretId: "s1", version: "latest" };

function setup(ttlMs?: number) {
  const calls: Array<{ binding: unknown; companyId: string; configPath: string }> = [];
  const clock = { t: 1000 };
  let impl: (n: number) => Promise<string> = async (n) => `v${n}`;
  const cache = new SecretCache({
    resolve: (binding, companyId, configPath) => { calls.push({ binding, companyId, configPath }); return impl(calls.length); },
    now: () => clock.t,
    ttlMs,
  });
  return { cache, calls, clock, setImpl: (f: (n: number) => Promise<string>) => { impl = f; } };
}

describe("SecretCache", () => {
  it("defaults to a 60 second TTL", () => { expect(SECRET_CACHE_MS).toBe(60_000); });

  it("reuses a value within the TTL", async () => {
    const { cache, calls, clock } = setup();
    expect(await cache.get("c1", "decisions", REF, "k")).toBe("v1");
    clock.t += SECRET_CACHE_MS - 1;
    expect(await cache.get("c1", "decisions", REF, "k")).toBe("v1");
    expect(calls).toHaveLength(1);
  });

  it("resolves again after expiry", async () => {
    const { cache, calls, clock } = setup();
    await cache.get("c1", "decisions", REF, "k");
    clock.t += SECRET_CACHE_MS;
    expect(await cache.get("c1", "decisions", REF, "k")).toBe("v2");
    expect(calls).toHaveLength(2);
  });

  it("resolves again for a different configPath or binding", async () => {
    const { cache, calls } = setup();
    await cache.get("c1", "s", REF, "a");
    await cache.get("c1", "s", REF, "b");
    await cache.get("c1", "s", { ...REF, version: "2" }, "b");
    expect(calls).toHaveLength(3);
  });

  it("keeps slots apart", async () => {
    const { cache, calls } = setup();
    await cache.get("c1", "a", REF, "k");
    await cache.get("c1", "b", REF, "k");
    expect(calls).toHaveLength(2);
  });

  it("shares one in-flight lookup between concurrent cold gets", async () => {
    const { cache, calls } = setup();
    const [a, b] = await Promise.all([cache.get("c1", "s", REF, "k"), cache.get("c1", "s", REF, "k")]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  it("invalidate(companyId) drops that company only", async () => {
    const { cache, calls } = setup();
    await cache.get("c1", "s", REF, "k");
    await cache.get("c2", "s", REF, "k");
    cache.invalidate("c1");
    await cache.get("c1", "s", REF, "k");
    await cache.get("c2", "s", REF, "k");
    expect(calls.map((c) => c.companyId)).toEqual(["c1", "c2", "c1"]);
  });

  it("a lookup started before invalidate never fills the cache after it", async () => {
    const { cache, calls, setImpl } = setup();
    let release!: (v: string) => void;
    setImpl(() => new Promise<string>((r) => { release = r; }));
    const first = cache.get("c1", "s", REF, "k");
    cache.invalidate("c1");
    release("stale");
    expect(await first).toBe("stale");
    setImpl(async () => "fresh");
    expect(await cache.get("c1", "s", REF, "k")).toBe("fresh");
    expect(calls).toHaveLength(2);
  });

  it("invalidate() drops everything", async () => {
    const { cache, calls } = setup();
    await cache.get("c1", "s", REF, "k");
    await cache.get("c2", "s", REF, "k");
    cache.invalidate();
    await cache.get("c1", "s", REF, "k");
    await cache.get("c2", "s", REF, "k");
    expect(calls).toHaveLength(4);
  });

  it("does not cache a rejection and rethrows the resolver's error", async () => {
    const { cache, calls, setImpl } = setup();
    const boom = new Error("boom");
    setImpl(async () => { throw boom; });
    await expect(cache.get("c1", "s", REF, "k")).rejects.toBe(boom);
    setImpl(async () => "ok");
    expect(await cache.get("c1", "s", REF, "k")).toBe("ok");
    expect(calls).toHaveLength(2);
  });
});
