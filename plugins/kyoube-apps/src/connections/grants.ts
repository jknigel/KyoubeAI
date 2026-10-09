import type { Pool, PoolClient } from "pg";
import { DataError } from "../data/errors.js";

/** A pool for a read, or a transaction's own client when the write commits with its audit row. */
type MetaDb = Pool | PoolClient;

export type ConnectionAccess = "none" | "read" | "read-write";

export interface ConnectionGrant {
  agentId: string;
  connection: string;
  access: Exclude<ConnectionAccess, "none">;
  updatedBy: string | null;
  updatedAt: string;
}

const ACCESS_VALUES: readonly ConnectionAccess[] = ["none", "read", "read-write"];

function parseGranted(value: unknown): Exclude<ConnectionAccess, "none"> | null {
  return value === "read" || value === "read-write" ? value : null;
}

/** No row, or a stored value this code does not know, is no access. */
export async function getConnectionGrant(db: Pool, companyId: string, agentId: string, connection: string): Promise<ConnectionAccess> {
  const result = await db.query<{ access: string }>(
    "SELECT access FROM kyoube_meta.connection_grants WHERE company_id = $1 AND agent_id = $2 AND connection_name = $3",
    [companyId, agentId, connection],
  );
  return parseGranted(result.rows[0]?.access) ?? "none";
}

export async function listConnectionGrants(db: Pool, companyId: string): Promise<ConnectionGrant[]> {
  const result = await db.query<{ agent_id: string; connection_name: string; access: string; updated_by: string | null; updated_at: Date }>(
    `SELECT agent_id, connection_name, access, updated_by, updated_at FROM kyoube_meta.connection_grants
     WHERE company_id = $1 ORDER BY agent_id COLLATE "C", connection_name COLLATE "C"`,
    [companyId],
  );
  const grants: ConnectionGrant[] = [];
  for (const row of result.rows) {
    const access = parseGranted(row.access);
    if (access) grants.push({ agentId: row.agent_id, connection: row.connection_name, access, updatedBy: row.updated_by, updatedAt: row.updated_at.toISOString() });
  }
  return grants;
}

/** "none" deletes the row. */
export async function setConnectionGrant(db: MetaDb, companyId: string, agentId: string, connection: string, access: ConnectionAccess, updatedBy: string | null): Promise<void> {
  if (!ACCESS_VALUES.includes(access)) throw new DataError("invalid", `connection access must be one of ${ACCESS_VALUES.join(", ")}`);
  if (access === "none") {
    await db.query("DELETE FROM kyoube_meta.connection_grants WHERE company_id = $1 AND agent_id = $2 AND connection_name = $3", [companyId, agentId, connection]);
    return;
  }
  await db.query(
    `INSERT INTO kyoube_meta.connection_grants (company_id, agent_id, connection_name, access, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (company_id, agent_id, connection_name) DO UPDATE SET access = EXCLUDED.access, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [companyId, agentId, connection, access, updatedBy],
  );
}
