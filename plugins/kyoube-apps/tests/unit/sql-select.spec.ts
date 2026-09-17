import { describe, expect, it } from "vitest";
import { assertReadOnlySelect } from "../../src/data/sql-select.js";

/** The company's active tables. Every call needs them, so this keeps the cases readable. */
const TABLES = ["contacts", "deals", "t"];
const check = (sql: string, allowedTables: readonly string[] = TABLES): string => assertReadOnlySelect(sql, { allowedTables });

describe("assertReadOnlySelect", () => {
  it("accepts single SELECT statements, CTEs of selects, and unions", () => {
    expect(check("SELECT 1;")).toBe("SELECT 1");
    expect(check("with x as (select 1 as n) select n from x")).toContain("select n from x");
    expect(check("select 1 union all select 2")).toBe("select 1 union all select 2");
  });
  it("rejects anything that is not exactly one read-only select", () => {
    for (const bad of ["DELETE FROM t", "SELECT 1; SELECT 2", "with d as (delete from t returning *) select * from d", "insert into t values (1)", "select * into t2 from t", "", "SELECT FROM WHERE", "create table x (a int)"]) {
      expect(() => check(bad)).toThrow("invalid");
    }
    // NOT garbage: two consecutive bare words with no comma/AS is a genuine syntax error.
    expect(() => check("select * from t s extra")).toThrow("invalid");
  });
  it("rejects locking clauses", () => {
    expect(() => check("select * from t for update")).toThrow("invalid");
    expect(() => check("select 1 for share")).toThrow("invalid");
  });
  it("rejects a locking clause at any depth, not only the top level", () => {
    // Postgres refuses both of these in a READ ONLY transaction, so before this they reached the
    // database and came back as a mapped driver error instead of "invalid".
    expect(() => check("select * from (select id from t for update) x")).toThrow("invalid");
    expect(() => check("select * from contacts where id in (select id from t for no key update)")).toThrow("invalid");
    expect(() => check("with c as (select id from t for key share) select id from c")).toThrow("invalid");
    expect(() => check("select 1 union all select id from t for share")).toThrow("invalid");
  });
  it("returns exactly the statement's own text, ignoring a trailing comment", () => {
    expect(check("SELECT 1; -- comment")).toBe("SELECT 1");
    expect(check("SELECT 1 /* x */")).toBe("SELECT 1");
  });
  it("accepts a read-only WITH RECURSIVE", () => {
    const sql = "with recursive r(n) as (select 1 union all select n+1 from r where n < 3) select n from r";
    expect(check(sql)).toBe(sql);
  });
  it("does not truncate a statement ending in a bare parenthesised expression", () => {
    for (const sql of [
      "select a from t where (a = 1)",
      "select a from t order by (a)",
      "select a from t group by (a)",
      "select 1 where 1 in (1,2,3)",
      "values (1), (2)",
      "select ((1))",
    ]) {
      expect(check(sql)).toBe(sql);
    }
  });
  it("does not mistake a string literal's -- for a comment", () => {
    expect(check("select 'a--b'")).toBe("select 'a--b'");
  });
  it("strips a trailing comment whether or not a semicolon precedes it", () => {
    expect(check("select 1 -- c")).toBe("select 1");
    expect(check("select 1; -- c")).toBe("select 1");
    expect(check("select 1 /* c */;")).toBe("select 1");
  });
  it("keeps a trailing implicit table or subquery alias that this parser's location tracking drops", () => {
    expect(check("select * from t s")).toBe("select * from t s");
    expect(check("select * from (select 1) s")).toBe("select * from (select 1) s");
  });
  it("keeps a trailing implicit column alias too, even though it looks like a stray word", () => {
    // "SELECT 1 garbage" is valid Postgres shorthand for "SELECT 1 AS garbage" - the AST records
    // it as a real column alias, so this is not garbage to reject, just the same location-tracking
    // gap as the table-alias case above (confirmed via the parsed AST before writing this test).
    expect(check("SELECT 1 garbage")).toBe("SELECT 1 garbage");
  });
  it("recovers a dropped closing paren even past a join, up to a trailing comment", () => {
    const sql = "select d.title from deals d join contacts c on c.id = d.contact where (d.amount > 1) -- top";
    expect(check(sql)).toBe(sql.replace(/ -- top$/, ""));
  });
  it("rejects SQL text over the length cap", () => {
    const long = `select '${"x".repeat(20_000)}'`;
    expect(() => check(long)).toThrow("too long");
  });
});

describe("assertReadOnlySelect table allowlist (P2-R28)", () => {
  it("accepts the company's own tables referenced by bare name", () => {
    expect(check("select * from contacts")).toBe("select * from contacts");
    expect(check("select c.name, d.title from contacts c join deals d on d.contact = c.id")).toContain("join deals d");
    expect(check("select 1")).toBe("select 1");
  });
  it("accepts CTE names the statement declares, including a recursive self-reference", () => {
    expect(check("with recent as (select * from contacts) select * from recent")).toContain("from recent");
    expect(check("with recursive r(n) as (select 1 union all select n+1 from r where n < 3) select n from r")).toContain("from r");
    // A CTE shadows a same-named real table for the whole query (verified against Postgres 17:
    // "with pg_class as (select 1 as n) select n from pg_class" returns 1), so this is a
    // reference to the CTE, not to the catalog.
    expect(check("with pg_class as (select 1 as n) select n from pg_class")).toContain("from pg_class");
  });
  it("accepts a table function, which is not a table reference", () => {
    expect(check("select * from generate_series(1, 3)")).toBe("select * from generate_series(1, 3)");
  });
  it("rejects an unregistered table in every position the parser can put one", () => {
    for (const sql of [
      "select * from pg_class",
      "select * from contacts, pg_class",
      "select * from contacts join pg_class on true",
      "select * from contacts left join pg_class c2 on true",
      "select (select count(*) from pg_class) as n from contacts",
      "select * from contacts where id in (select oid from pg_class)",
      "select * from contacts where exists (select 1 from pg_class)",
      "select * from contacts where id = (select oid from pg_class)",
      "select * from (select * from pg_class) s",
      "with x as (select * from pg_class) select * from x",
      "select 1 from pg_class union select 1 from contacts",
      "select 1 from contacts union all select 1 from pg_class",
      "select * from contacts, lateral (select * from pg_class) s",
      "select * from contacts join lateral (select * from pg_class) s on true",
      "select 1 from contacts group by (select 1 from pg_class)",
      "select 1 from contacts group by name having count(*) > (select 1 from pg_class)",
      "select 1 from contacts order by (select 1 from pg_class)",
      "select 1 from contacts limit (select 1 from pg_class)",
      "select distinct on ((select 1 from pg_class)) * from contacts",
      "select count(*) over (partition by (select 1 from pg_class)) from contacts",
      "select count(*) over (order by (select 1 from pg_class)) from contacts",
      "select array(select oid from pg_class) from contacts",
      "select case when true then (select 1 from pg_class) else 0 end from contacts",
      "select * from contacts where id = any(select oid from pg_class)",
    ]) {
      expect(() => check(sql), sql).toThrow('unknown table "pg_class"');
    }
  });
  it("rejects every schema-qualified reference, including the company's own schema", () => {
    for (const sql of [
      "select relname from pg_catalog.pg_class",
      "select * from information_schema.columns",
      "select * from kyoube_meta.tables",
      "select * from c_11111111111111111111111111111111.contacts",
      "select * from public.contacts",
    ]) {
      expect(() => check(sql), sql).toThrow("invalid");
    }
    expect(() => check("select * from kyoube_meta.tables")).toThrow("kyoube_meta.tables");
  });
  it("does not let a CTE name escape its own scope", () => {
    // The outer pg_class is the real catalog table: the inner WITH binds pg_class only for the
    // scalar subquery it introduces.
    expect(() => check("select * from pg_class where 1 = (with pg_class as (select 1) select 1)")).toThrow('unknown table "pg_class"');
    // A non-recursive CTE body cannot see a CTE declared after it, so this pg_class is the
    // catalog too.
    expect(() => check("with a as (select * from pg_class), pg_class as (select 1) select * from a")).toThrow('unknown table "pg_class"');
  });
  it("fails closed on a quoted mixed-case name, which Postgres does not fold", () => {
    // Registered names are always lowercase, and the parser only lowercases *unquoted*
    // identifiers, so "Contacts" is a different table than contacts.
    expect(() => check('select * from "Contacts"')).toThrow('unknown table "Contacts"');
    expect(check("select * from CONTACTS")).toBe("select * from CONTACTS");
  });
  it("rejects a table that is not (or is no longer) registered", () => {
    expect(() => check("select * from deals", ["contacts"])).toThrow('unknown table "deals"');
    expect(() => check("select * from contacts", [])).toThrow('unknown table "contacts"');
  });
  it("rejects INTERSECT and EXCEPT, which this parser does not support at all", () => {
    // Not an allowlist decision: pgsql-ast-parser@12.0.2 has no INTERSECT/EXCEPT grammar, so
    // both fail to parse and never reach Postgres. Recorded here so a parser upgrade that adds
    // them shows up as a failing test rather than as an unchecked position.
    expect(() => check("select 1 from contacts intersect select 1 from pg_class")).toThrow("could not be parsed");
    expect(() => check("select 1 from contacts except select 1 from pg_class")).toThrow("could not be parsed");
  });
});

describe("assertReadOnlySelect function allowlist (P4-R11)", () => {
  it("accepts at least one function from every allowed category", () => {
    for (const sql of [
      // aggregates
      "select count(*), sum(amount), avg(amount), min(amount), max(amount) from deals",
      "select string_agg(name, ','), array_agg(name), bool_and(true), bool_or(false) from contacts",
      // string
      "select lower(name), upper(name), length(name), char_length(name), trim(name) from contacts",
      "select ltrim(name), rtrim(name), substring(name, 1, 2), substr(name, 1), left(name, 1), right(name, 1) from contacts",
      "select replace(name, 'a', 'b'), concat(name, name), concat_ws(',', name), position('a' in name), strpos(name, 'a') from contacts",
      "select split_part(name, ',', 1), initcap(name), lpad(name, 2), rpad(name, 2), repeat(name, 2), reverse(name) from contacts",
      "select starts_with(name, 'a'), regexp_replace(name, 'a', 'b'), regexp_match(name, 'a'), regexp_matches(name, 'a') from contacts",
      "select to_char(now(), 'YYYY'), format('%s', name) from contacts",
      // math
      "select abs(-1), round(1.5), ceil(1.2), ceiling(1.2), floor(1.2), trunc(1.5), mod(3, 2)",
      "select power(2, 3), sqrt(4), exp(1), ln(1), log(10), sign(-1), random(), greatest(1, 2), least(1, 2), width_bucket(1, 1, 2, 3)",
      // date/time
      "select now(), date_trunc('day', now()), date_part('day', now()), extract(year from now()), age(now())",
      "select make_date(2020, 1, 1), make_timestamp(2020, 1, 1, 0, 0, 0), to_date('2020-01-01', 'YYYY-MM-DD'), to_timestamp(1)",
      "select justify_days(age(now())), justify_hours(age(now())), justify_interval(age(now()))",
      // conditional
      "select coalesce(name, 'x'), nullif(name, 'x'), num_nonnulls(name), num_nulls(name) from contacts",
      // type / JSON
      "select to_jsonb(name), to_json(name), jsonb_build_object('a', name), jsonb_build_array(name) from contacts",
      "select jsonb_array_length('[]'::jsonb), jsonb_typeof('{}'::jsonb), jsonb_array_elements('[]'::jsonb), jsonb_array_elements_text('[]'::jsonb)",
      "select jsonb_each('{}'::jsonb), jsonb_each_text('{}'::jsonb), jsonb_object_keys('{}'::jsonb)",
      "select jsonb_extract_path('{}'::jsonb, 'a'), jsonb_extract_path_text('{}'::jsonb, 'a'), json_build_object('a', 1)",
      "select row_to_json(c) from contacts c",
      "select array_length(array[1], 1), array_to_string(array[1], ','), string_to_array('a,b', ','), cardinality(array[1])",
      "select array_position(array[1], 1), array_remove(array[1], 1), array_append(array[1], 2), unnest(array[1])",
      "select * from generate_series(1, 3)",
      // misc
      "select gen_random_uuid(), md5('x'), encode('x'::bytea, 'hex'), decode('78', 'hex'), quote_literal('x'), quote_ident('x')",
      // window functions
      "select row_number() over (), rank() over (), dense_rank() over (), ntile(2) over () from contacts",
      "select lag(name) over (), lead(name) over (), first_value(name) over (), last_value(name) over (), nth_value(name, 1) over () from contacts",
      "select percent_rank() over (), cume_dist() over () from contacts",
    ]) {
      expect(() => check(sql), sql).not.toThrow();
    }
  });

  it("rejects a function that is not on the allowlist, naming it", () => {
    expect(() => check("select pg_get_userbyid(1)")).toThrow('function "pg_get_userbyid" is not allowed in sql_select');
    for (const sql of [
      "select to_regclass('contacts')",
      "select pg_relation_size('contacts')",
      "select current_setting('is_superuser')",
      "select version()",
      "select pg_ls_dir('/')",
      "select pg_read_file('/etc/passwd')",
    ]) {
      expect(() => check(sql), sql).toThrow("is not allowed in sql_select");
    }
  });

  it("rejects a schema-qualified call even when the bare name is allowed, reporting the qualifier", () => {
    expect(() => check("select pg_catalog.count(*) from contacts")).toThrow('function "pg_catalog.count" is not allowed in sql_select');
  });

  it("rejects a disallowed function nested in a subquery, CTE, window clause, CASE, or DISTINCT ON", () => {
    for (const sql of [
      "select (select pg_relation_size('contacts')) from contacts",
      "select * from contacts where id in (select pg_relation_size('contacts'))",
      "with x as (select pg_read_file('/x') as c) select c from x",
      "select count(*) over (partition by pg_relation_size('contacts')) from contacts",
      "select count(*) over (order by pg_relation_size('contacts')) from contacts",
      "select case when true then version() else '' end from contacts",
      "select distinct on (pg_ls_dir('/')) * from contacts",
      "select count(*) filter (where pg_relation_size('contacts') > 0) from contacts",
      "select string_agg(name, ',' order by pg_relation_size('contacts')) from contacts",
      "select 1 from contacts group by pg_relation_size('contacts')",
      "select 1 from contacts order by pg_relation_size('contacts')",
      "select 1 from contacts limit pg_relation_size('contacts')",
      "select * from pg_ls_dir('/')",
    ]) {
      expect(() => check(sql), sql).toThrow("is not allowed in sql_select");
    }
  });

  it("rejects a cast to a reg* OID alias type, in both cast spellings", () => {
    expect(() => check("select 'pg_class'::regclass")).toThrow('cast to "regclass" is not allowed in sql_select');
    expect(() => check("select cast('pg_class' as regclass)")).toThrow('cast to "regclass" is not allowed in sql_select');
    for (const sql of [
      "select 'x'::regproc",
      "select 'x'::regtype",
      "select 'x'::regrole",
      "select 'x'::regnamespace",
      "select 'x'::regoper",
      "select 'x'::regconfig",
      "select 'x'::regdictionary",
      "select 'x'::regcollation",
      "select 'x'::regprocedure",
      "select 'x'::regoperator",
      "select 'x'::pg_catalog.regclass",
      "select '{}'::regclass[]",
      "select 'x'::text::regclass",
      "select (select 'x'::regclass) from contacts",
    ]) {
      expect(() => check(sql), sql).toThrow("is not allowed in sql_select");
    }
  });

  it("keeps ordinary casts working", () => {
    expect(check("select amount::text from deals")).toBe("select amount::text from deals");
    expect(check("select cast(amount as int) from deals")).toBe("select cast(amount as int) from deals");
    expect(check("select '[]'::jsonb")).toBe("select '[]'::jsonb");
  });

  it("leaves operators and the SQL constructs this parser models as calls alone", () => {
    // ANY/ALL/SOME/EXISTS/ROW are reserved SQL constructs, not function calls — but
    // pgsql-ast-parser@12.0.2 gives them a `call` node all the same. Their arguments are still
    // checked (the pg_class references below are what these reject on).
    expect(check("select * from contacts where name like 'a%' and id is not null")).toContain("like");
    expect(check("select row(id, name) from contacts")).toContain("row(id, name)");
    expect(() => check("select 1 from contacts where exists (select 1 from pg_class)")).toThrow('unknown table "pg_class"');
    expect(() => check("select 1 from contacts where id = any(select oid from pg_class)")).toThrow('unknown table "pg_class"');
    expect(() => check("select 1 from contacts where id = all(select oid from pg_class)")).toThrow('unknown table "pg_class"');
    expect(() => check("select 1 from contacts where id = some(select oid from pg_class)")).toThrow('unknown table "pg_class"');
  });

  it("fails closed on a quoted mixed-case function name, which Postgres does not fold either", () => {
    expect(() => check('select "COUNT"(*) from contacts')).toThrow('function "COUNT" is not allowed in sql_select');
  });

  // Three SQL "functions" have grammar of their own, and pgsql-ast-parser@12.0.2
  // gives each its own node type rather than a `call`: `overlay`, `substring`
  // and `extract`. The allowlist is keyed on call nodes, so it never sees them
  // — what has to hold is that their *arguments* are still visited, and that
  // the round-trip guard notices if a parser upgrade ever stops visiting them.
  it("allows overlay, substring and extract in their special syntax", () => {
    for (const sql of [
      "select overlay(name placing 'x' from 2 for 1) from contacts",
      "select overlay(name placing 'x' from 2) from contacts",
      "select substring(name from 2 for 1) from contacts",
      "select substring(name from 2) from contacts",
      "select extract(year from created_at) from contacts",
    ]) expect(() => check(sql), sql).not.toThrow();
    // The plain call spellings keep working through the allowlist itself.
    expect(() => check("select overlay(name, 'x', 2, 1) from contacts")).not.toThrow();
    expect(() => check("select substring(name, 1, 2) from contacts")).not.toThrow();
  });

  it("still checks what is inside a special-syntax node", () => {
    for (const sql of [
      "select overlay(name placing pg_read_file('/x') from 2) from contacts",
      "select overlay(pg_read_file('/x') placing 'y' from 2) from contacts",
      "select substring(pg_read_file('/x') from 2) from contacts",
      "select extract(year from pg_stat_file('/x')) from contacts",
    ]) expect(() => check(sql), sql).toThrow("is not allowed in sql_select");
    for (const sql of [
      "select overlay(name placing 'x' from 2) from pg_class",
      "select substring((select relname from pg_class limit 1) from 2)",
    ]) expect(() => check(sql), sql).toThrow('unknown table "pg_class"');
  });

  // `OPERATOR(schema.op)` is a *binary operator* node here, not a call, so the
  // schema-prefix rule that rejects `pg_catalog.count(*)` does not reach it.
  // What still holds is that both operands are ordinary expressions and are
  // checked like any other — which is what keeps this from being a way to
  // reach past the allowlists. Documented in `sql-functions.ts`'s header.
  it("checks both operands of a schema-qualified OPERATOR", () => {
    expect(() => check("select 1 OPERATOR(pg_catalog.+) (select count(*) from pg_class)")).toThrow('unknown table "pg_class"');
    expect(() => check("select 1 OPERATOR(pg_catalog.+) pg_relation_size('contacts')")).toThrow("is not allowed in sql_select");
  });
});
