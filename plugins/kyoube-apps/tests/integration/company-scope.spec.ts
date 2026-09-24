import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureCompany, resetCompanyCache, roleNameFor, schemaNameFor, withCompany } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
let db: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/company-scope.spec.ts", "src/db/migrate.ts")));
});
afterAll(async () => { await db.close(); });

describe("company scope", () => {
  it("derives deterministic names and rejects non-uuids", () => {
    expect(schemaNameFor(A)).toBe("c_11111111111141118111111111111111");
    expect(roleNameFor(A)).toBe("kyoube_c_11111111111141118111111111111111");
    expect(() => schemaNameFor("nope")).toThrow("invalid");
  });

  it("provisions schema, role, and meta row idempotently", async () => {
    const first = await ensureCompany(db.pool, A);
    const second = await ensureCompany(db.pool, A);
    expect(second).toEqual(first);
    const schema = await db.pool.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1", [first.schema]);
    expect(schema.rowCount).toBe(1);
    const role = await db.pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [first.role]);
    expect(role.rowCount).toBe(1);
    const meta = await db.pool.query("SELECT company_id FROM kyoube_meta.companies WHERE company_id = $1", [A]);
    expect(meta.rowCount).toBe(1);
  });

  it("rejects a withCompany scope whose role/schema doesn't match its companyId, without touching the pool", async () => {
    const a = await ensureCompany(db.pool, A);
    const connectSpy = vi.spyOn(db.pool, "connect");
    try {
      await expect(
        withCompany(db.pool, { ...a, role: "kyoube_c_evil" }, async () => {}),
      ).rejects.toThrow("invalid");
      expect(connectSpy).not.toHaveBeenCalled();
    } finally {
      connectSpy.mockRestore();
    }
  });

  it("runs DDL/DML as the company role inside its schema, and isolates companies", async () => {
    const a = await ensureCompany(db.pool, A);
    const b = await ensureCompany(db.pool, B);
    await withCompany(db.pool, a, async ({ client }) => {
      await client.query('CREATE TABLE "notes" (id serial PRIMARY KEY, body text)');
      await client.query('INSERT INTO "notes" (body) VALUES ($1)', ["secret of A"]);
    });
    const own = await withCompany(db.pool, a, async ({ client }) => (await client.query('SELECT body FROM "notes"')).rows);
    expect(own).toEqual([{ body: "secret of A" }]);
    await expect(
      withCompany(db.pool, b, async ({ client }) => client.query(`SELECT body FROM ${a.schema}."notes"`)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withCompany(db.pool, b, async ({ client }) => client.query('SELECT body FROM "notes"')),
    ).rejects.toThrow(/does not exist/);
  });

  it("denies the company role read access to kyoube_meta", async () => {
    const a = await ensureCompany(db.pool, A);
    await expect(
      withCompany(db.pool, a, async ({ client }) => client.query("SELECT 1 FROM kyoube_meta.companies")),
    ).rejects.toThrow(/permission denied/);
  });

  it("supports read-only transactions, statement timeouts, and owner switches", async () => {
    const a = await ensureCompany(db.pool, A);
    await expect(
      withCompany(db.pool, a, async ({ client }) => client.query('INSERT INTO "notes" (body) VALUES ($1)', ["x"]), { readOnly: true }),
    ).rejects.toThrow(/read-only/);
    await expect(
      withCompany(db.pool, a, async ({ client }) => client.query("SELECT pg_sleep(1)"), { statementTimeoutMs: 100 }),
    ).rejects.toThrow(/statement timeout/);
    await withCompany(db.pool, a, async ({ client, asOwner, asCompany }) => {
      await asOwner();
      await client.query("INSERT INTO kyoube_meta.audit (company_id, actor_kind, operation) VALUES ($1, 'system', 'test')", [A]);
      await asCompany();
      await client.query('SELECT 1 FROM "notes"');
    });
    const audit = await db.pool.query("SELECT operation FROM kyoube_meta.audit WHERE company_id = $1", [A]);
    expect(audit.rows).toEqual([{ operation: "test" }]);
  });

  it("commits an audit payload on the same transaction, as the login role (P4-R12)", async () => {
    const a = await ensureCompany(db.pool, A);
    await withCompany(db.pool, a, async ({ client }) => {
      await client.query('INSERT INTO "notes" (body) VALUES ($1)', ["audited"]);
      return 7;
    }, { audit: (result) => ({ companyId: A, actor: { kind: "system", id: null, runId: null }, operation: "scoped_test", table: "notes", details: { result } }) });
    const audit = await db.pool.query<{ operation: string; details: { result: number } }>(
      "SELECT operation, details FROM kyoube_meta.audit WHERE company_id = $1 AND operation = 'scoped_test'",
      [A],
    );
    expect(audit.rows).toEqual([{ operation: "scoped_test", details: { result: 7 } }]);
    const note = await withCompany(db.pool, a, async ({ client }) => (await client.query('SELECT body FROM "notes" WHERE body = $1', ["audited"])).rows);
    expect(note).toEqual([{ body: "audited" }]);
    // Leaves the schema as it found it, for the row counts the tests below assert.
    await withCompany(db.pool, a, async ({ client }) => { await client.query('DELETE FROM "notes" WHERE body = $1', ["audited"]); });
  });

  it("rolls the whole transaction back when the audit insert fails, and still releases the client", async () => {
    const a = await ensureCompany(db.pool, A);
    const before = (await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM kyoube_meta.audit')).rows[0]!.n;
    // More attempts than the pool has connections (max 4): if a failing audit insert leaked its
    // client, the last attempts would hang rather than fail.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(
        withCompany(db.pool, a, async ({ client }) => {
          await client.query('INSERT INTO "notes" (body) VALUES ($1)', ["never committed"]);
        }, {
          // operation is NOT NULL: a test-only invalid payload, failing the audit insert alone.
          audit: () => ({ companyId: A, actor: { kind: "system", id: null, runId: null }, operation: null as unknown as string, table: null, details: null }),
        }),
      ).rejects.toThrow(/null value in column "operation"|violates not-null/);
    }
    const notes = await withCompany(db.pool, a, async ({ client }) => (await client.query<{ body: string }>('SELECT body FROM "notes" WHERE body = $1', ["never committed"])).rows);
    expect(notes).toEqual([]);
    expect((await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM kyoube_meta.audit')).rows[0]!.n).toBe(before);
  });

  it("refuses an audit payload on a read-only transaction", async () => {
    const a = await ensureCompany(db.pool, A);
    await expect(
      withCompany(db.pool, a, async () => {}, { readOnly: true, audit: () => ({ companyId: A, actor: { kind: "system", id: null, runId: null }, operation: "nope" }) }),
    ).rejects.toThrow("invalid");
  });

  it("rolls back on error", async () => {
    const a = await ensureCompany(db.pool, A);
    await expect(
      withCompany(db.pool, a, async ({ client }) => {
        await client.query('INSERT INTO "notes" (body) VALUES ($1)', ["rolled back"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rows = await withCompany(db.pool, a, async ({ client }) => (await client.query('SELECT count(*)::int AS n FROM "notes"')).rows);
    expect(rows).toEqual([{ n: 1 }]);
  });
});
