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
