import { DataError } from "./errors.js";
import type { FieldKind } from "./field-kinds.js";
import { quoteIdent } from "./identifiers.js";

export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains" | "starts_with" | "is_null" | "is_not_null";
const OPS: ReadonlySet<string> = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "starts_with", "is_null", "is_not_null"]);
const COMPARISONS: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

export interface FieldTypeMap {
  [field: string]: FieldKind | "system";
}

export interface QuerySpec {
  where?: unknown;
  orderBy?: Array<{ field: string; direction?: "asc" | "desc" }>;
  limit?: number;
  offset?: number;
  fields?: string[];
}

const MAX_DEPTH = 8;
const MAX_CONDITIONS = 64;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function knownField(name: unknown, fields: FieldTypeMap): string {
  if (typeof name !== "string" || !Object.hasOwn(fields, name)) throw new DataError("invalid", `unknown field "${String(name)}"`);
  return name;
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function compileWhere(where: unknown, fields: FieldTypeMap, params: unknown[]): string {
  if (where === undefined || where === null) return "";
  if (typeof where !== "object") throw new DataError("invalid", "where must be an object");
  if (Object.keys(where as object).length === 0) return "";
  let conditions = 0;

  const visit = (node: unknown, depth: number): string => {
    if (depth > MAX_DEPTH) throw new DataError("invalid", `filter nesting depth exceeds ${MAX_DEPTH}`);
    if (typeof node !== "object" || node === null || Array.isArray(node)) throw new DataError("invalid", "invalid filter node");
    const record = node as Record<string, unknown>;
    if ("and" in record || "or" in record) {
      const key = "and" in record ? "and" : "or";
      const items = record[key];
      if (!Array.isArray(items) || items.length === 0) throw new DataError("invalid", `${key} must be a non-empty array`);
      return `(${items.map((item) => visit(item, depth + 1)).join(key === "and" ? " AND " : " OR ")})`;
    }
    if ("not" in record) return `(NOT ${visit(record.not, depth + 1)})`;
    conditions += 1;
    if (conditions > MAX_CONDITIONS) throw new DataError("invalid", `filter has more than ${MAX_CONDITIONS} conditions`);
    const field = knownField(record.field, fields);
    const column = quoteIdent(field);
    const op = record.op;
    if (typeof op !== "string" || !OPS.has(op)) throw new DataError("invalid", `unknown operator "${String(op)}"`);
    const kind = fields[field]!;
    const value = record.value;
    switch (op as FilterOp) {
      case "is_null": return `(${column} IS NULL)`;
      case "is_not_null": return `(${column} IS NOT NULL)`;
      case "in":
        if (!Array.isArray(value) || value.length === 0 || !value.every(isScalar)) {
          throw new DataError("invalid", `operator in needs a non-empty array of strings, numbers, or booleans for "${field}"`);
        }
        params.push(value);
        return `(${column} = ANY($${params.length}))`;
      case "contains":
        if (kind === "multi_select") {
          if (typeof value !== "string") throw new DataError("invalid", `operator contains on a multi_select field needs a string value for "${field}"`);
          params.push(value);
          return `($${params.length} = ANY(${column}))`;
        }
        params.push(`%${escapeLike(String(value))}%`);
        return `(${column} ILIKE $${params.length} ESCAPE '\\')`;
      case "starts_with":
        params.push(`${escapeLike(String(value))}%`);
        return `(${column} ILIKE $${params.length} ESCAPE '\\')`;
      default:
        if (value === undefined) throw new DataError("invalid", `operator ${op} needs a value for "${field}"`);
        // Ruling P2-R31: SQL's `= NULL` / `<> NULL` are NULL, never true, so an equality filter
        // on a null value silently matched nothing. Compile the IS [NOT] NULL the caller means,
        // binding no parameter for it. The ordering operators keep SQL's own semantics, since
        // `> NULL` has no IS-form to mean instead.
        if (value === null && (op === "eq" || op === "neq")) return `(${column} IS ${op === "eq" ? "NULL" : "NOT NULL"})`;
        params.push(value);
        return `(${column} ${COMPARISONS[op]} $${params.length})`;
    }
  };
  return visit(where, 1);
}

export function compileQuery(
  table: string,
  fields: FieldTypeMap,
  spec: QuerySpec,
  opts: { maxLimit?: number; defaultLimit?: number } = {},
): { sql: string; params: unknown[]; limit: number; offset: number } {
  const maxLimit = opts.maxLimit ?? 1000;
  const params: unknown[] = [];
  const selected = spec.fields && spec.fields.length > 0 ? spec.fields.map((name) => quoteIdent(knownField(name, fields))).join(", ") : "*";
  const where = compileWhere(spec.where, fields, params);
  const order = (spec.orderBy && spec.orderBy.length > 0 ? spec.orderBy : [{ field: "created_at", direction: "asc" as const }])
    .map((item) => `${quoteIdent(knownField(item.field, fields))} ${item.direction === "desc" ? "DESC" : "ASC"}`)
    .join(", ");
  const limitInput = spec.limit;
  const limitBase = limitInput !== undefined && Number.isFinite(limitInput) ? limitInput : (opts.defaultLimit ?? 50);
  const limit = Math.min(maxLimit, Math.max(1, Math.floor(limitBase)));
  const offsetInput = spec.offset;
  const offsetBase = offsetInput !== undefined && Number.isFinite(offsetInput) ? offsetInput : 0;
  const offset = Math.max(0, Math.floor(offsetBase));
  const sql = `SELECT ${selected} FROM ${quoteIdent(table)}${where ? ` WHERE ${where}` : ""} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`;
  return { sql, params, limit, offset };
}
