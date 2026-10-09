import { describe, expect, it } from "vitest";
import { DECISIONS_CONFIG_SCHEMA, parseProviderSettings, ProviderResolver, validateDecisionsConfig } from "../../src/decisions/config.js";
import { DataError } from "../../src/data/errors.js";
import manifest from "../../src/manifest.js";

const KEY = { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" };

function problem(raw: Record<string, unknown>): string {
  try { parseProviderSettings(raw); return "none"; } catch (error) { return error instanceof DataError ? `${error.code}: ${error.message}` : String(error); }
}

describe("parseProviderSettings", () => {
  it("is null until a provider is chosen", () => {
    expect(parseProviderSettings({})).toBeNull();
    expect(parseProviderSettings({ decisionsProvider: "" })).toBeNull();
  });
  it("uses the preset base URLs", () => {
    expect(parseProviderSettings({ decisionsProvider: "typesafe", decisionsModel: "jev-1.13.0", decisionsApiKey: KEY })).toEqual({ provider: "typesafe", baseUrl: "https://api.typesafe.ai", model: "jev-1.13.0", apiKeyRef: KEY });
    expect(parseProviderSettings({ decisionsProvider: "openrouter", decisionsModel: "typesafe/jev-1.13", decisionsApiKey: KEY })!.baseUrl).toBe("https://openrouter.ai/api");
    expect(parseProviderSettings({ decisionsProvider: "vercel", decisionsModel: "typesafe-ai/jev", decisionsApiKey: KEY })!.baseUrl).toBe("https://ai-gateway.vercel.sh/typesafe");
  });
  it("takes a custom https base URL and nothing else", () => {
    expect(parseProviderSettings({ decisionsProvider: "custom", decisionsBaseUrl: "https://kev.example.com/api/", decisionsModel: "kev-9b", decisionsApiKey: KEY })!.baseUrl).toBe("https://kev.example.com/api");
    expect(problem({ decisionsProvider: "custom", decisionsBaseUrl: "http://kev.example.com", decisionsModel: "kev", decisionsApiKey: KEY })).toMatch(/^disabled: .*https/);
    expect(problem({ decisionsProvider: "custom", decisionsBaseUrl: "https://u:p@kev.example.com", decisionsModel: "kev", decisionsApiKey: KEY })).toMatch(/^disabled/);
    expect(problem({ decisionsProvider: "custom", decisionsModel: "kev", decisionsApiKey: KEY })).toMatch(/base URL/);
  });
  it("refuses aliases that move and missing pieces", () => {
    expect(problem({ decisionsProvider: "typesafe", decisionsModel: "jev-latest", decisionsApiKey: KEY })).toMatch(/pinned/);
    expect(problem({ decisionsProvider: "openrouter", decisionsModel: "~typesafe/jev-latest", decisionsApiKey: KEY })).toMatch(/pinned/);
    expect(problem({ decisionsProvider: "typesafe", decisionsApiKey: KEY })).toMatch(/model/);
    expect(problem({ decisionsProvider: "typesafe", decisionsModel: "jev-1.13.0" })).toMatch(/API key/);
    expect(problem({ decisionsProvider: "acme", decisionsModel: "x", decisionsApiKey: KEY })).toMatch(/provider/);
  });
  it("validates a saved config for the host", () => {
    expect(validateDecisionsConfig({})).toEqual({ ok: true });
    expect(validateDecisionsConfig({ decisionsProvider: "typesafe", decisionsModel: "jev-latest", decisionsApiKey: KEY }).ok).toBe(false);
  });
});

describe("ProviderResolver", () => {
  function resolver(config: Record<string, unknown>) {
    let clock = 0;
    const lookups: unknown[] = [];
    const r = new ProviderResolver({
      getConfig: async () => config,
      resolveSecret: async (ref) => { lookups.push(ref); return `key-${lookups.length}`; },
      now: () => clock,
    });
    return { r, lookups, advance: (ms: number) => { clock += ms; } };
  }
  const config = { decisionsProvider: "typesafe", decisionsModel: "jev-1.13.0", decisionsApiKey: KEY };

  it("caches the key for 60 seconds per company", async () => {
    const { r, lookups, advance } = resolver(config);
    expect((await r.resolve("c1")).apiKey).toBe("key-1");
    advance(59_000);
    expect((await r.resolve("c1")).apiKey).toBe("key-1");
    advance(2_000);
    expect((await r.resolve("c1")).apiKey).toBe("key-2");
    expect(lookups).toHaveLength(2);
  });
  it("looks the key up again when invalidated or when the secret reference changes", async () => {
    const { r, lookups } = resolver(config);
    await r.resolve("c1");
    r.invalidate("c1");
    await r.resolve("c1");
    config.decisionsApiKey = { ...KEY, version: 2 } as never;
    await r.resolve("c1");
    expect(lookups).toHaveLength(3);
  });
  it("looks a cold key up once for any number of callers at the same time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lookups: unknown[] = [];
    const r = new ProviderResolver({ getConfig: async () => config, resolveSecret: async (ref) => { lookups.push(ref); await gate; return "key-1"; } });
    const pending = Array.from({ length: 8 }, () => r.resolve("c1"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    expect((await Promise.all(pending)).map((target) => target.apiKey)).toEqual(Array(8).fill("key-1"));
    expect(lookups).toHaveLength(1);
    // Each company still has its own lookup.
    await r.resolve("c2");
    expect(lookups).toHaveLength(2);
  });
  it("never lets a lookup started before a config change fill the cache after it", async () => {
    const releases: Array<() => void> = [];
    let n = 0;
    const r = new ProviderResolver({
      getConfig: async () => config,
      resolveSecret: async () => { n += 1; const value = `key-${n}`; await new Promise<void>((resolve) => releases.push(resolve)); return value; },
    });
    const before = r.resolve("c1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    r.invalidate("c1");
    releases[0]!();
    expect((await before).apiKey).toBe("key-1");
    // The old lookup's key was not cached: the next caller looks the key up again.
    const after = r.resolve("c1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releases).toHaveLength(2);
    releases[1]!();
    expect((await after).apiKey).toBe("key-2");
    expect((await r.resolve("c1")).apiKey).toBe("key-2");
    expect(n).toBe(2);
    // Invalidating every company works the same way.
    r.invalidate();
    const third = r.resolve("c1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    releases[2]!();
    expect((await third).apiKey).toBe("key-3");
  });
  it("does not cache a failed lookup", async () => {
    let fail = true;
    let n = 0;
    const r = new ProviderResolver({ getConfig: async () => config, resolveSecret: async () => { n += 1; if (fail) throw new Error("secrets offline"); return "key-ok"; } });
    const failed = await Promise.all([r.resolve("c1"), r.resolve("c1")].map((p) => p.catch((error: unknown) => error)));
    expect(failed.map((error) => (error as DataError).code)).toEqual(["disabled", "disabled"]);
    expect(n).toBe(1);
    fail = false;
    expect((await r.resolve("c1")).apiKey).toBe("key-ok");
    expect(n).toBe(2);
  });
  it("answers disabled when no provider is set or the secret cannot be read", async () => {
    await expect(resolver({}).r.resolve("c1")).rejects.toMatchObject({ code: "disabled" });
    const broken = new ProviderResolver({ getConfig: async () => config, resolveSecret: async () => { throw new Error("binding_missing sk-123"); } });
    const error = await broken.resolve("c1").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "disabled" });
    expect(String((error as Error).message)).not.toContain("sk-123");
  });
});

describe("manifest", () => {
  it("declares the provider config with a secret-ref key and the two capabilities", () => {
    expect(manifest.instanceConfigSchema).toMatchObject({ type: "object", properties: DECISIONS_CONFIG_SCHEMA.properties });
    expect(DECISIONS_CONFIG_SCHEMA.properties.decisionsApiKey).toEqual({ type: ["string", "object"], format: "secret-ref", title: "Typed decisions: API key", description: "A company secret holding the provider's API key." });
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["http.outbound", "secrets.read-ref"]));
  });
  it("never declares a capability that answers cards or approvals", () => {
    expect(manifest.capabilities).not.toContain("issue.interactions.respond");
    expect(manifest.capabilities).not.toContain("approvals.respond");
  });
});
