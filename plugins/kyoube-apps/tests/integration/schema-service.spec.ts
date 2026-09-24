import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SchemaService } from "../../src/data/schema-service.js";
import { ensureCompany, resetCompanyCache, withCompany, type CompanyScope } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

const C = "44444444-4444-4444-8444-444444444444";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let scope: CompanyScope;
let schema: SchemaService;
const by = { kind: "user", id: "u1" };

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/schema-service.spec.ts", "src/db/migrate.ts")));
  scope = await ensureCompany(db.pool, C);
  schema = new SchemaService(db.pool);
});
afterAll(async () => { await db.close(); });

async function columns(table: string): Promise<string[]> {
  const rows = await withCompany(db.pool, scope, async ({ client }) =>
    (await client.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position", [scope.schema, table])).rows);
  return rows.map((row) => row.column_name);
}

describe("SchemaService", () => {
  it("creates a table with system columns and typed fields, and lists it", async () => {
    const table = await schema.createTable(scope, {
      name: "contacts",
      displayName: "Contacts",
      fields: [{ name: "name", kind: "text", required: true }, { name: "email", kind: "email" }, { name: "stage", kind: "select", options: { choices: ["lead", "customer"] } }],
    }, by);
    expect(table.fields.map((field) => field.name)).toEqual(["name", "email", "stage"]);
    expect(await columns("contacts")).toEqual(["id", "created_at", "updated_at", "created_by_kind", "created_by_id", "name", "email", "stage"]);
    expect((await schema.listTables(scope)).map((item) => item.name)).toEqual(["contacts"]);
    expect(schema.fieldTypeMap(table)).toEqual({ id: "system", created_at: "system", updated_at: "system", created_by_kind: "system", created_by_id: "system", name: "text", email: "email", stage: "select" });
  });

  it("rejects duplicates and unknown relation targets", async () => {
    await expect(schema.createTable(scope, { name: "contacts", fields: [] }, by)).rejects.toThrow("conflict");
    await expect(schema.createTable(scope, { name: "deals", fields: [{ name: "contact", kind: "relation", options: { relationTable: "nope" } }] }, by)).rejects.toThrow("not_found");
  });

  it("adds, updates, and soft-removes fields", async () => {
    await schema.createTable(scope, { name: "deals", fields: [{ name: "title", kind: "text" }] }, by);
    let deals = await schema.addField(scope, "deals", { name: "contact", kind: "relation", options: { relationTable: "contacts" } });
    expect(deals.fields.map((f) => f.name)).toEqual(["title", "contact"]);
    deals = await schema.addField(scope, "deals", { name: "stage", kind: "select", options: { choices: ["new"] } });
    deals = await schema.updateField(scope, "deals", "stage", { choices: ["new", "won"], required: true, displayName: "Stage!" });
    expect(deals.fields.find((f) => f.name === "stage")).toMatchObject({ displayName: "Stage!", required: true, options: { choices: ["new", "won"] } });
    await expect(schema.addField(scope, "deals", { name: "stage", kind: "text" })).rejects.toThrow("conflict");
    deals = await schema.removeField(scope, "deals", "contact", false);
    expect(deals.fields.map((f) => f.name)).toEqual(["title", "stage"]);
    expect((await columns("deals")).some((name) => name.startsWith("_trash_contact_"))).toBe(true);
    await schema.removeField(scope, "deals", "stage", true);
    expect(await columns("deals")).not.toContain("stage");
  });

  it("renames tables, creates indexes, soft-drops, and purges trash", async () => {
    await schema.createTable(scope, { name: "tmp", fields: [{ name: "a", kind: "integer" }] }, by);
    const renamed = await schema.renameTable(scope, "tmp", "tmp2");
    expect(renamed.name).toBe("tmp2");
    expect((await schema.createIndex(scope, "tmp2", ["a"], true)).name).toBe("tmp2_a_idx");
    await schema.dropTable(scope, "tmp2", false);
    await expect(schema.getTable(scope, "tmp2")).rejects.toThrow("not_found");
    const trashed = await withCompany(db.pool, scope, async ({ client }) =>
      (await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE '_trash_tmp2_%'", [scope.schema])).rows);
    expect(trashed).toHaveLength(1);
    expect(await schema.purgeTrash(scope, 30 * 86_400_000)).toEqual({ droppedTables: [], droppedColumns: [] });
    const purged = await schema.purgeTrash(scope, 0, Date.now() + 1000);
    expect(purged.droppedTables).toEqual([trashed[0]!.table_name]);
    expect(purged.droppedColumns.length).toBeGreaterThanOrEqual(1);
    await schema.createTable(scope, { name: "tmp2", fields: [] }, by); // name is free again
  });

  it("reuses a table name immediately after a soft drop; purge affects only the trashed row", async () => {
    // Metadata uniqueness (tables_company_name_active_idx) is a partial index on
    // status = 'active', so a trashed table's name must be free before purge ever runs.
    await schema.createTable(scope, { name: "reuse", fields: [] }, by);
    await schema.dropTable(scope, "reuse", false);
    const trashed = await withCompany(db.pool, scope, async ({ client }) =>
      (await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE '_trash_reuse_%'", [scope.schema])).rows);
    expect(trashed).toHaveLength(1);
    const recreated = await schema.createTable(scope, { name: "reuse", fields: [] }, by);
    expect(recreated.name).toBe("reuse");
    expect((await schema.listTables(scope)).filter((item) => item.name === "reuse")).toHaveLength(1);
    const purged = await schema.purgeTrash(scope, 0, Date.now() + 1000);
    expect(purged.droppedTables).toEqual([trashed[0]!.table_name]);
    expect((await schema.listTables(scope)).map((item) => item.name)).toContain("reuse");
    await expect(schema.getTable(scope, "reuse")).resolves.toMatchObject({ name: "reuse" });
    // P2-R4/P2-R21 item 5: the trashed physical table and its meta row are both
    // gone, and only the new active meta row (not a leftover trashed one) remains.
    const trashedAfterPurge = await withCompany(db.pool, scope, async ({ client }) =>
      (await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE '_trash_reuse_%'", [scope.schema])).rows);
    expect(trashedAfterPurge).toHaveLength(0);
    const metaRows = await db.pool.query<{ status: string }>("SELECT status FROM kyoube_meta.tables WHERE company_id = $1 AND name = $2", [scope.companyId, "reuse"]);
    expect(metaRows.rows).toEqual([{ status: "active" }]);
  });

  it("keeps the trash timestamp intact for long table names (Critical fix, ruling P2-R21 item 1)", async () => {
    const longName = `t${"a".repeat(59)}`; // 60 chars, a valid identifier (max 63)
    await schema.createTable(scope, { name: longName, fields: [] }, by);
    await schema.dropTable(scope, longName, false);
    const trashed = await withCompany(db.pool, scope, async ({ client }) =>
      (await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE '_trash_%'", [scope.schema])).rows);
    expect(trashed).toHaveLength(1);
    const trashedName = trashed[0]!.table_name;
    expect(trashedName.length).toBeLessThanOrEqual(63);
    expect(trashedName).toMatch(/_\d{10}$/); // the stamp must survive truncation intact
    expect(await schema.purgeTrash(scope, 30 * 86_400_000)).toEqual({ droppedTables: [], droppedColumns: [] });
    const purged = await schema.purgeTrash(scope, 0, Date.now() + 1000);
    expect(purged.droppedTables).toEqual([trashedName]);
  });

  it("moves the choices constraint to the new name on rename, instead of leaving a second stale one (Important fix, item 2)", async () => {
    await schema.createTable(scope, { name: "renamable", fields: [{ name: "stage", kind: "select", options: { choices: ["a"] } }] }, by);
    await schema.renameTable(scope, "renamable", "renamable2");
    await schema.updateField(scope, "renamable2", "stage", { choices: ["a", "b"] });
    // If the old "renamable_stage_choices" constraint (CHECK stage IN ('a')) had
    // survived the rename under its stale name, this insert of the newly-added
    // choice "b" would violate it and the whole transaction would reject.
    await withCompany(db.pool, scope, async ({ client }) => {
      await client.query('INSERT INTO "renamable2" ("stage") VALUES ($1)', ["b"]);
    });
    const rows = await withCompany(db.pool, scope, async ({ client }) => (await client.query('SELECT stage FROM "renamable2"')).rows);
    expect(rows).toEqual([{ stage: "b" }]);
  });

  it("blocks dropping a referenced table and rewrites dependents' relationTable on rename (Important fix, item 3)", async () => {
    await schema.createTable(scope, { name: "ref_target", fields: [] }, by);
    await schema.createTable(scope, { name: "ref_source", fields: [{ name: "link", kind: "relation", options: { relationTable: "ref_target" } }] }, by);
    await expect(schema.dropTable(scope, "ref_target", false)).rejects.toThrow("conflict");
    await expect(schema.dropTable(scope, "ref_target", true)).rejects.toThrow("conflict");
    const renamed = await schema.renameTable(scope, "ref_target", "ref_target2");
    expect(renamed.name).toBe("ref_target2");
    const source = await schema.getTable(scope, "ref_source");
    expect(source.fields.find((f) => f.name === "link")).toMatchObject({ options: { relationTable: "ref_target2" } });
    await schema.removeField(scope, "ref_source", "link", true);
    await schema.dropTable(scope, "ref_target2", true); // the block is lifted now that nothing references it
    await expect(schema.getTable(scope, "ref_target2")).rejects.toThrow("not_found");
  });

  it("rolls a rename back whole when two choices constraints collide at 63 characters (P4-R16)", async () => {
    await schema.createTable(scope, {
      name: "collide",
      fields: [
        { name: "alpha", kind: "select", options: { choices: ["a"] } },
        { name: "beta", kind: "select", options: { choices: ["b"] } },
      ],
    }, by);
    // choicesConstraintName truncates `<table>_<field>_choices` to 63 characters, so under a
    // 63-character table name both fields want the *same* constraint name and the second
    // RENAME CONSTRAINT raises 42710.
    const long = `t${"a".repeat(62)}`;
    expect(long).toHaveLength(63);
    await expect(schema.renameTable(scope, "collide", long)).rejects.toThrow("conflict");
    // Nothing half-renamed: the table, its metadata and its constraints are as they were.
    expect((await schema.getTable(scope, "collide")).name).toBe("collide");
    await expect(schema.getTable(scope, long)).rejects.toThrow("not_found");
    await withCompany(db.pool, scope, async ({ client }) => {
      await client.query('INSERT INTO "collide" ("alpha", "beta") VALUES ($1, $2)', ["a", "b"]);
      await expect(client.query('INSERT INTO "collide" ("alpha") VALUES ($1)', ["z"])).rejects.toThrow(/violates check constraint/);
    });
  });

  it("checks references inside the drop's own transaction, catching one committed after the call began (P4-R16)", async () => {
    await schema.createTable(scope, { name: "race_target", fields: [] }, by);
    await schema.createTable(scope, { name: "race_source", fields: [] }, by);
    let injected = false;
    // Commits a reference to race_target at the moment the drop reaches for its transaction —
    // after the lookups that precede it. A reference check made before the transaction (as it
    // was) would already have passed by this point and would drop a referenced table.
    const hooked = new Proxy(db.pool, {
      get(target, property, receiver) {
        if (property === "connect") {
          return async () => {
            if (!injected) {
              injected = true;
              await schema.addField(scope, "race_source", { name: "link", kind: "relation", options: { relationTable: "race_target" } });
            }
            return target.connect();
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const racing = new SchemaService(hooked);
    await expect(racing.dropTable(scope, "race_target", false)).rejects.toThrow("conflict");
    expect(injected).toBe(true);
    expect((await schema.getTable(scope, "race_target")).name).toBe("race_target");
  });

  it("computes a new field's position from the current max, not the field count (Important fix, item 4)", async () => {
    let t = await schema.createTable(scope, {
      name: "positions_test",
      fields: [{ name: "a", kind: "text" }, { name: "b", kind: "text" }, { name: "c", kind: "text" }],
    }, by);
    expect(t.fields.map((f) => f.position)).toEqual([0, 1, 2]);
    t = await schema.removeField(scope, "positions_test", "b", true);
    t = await schema.addField(scope, "positions_test", { name: "d", kind: "text" });
    expect(t.fields.map((f) => ({ name: f.name, position: f.position }))).toEqual([
      { name: "a", position: 0 },
      { name: "c", position: 2 },
      { name: "d", position: 3 },
    ]);
  });

  it("maps a Postgres-level duplicate-object error to conflict even when the metadata pre-check misses it (Important fix, item 6)", async () => {
    // Create the physical table directly, bypassing createTable's own metadata
    // pre-check (already covered by "rejects duplicates" above), so the only thing
    // that can catch the collision is the CREATE TABLE statement itself failing --
    // exercising run()/mapPgError's transaction-level fallback.
    await withCompany(db.pool, scope, async ({ client }) => {
      await client.query('CREATE TABLE "ghost" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid())');
    });
    await expect(schema.createTable(scope, { name: "ghost", fields: [] }, by)).rejects.toThrow("conflict");
  });

  it("rejects creating an index whose name already exists (Important fix, item 7)", async () => {
    await schema.createTable(scope, { name: "idx_test", fields: [{ name: "a", kind: "integer" }] }, by);
    await schema.createIndex(scope, "idx_test", ["a"], false);
    await expect(schema.createIndex(scope, "idx_test", ["a"], false)).rejects.toThrow("conflict");
  });
});
