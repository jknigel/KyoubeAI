import type { Pool } from "pg";
import { withCompany, type CompanyScope, type ScopedClient, type WithCompanyOptions } from "../db/company-scope.js";
import type { AuditPlan } from "./audit.js";
import { DataError, mapPgError } from "./errors.js";
import { coerceValue } from "./field-kinds.js";
import { compileQuery, compileWhere, type QuerySpec } from "./filter.js";
import { quoteIdent } from "./identifiers.js";
import type { SchemaService, TableInfo } from "./schema-service.js";
import { assertReadOnlySelect } from "./sql-select.js";

export type Row = Record<string, unknown>;

export interface RowTarget {
  ids?: string[];
  where?: unknown;
}

const MAX_INSERT = 500;
const MAX_AFFECTED = 1000;
const SQL_LIMIT = 1000;
const MAX_TARGET_IDS = 500;
const MAX_BIND_PARAMS = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ruling P4-R14: the row caps alone do not bound the *statement* — 500 rows on a 100-column
 * table is 51,000 bound values, close to Postgres' own 65,535 limit and a lot of memory to
 * parse. So the assembled parameter list is capped as well, and the caller is told to split the
 * call rather than being handed a driver-level failure.
 */
function assertBindLimit(params: readonly unknown[]): void {
  if (params.length > MAX_BIND_PARAMS) {
    throw new DataError("limit", `this call needs ${params.length} bound values; at most ${MAX_BIND_PARAMS} bound values are allowed per call — send fewer rows (or narrower ones) at a time`);
  }
}

function normalizeRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) out[key] = value instanceof Date ? value.toISOString() : value;
  return out;
}

export class RecordsService {
  constructor(private readonly pool: Pool, private readonly schema: SchemaService) {}

  /**
   * Runs `fn` as `withCompany`, mapping any raw Postgres error it throws (by
   * SQLSTATE) to a `DataError` so callers never see a driver error escape the
   * `DataError` contract. Mirrors SchemaService's private run() helper: an
   * error this file already threw as a `DataError` (whose `code` is never a
   * 5-character SQLSTATE) maps to null and passes through unchanged.
   */
  private async run<T>(
    scope: CompanyScope,
    fn: (scoped: ScopedClient) => Promise<T>,
    opts: WithCompanyOptions<T> = {},
  ): Promise<T> {
    try {
      return await withCompany(this.pool, scope, fn, opts);
    } catch (error) {
      throw mapPgError(error) ?? error;
    }
  }

  async insert(scope: CompanyScope, table: string, rows: unknown[], createdBy: { kind: string; id: string | null }, audit?: AuditPlan<Row[]>): Promise<Row[]> {
    if (!Array.isArray(rows) || rows.length === 0) throw new DataError("invalid", "insert needs at least one row");
    if (rows.length > MAX_INSERT) throw new DataError("limit", `insert at most ${MAX_INSERT} rows per call`);
    const info = await this.schema.getTable(scope, table);
    const columns = info.fields.map((field) => field.name);
    const values: unknown[] = [];
    const tuples = rows.map((raw) => {
      const cells = this.coerceRow(info, raw, { requireAll: true });
      const placeholders = columns.map((column) => { values.push(cells[column] ?? null); return `$${values.length}`; });
      values.push(createdBy.kind, createdBy.id);
      placeholders.push(`$${values.length - 1}`, `$${values.length}`);
      return `(${placeholders.join(", ")})`;
    });
    assertBindLimit(values);
    const columnList = [...columns, "created_by_kind", "created_by_id"].map(quoteIdent).join(", ");
    const sql = `INSERT INTO ${quoteIdent(info.name)} (${columnList}) VALUES ${tuples.join(", ")} RETURNING *`;
    return this.run(scope, async ({ client }) => (await client.query(sql, values)).rows.map(normalizeRow), { audit });
  }

  async get(scope: CompanyScope, table: string, id: string): Promise<Row | null> {
    const info = await this.schema.getTable(scope, table);
    if (!UUID_RE.test(id)) throw new DataError("invalid", "id must be a uuid");
    return this.run(scope, async ({ client }) => {
      const result = await client.query(`SELECT * FROM ${quoteIdent(info.name)} WHERE "id" = $1`, [id]);
      return result.rows[0] ? normalizeRow(result.rows[0]) : null;
    }, { readOnly: true });
  }

  async query(scope: CompanyScope, table: string, spec: QuerySpec): Promise<{ rows: Row[]; limit: number; offset: number }> {
    const info = await this.schema.getTable(scope, table);
    const compiled = compileQuery(info.name, this.schema.fieldTypeMap(info), spec);
    assertBindLimit(compiled.params);
    const rows = await this.run(scope, async ({ client }) => (await client.query(compiled.sql, compiled.params)).rows, { readOnly: true });
    return { rows: rows.map(normalizeRow), limit: compiled.limit, offset: compiled.offset };
  }

  async count(scope: CompanyScope, table: string, where?: unknown): Promise<number> {
    const info = await this.schema.getTable(scope, table);
    const params: unknown[] = [];
    const clause = compileWhere(where, this.schema.fieldTypeMap(info), params);
    assertBindLimit(params);
    const sql = `SELECT count(*)::int AS n FROM ${quoteIdent(info.name)}${clause ? ` WHERE ${clause}` : ""}`;
    return this.run(scope, async ({ client }) => (await client.query<{ n: number }>(sql, params)).rows[0]!.n, { readOnly: true });
  }

  async update(scope: CompanyScope, table: string, target: RowTarget, patch: Row, audit?: AuditPlan<{ affected: number; rows: Row[] }>): Promise<{ affected: number; rows: Row[] }> {
    const info = await this.schema.getTable(scope, table);
    const cells = this.coerceRow(info, patch, { requireAll: false });
    const keys = Object.keys(cells);
    if (keys.length === 0) throw new DataError("invalid", "update needs at least one field");
    const params: unknown[] = [];
    const sets = keys.map((key) => { params.push(cells[key]); return `${quoteIdent(key)} = $${params.length}`; });
    sets.push('"updated_at" = now()');
    const where = this.targetClause(info, target, params);
    assertBindLimit(params);
    const sql = `UPDATE ${quoteIdent(info.name)} SET ${sets.join(", ")} WHERE "id" IN (SELECT "id" FROM ${quoteIdent(info.name)} WHERE ${where} LIMIT ${MAX_AFFECTED + 1}) RETURNING *`;
    return this.run(scope, async ({ client }) => {
      const result = await client.query(sql, params);
      if (result.rowCount !== null && result.rowCount > MAX_AFFECTED) throw new DataError("limit", `update would affect more than ${MAX_AFFECTED} rows; narrow the filter`);
      return { affected: result.rowCount ?? 0, rows: result.rows.map(normalizeRow) };
    }, { audit });
  }

  async delete(scope: CompanyScope, table: string, target: RowTarget, audit?: AuditPlan<{ affected: number }>): Promise<{ affected: number }> {
    const info = await this.schema.getTable(scope, table);
    const params: unknown[] = [];
    const where = this.targetClause(info, target, params);
    assertBindLimit(params);
    const sql = `DELETE FROM ${quoteIdent(info.name)} WHERE "id" IN (SELECT "id" FROM ${quoteIdent(info.name)} WHERE ${where} LIMIT ${MAX_AFFECTED + 1})`;
    return this.run(scope, async ({ client }) => {
      const result = await client.query(sql, params);
      if (result.rowCount !== null && result.rowCount > MAX_AFFECTED) throw new DataError("limit", `delete would affect more than ${MAX_AFFECTED} rows; narrow the filter`);
      return { affected: result.rowCount ?? 0 };
    }, { audit });
  }

  async sqlSelect(scope: CompanyScope, sql: string, params: unknown[] = []): Promise<{ columns: string[]; rows: Row[]; truncated: boolean }> {
    // Ruling P2-R28: the statement may reference nothing but this company's active tables, so
    // the allowlist is loaded first, with the pool — the company role cannot read kyoube_meta.
    const statement = assertReadOnlySelect(sql, { allowedTables: await this.schema.listTableNames(scope) });
    if (!Array.isArray(params) || params.length > 50) throw new DataError("invalid", "params must be an array of at most 50 values");
    // Wrapped on its own lines so a line comment inside the statement can never
    // swallow the closing parenthesis or the LIMIT that follows it.
    const wrapped = `SELECT * FROM (\n${statement}\n) AS kyoube_q LIMIT ${SQL_LIMIT + 1}`;
    return this.run(scope, async ({ client }) => {
      const result = await client.query(wrapped, params);
      const truncated = result.rows.length > SQL_LIMIT;
      return { columns: result.fields.map((field) => field.name), rows: result.rows.slice(0, SQL_LIMIT).map(normalizeRow), truncated };
    }, { readOnly: true, statementTimeoutMs: 5000 });
  }

  private coerceRow(info: TableInfo, raw: unknown, opts: { requireAll: boolean }): Row {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new DataError("invalid", "each row must be an object");
    const input = raw as Row;
    const known = new Map(info.fields.map((field) => [field.name, field]));
    for (const key of Object.keys(input)) {
      if (!known.has(key)) throw new DataError("invalid", `unknown field "${key}" on "${info.name}"`);
    }
    const cells: Row = {};
    for (const field of info.fields) {
      if (!opts.requireAll && !Object.hasOwn(input, field.name)) continue;
      cells[field.name] = coerceValue(field, input[field.name]);
    }
    return cells;
  }

  private targetClause(info: TableInfo, target: RowTarget, params: unknown[]): string {
    const hasIds = Array.isArray(target.ids) && target.ids.length > 0;
    const hasWhere = target.where !== undefined && target.where !== null && Object.keys(target.where as object).length > 0;
    if (hasIds === hasWhere) throw new DataError("invalid", "provide exactly one of ids or where");
    if (hasIds) {
      // Ruling P4-R14. The ids travel as one array parameter, so this bounds the work the
      // statement does (and what a caller can ask to be scanned), not the bind count.
      if (target.ids!.length > MAX_TARGET_IDS) throw new DataError("limit", `target at most ${MAX_TARGET_IDS} ids per call (got ${target.ids!.length}); split it into smaller calls`);
      if (target.ids!.some((id) => !UUID_RE.test(id))) throw new DataError("invalid", "ids must be uuids");
      params.push(target.ids);
      return `"id" = ANY($${params.length}::uuid[])`;
    }
    return compileWhere(target.where, this.schema.fieldTypeMap(info), params);
  }
}
