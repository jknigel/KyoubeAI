import type { Pool, PoolClient } from "pg";
import { recordAudit, type AuditPlan } from "../data/audit.js";
import { DataError } from "../data/errors.js";

export interface CompanyScope {
  companyId: string;
  schema: string;
  role: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hex(companyId: string): string {
  if (!UUID_RE.test(companyId)) throw new DataError("invalid", `companyId "${companyId}" is not a uuid`);
  return companyId.toLowerCase().replace(/-/g, "");
}

export function schemaNameFor(companyId: string): string {
  return `c_${hex(companyId)}`;
}

export function roleNameFor(companyId: string): string {
  return `kyoube_c_${hex(companyId)}`;
}

const provisioned = new Map<string, CompanyScope>();

/**
 * Creates the company's NOLOGIN role and schema (owned by that role), grants
 * the role to the login role so it can SET ROLE, and records the company in
 * kyoube_meta. Safe to call repeatedly; cached per process after success.
 */
export async function ensureCompany(pool: Pool, companyId: string): Promise<CompanyScope> {
  const cached = provisioned.get(companyId);
  if (cached) return cached;
  const scope: CompanyScope = { companyId: companyId.toLowerCase(), schema: schemaNameFor(companyId), role: roleNameFor(companyId) };
  const client = await pool.connect();
  let provisionError: unknown;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [scope.schema]);
    // On Postgres 16+, a CREATEROLE login is no longer automatically able to
    // SET ROLE to a role it creates: CREATE ROLE only self-grants membership
    // WITH SET when createrole_self_grant includes 'set', and it defaults to
    // ''. Requesting it here makes the CREATE ROLE below hand the login role a
    // usable (SET-able) membership in the same statement. The explicit GRANT
    // that follows is kept as a fallback for a role that already existed
    // without a SET-able grant (e.g. created before this setting existed, or
    // by a session that had it unset); granting a membership that already
    // holds SET, or granting a role to itself, both fail harmlessly and are
    // tolerated below.
    await client.query("SET createrole_self_grant = 'set'");
    await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${scope.role}') THEN CREATE ROLE "${scope.role}" NOLOGIN NOINHERIT; END IF; END $$`);
    try {
      await client.query(`GRANT "${scope.role}" TO CURRENT_USER`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already a member|cannot be granted to itself/i.test(message)) throw error;
    }
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${scope.schema}" AUTHORIZATION "${scope.role}"`);
    // Naming the company role as owner above only required *membership* in it,
    // which the grants above already provide. But REVOKE and GRANT edit the
    // schema's ACL, and Postgres only lets the *current effective user* do
    // that (the schema owner, or a superuser) -- membership alone doesn't
    // count unless it also carries INHERIT, which this login role's grants
    // deliberately don't (see the createrole_self_grant comment above: SET,
    // not INHERIT). Assume the company role's identity for these two
    // statements, via the same SET-able membership, then hand the session
    // back to the login role (SESSION_USER, since CURRENT_USER now resolves
    // to the company role). The USAGE grant back is what lets the login role
    // see the schema at all -- e.g. via information_schema.schemata, which
    // (like the REVOKE) is gated on the querying role's own privileges, not
    // on being able to SET ROLE into the owner. It does not expose company
    // data: USAGE only permits resolving "schema.table" in a query, and every
    // table in the schema is still owned solely by the company role with no
    // privileges granted to anyone else, so the login role still cannot
    // select, insert, or otherwise touch a single row without first assuming
    // the company role via withCompany.
    await client.query(`SET ROLE "${scope.role}"`);
    try {
      await client.query(`REVOKE ALL ON SCHEMA "${scope.schema}" FROM PUBLIC`);
      await client.query(`GRANT USAGE ON SCHEMA "${scope.schema}" TO SESSION_USER`);
    } finally {
      // RESET ROLE takes no privilege of its own, so on a healthy connection it
      // cannot fail independently of the statements above; it only would if
      // the connection itself is already broken, in which case the next
      // statement (or the advisory unlock below) surfaces that failure anyway.
      // Swallow it here so it never masks a real error from REVOKE/GRANT.
      await client.query("RESET ROLE").catch(() => {});
    }
    await client.query(
      "INSERT INTO kyoube_meta.companies (company_id, schema_name, role_name) VALUES ($1, $2, $3) ON CONFLICT (company_id) DO NOTHING",
      [scope.companyId, scope.schema, scope.role],
    );
    await client.query("INSERT INTO kyoube_meta.company_settings (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING", [scope.companyId]);
  } catch (error) {
    provisionError = error;
  } finally {
    // The unlock must still run on this exact client, so it happens here
    // (before either release path below) regardless of success or failure.
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [scope.schema]).catch(() => {});
  }
  if (provisionError !== undefined) {
    // A mid-provisioning failure may leave the session's role or other
    // per-connection state non-default; hand the error to release() so pg
    // destroys this connection instead of returning a suspect one to the pool.
    client.release(provisionError as Error);
    throw provisionError;
  }
  client.release();
  provisioned.set(companyId, scope);
  return scope;
}

/** Test hook: forget the provisioning cache (a fresh database in tests). */
export function resetCompanyCache(): void {
  provisioned.clear();
}

export interface ScopedClient {
  client: PoolClient;
  asOwner(): Promise<void>;
  asCompany(): Promise<void>;
}

export interface WithCompanyOptions<T> {
  readOnly?: boolean;
  statementTimeoutMs?: number;
  /**
   * Ruling P4-R12: the audit row for this mutation, built from `fn`'s own result. It is inserted
   * on this same client, after `fn` resolves and before COMMIT, so the change and the record of
   * it are one transaction: either both land or neither does.
   */
  audit?: AuditPlan<T>;
}

export async function withCompany<T>(
  pool: Pool,
  scope: CompanyScope,
  fn: (scoped: ScopedClient) => Promise<T>,
  opts: WithCompanyOptions<T> = {},
): Promise<T> {
  // scope is often assembled or passed around by callers rather than freshly
  // returned from ensureCompany; verify it against the deterministic names
  // before it is interpolated into SQL run with this role's privileges.
  // schemaNameFor also throws "invalid" for a non-uuid companyId.
  if (scope.schema !== schemaNameFor(scope.companyId) || scope.role !== roleNameFor(scope.companyId)) {
    throw new DataError("invalid", `company scope for "${scope.companyId}" does not match its derived schema/role`);
  }
  if (opts.statementTimeoutMs !== undefined && !Number.isFinite(opts.statementTimeoutMs)) {
    throw new DataError("invalid", "statementTimeoutMs must be a finite number");
  }
  // A read-only transaction cannot write the audit row, and a read needs no audit row: asking
  // for both is a programming error, refused here rather than half-way through the transaction.
  if (opts.readOnly && opts.audit) {
    throw new DataError("invalid", "a read-only scoped transaction cannot carry an audit payload");
  }
  const client = await pool.connect();
  const timeout = Math.max(100, Math.floor(opts.statementTimeoutMs ?? 10_000));
  /** Set only when the connection cannot be trusted again; see the catch below. */
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN");
    if (opts.readOnly) await client.query("SET TRANSACTION READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${timeout}`);
    // pg_temp listed explicitly, and last: if omitted, Postgres searches the
    // session's temp schema *first* regardless of search_path, so a temp
    // table could otherwise shadow a same-named table in the company schema.
    await client.query(`SET LOCAL search_path TO "${scope.schema}", pg_temp`);
    await client.query(`SET LOCAL ROLE "${scope.role}"`);
    const result = await fn({
      client,
      asOwner: async () => { await client.query("RESET ROLE"); },
      asCompany: async () => { await client.query(`SET LOCAL ROLE "${scope.role}"`); },
    });
    // Ruling P4-R12: the audit row joins the mutation's transaction. The company role cannot see
    // kyoube_meta at all, so the session drops back to the login role (which owns it) first —
    // `fn` may or may not have already done that via asOwner(), and RESET ROLE is idempotent. A
    // failure here throws, so the catch below rolls the mutation back with it: a change is never
    // committed without its audit row.
    const entry = opts.audit?.(result) ?? null;
    if (entry) {
      await client.query("RESET ROLE");
      await recordAudit(client, entry);
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // A ROLLBACK that itself failed leaves this connection in an unknown state — possibly still
      // inside the transaction, possibly still under SET LOCAL ROLE. Hand that error to release()
      // (as `ensureCompany` does with its own failure) so pg destroys the connection instead of
      // returning a suspect one to the pool. A ROLLBACK that succeeded needs none of this: it ends
      // the transaction, and with it every SET LOCAL this function made.
      releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}
