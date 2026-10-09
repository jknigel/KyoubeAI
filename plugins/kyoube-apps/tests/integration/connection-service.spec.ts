import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setConnectionGrant } from "../../src/connections/grants.js";
import { ConnectionService } from "../../src/connections/service.js";
import { ensureCompany, resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import type { DataActor } from "../../src/data/permissions.js";
import { SecretCache } from "../../src/secrets/cache.js";
import { createTestDatabase } from "./setup.js";

const C = "66666666-6666-4666-8666-666666666666";
const SECRET = "sk_live_INTEGRATION";
const REF = { type: "secret_ref", secretId: "s-crm", version: "latest" };
const CONFIG = { connections: [{ name: "crm", baseUrl: "https://api.crm.example/v1/", auth: "bearer", secret: REF, methods: "read-write" }] };
const AGENT: DataActor = { kind: "agent", id: "agent-1", runId: "run-9" };
const OWNER: DataActor = { kind: "user", id: "owner-1", runId: null };

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let service: ConnectionService;
const sent: Array<{ url: string; init: { method: string; headers: Record<string, string>; body?: string } }> = [];

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/connection-service.spec.ts", "src/db/migrate.ts")));
  await ensureCompany(db.pool, C);
  service = new ConnectionService({
    pool: db.pool,
    getConfig: async () => CONFIG,
    secrets: new SecretCache({ resolve: async () => SECRET }),
    fetch: async (url, init) => {
      sent.push({ url, init });
      return new Response('{"id":"c_1"}', { status: 201, headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` } });
    },
    // Agents read company data (listing connections needs it); people here have no level.
    levelFor: async (_companyId, actor) => (actor.kind === "agent" ? "read" : "none"),
    resolveUserRole: async (_companyId, userId) => (userId === OWNER.id ? "owner" : null),
  });
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  sent.length = 0;
  await db.pool.query("DELETE FROM kyoube_meta.audit");
  await db.pool.query("DELETE FROM kyoube_meta.connection_grants");
});

async function auditRows() {
  const result = await db.pool.query<{ actor_kind: string; actor_id: string; run_id: string | null; operation: string; table_name: string | null; details: Record<string, unknown> }>(
    "SELECT actor_kind, actor_id, run_id, operation, table_name, details FROM kyoube_meta.audit WHERE company_id = $1 ORDER BY id",
    [C],
  );
  return result.rows;
}

describe("ConnectionService against Postgres", () => {
  it("calls with a real grant and writes one audit row without query values, body or secret", async () => {
    await setConnectionGrant(db.pool, C, "agent-1", "crm", "read-write", "owner-1");
    const result = await service.call(C, AGENT, "crm", { method: "POST", path: "contacts", query: { email: "ada@example.com" }, body: { note: "BODYVALUE" } }, { kind: "direct" });
    expect(result).toEqual({ status: 201, headers: { "content-type": "application/json" }, body: '{"id":"c_1"}' });
    expect(sent[0]!.init.headers.authorization).toBe(`Bearer ${SECRET}`);
    const rows = (await auditRows()).filter((row) => row.operation === "connection_call");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_kind: "agent", actor_id: "agent-1", run_id: "run-9", table_name: null });
    expect(rows[0]!.details).toEqual({ connection: "crm", method: "POST", path: "contacts", status: 201, ms: expect.any(Number), bytes: 12, via: "agent" });
    const text = JSON.stringify(rows);
    for (const leak of ["ada@example.com", "email", "BODYVALUE", SECRET]) expect(text).not.toContain(leak);
  });

  it("refuses an agent without a grant and records the refusal", async () => {
    await expect(service.call(C, AGENT, "crm", { path: "contacts" }, { kind: "direct" })).rejects.toMatchObject({ code: "forbidden" });
    expect(sent).toHaveLength(0);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toEqual({ connection: "crm", method: "GET", path: "contacts", status: null, ms: null, bytes: null, via: "agent", outcome: "forbidden" });
  });

  it("enforces a read grant from the table: GET goes, POST is refused", async () => {
    await setConnectionGrant(db.pool, C, "agent-1", "crm", "read", "owner-1");
    expect((await service.call(C, AGENT, "crm", { path: "contacts" }, { kind: "direct" })).status).toBe(201);
    await expect(service.call(C, AGENT, "crm", { method: "POST", path: "contacts" }, { kind: "direct" })).rejects.toMatchObject({ code: "forbidden" });
    expect(sent).toHaveLength(1);
    expect((await auditRows()).map((row) => row.details.outcome ?? "ok")).toEqual(["ok", "forbidden"]);
  });

  it("lets an owner set and remove grants, audited, and the agent's access follows", async () => {
    await service.setGrant(C, OWNER, "agent-1", "crm", "read-write");
    expect(await service.listGrants(C, OWNER)).toMatchObject([{ agentId: "agent-1", connection: "crm", access: "read-write", updatedBy: "owner-1" }]);
    expect((await service.list(C, AGENT)).map((c) => c.access)).toEqual(["read-write"]);
    await service.setGrant(C, OWNER, "agent-1", "crm", "none");
    expect(await service.listGrants(C, OWNER)).toEqual([]);
    expect((await service.list(C, AGENT)).map((c) => c.access)).toEqual(["none"]);
    const rows = await auditRows();
    expect(rows.map((row) => [row.operation, row.details])).toEqual([
      ["set_connection_grant", { agentId: "agent-1", connection: "crm", access: "read-write" }],
      ["set_connection_grant", { agentId: "agent-1", connection: "crm", access: "none" }],
    ]);
  });
});
