import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getConnectionGrant, listConnectionGrants, setConnectionGrant, type ConnectionAccess } from "../../src/connections/grants.js";
import { ensureCompany, resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

const C = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/connection-grants.spec.ts", "src/db/migrate.ts")));
  await ensureCompany(db.pool, C);
  await ensureCompany(db.pool, OTHER);
});
afterAll(async () => { await db.close(); });

describe("connection grants", () => {
  it("defaults to none, sets read then read-write, and none deletes the row", async () => {
    expect(await getConnectionGrant(db.pool, C, "agent-1", "crm")).toBe("none");
    await setConnectionGrant(db.pool, C, "agent-1", "crm", "read", "user-1");
    expect(await getConnectionGrant(db.pool, C, "agent-1", "crm")).toBe("read");
    await setConnectionGrant(db.pool, C, "agent-1", "crm", "read-write", "user-2");
    expect(await getConnectionGrant(db.pool, C, "agent-1", "crm")).toBe("read-write");
    expect(await listConnectionGrants(db.pool, C)).toMatchObject([{ agentId: "agent-1", connection: "crm", access: "read-write", updatedBy: "user-2" }]);
    await setConnectionGrant(db.pool, C, "agent-1", "crm", "none", "user-2");
    expect(await getConnectionGrant(db.pool, C, "agent-1", "crm")).toBe("none");
    expect(await listConnectionGrants(db.pool, C)).toEqual([]);
  });

  it("lists by agent then connection and hides other companies", async () => {
    await setConnectionGrant(db.pool, C, "b-agent", "z", "read", null);
    await setConnectionGrant(db.pool, C, "a-agent", "y", "read", null);
    await setConnectionGrant(db.pool, C, "a-agent", "x", "read-write", null);
    await setConnectionGrant(db.pool, OTHER, "a-agent", "w", "read", null);
    const list = await listConnectionGrants(db.pool, C);
    expect(list.map((g) => `${g.agentId}/${g.connection}`)).toEqual(["a-agent/x", "a-agent/y", "b-agent/z"]);
    expect(list[0]!.updatedBy).toBeNull();
    expect(await getConnectionGrant(db.pool, OTHER, "a-agent", "x")).toBe("none");
  });

  it("rejects an unknown access value and never returns an unexpected stored one", async () => {
    await expect(setConnectionGrant(db.pool, C, "agent-1", "crm", "admin" as ConnectionAccess, null)).rejects.toMatchObject({ code: "invalid" });
    await db.pool.query("ALTER TABLE kyoube_meta.connection_grants DROP CONSTRAINT connection_grants_access_check");
    try {
      await db.pool.query("INSERT INTO kyoube_meta.connection_grants (company_id, agent_id, connection_name, access) VALUES ($1, 'bad', 'c', 'owner')", [C]);
      expect(await getConnectionGrant(db.pool, C, "bad", "c")).toBe("none");
      expect((await listConnectionGrants(db.pool, C)).some((g) => g.agentId === "bad")).toBe(false);
    } finally {
      await db.pool.query("DELETE FROM kyoube_meta.connection_grants WHERE agent_id = 'bad'");
      await db.pool.query("ALTER TABLE kyoube_meta.connection_grants ADD CONSTRAINT connection_grants_access_check CHECK (access IN ('read', 'read-write'))");
    }
  });
});
