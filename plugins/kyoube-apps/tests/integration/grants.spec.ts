import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAudit, withMeta } from "../../src/data/audit.js";
import { getAgentLevel, getCompanySettings, listAgentGrants, setAgentGrant, setCompanySettings } from "../../src/data/grants.js";
import { ensureCompany, resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

const C = "33333333-3333-4333-8333-333333333333";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/grants.spec.ts", "src/db/migrate.ts")));
  await ensureCompany(db.pool, C);
});
afterAll(async () => { await db.close(); });

describe("grants and settings", () => {
  it("defaults agents to the company default level and honours explicit grants", async () => {
    expect(await getCompanySettings(db.pool, C)).toEqual({ defaultAgentLevel: "none", hardDelete: false });
    expect(await getAgentLevel(db.pool, C, "agent-1")).toBe("none");
    await setCompanySettings(db.pool, C, { defaultAgentLevel: "read" });
    expect(await getAgentLevel(db.pool, C, "agent-1")).toBe("read");
    const grant = await setAgentGrant(db.pool, C, "agent-1", "schema", "user-9");
    expect(grant).toMatchObject({ agentId: "agent-1", level: "schema", updatedBy: "user-9" });
    expect(await getAgentLevel(db.pool, C, "agent-1")).toBe("schema");
    expect(await listAgentGrants(db.pool, C)).toHaveLength(1);
    await setAgentGrant(db.pool, C, "agent-1", "none", "user-9");
    expect(await getAgentLevel(db.pool, C, "agent-1")).toBe("none");

    expect(await setCompanySettings(db.pool, C, { hardDelete: true })).toEqual({ defaultAgentLevel: "read", hardDelete: true });
    expect(await setCompanySettings(db.pool, C, { defaultAgentLevel: "write" })).toEqual({ defaultAgentLevel: "write", hardDelete: true });

    await setAgentGrant(db.pool, C, "agent-2", "read", "user-9");
    const grants = await listAgentGrants(db.pool, C);
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => g.agentId)).toEqual(["agent-2", "agent-1"]);
  });
  // Ruling P4-R28: a kyoube_meta change runs under the same 10 s ceiling as a
  // company-scoped one (`withCompany`). The timeout is set before the caller's
  // own statements — which is what `fn` observing it proves — so a statement
  // that hangs inside the transaction is cut off rather than holding a pooled
  // client and the rows it has locked open indefinitely.
  it("runs a meta change under a 10 s statement timeout", async () => {
    const seen = await withMeta(db.pool, async (client) => (await client.query<{ value: string }>("SELECT current_setting('statement_timeout') AS value")).rows[0]!.value);
    expect(seen).toBe("10s");
    // SET LOCAL, so it goes with the transaction rather than sticking to the
    // pooled client and silently capping every later query on it.
    const after = await db.pool.query<{ value: string }>("SELECT current_setting('statement_timeout') AS value");
    expect(after.rows[0]!.value).not.toBe("10s");
  });

  // `recordAudit` takes the transaction's own client, never a pool (ruling
  // P4-R12): every audit row commits with the change it records.
  it("records audit rows", async () => {
    const client = await db.pool.connect();
    try {
      await recordAudit(client, { companyId: C, actor: { kind: "agent", id: "agent-1", runId: "run-1" }, operation: "create_table", table: "contacts", details: { fields: 3 } });
    } finally {
      client.release();
    }
    const rows = await db.pool.query("SELECT actor_kind, actor_id, run_id, operation, table_name, details FROM kyoube_meta.audit WHERE company_id = $1", [C]);
    expect(rows.rows).toEqual([{ actor_kind: "agent", actor_id: "agent-1", run_id: "run-1", operation: "create_table", table_name: "contacts", details: { fields: 3 } }]);
  });
});
