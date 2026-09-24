export type DataErrorCode = "invalid" | "forbidden" | "not_found" | "conflict" | "limit";

export class DataError extends Error {
  readonly code: DataErrorCode;
  /**
   * The error this one was mapped from, when there was one. It is for operator logs only —
   * `message` is the whole caller-visible contract (ruling P4-R15 scrubs it), and nothing that
   * answers a request, a tool call, or an app may read this.
   */
  constructor(code: DataErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "DataError";
    this.code = code;
  }
}

/**
 * Ruling P4-R15: what a mapped error is allowed to say about *which* thing failed — the
 * constraint or column the driver names, and nothing else. `error.detail` is never used: for a
 * unique violation it is "Key (email)=(ada@example.com) already exists.", and for a check or
 * not-null violation it is the whole failing row, so quoting it would put row contents into a
 * caller-visible message (and, through it, into a tool result an agent may repeat). Constraint
 * and column names are schema, not data. The raw error still reaches the operator log untouched
 * (see tool-runtime.ts) — that is not the activity log.
 */
function namedSubject(error: object): string {
  const { constraint, column } = error as { constraint?: unknown; column?: unknown };
  if (typeof constraint === "string" && constraint.length > 0) return ` (constraint "${constraint}")`;
  if (typeof column === "string" && column.length > 0) return ` (column "${column}")`;
  return "";
}

/**
 * Maps a raw `pg` driver error (identified by its Postgres SQLSTATE `code`) to
 * the matching `DataError`, or returns null when the error isn't a recognised
 * Postgres error (including when it's already a `DataError`, whose `code` is
 * never one of these 5-character SQLSTATEs) so callers can rethrow it unchanged.
 */
export function mapPgError(error: unknown): DataError | null {
  if (typeof error !== "object" || error === null) return null;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (typeof code !== "string") return null;
  const subject = namedSubject(error);
  // The raw driver error rides along as `cause` for the operator log only; no caller-facing
  // surface reads it (they all answer with `message`).
  const as = (code2: DataErrorCode, message: string): DataError => new DataError(code2, message, { cause: error });
  switch (code) {
    case "23505": // unique_violation
    case "42P07": // duplicate_table (also raised for a duplicate index/view/sequence name)
    case "42710": // duplicate_object (a constraint name already taken — see renameTable's
                  // constraint renames, where two names can collide at 63 characters)
      return as("conflict", `already exists${subject}`);
    case "23514": // check_violation
    case "23502": // not_null_violation
    case "23503": // foreign_key_violation
    case "22P02": // invalid_text_representation
      return as("invalid", `invalid value${subject}`);
    case "42703": // undefined_column
    case "42P01": // undefined_table
    case "42704": // undefined_object (a constraint or other named object that is not there)
      return as("not_found", `not found${subject}`);
    case "57014": // query_canceled (statement timeout, or an explicit pg_cancel_backend)
      return as("limit", "the query exceeded its time limit");
    case "42501": // insufficient_privilege
      return as("forbidden", "the database refused this operation");
    default:
      return null;
  }
}
