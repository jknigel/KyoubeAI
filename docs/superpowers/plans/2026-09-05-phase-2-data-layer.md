# Phase 2 — Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents with permission (and humans through the UI) can design and populate an organisation database — tables, fields, records, read-only SQL — isolated per company inside the dedicated `kyoube` Postgres database, exposed to agents as MCP tools, REST routes, and a managed skill, and governed by per-agent grant levels.

**Architecture:** `@kyoube/plugin-apps` (id `kyoube.apps`) owns a `pg` pool to the `kyoube` database. Metadata lives in schema `kyoube_meta`; each Paperclip company gets its own schema `c_<hex>` owned by a NOLOGIN role `kyoube_c_<hex>`, and every data operation runs inside a transaction that does `SET LOCAL ROLE` + `search_path` + `statement_timeout`, so isolation is enforced by Postgres. One `DataService` façade (actor-aware) is exposed through three thin adapters: plugin tools, scoped API routes, and UI data/actions.

**Tech Stack:** `@paperclipai/plugin-sdk@2026.831.1`, `pg@^8.23.0`, `pgsql-ast-parser@^12.0.2`, `zod@^4.5.4` (validation + `z.toJSONSchema` for tool schemas), esbuild, Vitest (unit + integration against a real Postgres 17).

**Spec:** `docs/superpowers/specs/2026-09-05-kyoubeai-architecture-design.md` §8.1–8.3, §10, §13 Phase 2. Builds on Phases 0–1.

> **Post-execution notes (2026-09-07).** Phase 2 is implemented; where the code differs from the snippets below, the code and the rulings P2-R1..R31 recorded during execution are authoritative. Substantive deviations: `kyoube_meta.tables` uses a partial unique index on active names so a trashed name can be reused (P2-R4); provisioning sets `createrole_self_grant = 'set'` before `CREATE ROLE`, revokes PUBLIC schema access under `SET ROLE`, and grants the login role USAGE on each company schema (P2-R3/R15); `withCompany` re-derives and checks the scope's schema/role names, uses `search_path "<schema>", pg_temp`, and requires a finite timeout (P2-R16); `coerceValue` gates by field kind before coercing (P2-R14); SQL reserved words stay rejected as identifiers (P2-R13); the read-only SQL validator derives the statement boundary from `parseWithComments` comment spans (the parser's `_location.end` under-reports trailing parens and implicit aliases), caps input at 20,000 characters, round-trip-parses the sliced text, rejects locking clauses, accepts `with recursive` (P2-R17–R19), and — after the final review — allows only bare-name references to the company's active tables or to CTEs declared in the enclosing statement (CTE names are scoped to their binding; any table reference the AST visitor did not visit is rejected by a cross-check; `INTERSECT`/`EXCEPT` have no grammar in pgsql-ast-parser 12 and fail closed), because `pg_catalog` is world-readable and would otherwise reveal other companies' table, column, and role names (P2-R28; catalog *functions* remain a Phase 4 security-review item); the records service wraps statements on their own lines; the schema service budgets trash-name suffixes, renames choices constraints on rename, refuses to drop a table another active table relates to, rewrites `relationTable` on rename, uses `MAX(position)+1`, and maps Postgres errors through a shared `mapPgError` (23505/42P07 → conflict, 23514/23502/23503/22P02 → invalid, 42703/42P01 → not_found, 57014 → limit, 42501 → forbidden; P2-R21/R22); `setCompanySettings` is one atomic COALESCE upsert (P2-R20); `DataService` keeps its schema/records services private, exposes `systemActor()` for the purge job, and routes `onMutation` failures to `onMutationError` instead of failing committed writes, while audit rows are still written outside the mutation's transaction (P2-R23, Phase 4); tools and routes return a generic `internal error` for non-`DataError`s and log the detail (P2-R24); `onApiRequest` returns 503 and `onHealth` reports `degraded` until setup completes (P2-R5/R25); UI data reads take `userId` from params — client-supplied and advisory, safe only because the host gates company membership and reads need only `read` (P2-R10 as re-stated by P2-R29); `usePluginData` params are memoised and the edit form is keyed by row id (P2-R26/R27); the `companySettingsPage` slot needs the `instance.settings.register` capability (found by the smoke); the smoke expects two bundled plugins and proves a REST data round-trip, 17 registered tools, an activity line without row contents, and audit rows (P2-R8/R11); filter `eq`/`neq` with `null` compile to `IS NULL`/`IS NOT NULL` (P2-R31); the `attachment` field kind from spec §8.1 is deferred (P2-R30). Manual acceptance (Task 13 Step 3) is still owed. Deferred minors and Phase 4 carry-overs are recorded in the Phase 4 plan's Task 5 note.

## Global Constraints

- Same toolchain rules as Phase 0 (SDK pinned `2026.831.1`, ESM, strict TS, NodeNext `.js` imports, Conventional Commits).
- Plugin id `kyoube.apps`; npm `@kyoube/plugin-apps`; deployed to `/opt/kyoube/plugins/apps`; page route `data`; company settings route `data-access`.
- Postgres objects: metadata schema `kyoube_meta`; company schema `c_<companyId hex, no dashes>`; company role `kyoube_c_<hex>`; login role `kyoube` (CREATEROLE, NOINHERIT, from Phase 0's init script).
- Identifiers: `^[a-z][a-z0-9_]{0,62}$`, never prefixed `kyoube_`, `pg_`, or `_trash_`, never a system column (`id`, `created_at`, `updated_at`, `created_by_kind`, `created_by_id`), never a SQL reserved word.
- Field kinds (exhaustive): `text, long_text, integer, decimal, boolean, date, datetime, json, select, multi_select, relation, email, url`.
- Access levels (ordered): `none < read < write < schema`. Humans: `viewer→read`, `member/operator→write`, `owner/admin→schema`. Agents: `kyoube_meta.agent_grants` row or the company default (default `none`).
- Limits: insert ≤ 500 rows/call; query `limit` ≤ 1000 (default 50); `sql_select` ≤ 1000 rows, single SELECT, 5 s timeout; statement timeout 10 s for everything else; destructive schema ops are soft (rename to `_trash_<name>_<unix seconds>`), purged after 30 days.
- Tool names (namespaced by the host as `kyoube.apps:<name>`): `data_list_tables, data_describe_table, data_create_table, data_add_field, data_update_field, data_remove_field, data_drop_table, data_rename_table, data_create_index, data_insert, data_update, data_delete, data_get, data_query, data_count, data_sql_select, data_my_access`.
- Every mutation writes `kyoube_meta.audit` (actor kind/id, run id, operation, table, details) and a one-line `ctx.activity.log` entry; row *contents* are never written to the Paperclip activity log.
- Error contract: `DataError` with `code ∈ invalid | forbidden | not_found | conflict | limit`, message `<code>: <text>`.

---

## File structure

```
plugins/kyoube-apps/
├─ package.json · tsconfig.json · build.mjs · vitest.config.ts · vitest.integration.config.ts
├─ migrations/0001_meta.sql
├─ src/manifest.ts · src/worker.ts · src/plugin.ts
├─ src/kyoube-config.ts            # reads /paperclip/kyoube/config.json (same shape as Phase 1)
├─ src/roles.ts                    # RoleResolver (same logic as Phase 1's auth.ts)
├─ src/db/pool.ts                  # createPool(url)
├─ src/db/migrate.ts               # runMetaMigrations(pool, dir)
├─ src/db/company-scope.ts         # schemaNameFor/roleNameFor/ensureCompany/withCompany
├─ src/data/errors.ts              # DataError
├─ src/data/identifiers.ts
├─ src/data/field-kinds.ts
├─ src/data/filter.ts              # compileWhere/compileQuery
├─ src/data/sql-select.ts          # assertReadOnlySelect
├─ src/data/permissions.ts         # levels, roleToLevel, DataActor
├─ src/data/grants.ts              # agent grants + company settings repo
├─ src/data/audit.ts
├─ src/data/schema-service.ts
├─ src/data/records-service.ts
├─ src/data/service.ts             # DataService façade
├─ src/tools.ts                    # tool declarations (zod → JSON schema) + registration
├─ src/api-routes.ts               # apiRoutes declarations + onApiRequest dispatcher
├─ src/skills/kyoube-data.md       # managed skill text (imported as text)
├─ src/ui/index.tsx · SidebarEntry.tsx · DataPage.tsx · CompanySettingsPage.tsx · forms.tsx
└─ tests/unit/*.spec.ts · tests/integration/{setup.ts,*.spec.ts} · tests/stub-service.ts
scripts/dev-db.sh                  # local Postgres for integration tests
docker/Dockerfile · .github/workflows/ci.yml · scripts/smoke.sh · README.md (modified)
```

---

### Task 1: Package skeleton, config, pool, metadata migrations, container wiring

**Files:**
- Create: `plugins/kyoube-apps/package.json`, `tsconfig.json`, `build.mjs`, `vitest.config.ts`, `vitest.integration.config.ts`, `migrations/0001_meta.sql`, `src/manifest.ts`, `src/worker.ts`, `src/kyoube-config.ts`, `src/db/pool.ts`, `src/db/migrate.ts`, `tests/integration/setup.ts`, `scripts/dev-db.sh`
- Modify: `docker/Dockerfile`, `.github/workflows/ci.yml`
- Test: `tests/integration/migrate.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export function createPool(url: string, opts?: { max?: number }): Pool;                       // pg Pool, application_name "kyoube-apps"
  export async function runMetaMigrations(pool: Pool, dir: string): Promise<string[]>;        // applies *.sql in name order once; checksum-verified; returns applied names
  export interface KyoubeRuntimeConfig { home: string; hermesHome: string; dataDatabaseUrl: string; publicUrl: string; paperclipApiUrl: string }
  export async function readKyoubeConfig(filePath?: string): Promise<KyoubeRuntimeConfig>;
  // tests/integration/setup.ts
  export async function createTestDatabase(): Promise<{ pool: Pool; url: string; close(): Promise<void> }>; // needs KYOUBE_TEST_DATABASE_URL (superuser); creates role kyoube_test (CREATEROLE NOINHERIT) + db kyoube_test_<random>
  ```

- [ ] **Step 1: Create the package**

`plugins/kyoube-apps/package.json`:
```json
{
  "name": "@kyoube/plugin-apps",
  "version": "0.1.0",
  "description": "KyoubeAI organisation database and apps (Paperclip plugin)",
  "license": "MIT",
  "type": "module",
  "files": ["dist", "migrations", "package.json", "README.md"],
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js",
    "ui": "./dist/ui/"
  },
  "scripts": {
    "build": "node build.mjs",
    "test": "vitest run",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@paperclipai/plugin-sdk": "2026.831.1",
    "pg": "^8.23.0",
    "pgsql-ast-parser": "^12.0.2",
    "zod": "^4.5.4"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/pg": "^8.23.1",
    "@types/react": "^19.2.18",
    "@types/react-dom": "^19.2.5",
    "esbuild": "^0.28.2",
    "react": "^19.2.8",
    "react-dom": "^19.2.8",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  },
  "peerDependencies": { "react": ">=18" },
  "engines": { "node": ">=24.11.0" }
}
```

`plugins/kyoube-apps/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "rootDir": ".", "lib": ["ES2023", "DOM"], "jsx": "react-jsx" },
  "include": ["src", "tests"]
}
```

`plugins/kyoube-apps/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/unit/**/*.spec.ts", "tests/unit/**/*.spec.tsx"], environment: "node" } });
```

`plugins/kyoube-apps/vitest.integration.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["tests/integration/**/*.spec.ts"], environment: "node", fileParallelism: false, testTimeout: 30_000, hookTimeout: 30_000 },
});
```

`plugins/kyoube-apps/build.mjs`:
```js
import esbuild from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

await esbuild.build({
  entryPoints: { manifest: "src/manifest.ts", worker: "src/worker.ts" },
  outdir: "dist",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: ["node24"],
  loader: { ".md": "text" },
  sourcemap: true,
  logLevel: "info",
});

await esbuild.build({
  entryPoints: { "ui/index": "src/ui/index.tsx" },
  outdir: "dist",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  external: ["react", "react-dom", "react/jsx-runtime", "@paperclipai/plugin-sdk/ui"],
  loader: { ".css": "text" },
  sourcemap: true,
  logLevel: "info",
});
```

Also add `plugins/kyoube-apps/src/md.d.ts`:
```ts
declare module "*.md" {
  const text: string;
  export default text;
}
```

- [ ] **Step 2: Write the metadata migration**

`plugins/kyoube-apps/migrations/0001_meta.sql`:
```sql
CREATE SCHEMA IF NOT EXISTS kyoube_meta;

CREATE TABLE IF NOT EXISTS kyoube_meta.migrations (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kyoube_meta.companies (
  company_id text PRIMARY KEY,
  schema_name text NOT NULL UNIQUE,
  role_name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kyoube_meta.company_settings (
  company_id text PRIMARY KEY REFERENCES kyoube_meta.companies(company_id) ON DELETE CASCADE,
  default_agent_level text NOT NULL DEFAULT 'none',
  hard_delete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kyoube_meta.agent_grants (
  company_id text NOT NULL REFERENCES kyoube_meta.companies(company_id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  level text NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, agent_id)
);

CREATE TABLE IF NOT EXISTS kyoube_meta.tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL REFERENCES kyoube_meta.companies(company_id) ON DELETE CASCADE,
  name text NOT NULL,
  display_name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  trash_name text,
  trashed_at timestamptz,
  created_by_kind text,
  created_by_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS kyoube_meta.fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES kyoube_meta.tables(id) ON DELETE CASCADE,
  name text NOT NULL,
  display_name text NOT NULL,
  description text,
  kind text NOT NULL,
  required boolean NOT NULL DEFAULT false,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (table_id, name)
);

CREATE TABLE IF NOT EXISTS kyoube_meta.audit (
  id bigserial PRIMARY KEY,
  company_id text NOT NULL,
  actor_kind text NOT NULL,
  actor_id text,
  run_id text,
  operation text NOT NULL,
  table_name text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_company_created_idx ON kyoube_meta.audit (company_id, created_at DESC);
```

- [ ] **Step 3: Write config reader, pool, and migration runner**

`plugins/kyoube-apps/src/kyoube-config.ts` — identical content to Phase 1's `plugins/kyoube-terminal/src/kyoube-config.ts` (copy it verbatim; the two plugins are deployed independently).

`plugins/kyoube-apps/src/db/pool.ts`:
```ts
import pg from "pg";

export type { Pool, PoolClient } from "pg";

export function createPool(url: string, opts: { max?: number } = {}): pg.Pool {
  return new pg.Pool({ connectionString: url, max: opts.max ?? 8, application_name: "kyoube-apps" });
}
```

`plugins/kyoube-apps/src/db/migrate.ts`:
```ts
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

/** Applies migrations/*.sql in filename order exactly once; a changed, already-applied file is an error. */
export async function runMetaMigrations(pool: Pool, dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(7245901)");
    await client.query("CREATE SCHEMA IF NOT EXISTS kyoube_meta");
    await client.query(
      "CREATE TABLE IF NOT EXISTS kyoube_meta.migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of files) {
      const sql = await readFile(path.join(dir, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>("SELECT checksum FROM kyoube_meta.migrations WHERE name = $1", [name]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`migration ${name} was modified after being applied`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO kyoube_meta.migrations (name, checksum) VALUES ($1, $2)", [name, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      applied.push(name);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(7245901)").catch(() => {});
    client.release();
  }
}

/**
 * Resolves <package>/migrations from any module in the package:
 * dist/worker.js → ../migrations; src/db/migrate.ts and tests/integration/*.ts → ../../migrations.
 */
export function migrationsDirFrom(moduleUrl: string): string {
  const here = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [path.resolve(here, "..", "migrations"), path.resolve(here, "..", "..", "migrations")];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
```

- [ ] **Step 4: Write the minimal manifest and worker (completed in Task 11)**

`plugins/kyoube-apps/src/manifest.ts`:
```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "kyoube.apps";
export const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kyoube Data & Apps",
  description: "Organisation database and AI-built apps for KyoubeAI.",
  author: "KyoubeAI",
  categories: ["workspace", "automation", "ui"],
  capabilities: [],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
};

export default manifest;
```

`plugins/kyoube-apps/src/worker.ts`:
```ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./manifest.js";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_ID} worker started (skeleton)`);
  },
  async onHealth() {
    return { status: "ok", message: `${PLUGIN_ID} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

`plugins/kyoube-apps/src/ui/index.tsx` (placeholder export so the UI bundle builds; replaced in Task 12):
```tsx
export function SidebarEntry() {
  return null;
}
```

- [ ] **Step 5: Integration test infrastructure**

`scripts/dev-db.sh`:
```bash
#!/usr/bin/env bash
# Starts a throwaway Postgres 17 for integration tests and prints the URL to export.
set -euo pipefail
docker rm -f kyoube-dev-db >/dev/null 2>&1 || true
docker run -d --name kyoube-dev-db -e POSTGRES_PASSWORD=dev -p 5433:5432 postgres:17-alpine >/dev/null
for i in $(seq 1 30); do docker exec kyoube-dev-db pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
echo "export KYOUBE_TEST_DATABASE_URL=postgres://postgres:dev@localhost:5433/postgres"
```

`plugins/kyoube-apps/tests/integration/setup.ts`:
```ts
import { randomBytes } from "node:crypto";
import pg from "pg";

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
      const owned = await cleanup.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname LIKE 'kyoube_c_%'");
      for (const row of owned.rows) await cleanup.query(`DROP ROLE IF EXISTS ${row.rolname}`).catch(() => {});
      await cleanup.query(`DROP ROLE IF EXISTS ${roleName}`);
      await cleanup.end();
    },
  };
}
```

`plugins/kyoube-apps/tests/integration/migrate.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { db = await createTestDatabase(); });
afterAll(async () => { await db.close(); });

describe("runMetaMigrations", () => {
  it("applies the metadata schema once and is idempotent", async () => {
    const dir = migrationsDirFrom(import.meta.url.replace("tests/integration/migrate.spec.ts", "src/db/migrate.ts"));
    const first = await runMetaMigrations(db.pool, dir);
    expect(first).toEqual(["0001_meta.sql"]);
    expect(await runMetaMigrations(db.pool, dir)).toEqual([]);
    const tables = await db.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'kyoube_meta' ORDER BY table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(["agent_grants", "audit", "companies", "company_settings", "fields", "migrations", "tables"]);
  });
});
```

- [ ] **Step 6: Wire the plugin into the image and CI**

In `docker/Dockerfile`, stage `kyoube-build`: add `COPY plugins/kyoube-apps/package.json plugins/kyoube-apps/` next to the terminal `COPY`, and add `&& pnpm --filter @kyoube/plugin-apps deploy --prod /out/plugins/apps && test -f /out/plugins/apps/dist/manifest.js` to the build `RUN`.

In `.github/workflows/ci.yml`, job `unit`: add a Postgres service and the integration run:
```yaml
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_PASSWORD: ci
        ports: ["5433:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      KYOUBE_TEST_DATABASE_URL: postgres://postgres:ci@localhost:5433/postgres
```
and after `- run: pnpm test` add `- run: pnpm --filter @kyoube/plugin-apps test:integration`.

- [ ] **Step 7: Install, run, build, commit**

Run: `pnpm install && bash scripts/dev-db.sh` then `export KYOUBE_TEST_DATABASE_URL=postgres://postgres:dev@localhost:5433/postgres` and `pnpm --filter @kyoube/plugin-apps test:integration && pnpm --filter @kyoube/plugin-apps build`
Expected: integration test PASS; `dist/manifest.js`, `dist/worker.js`, `dist/ui/index.js` exist.

```bash
git add plugins/kyoube-apps scripts/dev-db.sh docker/Dockerfile .github/workflows/ci.yml pnpm-lock.yaml
git commit -m "feat(apps): plugin skeleton, metadata migrations, integration test harness"
```

---

### Task 2: Identifiers and field kinds (pure)

**Files:**
- Create: `plugins/kyoube-apps/src/data/errors.ts`, `plugins/kyoube-apps/src/data/identifiers.ts`, `plugins/kyoube-apps/src/data/field-kinds.ts`
- Test: `plugins/kyoube-apps/tests/unit/identifiers.spec.ts`, `plugins/kyoube-apps/tests/unit/field-kinds.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DataErrorCode = "invalid" | "forbidden" | "not_found" | "conflict" | "limit";
  export class DataError extends Error { readonly code: DataErrorCode; constructor(code, message) }
  export const SYSTEM_COLUMNS: readonly string[];
  export function assertIdentifier(value: unknown, what: string): string;   // validated lowercase name
  export function quoteIdent(name: string): string;                        // "name" after validation
  export function quoteLiteral(value: string): string;                     // 'x''y'
  export type FieldKind = "text" | "long_text" | "integer" | "decimal" | "boolean" | "date" | "datetime" | "json" | "select" | "multi_select" | "relation" | "email" | "url";
  export const FIELD_KINDS: readonly FieldKind[];
  export interface FieldOptions { choices?: string[]; relationTable?: string }
  export interface FieldSpec { name: string; displayName: string; description: string | null; kind: FieldKind; required: boolean; options: FieldOptions }
  export function normalizeFieldSpec(raw: unknown): FieldSpec;             // zod-validated; select needs ≥1 choice; relation needs relationTable
  export function columnType(kind: FieldKind): string;
  export function columnDefinition(spec: FieldSpec, table: string): string; // e.g. "status" text NOT NULL CONSTRAINT "t_status_choices" CHECK ("status" IN ('a','b'))
  export function choicesConstraintName(table: string, field: string): string;
  export function coerceValue(spec: FieldSpec, value: unknown): unknown;    // validates/normalises one cell for insert/update; null allowed unless required
  ```

- [ ] **Step 1: Write the failing tests**

`plugins/kyoube-apps/tests/unit/identifiers.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { assertIdentifier, quoteIdent, quoteLiteral } from "../../src/data/identifiers.js";

describe("assertIdentifier", () => {
  it("accepts lowercase snake_case names", () => {
    expect(assertIdentifier("contacts", "table")).toBe("contacts");
    expect(assertIdentifier("deal_stage_2", "field")).toBe("deal_stage_2");
  });
  it("rejects bad shapes, reserved prefixes, system columns, and reserved words", () => {
    for (const bad of ["Contacts", "1abc", "a-b", "", "x".repeat(64), "kyoube_x", "pg_x", "_trash_a", "id", "created_at", "select", "user", "table"]) {
      expect(() => assertIdentifier(bad, "name")).toThrow("invalid");
    }
    expect(() => assertIdentifier(42, "name")).toThrow("invalid");
  });
});

describe("quoting", () => {
  it("quotes identifiers and literals safely", () => {
    expect(quoteIdent("contacts")).toBe('"contacts"');
    expect(() => quoteIdent('bad"name')).toThrow("invalid");
    expect(quoteLiteral("it's")).toBe("'it''s'");
  });
});
```

`plugins/kyoube-apps/tests/unit/field-kinds.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { coerceValue, columnDefinition, normalizeFieldSpec } from "../../src/data/field-kinds.js";

describe("normalizeFieldSpec", () => {
  it("fills defaults and validates kind-specific options", () => {
    expect(normalizeFieldSpec({ name: "email", kind: "email" })).toEqual({ name: "email", displayName: "Email", description: null, kind: "email", required: false, options: {} });
    expect(normalizeFieldSpec({ name: "stage", kind: "select", options: { choices: ["new", "won"] }, required: true }).options).toEqual({ choices: ["new", "won"] });
    expect(() => normalizeFieldSpec({ name: "stage", kind: "select" })).toThrow("choices");
    expect(() => normalizeFieldSpec({ name: "owner", kind: "relation" })).toThrow("relationTable");
    expect(() => normalizeFieldSpec({ name: "x", kind: "blob" })).toThrow("invalid");
  });
});

describe("columnDefinition", () => {
  it("maps kinds to Postgres types with constraints", () => {
    const text = normalizeFieldSpec({ name: "title", kind: "text", required: true });
    expect(columnDefinition(text, "deals")).toBe('"title" text NOT NULL');
    const amount = normalizeFieldSpec({ name: "amount", kind: "decimal" });
    expect(columnDefinition(amount, "deals")).toBe('"amount" numeric');
    const stage = normalizeFieldSpec({ name: "stage", kind: "select", options: { choices: ["new", "it's"] } });
    expect(columnDefinition(stage, "deals")).toBe('"stage" text CONSTRAINT "deals_stage_choices" CHECK ("stage" IN (\'new\', \'it\'\'s\'))');
    const tags = normalizeFieldSpec({ name: "tags", kind: "multi_select", options: { choices: ["a", "b"] } });
    expect(columnDefinition(tags, "deals")).toBe('"tags" text[] CONSTRAINT "deals_tags_choices" CHECK ("tags" <@ ARRAY[\'a\', \'b\']::text[])');
    const contact = normalizeFieldSpec({ name: "contact", kind: "relation", options: { relationTable: "contacts" } });
    expect(columnDefinition(contact, "deals")).toBe('"contact" uuid REFERENCES "contacts" ("id") ON DELETE SET NULL');
    expect(columnDefinition(normalizeFieldSpec({ name: "when", kind: "datetime" }), "t")).toBe('"when" timestamptz');
  });
});

describe("coerceValue", () => {
  it("validates and normalises cell values by kind", () => {
    expect(coerceValue(normalizeFieldSpec({ name: "n", kind: "integer" }), "12")).toBe(12);
    expect(() => coerceValue(normalizeFieldSpec({ name: "n", kind: "integer" }), 1.5)).toThrow("integer");
    expect(coerceValue(normalizeFieldSpec({ name: "d", kind: "date" }), "2026-09-05")).toBe("2026-09-05");
    expect(() => coerceValue(normalizeFieldSpec({ name: "d", kind: "date" }), "05/09/2026")).toThrow("YYYY-MM-DD");
    expect(coerceValue(normalizeFieldSpec({ name: "t", kind: "datetime" }), "2026-09-05T10:00:00Z")).toBe("2026-09-05T10:00:00.000Z");
    expect(coerceValue(normalizeFieldSpec({ name: "b", kind: "boolean" }), "true")).toBe(true);
    expect(coerceValue(normalizeFieldSpec({ name: "s", kind: "select", options: { choices: ["a"] } }), "a")).toBe("a");
    expect(() => coerceValue(normalizeFieldSpec({ name: "s", kind: "select", options: { choices: ["a"] } }), "z")).toThrow("one of");
    expect(coerceValue(normalizeFieldSpec({ name: "m", kind: "multi_select", options: { choices: ["a", "b"] } }), ["b"])).toEqual(["b"]);
    expect(() => coerceValue(normalizeFieldSpec({ name: "e", kind: "email" }), "nope")).toThrow("email");
    expect(coerceValue(normalizeFieldSpec({ name: "u", kind: "url" }), "https://x.y")).toBe("https://x.y/");
    expect(coerceValue(normalizeFieldSpec({ name: "j", kind: "json" }), { a: 1 })).toEqual({ a: 1 });
    expect(coerceValue(normalizeFieldSpec({ name: "r", kind: "relation", options: { relationTable: "x" } }), "2f1d8e2a-1f0a-4c7b-9a2d-3b4c5d6e7f80")).toBe("2f1d8e2a-1f0a-4c7b-9a2d-3b4c5d6e7f80");
    expect(coerceValue(normalizeFieldSpec({ name: "x", kind: "text" }), null)).toBeNull();
    expect(() => coerceValue(normalizeFieldSpec({ name: "x", kind: "text", required: true }), null)).toThrow("required");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kyoube/plugin-apps test`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement errors.ts, identifiers.ts, field-kinds.ts**

`plugins/kyoube-apps/src/data/errors.ts`:
```ts
export type DataErrorCode = "invalid" | "forbidden" | "not_found" | "conflict" | "limit";

export class DataError extends Error {
  readonly code: DataErrorCode;
  constructor(code: DataErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "DataError";
    this.code = code;
  }
}
```

`plugins/kyoube-apps/src/data/identifiers.ts`:
```ts
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
```

`plugins/kyoube-apps/src/data/field-kinds.ts`:
```ts
import { z } from "zod";
import { DataError } from "./errors.js";
import { assertIdentifier, quoteIdent, quoteLiteral } from "./identifiers.js";

export const FIELD_KINDS = ["text", "long_text", "integer", "decimal", "boolean", "date", "datetime", "json", "select", "multi_select", "relation", "email", "url"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export interface FieldOptions {
  choices?: string[];
  relationTable?: string;
}

export interface FieldSpec {
  name: string;
  displayName: string;
  description: string | null;
  kind: FieldKind;
  required: boolean;
  options: FieldOptions;
}

const fieldSchema = z.object({
  name: z.string(),
  displayName: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  kind: z.enum(FIELD_KINDS),
  required: z.boolean().optional(),
  options: z.object({
    choices: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
    relationTable: z.string().optional(),
  }).optional(),
});

function titleCase(name: string): string {
  return name.split("_").filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

export function normalizeFieldSpec(raw: unknown): FieldSpec {
  const parsed = fieldSchema.safeParse(raw);
  if (!parsed.success) throw new DataError("invalid", `invalid field: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "field"} ${issue.message}`).join("; ")}`);
  const value = parsed.data;
  const name = assertIdentifier(value.name, "field name");
  const options: FieldOptions = {};
  if (value.kind === "select" || value.kind === "multi_select") {
    const choices = [...new Set(value.options?.choices ?? [])];
    if (choices.length === 0) throw new DataError("invalid", `field "${name}" of kind ${value.kind} needs options.choices`);
    options.choices = choices;
  }
  if (value.kind === "relation") {
    if (!value.options?.relationTable) throw new DataError("invalid", `field "${name}" of kind relation needs options.relationTable`);
    options.relationTable = assertIdentifier(value.options.relationTable, "relationTable");
  }
  return { name, displayName: value.displayName ?? titleCase(name), description: value.description ?? null, kind: value.kind, required: value.required ?? false, options };
}

export function columnType(kind: FieldKind): string {
  switch (kind) {
    case "text": case "long_text": case "select": case "email": case "url": return "text";
    case "integer": return "bigint";
    case "decimal": return "numeric";
    case "boolean": return "boolean";
    case "date": return "date";
    case "datetime": return "timestamptz";
    case "json": return "jsonb";
    case "multi_select": return "text[]";
    case "relation": return "uuid";
  }
}

export function choicesConstraintName(table: string, field: string): string {
  return `${table}_${field}_choices`.slice(0, 63);
}

export function choicesConstraint(spec: FieldSpec, table: string): string | null {
  if (!spec.options.choices) return null;
  const literals = spec.options.choices.map(quoteLiteral).join(", ");
  const column = quoteIdent(spec.name);
  const body = spec.kind === "multi_select" ? `${column} <@ ARRAY[${literals}]::text[]` : `${column} IN (${literals})`;
  return `CONSTRAINT ${quoteIdent(choicesConstraintName(table, spec.name))} CHECK (${body})`;
}

export function columnDefinition(spec: FieldSpec, table: string): string {
  const parts = [quoteIdent(spec.name), columnType(spec.kind)];
  if (spec.required) parts.push("NOT NULL");
  const constraint = choicesConstraint(spec, table);
  if (constraint) parts.push(constraint);
  if (spec.kind === "relation" && spec.options.relationTable) parts.push(`REFERENCES ${quoteIdent(spec.options.relationTable)} ("id") ON DELETE SET NULL`);
  return parts.join(" ");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function coerceValue(spec: FieldSpec, value: unknown): unknown {
  if (value === null || value === undefined || value === "") {
    if (spec.required) throw new DataError("invalid", `field "${spec.name}" is required`);
    return null;
  }
  const fail = (expected: string): never => { throw new DataError("invalid", `field "${spec.name}" expects ${expected}`); };
  switch (spec.kind) {
    case "text": case "long_text": return typeof value === "string" ? value : String(value);
    case "integer": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isInteger(n) ? n : fail("an integer");
    }
    case "decimal": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? n : fail("a number");
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "false") return value === "true";
      return fail("a boolean");
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : fail("a date formatted YYYY-MM-DD");
    case "datetime": {
      const ms = typeof value === "string" || typeof value === "number" ? Date.parse(String(value)) : Number.NaN;
      return Number.isNaN(ms) ? fail("an ISO 8601 timestamp") : new Date(ms).toISOString();
    }
    case "json": return value;
    case "select":
      return typeof value === "string" && spec.options.choices?.includes(value) ? value : fail(`one of ${spec.options.choices?.join(", ")}`);
    case "multi_select":
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && spec.options.choices?.includes(item))) return fail(`an array with values from ${spec.options.choices?.join(", ")}`);
      return value;
    case "relation":
      return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : fail("a record id (uuid)");
    case "email":
      return typeof value === "string" && EMAIL_RE.test(value) ? value.trim() : fail("an email address");
    case "url":
      try { return new URL(String(value)).toString(); } catch { return fail("a URL"); }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass, then commit**

Run: `pnpm --filter @kyoube/plugin-apps test`
Expected: PASS (note `new URL("https://x.y").toString()` normalises to `https://x.y/`, which the test expects).

```bash
git add plugins/kyoube-apps/src/data plugins/kyoube-apps/tests/unit
git commit -m "feat(apps): identifier validation and field kinds"
```

---

### Task 3: Company scope — schema + role provisioning and scoped transactions

**Files:**
- Create: `plugins/kyoube-apps/src/db/company-scope.ts`
- Test: `plugins/kyoube-apps/tests/integration/company-scope.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CompanyScope { companyId: string; schema: string; role: string }
  export function schemaNameFor(companyId: string): string;   // "c_" + 32 hex chars (throws DataError invalid for non-uuid)
  export function roleNameFor(companyId: string): string;     // "kyoube_c_" + hex
  export async function ensureCompany(pool: Pool, companyId: string): Promise<CompanyScope>;  // idempotent
  export interface ScopedClient { client: PoolClient; asOwner(): Promise<void>; asCompany(): Promise<void> }
  export async function withCompany<T>(pool: Pool, scope: CompanyScope, fn: (scoped: ScopedClient) => Promise<T>, opts?: { readOnly?: boolean; statementTimeoutMs?: number }): Promise<T>;
  ```
- Semantics: `withCompany` opens a transaction, runs `SET LOCAL ROLE <role>`, `SET LOCAL search_path TO <schema>`, `SET LOCAL statement_timeout = <ms>` (default 10000) and, when `readOnly`, `SET TRANSACTION READ ONLY`; `asOwner()` runs `RESET ROLE` so the callback can write `kyoube_meta` in the same transaction; `asCompany()` re-applies `SET LOCAL ROLE`. Commit on success, rollback on throw.

- [ ] **Step 1: Write the failing integration test**

`plugins/kyoube-apps/tests/integration/company-scope.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureCompany, roleNameFor, schemaNameFor, withCompany } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
let db: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  db = await createTestDatabase();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/company-scope.spec.ts", "src/db/migrate.ts")));
});
afterAll(async () => { await db.close(); });

describe("company scope", () => {
  it("derives deterministic names and rejects non-uuids", () => {
    expect(schemaNameFor(A)).toBe("c_11111111111141118111111111111111");
    expect(roleNameFor(A)).toBe("kyoube_c_11111111111141118111111111111111");
    expect(() => schemaNameFor("nope")).toThrow("invalid");
  });

  it("provisions schema, role, and meta row idempotently", async () => {
    const first = await ensureCompany(db.pool, A);
    const second = await ensureCompany(db.pool, A);
    expect(second).toEqual(first);
    const schema = await db.pool.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1", [first.schema]);
    expect(schema.rowCount).toBe(1);
    const role = await db.pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [first.role]);
    expect(role.rowCount).toBe(1);
    const meta = await db.pool.query("SELECT company_id FROM kyoube_meta.companies WHERE company_id = $1", [A]);
    expect(meta.rowCount).toBe(1);
  });

  it("runs DDL/DML as the company role inside its schema, and isolates companies", async () => {
    const a = await ensureCompany(db.pool, A);
    const b = await ensureCompany(db.pool, B);
    await withCompany(db.pool, a, async ({ client }) => {
      await client.query('CREATE TABLE "notes" (id serial PRIMARY KEY, body text)');
      await client.query('INSERT INTO "notes" (body) VALUES ($1)', ["secret of A"]);
    });
    const own = await withCompany(db.pool, a, async ({ client }) => (await client.query('SELECT body FROM "notes"')).rows);
    expect(own).toEqual([{ body: "secret of A" }]);
    await expect(
      withCompany(db.pool, b, async ({ client }) => client.query(`SELECT body FROM ${a.schema}."notes"`)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withCompany(db.pool, b, async ({ client }) => client.query('SELECT body FROM "notes"')),
    ).rejects.toThrow(/does not exist/);
  });

  it("supports read-only transactions, statement timeouts, and owner switches", async () => {
    const a = await ensureCompany(db.pool, A);
    await expect(
      withCompany(db.pool, a, async ({ client }) => client.query('INSERT INTO "notes" (body) VALUES ($1)', ["x"]), { readOnly: true }),
    ).rejects.toThrow(/read-only/);
    await expect(
      withCompany(db.pool, a, async ({ client }) => client.query("SELECT pg_sleep(1)"), { statementTimeoutMs: 100 }),
    ).rejects.toThrow(/statement timeout/);
    await withCompany(db.pool, a, async ({ client, asOwner, asCompany }) => {
      await asOwner();
      await client.query("INSERT INTO kyoube_meta.audit (company_id, actor_kind, operation) VALUES ($1, 'system', 'test')", [A]);
      await asCompany();
      await client.query('SELECT 1 FROM "notes"');
    });
    const audit = await db.pool.query("SELECT operation FROM kyoube_meta.audit WHERE company_id = $1", [A]);
    expect(audit.rows).toEqual([{ operation: "test" }]);
  });

  it("rolls back on error", async () => {
    const a = await ensureCompany(db.pool, A);
    await expect(
      withCompany(db.pool, a, async ({ client }) => {
        await client.query('INSERT INTO "notes" (body) VALUES ($1)', ["rolled back"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rows = await withCompany(db.pool, a, async ({ client }) => (await client.query('SELECT count(*)::int AS n FROM "notes"')).rows);
    expect(rows).toEqual([{ n: 1 }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kyoube/plugin-apps test:integration`
Expected: FAIL — `Cannot find module '../../src/db/company-scope.js'`

- [ ] **Step 3: Implement company-scope.ts**

`plugins/kyoube-apps/src/db/company-scope.ts`:
```ts
import type { Pool, PoolClient } from "pg";
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
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [scope.schema]);
    await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${scope.role}') THEN CREATE ROLE "${scope.role}" NOLOGIN NOINHERIT; END IF; END $$`);
    await client.query(`GRANT "${scope.role}" TO CURRENT_USER`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${scope.schema}" AUTHORIZATION "${scope.role}"`);
    await client.query(`REVOKE ALL ON SCHEMA "${scope.schema}" FROM PUBLIC`);
    await client.query(
      "INSERT INTO kyoube_meta.companies (company_id, schema_name, role_name) VALUES ($1, $2, $3) ON CONFLICT (company_id) DO NOTHING",
      [scope.companyId, scope.schema, scope.role],
    );
    await client.query("INSERT INTO kyoube_meta.company_settings (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING", [scope.companyId]);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [scope.schema]).catch(() => {});
    client.release();
  }
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

export async function withCompany<T>(
  pool: Pool,
  scope: CompanyScope,
  fn: (scoped: ScopedClient) => Promise<T>,
  opts: { readOnly?: boolean; statementTimeoutMs?: number } = {},
): Promise<T> {
  const client = await pool.connect();
  const timeout = Math.max(100, Math.floor(opts.statementTimeoutMs ?? 10_000));
  try {
    await client.query("BEGIN");
    if (opts.readOnly) await client.query("SET TRANSACTION READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${timeout}`);
    await client.query(`SET LOCAL search_path TO "${scope.schema}"`);
    await client.query(`SET LOCAL ROLE "${scope.role}"`);
    const result = await fn({
      client,
      asOwner: async () => { await client.query("RESET ROLE"); },
      asCompany: async () => { await client.query(`SET LOCAL ROLE "${scope.role}"`); },
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run the integration tests to verify they pass, then commit**

Run: `pnpm --filter @kyoube/plugin-apps test:integration`
Expected: PASS. (`resetCompanyCache()` must be called in `beforeAll` of every integration file that creates a fresh database; add it to `company-scope.spec.ts` after `createTestDatabase()`.)

```bash
git add plugins/kyoube-apps/src/db/company-scope.ts plugins/kyoube-apps/tests/integration/company-scope.spec.ts
git commit -m "feat(apps): per-company schema and role provisioning with scoped transactions"
```

---

### Task 4: Filter DSL compiler and read-only SQL validator (pure)

**Files:**
- Create: `plugins/kyoube-apps/src/data/filter.ts`, `plugins/kyoube-apps/src/data/sql-select.ts`
- Test: `plugins/kyoube-apps/tests/unit/filter.spec.ts`, `plugins/kyoube-apps/tests/unit/sql-select.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains" | "starts_with" | "is_null" | "is_not_null";
  export interface FieldTypeMap { [field: string]: FieldKind | "system" }   // system columns are typed "system" (text/uuid/timestamps compared as-is)
  export interface QuerySpec { where?: unknown; orderBy?: Array<{ field: string; direction?: "asc" | "desc" }>; limit?: number; offset?: number; fields?: string[] }
  export function compileWhere(where: unknown, fields: FieldTypeMap, params: unknown[]): string;  // "" when where is empty; appends to params
  export function compileQuery(table: string, fields: FieldTypeMap, spec: QuerySpec, opts?: { maxLimit?: number; defaultLimit?: number }): { sql: string; params: unknown[]; limit: number; offset: number };
  export function assertReadOnlySelect(sql: string): string;   // returns the statement without trailing semicolon; throws DataError invalid
  ```
- Where grammar: a condition `{ field, op, value? }` or a group `{ and: Where[] } | { or: Where[] } | { not: Where }`; depth ≤ 8, ≤ 64 conditions.

- [ ] **Step 1: Write the failing tests**

`plugins/kyoube-apps/tests/unit/filter.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { compileQuery, compileWhere, type FieldTypeMap } from "../../src/data/filter.js";

const fields: FieldTypeMap = { id: "system", created_at: "system", name: "text", amount: "decimal", stage: "select", tags: "multi_select", active: "boolean" };

describe("compileWhere", () => {
  it("compiles simple and nested conditions with positional params", () => {
    const params: unknown[] = [];
    const sql = compileWhere({ and: [{ field: "name", op: "contains", value: "ac%me" }, { or: [{ field: "amount", op: "gte", value: 10 }, { field: "stage", op: "in", value: ["new", "won"] }] }, { not: { field: "active", op: "eq", value: false } }] }, fields, params);
    expect(sql).toBe('(("name" ILIKE $1 ESCAPE \'\\\') AND (("amount" >= $2) OR ("stage" = ANY($3))) AND (NOT ("active" = $4)))');
    expect(params).toEqual(["%ac\\%me%", 10, ["new", "won"], false]);
  });
  it("handles null checks, array contains, and starts_with", () => {
    const params: unknown[] = [];
    expect(compileWhere({ field: "name", op: "is_null" }, fields, params)).toBe('("name" IS NULL)');
    expect(compileWhere({ field: "tags", op: "contains", value: "vip" }, fields, params)).toBe('($1 = ANY("tags"))');
    expect(compileWhere({ field: "name", op: "starts_with", value: "A_" }, fields, params)).toBe('("name" ILIKE $2 ESCAPE \'\\\')');
    expect(params).toEqual(["vip", "A\\_%"]);
  });
  it("rejects unknown fields, unknown ops, bad shapes, and excessive nesting", () => {
    expect(() => compileWhere({ field: "nope", op: "eq", value: 1 }, fields, [])).toThrow("unknown field");
    expect(() => compileWhere({ field: "name", op: "like", value: 1 }, fields, [])).toThrow("unknown operator");
    expect(() => compileWhere({ field: "name", op: "in", value: "x" }, fields, [])).toThrow("array");
    expect(() => compileWhere({ and: "x" }, fields, [])).toThrow("invalid");
    let deep: unknown = { field: "name", op: "eq", value: "x" };
    for (let i = 0; i < 9; i += 1) deep = { not: deep };
    expect(() => compileWhere(deep, fields, [])).toThrow("depth");
  });
  it("returns an empty string for no filter", () => {
    expect(compileWhere(undefined, fields, [])).toBe("");
    expect(compileWhere({}, fields, [])).toBe("");
  });
});

describe("compileQuery", () => {
  it("builds a full SELECT with ordering, limit, and offset clamped", () => {
    const query = compileQuery("deals", fields, { where: { field: "stage", op: "eq", value: "won" }, orderBy: [{ field: "amount", direction: "desc" }, { field: "created_at" }], limit: 5000, offset: 10, fields: ["id", "name"] });
    expect(query.sql).toBe('SELECT "id", "name" FROM "deals" WHERE ("stage" = $1) ORDER BY "amount" DESC, "created_at" ASC LIMIT 1000 OFFSET 10');
    expect(query.params).toEqual(["won"]);
    expect(query.limit).toBe(1000);
  });
  it("defaults to all fields ordered by created_at with limit 50", () => {
    const query = compileQuery("deals", fields, {});
    expect(query.sql).toBe('SELECT * FROM "deals" ORDER BY "created_at" ASC LIMIT 50 OFFSET 0');
  });
  it("rejects unknown order/select fields", () => {
    expect(() => compileQuery("deals", fields, { orderBy: [{ field: "nope" }] })).toThrow("unknown field");
    expect(() => compileQuery("deals", fields, { fields: ["nope"] })).toThrow("unknown field");
  });
});
```

`plugins/kyoube-apps/tests/unit/sql-select.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { assertReadOnlySelect } from "../../src/data/sql-select.js";

describe("assertReadOnlySelect", () => {
  it("accepts single SELECT statements, CTEs of selects, and unions", () => {
    expect(assertReadOnlySelect("SELECT 1;")).toBe("SELECT 1");
    expect(assertReadOnlySelect("with x as (select 1 as n) select n from x")).toContain("select n from x");
    expect(assertReadOnlySelect("select 1 union all select 2")).toBe("select 1 union all select 2");
  });
  it("rejects anything that is not exactly one read-only select", () => {
    for (const bad of ["DELETE FROM t", "SELECT 1; SELECT 2", "with d as (delete from t returning *) select * from d", "insert into t values (1)", "select * into t2 from t", "", "SELECT FROM WHERE", "create table x (a int)"]) {
      expect(() => assertReadOnlySelect(bad)).toThrow("invalid");
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kyoube/plugin-apps test`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement filter.ts**

`plugins/kyoube-apps/src/data/filter.ts`:
```ts
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
  if (typeof name !== "string" || !(name in fields)) throw new DataError("invalid", `unknown field "${String(name)}"`);
  return name;
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
        if (!Array.isArray(value)) throw new DataError("invalid", `operator in needs an array value for "${field}"`);
        params.push(value);
        return `(${column} = ANY($${params.length}))`;
      case "contains":
        if (kind === "multi_select") { params.push(value); return `($${params.length} = ANY(${column}))`; }
        params.push(`%${escapeLike(String(value))}%`);
        return `(${column} ILIKE $${params.length} ESCAPE '\\')`;
      case "starts_with":
        params.push(`${escapeLike(String(value))}%`);
        return `(${column} ILIKE $${params.length} ESCAPE '\\')`;
      default:
        if (value === undefined) throw new DataError("invalid", `operator ${op} needs a value for "${field}"`);
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
  const limit = Math.min(maxLimit, Math.max(1, Math.floor(spec.limit ?? opts.defaultLimit ?? 50)));
  const offset = Math.max(0, Math.floor(spec.offset ?? 0));
  const sql = `SELECT ${selected} FROM ${quoteIdent(table)}${where ? ` WHERE ${where}` : ""} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`;
  return { sql, params, limit, offset };
}
```

- [ ] **Step 4: Implement sql-select.ts**

`plugins/kyoube-apps/src/data/sql-select.ts`:
```ts
import { parse, type Statement } from "pgsql-ast-parser";
import { DataError } from "./errors.js";

function isReadOnly(statement: Statement): boolean {
  switch (statement.type) {
    case "select":
      return !("into" in statement && statement.into);
    case "union":
    case "union all":
      return isReadOnly(statement.left) && isReadOnly(statement.right);
    case "with":
      return statement.bind.every((cte) => isReadOnly(cte.statement)) && isReadOnly(statement.in);
    case "values":
      return true;
    default:
      return false;
  }
}

/** Returns the trimmed statement (no trailing semicolon) if it is exactly one read-only SELECT; throws otherwise. */
export function assertReadOnlySelect(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (trimmed.length === 0) throw new DataError("invalid", "sql must contain one SELECT statement");
  let statements: Statement[];
  try {
    statements = parse(trimmed);
  } catch (error) {
    throw new DataError("invalid", `sql could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (statements.length !== 1) throw new DataError("invalid", "sql must contain exactly one statement");
  if (!isReadOnly(statements[0]!)) throw new DataError("invalid", "only read-only SELECT statements are allowed");
  return trimmed;
}
```

- [ ] **Step 5: Run the tests to verify they pass, then commit**

Run: `pnpm --filter @kyoube/plugin-apps test`
Expected: PASS. If `pgsql-ast-parser` names the union node differently in this version (check `node_modules/pgsql-ast-parser/lib/syntax/ast.d.ts` for `SelectStatement` / `SelectFromUnion`), adjust the `case` labels — the test suite is the contract.

```bash
git add plugins/kyoube-apps/src/data/filter.ts plugins/kyoube-apps/src/data/sql-select.ts plugins/kyoube-apps/tests/unit/filter.spec.ts plugins/kyoube-apps/tests/unit/sql-select.spec.ts
git commit -m "feat(apps): filter DSL compiler and read-only SQL validator"
```

---

### Task 5: Permissions, grants repository, audit writer

**Files:**
- Create: `plugins/kyoube-apps/src/data/permissions.ts`, `plugins/kyoube-apps/src/data/grants.ts`, `plugins/kyoube-apps/src/data/audit.ts`
- Test: `plugins/kyoube-apps/tests/unit/permissions.spec.ts`, `plugins/kyoube-apps/tests/integration/grants.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type AccessLevel = "none" | "read" | "write" | "schema";
  export type Operation = "read" | "write" | "schema";
  export const ACCESS_LEVELS: readonly AccessLevel[];               // ordered
  export interface DataActor { kind: "user" | "agent" | "system"; id: string | null; runId?: string | null }
  export function parseLevel(value: unknown): AccessLevel;         // throws DataError invalid
  export function levelAllows(level: AccessLevel, op: Operation): boolean;
  export function roleToLevel(role: string | null | undefined): AccessLevel;
  export function assertLevel(level: AccessLevel, op: Operation, what: string): void; // throws DataError forbidden with a hint
  // grants.ts
  export interface CompanySettings { defaultAgentLevel: AccessLevel; hardDelete: boolean }
  export interface AgentGrant { agentId: string; level: AccessLevel; updatedBy: string | null; updatedAt: string }
  export async function getCompanySettings(pool, companyId): Promise<CompanySettings>;
  export async function setCompanySettings(pool, companyId, patch: Partial<CompanySettings>): Promise<CompanySettings>;
  export async function getAgentLevel(pool, companyId, agentId): Promise<AccessLevel>;   // grant row or company default
  export async function listAgentGrants(pool, companyId): Promise<AgentGrant[]>;
  export async function setAgentGrant(pool, companyId, agentId, level: AccessLevel, updatedBy: string | null): Promise<AgentGrant>;
  // audit.ts
  export interface AuditEntry { companyId: string; actor: DataActor; operation: string; table?: string | null; details?: Record<string, unknown> | null }
  export async function recordAudit(pool, entry: AuditEntry): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

`plugins/kyoube-apps/tests/unit/permissions.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { assertLevel, levelAllows, parseLevel, roleToLevel } from "../../src/data/permissions.js";

describe("permissions", () => {
  it("orders levels and checks operations", () => {
    expect(levelAllows("none", "read")).toBe(false);
    expect(levelAllows("read", "read")).toBe(true);
    expect(levelAllows("read", "write")).toBe(false);
    expect(levelAllows("write", "write")).toBe(true);
    expect(levelAllows("write", "schema")).toBe(false);
    expect(levelAllows("schema", "schema")).toBe(true);
  });
  it("maps company roles to levels", () => {
    expect(roleToLevel("owner")).toBe("schema");
    expect(roleToLevel("admin")).toBe("schema");
    expect(roleToLevel("operator")).toBe("write");
    expect(roleToLevel("member")).toBe("write");
    expect(roleToLevel("viewer")).toBe("read");
    expect(roleToLevel(null)).toBe("none");
    expect(roleToLevel("weird")).toBe("none");
  });
  it("parses and asserts", () => {
    expect(parseLevel("write")).toBe("write");
    expect(() => parseLevel("root")).toThrow("invalid");
    expect(() => assertLevel("read", "write", "insert rows")).toThrow("forbidden: insert rows requires write access (you have read)");
    expect(() => assertLevel("schema", "read", "x")).not.toThrow();
  });
});
```

`plugins/kyoube-apps/tests/integration/grants.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAudit } from "../../src/data/audit.js";
import { getAgentLevel, getCompanySettings, listAgentGrants, setAgentGrant, setCompanySettings } from "../../src/data/grants.js";
import { ensureCompany, resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

const C = "33333333-3333-4333-8333-333333333333";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/grants.spec.ts", "src/db/migrate.ts")));
  await ensureCompany(db.pool, C);
});
afterAll(async () => { await db.close(); });

describe("grants and settings", () => {
  it("defaults agents to the company default level and honours explicit grants", async () => {
    expect(await getCompanySettings(db.pool, C)).toEqual({ defaultAgentLevel: "none", hardDelete: false });
    expect(await getAgentLevel(db.pool, C, "agent-1")).toBe("none");
    await setCompanySettings(db.pool, C, { defaultAgentLevel: "read" });
    expect(await getAgentLevel(db.pool, C, "agent-1")).toBe("read");
    const grant = await setAgentGrant(db.pool, C, "agent-1", "schema", "user-9");
    expect(grant).toMatchObject({ agentId: "agent-1", level: "schema", updatedBy: "user-9" });
    expect(await getAgentLevel(db.pool, C, "agent-1")).toBe("schema");
    expect(await listAgentGrants(db.pool, C)).toHaveLength(1);
    await setAgentGrant(db.pool, C, "agent-1", "none", "user-9");
    expect(await getAgentLevel(db.pool, C, "agent-1")).toBe("none");
  });
  it("records audit rows", async () => {
    await recordAudit(db.pool, { companyId: C, actor: { kind: "agent", id: "agent-1", runId: "run-1" }, operation: "create_table", table: "contacts", details: { fields: 3 } });
    const rows = await db.pool.query("SELECT actor_kind, actor_id, run_id, operation, table_name, details FROM kyoube_meta.audit WHERE company_id = $1", [C]);
    expect(rows.rows).toEqual([{ actor_kind: "agent", actor_id: "agent-1", run_id: "run-1", operation: "create_table", table_name: "contacts", details: { fields: 3 } }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kyoube/plugin-apps test && pnpm --filter @kyoube/plugin-apps test:integration`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement the three modules**

`plugins/kyoube-apps/src/data/permissions.ts`:
```ts
import { DataError } from "./errors.js";

export type AccessLevel = "none" | "read" | "write" | "schema";
export type Operation = "read" | "write" | "schema";
export const ACCESS_LEVELS: readonly AccessLevel[] = ["none", "read", "write", "schema"];

export interface DataActor {
  kind: "user" | "agent" | "system";
  id: string | null;
  runId?: string | null;
}

export function parseLevel(value: unknown): AccessLevel {
  if (typeof value === "string" && (ACCESS_LEVELS as readonly string[]).includes(value)) return value as AccessLevel;
  throw new DataError("invalid", `access level must be one of ${ACCESS_LEVELS.join(", ")}`);
}

export function levelAllows(level: AccessLevel, op: Operation): boolean {
  return ACCESS_LEVELS.indexOf(level) >= ACCESS_LEVELS.indexOf(op);
}

export function roleToLevel(role: string | null | undefined): AccessLevel {
  switch ((role ?? "").toLowerCase()) {
    case "owner": case "admin": return "schema";
    case "operator": case "member": return "write";
    case "viewer": return "read";
    default: return "none";
  }
}

export function assertLevel(level: AccessLevel, op: Operation, what: string): void {
  if (!levelAllows(level, op)) {
    throw new DataError("forbidden", `${what} requires ${op} access (you have ${level})`);
  }
}
```

`plugins/kyoube-apps/src/data/grants.ts`:
```ts
import type { Pool } from "pg";
import { parseLevel, type AccessLevel } from "./permissions.js";

export interface CompanySettings {
  defaultAgentLevel: AccessLevel;
  hardDelete: boolean;
}

export interface AgentGrant {
  agentId: string;
  level: AccessLevel;
  updatedBy: string | null;
  updatedAt: string;
}

export async function getCompanySettings(pool: Pool, companyId: string): Promise<CompanySettings> {
  const result = await pool.query<{ default_agent_level: string; hard_delete: boolean }>(
    "SELECT default_agent_level, hard_delete FROM kyoube_meta.company_settings WHERE company_id = $1",
    [companyId],
  );
  const row = result.rows[0];
  return { defaultAgentLevel: row ? parseLevel(row.default_agent_level) : "none", hardDelete: row?.hard_delete ?? false };
}

export async function setCompanySettings(pool: Pool, companyId: string, patch: Partial<CompanySettings>): Promise<CompanySettings> {
  const current = await getCompanySettings(pool, companyId);
  const next: CompanySettings = {
    defaultAgentLevel: patch.defaultAgentLevel !== undefined ? parseLevel(patch.defaultAgentLevel) : current.defaultAgentLevel,
    hardDelete: patch.hardDelete ?? current.hardDelete,
  };
  await pool.query(
    `INSERT INTO kyoube_meta.company_settings (company_id, default_agent_level, hard_delete, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (company_id) DO UPDATE SET default_agent_level = EXCLUDED.default_agent_level, hard_delete = EXCLUDED.hard_delete, updated_at = now()`,
    [companyId, next.defaultAgentLevel, next.hardDelete],
  );
  return next;
}

export async function getAgentLevel(pool: Pool, companyId: string, agentId: string): Promise<AccessLevel> {
  const result = await pool.query<{ level: string }>("SELECT level FROM kyoube_meta.agent_grants WHERE company_id = $1 AND agent_id = $2", [companyId, agentId]);
  if (result.rows[0]) return parseLevel(result.rows[0].level);
  return (await getCompanySettings(pool, companyId)).defaultAgentLevel;
}

export async function listAgentGrants(pool: Pool, companyId: string): Promise<AgentGrant[]> {
  const result = await pool.query<{ agent_id: string; level: string; updated_by: string | null; updated_at: Date }>(
    "SELECT agent_id, level, updated_by, updated_at FROM kyoube_meta.agent_grants WHERE company_id = $1 ORDER BY updated_at DESC",
    [companyId],
  );
  return result.rows.map((row) => ({ agentId: row.agent_id, level: parseLevel(row.level), updatedBy: row.updated_by, updatedAt: row.updated_at.toISOString() }));
}

export async function setAgentGrant(pool: Pool, companyId: string, agentId: string, level: AccessLevel, updatedBy: string | null): Promise<AgentGrant> {
  const result = await pool.query<{ updated_at: Date }>(
    `INSERT INTO kyoube_meta.agent_grants (company_id, agent_id, level, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (company_id, agent_id) DO UPDATE SET level = EXCLUDED.level, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING updated_at`,
    [companyId, agentId, parseLevel(level), updatedBy],
  );
  return { agentId, level, updatedBy, updatedAt: result.rows[0]!.updated_at.toISOString() };
}
```

`plugins/kyoube-apps/src/data/audit.ts`:
```ts
import type { Pool } from "pg";
import type { DataActor } from "./permissions.js";

export interface AuditEntry {
  companyId: string;
  actor: DataActor;
  operation: string;
  table?: string | null;
  details?: Record<string, unknown> | null;
}

export async function recordAudit(pool: Pool, entry: AuditEntry): Promise<void> {
  await pool.query(
    "INSERT INTO kyoube_meta.audit (company_id, actor_kind, actor_id, run_id, operation, table_name, details) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [entry.companyId, entry.actor.kind, entry.actor.id, entry.actor.runId ?? null, entry.operation, entry.table ?? null, entry.details ?? null],
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass, then commit**

Run: `pnpm --filter @kyoube/plugin-apps test && pnpm --filter @kyoube/plugin-apps test:integration`
Expected: PASS

```bash
git add plugins/kyoube-apps/src/data plugins/kyoube-apps/tests
git commit -m "feat(apps): access levels, agent grants, company settings, audit"
```

---

### Task 6: Schema service (tables, fields, indexes, soft drops)

**Files:**
- Create: `plugins/kyoube-apps/src/data/schema-service.ts`
- Test: `plugins/kyoube-apps/tests/integration/schema-service.spec.ts`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces:
  ```ts
  export interface FieldInfo extends FieldSpec { position: number }
  export interface TableInfo { name: string; displayName: string; description: string | null; fields: FieldInfo[]; createdAt: string; updatedAt: string }
  export interface CreateTableInput { name: string; displayName?: string; description?: string | null; fields: unknown[] }
  export interface UpdateFieldPatch { displayName?: string; description?: string | null; required?: boolean; choices?: string[] }
  export class SchemaService {
    constructor(pool: Pool);
    listTables(scope: CompanyScope): Promise<TableInfo[]>;
    getTable(scope: CompanyScope, name: string): Promise<TableInfo>;           // throws not_found
    createTable(scope, input: CreateTableInput, createdBy: { kind: string; id: string | null }): Promise<TableInfo>;
    addField(scope, table: string, field: unknown): Promise<TableInfo>;
    updateField(scope, table: string, field: string, patch: UpdateFieldPatch): Promise<TableInfo>;
    removeField(scope, table: string, field: string, hard: boolean): Promise<TableInfo>;   // soft: column renamed _trash_<field>_<ts>
    dropTable(scope, table: string, hard: boolean): Promise<void>;                          // soft: table renamed, meta status trashed
    renameTable(scope, table: string, newName: string): Promise<TableInfo>;
    createIndex(scope, table: string, fields: string[], unique: boolean): Promise<{ name: string }>;
    purgeTrash(scope, olderThanMs: number, now?: number): Promise<{ droppedTables: string[]; droppedColumns: string[] }>;
    fieldTypeMap(table: TableInfo): FieldTypeMap;                                          // includes system columns as "system"
  }
  ```
- System columns on every table: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`, `created_by_kind text`, `created_by_id text`.

- [ ] **Step 1: Write the failing integration test**

`plugins/kyoube-apps/tests/integration/schema-service.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SchemaService } from "../../src/data/schema-service.js";
import { ensureCompany, resetCompanyCache, withCompany, type CompanyScope } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

const C = "44444444-4444-4444-8444-444444444444";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let scope: CompanyScope;
let schema: SchemaService;
const by = { kind: "user", id: "u1" };

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/schema-service.spec.ts", "src/db/migrate.ts")));
  scope = await ensureCompany(db.pool, C);
  schema = new SchemaService(db.pool);
});
afterAll(async () => { await db.close(); });

async function columns(table: string): Promise<string[]> {
  const rows = await withCompany(db.pool, scope, async ({ client }) =>
    (await client.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position", [scope.schema, table])).rows);
  return rows.map((row) => row.column_name);
}

describe("SchemaService", () => {
  it("creates a table with system columns and typed fields, and lists it", async () => {
    const table = await schema.createTable(scope, {
      name: "contacts",
      displayName: "Contacts",
      fields: [{ name: "name", kind: "text", required: true }, { name: "email", kind: "email" }, { name: "stage", kind: "select", options: { choices: ["lead", "customer"] } }],
    }, by);
    expect(table.fields.map((field) => field.name)).toEqual(["name", "email", "stage"]);
    expect(await columns("contacts")).toEqual(["id", "created_at", "updated_at", "created_by_kind", "created_by_id", "name", "email", "stage"]);
    expect((await schema.listTables(scope)).map((item) => item.name)).toEqual(["contacts"]);
    expect(schema.fieldTypeMap(table)).toEqual({ id: "system", created_at: "system", updated_at: "system", created_by_kind: "system", created_by_id: "system", name: "text", email: "email", stage: "select" });
  });

  it("rejects duplicates and unknown relation targets", async () => {
    await expect(schema.createTable(scope, { name: "contacts", fields: [] }, by)).rejects.toThrow("conflict");
    await expect(schema.createTable(scope, { name: "deals", fields: [{ name: "contact", kind: "relation", options: { relationTable: "nope" } }] }, by)).rejects.toThrow("not_found");
  });

  it("adds, updates, and soft-removes fields", async () => {
    await schema.createTable(scope, { name: "deals", fields: [{ name: "title", kind: "text" }] }, by);
    let deals = await schema.addField(scope, "deals", { name: "contact", kind: "relation", options: { relationTable: "contacts" } });
    expect(deals.fields.map((f) => f.name)).toEqual(["title", "contact"]);
    deals = await schema.addField(scope, "deals", { name: "stage", kind: "select", options: { choices: ["new"] } });
    deals = await schema.updateField(scope, "deals", "stage", { choices: ["new", "won"], required: true, displayName: "Stage!" });
    expect(deals.fields.find((f) => f.name === "stage")).toMatchObject({ displayName: "Stage!", required: true, options: { choices: ["new", "won"] } });
    await expect(schema.addField(scope, "deals", { name: "stage", kind: "text" })).rejects.toThrow("conflict");
    deals = await schema.removeField(scope, "deals", "contact", false);
    expect(deals.fields.map((f) => f.name)).toEqual(["title", "stage"]);
    expect((await columns("deals")).some((name) => name.startsWith("_trash_contact_"))).toBe(true);
    await schema.removeField(scope, "deals", "stage", true);
    expect(await columns("deals")).not.toContain("stage");
  });

  it("renames tables, creates indexes, soft-drops, and purges trash", async () => {
    await schema.createTable(scope, { name: "tmp", fields: [{ name: "a", kind: "integer" }] }, by);
    const renamed = await schema.renameTable(scope, "tmp", "tmp2");
    expect(renamed.name).toBe("tmp2");
    expect((await schema.createIndex(scope, "tmp2", ["a"], true)).name).toBe("tmp2_a_idx");
    await schema.dropTable(scope, "tmp2", false);
    await expect(schema.getTable(scope, "tmp2")).rejects.toThrow("not_found");
    const trashed = await withCompany(db.pool, scope, async ({ client }) =>
      (await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE '_trash_tmp2_%'", [scope.schema])).rows);
    expect(trashed).toHaveLength(1);
    expect(await schema.purgeTrash(scope, 30 * 86_400_000)).toEqual({ droppedTables: [], droppedColumns: [] });
    const purged = await schema.purgeTrash(scope, 0, Date.now() + 1000);
    expect(purged.droppedTables).toEqual([trashed[0]!.table_name]);
    expect(purged.droppedColumns.length).toBeGreaterThanOrEqual(1);
    await schema.createTable(scope, { name: "tmp2", fields: [] }, by); // name is free again
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kyoube/plugin-apps test:integration`
Expected: FAIL — `Cannot find module '../../src/data/schema-service.js'`

- [ ] **Step 3: Implement schema-service.ts**

`plugins/kyoube-apps/src/data/schema-service.ts`:
```ts
import type { Pool, PoolClient } from "pg";
import { withCompany, type CompanyScope } from "../db/company-scope.js";
import { DataError } from "./errors.js";
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
  return `_trash_${name}_${Math.floor(now / 1000)}`.slice(0, 63);
}

export class SchemaService {
  constructor(private readonly pool: Pool) {}

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

  async getTable(scope: CompanyScope, name: string): Promise<TableInfo> {
    const row = await this.tableRow(scope, assertIdentifier(name, "table name"));
    return this.hydrate(row);
  }

  async createTable(scope: CompanyScope, input: CreateTableInput, createdBy: { kind: string; id: string | null }): Promise<TableInfo> {
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
    await withCompany(this.pool, scope, async ({ client, asOwner }) => {
      await client.query(`CREATE TABLE ${quoteIdent(name)} (${definitions})`);
      await asOwner();
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO kyoube_meta.tables (company_id, name, display_name, description, created_by_kind, created_by_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [scope.companyId, name, input.displayName?.trim() || titleCase(name), input.description ?? null, createdBy.kind, createdBy.id],
      );
      await this.insertFieldRows(client, inserted.rows[0]!.id, fields, 0);
    });
    return this.getTable(scope, name);
  }

  async addField(scope: CompanyScope, table: string, rawField: unknown): Promise<TableInfo> {
    const info = await this.getTable(scope, table);
    const field = normalizeFieldSpec(rawField);
    if (info.fields.some((existing) => existing.name === field.name)) throw new DataError("conflict", `field "${field.name}" already exists on "${info.name}"`);
    if (field.kind === "relation") await this.tableRow(scope, field.options.relationTable!);
    const row = await this.tableRow(scope, info.name);
    await withCompany(this.pool, scope, async ({ client, asOwner }) => {
      await client.query(`ALTER TABLE ${quoteIdent(info.name)} ADD COLUMN ${columnDefinition(field, info.name)}`);
      await asOwner();
      await this.insertFieldRows(client, row.id, [field], info.fields.length);
      await client.query("UPDATE kyoube_meta.tables SET updated_at = now() WHERE id = $1", [row.id]);
    });
    return this.getTable(scope, info.name);
  }

  async updateField(scope: CompanyScope, table: string, fieldName: string, patch: UpdateFieldPatch): Promise<TableInfo> {
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
    await withCompany(this.pool, scope, async ({ client, asOwner }) => {
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
    });
    return this.getTable(scope, info.name);
  }

  async removeField(scope: CompanyScope, table: string, fieldName: string, hard: boolean): Promise<TableInfo> {
    const info = await this.getTable(scope, table);
    const name = assertIdentifier(fieldName, "field name");
    if (!info.fields.some((field) => field.name === name)) throw new DataError("not_found", `field "${name}" not found on "${info.name}"`);
    const row = await this.tableRow(scope, info.name);
    await withCompany(this.pool, scope, async ({ client, asOwner }) => {
      const t = quoteIdent(info.name);
      await client.query(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${quoteIdent(choicesConstraintName(info.name, name))}`);
      if (hard) await client.query(`ALTER TABLE ${t} DROP COLUMN ${quoteIdent(name)}`);
      else {
        await client.query(`ALTER TABLE ${t} ALTER COLUMN ${quoteIdent(name)} DROP NOT NULL`);
        await client.query(`ALTER TABLE ${t} RENAME COLUMN ${quoteIdent(name)} TO ${quoteIdent(trashName(name, Date.now()))}`);
      }
      await asOwner();
      await client.query("DELETE FROM kyoube_meta.fields WHERE table_id = $1 AND name = $2", [row.id, name]);
    });
    return this.getTable(scope, info.name);
  }

  async dropTable(scope: CompanyScope, table: string, hard: boolean): Promise<void> {
    const row = await this.tableRow(scope, assertIdentifier(table, "table name"));
    const trash = trashName(row.name, Date.now());
    await withCompany(this.pool, scope, async ({ client, asOwner }) => {
      if (hard) await client.query(`DROP TABLE ${quoteIdent(row.name)} CASCADE`);
      else await client.query(`ALTER TABLE ${quoteIdent(row.name)} RENAME TO ${quoteIdent(trash)}`);
      await asOwner();
      if (hard) await client.query("DELETE FROM kyoube_meta.tables WHERE id = $1", [row.id]);
      else await client.query("UPDATE kyoube_meta.tables SET status = 'trashed', trash_name = $2, trashed_at = now(), updated_at = now() WHERE id = $1", [row.id, trash]);
    });
  }

  async renameTable(scope: CompanyScope, table: string, newName: string): Promise<TableInfo> {
    const row = await this.tableRow(scope, assertIdentifier(table, "table name"));
    const target = assertIdentifier(newName, "table name");
    const taken = await this.pool.query("SELECT 1 FROM kyoube_meta.tables WHERE company_id = $1 AND name = $2 AND status = 'active'", [scope.companyId, target]);
    if (taken.rowCount) throw new DataError("conflict", `table "${target}" already exists`);
    await withCompany(this.pool, scope, async ({ client, asOwner }) => {
      await client.query(`ALTER TABLE ${quoteIdent(row.name)} RENAME TO ${quoteIdent(target)}`);
      await asOwner();
      await client.query("UPDATE kyoube_meta.tables SET name = $2, updated_at = now() WHERE id = $1", [row.id, target]);
    });
    return this.getTable(scope, target);
  }

  async createIndex(scope: CompanyScope, table: string, fields: string[], unique: boolean): Promise<{ name: string }> {
    const info = await this.getTable(scope, table);
    if (fields.length === 0 || fields.length > 4) throw new DataError("invalid", "an index needs 1-4 fields");
    const map = this.fieldTypeMap(info);
    const names = fields.map((field) => { if (!(field in map)) throw new DataError("not_found", `field "${field}" not found`); return field; });
    const name = `${info.name}_${names.join("_")}_idx`.slice(0, 63);
    await withCompany(this.pool, scope, async ({ client }) => {
      await client.query(`CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${quoteIdent(info.name)} (${names.map(quoteIdent).join(", ")})`);
    });
    return { name };
  }

  async purgeTrash(scope: CompanyScope, olderThanMs: number, now: number = Date.now()): Promise<{ droppedTables: string[]; droppedColumns: string[] }> {
    const cutoff = Math.floor((now - olderThanMs) / 1000);
    const droppedTables: string[] = [];
    const droppedColumns: string[] = [];
    await withCompany(this.pool, scope, async ({ client, asOwner, asCompany }) => {
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
      await asCompany();
    });
    return { droppedTables, droppedColumns };
  }

  private trashStamp(name: string): number {
    const match = /_(\d+)$/.exec(name);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
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
```

- [ ] **Step 4: Run the integration tests to verify they pass, then commit**

Run: `pnpm --filter @kyoube/plugin-apps test:integration`
Expected: PASS

```bash
git add plugins/kyoube-apps/src/data/schema-service.ts plugins/kyoube-apps/tests/integration/schema-service.spec.ts
git commit -m "feat(apps): schema service with soft drops and trash purge"
```

---

### Task 7: Records service (CRUD, query, count, read-only SQL)

**Files:**
- Create: `plugins/kyoube-apps/src/data/records-service.ts`
- Modify: `plugins/kyoube-apps/src/db/pool.ts` (type parsers)
- Test: `plugins/kyoube-apps/tests/integration/records-service.spec.ts`

**Interfaces:**
- Consumes: `SchemaService.getTable/fieldTypeMap` (Task 6), `compileWhere/compileQuery` (Task 4), `coerceValue` (Task 2), `withCompany` (Task 3).
- Produces:
  ```ts
  export type Row = Record<string, unknown>;
  export interface RowTarget { ids?: string[]; where?: unknown }   // exactly one must be given
  export class RecordsService {
    constructor(pool: Pool, schema: SchemaService);
    insert(scope, table: string, rows: unknown[], createdBy: { kind: string; id: string | null }): Promise<Row[]>;      // 1..500 rows, RETURNING *
    get(scope, table: string, id: string): Promise<Row | null>;
    query(scope, table: string, spec: QuerySpec): Promise<{ rows: Row[]; limit: number; offset: number }>;
    count(scope, table: string, where?: unknown): Promise<number>;
    update(scope, table: string, target: RowTarget, patch: Row): Promise<{ affected: number; rows: Row[] }>;         // sets updated_at = now(); ≤ 1000 rows
    delete(scope, table: string, target: RowTarget): Promise<{ affected: number }>;                                   // ≤ 1000 rows
    sqlSelect(scope, sql: string, params?: unknown[]): Promise<{ columns: string[]; rows: Row[]; truncated: boolean }>; // ≤ 1000 rows, 5 s, read-only txn
  }
  export function configureTypeParsers(): void; // pool.ts: date → "YYYY-MM-DD" string, bigint → number when safe, numeric → number
  ```

- [ ] **Step 1: Write the failing integration test**

`plugins/kyoube-apps/tests/integration/records-service.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RecordsService } from "../../src/data/records-service.js";
import { SchemaService } from "../../src/data/schema-service.js";
import { ensureCompany, resetCompanyCache, type CompanyScope } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

const C = "55555555-5555-4555-8555-555555555555";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let scope: CompanyScope;
let records: RecordsService;
const by = { kind: "agent", id: "agent-7" };

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/records-service.spec.ts", "src/db/migrate.ts")));
  scope = await ensureCompany(db.pool, C);
  const schema = new SchemaService(db.pool);
  records = new RecordsService(db.pool, schema);
  await schema.createTable(scope, { name: "contacts", fields: [{ name: "name", kind: "text", required: true }, { name: "email", kind: "email" }] }, { kind: "user", id: "u1" });
  await schema.createTable(scope, {
    name: "deals",
    fields: [
      { name: "title", kind: "text", required: true },
      { name: "amount", kind: "decimal" },
      { name: "stage", kind: "select", options: { choices: ["new", "won"] } },
      { name: "closes_on", kind: "date" },
      { name: "contact", kind: "relation", options: { relationTable: "contacts" } },
      { name: "tags", kind: "multi_select", options: { choices: ["hot", "big"] } },
    ],
  }, { kind: "user", id: "u1" });
});
afterAll(async () => { await db.close(); });

describe("RecordsService", () => {
  it("inserts validated rows with system columns and reads them back", async () => {
    const [contact] = await records.insert(scope, "contacts", [{ name: "Ada", email: "ada@example.com" }], by);
    expect(contact).toMatchObject({ name: "Ada", email: "ada@example.com", created_by_kind: "agent", created_by_id: "agent-7" });
    expect(typeof contact!.id).toBe("string");
    expect(typeof contact!.created_at).toBe("string");
    const [deal] = await records.insert(scope, "deals", [{ title: "Big one", amount: "1200.50", stage: "new", closes_on: "2026-12-01", contact: contact!.id, tags: ["big"] }], by);
    expect(deal).toMatchObject({ title: "Big one", amount: 1200.5, stage: "new", closes_on: "2026-12-01", contact: contact!.id, tags: ["big"] });
    expect(await records.get(scope, "deals", String(deal!.id))).toMatchObject({ title: "Big one" });
    expect(await records.get(scope, "deals", "2f1d8e2a-1f0a-4c7b-9a2d-3b4c5d6e7f80")).toBeNull();
  });

  it("rejects invalid cells, unknown columns, and too many rows", async () => {
    await expect(records.insert(scope, "deals", [{ title: "x", stage: "lost" }], by)).rejects.toThrow("one of");
    await expect(records.insert(scope, "deals", [{ title: "x", nope: 1 }], by)).rejects.toThrow('unknown field "nope"');
    await expect(records.insert(scope, "deals", [{}], by)).rejects.toThrow("required");
    await expect(records.insert(scope, "deals", Array.from({ length: 501 }, () => ({ title: "x" })), by)).rejects.toThrow("limit");
    await expect(records.insert(scope, "deals", [], by)).rejects.toThrow("at least one row");
  });

  it("queries with filters, ordering, paging, and counts", async () => {
    await records.insert(scope, "deals", [{ title: "Small", amount: 10, stage: "won" }, { title: "Medium", amount: 500, stage: "new", tags: ["hot"] }], by);
    const won = await records.query(scope, "deals", { where: { field: "stage", op: "eq", value: "won" }, fields: ["title"] });
    expect(won.rows).toEqual([{ title: "Small" }]);
    const hot = await records.query(scope, "deals", { where: { field: "tags", op: "contains", value: "hot" } });
    expect(hot.rows.map((row) => row.title)).toEqual(["Medium"]);
    const paged = await records.query(scope, "deals", { orderBy: [{ field: "amount", direction: "desc" }], limit: 2, offset: 1 });
    expect(paged.rows.map((row) => row.title)).toEqual(["Medium", "Small"]);
    expect(await records.count(scope, "deals", { field: "amount", op: "gte", value: 100 })).toBe(2);
    expect(await records.count(scope, "deals")).toBe(3);
  });

  it("updates and deletes by ids or filters, bumping updated_at", async () => {
    const before = await records.query(scope, "deals", { where: { field: "title", op: "eq", value: "Small" } });
    const id = String(before.rows[0]!.id);
    const updated = await records.update(scope, "deals", { ids: [id] }, { amount: 15, stage: "won" });
    expect(updated.affected).toBe(1);
    expect(updated.rows[0]).toMatchObject({ amount: 15, stage: "won" });
    expect(String(updated.rows[0]!.updated_at) > String(before.rows[0]!.updated_at)).toBe(true);
    await expect(records.update(scope, "deals", {}, { amount: 1 })).rejects.toThrow("ids or where");
    await expect(records.update(scope, "deals", { ids: [id] }, { title: null })).rejects.toThrow("required");
    const bulk = await records.update(scope, "deals", { where: { field: "stage", op: "eq", value: "new" } }, { stage: "won" });
    expect(bulk.affected).toBe(2);
    expect((await records.delete(scope, "deals", { where: { field: "title", op: "starts_with", value: "Med" } })).affected).toBe(1);
    expect(await records.count(scope, "deals")).toBe(2);
  });

  it("runs read-only SQL with limits and rejects writes", async () => {
    const result = await records.sqlSelect(scope, "select stage, count(*)::int as n from deals group by stage order by stage");
    expect(result.columns).toEqual(["stage", "n"]);
    expect(result.rows).toEqual([{ stage: "won", n: 2 }]);
    expect(result.truncated).toBe(false);
    const params = await records.sqlSelect(scope, "select title from deals where amount > $1 order by title", [10]);
    expect(params.rows.map((row) => row.title)).toEqual(["Big one", "Small"]);
    await expect(records.sqlSelect(scope, "delete from deals")).rejects.toThrow("invalid");
    await expect(records.sqlSelect(scope, "select pg_sleep(10)")).rejects.toThrow(/statement timeout/);
    await expect(records.sqlSelect(scope, "select * from kyoube_meta.audit")).rejects.toThrow(/permission denied/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kyoube/plugin-apps test:integration`
Expected: FAIL — `Cannot find module '../../src/data/records-service.js'`

- [ ] **Step 3: Add type parsers to pool.ts**

Replace `plugins/kyoube-apps/src/db/pool.ts`:
```ts
import pg from "pg";

export type { Pool, PoolClient } from "pg";

let configured = false;

/** Dates stay "YYYY-MM-DD" strings, bigints become numbers when safe, numerics become numbers. */
export function configureTypeParsers(): void {
  if (configured) return;
  configured = true;
  pg.types.setTypeParser(1082, (value) => value); // date
  pg.types.setTypeParser(20, (value) => { const n = Number(value); return Number.isSafeInteger(n) ? n : value; }); // int8
  pg.types.setTypeParser(1700, (value) => Number(value)); // numeric
}

export function createPool(url: string, opts: { max?: number } = {}): pg.Pool {
  configureTypeParsers();
  return new pg.Pool({ connectionString: url, max: opts.max ?? 8, application_name: "kyoube-apps" });
}
```
Also call `configureTypeParsers()` at the top of `tests/integration/setup.ts` (import it from `../../src/db/pool.js`) so the test pool behaves like production.

- [ ] **Step 4: Implement records-service.ts**

`plugins/kyoube-apps/src/data/records-service.ts`:
```ts
import type { Pool } from "pg";
import { withCompany, type CompanyScope } from "../db/company-scope.js";
import { DataError } from "./errors.js";
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) out[key] = value instanceof Date ? value.toISOString() : value;
  return out;
}

export class RecordsService {
  constructor(private readonly pool: Pool, private readonly schema: SchemaService) {}

  async insert(scope: CompanyScope, table: string, rows: unknown[], createdBy: { kind: string; id: string | null }): Promise<Row[]> {
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
    const columnList = [...columns, "created_by_kind", "created_by_id"].map(quoteIdent).join(", ");
    const sql = `INSERT INTO ${quoteIdent(info.name)} (${columnList}) VALUES ${tuples.join(", ")} RETURNING *`;
    return withCompany(this.pool, scope, async ({ client }) => (await client.query(sql, values)).rows.map(normalizeRow));
  }

  async get(scope: CompanyScope, table: string, id: string): Promise<Row | null> {
    const info = await this.schema.getTable(scope, table);
    if (!UUID_RE.test(id)) throw new DataError("invalid", "id must be a uuid");
    return withCompany(this.pool, scope, async ({ client }) => {
      const result = await client.query(`SELECT * FROM ${quoteIdent(info.name)} WHERE "id" = $1`, [id]);
      return result.rows[0] ? normalizeRow(result.rows[0]) : null;
    }, { readOnly: true });
  }

  async query(scope: CompanyScope, table: string, spec: QuerySpec): Promise<{ rows: Row[]; limit: number; offset: number }> {
    const info = await this.schema.getTable(scope, table);
    const compiled = compileQuery(info.name, this.schema.fieldTypeMap(info), spec);
    const rows = await withCompany(this.pool, scope, async ({ client }) => (await client.query(compiled.sql, compiled.params)).rows, { readOnly: true });
    return { rows: rows.map(normalizeRow), limit: compiled.limit, offset: compiled.offset };
  }

  async count(scope: CompanyScope, table: string, where?: unknown): Promise<number> {
    const info = await this.schema.getTable(scope, table);
    const params: unknown[] = [];
    const clause = compileWhere(where, this.schema.fieldTypeMap(info), params);
    const sql = `SELECT count(*)::int AS n FROM ${quoteIdent(info.name)}${clause ? ` WHERE ${clause}` : ""}`;
    return withCompany(this.pool, scope, async ({ client }) => (await client.query<{ n: number }>(sql, params)).rows[0]!.n, { readOnly: true });
  }

  async update(scope: CompanyScope, table: string, target: RowTarget, patch: Row): Promise<{ affected: number; rows: Row[] }> {
    const info = await this.schema.getTable(scope, table);
    const cells = this.coerceRow(info, patch, { requireAll: false });
    const keys = Object.keys(cells);
    if (keys.length === 0) throw new DataError("invalid", "update needs at least one field");
    const params: unknown[] = [];
    const sets = keys.map((key) => { params.push(cells[key]); return `${quoteIdent(key)} = $${params.length}`; });
    sets.push('"updated_at" = now()');
    const where = this.targetClause(info, target, params);
    const sql = `UPDATE ${quoteIdent(info.name)} SET ${sets.join(", ")} WHERE "id" IN (SELECT "id" FROM ${quoteIdent(info.name)} WHERE ${where} LIMIT ${MAX_AFFECTED + 1}) RETURNING *`;
    return withCompany(this.pool, scope, async ({ client }) => {
      const result = await client.query(sql, params);
      if (result.rowCount !== null && result.rowCount > MAX_AFFECTED) throw new DataError("limit", `update would affect more than ${MAX_AFFECTED} rows; narrow the filter`);
      return { affected: result.rowCount ?? 0, rows: result.rows.map(normalizeRow) };
    });
  }

  async delete(scope: CompanyScope, table: string, target: RowTarget): Promise<{ affected: number }> {
    const info = await this.schema.getTable(scope, table);
    const params: unknown[] = [];
    const where = this.targetClause(info, target, params);
    const sql = `DELETE FROM ${quoteIdent(info.name)} WHERE "id" IN (SELECT "id" FROM ${quoteIdent(info.name)} WHERE ${where} LIMIT ${MAX_AFFECTED + 1})`;
    return withCompany(this.pool, scope, async ({ client }) => {
      const result = await client.query(sql, params);
      if (result.rowCount !== null && result.rowCount > MAX_AFFECTED) throw new DataError("limit", `delete would affect more than ${MAX_AFFECTED} rows; narrow the filter`);
      return { affected: result.rowCount ?? 0 };
    });
  }

  async sqlSelect(scope: CompanyScope, sql: string, params: unknown[] = []): Promise<{ columns: string[]; rows: Row[]; truncated: boolean }> {
    const statement = assertReadOnlySelect(sql);
    if (!Array.isArray(params) || params.length > 50) throw new DataError("invalid", "params must be an array of at most 50 values");
    const wrapped = `SELECT * FROM (${statement}) AS kyoube_q LIMIT ${SQL_LIMIT + 1}`;
    return withCompany(this.pool, scope, async ({ client }) => {
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
      if (!opts.requireAll && !(field.name in input)) continue;
      cells[field.name] = coerceValue(field, input[field.name]);
    }
    return cells;
  }

  private targetClause(info: TableInfo, target: RowTarget, params: unknown[]): string {
    const hasIds = Array.isArray(target.ids) && target.ids.length > 0;
    const hasWhere = target.where !== undefined && target.where !== null && Object.keys(target.where as object).length > 0;
    if (hasIds === hasWhere) throw new DataError("invalid", "provide exactly one of ids or where");
    if (hasIds) {
      if (target.ids!.some((id) => !UUID_RE.test(id))) throw new DataError("invalid", "ids must be uuids");
      params.push(target.ids);
      return `"id" = ANY($${params.length}::uuid[])`;
    }
    return compileWhere(target.where, this.schema.fieldTypeMap(info), params);
  }
}
```

- [ ] **Step 5: Run the integration tests to verify they pass, then commit**

Run: `pnpm --filter @kyoube/plugin-apps test:integration`
Expected: PASS

```bash
git add plugins/kyoube-apps/src/data/records-service.ts plugins/kyoube-apps/src/db/pool.ts plugins/kyoube-apps/tests/integration
git commit -m "feat(apps): records service with validated CRUD, queries, and read-only SQL"
```

---

### Task 8: `DataService` façade (actor-aware, audited)

**Files:**
- Create: `plugins/kyoube-apps/src/data/service.ts`
- Test: `plugins/kyoube-apps/tests/integration/data-service.spec.ts`

**Interfaces:**
- Consumes: Tasks 3, 5, 6, 7.
- Produces (every method takes `companyId` and a `DataActor` first and enforces the level in parentheses):
  ```ts
  export interface MutationEvent { companyId: string; actor: DataActor; operation: string; table: string | null; summary: string }
  export interface DataServiceDeps { pool: Pool; resolveUserRole: (companyId: string, userId: string) => Promise<string | null>; onMutation?: (event: MutationEvent) => Promise<void> }
  export class DataService {
    constructor(deps: DataServiceDeps);
    scope(companyId): Promise<CompanyScope>;
    levelFor(companyId, actor): Promise<AccessLevel>;
    myAccess(companyId, actor): Promise<{ level: AccessLevel; actorKind: string; hint: string }>;
    listTables(companyId, actor): Promise<TableInfo[]>;                                   (read)
    describeTable(companyId, actor, table): Promise<TableInfo>;                          (read)
    createTable(companyId, actor, input: CreateTableInput): Promise<TableInfo>;          (schema)
    addField(companyId, actor, table, field: unknown): Promise<TableInfo>;               (schema)
    updateField(companyId, actor, table, field, patch: UpdateFieldPatch): Promise<TableInfo>; (schema)
    removeField(companyId, actor, table, field): Promise<TableInfo>;                     (schema; hard per company setting)
    dropTable(companyId, actor, table): Promise<{ ok: true }>;                           (schema; hard per company setting)
    renameTable(companyId, actor, table, newName): Promise<TableInfo>;                   (schema)
    createIndex(companyId, actor, table, fields: string[], unique: boolean): Promise<{ name: string }>; (schema)
    insert(companyId, actor, table, rows: unknown[]): Promise<Row[]>;                    (write)
    update(companyId, actor, table, target: RowTarget, patch: Row): Promise<{ affected: number; rows: Row[] }>; (write)
    delete(companyId, actor, table, target: RowTarget): Promise<{ affected: number }>;   (write)
    get(companyId, actor, table, id): Promise<Row | null>;                               (read)
    query(companyId, actor, table, spec: QuerySpec): Promise<{ rows: Row[]; limit: number; offset: number }>; (read)
    count(companyId, actor, table, where?: unknown): Promise<number>;                    (read)
    sqlSelect(companyId, actor, sql, params?: unknown[]): Promise<{ columns: string[]; rows: Row[]; truncated: boolean }>; (read)
    listAgentGrants(companyId, actor): Promise<AgentGrant[]>;                            (user with schema level)
    setAgentGrant(companyId, actor, agentId, level: AccessLevel): Promise<AgentGrant>;   (user with schema level)
    getSettings(companyId, actor): Promise<CompanySettings>;                             (user with schema level)
    setSettings(companyId, actor, patch: Partial<CompanySettings>): Promise<CompanySettings>; (user with schema level)
    purgeTrash(companyId): Promise<{ droppedTables: string[]; droppedColumns: string[] }>; (system; 30-day cutoff)
  }
  ```

- [ ] **Step 1: Write the failing integration test**

`plugins/kyoube-apps/tests/integration/data-service.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataService, type MutationEvent } from "../../src/data/service.js";
import { resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

const C = "66666666-6666-4666-8666-666666666666";
const OWNER = { kind: "user" as const, id: "owner-1" };
const VIEWER = { kind: "user" as const, id: "viewer-1" };
const AGENT = { kind: "agent" as const, id: "agent-1", runId: "run-1" };
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let service: DataService;
const mutations: MutationEvent[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/data-service.spec.ts", "src/db/migrate.ts")));
  service = new DataService({
    pool: db.pool,
    resolveUserRole: async (_companyId, userId) => (userId === "owner-1" ? "owner" : userId === "viewer-1" ? "viewer" : null),
    onMutation: async (event) => { mutations.push(event); },
  });
});
afterAll(async () => { await db.close(); });

describe("DataService", () => {
  it("maps users to levels from their company role and agents from grants", async () => {
    expect(await service.levelFor(C, OWNER)).toBe("schema");
    expect(await service.levelFor(C, VIEWER)).toBe("read");
    expect(await service.levelFor(C, { kind: "user", id: "stranger" })).toBe("none");
    expect(await service.levelFor(C, AGENT)).toBe("none");
    expect((await service.myAccess(C, AGENT)).hint).toContain("ask a company admin");
  });

  it("enforces levels on schema, write, and read operations", async () => {
    await expect(service.createTable(C, AGENT, { name: "contacts", fields: [] })).rejects.toThrow("forbidden");
    await expect(service.createTable(C, VIEWER, { name: "contacts", fields: [] })).rejects.toThrow("forbidden");
    const table = await service.createTable(C, OWNER, { name: "contacts", fields: [{ name: "name", kind: "text", required: true }] });
    expect(table.name).toBe("contacts");
    await expect(service.insert(C, VIEWER, "contacts", [{ name: "x" }])).rejects.toThrow("forbidden");
    await service.setAgentGrant(C, OWNER, "agent-1", "write");
    const rows = await service.insert(C, AGENT, "contacts", [{ name: "Ada" }]);
    expect(rows[0]).toMatchObject({ name: "Ada", created_by_kind: "agent", created_by_id: "agent-1" });
    expect((await service.query(C, VIEWER, "contacts", {})).rows).toHaveLength(1);
    await expect(service.addField(C, AGENT, "contacts", { name: "email", kind: "email" })).rejects.toThrow("forbidden");
    await service.setAgentGrant(C, OWNER, "agent-1", "schema");
    expect((await service.addField(C, AGENT, "contacts", { name: "email", kind: "email" })).fields).toHaveLength(2);
  });

  it("only admins manage grants and settings", async () => {
    await expect(service.listAgentGrants(C, VIEWER)).rejects.toThrow("forbidden");
    await expect(service.setAgentGrant(C, AGENT, "agent-2", "read")).rejects.toThrow("forbidden");
    expect(await service.getSettings(C, OWNER)).toEqual({ defaultAgentLevel: "none", hardDelete: false });
    await service.setSettings(C, OWNER, { defaultAgentLevel: "read" });
    expect(await service.levelFor(C, { kind: "agent", id: "agent-new" })).toBe("read");
  });

  it("audits mutations in kyoube_meta and via the callback, soft-drops by default, hard-drops when configured", async () => {
    await service.dropTable(C, OWNER, "contacts");
    const trashed = await db.pool.query("SELECT status FROM kyoube_meta.tables WHERE company_id = $1 AND name = 'contacts'", [C]);
    expect(trashed.rows[0]).toEqual({ status: "trashed" });
    await service.setSettings(C, OWNER, { hardDelete: true });
    await service.createTable(C, OWNER, { name: "temp", fields: [] });
    await service.dropTable(C, OWNER, "temp");
    expect((await db.pool.query("SELECT 1 FROM kyoube_meta.tables WHERE company_id = $1 AND name = 'temp'", [C])).rowCount).toBe(0);
    const audit = await db.pool.query<{ operation: string; actor_kind: string }>("SELECT operation, actor_kind FROM kyoube_meta.audit WHERE company_id = $1 ORDER BY id", [C]);
    expect(audit.rows.map((row) => row.operation)).toEqual(expect.arrayContaining(["create_table", "insert", "add_field", "set_agent_grant", "set_settings", "drop_table"]));
    expect(mutations.some((event) => event.operation === "insert" && event.actor.kind === "agent" && !event.summary.includes("Ada"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kyoube/plugin-apps test:integration`
Expected: FAIL — `Cannot find module '../../src/data/service.js'`

- [ ] **Step 3: Implement service.ts**

`plugins/kyoube-apps/src/data/service.ts`:
```ts
import type { Pool } from "pg";
import { ensureCompany, type CompanyScope } from "../db/company-scope.js";
import { recordAudit } from "./audit.js";
import { DataError } from "./errors.js";
import type { QuerySpec } from "./filter.js";
import { getAgentLevel, getCompanySettings, listAgentGrants, setAgentGrant, setCompanySettings, type AgentGrant, type CompanySettings } from "./grants.js";
import { assertLevel, roleToLevel, type AccessLevel, type DataActor, type Operation } from "./permissions.js";
import { RecordsService, type Row, type RowTarget } from "./records-service.js";
import { SchemaService, type CreateTableInput, type TableInfo, type UpdateFieldPatch } from "./schema-service.js";

export interface MutationEvent {
  companyId: string;
  actor: DataActor;
  operation: string;
  table: string | null;
  summary: string;
}

export interface DataServiceDeps {
  pool: Pool;
  resolveUserRole: (companyId: string, userId: string) => Promise<string | null>;
  onMutation?: (event: MutationEvent) => Promise<void>;
}

const TRASH_RETENTION_MS = 30 * 86_400_000;

export class DataService {
  readonly schema: SchemaService;
  readonly records: RecordsService;
  private readonly pool: Pool;
  private readonly resolveUserRole: DataServiceDeps["resolveUserRole"];
  private readonly onMutation: DataServiceDeps["onMutation"];

  constructor(deps: DataServiceDeps) {
    this.pool = deps.pool;
    this.resolveUserRole = deps.resolveUserRole;
    this.onMutation = deps.onMutation;
    this.schema = new SchemaService(deps.pool);
    this.records = new RecordsService(deps.pool, this.schema);
  }

  scope(companyId: string): Promise<CompanyScope> {
    return ensureCompany(this.pool, companyId);
  }

  async levelFor(companyId: string, actor: DataActor): Promise<AccessLevel> {
    await this.scope(companyId);
    if (actor.kind === "system") return "schema";
    if (!actor.id) return "none";
    if (actor.kind === "user") return roleToLevel(await this.resolveUserRole(companyId, actor.id));
    return getAgentLevel(this.pool, companyId, actor.id);
  }

  async myAccess(companyId: string, actor: DataActor): Promise<{ level: AccessLevel; actorKind: string; hint: string }> {
    const level = await this.levelFor(companyId, actor);
    const hint = level === "schema"
      ? "You can read, write, and change the schema."
      : `You have ${level} access. To get more, ask a company admin to raise your level under Company Settings → Data access.`;
    return { level, actorKind: actor.kind, hint };
  }

  // ---- schema -----------------------------------------------------------

  async listTables(companyId: string, actor: DataActor): Promise<TableInfo[]> {
    const scope = await this.authorize(companyId, actor, "read", "list tables");
    return this.schema.listTables(scope);
  }

  async describeTable(companyId: string, actor: DataActor, table: string): Promise<TableInfo> {
    const scope = await this.authorize(companyId, actor, "read", "describe a table");
    return this.schema.getTable(scope, table);
  }

  async createTable(companyId: string, actor: DataActor, input: CreateTableInput): Promise<TableInfo> {
    const scope = await this.authorize(companyId, actor, "schema", "create a table");
    const table = await this.schema.createTable(scope, input, { kind: actor.kind, id: actor.id });
    await this.audit(companyId, actor, "create_table", table.name, { fields: table.fields.map((field) => field.name) }, `created table ${table.name}`);
    return table;
  }

  async addField(companyId: string, actor: DataActor, table: string, field: unknown): Promise<TableInfo> {
    const scope = await this.authorize(companyId, actor, "schema", "add a field");
    const info = await this.schema.addField(scope, table, field);
    await this.audit(companyId, actor, "add_field", info.name, { field }, `added a field to ${info.name}`);
    return info;
  }

  async updateField(companyId: string, actor: DataActor, table: string, field: string, patch: UpdateFieldPatch): Promise<TableInfo> {
    const scope = await this.authorize(companyId, actor, "schema", "update a field");
    const info = await this.schema.updateField(scope, table, field, patch);
    await this.audit(companyId, actor, "update_field", info.name, { field, patch }, `updated field ${field} on ${info.name}`);
    return info;
  }

  async removeField(companyId: string, actor: DataActor, table: string, field: string): Promise<TableInfo> {
    const scope = await this.authorize(companyId, actor, "schema", "remove a field");
    const hard = (await getCompanySettings(this.pool, companyId)).hardDelete;
    const info = await this.schema.removeField(scope, table, field, hard);
    await this.audit(companyId, actor, "remove_field", info.name, { field, hard }, `removed field ${field} from ${info.name}`);
    return info;
  }

  async dropTable(companyId: string, actor: DataActor, table: string): Promise<{ ok: true }> {
    const scope = await this.authorize(companyId, actor, "schema", "drop a table");
    const hard = (await getCompanySettings(this.pool, companyId)).hardDelete;
    await this.schema.dropTable(scope, table, hard);
    await this.audit(companyId, actor, "drop_table", table, { hard }, `dropped table ${table}${hard ? "" : " (recoverable for 30 days)"}`);
    return { ok: true };
  }

  async renameTable(companyId: string, actor: DataActor, table: string, newName: string): Promise<TableInfo> {
    const scope = await this.authorize(companyId, actor, "schema", "rename a table");
    const info = await this.schema.renameTable(scope, table, newName);
    await this.audit(companyId, actor, "rename_table", info.name, { from: table }, `renamed table ${table} to ${info.name}`);
    return info;
  }

  async createIndex(companyId: string, actor: DataActor, table: string, fields: string[], unique: boolean): Promise<{ name: string }> {
    const scope = await this.authorize(companyId, actor, "schema", "create an index");
    const result = await this.schema.createIndex(scope, table, fields, unique);
    await this.audit(companyId, actor, "create_index", table, { fields, unique }, `created index ${result.name}`);
    return result;
  }

  // ---- records ----------------------------------------------------------

  async insert(companyId: string, actor: DataActor, table: string, rows: unknown[]): Promise<Row[]> {
    const scope = await this.authorize(companyId, actor, "write", "insert rows");
    const inserted = await this.records.insert(scope, table, rows, { kind: actor.kind, id: actor.id });
    await this.audit(companyId, actor, "insert", table, { count: inserted.length, ids: inserted.map((row) => row.id) }, `inserted ${inserted.length} row(s) into ${table}`);
    return inserted;
  }

  async update(companyId: string, actor: DataActor, table: string, target: RowTarget, patch: Row): Promise<{ affected: number; rows: Row[] }> {
    const scope = await this.authorize(companyId, actor, "write", "update rows");
    const result = await this.records.update(scope, table, target, patch);
    await this.audit(companyId, actor, "update", table, { affected: result.affected, fields: Object.keys(patch) }, `updated ${result.affected} row(s) in ${table}`);
    return result;
  }

  async delete(companyId: string, actor: DataActor, table: string, target: RowTarget): Promise<{ affected: number }> {
    const scope = await this.authorize(companyId, actor, "write", "delete rows");
    const result = await this.records.delete(scope, table, target);
    await this.audit(companyId, actor, "delete", table, { affected: result.affected }, `deleted ${result.affected} row(s) from ${table}`);
    return result;
  }

  async get(companyId: string, actor: DataActor, table: string, id: string): Promise<Row | null> {
    const scope = await this.authorize(companyId, actor, "read", "read a row");
    return this.records.get(scope, table, id);
  }

  async query(companyId: string, actor: DataActor, table: string, spec: QuerySpec): Promise<{ rows: Row[]; limit: number; offset: number }> {
    const scope = await this.authorize(companyId, actor, "read", "query rows");
    return this.records.query(scope, table, spec);
  }

  async count(companyId: string, actor: DataActor, table: string, where?: unknown): Promise<number> {
    const scope = await this.authorize(companyId, actor, "read", "count rows");
    return this.records.count(scope, table, where);
  }

  async sqlSelect(companyId: string, actor: DataActor, sql: string, params: unknown[] = []): Promise<{ columns: string[]; rows: Row[]; truncated: boolean }> {
    const scope = await this.authorize(companyId, actor, "read", "run SQL");
    return this.records.sqlSelect(scope, sql, params);
  }

  // ---- administration ---------------------------------------------------

  async listAgentGrants(companyId: string, actor: DataActor): Promise<AgentGrant[]> {
    await this.authorizeAdmin(companyId, actor);
    return listAgentGrants(this.pool, companyId);
  }

  async setAgentGrant(companyId: string, actor: DataActor, agentId: string, level: AccessLevel): Promise<AgentGrant> {
    await this.authorizeAdmin(companyId, actor);
    if (!agentId) throw new DataError("invalid", "agentId is required");
    const grant = await setAgentGrant(this.pool, companyId, agentId, level, actor.id);
    await this.audit(companyId, actor, "set_agent_grant", null, { agentId, level }, `set agent ${agentId} data access to ${level}`);
    return grant;
  }

  async getSettings(companyId: string, actor: DataActor): Promise<CompanySettings> {
    await this.authorizeAdmin(companyId, actor);
    return getCompanySettings(this.pool, companyId);
  }

  async setSettings(companyId: string, actor: DataActor, patch: Partial<CompanySettings>): Promise<CompanySettings> {
    await this.authorizeAdmin(companyId, actor);
    const settings = await setCompanySettings(this.pool, companyId, patch);
    await this.audit(companyId, actor, "set_settings", null, { ...settings }, `updated data settings`);
    return settings;
  }

  async purgeTrash(companyId: string): Promise<{ droppedTables: string[]; droppedColumns: string[] }> {
    const scope = await this.scope(companyId);
    const result = await this.schema.purgeTrash(scope, TRASH_RETENTION_MS);
    if (result.droppedTables.length + result.droppedColumns.length > 0) {
      await this.audit(companyId, { kind: "system", id: null }, "purge_trash", null, result, `purged ${result.droppedTables.length} table(s) and ${result.droppedColumns.length} column(s)`);
    }
    return result;
  }

  // ---- internals --------------------------------------------------------

  private async authorize(companyId: string, actor: DataActor, op: Operation, what: string): Promise<CompanyScope> {
    const scope = await this.scope(companyId);
    assertLevel(await this.levelFor(companyId, actor), op, what);
    return scope;
  }

  private async authorizeAdmin(companyId: string, actor: DataActor): Promise<void> {
    if (actor.kind !== "user") throw new DataError("forbidden", "only company admins manage data access");
    assertLevel(await this.levelFor(companyId, actor), "schema", "managing data access");
  }

  private async audit(companyId: string, actor: DataActor, operation: string, table: string | null, details: Record<string, unknown>, summary: string): Promise<void> {
    await recordAudit(this.pool, { companyId, actor, operation, table, details });
    if (this.onMutation) await this.onMutation({ companyId, actor, operation, table, summary });
  }
}
```

- [ ] **Step 4: Run the integration tests to verify they pass, then commit**

Run: `pnpm --filter @kyoube/plugin-apps test:integration`
Expected: PASS

```bash
git add plugins/kyoube-apps/src/data/service.ts plugins/kyoube-apps/tests/integration/data-service.spec.ts
git commit -m "feat(apps): actor-aware DataService facade with audit"
```

---

### Task 9: Agent tools and the managed skill

**Files:**
- Create: `plugins/kyoube-apps/src/tools.ts`, `plugins/kyoube-apps/src/skills/kyoube-data.md`, `plugins/kyoube-apps/tests/stub-service.ts`
- Test: `plugins/kyoube-apps/tests/unit/tools.spec.ts`

**Interfaces:**
- Consumes: `DataService` (Task 8); SDK `ctx.tools.register(name, { displayName, description, parametersSchema }, (params, runCtx) => Promise<ToolResult>)`, `ToolRunContext { agentId, runId, companyId, projectId }`, `ToolResult { content?, data?, error? }`.
- Produces:
  ```ts
  export interface ToolDefinition { name: string; displayName: string; description: string; schema: z.ZodTypeAny; run: (service: DataService, companyId: string, actor: DataActor, params: any) => Promise<unknown> }
  export const TOOL_DEFINITIONS: ToolDefinition[];               // the 17 tools from Global Constraints
  export function toolDeclarations(): PluginToolDeclaration[];  // manifest `tools`, parametersSchema via z.toJSONSchema
  export function registerTools(ctx: PluginContext, service: DataService): void;
  export function formatToolResult(data: unknown): string;      // pretty JSON, capped at 20 000 chars with a truncation note
  // tests/stub-service.ts
  export function createStubService(): { service: DataService; calls: Array<{ method: string; args: unknown[] }> }
  ```
- Tool errors are returned as `{ error }` (never thrown) so the agent sees the reason and the `hint` for access problems.

- [ ] **Step 1: Write the stub service and the failing tests**

`plugins/kyoube-apps/tests/stub-service.ts`:
```ts
import type { DataService } from "../src/data/service.js";
import { DataError } from "../src/data/errors.js";

/** Records every call; each method returns a recognisable value or throws `fail` when it is given. */
export function createStubService(fail?: DataError) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const handler: ProxyHandler<object> = {
    get(_target, method: string) {
      if (method === "then") return undefined;
      return async (...args: unknown[]) => {
        calls.push({ method, args });
        if (fail) throw fail;
        if (method === "myAccess") return { level: "write", actorKind: "agent", hint: "ok" };
        if (method === "listTables") return [{ name: "contacts", displayName: "Contacts", description: null, fields: [], createdAt: "", updatedAt: "" }];
        if (method === "count") return 3;
        return { method, args };
      };
    },
  };
  return { service: new Proxy({}, handler) as unknown as DataService, calls };
}
```

`plugins/kyoube-apps/tests/unit/tools.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { DataError } from "../../src/data/errors.js";
import manifest from "../../src/manifest.js";
import { TOOL_DEFINITIONS, formatToolResult, registerTools, toolDeclarations } from "../../src/tools.js";
import { createStubService } from "../stub-service.js";

const RUN = { agentId: "agent-1", runId: "run-1", companyId: "11111111-1111-4111-8111-111111111111", projectId: "p1" };

describe("tool declarations", () => {
  it("declares every tool with a JSON schema object", () => {
    const declarations = toolDeclarations();
    expect(declarations.map((tool) => tool.name)).toEqual([
      "data_list_tables", "data_describe_table", "data_create_table", "data_add_field", "data_update_field", "data_remove_field",
      "data_drop_table", "data_rename_table", "data_create_index", "data_insert", "data_update", "data_delete", "data_get",
      "data_query", "data_count", "data_sql_select", "data_my_access",
    ]);
    for (const tool of declarations) {
      expect(tool.parametersSchema).toMatchObject({ type: "object" });
      expect(tool.parametersSchema).not.toHaveProperty("$schema");
      expect(tool.description.length).toBeGreaterThan(20);
    }
    expect(manifest.tools?.map((tool) => tool.name)).toEqual(declarations.map((tool) => tool.name));
  });
  it("formats results and truncates huge payloads", () => {
    expect(formatToolResult({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatToolResult("x".repeat(30_000))).toContain("truncated");
  });
});

describe("registerTools", () => {
  function setup(fail?: DataError) {
    const harness = createTestHarness({ manifest, capabilities: ["agent.tools.register"] });
    const stub = createStubService(fail);
    registerTools(harness.ctx, stub.service);
    return { harness, ...stub };
  }

  it("routes tool calls to the service with an agent actor", async () => {
    const { harness, calls } = setup();
    const result = await harness.executeTool("data_create_table", { name: "contacts", fields: [{ name: "email", kind: "email" }] }, RUN);
    expect(calls[0]).toEqual({ method: "createTable", args: [RUN.companyId, { kind: "agent", id: "agent-1", runId: "run-1" }, { name: "contacts", displayName: undefined, description: undefined, fields: [{ name: "email", kind: "email" }] }] });
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("createTable");
    await harness.executeTool("data_query", { table: "contacts", where: { field: "email", op: "is_not_null" }, limit: 10 }, RUN);
    expect(calls[1]).toEqual({ method: "query", args: [RUN.companyId, { kind: "agent", id: "agent-1", runId: "run-1" }, "contacts", { where: { field: "email", op: "is_not_null" }, orderBy: undefined, limit: 10, offset: undefined, fields: undefined }] });
    const count = await harness.executeTool("data_count", { table: "contacts" }, RUN);
    expect(count.data).toEqual({ count: 3 });
  });

  it("returns validation problems and service errors as tool errors", async () => {
    const { harness } = setup();
    const bad = await harness.executeTool("data_insert", { table: "contacts" }, RUN);
    expect(bad.error).toContain("rows");
    const { harness: failing } = setup(new DataError("forbidden", "insert rows requires write access (you have none)"));
    const denied = await failing.executeTool("data_insert", { table: "contacts", rows: [{ a: 1 }] }, RUN);
    expect(denied.error).toBe("forbidden: insert rows requires write access (you have none)");
  });

  it("every declared tool has a registered handler", async () => {
    const { harness } = setup();
    for (const tool of TOOL_DEFINITIONS) {
      await expect(harness.executeTool(tool.name, {}, RUN)).resolves.toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kyoube/plugin-apps test`
Expected: FAIL — `Cannot find module '../../src/tools.js'`

- [ ] **Step 3: Implement tools.ts**

`plugins/kyoube-apps/src/tools.ts`:
```ts
import type { PluginContext, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { DataError } from "./data/errors.js";
import { FIELD_KINDS } from "./data/field-kinds.js";
import { ACCESS_LEVELS, type DataActor } from "./data/permissions.js";
import type { DataService } from "./data/service.js";

const identifier = z.string().min(1).max(63).describe("lowercase snake_case name, e.g. contacts");
const fieldSpec = z.object({
  name: identifier,
  kind: z.enum(FIELD_KINDS).describe("text | long_text | integer | decimal | boolean | date | datetime | json | select | multi_select | relation | email | url"),
  displayName: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  options: z.object({
    choices: z.array(z.string()).optional().describe("for select / multi_select"),
    relationTable: identifier.optional().describe("for relation: the table the field points to"),
  }).optional(),
});
const where = z.unknown().describe('filter: { field, op, value } with op in eq|neq|gt|gte|lt|lte|in|contains|starts_with|is_null|is_not_null, or { and: [...] } | { or: [...] } | { not: {...} }');
const rowTarget = { ids: z.array(z.string()).optional().describe("row ids (uuid)"), where: where.optional() };

export interface ToolDefinition {
  name: string;
  displayName: string;
  description: string;
  schema: z.ZodTypeAny;
  run: (service: DataService, companyId: string, actor: DataActor, params: any) => Promise<unknown>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: "data_list_tables", displayName: "List tables", description: "List the organisation database tables in this company with their fields.", schema: z.object({}), run: (s, c, a) => s.listTables(c, a) },
  { name: "data_describe_table", displayName: "Describe table", description: "Show one table: fields, kinds, choices, relations, and system columns (id, created_at, updated_at).", schema: z.object({ table: identifier }), run: (s, c, a, p) => s.describeTable(c, a, p.table) },
  { name: "data_create_table", displayName: "Create table", description: "Create a table with typed fields. Every table automatically gets id (uuid), created_at, updated_at, created_by_kind, created_by_id. Requires schema access.", schema: z.object({ name: identifier, displayName: z.string().optional(), description: z.string().optional(), fields: z.array(fieldSpec).max(100) }), run: (s, c, a, p) => s.createTable(c, a, { name: p.name, displayName: p.displayName, description: p.description, fields: p.fields }) },
  { name: "data_add_field", displayName: "Add field", description: "Add a field (column) to an existing table. Requires schema access.", schema: z.object({ table: identifier, field: fieldSpec }), run: (s, c, a, p) => s.addField(c, a, p.table, p.field) },
  { name: "data_update_field", displayName: "Update field", description: "Change a field's display name, description, required flag, or choices (select/multi_select). Kinds cannot change. Requires schema access.", schema: z.object({ table: identifier, field: identifier, displayName: z.string().optional(), description: z.string().nullable().optional(), required: z.boolean().optional(), choices: z.array(z.string()).optional() }), run: (s, c, a, p) => s.updateField(c, a, p.table, p.field, { displayName: p.displayName, description: p.description, required: p.required, choices: p.choices }) },
  { name: "data_remove_field", displayName: "Remove field", description: "Remove a field. Recoverable for 30 days unless the company enabled hard deletes. Requires schema access.", schema: z.object({ table: identifier, field: identifier }), run: (s, c, a, p) => s.removeField(c, a, p.table, p.field) },
  { name: "data_drop_table", displayName: "Drop table", description: "Drop a table. Recoverable for 30 days unless the company enabled hard deletes. Requires schema access.", schema: z.object({ table: identifier }), run: (s, c, a, p) => s.dropTable(c, a, p.table) },
  { name: "data_rename_table", displayName: "Rename table", description: "Rename a table. Requires schema access.", schema: z.object({ table: identifier, newName: identifier }), run: (s, c, a, p) => s.renameTable(c, a, p.table, p.newName) },
  { name: "data_create_index", displayName: "Create index", description: "Create an index (optionally unique) on 1-4 fields of a table. Requires schema access.", schema: z.object({ table: identifier, fields: z.array(identifier).min(1).max(4), unique: z.boolean().optional() }), run: (s, c, a, p) => s.createIndex(c, a, p.table, p.fields, p.unique ?? false) },
  { name: "data_insert", displayName: "Insert rows", description: "Insert 1-500 rows. Values are validated against field kinds (dates YYYY-MM-DD, select values from choices, relation = uuid of the target row). Returns the created rows. Requires write access.", schema: z.object({ table: identifier, rows: z.array(z.record(z.string(), z.unknown())).min(1).max(500) }), run: (s, c, a, p) => s.insert(c, a, p.table, p.rows) },
  { name: "data_update", displayName: "Update rows", description: "Update rows selected by ids or a where filter (exactly one). At most 1000 rows per call. Requires write access.", schema: z.object({ table: identifier, ...rowTarget, patch: z.record(z.string(), z.unknown()) }), run: (s, c, a, p) => s.update(c, a, p.table, { ids: p.ids, where: p.where }, p.patch) },
  { name: "data_delete", displayName: "Delete rows", description: "Delete rows selected by ids or a where filter (exactly one). At most 1000 rows per call. Requires write access.", schema: z.object({ table: identifier, ...rowTarget }), run: (s, c, a, p) => s.delete(c, a, p.table, { ids: p.ids, where: p.where }) },
  { name: "data_get", displayName: "Get row", description: "Fetch one row by id.", schema: z.object({ table: identifier, id: z.string() }), run: (s, c, a, p) => s.get(c, a, p.table, p.id) },
  { name: "data_query", displayName: "Query rows", description: "Query rows with an optional where filter, orderBy, limit (max 1000, default 50), offset, and a field list.", schema: z.object({ table: identifier, where: where.optional(), orderBy: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).optional() })).optional(), limit: z.number().int().optional(), offset: z.number().int().optional(), fields: z.array(z.string()).optional() }), run: (s, c, a, p) => s.query(c, a, p.table, { where: p.where, orderBy: p.orderBy, limit: p.limit, offset: p.offset, fields: p.fields }) },
  { name: "data_count", displayName: "Count rows", description: "Count rows matching an optional where filter.", schema: z.object({ table: identifier, where: where.optional() }), run: async (s, c, a, p) => ({ count: await s.count(c, a, p.table, p.where) }) },
  { name: "data_sql_select", displayName: "Read-only SQL", description: "Run one read-only SELECT (joins, aggregates, CTEs allowed) against this company's tables. Use $1, $2 placeholders with params. Max 1000 rows, 5 s.", schema: z.object({ sql: z.string().min(1).max(20_000), params: z.array(z.unknown()).max(50).optional() }), run: (s, c, a, p) => s.sqlSelect(c, a, p.sql, p.params ?? []) },
  { name: "data_my_access", displayName: "My data access", description: `Show your access level (${ACCESS_LEVELS.join(" < ")}) and how to request more.`, schema: z.object({}), run: (s, c, a) => s.myAccess(c, a) },
];

const MAX_CONTENT_CHARS = 20_000;

export function formatToolResult(data: unknown): string {
  const text = JSON.stringify(data, null, 2) ?? "null";
  return text.length > MAX_CONTENT_CHARS ? `${text.slice(0, MAX_CONTENT_CHARS)}\n… (truncated; narrow the query or use limit/offset)` : text;
}

function jsonSchemaFor(schema: z.ZodTypeAny): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete generated.$schema;
  return generated;
}

export function toolDeclarations(): PluginToolDeclaration[] {
  return TOOL_DEFINITIONS.map((tool) => ({ name: tool.name, displayName: tool.displayName, description: tool.description, parametersSchema: jsonSchemaFor(tool.schema) }));
}

export function registerTools(ctx: PluginContext, service: DataService): void {
  for (const tool of TOOL_DEFINITIONS) {
    ctx.tools.register(tool.name, { displayName: tool.displayName, description: tool.description, parametersSchema: jsonSchemaFor(tool.schema) }, async (params, runCtx) => {
      const parsed = tool.schema.safeParse(params ?? {});
      if (!parsed.success) {
        return { error: `invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "params"} ${issue.message}`).join("; ")}` };
      }
      const actor: DataActor = { kind: "agent", id: runCtx.agentId, runId: runCtx.runId };
      try {
        const data = await tool.run(service, runCtx.companyId, actor, parsed.data);
        return { content: formatToolResult(data), data };
      } catch (error) {
        const message = error instanceof DataError ? error.message : `error: ${error instanceof Error ? error.message : String(error)}`;
        ctx.logger.warn("data tool failed", { tool: tool.name, agentId: runCtx.agentId, message });
        return { error: message };
      }
    });
  }
}
```

- [ ] **Step 4: Write the managed skill**

`plugins/kyoube-apps/src/skills/kyoube-data.md`:
```markdown
---
name: kyoube-data
description: Use the Kyoube organisation database (tables, fields, records, read-only SQL) through the kyoube.apps tools or API when a task needs structured company data such as contacts, deals, inventory, tickets, or reports.
---

# Kyoube Data

Every company in KyoubeAI has its own isolated Postgres schema. You work with it through the
`kyoube.apps:data_*` tools (or the REST routes below). Nothing you do here can touch other
companies' data or Paperclip's own tables.

## Check your access first

Call `data_my_access`. Levels: `none < read < write < schema`.
- `read`: list/describe/query/count/get/sql_select
- `write`: also insert/update/delete rows
- `schema`: also create/alter/drop tables and fields

If your level is too low, stop and tell the user: a company admin raises it under
**Company Settings → Data access**. Do not retry the call in a loop.

## Designing tables

1. `data_list_tables` — reuse existing tables before creating new ones.
2. `data_create_table` with lowercase snake_case names and typed fields. Prefer:
   - `text` / `long_text` for free text, `email`, `url`
   - `integer` / `decimal` for numbers, `boolean`
   - `date` (YYYY-MM-DD) / `datetime` (ISO 8601)
   - `select` with `options.choices` for statuses; `multi_select` for tags
   - `relation` with `options.relationTable` to link rows (stores the target row's `id`)
   - `json` only for genuinely unstructured data
3. Every table already has `id`, `created_at`, `updated_at`, `created_by_kind`, `created_by_id` — never add them.
4. Evolve carefully: `data_add_field`, `data_update_field` (choices/required/labels), `data_rename_table`.
   `data_remove_field` and `data_drop_table` are recoverable for 30 days but still confirm with the user first.

Example:
```json
{ "name": "deals", "displayName": "Deals", "fields": [
  { "name": "title", "kind": "text", "required": true },
  { "name": "amount", "kind": "decimal" },
  { "name": "stage", "kind": "select", "options": { "choices": ["new", "qualified", "won", "lost"] } },
  { "name": "contact", "kind": "relation", "options": { "relationTable": "contacts" } },
  { "name": "closes_on", "kind": "date" } ] }
```

## Working with rows

- `data_insert` — up to 500 rows per call; values are validated against the field kinds.
- `data_query` — `where` filters, `orderBy`, `limit` (≤ 1000), `offset`, `fields`.
  Filter grammar: `{ "field": "stage", "op": "eq", "value": "won" }`, ops `eq neq gt gte lt lte in contains starts_with is_null is_not_null`,
  combined with `{ "and": [...] }`, `{ "or": [...] }`, `{ "not": {...} }`.
- `data_update` / `data_delete` — select rows with `ids` **or** `where` (exactly one); ≤ 1000 rows per call.
- `data_sql_select` — one read-only SELECT for joins, aggregates, and reports; use `$1, $2` placeholders with `params`.
  Table names are plain (`deals`, `contacts`); no schema prefix.

## Reporting back

Summarise what changed (tables/fields/row counts), link the Data page (`/<company>/data`), and
never paste more than a handful of rows into an issue comment — point to the table instead.

## REST alternative (curl from a run)

`$PAPERCLIP_API_URL/api/plugins/kyoube.apps/api/...` with `Authorization: Bearer $PAPERCLIP_API_KEY`:
`GET /tables?companyId=$PAPERCLIP_COMPANY_ID`, `POST /tables`, `POST /tables/{table}/rows`,
`POST /tables/{table}/rows/query`, `POST /sql`, `GET /access/me?companyId=…`. Bodies for POST include `companyId`.
```

- [ ] **Step 5: Add the tools and skill to the manifest**

In `plugins/kyoube-apps/src/manifest.ts` add the imports and fields:
```ts
import skillMarkdown from "./skills/kyoube-data.md";
import { toolDeclarations } from "./tools.js";
export const DATA_SKILL_KEY = "kyoube-data";
// inside the manifest object:
  tools: toolDeclarations(),
  skills: [{ skillKey: DATA_SKILL_KEY, displayName: "Kyoube Data", slug: "kyoube-data", description: "Design and use the company's Kyoube organisation database through the kyoube.apps tools.", markdown: skillMarkdown }],
```
and add `"agent.tools.register"` and `"skills.managed"` to `capabilities` (the full capability list is finalised in Task 11).

Change `build.mjs` so the manifest is fully bundled (the host imports `dist/manifest.js` directly and must not resolve `zod` or the markdown loader at runtime): split the first build into two calls — `{ entryPoints: { manifest: "src/manifest.ts" }, bundle: true, packages: "bundle", loader: { ".md": "text" }, ... }` and `{ entryPoints: { worker: "src/worker.ts" }, bundle: true, packages: "external", loader: { ".md": "text" }, ... }`.

- [ ] **Step 6: Run the tests to verify they pass, then commit**

Run: `pnpm --filter @kyoube/plugin-apps test && pnpm --filter @kyoube/plugin-apps build && node -e "import('./plugins/kyoube-apps/dist/manifest.js').then(m => console.log(m.default.tools.length, m.default.skills[0].skillKey))"`
Expected: PASS; prints `17 kyoube-data`.

```bash
git add plugins/kyoube-apps
git commit -m "feat(apps): agent tools with zod schemas and the kyoube-data managed skill"
```

---

### Task 10: Scoped API routes

**Files:**
- Create: `plugins/kyoube-apps/src/api-routes.ts`
- Test: `plugins/kyoube-apps/tests/unit/api-routes.spec.ts`

**Interfaces:**
- Consumes: SDK `PluginApiRouteDeclaration { routeKey, method, path, auth, capability: "api.routes.register", companyResolution }`, `PluginApiRequestInput { routeKey, method, path, params, query, body, actor: { actorType: "user" | "agent", actorId, agentId?, userId?, runId? }, companyId, headers }`, `PluginApiResponse { status?, headers?, body? }`.
- Produces:
  ```ts
  export const API_ROUTES: PluginApiRouteDeclaration[];
  export function actorFromRequest(input: PluginApiRequestInput): DataActor;
  export async function handleApiRequest(service: DataService, input: PluginApiRequestInput): Promise<PluginApiResponse>;
  export function statusForError(error: unknown): number;   // invalid 400, forbidden 403, not_found 404, conflict 409, limit 413, other 500
  ```
- Route table (all mounted under `/api/plugins/kyoube.apps/api`; GET routes resolve the company from `?companyId=`, POST routes from `body.companyId`):

  | routeKey | method | path | body |
  |---|---|---|---|
  | `access.me` | GET | `/access/me` | — |
  | `tables.list` | GET | `/tables` | — |
  | `tables.create` | POST | `/tables` | `{ name, displayName?, description?, fields }` |
  | `tables.get` | GET | `/tables/:table` | — |
  | `tables.rename` | POST | `/tables/:table/rename` | `{ newName }` |
  | `tables.drop` | POST | `/tables/:table/drop` | — |
  | `fields.add` | POST | `/tables/:table/fields` | `{ field }` |
  | `fields.update` | POST | `/tables/:table/fields/:field/update` | `{ displayName?, description?, required?, choices? }` |
  | `fields.remove` | POST | `/tables/:table/fields/:field/remove` | — |
  | `indexes.create` | POST | `/tables/:table/indexes` | `{ fields, unique? }` |
  | `rows.insert` | POST | `/tables/:table/rows` | `{ rows }` |
  | `rows.query` | POST | `/tables/:table/rows/query` | `{ where?, orderBy?, limit?, offset?, fields? }` |
  | `rows.count` | POST | `/tables/:table/rows/count` | `{ where? }` |
  | `rows.get` | GET | `/tables/:table/rows/:id` | — |
  | `rows.update` | POST | `/tables/:table/rows/update` | `{ ids?, where?, patch }` |
  | `rows.delete` | POST | `/tables/:table/rows/delete` | `{ ids?, where? }` |
  | `sql.select` | POST | `/sql` | `{ sql, params? }` |

- [ ] **Step 1: Write the failing tests**

`plugins/kyoube-apps/tests/unit/api-routes.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { API_ROUTES, actorFromRequest, handleApiRequest, statusForError } from "../../src/api-routes.js";
import { DataError } from "../../src/data/errors.js";
import { createStubService } from "../stub-service.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";

function request(routeKey: string, overrides: Partial<PluginApiRequestInput> = {}): PluginApiRequestInput {
  const route = API_ROUTES.find((entry) => entry.routeKey === routeKey)!;
  return { routeKey, method: route.method, path: route.path, params: {}, query: {}, body: undefined, actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1", runId: "run-1" }, companyId: COMPANY, headers: {}, ...overrides };
}

describe("API_ROUTES", () => {
  it("declares GET routes with query company resolution and POST routes with body resolution", () => {
    expect(API_ROUTES.map((route) => route.routeKey)).toContain("rows.query");
    for (const route of API_ROUTES) {
      expect(route.auth).toBe("board-or-agent");
      expect(route.capability).toBe("api.routes.register");
      expect(route.companyResolution).toEqual(route.method === "GET" ? { from: "query", key: "companyId" } : { from: "body", key: "companyId" });
    }
  });
});

describe("handleApiRequest", () => {
  it("maps actors and dispatches to the service", async () => {
    expect(actorFromRequest(request("tables.list"))).toEqual({ kind: "agent", id: "agent-1", runId: "run-1" });
    expect(actorFromRequest(request("tables.list", { actor: { actorType: "user", actorId: "u1", userId: "u1" } }))).toEqual({ kind: "user", id: "u1", runId: null });
    const { service, calls } = createStubService();
    const listed = await handleApiRequest(service, request("tables.list"));
    expect(listed.status).toBe(200);
    expect(calls[0]).toEqual({ method: "listTables", args: [COMPANY, { kind: "agent", id: "agent-1", runId: "run-1" }] });
    await handleApiRequest(service, request("rows.query", { params: { table: "deals" }, body: { companyId: COMPANY, where: { field: "stage", op: "eq", value: "won" }, limit: 5 } }));
    expect(calls[1]).toEqual({ method: "query", args: [COMPANY, { kind: "agent", id: "agent-1", runId: "run-1" }, "deals", { where: { field: "stage", op: "eq", value: "won" }, orderBy: undefined, limit: 5, offset: undefined, fields: undefined }] });
    await handleApiRequest(service, request("fields.update", { params: { table: "deals", field: "stage" }, body: { companyId: COMPANY, choices: ["a"] } }));
    expect(calls[2]).toEqual({ method: "updateField", args: [COMPANY, expect.anything(), "deals", "stage", { displayName: undefined, description: undefined, required: undefined, choices: ["a"] }] });
    const count = await handleApiRequest(service, request("rows.count", { params: { table: "deals" }, body: { companyId: COMPANY } }));
    expect(count.body).toEqual({ count: 3 });
  });

  it("returns 400 for invalid bodies, maps DataError codes, and 404 for unknown route keys", async () => {
    const { service } = createStubService();
    expect((await handleApiRequest(service, request("rows.insert", { params: { table: "deals" }, body: { companyId: COMPANY } }))).status).toBe(400);
    expect((await handleApiRequest(service, request("nope"))).status).toBe(404);
    const denied = createStubService(new DataError("forbidden", "no"));
    const response = await handleApiRequest(denied.service, request("tables.list"));
    expect(response).toEqual({ status: 403, body: { error: "forbidden: no", code: "forbidden" } });
    expect(statusForError(new DataError("limit", "x"))).toBe(413);
    expect(statusForError(new Error("boom"))).toBe(500);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kyoube/plugin-apps test`
Expected: FAIL — `Cannot find module '../../src/api-routes.js'`

- [ ] **Step 3: Implement api-routes.ts**

`plugins/kyoube-apps/src/api-routes.ts`:
```ts
import type { PluginApiRequestInput, PluginApiResponse, PluginApiRouteDeclaration } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { DataError } from "./data/errors.js";
import { FIELD_KINDS } from "./data/field-kinds.js";
import type { DataActor } from "./data/permissions.js";
import type { DataService } from "./data/service.js";

type Method = "GET" | "POST";

function route(routeKey: string, method: Method, path: string): PluginApiRouteDeclaration {
  return {
    routeKey,
    method,
    path,
    auth: "board-or-agent",
    capability: "api.routes.register",
    companyResolution: method === "GET" ? { from: "query", key: "companyId" } : { from: "body", key: "companyId" },
  };
}

export const API_ROUTES: PluginApiRouteDeclaration[] = [
  route("access.me", "GET", "/access/me"),
  route("tables.list", "GET", "/tables"),
  route("tables.create", "POST", "/tables"),
  route("tables.get", "GET", "/tables/:table"),
  route("tables.rename", "POST", "/tables/:table/rename"),
  route("tables.drop", "POST", "/tables/:table/drop"),
  route("fields.add", "POST", "/tables/:table/fields"),
  route("fields.update", "POST", "/tables/:table/fields/:field/update"),
  route("fields.remove", "POST", "/tables/:table/fields/:field/remove"),
  route("indexes.create", "POST", "/tables/:table/indexes"),
  route("rows.insert", "POST", "/tables/:table/rows"),
  route("rows.query", "POST", "/tables/:table/rows/query"),
  route("rows.count", "POST", "/tables/:table/rows/count"),
  route("rows.get", "GET", "/tables/:table/rows/:id"),
  route("rows.update", "POST", "/tables/:table/rows/update"),
  route("rows.delete", "POST", "/tables/:table/rows/delete"),
  route("sql.select", "POST", "/sql"),
];

const fieldSpec = z.object({
  name: z.string(),
  kind: z.enum(FIELD_KINDS),
  displayName: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  options: z.object({ choices: z.array(z.string()).optional(), relationTable: z.string().optional() }).optional(),
});
const bodies = {
  "tables.create": z.object({ name: z.string(), displayName: z.string().optional(), description: z.string().nullable().optional(), fields: z.array(fieldSpec).max(100) }),
  "tables.rename": z.object({ newName: z.string() }),
  "fields.add": z.object({ field: fieldSpec }),
  "fields.update": z.object({ displayName: z.string().optional(), description: z.string().nullable().optional(), required: z.boolean().optional(), choices: z.array(z.string()).optional() }),
  "indexes.create": z.object({ fields: z.array(z.string()).min(1).max(4), unique: z.boolean().optional() }),
  "rows.insert": z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(500) }),
  "rows.query": z.object({ where: z.unknown().optional(), orderBy: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).optional() })).optional(), limit: z.number().int().optional(), offset: z.number().int().optional(), fields: z.array(z.string()).optional() }),
  "rows.count": z.object({ where: z.unknown().optional() }),
  "rows.update": z.object({ ids: z.array(z.string()).optional(), where: z.unknown().optional(), patch: z.record(z.string(), z.unknown()) }),
  "rows.delete": z.object({ ids: z.array(z.string()).optional(), where: z.unknown().optional() }),
  "sql.select": z.object({ sql: z.string().min(1).max(20_000), params: z.array(z.unknown()).max(50).optional() }),
} as const;

export function actorFromRequest(input: PluginApiRequestInput): DataActor {
  const actor = input.actor;
  if (actor.actorType === "agent") return { kind: "agent", id: actor.agentId ?? actor.actorId, runId: actor.runId ?? null };
  return { kind: "user", id: actor.userId ?? actor.actorId, runId: null };
}

export function statusForError(error: unknown): number {
  if (error instanceof DataError) {
    return { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, limit: 413 }[error.code];
  }
  return 500;
}

function parseBody<K extends keyof typeof bodies>(key: K, body: unknown): z.infer<(typeof bodies)[K]> {
  const parsed = bodies[key].safeParse(body ?? {});
  if (!parsed.success) throw new DataError("invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"} ${issue.message}`).join("; "));
  return parsed.data as z.infer<(typeof bodies)[K]>;
}

function param(input: PluginApiRequestInput, name: string): string {
  const value = input.params[name];
  if (!value) throw new DataError("invalid", `${name} is required`);
  return value;
}

export async function handleApiRequest(service: DataService, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const companyId = input.companyId;
  const actor = actorFromRequest(input);
  try {
    const body = await dispatch(service, input, companyId, actor);
    if (body === undefined) return { status: 404, body: { error: `unknown route ${input.routeKey}`, code: "not_found" } };
    return { status: 200, body };
  } catch (error) {
    const status = statusForError(error);
    const message = error instanceof DataError ? error.message : `error: ${error instanceof Error ? error.message : String(error)}`;
    return { status, body: { error: message, code: error instanceof DataError ? error.code : "error" } };
  }
}

async function dispatch(service: DataService, input: PluginApiRequestInput, companyId: string, actor: DataActor): Promise<unknown> {
  switch (input.routeKey) {
    case "access.me": return service.myAccess(companyId, actor);
    case "tables.list": return service.listTables(companyId, actor);
    case "tables.create": { const b = parseBody("tables.create", input.body); return service.createTable(companyId, actor, { name: b.name, displayName: b.displayName, description: b.description, fields: b.fields }); }
    case "tables.get": return service.describeTable(companyId, actor, param(input, "table"));
    case "tables.rename": { const b = parseBody("tables.rename", input.body); return service.renameTable(companyId, actor, param(input, "table"), b.newName); }
    case "tables.drop": return service.dropTable(companyId, actor, param(input, "table"));
    case "fields.add": { const b = parseBody("fields.add", input.body); return service.addField(companyId, actor, param(input, "table"), b.field); }
    case "fields.update": { const b = parseBody("fields.update", input.body); return service.updateField(companyId, actor, param(input, "table"), param(input, "field"), { displayName: b.displayName, description: b.description, required: b.required, choices: b.choices }); }
    case "fields.remove": return service.removeField(companyId, actor, param(input, "table"), param(input, "field"));
    case "indexes.create": { const b = parseBody("indexes.create", input.body); return service.createIndex(companyId, actor, param(input, "table"), b.fields, b.unique ?? false); }
    case "rows.insert": { const b = parseBody("rows.insert", input.body); return service.insert(companyId, actor, param(input, "table"), b.rows); }
    case "rows.query": { const b = parseBody("rows.query", input.body); return service.query(companyId, actor, param(input, "table"), { where: b.where, orderBy: b.orderBy, limit: b.limit, offset: b.offset, fields: b.fields }); }
    case "rows.count": { const b = parseBody("rows.count", input.body); return { count: await service.count(companyId, actor, param(input, "table"), b.where) }; }
    case "rows.get": return service.get(companyId, actor, param(input, "table"), param(input, "id"));
    case "rows.update": { const b = parseBody("rows.update", input.body); return service.update(companyId, actor, param(input, "table"), { ids: b.ids, where: b.where }, b.patch); }
    case "rows.delete": { const b = parseBody("rows.delete", input.body); return service.delete(companyId, actor, param(input, "table"), { ids: b.ids, where: b.where }); }
    case "sql.select": { const b = parseBody("sql.select", input.body); return service.sqlSelect(companyId, actor, b.sql, b.params ?? []); }
    default: return undefined;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass, then commit**

Run: `pnpm --filter @kyoube/plugin-apps test`
Expected: PASS

```bash
git add plugins/kyoube-apps/src/api-routes.ts plugins/kyoube-apps/tests/unit/api-routes.spec.ts
git commit -m "feat(apps): scoped REST routes for tables, rows, and SQL"
```

---

### Task 11: Plugin wiring — setup, UI bridge, API dispatch, purge job, health

**Files:**
- Create: `plugins/kyoube-apps/src/plugin.ts`, `plugins/kyoube-apps/src/roles.ts`
- Modify: `plugins/kyoube-apps/src/manifest.ts` (final capabilities, slots, apiRoutes, jobs), `plugins/kyoube-apps/src/worker.ts`
- Test: `plugins/kyoube-apps/tests/unit/plugin.spec.ts`

**Interfaces:**
- Consumes: Tasks 1, 8, 9, 10; SDK `ctx.actions/data/tools/activity/access/agents/skills/jobs`, `PluginPerformActionContext`.
- Produces:
  ```ts
  export interface AppsPluginDeps {
    loadKyoubeConfig: () => Promise<KyoubeRuntimeConfig>;
    migrationsDir: string;
    createPool?: (url: string) => Pool;                                    // default createPool
    migrate?: (pool: Pool, dir: string) => Promise<unknown>;                // default runMetaMigrations
    createService?: (deps: DataServiceDeps) => DataService;                 // default new DataService(deps)
  }
  export function createAppsPlugin(deps: AppsPluginDeps): PaperclipPlugin;
  export function actorFromAction(context: PluginPerformActionContext): DataActor;   // throws DataError forbidden for non user/agent
  ```
  UI bridge keys (all company-scoped through the host bridge):
  - data (reads, `{ companyId, userId, ... }`): `data.tables`, `data.table { table }`, `data.rows { table, where?, orderBy?, limit?, offset? }`, `data.count { table, where? }`, `data.access { userId }`
  - actions (actor-aware): `data.create_table`, `data.add_field`, `data.update_field`, `data.remove_field`, `data.drop_table`, `data.rename_table`, `data.insert`, `data.update`, `data.delete`, `data.sql_select`, `data.grants` (→ `{ settings, grants, agents: [{ id, name, status }] }`), `data.set_agent_grant { agentId, level }`, `data.set_settings { defaultAgentLevel?, hardDelete? }`, `data.setup_company` (reconciles the managed skill; returns the resolution)
  - job `purge-trash` daily at 03:00 UTC; `onApiRequest` → `handleApiRequest`.

- [ ] **Step 1: Finalise the manifest**

Replace `plugins/kyoube-apps/src/manifest.ts`:
```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { API_ROUTES } from "./api-routes.js";
import skillMarkdown from "./skills/kyoube-data.md";
import { toolDeclarations } from "./tools.js";

export const PLUGIN_ID = "kyoube.apps";
export const PLUGIN_VERSION = "0.2.0";
export const DATA_PAGE_ROUTE = "data";
export const DATA_ACCESS_SETTINGS_ROUTE = "data-access";
export const DATA_SKILL_KEY = "kyoube-data";
export const PURGE_JOB_KEY = "purge-trash";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kyoube Data & Apps",
  description: "Per-company organisation database that agents and people can design and populate, plus AI-built apps on top of it.",
  author: "KyoubeAI",
  categories: ["workspace", "automation", "ui"],
  capabilities: [
    "agent.tools.register",
    "api.routes.register",
    "access.members.read",
    "agents.read",
    "activity.log.write",
    "skills.managed",
    "jobs.schedule",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  tools: toolDeclarations(),
  apiRoutes: API_ROUTES,
  jobs: [{ jobKey: PURGE_JOB_KEY, displayName: "Purge trashed tables and fields", description: "Drops tables/fields soft-deleted more than 30 days ago.", schedule: "0 3 * * *" }],
  skills: [{ skillKey: DATA_SKILL_KEY, displayName: "Kyoube Data", slug: "kyoube-data", description: "Design and use the company's Kyoube organisation database through the kyoube.apps tools.", markdown: skillMarkdown }],
  ui: {
    slots: [
      { type: "page", id: "data-page", displayName: "Data", exportName: "DataPage", routePath: DATA_PAGE_ROUTE },
      { type: "sidebar", id: "data-nav", displayName: "Data", exportName: "SidebarEntry" },
      { type: "companySettingsPage", id: "data-access", displayName: "Data access", exportName: "DataAccessSettingsPage", routePath: DATA_ACCESS_SETTINGS_ROUTE },
    ],
  },
};

export default manifest;
```

- [ ] **Step 2: Write the failing plugin test**

`plugins/kyoube-apps/tests/unit/plugin.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../../src/manifest.js";
import { actorFromAction, createAppsPlugin } from "../../src/plugin.js";
import { createStubService } from "../stub-service.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ADMIN = { type: "user" as const, userId: "admin-1" };

async function setup() {
  const harness = createTestHarness({ manifest });
  harness.seed({
    accessMembers: [{ id: "m1", companyId: COMPANY, principalType: "user", principalId: "admin-1", status: "active", membershipRole: "admin", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" }],
    agents: [{ id: "agent-1", companyId: COMPANY, name: "Builder", status: "idle" } as never],
  });
  const stub = createStubService();
  const fakePool = { query: async () => ({ rows: [{ ok: 1 }] }), end: async () => {} };
  const plugin = createAppsPlugin({
    loadKyoubeConfig: async () => ({ home: "/paperclip", hermesHome: "/paperclip/.hermes", dataDatabaseUrl: "postgres://x", publicUrl: "http://localhost:3100", paperclipApiUrl: "http://127.0.0.1:3100" }),
    migrationsDir: "/nowhere",
    createPool: () => fakePool as never,
    migrate: async () => [],
    createService: () => stub.service,
  });
  await plugin.definition.setup(harness.ctx);
  return { harness, plugin, ...stub };
}

describe("kyoube.apps plugin wiring", () => {
  it("maps action actors and rejects system callers", () => {
    expect(actorFromAction({ actor: { type: "user", userId: "u1", agentId: null, runId: null, companyId: COMPANY }, companyId: COMPANY })).toEqual({ kind: "user", id: "u1", runId: null });
    expect(actorFromAction({ actor: { type: "agent", userId: null, agentId: "a1", runId: "r1", companyId: COMPANY }, companyId: COMPANY })).toEqual({ kind: "agent", id: "a1", runId: "r1" });
    expect(() => actorFromAction({ actor: { type: "system", userId: null, agentId: null, runId: null, companyId: COMPANY }, companyId: COMPANY })).toThrow("forbidden");
  });

  it("registers every tool, serves UI data, and routes actions with the actor", async () => {
    const { harness, calls } = await setup();
    await harness.executeTool("data_list_tables", {}, { companyId: COMPANY, agentId: "agent-1" });
    expect(calls.at(-1)).toMatchObject({ method: "listTables", args: [COMPANY, { kind: "agent", id: "agent-1" }] });
    const tables = await harness.getData("data.tables", { companyId: COMPANY, userId: "admin-1" });
    expect(tables).toEqual([{ name: "contacts", displayName: "Contacts", description: null, fields: [], createdAt: "", updatedAt: "" }]);
    await harness.performAction("data.create_table", { name: "deals", fields: [] }, { actor: ADMIN, companyId: COMPANY });
    expect(calls.at(-1)).toEqual({ method: "createTable", args: [COMPANY, { kind: "user", id: "admin-1", runId: null }, { name: "deals", displayName: undefined, description: undefined, fields: [] }] });
    await harness.performAction("data.insert", { table: "deals", rows: [{ title: "x" }] }, { actor: ADMIN, companyId: COMPANY });
    expect(calls.at(-1)).toEqual({ method: "insert", args: [COMPANY, { kind: "user", id: "admin-1", runId: null }, "deals", [{ title: "x" }]] });
  });

  it("returns grants with the agent directory and reconciles the skill on setup_company", async () => {
    const { harness, calls } = await setup();
    const grants = await harness.performAction<{ agents: Array<{ id: string; name: string }> }>("data.grants", {}, { actor: ADMIN, companyId: COMPANY });
    expect(grants.agents).toEqual([{ id: "agent-1", name: "Builder", status: "idle" }]);
    expect(calls.map((call) => call.method)).toEqual(expect.arrayContaining(["getSettings", "listAgentGrants"]));
    const setup = await harness.performAction<{ status: string }>("data.setup_company", {}, { actor: ADMIN, companyId: COMPANY });
    expect(setup.status).toBeDefined();
  });

  it("dispatches API requests and reports health", async () => {
    const { harness, plugin } = await setup();
    const response = await plugin.definition.onApiRequest?.({ routeKey: "tables.list", method: "GET", path: "/tables", params: {}, query: {}, body: undefined, actor: { actorType: "user", actorId: "admin-1", userId: "admin-1" }, companyId: COMPANY, headers: {} });
    expect(response?.status).toBe(200);
    expect(await plugin.definition.onHealth?.()).toMatchObject({ status: "ok" });
    expect(harness.logs.some((entry) => entry.message.includes("kyoube.apps"))).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @kyoube/plugin-apps test`
Expected: FAIL — `Cannot find module '../../src/plugin.js'`

- [ ] **Step 4: Implement roles.ts and plugin.ts, rewrite worker.ts**

`plugins/kyoube-apps/src/roles.ts` — copy Phase 1's `plugins/kyoube-terminal/src/auth.ts` verbatim but replace the `TerminalError` import/throw with `DataError` from `./data/errors.js` (`new DataError("forbidden", ...)`), and export the same `RoleResolver` class (`resolveRole`, `assertAllowed`, `invalidate`).

`plugins/kyoube-apps/src/plugin.ts`:
```ts
import { definePlugin, type PaperclipPlugin, type PluginContext } from "@paperclipai/plugin-sdk";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk/protocol";
import type { Pool } from "pg";
import { handleApiRequest } from "./api-routes.js";
import { DataError } from "./data/errors.js";
import { parseLevel, type DataActor } from "./data/permissions.js";
import { DataService, type DataServiceDeps } from "./data/service.js";
import { createPool as defaultCreatePool } from "./db/pool.js";
import { runMetaMigrations } from "./db/migrate.js";
import type { KyoubeRuntimeConfig } from "./kyoube-config.js";
import { DATA_SKILL_KEY, PLUGIN_ID, PURGE_JOB_KEY } from "./manifest.js";
import { RoleResolver } from "./roles.js";
import { registerTools } from "./tools.js";

export interface AppsPluginDeps {
  loadKyoubeConfig: () => Promise<KyoubeRuntimeConfig>;
  migrationsDir: string;
  createPool?: (url: string) => Pool;
  migrate?: (pool: Pool, dir: string) => Promise<unknown>;
  createService?: (deps: DataServiceDeps) => DataService;
}

type Params = Record<string, unknown>;

export function actorFromAction(context: PluginPerformActionContext): DataActor {
  const actor = context.actor;
  if (actor.type === "user" && actor.userId) return { kind: "user", id: actor.userId, runId: null };
  if (actor.type === "agent" && actor.agentId) return { kind: "agent", id: actor.agentId, runId: actor.runId ?? null };
  throw new DataError("forbidden", "data actions require a signed-in user or an agent run");
}

function str(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw new DataError("invalid", `${key} is required`);
  return value;
}

function companyOf(context: PluginPerformActionContext, params: Params): string {
  const companyId = context.companyId ?? (typeof params.companyId === "string" ? params.companyId : null);
  if (!companyId) throw new DataError("invalid", "companyId is required");
  return companyId;
}

export function createAppsPlugin(deps: AppsPluginDeps): PaperclipPlugin {
  let pool: Pool | null = null;

  return definePlugin({
    async setup(ctx: PluginContext) {
      const config = await deps.loadKyoubeConfig();
      pool = (deps.createPool ?? defaultCreatePool)(config.dataDatabaseUrl);
      await (deps.migrate ?? runMetaMigrations)(pool, deps.migrationsDir);
      const roles = new RoleResolver(ctx.access.members);
      const service = (deps.createService ?? ((serviceDeps) => new DataService(serviceDeps)))({
        pool,
        resolveUserRole: (companyId, userId) => roles.resolveRole(companyId, userId),
        onMutation: async (event) => {
          await ctx.activity.log({
            companyId: event.companyId,
            message: `Kyoube data: ${event.summary}`,
            entityType: "kyoube_table",
            entityId: event.table ?? undefined,
            metadata: { operation: event.operation, actorKind: event.actor.kind, actorId: event.actor.id, runId: event.actor.runId ?? null },
          });
        },
      });

      registerTools(ctx, service);

      // ---- UI reads (company scope is host-authorised; reads need only member access) ----
      const readActor = (params: Params): DataActor => ({ kind: "user", id: typeof params.userId === "string" ? params.userId : null, runId: null });
      ctx.data.register("data.tables", async (params) => service.listTables(str(params, "companyId"), readActor(params)));
      ctx.data.register("data.table", async (params) => service.describeTable(str(params, "companyId"), readActor(params), str(params, "table")));
      ctx.data.register("data.rows", async (params) => service.query(str(params, "companyId"), readActor(params), str(params, "table"), {
        where: params.where, orderBy: params.orderBy as never, limit: params.limit as number | undefined, offset: params.offset as number | undefined,
      }));
      ctx.data.register("data.count", async (params) => ({ count: await service.count(str(params, "companyId"), readActor(params), str(params, "table"), params.where) }));
      ctx.data.register("data.access", async (params) => service.myAccess(str(params, "companyId"), readActor(params)));

      // ---- UI actions (actor supplied by the host) ----
      const action = (key: string, fn: (companyId: string, actor: DataActor, params: Params) => Promise<unknown>) =>
        ctx.actions.register(key, async (params, context) => fn(companyOf(context, params), actorFromAction(context), params));

      action("data.create_table", (c, a, p) => service.createTable(c, a, { name: str(p, "name"), displayName: p.displayName as string | undefined, description: p.description as string | undefined, fields: Array.isArray(p.fields) ? p.fields : [] }));
      action("data.add_field", (c, a, p) => service.addField(c, a, str(p, "table"), p.field));
      action("data.update_field", (c, a, p) => service.updateField(c, a, str(p, "table"), str(p, "field"), { displayName: p.displayName as string | undefined, description: p.description as string | null | undefined, required: p.required as boolean | undefined, choices: p.choices as string[] | undefined }));
      action("data.remove_field", (c, a, p) => service.removeField(c, a, str(p, "table"), str(p, "field")));
      action("data.drop_table", (c, a, p) => service.dropTable(c, a, str(p, "table")));
      action("data.rename_table", (c, a, p) => service.renameTable(c, a, str(p, "table"), str(p, "newName")));
      action("data.insert", (c, a, p) => service.insert(c, a, str(p, "table"), Array.isArray(p.rows) ? p.rows : []));
      action("data.update", (c, a, p) => service.update(c, a, str(p, "table"), { ids: p.ids as string[] | undefined, where: p.where }, (p.patch ?? {}) as Record<string, unknown>));
      action("data.delete", (c, a, p) => service.delete(c, a, str(p, "table"), { ids: p.ids as string[] | undefined, where: p.where }));
      action("data.sql_select", (c, a, p) => service.sqlSelect(c, a, str(p, "sql"), Array.isArray(p.params) ? p.params : []));
      action("data.grants", async (c, a) => {
        const [settings, grants, agents] = await Promise.all([service.getSettings(c, a), service.listAgentGrants(c, a), ctx.agents.list({ companyId: c })]);
        return { settings, grants, agents: agents.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status })) };
      });
      action("data.set_agent_grant", (c, a, p) => service.setAgentGrant(c, a, str(p, "agentId"), parseLevel(p.level)));
      action("data.set_settings", (c, a, p) => service.setSettings(c, a, { defaultAgentLevel: p.defaultAgentLevel === undefined ? undefined : parseLevel(p.defaultAgentLevel), hardDelete: p.hardDelete as boolean | undefined }));
      action("data.setup_company", async (c, a) => {
        await service.getSettings(c, a); // admin gate
        await service.scope(c);
        return ctx.skills.managed.reconcile(DATA_SKILL_KEY, c);
      });

      // ---- maintenance ----
      ctx.jobs.register(PURGE_JOB_KEY, async () => {
        const companies = await pool!.query<{ company_id: string }>("SELECT company_id FROM kyoube_meta.companies");
        for (const row of companies.rows) {
          const result = await service.purgeTrash(row.company_id);
          if (result.droppedTables.length + result.droppedColumns.length > 0) ctx.logger.info("purged trash", { companyId: row.company_id, ...result });
        }
      });

      ctx.logger.info(`${PLUGIN_ID} worker ready`);
    },

    async onApiRequest(input) {
      const service = currentService;
      if (!service) return { status: 503, body: { error: "data service not ready" } };
      return handleApiRequest(service, input);
    },

    async onHealth() {
      try {
        await pool?.query("SELECT 1");
        return { status: "ok", message: `${PLUGIN_ID} ready` };
      } catch (error) {
        return { status: "error", message: error instanceof Error ? error.message : String(error) };
      }
    },

    async onShutdown() {
      await pool?.end();
    },
  });
}

// `onApiRequest` runs outside `setup`; the service is captured here once setup completes.
let currentService: DataService | null = null;
export function __setCurrentService(service: DataService | null): void {
  currentService = service;
}
```
Inside `setup`, right after the service is created, add `__setCurrentService(service);` (and `__setCurrentService(null)` in `onShutdown`).

`plugins/kyoube-apps/src/worker.ts`:
```ts
import { runWorker } from "@paperclipai/plugin-sdk";
import { migrationsDirFrom } from "./db/migrate.js";
import { readKyoubeConfig } from "./kyoube-config.js";
import { createAppsPlugin } from "./plugin.js";

const plugin = createAppsPlugin({
  loadKyoubeConfig: () => readKyoubeConfig(),
  migrationsDir: migrationsDirFrom(import.meta.url),
});

export default plugin;
runWorker(plugin, import.meta.url);
```

- [ ] **Step 5: Run tests, typecheck, build, then commit**

Run: `pnpm --filter @kyoube/plugin-apps test && pnpm --filter @kyoube/plugin-apps typecheck && pnpm --filter @kyoube/plugin-apps build`
Expected: PASS; if the harness's `ctx.agents.list` requires seeded `Agent` objects with more fields, extend the seed in the test with `role: "general"` and `adapterType: "claude_local"`.

```bash
git add plugins/kyoube-apps
git commit -m "feat(apps): worker wiring for tools, UI bridge, API routes, purge job"
```

---

### Task 12: UI — Data page, sidebar entry, data-access settings

**Files:**
- Create: `plugins/kyoube-apps/src/ui/index.tsx`, `SidebarEntry.tsx`, `DataPage.tsx`, `DataAccessSettingsPage.tsx`, `forms.tsx`, `format.ts`
- Test: `plugins/kyoube-apps/tests/unit/format.spec.ts`, `plugins/kyoube-apps/tests/unit/ui.spec.tsx`

**Interfaces:**
- Consumes: bridge keys from Task 11; SDK UI hooks (`useHostContext`, `useHostNavigation`, `usePluginData`, `usePluginAction`, `usePluginToast`), props `PluginPageProps`, `PluginSidebarProps`, `PluginCompanySettingsPageProps`.
- Produces: exports `SidebarEntry`, `DataPage`, `DataAccessSettingsPage`; pure helpers `formatCell(kind, value): string`, `emptyRow(fields): Record<string, unknown>`, `parseCellInput(kind, text): unknown`.

- [ ] **Step 1: Write the failing tests**

`plugins/kyoube-apps/tests/unit/format.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { emptyRow, formatCell, parseCellInput } from "../../src/ui/format.js";

describe("format helpers", () => {
  it("formats cells for the grid", () => {
    expect(formatCell("text", null)).toBe("");
    expect(formatCell("boolean", true)).toBe("Yes");
    expect(formatCell("datetime", "2026-09-05T10:00:00.000Z")).toMatch(/2026/);
    expect(formatCell("multi_select", ["a", "b"])).toBe("a, b");
    expect(formatCell("json", { a: 1 })).toBe('{"a":1}');
    expect(formatCell("relation", "2f1d8e2a-1f0a-4c7b-9a2d-3b4c5d6e7f80")).toBe("2f1d8e2a…");
  });
  it("parses form input by kind", () => {
    expect(parseCellInput("integer", "42")).toBe(42);
    expect(parseCellInput("decimal", "")).toBeNull();
    expect(parseCellInput("boolean", "true")).toBe(true);
    expect(parseCellInput("multi_select", "a, b")).toEqual(["a", "b"]);
    expect(parseCellInput("json", '{"x":1}')).toEqual({ x: 1 });
    expect(() => parseCellInput("json", "{")).toThrow("JSON");
    expect(parseCellInput("text", " hi ")).toBe("hi");
  });
  it("builds an empty row from fields", () => {
    expect(emptyRow([{ name: "a", kind: "text", required: false, displayName: "A", description: null, options: {}, position: 0 }, { name: "b", kind: "boolean", required: false, displayName: "B", description: null, options: {}, position: 1 }])).toEqual({ a: "", b: false });
  });
});
```

`plugins/kyoube-apps/tests/unit/ui.spec.tsx`:
```tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarEntry } from "../../src/ui/SidebarEntry.js";
import { DataAccessSettingsPage } from "../../src/ui/DataAccessSettingsPage.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi?: Record<string, unknown> } };
const context = { companyId: "c1", companyPrefix: "acme", projectId: null, entityId: null, entityType: null, userId: "u1" };

function installBridge(overrides: Record<string, unknown> = {}) {
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = {
    sdkUi: {
      useHostContext: () => context,
      useHostNavigation: () => ({ resolveHref: (to: string) => `/acme${to}`, navigate: () => {}, linkProps: (to: string) => ({ href: `/acme${to}`, onClick: () => {} }) }),
      usePluginData: () => ({ data: { level: "read", actorKind: "user", hint: "" }, loading: false, error: null, refresh: () => {} }),
      usePluginAction: () => async () => ({ settings: { defaultAgentLevel: "none", hardDelete: false }, grants: [], agents: [] }),
      usePluginToast: () => () => null,
      ...overrides,
    },
  };
}
afterEach(() => { delete (globalThis as BridgeGlobal).__paperclipPluginBridge__; });

describe("UI", () => {
  it("SidebarEntry links to the data page for members with read access", () => {
    installBridge();
    expect(renderToStaticMarkup(createElement(SidebarEntry, { context }))).toContain('href="/acme/data"');
    installBridge({ usePluginData: () => ({ data: { level: "none" }, loading: false, error: null, refresh: () => {} }) });
    expect(renderToStaticMarkup(createElement(SidebarEntry, { context }))).toBe("");
  });
  it("DataAccessSettingsPage renders its headings", () => {
    installBridge();
    const html = renderToStaticMarkup(createElement(DataAccessSettingsPage, { context }));
    expect(html).toContain("Data access");
    expect(html).toContain("Default level for agents");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kyoube/plugin-apps test`
Expected: FAIL — modules under `../../src/ui/` not found

- [ ] **Step 3: Implement format.ts, forms.tsx, SidebarEntry.tsx**

`plugins/kyoube-apps/src/ui/format.ts`:
```ts
export type UiFieldKind = "text" | "long_text" | "integer" | "decimal" | "boolean" | "date" | "datetime" | "json" | "select" | "multi_select" | "relation" | "email" | "url";
export interface UiField { name: string; displayName: string; description: string | null; kind: UiFieldKind; required: boolean; options: { choices?: string[]; relationTable?: string }; position: number }
export interface UiTable { name: string; displayName: string; description: string | null; fields: UiField[]; createdAt: string; updatedAt: string }

export function formatCell(kind: UiFieldKind | "system", value: unknown): string {
  if (value === null || value === undefined) return "";
  switch (kind) {
    case "boolean": return value ? "Yes" : "No";
    case "datetime": return new Date(String(value)).toLocaleString();
    case "multi_select": return Array.isArray(value) ? value.join(", ") : String(value);
    case "json": return JSON.stringify(value);
    case "relation": return `${String(value).slice(0, 8)}…`;
    default: return String(value);
  }
}

export function parseCellInput(kind: UiFieldKind, text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "" && kind !== "boolean") return null;
  switch (kind) {
    case "integer": case "decimal": return Number(trimmed);
    case "boolean": return trimmed === "true";
    case "multi_select": return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
    case "json":
      try { return JSON.parse(trimmed); } catch { throw new Error("Invalid JSON"); }
    default: return trimmed;
  }
}

export function emptyRow(fields: UiField[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const field of fields) row[field.name] = field.kind === "boolean" ? false : "";
  return row;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

`plugins/kyoube-apps/src/ui/forms.tsx`:
```tsx
import { useState } from "react";
import { parseCellInput, type UiField, type UiFieldKind } from "./format.js";

const KINDS: UiFieldKind[] = ["text", "long_text", "integer", "decimal", "boolean", "date", "datetime", "json", "select", "multi_select", "relation", "email", "url"];
export const input = "rounded border px-2 py-1 text-sm bg-background";
export const button = "rounded border px-2 py-1 text-sm hover:bg-accent";

/** One input per field kind; values are kept as strings until submit. */
export function CellInput(props: { field: UiField; value: string; onChange: (value: string) => void }) {
  const { field, value, onChange } = props;
  if (field.kind === "boolean") return <input type="checkbox" checked={value === "true"} onChange={(event) => onChange(event.target.checked ? "true" : "false")} />;
  if (field.kind === "select") return (
    <select className={input} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">—</option>
      {(field.options.choices ?? []).map((choice) => <option key={choice} value={choice}>{choice}</option>)}
    </select>
  );
  if (field.kind === "long_text" || field.kind === "json") return <textarea className={input} rows={3} value={value} onChange={(event) => onChange(event.target.value)} />;
  const type = field.kind === "date" ? "date" : field.kind === "datetime" ? "datetime-local" : field.kind === "integer" || field.kind === "decimal" ? "number" : "text";
  return <input className={input} type={type} value={value} placeholder={field.kind === "multi_select" ? "a, b" : field.kind === "relation" ? "row id" : ""} onChange={(event) => onChange(event.target.value)} />;
}

export function RowForm(props: { fields: UiField[]; initial: Record<string, unknown>; submitLabel: string; onSubmit: (row: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(props.fields.map((field) => [field.name, props.initial[field.name] === null || props.initial[field.name] === undefined ? "" : Array.isArray(props.initial[field.name]) ? (props.initial[field.name] as string[]).join(", ") : field.kind === "json" ? JSON.stringify(props.initial[field.name]) : String(props.initial[field.name])])));
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="flex flex-col gap-2 rounded border p-3" onSubmit={(event) => {
      event.preventDefault();
      try {
        const row: Record<string, unknown> = {};
        for (const field of props.fields) row[field.name] = parseCellInput(field.kind, values[field.name] ?? "");
        props.onSubmit(row).catch((err) => setError(String(err instanceof Error ? err.message : err)));
      } catch (err) { setError(String(err instanceof Error ? err.message : err)); }
    }}>
      {props.fields.map((field) => (
        <label key={field.name} className="flex items-center gap-2 text-sm">
          <span className="w-40 shrink-0">{field.displayName}{field.required ? " *" : ""}</span>
          <CellInput field={field} value={values[field.name] ?? ""} onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))} />
        </label>
      ))}
      {error && <div className="text-sm text-red-600">{error}</div>}
      <div className="flex gap-2"><button type="submit" className={button}>{props.submitLabel}</button><button type="button" className={button} onClick={props.onCancel}>Cancel</button></div>
    </form>
  );
}

export interface FieldDraft { name: string; kind: UiFieldKind; required: boolean; choices: string; relationTable: string }
export const emptyFieldDraft = (): FieldDraft => ({ name: "", kind: "text", required: false, choices: "", relationTable: "" });

export function fieldDraftToSpec(draft: FieldDraft) {
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    required: draft.required,
    options: {
      ...(draft.kind === "select" || draft.kind === "multi_select" ? { choices: draft.choices.split(",").map((item) => item.trim()).filter(Boolean) } : {}),
      ...(draft.kind === "relation" ? { relationTable: draft.relationTable.trim() } : {}),
    },
  };
}

export function FieldEditor(props: { draft: FieldDraft; tables: string[]; onChange: (draft: FieldDraft) => void }) {
  const { draft, onChange } = props;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <input className={input} placeholder="field_name" value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
      <select className={input} value={draft.kind} onChange={(event) => onChange({ ...draft, kind: event.target.value as UiFieldKind })}>
        {KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
      </select>
      <label className="flex items-center gap-1"><input type="checkbox" checked={draft.required} onChange={(event) => onChange({ ...draft, required: event.target.checked })} /> required</label>
      {(draft.kind === "select" || draft.kind === "multi_select") && <input className={input} placeholder="choice1, choice2" value={draft.choices} onChange={(event) => onChange({ ...draft, choices: event.target.value })} />}
      {draft.kind === "relation" && (
        <select className={input} value={draft.relationTable} onChange={(event) => onChange({ ...draft, relationTable: event.target.value })}>
          <option value="">target table…</option>
          {props.tables.map((table) => <option key={table} value={table}>{table}</option>)}
        </select>
      )}
    </div>
  );
}
```

`plugins/kyoube-apps/src/ui/SidebarEntry.tsx`:
```tsx
import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { useHostContext, useHostNavigation, usePluginData } from "@paperclipai/plugin-sdk/ui";

export function SidebarEntry(_props: PluginSidebarProps) {
  const host = useHostContext();
  const navigation = useHostNavigation();
  const access = usePluginData<{ level: string }>("data.access", { companyId: host.companyId, userId: host.userId });
  if (access.loading || !access.data || access.data.level === "none") return null;
  return (
    <a {...navigation.linkProps("/data")} className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground">
      <span aria-hidden="true">▦</span>
      <span>Data</span>
    </a>
  );
}
```

- [ ] **Step 4: Implement DataPage.tsx**

`plugins/kyoube-apps/src/ui/DataPage.tsx`:
```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { useHostContext, usePluginAction, usePluginData, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { errorText, formatCell, emptyRow, type UiField, type UiTable } from "./format.js";
import { button, emptyFieldDraft, FieldEditor, fieldDraftToSpec, input, RowForm, type FieldDraft } from "./forms.js";

const PAGE_SIZE = 50;
type Row = Record<string, unknown>;

export function DataPage({ context }: PluginPageProps) {
  const host = useHostContext();
  const companyId = context.companyId ?? host.companyId ?? "";
  const toast = usePluginToast();
  const access = usePluginData<{ level: string; hint: string }>("data.access", { companyId, userId: host.userId });
  const tables = usePluginData<UiTable[]>("data.tables", { companyId, userId: host.userId });
  const [selected, setSelected] = useState<string | null>(null);
  const table = useMemo(() => tables.data?.find((item) => item.name === selected) ?? null, [tables.data, selected]);
  const canWrite = access.data?.level === "write" || access.data?.level === "schema";
  const canSchema = access.data?.level === "schema";

  useEffect(() => { if (!selected && tables.data?.[0]) setSelected(tables.data[0].name); }, [tables.data, selected]);

  const notify = useCallback((title: string, tone: "success" | "error" = "success") => { toast({ title, tone }); }, [toast]);

  if (!companyId) return <div className="p-4 text-sm">Select a company.</div>;
  if (access.data && access.data.level === "none") return <div className="p-4 text-sm">You do not have access to this company's data. {access.data.hint}</div>;

  return (
    <div className="flex h-full gap-4 p-4">
      <aside className="w-56 shrink-0">
        <div className="mb-2 flex items-center justify-between"><strong>Tables</strong>{canSchema && <CreateTableButton companyId={companyId} onCreated={(name) => { tables.refresh(); setSelected(name); notify(`Created ${name}`); }} />}</div>
        <ul className="space-y-1 text-sm">
          {(tables.data ?? []).map((item) => (
            <li key={item.name}><button type="button" className={`w-full rounded px-2 py-1 text-left ${item.name === selected ? "bg-accent" : "hover:bg-accent/50"}`} onClick={() => setSelected(item.name)}>{item.displayName} <span className="text-foreground/50">({item.name})</span></button></li>
          ))}
          {tables.data && tables.data.length === 0 && <li className="text-foreground/60">No tables yet.{canSchema ? " Create one, or ask an agent to." : ""}</li>}
        </ul>
      </aside>
      <main className="min-w-0 flex-1">
        {table ? <TableView key={table.name} companyId={companyId} userId={host.userId} table={table} allTables={(tables.data ?? []).map((item) => item.name)} canWrite={canWrite} canSchema={canSchema} onSchemaChange={() => tables.refresh()} onDropped={() => { setSelected(null); tables.refresh(); }} notify={notify} /> : <div className="text-sm text-foreground/60">Select a table.</div>}
      </main>
    </div>
  );
}

function CreateTableButton(props: { companyId: string; onCreated: (name: string) => void }) {
  const createTable = usePluginAction("data.create_table");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [fields, setFields] = useState<FieldDraft[]>([emptyFieldDraft()]);
  const [error, setError] = useState<string | null>(null);
  if (!open) return <button type="button" className={button} onClick={() => setOpen(true)}>+ Table</button>;
  return (
    <form className="flex flex-col gap-2 rounded border p-2 text-sm" onSubmit={(event) => {
      event.preventDefault();
      createTable({ name: name.trim(), fields: fields.filter((field) => field.name.trim()).map(fieldDraftToSpec) })
        .then(() => { props.onCreated(name.trim()); setOpen(false); setName(""); setFields([emptyFieldDraft()]); })
        .catch((err) => setError(errorText(err)));
    }}>
      <input className={input} placeholder="table_name" value={name} onChange={(event) => setName(event.target.value)} />
      {fields.map((field, index) => <FieldEditor key={index} draft={field} tables={[]} onChange={(draft) => setFields((current) => current.map((item, i) => (i === index ? draft : item)))} />)}
      <button type="button" className={button} onClick={() => setFields((current) => [...current, emptyFieldDraft()])}>+ field</button>
      {error && <div className="text-red-600">{error}</div>}
      <div className="flex gap-2"><button type="submit" className={button}>Create</button><button type="button" className={button} onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

function TableView(props: { companyId: string; userId: string | null; table: UiTable; allTables: string[]; canWrite: boolean; canSchema: boolean; onSchemaChange: () => void; onDropped: () => void; notify: (title: string, tone?: "success" | "error") => void }) {
  const { companyId, table } = props;
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Row | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [fieldDraft, setFieldDraft] = useState<FieldDraft | null>(null);
  const textFields = table.fields.filter((field) => ["text", "long_text", "email", "url", "select"].includes(field.kind));
  const where = search.trim() && textFields.length > 0 ? { or: textFields.map((field) => ({ field: field.name, op: "contains", value: search.trim() })) } : undefined;
  const rows = usePluginData<{ rows: Row[] }>("data.rows", { companyId, userId: props.userId, table: table.name, where, limit: PAGE_SIZE, offset: page * PAGE_SIZE, orderBy: [{ field: "created_at", direction: "desc" }] });
  const count = usePluginData<{ count: number }>("data.count", { companyId, userId: props.userId, table: table.name, where });
  const insert = usePluginAction("data.insert");
  const update = usePluginAction("data.update");
  const remove = usePluginAction("data.delete");
  const addField = usePluginAction("data.add_field");
  const removeField = usePluginAction("data.remove_field");
  const dropTable = usePluginAction("data.drop_table");
  const refresh = () => { rows.refresh(); count.refresh(); };
  const run = (promise: Promise<unknown>, success: string) => promise.then(() => { props.notify(success); refresh(); }).catch((err) => props.notify(errorText(err), "error"));
  const total = count.data?.count ?? 0;
  const columns: Array<{ name: string; kind: UiField["kind"] | "system" }> = [...table.fields.map((field) => ({ name: field.name, kind: field.kind })), { name: "created_at", kind: "system" as const }];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{table.displayName}</h2>
        <span className="text-xs text-foreground/60">{total} rows</span>
        <input className={input} placeholder="Search…" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} />
        <span className="flex-1" />
        {props.canWrite && <button type="button" className={button} onClick={() => setAdding(true)}>+ Row</button>}
        {props.canSchema && <button type="button" className={button} onClick={() => setFieldDraft(emptyFieldDraft())}>+ Field</button>}
        {props.canSchema && (confirmDrop
          ? <span className="flex items-center gap-1 text-sm">Drop {table.name}? <button type="button" className={button} onClick={() => { dropTable({ table: table.name }).then(() => { props.notify(`Dropped ${table.name} (recoverable for 30 days)`); props.onDropped(); }).catch((err) => props.notify(errorText(err), "error")); }}>Yes</button><button type="button" className={button} onClick={() => setConfirmDrop(false)}>No</button></span>
          : <button type="button" className={button} onClick={() => setConfirmDrop(true)}>Drop table</button>)}
      </div>
      {fieldDraft && (
        <div className="flex flex-col gap-2 rounded border p-2">
          <FieldEditor draft={fieldDraft} tables={props.allTables} onChange={setFieldDraft} />
          <div className="flex gap-2"><button type="button" className={button} onClick={() => run(addField({ table: table.name, field: fieldDraftToSpec(fieldDraft) }).then(() => { setFieldDraft(null); props.onSchemaChange(); }), "Field added")}>Add</button><button type="button" className={button} onClick={() => setFieldDraft(null)}>Cancel</button></div>
        </div>
      )}
      {adding && <RowForm fields={table.fields} initial={emptyRow(table.fields)} submitLabel="Insert" onCancel={() => setAdding(false)} onSubmit={async (row) => { await insert({ table: table.name, rows: [row] }); setAdding(false); props.notify("Row inserted"); refresh(); }} />}
      {editing && <RowForm fields={table.fields} initial={editing} submitLabel="Save" onCancel={() => setEditing(null)} onSubmit={async (row) => { await update({ table: table.name, ids: [String(editing.id)], patch: row }); setEditing(null); props.notify("Row updated"); refresh(); }} />}
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead><tr className="bg-accent/40 text-left">{columns.map((column) => <th key={column.name} className="px-2 py-1 font-medium">{column.name}{props.canSchema && column.kind !== "system" && <button type="button" className="ml-1 text-foreground/40 hover:text-red-600" title="Remove field" onClick={() => run(removeField({ table: table.name, field: column.name }).then(props.onSchemaChange), `Removed ${column.name}`)}>×</button>}</th>)}{props.canWrite && <th />}</tr></thead>
          <tbody>
            {(rows.data?.rows ?? []).map((row) => (
              <tr key={String(row.id)} className="border-t">
                {columns.map((column) => <td key={column.name} className="max-w-xs truncate px-2 py-1" title={formatCell(column.kind, row[column.name])}>{formatCell(column.kind, row[column.name])}</td>)}
                {props.canWrite && <td className="whitespace-nowrap px-2 py-1"><button type="button" className="underline" onClick={() => setEditing(row)}>edit</button> <button type="button" className="underline" onClick={() => run(remove({ table: table.name, ids: [String(row.id)] }), "Row deleted")}>delete</button></td>}
              </tr>
            ))}
            {rows.data && rows.data.rows.length === 0 && <tr><td className="px-2 py-3 text-foreground/60" colSpan={columns.length + 1}>No rows.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <button type="button" className={button} disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Prev</button>
        <span>page {page + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span>
        <button type="button" className={button} disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage((value) => value + 1)}>Next</button>
        {rows.error && <span className="text-red-600">{rows.error.message}</span>}
      </div>
      {table.description && <p className="text-xs text-foreground/60">{table.description}</p>}
    </div>
  );
}
```

- [ ] **Step 5: Implement DataAccessSettingsPage.tsx and index.tsx**

`plugins/kyoube-apps/src/ui/DataAccessSettingsPage.tsx`:
```tsx
import { useEffect, useState } from "react";
import type { PluginCompanySettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginAction, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { errorText } from "./format.js";
import { button, input } from "./forms.js";

const LEVELS = ["none", "read", "write", "schema"] as const;
interface GrantsData { settings: { defaultAgentLevel: string; hardDelete: boolean }; grants: Array<{ agentId: string; level: string; updatedAt: string }>; agents: Array<{ id: string; name: string; status: string }> }

export function DataAccessSettingsPage({ context }: PluginCompanySettingsPageProps) {
  const companyId = context.companyId ?? "";
  const toast = usePluginToast();
  const loadGrants = usePluginAction("data.grants");
  const setGrant = usePluginAction("data.set_agent_grant");
  const setSettings = usePluginAction("data.set_settings");
  const setupCompany = usePluginAction("data.setup_company");
  const [data, setData] = useState<GrantsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => loadGrants({}).then((result) => setData(result as GrantsData)).catch((err) => setError(errorText(err)));
  useEffect(() => { if (companyId) reload().catch(() => {}); }, [companyId]);
  const act = (promise: Promise<unknown>, title: string) => promise.then(() => { toast({ title, tone: "success" }); return reload(); }).catch((err) => toast({ title: errorText(err), tone: "error" }));

  const levelOf = (agentId: string) => data?.grants.find((grant) => grant.agentId === agentId)?.level ?? `default (${data?.settings.defaultAgentLevel ?? "none"})`;

  return (
    <div className="flex flex-col gap-4 p-4 text-sm">
      <h1 className="text-base font-semibold">Data access</h1>
      <p className="text-foreground/70">Levels: <code>none</code> &lt; <code>read</code> &lt; <code>write</code> &lt; <code>schema</code>. People get their level from their company role (viewer → read, member/operator → write, owner/admin → schema). Agents get an explicit level or the company default.</p>
      {error && <div className="text-red-600">{error}</div>}
      {data && (
        <>
          <section className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2">Default level for agents
              <select className={input} value={data.settings.defaultAgentLevel} onChange={(event) => act(setSettings({ defaultAgentLevel: event.target.value }), "Default updated")}>
                {LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={data.settings.hardDelete} onChange={(event) => act(setSettings({ hardDelete: event.target.checked }), "Delete mode updated")} /> Hard-delete dropped tables and fields immediately (default: keep 30 days)</label>
            <button type="button" className={button} onClick={() => act(setupCompany({}), "Kyoube Data skill installed for this company")}>Install the Kyoube Data skill</button>
          </section>
          <table className="w-full max-w-3xl text-sm">
            <thead><tr className="bg-accent/40 text-left"><th className="px-2 py-1">Agent</th><th className="px-2 py-1">Status</th><th className="px-2 py-1">Data level</th></tr></thead>
            <tbody>
              {data.agents.map((agent) => (
                <tr key={agent.id} className="border-t">
                  <td className="px-2 py-1">{agent.name}</td>
                  <td className="px-2 py-1 text-foreground/60">{agent.status}</td>
                  <td className="px-2 py-1">
                    <select className={input} value={data.grants.find((grant) => grant.agentId === agent.id)?.level ?? ""} onChange={(event) => act(setGrant({ agentId: agent.id, level: event.target.value || data.settings.defaultAgentLevel }), `${agent.name} → ${event.target.value || "default"}`)}>
                      <option value="">{levelOf(agent.id)}</option>
                      {LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
              {data.agents.length === 0 && <tr><td className="px-2 py-2 text-foreground/60" colSpan={3}>No agents in this company yet.</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
```

`plugins/kyoube-apps/src/ui/index.tsx`:
```tsx
export { SidebarEntry } from "./SidebarEntry.js";
export { DataPage } from "./DataPage.js";
export { DataAccessSettingsPage } from "./DataAccessSettingsPage.js";
```

- [ ] **Step 6: Run tests, typecheck, build, then commit**

Run: `pnpm --filter @kyoube/plugin-apps test && pnpm --filter @kyoube/plugin-apps typecheck && pnpm --filter @kyoube/plugin-apps build`
Expected: PASS; `dist/ui/index.js` exports the three components. (The settings page test renders with `useEffect` inert under `renderToStaticMarkup`, so only the headings are asserted.)

```bash
git add plugins/kyoube-apps
git commit -m "feat(apps): Data page, sidebar entry, and data-access settings UI"
```

---

### Task 13: Container integration, smoke test, docs

**Files:**
- Modify: `scripts/smoke.sh`, `README.md`

**Interfaces:**
- Consumes: scoped API routes at `/api/plugins/kyoube.apps/api/*` (Task 10) with the board API key; the bootstrap from Phase 0 installs `/opt/kyoube/plugins/apps` because the Dockerfile now deploys it (Task 1).

- [ ] **Step 1: Extend the smoke test**

Append to `scripts/smoke.sh` before the `==> kyoube doctor` block:
```bash
echo "==> data: plugin ready, create a table, insert, query, sql"
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins" \
  | jq -e 'map(select(.pluginKey == "kyoube.apps")) | length == 1 and .[0].status == "ready"' >/dev/null
API="$BASE_URL/api/plugins/kyoube.apps/api"
api_post() { curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$API$1" --data "$2"; }
api_get() { curl -fsS -H "Authorization: Bearer $TOKEN" "$API$1?companyId=$COMPANY_ID"; }
api_get "/access/me" | jq -e '.level == "schema"' >/dev/null
api_post "/tables" "{\"companyId\":\"$COMPANY_ID\",\"name\":\"smoke_contacts\",\"fields\":[{\"name\":\"name\",\"kind\":\"text\",\"required\":true},{\"name\":\"stage\",\"kind\":\"select\",\"options\":{\"choices\":[\"lead\",\"customer\"]}}]}" | jq -e '.name == "smoke_contacts"' >/dev/null
api_post "/tables/smoke_contacts/rows" "{\"companyId\":\"$COMPANY_ID\",\"rows\":[{\"name\":\"Ada\",\"stage\":\"lead\"},{\"name\":\"Grace\",\"stage\":\"customer\"}]}" | jq -e 'length == 2' >/dev/null
api_post "/tables/smoke_contacts/rows/query" "{\"companyId\":\"$COMPANY_ID\",\"where\":{\"field\":\"stage\",\"op\":\"eq\",\"value\":\"customer\"}}" | jq -e '.rows | length == 1 and .[0].name == "Grace"' >/dev/null
api_post "/sql" "{\"companyId\":\"$COMPANY_ID\",\"sql\":\"select count(*)::int as n from smoke_contacts\"}" | jq -e '.rows[0].n == 2' >/dev/null
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$API/sql" --data "{\"companyId\":\"$COMPANY_ID\",\"sql\":\"delete from smoke_contacts\"}")"
[[ "$STATUS" == "400" ]] || { echo "expected 400 for a non-SELECT, got $STATUS" >&2; exit 1; }
api_get "/tables" | jq -e 'map(.name) | index("smoke_contacts") != null' >/dev/null
echo "    data round-trip ok"
```

- [ ] **Step 2: Run the smoke test**

Run: `bash scripts/smoke.sh`
Expected: `data round-trip ok` and `smoke passed`. If `kyoube.apps` is not `ready`, read `docker compose -p kyoube-smoke logs app | grep -i kyoube.apps` — the usual causes are the migrations directory not found in the deployed bundle (check `/opt/kyoube/plugins/apps/migrations` exists; it is listed in `package.json.files`) or `KYOUBE_DATABASE_URL` not reaching the config file.

- [ ] **Step 3: Manual acceptance**

1. As the admin, open **Data** in the sidebar: create a table with a `select` field and a `relation`, insert rows, edit and delete one, add and remove a field, drop the table.
2. Open **Company Settings → Data access**: set an agent to `schema`, click **Install the Kyoube Data skill**, confirm the skill appears under the company's skills.
3. Assign the agent a task: "Create a contacts and deals database for us and add three sample deals." Verify it uses the `kyoube.apps:data_*` tools (visible in the run transcript), the tables appear on the Data page, and the activity log shows `Kyoube data:` entries without row contents.
4. Set the agent back to `none` and give it a similar task: it must report the access hint instead of retrying.
5. Sign in as a `viewer`: the Data page is read-only (no `+ Row`, `edit`, or schema buttons).

- [ ] **Step 4: Document and commit**

Add to `README.md` under a new `## Data` heading:
```markdown
## Data

Every company gets its own isolated PostgreSQL schema in the `kyoube` database (separate from Paperclip's own database). People use it from the **Data** page; agents use the `kyoube.apps:data_*` tools (served through Paperclip's MCP gateway) or the REST routes under `/api/plugins/kyoube.apps/api/`, guided by the managed **Kyoube Data** skill.

Access levels are `none < read < write < schema`. People inherit theirs from their company role; agents get an explicit level or the company default (`none`) under **Company Settings → Data access**. Dropped tables and fields are kept for 30 days unless hard deletes are enabled. Every mutation is audited in `kyoube_meta.audit` and summarised in Paperclip's activity log.

Tip: pair this with Paperclip's tool policies (Tools & Access) to require human approval for `kyoube.apps:data_drop_table` and `kyoube.apps:data_remove_field`.
```

```bash
git add scripts/smoke.sh README.md
git commit -m "feat(apps): data smoke test and documentation"
```

---

## Phase 2 exit checklist

- [ ] Unit and integration suites pass locally and in CI (`pnpm test`, `pnpm --filter @kyoube/plugin-apps test:integration`).
- [ ] `bash scripts/smoke.sh` passes including the data round-trip.
- [ ] Manual acceptance (Task 13 Step 3) completed for admin, agent (with and without grants), and viewer.
- [ ] Cross-company isolation is proven by `company-scope.spec.ts` (permission denied across schemas).
- [ ] The Paperclip activity log never contains row contents; `kyoube_meta.audit` contains every mutation.
