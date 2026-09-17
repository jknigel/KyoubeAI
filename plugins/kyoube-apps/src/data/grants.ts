import type { Pool, PoolClient } from "pg";
import { parseLevel, type AccessLevel } from "./permissions.js";

/**
 * A pool for a read, or a transaction's own client when the write has to commit together with
 * its audit row (ruling P4-R12). Grants and settings live in `kyoube_meta`, which only the login
 * role can touch, so neither form ever assumes a company role.
 */
type MetaDb = Pool | PoolClient;

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

export async function setCompanySettings(pool: MetaDb, companyId: string, patch: Partial<CompanySettings>): Promise<CompanySettings> {
  const defaultAgentLevel = patch.defaultAgentLevel !== undefined ? parseLevel(patch.defaultAgentLevel) : null;
  const hardDelete = patch.hardDelete !== undefined ? patch.hardDelete : null;
  const result = await pool.query<{ default_agent_level: string; hard_delete: boolean }>(
    `INSERT INTO kyoube_meta.company_settings (company_id, default_agent_level, hard_delete, updated_at)
     VALUES ($1, COALESCE($2::text, 'none'), COALESCE($3::boolean, false), now())
     ON CONFLICT (company_id) DO UPDATE
       SET default_agent_level = COALESCE($2::text, company_settings.default_agent_level),
           hard_delete = COALESCE($3::boolean, company_settings.hard_delete),
           updated_at = now()
     RETURNING default_agent_level, hard_delete`,
    [companyId, defaultAgentLevel, hardDelete],
  );
  const row = result.rows[0]!;
  return { defaultAgentLevel: parseLevel(row.default_agent_level), hardDelete: row.hard_delete };
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

export async function setAgentGrant(pool: MetaDb, companyId: string, agentId: string, level: AccessLevel, updatedBy: string | null): Promise<AgentGrant> {
  const result = await pool.query<{ updated_at: Date }>(
    `INSERT INTO kyoube_meta.agent_grants (company_id, agent_id, level, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (company_id, agent_id) DO UPDATE SET level = EXCLUDED.level, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING updated_at`,
    [companyId, agentId, parseLevel(level), updatedBy],
  );
  return { agentId, level, updatedBy, updatedAt: result.rows[0]!.updated_at.toISOString() };
}
