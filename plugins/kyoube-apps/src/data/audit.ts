import type { Pool, PoolClient } from "pg";
import type { DataActor } from "./permissions.js";

export interface AuditEntry {
  companyId: string;
  actor: DataActor;
  operation: string;
  table?: string | null;
  details?: Record<string, unknown> | null;
}

/**
 * Ruling P4-R12: builds a mutation's audit row from the mutation's own result, so the row can be
 * written *inside* the transaction that made the change (see `withCompany`). Returning null
 * writes no row — `purgeTrash` uses that for a run that dropped nothing.
 */
export type AuditPlan<T> = (result: T) => AuditEntry | null;

/**
 * Writes one audit row, on the client of the transaction making the change it records. A pooled
 * client is not accepted: ruling P4-R12 leaves no caller that may write an audit row outside its
 * change's own transaction, and the type is what keeps a new one from appearing. `kyoube_meta` is
 * readable and writable only by the login role, so a scoped caller must have run `RESET ROLE` on
 * that client first.
 */
export async function recordAudit(client: PoolClient, entry: AuditEntry): Promise<void> {
  await client.query(
    "INSERT INTO kyoube_meta.audit (company_id, actor_kind, actor_id, run_id, operation, table_name, details) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [entry.companyId, entry.actor.kind, entry.actor.id, entry.actor.runId ?? null, entry.operation, entry.table ?? null, entry.details ?? null],
  );
}

/**
 * The transaction for a change that lives only in `kyoube_meta` — grants, settings, and every
 * app lifecycle change. There is no company schema to scope (the login role owns `kyoube_meta`,
 * so no role switch is involved), but ruling P4-R12's rule holds all the same: the audit row is
 * written on this client, after `fn` and before COMMIT, so the change and the record of it are
 * one transaction. An audit row Postgres refuses — or a plan that throws — rolls the change back
 * with it, rather than leaving a committed change nobody can account for.
 *
 * `withCompany` is the same contract for a change inside a company's schema; this is the
 * `kyoube_meta`-only half, shared by `DataService` and `AppStore` so there is one of it — and it
 * carries the same 10 s statement ceiling, set before the caller's own statements. Without it a
 * statement that hangs holds a pooled client, an open transaction, and every row it has locked
 * for as long as the server will let it.
 */
export const META_STATEMENT_TIMEOUT_MS = 10_000;

export async function withMeta<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>, audit?: AuditPlan<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // SET LOCAL: it lapses with the transaction rather than sticking to a pooled client and
    // silently capping every later query that client serves.
    await client.query(`SET LOCAL statement_timeout = ${META_STATEMENT_TIMEOUT_MS}`);
    const result = await fn(client);
    const entry = audit?.(result) ?? null;
    if (entry) await recordAudit(client, entry);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
