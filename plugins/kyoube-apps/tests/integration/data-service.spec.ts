import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataService, systemActor, type MutationEvent } from "../../src/data/service.js";
import { resetCompanyCache, roleNameFor, schemaNameFor } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

const C = "66666666-6666-4666-8666-666666666666";
const OWNER = { kind: "user" as const, id: "owner-1" };
const VIEWER = { kind: "user" as const, id: "viewer-1" };
const AGENT = { kind: "agent" as const, id: "agent-1", runId: "run-1" };
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let service: DataService;
const mutations: MutationEvent[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/data-service.spec.ts", "src/db/migrate.ts")));
  service = new DataService({
    pool: db.pool,
    resolveUserRole: async (_companyId, userId) => (userId === "owner-1" ? "owner" : userId === "viewer-1" ? "viewer" : null),
    onMutation: async (event) => { mutations.push(event); },
  });
});
afterAll(async () => { await db.close(); });

describe("DataService", () => {
  it("maps users to levels from their company role and agents from grants", async () => {
    expect(await service.levelFor(C, OWNER)).toBe("schema");
    expect(await service.levelFor(C, VIEWER)).toBe("read");
    expect(await service.levelFor(C, { kind: "user", id: "stranger" })).toBe("none");
    expect(await service.levelFor(C, AGENT)).toBe("none");
    expect((await service.myAccess(C, AGENT)).hint).toContain("ask a company admin");
    expect(await service.levelFor(C, systemActor())).toBe("schema");
    expect(await service.levelFor(C, { kind: "user", id: null })).toBe("none");
  });

  it("enforces levels on schema, write, and read operations", async () => {
    await expect(service.createTable(C, AGENT, { name: "contacts", fields: [] })).rejects.toThrow("forbidden");
    await expect(service.createTable(C, VIEWER, { name: "contacts", fields: [] })).rejects.toThrow("forbidden");
    const table = await service.createTable(C, OWNER, { name: "contacts", fields: [{ name: "name", kind: "text", required: true }] });
    expect(table.name).toBe("contacts");
    await expect(service.insert(C, VIEWER, "contacts", [{ name: "x" }])).rejects.toThrow("forbidden");
    await service.setAgentGrant(C, OWNER, "agent-1", "write");
    const rows = await service.insert(C, AGENT, "contacts", [{ name: "Ada" }]);
    expect(rows[0]).toMatchObject({ name: "Ada", created_by_kind: "agent", created_by_id: "agent-1" });
    expect((await service.query(C, VIEWER, "contacts", {})).rows).toHaveLength(1);
    await expect(service.addField(C, AGENT, "contacts", { name: "email", kind: "email" })).rejects.toThrow("forbidden");
    await service.setAgentGrant(C, OWNER, "agent-1", "schema");
    expect((await service.addField(C, AGENT, "contacts", { name: "email", kind: "email" })).fields).toHaveLength(2);
  });

  it("only admins manage grants and settings", async () => {
    await expect(service.listAgentGrants(C, VIEWER)).rejects.toThrow("forbidden");
    await expect(service.setAgentGrant(C, AGENT, "agent-2", "read")).rejects.toThrow("forbidden");
    expect(await service.getSettings(C, OWNER)).toEqual({ defaultAgentLevel: "none", hardDelete: false });
    await service.setSettings(C, OWNER, { defaultAgentLevel: "read" });
    expect(await service.levelFor(C, { kind: "agent", id: "agent-new" })).toBe("read");
  });

  it("audits mutations in kyoube_meta and via the callback, soft-drops by default, hard-drops when configured", async () => {
    await service.dropTable(C, OWNER, "contacts");
    const trashed = await db.pool.query("SELECT status FROM kyoube_meta.tables WHERE company_id = $1 AND name = 'contacts'", [C]);
    expect(trashed.rows[0]).toEqual({ status: "trashed" });
    await service.setSettings(C, OWNER, { hardDelete: true });
    await service.createTable(C, OWNER, { name: "temp", fields: [] });
    await service.dropTable(C, OWNER, "temp");
    expect((await db.pool.query("SELECT 1 FROM kyoube_meta.tables WHERE company_id = $1 AND name = 'temp'", [C])).rowCount).toBe(0);
    const audit = await db.pool.query<{ operation: string; actor_kind: string }>("SELECT operation, actor_kind FROM kyoube_meta.audit WHERE company_id = $1 ORDER BY id", [C]);
    expect(audit.rows.map((row) => row.operation)).toEqual(expect.arrayContaining(["create_table", "insert", "add_field", "set_agent_grant", "set_settings", "drop_table"]));
    expect(mutations.some((event) => event.operation === "insert" && event.actor.kind === "agent" && !event.summary.includes("Ada"))).toBe(true);
  });

  it("writes exactly one audit row per mutation, inside the mutation's own transaction (P4-R12)", async () => {
    mutations.length = 0;
    await service.createTable(C, OWNER, { name: "audited", fields: [{ name: "name", kind: "text", required: true }] });
    const rows = await service.insert(C, OWNER, "audited", [{ name: "Ada" }, { name: "Grace" }]);
    const audit = await db.pool.query<{ operation: string; details: Record<string, unknown> }>(
      "SELECT operation, details FROM kyoube_meta.audit WHERE company_id = $1 AND table_name = 'audited' ORDER BY id",
      [C],
    );
    expect(audit.rows.map((row) => row.operation)).toEqual(["create_table", "insert"]);
    expect(audit.rows[1]!.details).toEqual({ count: 2, ids: rows.map((row) => row.id) });
    // The summariser is a post-commit subscriber, so it still fires — and still carries no row values.
    expect(mutations.map((event) => event.operation)).toEqual(["create_table", "insert"]);
    expect(mutations.some((event) => event.summary.includes("Ada"))).toBe(false);
  });

  it("leaves no row change behind when the audit insert fails", async () => {
    // Blocks the audit insert alone: the rows are written first, so the insert only rolls back
    // if the audit row really is part of the same transaction.
    // NOT VALID so the constraint applies to new rows only: earlier tests already audited inserts.
    await db.pool.query("ALTER TABLE kyoube_meta.audit ADD CONSTRAINT audit_block_test CHECK (operation <> 'insert') NOT VALID");
    try {
      await expect(service.insert(C, OWNER, "audited", [{ name: "Hopper" }])).rejects.toThrow();
      const rows = await service.query(C, OWNER, "audited", { where: { field: "name", op: "eq", value: "Hopper" } });
      expect(rows.rows).toEqual([]);
    } finally {
      await db.pool.query("ALTER TABLE kyoube_meta.audit DROP CONSTRAINT audit_block_test");
    }
  });

  it("resolves the role freshly for schema and admin operations, and from the cache for reads and row writes (P4-R13)", async () => {
    const asked: boolean[] = [];
    // The cached answer is stale (still "owner"); a fresh lookup sees the demotion to "viewer".
    const demoted = new DataService({
      pool: db.pool,
      resolveUserRole: async (_companyId, _userId, fresh) => { asked.push(fresh); return fresh ? "viewer" : "owner"; },
    });
    await expect(demoted.createTable(C, OWNER, { name: "late", fields: [] })).rejects.toThrow("forbidden");
    await expect(demoted.dropTable(C, OWNER, "audited")).rejects.toThrow("forbidden");
    await expect(demoted.setAgentGrant(C, OWNER, "agent-9", "read")).rejects.toThrow("forbidden");
    expect(asked).toEqual([true, true, true]);
    // Reads and row writes keep the 30 s cache, which still says owner.
    asked.length = 0;
    expect((await demoted.query(C, OWNER, "audited", {})).rows.length).toBeGreaterThan(0);
    await demoted.insert(C, OWNER, "audited", [{ name: "Cached" }]);
    expect(asked).toEqual([false, false]);
  });

  it("denies an actor at none before provisioning anything for the company (P4-R17)", async () => {
    const UNTOUCHED = "77777777-7777-4777-8777-777777777777";
    const schemaName = schemaNameFor(UNTOUCHED);
    await expect(service.listTables(UNTOUCHED, { kind: "user", id: "stranger" })).rejects.toThrow("forbidden");
    await expect(service.insert(UNTOUCHED, AGENT, "anything", [{}])).rejects.toThrow("forbidden");
    await expect(service.createTable(UNTOUCHED, VIEWER, { name: "x", fields: [] })).rejects.toThrow("forbidden");
    await expect(service.setSettings(UNTOUCHED, VIEWER, { hardDelete: true })).rejects.toThrow("forbidden");
    expect(await service.levelFor(UNTOUCHED, { kind: "user", id: "stranger" })).toBe("none");
    // Nothing was created: no schema, no role, no kyoube_meta row.
    expect((await db.pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [schemaName])).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roleNameFor(UNTOUCHED)])).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM kyoube_meta.companies WHERE company_id = $1", [UNTOUCHED])).rowCount).toBe(0);
    // A non-uuid company is still refused as "invalid" without provisioning either.
    await expect(service.listTables("not-a-uuid", OWNER)).rejects.toThrow("is not a uuid");
    // An authorised caller still provisions on demand.
    await service.createTable(UNTOUCHED, OWNER, { name: "welcome", fields: [] });
    expect((await db.pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [schemaName])).rowCount).toBe(1);
  });

  it("records the app a row mutation was made through, without changing the actor (P4-R21)", async () => {
    const via = { app: "crm", version: 3 };
    const [row] = await service.insert(C, OWNER, "audited", [{ name: "Via" }], via);
    await service.update(C, OWNER, "audited", { ids: [String(row!.id)] }, { name: "Via 2" }, via);
    await service.delete(C, OWNER, "audited", { ids: [String(row!.id)] }, via);
    const audit = await db.pool.query<{ operation: string; actor_kind: string; actor_id: string; details: { via?: unknown } }>(
      "SELECT operation, actor_kind, actor_id, details FROM kyoube_meta.audit WHERE company_id = $1 AND details ? 'via' ORDER BY id",
      [C],
    );
    expect(audit.rows.map((entry) => entry.operation)).toEqual(["insert", "update", "delete"]);
    for (const entry of audit.rows) {
      expect(entry.details.via).toEqual({ app: "crm", version: 3 });
      // The actor stays the viewer: an app never becomes the actor of what it does for someone.
      expect(entry).toMatchObject({ actor_kind: "user", actor_id: "owner-1" });
    }
    // Only the two known fields travel, whatever else a caller's object holds.
    const [extra] = await service.insert(C, OWNER, "audited", [{ name: "Extra" }], { app: "crm", version: 4, secret: "x" } as never);
    const details = await db.pool.query<{ details: { via?: unknown } }>(
      "SELECT details FROM kyoube_meta.audit WHERE company_id = $1 AND operation = 'insert' AND details -> 'ids' ? $2",
      [C, String(extra!.id)],
    );
    expect(details.rows[0]!.details.via).toEqual({ app: "crm", version: 4 });
  });

  it("isolates a throwing onMutation subscriber from the caller and reports it via onMutationError", async () => {
    const captured: Array<{ error: unknown; event: MutationEvent }> = [];
    const failingService = new DataService({
      pool: db.pool,
      resolveUserRole: async (_companyId, userId) => (userId === "owner-1" ? "owner" : null),
      onMutation: async () => { throw new Error("subscriber boom"); },
      onMutationError: (error, event) => { captured.push({ error, event }); },
    });
    await failingService.createTable(C, OWNER, { name: "widgets", fields: [{ name: "name", kind: "text", required: true }] });
    const [row] = await failingService.insert(C, OWNER, "widgets", [{ name: "gizmo" }]);
    expect(row).toMatchObject({ name: "gizmo" });
    const audited = await db.pool.query("SELECT 1 FROM kyoube_meta.audit WHERE company_id = $1 AND operation = 'insert' AND table_name = 'widgets'", [C]);
    expect(audited.rowCount).toBe(1);
    const insertFailure = captured.find((entry) => entry.event.operation === "insert" && entry.event.table === "widgets");
    expect(insertFailure?.error).toBeInstanceOf(Error);
    expect((insertFailure?.error as Error).message).toBe("subscriber boom");
  });
});
