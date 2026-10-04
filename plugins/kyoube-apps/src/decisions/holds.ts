import type { Pool } from "pg";

/** One held action, tied to its confirmation card. Used at most once, within 24 hours. */
export interface Hold {
  id: string;
  companyId: string;
  agentId: string;
  issueId: string;
  cardId: string;
  fingerprint: string;
  operation: string;
  consumedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

interface HoldRow {
  id: string; company_id: string; agent_id: string; issue_id: string; card_id: string; action_fingerprint: string;
  operation: string; consumed_at: Date | null; expires_at: Date; created_at: Date;
}
const COLUMNS = "id, company_id, agent_id, issue_id, card_id, action_fingerprint, operation, consumed_at, expires_at, created_at";

function fromRow(row: HoldRow): Hold {
  return {
    id: row.id, companyId: row.company_id, agentId: row.agent_id, issueId: row.issue_id, cardId: row.card_id,
    fingerprint: row.action_fingerprint, operation: row.operation, consumedAt: row.consumed_at ? row.consumed_at.toISOString() : null,
    expiresAt: row.expires_at.toISOString(), createdAt: row.created_at.toISOString(),
  };
}

/**
 * The core returns the existing card for a repeated idempotency key, so a second hold for the same
 * card is not an error: the first one stands and is returned.
 */
export async function createHold(
  pool: Pool,
  input: { id: string; companyId: string; agentId: string; issueId: string; cardId: string; fingerprint: string; operation: string; expiresAt: Date },
): Promise<Hold> {
  await pool.query(
    `INSERT INTO kyoube_meta.guardrail_holds (id, company_id, agent_id, issue_id, card_id, action_fingerprint, operation, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (company_id, card_id) DO NOTHING`,
    [input.id, input.companyId, input.agentId, input.issueId, input.cardId, input.fingerprint, input.operation, input.expiresAt],
  );
  const hold = await findHold(pool, input.companyId, input.cardId);
  if (!hold) throw new Error("guardrail hold was not stored");
  return hold;
}

export async function findHold(pool: Pool, companyId: string, cardId: string): Promise<Hold | null> {
  const result = await pool.query<HoldRow>(`SELECT ${COLUMNS} FROM kyoube_meta.guardrail_holds WHERE company_id = $1 AND card_id = $2`, [companyId, cardId]);
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

/** The newest unused, unexpired hold for this agent, task and exact action. */
export async function findLiveHold(pool: Pool, input: { companyId: string; agentId: string; issueId: string; fingerprint: string; now: Date }): Promise<Hold | null> {
  const result = await pool.query<HoldRow>(
    `SELECT ${COLUMNS} FROM kyoube_meta.guardrail_holds
      WHERE company_id = $1 AND agent_id = $2 AND issue_id = $3 AND action_fingerprint = $4 AND consumed_at IS NULL AND expires_at > $5
      ORDER BY created_at DESC LIMIT 1`,
    [input.companyId, input.agentId, input.issueId, input.fingerprint, input.now],
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

/**
 * One atomic statement, so two racing retries cannot both use the same hold, and an expired hold is
 * never used. `now` is the caller's clock, as for `findLiveHold`.
 */
export async function consumeHold(pool: Pool, holdId: string, now: Date = new Date()): Promise<boolean> {
  const result = await pool.query(
    "UPDATE kyoube_meta.guardrail_holds SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL AND expires_at > $2",
    [holdId, now],
  );
  return (result.rowCount ?? 0) > 0;
}

/** How long a hold is kept after it expires, before the purge job deletes it. */
export const HOLD_GRACE_DAYS = 7;

/**
 * Whether this agent has an unused hold on this exact action that is still kept: unexpired, or
 * expired at most `HOLD_GRACE_DAYS` ago, on any task. Its card never released the action (a used hold
 * means the action ran), so only a person may release it now and the model is not asked again.
 */
export async function hasUnreleasedHold(pool: Pool, input: { companyId: string; agentId: string; fingerprint: string; now: Date }): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM kyoube_meta.guardrail_holds
      WHERE company_id = $1 AND agent_id = $2 AND action_fingerprint = $3 AND consumed_at IS NULL
        AND expires_at > $4::timestamptz - make_interval(days => $5::int)
      LIMIT 1`,
    [input.companyId, input.agentId, input.fingerprint, input.now, HOLD_GRACE_DAYS],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function purgeGuardrailHolds(pool: Pool, graceDays = HOLD_GRACE_DAYS): Promise<number> {
  const result = await pool.query("DELETE FROM kyoube_meta.guardrail_holds WHERE expires_at < now() - make_interval(days => $1::int)", [graceDays]);
  return result.rowCount ?? 0;
}
