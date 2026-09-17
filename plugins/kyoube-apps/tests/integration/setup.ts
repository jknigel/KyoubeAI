import { randomBytes } from "node:crypto";
import pg from "pg";
import { configureTypeParsers } from "../../src/db/pool.js";

configureTypeParsers();

/**
 * Creates an isolated database owned by a non-superuser role shaped like
 * production (`kyoube`: LOGIN, CREATEROLE, NOINHERIT). Requires
 * KYOUBE_TEST_DATABASE_URL pointing at a superuser connection.
 */
export async function createTestDatabase(): Promise<{ pool: pg.Pool; url: string; close(): Promise<void> }> {
  const adminUrl = process.env.KYOUBE_TEST_DATABASE_URL;
  if (!adminUrl) throw new Error("KYOUBE_TEST_DATABASE_URL is required for integration tests (see scripts/dev-db.sh)");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const suffix = randomBytes(4).toString("hex");
  const dbName = `kyoube_test_${suffix}`;
  const roleName = `kyoube_test_${suffix}`;
  await admin.query(`CREATE ROLE ${roleName} LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT`);
  await admin.query(`CREATE DATABASE ${dbName} OWNER ${roleName}`);
  await admin.end();
  const parsed = new URL(adminUrl);
  parsed.username = roleName;
  parsed.password = "test";
  parsed.pathname = `/${dbName}`;
  const url = parsed.toString();
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  return {
    pool,
    url,
    async close() {
      await pool.end();
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      // Company roles created by the tests are owned by the test role; drop them with it.
      await cleanup.query(`DROP OWNED BY ${roleName} CASCADE`).catch(() => {});
      // Only the company roles *this run* created: on PG16+ a CREATEROLE role is
      // automatically granted ADMIN OPTION on every role it creates, so this
      // membership is exactly the set to sweep. A bare `rolname LIKE 'kyoube_c_%'`
      // would drop another run's roles out from under it. (Two runs against one
      // server still collide anyway — company role names derive deterministically
      // from the fixed company UUIDs the tests use — so concurrent runs against a
      // shared server are unsupported regardless.)
      const owned = await cleanup.query<{ rolname: string }>(
        `SELECT r.rolname
           FROM pg_roles r
           JOIN pg_auth_members m ON m.roleid = r.oid
           JOIN pg_roles g ON g.oid = m.member
          WHERE g.rolname = $1 AND m.admin_option AND r.rolname LIKE 'kyoube_c_%'`,
        [roleName],
      );
      for (const row of owned.rows) await cleanup.query(`DROP ROLE IF EXISTS ${row.rolname}`).catch(() => {});
      await cleanup.query(`DROP ROLE IF EXISTS ${roleName}`);
      await cleanup.end();
    },
  };
}
