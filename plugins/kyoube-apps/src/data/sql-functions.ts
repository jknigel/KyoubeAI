/**
 * Ruling P4-R11: what `sql_select` may call.
 *
 * The company role runs the statement, and `pg_catalog` is implicitly first on every search_path,
 * so a bare `pg_read_file(...)` or `current_setting(...)` needs no schema prefix to resolve. The
 * table allowlist in `sql-select.ts` closes the relation half of that hole; this closes the
 * function half, the same way: an allowlist of bare names, never a blocklist of prefixes.
 *
 * The list is deliberately conservative — everything on it is a pure, well-known
 * scalar/aggregate/window builtin that reads only its own arguments. Nothing here reads the
 * catalog, the filesystem, a setting, a sequence, or the server's identity, and no `pg_*`
 * function is on it at all. A caller who needs to introspect uses `data_list_tables` /
 * `data_describe_table` instead. Adding a name here is a security decision: it must not be able
 * to reach anything outside the arguments it is handed.
 *
 * Two things this list does *not* govern, both verified against pgsql-ast-parser@12.0.2:
 *
 * 1. **The three SQL functions with grammar of their own.** `overlay(x placing y from a for b)`,
 *    `substring(x from a for b)` and `extract(field from x)` parse to `ExprOverlay`,
 *    `ExprSubstring` and `ExprExtract` — their own node types, not `call` nodes — so the check
 *    keyed on calls never sees them and cannot refuse them. That is safe rather than merely
 *    tolerated: all three are pure builtins that read only their arguments (exactly what the
 *    list is for), the arguments themselves are ordinary expressions visited like any other, and
 *    `collectNodes` in sql-select.ts fails the statement closed if a parser upgrade ever stops
 *    visiting a call or a cast inside one. All three names are on the list anyway, for their
 *    plain-call spellings (`substring(x, 1, 2)`, `overlay(x, y, 1, 2)`), which do parse as calls.
 *
 * 2. **`OPERATOR(schema.op)`.** It parses to a binary *operator* node carrying an `opSchema`,
 *    not to a call, so the rule that rejects a schema-qualified `pg_catalog.count(*)` does not
 *    reach it: `1 OPERATOR(pg_catalog.+) 2` is accepted. What contains it is that an operator
 *    resolves to an operator, never to an arbitrary function by name — and that both operands
 *    are ordinary expressions, so a catalog table or a disallowed function inside one is still
 *    rejected. Only a user-defined operator in a reachable schema could widen this, and nothing
 *    in this plugin's surface creates one.
 */
export const ALLOWED_SQL_FUNCTIONS: ReadonlySet<string> = new Set([
  // aggregates
  "count", "sum", "avg", "min", "max", "string_agg", "array_agg", "bool_and", "bool_or",
  // string
  "lower", "upper", "length", "char_length", "trim", "ltrim", "rtrim", "substring", "substr", "overlay",
  "left", "right", "replace", "concat", "concat_ws", "position", "strpos", "split_part",
  "initcap", "lpad", "rpad", "repeat", "reverse", "starts_with", "regexp_replace",
  "regexp_match", "regexp_matches", "to_char", "format",
  // math
  "abs", "round", "ceil", "ceiling", "floor", "trunc", "mod", "power", "sqrt", "exp", "ln",
  "log", "sign", "random", "greatest", "least", "width_bucket",
  // date / time
  "now", "current_date", "current_timestamp", "current_time", "date_trunc", "date_part",
  "extract", "age", "make_date", "make_timestamp", "to_date", "to_timestamp", "justify_days",
  "justify_hours", "justify_interval",
  // conditional
  "coalesce", "nullif", "num_nonnulls", "num_nulls",
  // type / JSON / array
  "to_jsonb", "to_json", "jsonb_build_object", "jsonb_build_array", "jsonb_array_length",
  "jsonb_typeof", "jsonb_array_elements", "jsonb_array_elements_text", "jsonb_each",
  "jsonb_each_text", "jsonb_object_keys", "jsonb_extract_path", "jsonb_extract_path_text",
  "row_to_json", "json_build_object", "array_length", "array_to_string", "string_to_array",
  "unnest", "generate_series", "cardinality", "array_position", "array_remove", "array_append",
  // misc
  "gen_random_uuid", "md5", "encode", "decode", "quote_literal", "quote_ident",
  // window functions
  "row_number", "rank", "dense_rank", "lag", "lead", "first_value", "last_value", "ntile",
  "percent_rank", "cume_dist", "nth_value",
]);

/**
 * SQL constructs that pgsql-ast-parser@12.0.2 happens to model as `call` nodes even though they
 * are not function calls: the quantified comparisons (`= ANY (...)`, `= ALL (...)`,
 * `= SOME (...)`), `EXISTS (...)`, and the `ROW(...)` constructor. All five are *reserved* words
 * in Postgres, so none of them can name a user- or catalog-defined function in an expression —
 * writing `any(...)` cannot smuggle a call past the allowlist above. Their arguments are visited
 * like any other expression, so a catalog table or a disallowed function inside one is still
 * rejected. Operators proper (`||`, `->>`, `like`, …) are not call nodes at all and never reach
 * this check.
 */
export const SQL_CALL_CONSTRUCTS: ReadonlySet<string> = new Set(["any", "all", "some", "exists", "row"]);

/**
 * Postgres' OID alias types. A cast to one of these turns a plain string into a catalog
 * identifier (`'pg_class'::regclass`, `'pg_read_file(text)'::regprocedure`), which is a way to
 * ask the catalog a question without naming a catalog table or calling a catalog function — so
 * ruling P4-R11 rejects the whole family. Every other cast passes.
 *
 * The ruling enumerates nine; `regprocedure` and `regoperator` are the remaining two members of
 * the same family in Postgres 17 and are rejected too, because leaving them out would leave the
 * exact hole the other nine close.
 */
export const REJECTED_CAST_TYPES: ReadonlySet<string> = new Set([
  "regclass", "regcollation", "regconfig", "regdictionary", "regnamespace", "regoper",
  "regoperator", "regproc", "regprocedure", "regrole", "regtype",
]);
