import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { AppServiceDeps } from "../../src/apps/service.js";
import type { ConnectionServiceDeps } from "../../src/connections/service.js";
import type { DecisionServiceDeps } from "../../src/decisions/service.js";
import manifest from "../../src/manifest.js";
import { createAppsPlugin } from "../../src/plugin.js";
import { SecretCache } from "../../src/secrets/cache.js";
import { createStubService } from "../stub-service.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const KYOUBE_CONFIG = { home: "/kyoubeai", hermesHome: "/kyoubeai/.hermes", dataDatabaseUrl: "postgres://x", publicUrl: "http://localhost:3100", paperclipApiUrl: "http://127.0.0.1:3100" };
const REF = { type: "secret_ref", secretId: "22222222-2222-4222-8222-222222222222", version: "latest" };

async function setup() {
  const harness = createTestHarness({ manifest });
  const data = createStubService();
  const invalidated: Array<string | null | undefined> = [];
  let connectionDeps: ConnectionServiceDeps | null = null;
  let appDeps: AppServiceDeps | null = null;
  let decisionDeps: DecisionServiceDeps | null = null;
  const plugin = createAppsPlugin({
    loadKyoubeConfig: async () => KYOUBE_CONFIG,
    migrationsDir: "/nowhere",
    createPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }), end: async () => {} }) as never,
    migrate: async () => [],
    createService: () => data.service,
    createAppService: (deps) => { appDeps = deps; return createStubService().service as never; },
    createDecisionService: (deps) => { decisionDeps = deps; return createStubService().service as never; },
    createConnectionService: (deps) => { connectionDeps = deps; return { invalidate: (companyId?: string | null) => { invalidated.push(companyId); } } as never; },
  });
  await plugin.definition.setup(harness.ctx);
  return { harness, plugin, data, invalidated, deps: () => connectionDeps!, appDeps: () => appDeps!, decisionDeps: () => decisionDeps! };
}

describe("plugin wiring for connections", () => {
  it("hands the connection service the same guard as the other services", async () => {
    const { deps, appDeps } = await setup();
    expect(typeof deps().guardAgentAction).toBe("function");
    expect(deps().guardAgentAction).toBe(appDeps().guardAgentAction);
  });

  it("shares the plugin's one secret cache, which a config change drops", async () => {
    const { harness, plugin, deps, decisionDeps, invalidated } = await setup();
    expect(deps().secrets).toBeInstanceOf(SecretCache);
    expect((decisionDeps().providers as unknown as { cache: SecretCache }).cache).toBe(deps().secrets);
    let lookups = 0;
    harness.ctx.secrets.resolve = (async () => { lookups += 1; return "value"; }) as never;
    await deps().secrets.get(COMPANY, "connection:crm", REF, "connections.0.secret");
    await deps().secrets.get(COMPANY, "connection:crm", REF, "connections.0.secret");
    expect(lookups).toBe(1);
    await plugin.definition.onConfigChanged!({}, { companyId: COMPANY });
    expect(invalidated).toEqual([COMPANY]);
    await deps().secrets.get(COMPANY, "connection:crm", REF, "connections.0.secret");
    expect(lookups).toBe(2);
  });

  it("calls out through ctx.http.fetch and reads levels from the data service", async () => {
    const { harness, deps, data } = await setup();
    const seen: string[] = [];
    harness.ctx.http.fetch = (async (url: string) => { seen.push(url); return new Response("{}", { status: 200 }); }) as never;
    await deps().fetch("https://api.example/v1/x", { method: "GET", headers: {} });
    expect(seen).toEqual(["https://api.example/v1/x"]);
    await deps().levelFor(COMPANY, { kind: "user", id: "u1" });
    expect(data.calls.find((call) => call.method === "levelFor")?.args).toEqual([COMPANY, { kind: "user", id: "u1" }]);
  });

  it("writes an agent's call summary to the activity log, and never throws when that fails", async () => {
    const { harness, deps } = await setup();
    await deps().onActivity!({ companyId: COMPANY, actor: { kind: "agent", id: "a1", runId: "r1" }, summary: "connection crm: GET contacts → 200", connection: "crm" });
    expect(harness.activity.at(-1)).toMatchObject({
      message: "Kyoube connections: connection crm: GET contacts → 200",
      entityType: "kyoube_connection",
      entityId: "crm",
      metadata: { actorKind: "agent", actorId: "a1", runId: "r1" },
    });
    harness.ctx.activity.log = (async () => { throw new Error("down"); }) as never;
    await expect(deps().onActivity!({ companyId: COMPANY, actor: { kind: "agent", id: "a1" }, summary: "x", connection: "crm" })).resolves.toBeUndefined();
  });
});
