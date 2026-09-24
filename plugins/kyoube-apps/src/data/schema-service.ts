import type { Pool, PoolClient } from "pg";
import { withCompany, type CompanyScope, type ScopedClient } from "../db/company-scope.js";
import type { AuditPlan } from "./audit.js";
import { DataError, mapPgError } from "./errors.js";
import { choicesConstraint, choicesConstraintName, columnDefinition, normalizeFieldSpec, type FieldSpec } from "./field-kinds.js";
import type { FieldTypeMap } from "./filter.js";
import { assertIdentifier, quoteIdent, SYSTEM_COLUMNS } from "./identifiers.js";

export interface FieldInfo extends FieldSpec {
  position: number;
}

export interface TableInfo {
  name: string;
  displayName: string;
  description: string | null;
  fields: FieldInfo[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateTableInput {
  name: string;
  displayName?: string;
  description?: string | null;
  fields: unknown[];
}

export interface UpdateFieldPatch {
  displayName?: string;
  description?: string | null;
  required?: boolean;
  choices?: string[];
}

interface TableRow { id: string; name: string; display_name: string; description: string | null; created_at: Date; updated_at: Date }
interface FieldRow { name: string; display_name: string; description: string | null; kind: FieldSpec["kind"]; required: boolean; options: FieldSpec["options"]; position: number }

const SYSTEM_DDL = '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(), "created_by_kind" text, "created_by_id" text';

function titleCase(name: string): string {
  return name.split("_").filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

function trashName(name: string, now: number): string {
  // Budget the truncation around the stamp instead of slicing the whole string:
  // slicing `_trash_<name>_<stamp>` to 63 chars after concatenation can eat into
  // (or entirely remove) the trailing stamp for a long enough name, which makes
  // trashStamp() below parse garbage or find no digits at all.
  const stamp = String(Math.floor(now / 1000));
  const budget = 63 - "_trash_".length - "_".length - stamp.length;
  return `_trash_${name.slice(0, budget)}_${stamp}`;
}

/** True for the Postgres errors a trashName() collision (truncated-name reuse within the same second) can raise. */
function isDuplicateNameError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === "42P07" /* duplicate_table */ || code === "42701" /* duplicate_column */;
}

export class SchemaService {
  constructor(private readonly pool: Pool) {}

  /**
   * Runs `fn` as `withCompany`, mapping any raw Postgres error it throws (by
   * SQLSTATE) to a `DataError` so callers never see a driver error escape the
   * `DataError` contract. This is a fallback net behind the explicit pre-checks
   * each method already does (e.g. duplicate-name lookups) for races/gaps those
   * checks don't cover — an error this file already threw as a `DataError`
   * (whose `code` is never a 5-character SQLSTATE) maps to null and passes through
   * unchanged.
   *
   * `audit` (ruling P4-R12) is the caller's audit row for this change, written on the same
   * transaction from what the scoped work returns — so a failure to record the change also
   * rolls the change back.
   */
  private async run<T>(scope: CompanyScope, fn: (scoped: ScopedClient) => Promise<T>, audit?: AuditPlan<T>): Promise<T> {
    try {
      return await withCompany(this.pool, scope, fn, { audit });
    } catch (error) {
      throw mapPgError(error) ?? error;
    }
  }

  fieldTypeMap(table: TableInfo): FieldTypeMap {
    const map: FieldTypeMap = {};
    for (const column of SYSTEM_COLUMNS) map[column] = "system";
    for (const field of table.fields) map[field.name] = field.kind;
    return map;
  }

  async listTables(scope: CompanyScope): Promise<TableInfo[]> {
    const rows = await this.pool.query<TableRow>(
      "SELECT id, name, display_name, description, created_at, updated_at FROM kyoube_meta.tables WHERE company_id = $1 AND status = 'active' ORDER BY name",
      [scope.companyId],
    );
    return Promise.all(rows.rows.map((row) => this.hydrate(row)));
  }

  /**
   * The company's active table names, without hydrating their fields. Read with the pool (the
   * login role): a company role cannot see `kyoube_meta` at all. Ruling P2-R28 uses this as the
   * allowlist for `sql_select`, so a trashed table stops being referenceable in SQL.
   */
  async listTableNames(scope: CompanyScope): Promise<string[]> {
    const rows = await this.pool.query<{ name: string }>(
      "SELECT name FROM kyoube_meta.tables WHERE company_id = $1 AND status = 'active' ORDER BY name",
      [scope.companyId],
    );
    return rows.rows.map((row) => row.name);
  }

  async getTable(scope: CompanyScope, name: string): Promise<TableInfo> {
    const row = await this.tableRow(scope, assertIdentifier(name, "table name"));
    return this.hydrate(row);
  }

  async createTable(scope: CompanyScope, input: CreateTableInput, createdBy: { kind: string; id: string | null }, audit?: AuditPlan<{ name: string; fields: string[] }>): Promise<TableInfo> {
    const name = assertIdentifier(input.name, "table name");
    const fields = (input.fields ?? []).map(normalizeFieldSpec);
    const seen = new Set<string>();
    for (const field of fields) {
      if (seen.has(field.name)) throw new DataError("conflict", `duplicate field "${field.name}"`);
      seen.add(field.name);
    }
    const existing = await this.pool.query("SELECT 1 FROM kyoube_meta.tables WHERE company_id = $1 AND name = $2 AND status = 'active'", [scope.companyId, name]);
    if (existing.rowCount) throw new DataError("conflict", `table "${name}" already exists`);
    for (const field of fields) {
      if (field.kind === "relation") await this.tableRow(scope, field.options.relationTable!);
    }
    const definitions = [SYSTEM_DDL, ...fields.map((field) => columnDefinition(field, name))].join(", ");
    await this.run(scope, async ({ client, asOwner }) => {
      await client.query(`CREATE TABLE ${quoteIdent(name)} (${definitions})`);
      await asOwner();
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO kyoube_meta.tables (company_id, name, display_name, description, created_by_kind, created_by_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [scope.companyId, name, input.displayName?.trim() || titleCase(name), input.description ?? null, createdBy.kind, createdBy.id],
      );
      await this.insertFieldRows(client, inserted.rows[0]!.id, fields, 0);
      return { name, fields: fields.map((field) => field.name) };
    }, audit);
    return this.getTable(scope, name);
  }

  async addField(scope: CompanyScope, table: string, rawField: unknown, audit?: AuditPlan<string>): Promise<TableInfo> {
    const info = await this.getTable(scope, table);
    const field = normalizeFieldSpec(rawField);
    if (info.fields.some((existing) => existing.name === field.name)) throw new DataError("conflict", `field "${field.name}" already exists on "${info.name}"`);
    if (field.kind === "relation") await this.tableRow(scope, field.options.relationTable!);
    const row = await this.tableRow(scope, info.name);
    await this.run(scope, async ({ client, asOwner }) => {
      await client.query(`ALTER TABLE ${quoteIdent(info.name)} ADD COLUMN ${columnDefinition(field, info.name)}`);
      await asOwner();
      // The next position must come from the actual max in kyoube_meta.fields, not
      // info.fields.length: a prior soft/hard removal can leave gaps (or the two
      // can simply diverge), and reusing a freed position would collide there.
      const next = await client.query<{ next: number }>("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM kyoube_meta.fields WHERE table_id = $1", [row.id]);
      await this.insertFieldRows(client, row.id, [field], next.rows[0]!.next);
      await client.query("UPDATE kyoube_meta.tables SET updated_at = now() WHERE id = $1", [row.id]);
      return info.name;
    }, audit);
    return this.getTable(scope, info.name);
  }

  async updateField(scope: CompanyScope, table: string, fieldName: string, patch: UpdateFieldPatch, audit?: AuditPlan<string>): Promise<TableInfo> {
    const info = await this.getTable(scope, table);
    const name = assertIdentifier(fieldName, "field name");
    const current = info.fields.find((field) => field.name === name);
    if (!current) throw new DataError("not_found", `field "${name}" not found on "${info.name}"`);
    const next: FieldSpec = {
      ...current,
      displayName: patch.displayName?.trim() || current.displayName,
      description: patch.description !== undefined ? patch.description : current.description,
      required: patch.required ?? current.required,
      options: patch.choices ? { ...current.options, choices: [...new Set(patch.choices)] } : current.options,
    };
    if (patch.choices && current.kind !== "select" && current.kind !== "multi_select") throw new DataError("invalid", `field "${name}" has no choices`);
    if (patch.choices && patch.choices.length === 0) throw new DataError("invalid", "choices must not be empty");
    const row = await this.tableRow(scope, info.name);
    await this.run(scope, async ({ client, asOwner }) => {
      const t = quoteIdent(info.name);
      if (patch.required !== undefined && patch.required !== current.required) {
        await client.query(`ALTER TABLE ${t} ALTER COLUMN ${quoteIdent(name)} ${patch.required ? "SET" : "DROP"} NOT NULL`);
      }
      if (patch.choices) {
        await client.query(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${quoteIdent(choicesConstraintName(info.name, name))}`);
        await client.query(`ALTER TABLE ${t} ADD ${choicesConstraint(next, info.name)}`);
      }
      await asOwner();
      await client.query(
        "UPDATE kyoube_meta.fields SET display_name = $3, description = $4, required = $5, options = $6, updated_at = now() WHERE table_id = $1 AND name = $2",
        [row.id, name, next.displayName, next.description, next.required, JSON.stringify(next.options)],
      );
      return info.name;
    }, audit);
    return this.getTable(scope, info.name);
  }

  async removeField(scope: CompanyScope, table: string, fieldName: string, hard: boolean, audit?: AuditPlan<string>): Promise<TableInfo> {
    const info = await this.getTable(scope, table);
    const name = assertIdentifier(fieldName, "field name");
    if (!info.fields.some((field) => field.name === name)) throw new DataError("not_found", `field "${name}" not found on "${info.name}"`);
    const row = await this.tableRow(scope, info.name);
    await this.run(scope, async ({ client, asOwner }) => {
      const t = quoteIdent(info.name);
      await client.query(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${quoteIdent(choicesConstraintName(info.name, name))}`);
      if (hard) await client.query(`ALTER TABLE ${t} DROP COLUMN ${quoteIdent(name)}`);
      else {
        await client.query(`ALTER TABLE ${t} ALTER COLUMN ${quoteIdent(name)} DROP NOT NULL`);
        const trash = trashName(name, Date.now());
        try {
          await client.query(`ALTER TABLE ${t} RENAME COLUMN ${quoteIdent(name)} TO ${quoteIdent(trash)}`);
        } catch (error) {
          if (isDuplicateNameError(error)) throw new DataError("conflict", `a trashed column already uses the name "${trash}"; try again in a second`);
          throw error;
        }
      }
      await asOwner();
      await client.query("DELETE FROM kyoube_meta.fields WHERE table_id = $1 AND name = $2", [row.id, name]);
      return info.name;
    }, audit);
    return this.getTable(scope, info.name);
  }

  async dropTable(scope: CompanyScope, table: string, hard: boolean, audit?: AuditPlan<string>): Promise<void> {
    const row = await this.tableRow(scope, assertIdentifier(table, "table name"));
    const trash = trashName(row.name, Date.now());
    await this.run(scope, async ({ client, asOwner, asCompany }) => {
      // Ruling P4-R16: the reference check reads kyoube_meta, so it runs as the owner and — the
      // point of the ruling — *inside* this transaction, on the same snapshot as the drop. Run
      // before the transaction (as it was), it could pass while another session was still
      // committing a relation field, and the drop would go ahead on a referenced table.
      await asOwner();
      await this.assertNotReferenced(client, scope, row.name);
      await asCompany();
      if (hard) await client.query(`DROP TABLE ${quoteIdent(row.name)} CASCADE`);
      else {
        try {
          await client.query(`ALTER TABLE ${quoteIdent(row.name)} RENAME TO ${quoteIdent(trash)}`);
        } catch (error) {
          if (isDuplicateNameError(error)) throw new DataError("conflict", `a trashed table already uses the name "${trash}"; try again in a second`);
          throw error;
        }
      }
      await asOwner();
      if (hard) await client.query("DELETE FROM kyoube_meta.tables WHERE id = $1", [row.id]);
      else await client.query("UPDATE kyoube_meta.tables SET status = 'trashed', trash_name = $2, trashed_at = now(), updated_at = now() WHERE id = $1", [row.id, trash]);
      return row.name;
    }, audit);
  }

  async renameTable(scope: CompanyScope, table: string, newName: string, audit?: AuditPlan<string>): Promise<TableInfo> {
    const row = await this.tableRow(scope, assertIdentifier(table, "table name"));
    const target = assertIdentifier(newName, "table name");
    const taken = await this.pool.query("SELECT 1 FROM kyoube_meta.tables WHERE company_id = $1 AND name = $2 AND status = 'active'", [scope.companyId, target]);
    if (taken.rowCount) throw new DataError("conflict", `table "${target}" already exists`);
    // Snapshot the fields before the transaction: their choices constraints (named
    // after the *old* table name) need renaming alongside the table itself, below.
    const info = await this.hydrate(row);
    await this.run(scope, async ({ client, asOwner }) => {
      await client.query(`ALTER TABLE ${quoteIdent(row.name)} RENAME TO ${quoteIdent(target)}`);
      // Postgres does not rename constraints when their table is renamed, so a
      // choices CHECK constraint would otherwise keep living under its old name.
      // updateField() computes the constraint name to DROP from the *current*
      // table name, so left alone it would find nothing to drop and just ADD a
      // second, differently-named constraint alongside the stale one -- the two
      // CHECKs both apply, so the field's allowed values become their intersection.
      for (const field of info.fields) {
        if (field.options.choices) {
          await client.query(
            `ALTER TABLE ${quoteIdent(target)} RENAME CONSTRAINT ${quoteIdent(choicesConstraintName(row.name, field.name))} TO ${quoteIdent(choicesConstraintName(target, field.name))}`,
          );
        }
      }
      await asOwner();
      await client.query("UPDATE kyoube_meta.tables SET name = $2, updated_at = now() WHERE id = $1", [row.id, target]);
      // The physical FK (if any) follows the rename automatically, but every OTHER
      // active table's relation field metadata still names this table by its old
      // name and must be rewritten to match, or getTable()/fieldTypeMap() on the
      // referencing table would report a relationTable that no longer resolves.
      const dependents = await client.query<{ id: string }>(
        `SELECT f.id FROM kyoube_meta.fields f
           JOIN kyoube_meta.tables t ON t.id = f.table_id
          WHERE t.company_id = $1 AND t.status = 'active' AND f.kind = 'relation' AND f.options ->> 'relationTable' = $2`,
        [scope.companyId, row.name],
      );
      for (const dependent of dependents.rows) {
        await client.query(
          "UPDATE kyoube_meta.fields SET options = jsonb_set(options, '{relationTable}', to_jsonb($2::text)), updated_at = now() WHERE id = $1",
          [dependent.id, target],
        );
      }
      return target;
    }, audit);
    return this.getTable(scope, target);
  }

  async createIndex(scope: CompanyScope, table: string, fields: string[], unique: boolean, audit?: AuditPlan<string>): Promise<{ name: string }> {
    const info = await this.getTable(scope, table);
    if (fields.length === 0 || fields.length > 4) throw new DataError("invalid", "an index needs 1-4 fields");
    const map = this.fieldTypeMap(info);
    const names = fields.map((field) => { if (!Object.hasOwn(map, field)) throw new DataError("not_found", `field "${field}" not found`); return field; });
    const name = `${info.name}_${names.join("_")}_idx`.slice(0, 63);
    // No IF NOT EXISTS: a duplicate index name should fail, and now maps to a
    // "conflict" DataError via run()/mapPgError instead of silently no-op'ing.
    await this.run(scope, async ({ client }) => {
      await client.query(`CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdent(name)} ON ${quoteIdent(info.name)} (${names.map(quoteIdent).join(", ")})`);
      return info.name;
    }, audit);
    return { name };
  }

  async purgeTrash(
    scope: CompanyScope,
    olderThanMs: number,
    now: number = Date.now(),
    audit?: AuditPlan<{ droppedTables: string[]; droppedColumns: string[] }>,
  ): Promise<{ droppedTables: string[]; droppedColumns: string[] }> {
    const cutoff = Math.floor((now - olderThanMs) / 1000);
    const droppedTables: string[] = [];
    const droppedColumns: string[] = [];
    await this.run(scope, async ({ client, asOwner }) => {
      const tables = await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE '\\_trash\\_%'", [scope.schema]);
      for (const { table_name } of tables.rows) {
        if (this.trashStamp(table_name) <= cutoff) { await client.query(`DROP TABLE ${quoteIdent(table_name)} CASCADE`); droppedTables.push(table_name); }
      }
      const columns = await client.query<{ table_name: string; column_name: string }>(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND column_name LIKE '\\_trash\\_%' AND table_name NOT LIKE '\\_trash\\_%'",
        [scope.schema],
      );
      for (const { table_name, column_name } of columns.rows) {
        if (this.trashStamp(column_name) <= cutoff) { await client.query(`ALTER TABLE ${quoteIdent(table_name)} DROP COLUMN ${quoteIdent(column_name)}`); droppedColumns.push(`${table_name}.${column_name}`); }
      }
      await asOwner();
      if (droppedTables.length > 0) await client.query("DELETE FROM kyoube_meta.tables WHERE company_id = $1 AND status = 'trashed' AND trash_name = ANY($2)", [scope.companyId, droppedTables]);
      return { droppedTables, droppedColumns };
    }, audit);
    return { droppedTables, droppedColumns };
  }

  private trashStamp(name: string): number {
    const match = /_(\d+)$/.exec(name);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  }

  /**
   * Refuses when some OTHER active table has an active relation field pointing at `tableName`.
   * Takes the queryable to read from so the caller can run it on its own transaction's client
   * (ruling P4-R16) rather than separately on the pool.
   */
  private async assertNotReferenced(db: Pool | PoolClient, scope: CompanyScope, tableName: string): Promise<void> {
    const result = await db.query<{ table_name: string; field_name: string }>(
      `SELECT t.name AS table_name, f.name AS field_name
         FROM kyoube_meta.fields f
         JOIN kyoube_meta.tables t ON t.id = f.table_id
        WHERE t.company_id = $1 AND t.status = 'active' AND t.name <> $2
          AND f.kind = 'relation' AND f.options ->> 'relationTable' = $2
        LIMIT 1`,
      [scope.companyId, tableName],
    );
    const ref = result.rows[0];
    if (ref) throw new DataError("conflict", `table "${tableName}" is referenced by "${ref.table_name}"."${ref.field_name}"; remove that field first`);
  }

  private async tableRow(scope: CompanyScope, name: string): Promise<TableRow> {
    const result = await this.pool.query<TableRow>(
      "SELECT id, name, display_name, description, created_at, updated_at FROM kyoube_meta.tables WHERE company_id = $1 AND name = $2 AND status = 'active'",
      [scope.companyId, name],
    );
    if (!result.rows[0]) throw new DataError("not_found", `table "${name}" not found`);
    return result.rows[0];
  }

  private async hydrate(row: TableRow): Promise<TableInfo> {
    const fields = await this.pool.query<FieldRow>(
      "SELECT name, display_name, description, kind, required, options, position FROM kyoube_meta.fields WHERE table_id = $1 ORDER BY position, name",
      [row.id],
    );
    return {
      name: row.name,
      displayName: row.display_name,
      description: row.description,
      fields: fields.rows.map((field) => ({ name: field.name, displayName: field.display_name, description: field.description, kind: field.kind, required: field.required, options: field.options ?? {}, position: field.position })),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private async insertFieldRows(client: PoolClient, tableId: string, fields: FieldSpec[], startPosition: number): Promise<void> {
    let position = startPosition;
    for (const field of fields) {
      await client.query(
        "INSERT INTO kyoube_meta.fields (table_id, name, display_name, description, kind, required, options, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [tableId, field.name, field.displayName, field.description, field.kind, field.required, JSON.stringify(field.options), position++],
      );
    }
  }
}
