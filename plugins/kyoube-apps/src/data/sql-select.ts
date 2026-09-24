import {
  astVisitor,
  parse,
  parseWithComments,
  type DataTypeDef,
  type ExprCall,
  type ExprCast,
  type PGComment,
  type QNameAliased,
  type SelectFromStatement,
  type Statement,
  type WithRecursiveStatement,
  type WithStatement,
} from "pgsql-ast-parser";
import { DataError } from "./errors.js";
import { ALLOWED_SQL_FUNCTIONS, REJECTED_CAST_TYPES, SQL_CALL_CONSTRUCTS } from "./sql-functions.js";

const MAX_SQL_LENGTH = 20_000;
const REFERENCE_HINT = "SQL may reference only this company's tables by bare name";

/**
 * A locking clause (FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE / FOR KEY SHARE) anywhere in the
 * tree, at any depth. The parser hangs `for` on the `select` node that carries it, so a subquery
 * in FROM (`select * from (select id from t for update) x`), one inside an `IN (…)`, or a CTE body
 * each keep their own — and checking only the statement handed in would let those through to
 * Postgres, which refuses them in a READ ONLY transaction. The caller would then see a mapped
 * driver error instead of `invalid`, which is a worse answer to the same question.
 *
 * Called once per statement, from `assertReadOnlySelect`.
 */
function hasLockingClause(node: unknown): boolean {
  if (Array.isArray(node)) return node.some((item) => hasLockingClause(item));
  if (typeof node !== "object" || node === null) return false;
  const record = node as Record<string, unknown>;
  if (record.type === "select" && record.for !== undefined && record.for !== null) return true;
  for (const [key, value] of Object.entries(record)) {
    if (key === "_location") continue;
    if (hasLockingClause(value)) return true;
  }
  return false;
}

function isReadOnly(statement: Statement): boolean {
  switch (statement.type) {
    // This parser has no SELECT ... INTO support (that input fails to parse before
    // reaching here), so the only way a "select" node stops being read-only is a
    // locking clause — settled for every depth by `hasLockingClause`, which
    // `assertReadOnlySelect` runs once over the whole tree before calling this.
    case "select":
      return true;
    case "union":
    case "union all":
      return isReadOnly(statement.left) && isReadOnly(statement.right);
    case "with":
      return statement.bind.every((cte) => isReadOnly(cte.statement)) && isReadOnly(statement.in);
    case "with recursive":
      return isReadOnly(statement.bind) && isReadOnly(statement.in);
    case "values":
      return true;
    default:
      return false;
  }
}

/**
 * pgsql-ast-parser@12.0.2's statement `_location.end` is unreliable in more than one way: it
 * lands before one or more trailing `)` on a bare parenthesised expression, and separately it
 * lands before a trailing *implicit* alias ("select * from t s" reports `end` right after "t",
 * not after "s" — "select 1 garbage" is the same bug on a column alias: "garbage" is a real,
 * parsed `AS garbage`, just not counted in the location span). Rather than patch each such shape
 * individually, this ignores the statement's own `_location.end` for the upper bound entirely.
 * It starts from the true end of the input and peels off only what is unambiguously trivia — a
 * comment with a known-exact `_location` (from `parseWithComments`), or a single trailing
 * whitespace/`;` character — stopping the instant neither applies. Whatever remains is real
 * statement content, whatever this parser's location bug says about it; genuinely invalid
 * trailing text (e.g. a second bare word with no comma/AS) fails to parse at all, so it never
 * reaches this function in the first place.
 */
function peelTrailingTrivia(sql: string, comments: readonly PGComment[]): number {
  let end = sql.length;
  for (;;) {
    const comment = comments.find((c) => c._location !== undefined && c._location.end === end);
    if (comment) {
      end = comment._location!.start;
      continue;
    }
    if (end > 0 && /[\s;]/.test(sql[end - 1]!)) {
      end -= 1;
      continue;
    }
    return end;
  }
}

interface CollectedNodes {
  tables: QNameAliased[];
  calls: ExprCall[];
  casts: ExprCast[];
}

/**
 * Every `{ type: "table" }`, `{ type: "call" }` and `{ type: "cast" }` node in the AST, wherever
 * it sits. Used only to cross-check the visitor pass below: a node the visitor never reported is
 * one the parser's own traversal does not reach, and an unchecked reference, call or cast must
 * fail closed rather than run.
 */
function collectNodes(node: unknown, out: CollectedNodes): void {
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  if (record.type === "table" && typeof record.name === "object" && record.name !== null) out.tables.push(record.name as QNameAliased);
  if (record.type === "call" && typeof record.function === "object" && record.function !== null) out.calls.push(record as unknown as ExprCall);
  if (record.type === "cast" && typeof record.to === "object" && record.to !== null) out.casts.push(record as unknown as ExprCast);
  for (const [key, value] of Object.entries(record)) {
    if (key !== "_location") collectNodes(value, out);
  }
}

function qualifiedName(qname: { schema?: string; name: string }): string {
  return qname.schema === undefined ? qname.name : `${qname.schema}.${qname.name}`;
}

/**
 * Ruling P4-R11: rejects a cast whose target type is one of Postgres' OID alias types, at any
 * array depth and under any schema — `'pg_class'::regclass` and `CAST('x' AS pg_catalog.regclass)`
 * alike. The parser lowercases unquoted type names; a double-quoted one keeps its case, and is
 * compared case-insensitively here so `'x'::"RegClass"` cannot slip through (Postgres has no such
 * type either way, so rejecting it costs nothing). Every other cast passes.
 */
function assertAllowedCastType(to: DataTypeDef): void {
  if (to.kind === "array") {
    assertAllowedCastType(to.arrayOf);
    return;
  }
  if (REJECTED_CAST_TYPES.has(to.name.toLowerCase())) {
    throw new DataError("invalid", `cast to "${qualifiedName(to)}" is not allowed in sql_select`);
  }
}

/**
 * Ruling P2-R28: rejects the statement unless every table it references is one of the company's
 * own active tables, named without a schema. `pg_catalog` is implicitly first on every
 * search_path, so rejecting qualified names alone would still leave a bare `pg_class` (and every
 * other catalog relation) readable by the company role — hence an allowlist of bare names, not
 * a blocklist of schemas.
 *
 * Ruling P4-R11 closes the same hole on the two other ways a statement can reach past its own
 * tables: an unqualified *function* name resolves against `pg_catalog` too (`pg_read_file`,
 * `current_setting`, `pg_relation_size`), and a cast to an OID alias type turns a string into a
 * catalog identifier. So every `call` must name an allowlisted function (a table function like
 * `from generate_series(1, 3)` is a call, not a table reference, and is allowlisted by name like
 * any other), and every `cast` must not target a `reg*` type.
 *
 * CTE names are tracked per scope rather than collected up front, because a CTE only shadows a
 * real table inside the query that binds it: in
 * `select * from pg_class where 1 = (with pg_class as (select 1) select 1)` the outer reference
 * is the catalog, and a non-recursive CTE body cannot see a sibling declared after it either.
 */
function assertAllowedReferences(statement: Statement, allowed: ReadonlySet<string>): void {
  const scopes: Array<Set<string>> = [];
  const checked = new Set<unknown>();
  const check = (ref: QNameAliased): void => {
    checked.add(ref);
    if (ref.schema !== undefined) throw new DataError("invalid", `${REFERENCE_HINT}; remove the schema prefix from "${ref.schema}.${ref.name}"`);
    if (scopes.some((scope) => scope.has(ref.name))) return;
    if (!allowed.has(ref.name)) throw new DataError("invalid", `${REFERENCE_HINT}; unknown table "${ref.name}"`);
  };
  const checkCall = (node: ExprCall): void => {
    checked.add(node);
    const { schema, name } = node.function;
    if (schema === undefined && (ALLOWED_SQL_FUNCTIONS.has(name) || SQL_CALL_CONSTRUCTS.has(name))) return;
    throw new DataError("invalid", `function "${qualifiedName(node.function)}" is not allowed in sql_select`);
  };
  const checkCast = (node: ExprCast): void => {
    checked.add(node);
    assertAllowedCastType(node.to);
  };

  // Verified against pgsql-ast-parser@12.0.2: the default traversal reports `tableRef` for FROM
  // (including comma-separated and every JOIN), subqueries in the select list, WHERE (IN /
  // EXISTS / ANY / scalar), GROUP BY, HAVING, ORDER BY, LIMIT, CASE, CAST, ARRAY(...), FILTER,
  // WITHIN GROUP and VALUES, for CTE bodies and both branches of UNION [ALL], and for LATERAL
  // subqueries in both the comma and JOIN forms. It does *not* descend into DISTINCT ON or the
  // OVER (PARTITION BY / ORDER BY) window clause, which are walked explicitly below; INTERSECT
  // and EXCEPT have no grammar in this parser at all, so they never parse.
  const visitor = astVisitor((v) => ({
    tableRef: (ref: QNameAliased) => check(ref),
    with: (node: WithStatement) => {
      const scope = new Set<string>();
      scopes.push(scope);
      // Each binding is visited before its own name is in scope: Postgres resolves a
      // non-recursive CTE body against the CTEs declared *before* it only.
      for (const bound of node.bind) {
        v.statement(bound.statement);
        scope.add(bound.alias.name);
      }
      v.statement(node.in);
      scopes.pop();
    },
    withRecursive: (node: WithRecursiveStatement) => {
      scopes.push(new Set([node.alias.name]));
      v.statement(node.bind);
      v.statement(node.in);
      scopes.pop();
    },
    selection: (node: SelectFromStatement) => {
      v.super().selection(node);
      if (Array.isArray(node.distinct)) for (const expr of node.distinct) v.expr(expr);
    },
    call: (node: ExprCall) => {
      checkCall(node);
      v.super().call(node);
      for (const expr of node.over?.partitionBy ?? []) v.expr(expr);
      for (const item of node.over?.orderBy ?? []) v.expr(item.by);
    },
    cast: (node: ExprCast) => {
      checkCast(node);
      v.super().cast(node);
    },
  }));
  visitor.statement(statement);

  // Defense in depth, in the same spirit as the round-trip guard below: if the traversal above
  // ever misses a position (a parser upgrade, or a shape not enumerated here), refuse the
  // statement instead of running an unchecked reference, call or cast.
  const every: CollectedNodes = { tables: [], calls: [], casts: [] };
  collectNodes(statement, every);
  for (const name of every.tables) {
    if (!checked.has(name)) throw new DataError("invalid", `${REFERENCE_HINT}; the reference to "${name.name}" is in a position this validator cannot check`);
  }
  for (const call of every.calls) {
    if (!checked.has(call)) throw new DataError("invalid", `the call to "${qualifiedName(call.function)}" is in a position this validator cannot check`);
  }
  for (const cast of every.casts) {
    if (!checked.has(cast)) throw new DataError("invalid", "a cast is in a position this validator cannot check");
  }
}

export interface ReadOnlySelectOptions {
  /**
   * The company's active table names. Required, so the reference check can never be skipped by
   * calling the structure check on its own.
   */
  allowedTables: readonly string[];
}

/**
 * Returns the parsed statement's own source text when `sql` is exactly one read-only SELECT that
 * references nothing but `options.allowedTables` (and its own CTEs), ignoring only trailing
 * whitespace, semicolons, and comments; throws DataError("invalid", ...) otherwise.
 */
export function assertReadOnlySelect(sql: string, options: ReadOnlySelectOptions): string {
  if (sql.length > MAX_SQL_LENGTH) throw new DataError("invalid", `sql is too long (max ${MAX_SQL_LENGTH} characters)`);
  if (sql.trim().length === 0) throw new DataError("invalid", "sql must contain one SELECT statement");
  let parsed: { ast: Statement[]; comments: PGComment[] };
  try {
    parsed = parseWithComments(sql, { locationTracking: true });
  } catch (error) {
    throw new DataError("invalid", `sql could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { ast, comments } = parsed;
  if (ast.length !== 1) throw new DataError("invalid", "sql must contain exactly one statement");
  const statement = ast[0]!;
  // One scan of the whole tree, here, rather than one inside every `isReadOnly` call: that function
  // recurses into union branches and CTE bodies, and re-scanning each subtree on the way down is
  // quadratic on a deeply nested statement for no extra coverage. The text this function returns is
  // a slice of exactly the statement scanned here, so the round-trip re-parse below cannot contain
  // a locking clause this pass missed.
  if (hasLockingClause(statement) || !isReadOnly(statement)) throw new DataError("invalid", "only read-only SELECT statements are allowed");
  const start = statement._location!.start;
  const end = peelTrailingTrivia(sql, comments);
  const result = sql.slice(start, end);

  // Defense in depth: this parser's location tracking has already proven unreliable more than
  // once (that's what peelTrailingTrivia works around above), so never trust it blindly a second
  // time either. Re-parse exactly the text we are about to return and require it to still be
  // exactly one read-only statement on its own, closing off any other boundary quirk this parser
  // might have that we have not yet enumerated.
  let roundTrip: Statement[];
  try {
    roundTrip = parse(result, { locationTracking: true });
  } catch (error) {
    throw new DataError("invalid", `sql round-trip failed to reparse: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (roundTrip.length !== 1 || !isReadOnly(roundTrip[0]!)) {
    throw new DataError("invalid", "sql round-trip did not reproduce a single read-only statement");
  }
  // Checked on the round-trip AST: that is the parse of exactly the text this returns to run.
  assertAllowedReferences(roundTrip[0]!, new Set(options.allowedTables));
  return result;
}
