import { DataError } from "./errors.js";

export const IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,62}$/;
export const SYSTEM_COLUMNS = ["id", "created_at", "updated_at", "created_by_kind", "created_by_id"] as const;
const RESERVED_PREFIXES = ["kyoube_", "pg_", "_trash_"];
const RESERVED_WORDS = new Set([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric", "authorization", "binary", "both", "case", "cast",
  "check", "collate", "column", "concurrently", "constraint", "create", "cross", "current_date", "current_role", "current_time",
  "current_timestamp", "current_user", "default", "deferrable", "desc", "distinct", "do", "else", "end", "except", "false", "fetch",
  "for", "foreign", "freeze", "from", "full", "grant", "group", "having", "ilike", "in", "initially", "inner", "intersect", "into",
  "is", "isnull", "join", "lateral", "leading", "left", "like", "limit", "localtime", "localtimestamp", "natural", "not", "notnull",
  "null", "offset", "on", "only", "or", "order", "outer", "overlaps", "placing", "primary", "references", "returning", "right",
  "select", "session_user", "similar", "some", "symmetric", "table", "tablesample", "then", "to", "trailing", "true", "union",
  "unique", "user", "using", "variadic", "verbose", "when", "where", "window", "with",
]);

export function assertIdentifier(value: unknown, what: string): string {
  if (typeof value !== "string") throw new DataError("invalid", `${what} must be a string`);
  const name = value.trim();
  if (!IDENTIFIER_RE.test(name)) throw new DataError("invalid", `${what} "${value}" must match ^[a-z][a-z0-9_]{0,62}$`);
  if (RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) throw new DataError("invalid", `${what} "${name}" uses a reserved prefix`);
  if ((SYSTEM_COLUMNS as readonly string[]).includes(name)) throw new DataError("invalid", `${what} "${name}" is a system column`);
  if (RESERVED_WORDS.has(name)) throw new DataError("invalid", `${what} "${name}" is a reserved SQL word`);
  return name;
}

/** Quotes an identifier that was validated with assertIdentifier (or a system/internal name that is plain). */
export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new DataError("invalid", `cannot quote identifier "${name}"`);
  return `"${name}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
