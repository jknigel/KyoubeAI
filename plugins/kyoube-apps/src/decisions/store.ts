import type { Pool, PoolClient } from "pg";
import type { Surface } from "./contract.js";

/** A pool for a read, or a transaction's own client when the write commits with its audit row (P4-R12). */
type Db = Pool | PoolClient;

export interface DecisionSettings { agents: boolean; columns: boolean; apps: boolean; guardrail: boolean; dailyCap: number }
export const DEFAULT_DECISION_SETTINGS: DecisionSettings = { agents: false, columns: false, apps: false, guardrail: false, dailyCap: 10_000 };
export const MAX_DAILY_CAP = 1_000_000;

interface SettingsRow { decisions_agents: boolean; decisions_columns: boolean; decisions_apps: boolean; decisions_guardrail: boolean; decisions_daily_cap: number }
const SETTINGS_COLUMNS = "decisions_agents, decisions_columns, decisions_apps, decisions_guardrail, decisions_daily_cap";

function fromRow(row: SettingsRow | undefined): DecisionSettings {
  if (!row) return { ...DEFAULT_DECISION_SETTINGS };
  return { agents: row.decisions_agents, columns: row.decisions_columns, apps: row.decisions_apps, guardrail: row.decisions_guardrail, dailyCap: row.decisions_daily_cap };
}

export async function getDecisionSettings(db: Db, companyId: string): Promise<DecisionSettings> {
  const result = await db.query<SettingsRow>(`SELECT ${SETTINGS_COLUMNS} FROM kyoube_meta.company_settings WHERE company_id = $1`, [companyId]);
  return fromRow(result.rows[0]);
}

export async function setDecisionSettings(db: Db, companyId: string, patch: Partial<DecisionSettings>): Promise<DecisionSettings> {
  const result = await db.query<SettingsRow>(
    `INSERT INTO kyoube_meta.company_settings (company_id, decisions_agents, decisions_columns, decisions_apps, decisions_guardrail, decisions_daily_cap, updated_at)
     VALUES ($1, COALESCE($2::boolean, false), COALESCE($3::boolean, false), COALESCE($4::boolean, false), COALESCE($5::boolean, false), COALESCE($6::integer, 10000), now())
     ON CONFLICT (company_id) DO UPDATE SET
       decisions_agents = COALESCE($2::boolean, company_settings.decisions_agents),
       decisions_columns = COALESCE($3::boolean, company_settings.decisions_columns),
       decisions_apps = COALESCE($4::boolean, company_settings.decisions_apps),
       decisions_guardrail = COALESCE($5::boolean, company_settings.decisions_guardrail),
       decisions_daily_cap = COALESCE($6::integer, company_settings.decisions_daily_cap),
       updated_at = now()
     RETURNING ${SETTINGS_COLUMNS}`,
    [companyId, patch.agents ?? null, patch.columns ?? null, patch.apps ?? null, patch.guardrail ?? null, patch.dailyCap ?? null],
  );
  return fromRow(result.rows[0]);
}

export function utcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * One atomic statement: concurrent callers serialise on the row lock and the `WHERE` is checked
 * against the latest count, so the cap can never be overshot. A first insert above the cap is
 * refused before the statement runs.
 */
export async function reserveRequests(pool: Pool, companyId: string, count: number, cap: number, day: string): Promise<boolean> {
  if (count <= 0) return true;
  if (count > cap) return false;
  const result = await pool.query(
    `INSERT INTO kyoube_meta.decision_usage (company_id, day, requests) VALUES ($1, $2::date, $3)
     ON CONFLICT (company_id, day) DO UPDATE SET requests = decision_usage.requests + EXCLUDED.requests
       WHERE decision_usage.requests + EXCLUDED.requests <= $4
     RETURNING requests`,
    [companyId, day, count, cap],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function releaseRequests(pool: Pool, companyId: string, count: number, day: string): Promise<void> {
  await pool.query("UPDATE kyoube_meta.decision_usage SET requests = GREATEST(requests - $3, 0) WHERE company_id = $1 AND day = $2::date", [companyId, day, count]);
}

export async function usageOn(pool: Pool, companyId: string, day: string): Promise<number> {
  const result = await pool.query<{ requests: number }>("SELECT requests FROM kyoube_meta.decision_usage WHERE company_id = $1 AND day = $2::date", [companyId, day]);
  return result.rows[0]?.requests ?? 0;
}

export interface DecisionLogRow {
  decisionId: string;
  questionKey: string;
  companyId: string;
  surface: Surface;
  actorKind: string;
  actorId: string | null;
  runId: string | null;
  via: string | null;
  fingerprint: string;
  questionType: string;
  answer: string;
  confidence: number;
  reviewThreshold: number;
  status: "auto" | "review";
  model: string;
  latencyMs: number;
}

const LOG_COLUMNS = ["decision_id", "question_key", "company_id", "surface", "actor_kind", "actor_id", "run_id", "via", "question_fingerprint", "question_type", "answer", "confidence", "review_threshold", "status", "model", "latency_ms"];

export async function recordDecisions(pool: Pool, rows: DecisionLogRow[]): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const values = [row.decisionId, row.questionKey, row.companyId, row.surface, row.actorKind, row.actorId, row.runId, row.via, row.fingerprint, row.questionType, row.answer, row.confidence, row.reviewThreshold, row.status, row.model, Math.round(row.latencyMs)];
    const placeholders = values.map((value) => { params.push(value); return `$${params.length}`; });
    return `(${placeholders.join(", ")})`;
  });
  await pool.query(`INSERT INTO kyoube_meta.decisions (${LOG_COLUMNS.join(", ")}) VALUES ${tuples.join(", ")}`, params);
}

export type Outcome = "human_confirmed" | "human_changed";

export async function recordOutcome(
  pool: Pool,
  input: { companyId: string; decisionId: string; questionKey: string; outcome: Outcome; via: "data_page" | "app"; by: string },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE kyoube_meta.decisions SET outcome = $4, outcome_via = $5, outcome_by = $6, outcome_at = now()
     WHERE company_id = $1 AND decision_id = $2 AND question_key = $3`,
    [input.companyId, input.decisionId, input.questionKey, input.outcome, input.via, input.by],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface LoggedDecision {
  decisionId: string;
  questionKey: string;
  surface: Surface;
  actorKind: string;
  actorId: string | null;
  via: string | null;
  answer: string;
  status: "auto" | "review";
  outcome: Outcome | null;
  createdAt: string;
}

export async function getLoggedDecision(pool: Pool, companyId: string, decisionId: string, questionKey: string): Promise<LoggedDecision | null> {
  const result = await pool.query<{ decision_id: string; question_key: string; surface: Surface; actor_kind: string; actor_id: string | null; via: string | null; answer: string; status: "auto" | "review"; outcome: Outcome | null; created_at: Date }>(
    `SELECT decision_id, question_key, surface, actor_kind, actor_id, via, answer, status, outcome, created_at
       FROM kyoube_meta.decisions WHERE company_id = $1 AND decision_id = $2 AND question_key = $3`,
    [companyId, decisionId, questionKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { decisionId: row.decision_id, questionKey: row.question_key, surface: row.surface, actorKind: row.actor_kind, actorId: row.actor_id, via: row.via, answer: row.answer, status: row.status, outcome: row.outcome, createdAt: row.created_at.toISOString() };
}

export async function purgeDecisionData(pool: Pool, retentionDays = 90): Promise<{ decisions: number; usage: number }> {
  const decisions = await pool.query("DELETE FROM kyoube_meta.decisions WHERE created_at < now() - make_interval(days => $1::int)", [retentionDays]);
  const usage = await pool.query("DELETE FROM kyoube_meta.decision_usage WHERE day < ((now() AT TIME ZONE 'UTC')::date - $1::int)", [retentionDays]);
  return { decisions: decisions.rowCount ?? 0, usage: usage.rowCount ?? 0 };
}
