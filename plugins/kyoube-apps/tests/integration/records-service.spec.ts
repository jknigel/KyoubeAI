import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RecordsService } from "../../src/data/records-service.js";
import { SchemaService } from "../../src/data/schema-service.js";
import { ensureCompany, resetCompanyCache, type CompanyScope } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

const C = "55555555-5555-4555-8555-555555555555";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let scope: CompanyScope;
let schema: SchemaService;
let records: RecordsService;
const by = { kind: "agent", id: "agent-7" };

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/records-service.spec.ts", "src/db/migrate.ts")));
  scope = await ensureCompany(db.pool, C);
  schema = new SchemaService(db.pool);
  records = new RecordsService(db.pool, schema);
  await schema.createTable(scope, { name: "contacts", fields: [{ name: "name", kind: "text", required: true }, { name: "email", kind: "email" }] }, { kind: "user", id: "u1" });
  await schema.createTable(scope, {
    name: "deals",
    fields: [
      { name: "title", kind: "text", required: true },
      { name: "amount", kind: "decimal" },
      { name: "stage", kind: "select", options: { choices: ["new", "won"] } },
      { name: "closes_on", kind: "date" },
      { name: "contact", kind: "relation", options: { relationTable: "contacts" } },
      { name: "tags", kind: "multi_select", options: { choices: ["hot", "big"] } },
    ],
  }, { kind: "user", id: "u1" });
});
afterAll(async () => { await db.close(); });

describe("RecordsService", () => {
  it("inserts validated rows with system columns and reads them back", async () => {
    const [contact] = await records.insert(scope, "contacts", [{ name: "Ada", email: "ada@example.com" }], by);
    expect(contact).toMatchObject({ name: "Ada", email: "ada@example.com", created_by_kind: "agent", created_by_id: "agent-7" });
    expect(typeof contact!.id).toBe("string");
    expect(typeof contact!.created_at).toBe("string");
    const [deal] = await records.insert(scope, "deals", [{ title: "Big one", amount: "1200.50", stage: "new", closes_on: "2026-12-01", contact: contact!.id, tags: ["big"] }], by);
    expect(deal).toMatchObject({ title: "Big one", amount: 1200.5, stage: "new", closes_on: "2026-12-01", contact: contact!.id, tags: ["big"] });
    expect(await records.get(scope, "deals", String(deal!.id))).toMatchObject({ title: "Big one" });
    expect(await records.get(scope, "deals", "2f1d8e2a-1f0a-4c7b-9a2d-3b4c5d6e7f80")).toBeNull();
  });

  it("maps a unique index violation on insert to conflict", async () => {
    await schema.createIndex(scope, "contacts", ["email"], true);
    await records.insert(scope, "contacts", [{ name: "Grace", email: "dup@example.com" }], by);
    await expect(records.insert(scope, "contacts", [{ name: "Hedy", email: "dup@example.com" }], by)).rejects.toThrow("conflict");
  });

  it("rejects invalid cells, unknown columns, and too many rows", async () => {
    await expect(records.insert(scope, "deals", [{ title: "x", stage: "lost" }], by)).rejects.toThrow("one of");
    await expect(records.insert(scope, "deals", [{ title: "x", nope: 1 }], by)).rejects.toThrow('unknown field "nope"');
    await expect(records.insert(scope, "deals", [{}], by)).rejects.toThrow("required");
    await expect(records.insert(scope, "deals", Array.from({ length: 501 }, () => ({ title: "x" })), by)).rejects.toThrow("limit");
    await expect(records.insert(scope, "deals", [], by)).rejects.toThrow("at least one row");
  });

  it("caps a target's ids and the bind parameters one call may use (P4-R14)", async () => {
    const ids = Array.from({ length: 501 }, () => randomUUID());
    await expect(records.update(scope, "deals", { ids }, { stage: "won" })).rejects.toThrow("at most 500 ids");
    await expect(records.delete(scope, "deals", { ids })).rejects.toThrow("at most 500 ids");
    // 500 is the boundary and is allowed (no row carries these ids, so nothing changes).
    expect((await records.update(scope, "deals", { ids: ids.slice(0, 500) }, { stage: "won" })).affected).toBe(0);
    expect((await records.delete(scope, "deals", { ids: ids.slice(0, 500) })).affected).toBe(0);

    // 9 columns plus created_by_kind/created_by_id is 11 bound values per row.
    await schema.createTable(scope, {
      name: "wide",
      fields: Array.from({ length: 9 }, (_unused, index) => ({ name: `f${index}`, kind: "text" })),
    }, { kind: "user", id: "u1" });
    const rows = (count: number) => Array.from({ length: count }, () => ({ f0: "x" }));
    expect(await records.insert(scope, "wide", rows(454), by)).toHaveLength(454); // 4_994 values
    await expect(records.insert(scope, "wide", rows(455), by)).rejects.toThrow("at most 5000 bound values"); // 5_005
  });

  it("queries with filters, ordering, paging, and counts", async () => {
    await records.insert(scope, "deals", [{ title: "Small", amount: 10, stage: "won" }, { title: "Medium", amount: 500, stage: "new", tags: ["hot"] }], by);
    const won = await records.query(scope, "deals", { where: { field: "stage", op: "eq", value: "won" }, fields: ["title"] });
    expect(won.rows).toEqual([{ title: "Small" }]);
    const hot = await records.query(scope, "deals", { where: { field: "tags", op: "contains", value: "hot" } });
    expect(hot.rows.map((row) => row.title)).toEqual(["Medium"]);
    const paged = await records.query(scope, "deals", { orderBy: [{ field: "amount", direction: "desc" }], limit: 2, offset: 1 });
    expect(paged.rows.map((row) => row.title)).toEqual(["Medium", "Small"]);
    expect(await records.count(scope, "deals", { field: "amount", op: "gte", value: 100 })).toBe(2);
    expect(await records.count(scope, "deals")).toBe(3);
    // P2-R31: only "Big one" has a closes_on, and an eq/neq filter on null is the IS [NOT] NULL
    // the caller means rather than a `= NULL` that silently matches nothing.
    expect(await records.count(scope, "deals", { field: "closes_on", op: "eq", value: null })).toBe(2);
    expect(await records.count(scope, "deals", { field: "closes_on", op: "neq", value: null })).toBe(1);
  });

  it("updates and deletes by ids or filters, bumping updated_at", async () => {
    const before = await records.query(scope, "deals", { where: { field: "title", op: "eq", value: "Small" } });
    const id = String(before.rows[0]!.id);
    const updated = await records.update(scope, "deals", { ids: [id] }, { amount: 15, stage: "won" });
    expect(updated.affected).toBe(1);
    expect(updated.rows[0]).toMatchObject({ amount: 15, stage: "won" });
    expect(String(updated.rows[0]!.updated_at) > String(before.rows[0]!.updated_at)).toBe(true);
    await expect(records.update(scope, "deals", {}, { amount: 1 })).rejects.toThrow("ids or where");
    await expect(records.update(scope, "deals", { ids: [id] }, { title: null })).rejects.toThrow("required");
    const bulk = await records.update(scope, "deals", { where: { field: "stage", op: "eq", value: "new" } }, { stage: "won" });
    expect(bulk.affected).toBe(2);
    expect((await records.delete(scope, "deals", { where: { field: "title", op: "starts_with", value: "Med" } })).affected).toBe(1);
    expect(await records.count(scope, "deals")).toBe(2);
  });

  it("runs read-only SQL with limits and rejects writes", async () => {
    const result = await records.sqlSelect(scope, "select stage, count(*)::int as n from deals group by stage order by stage");
    expect(result.columns).toEqual(["stage", "n"]);
    expect(result.rows).toEqual([{ stage: "won", n: 2 }]);
    expect(result.truncated).toBe(false);
    const params = await records.sqlSelect(scope, "select title from deals where amount > $1 order by title", [10]);
    expect(params.rows.map((row) => row.title)).toEqual(["Big one", "Small"]);
    await expect(records.sqlSelect(scope, "delete from deals")).rejects.toThrow("invalid");
    // Ruling P4-R11: pg_sleep is no longer even reachable — the function allowlist rejects it
    // before the 5 s statement timeout would. (The timeout itself is covered on withCompany in
    // company-scope.spec.ts, which runs its statement without going through the validator.)
    await expect(records.sqlSelect(scope, "select pg_sleep(10)")).rejects.toThrow('function "pg_sleep" is not allowed');
  });

  it("limits SQL to this company's registered tables (P2-R28)", async () => {
    // Each of these is a query the company role could otherwise run: pg_catalog is
    // world-readable and is first on every search_path, so the bare name resolves too.
    for (const sql of [
      "select * from pg_class",
      "select relname from pg_catalog.pg_class",
      "select rolname from pg_roles",
      "select * from information_schema.columns",
      "select * from kyoube_meta.tables",
      "select * from kyoube_meta.audit",
      "select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace",
    ]) {
      await expect(records.sqlSelect(scope, sql), sql).rejects.toThrow("invalid");
    }
    const cte = await records.sqlSelect(scope, "with won as (select title from deals where stage = 'won') select count(*)::int as n from won");
    expect(cte.rows).toEqual([{ n: 2 }]);
  });

  it("stops referencing a table in SQL once it is soft-dropped", async () => {
    await schema.createTable(scope, { name: "notes", fields: [{ name: "body", kind: "text" }] }, { kind: "user", id: "u1" });
    await records.insert(scope, "notes", [{ body: "keep" }], by);
    expect((await records.sqlSelect(scope, "select body from notes")).rows).toEqual([{ body: "keep" }]);
    await schema.dropTable(scope, "notes", false);
    await expect(records.sqlSelect(scope, "select body from notes")).rejects.toThrow('unknown table "notes"');
  });
});
