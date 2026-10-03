import pg from "pg";
import type { SnapshotUser } from "@kyoube/license";

/**
 * The core database, for the two things licensing needs that no API gives:
 * every user (the admin API stops at 50) and deleting one (the core has no
 * route for it). Only `kyoube` uses this, never a plugin.
 */
export interface CoreUsersDb {
  listUsers(): Promise<SnapshotUser[]>;
  deleteUser(id: string): Promise<boolean>;
  close(): Promise<void>;
}

export const LIST_USERS_SQL =
  'SELECT u.id, u.email, u.name, u.created_at, EXISTS (SELECT 1 FROM instance_user_roles r WHERE r.user_id = u.id AND r.role = \'instance_admin\') AS is_instance_admin FROM "user" u ORDER BY u.created_at, u.id';

export function coreDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set: run this inside the app container (docker compose exec app kyoube ...)");
  return url;
}

export function openCoreUsersDb(url: string): CoreUsersDb {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  // An idle connection dropped by a database restart must not crash the long-lived `--watch` process.
  pool.on("error", () => {});
  return {
    async listUsers() {
      const { rows } = await pool.query<{ id: string; email: string; name: string; created_at: Date | string; is_instance_admin: boolean }>(LIST_USERS_SQL);
      return rows.map((row) => ({ id: row.id, email: row.email, name: row.name, createdAt: new Date(row.created_at).toISOString(), isInstanceAdmin: row.is_instance_admin }));
    },
    async deleteUser(id) {
      const result = await pool.query('DELETE FROM "user" WHERE id = $1', [id]);
      return (result.rowCount ?? 0) > 0;
    },
    close: () => pool.end(),
  };
}
