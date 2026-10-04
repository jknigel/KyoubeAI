import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { AiColumnHooks } from "../data/ai-hooks.js";
import { DataError } from "../data/errors.js";
import type { AiColumnDefinition } from "../data/field-kinds.js";
import type { AiSourceRow } from "../data/records-service.js";
import { systemActor, type DataService } from "../data/service.js";
import { advanceWatermark, deleteCells, errorRowIds, getCells, listAiColumns, syncColumn, upsertCells, type AiColumnRef, type CellWrite } from "./cells.js";
import { canonical, questionFingerprint, reviewThreshold, type DecideResult } from "./contract.js";
import { runPool, type DecisionService } from "./service.js";

/**
 * AI columns (docs/decisions.md, spec §4): the fill engine behind the `fill-ai-columns` job
 * (FILL_JOB_KEY in manifest.ts) and the background fill a new or changed column starts.
 */
export const FILL_ROWS_PER_RUN = 2000;
export const FILL_CONCURRENCY = 8;
/** The core gives a job 5 minutes; a run stops starting rows at 4. */
export const FILL_DEADLINE_MS = 4 * 60_000;
export const SCAN_PAGE = 500;
/** Field names may be 63 characters and question keys only 40, so the fill job asks under one key. */
export const AI_QUESTION_KEY = "value";

/** Errors that end a company's run: no budget, switched off, or the provider is not answering. */
const STOP = new Set(["budget_exceeded", "disabled", "provider_unavailable", "provider_rejected", "timeout"]);
/** Of those, the ones that never touched the row: it is left as it was, behind the watermark. */
const UNTOUCHED = new Set(["budget_exceeded", "disabled"]);

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** What makes a column's answers what they are: its question, sources, threshold and advisory flag. */
export function columnFingerprint(definition: AiColumnDefinition): string {
  return sha256(JSON.stringify({ question: questionFingerprint(definition.question), sources: definition.sourceFields, review: reviewThreshold(definition.question), advisory: definition.advisory === true }));
}

/** Only the hash is stored, never the values. */
export function sourceHash(fingerprint: string, values: Record<string, unknown>, sourceFields: string[]): string {
  return sha256(`${fingerprint}\n${JSON.stringify(canonical(sourceFields.map((field) => values[field] ?? null)))}`);
}

/**
 * `upsertCells` refuses a call that names one row twice (ON CONFLICT cannot touch a row twice in
 * one statement), so every batch goes through this first: one entry per row, the last one wins.
 */
function lastPerRow<T>(entries: T[], rowId: (entry: T) => string): T[] {
  return [...new Map(entries.map((entry) => [rowId(entry), entry])).values()];
}

export interface FillReport { companyId: string; decided: number; review: number; failed: number; stoppedBy: string | null }

export interface AiColumnServiceDeps {
  pool: Pool;
  data: Pick<DataService, "scanForAi" | "rowsForAi" | "existingRowIds" | "writeAiValues">;
  decisions: Pick<DecisionService, "decide" | "assertEnabled" | "announce" | "tally">;
  providerName?(companyId: string): Promise<string | null>;
  /** The operator log. Never handed row values. */
  log?(message: string, meta: Record<string, unknown>): void;
  now?(): number;
  limits?: { rowsPerRun?: number; deadlineMs?: number };
}

interface Candidate { row: AiSourceRow; hash: string; scanIndex: number | null }
type FillOutcome = { kind: "decided"; result: DecideResult } | { kind: "error" };

export class AiColumnService {
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();

  constructor(private readonly deps: AiColumnServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get rowsPerRun(): number {
    return this.deps.limits?.rowsPerRun ?? FILL_ROWS_PER_RUN;
  }

  private get deadlineMs(): number {
    return this.deps.limits?.deadlineMs ?? FILL_DEADLINE_MS;
  }

  /** A broken operator log must never break a fill (nor reject `runPool`, see `fillColumn`). */
  private log(message: string, meta: Record<string, unknown>): void {
    try {
      this.deps.log?.(message, meta);
    } catch {
      // Nothing left to report it to.
    }
  }

  hooks(): AiColumnHooks {
    return {
      assertEnabled: async (companyId) => { await this.deps.decisions.assertEnabled(companyId, "columns"); },
      changed: (companyId) => this.startBackground(companyId),
      rowsWritten: async () => {},
      counts: async () => ({}),
      listReview: async () => [],
      refill: async () => {},
      cells: async () => ({ provider: null, counts: {}, cells: {} }),
    };
  }

  /** One company, under its lock; a second request while it runs makes it run once more after. */
  startBackground(companyId: string): void {
    if (this.running.has(companyId)) {
      this.again.add(companyId);
      return;
    }
    const run = (async () => {
      try {
        do {
          this.again.delete(companyId);
          await this.fillCompany(companyId).catch((error) => this.log("AI column fill failed", { companyId, error: String(error) }));
        } while (this.again.has(companyId));
      } finally {
        // In the same step as the last check of `again`, so no request can slip in between.
        this.running.delete(companyId);
      }
    })();
    this.running.set(companyId, run);
  }

  /** Resolves once the company's background fill (if any) has finished. */
  async idle(companyId: string): Promise<void> {
    while (this.running.has(companyId)) await this.running.get(companyId);
  }

  /** The `fill-ai-columns` job: every company with AI columns on, sharing one deadline. */
  async runJob(): Promise<FillReport[]> {
    const deadline = this.now() + this.deadlineMs;
    const companies = await this.deps.pool.query<{ company_id: string }>("SELECT company_id FROM kyoube_meta.company_settings WHERE decisions_columns ORDER BY company_id");
    const reports: FillReport[] = [];
    for (const { company_id: companyId } of companies.rows) {
      if (this.now() >= deadline) break;
      if (this.running.has(companyId)) continue;
      const run = this.fillCompany(companyId, deadline)
        .then((report) => void reports.push(report), (error) => this.log("AI column fill failed", { companyId, error: String(error) }))
        .finally(() => this.running.delete(companyId));
      this.running.set(companyId, run);
      await run;
      // A column created or changed while the job held this company's lock is filled now, not
      // at the next scheduled run.
      if (this.again.delete(companyId)) this.startBackground(companyId);
    }
    return reports;
  }

  async fillCompany(companyId: string, deadline: number = this.now() + this.deadlineMs): Promise<FillReport> {
    const report: FillReport = { companyId, decided: 0, review: 0, failed: 0, stoppedBy: null };
    try {
      await this.deps.decisions.assertEnabled(companyId, "columns");
    } catch (error) {
      if (error instanceof DataError && error.code === "disabled") {
        report.stoppedBy = "disabled";
        return report;
      }
      throw error;
    }
    let budget = this.rowsPerRun;
    for (const column of await listAiColumns(this.deps.pool, companyId)) {
      if (budget <= 0 || report.stoppedBy || this.now() >= deadline) break;
      budget -= await this.fillColumn(column, budget, deadline, report);
    }
    return report;
  }

  /** Returns how many rows this column used of the run's budget. */
  private async fillColumn(ref: AiColumnRef, budget: number, deadline: number, report: FillReport): Promise<number> {
    const { definition } = ref;
    const fingerprint = columnFingerprint(definition);
    const mark = await syncColumn(this.deps.pool, ref, fingerprint);
    const sources = definition.sourceFields;
    const via = `${ref.table}.${ref.field}`;
    const candidates: Candidate[] = [];
    const chosen = new Set<string>();

    // 1. Cells that failed last time, whatever the watermark says.
    const retry = await errorRowIds(this.deps.pool, ref.fieldId, budget);
    if (retry.length > 0) {
      const rows = await this.deps.data.rowsForAi(ref.companyId, ref.table, retry, sources);
      for (const row of rows) {
        if (chosen.has(row.id)) continue;
        chosen.add(row.id);
        candidates.push({ row, hash: sourceHash(fingerprint, row.values, sources), scanIndex: null });
      }
      await deleteCells(this.deps.pool, ref.fieldId, retry.filter((id) => !chosen.has(id)));
    }

    // 2. Rows changed since the watermark, in (updated_at, id) order.
    const examined: Array<{ at: string; id: string }> = [];
    let after = mark.at && mark.id ? { at: mark.at, id: mark.id } : null;
    let more = true;
    while (more && candidates.length < budget && this.now() < deadline) {
      const page = await this.deps.data.scanForAi(ref.companyId, ref.table, sources, after, SCAN_PAGE);
      more = page.length === SCAN_PAGE;
      if (page.length === 0) break;
      const cells = await getCells(this.deps.pool, ref.fieldId, page.map((row) => row.id));
      for (const row of page) {
        examined.push({ at: row.updatedAt, id: row.id });
        after = { at: row.updatedAt, id: row.id };
        const cell = cells.get(row.id);
        const hash = sourceHash(fingerprint, row.values, sources);
        if (cell?.status === "manual") continue;
        if (cell && cell.status !== "error" && cell.sourceHash === hash) continue;
        if (chosen.has(row.id)) continue;
        chosen.add(row.id);
        candidates.push({ row, hash, scanIndex: examined.length - 1 });
        if (candidates.length >= budget) { more = false; break; }
      }
    }

    // 3. Decide, eight at a time. A row whose turn never came stays unprocessed. `runPool` gives
    //    up on the first rejection while the other workers carry on, so this never throws: every
    //    failure becomes the row's outcome (or, for a stop that never touched it, none).
    const outcomes: Array<FillOutcome | null> = candidates.map(() => null);
    let stop: string | null = null;
    await runPool(candidates, FILL_CONCURRENCY, async (candidate, index) => {
      if (stop || this.now() >= deadline) return;
      try {
        const result = await this.deps.decisions.decide(ref.companyId, systemActor(), "columns",
          { state: candidate.row.values, questions: { [AI_QUESTION_KEY]: definition.question } },
          { quiet: true, advisory: definition.advisory === true, via });
        outcomes[index] = { kind: "decided", result };
      } catch (error) {
        const code = error instanceof DataError ? error.code : "error";
        if (STOP.has(code)) stop ??= code;
        if (UNTOUCHED.has(code)) return;
        outcomes[index] = { kind: "error" };
        if (!(error instanceof DataError)) this.log("AI column decision failed", { companyId: ref.companyId, column: via, error: String(error) });
      }
    });

    // 4. One write for the batch: values for auto answers, empty for review; cells in the same transaction.
    const values: Array<{ id: string; value: string | boolean | null }> = [];
    const writes: CellWrite[] = [];
    const results: DecideResult[] = [];
    let failed = 0;
    candidates.forEach((candidate, index) => {
      const outcome = outcomes[index];
      if (!outcome) return;
      if (outcome.kind === "error") {
        failed += 1;
        writes.push({ rowId: candidate.row.id, status: "error", suggestion: null, confidence: null, decisionId: null, sourceHash: null });
        return;
      }
      const answer = outcome.result.answers[AI_QUESTION_KEY]!;
      results.push(outcome.result);
      values.push({ id: candidate.row.id, value: answer.status === "auto" ? answer.value : null });
      writes.push({ rowId: candidate.row.id, status: answer.status, suggestion: String(answer.value), confidence: answer.confidence, decisionId: outcome.result.decisionId, sourceHash: candidate.hash });
    });
    const cellWrites = lastPerRow(writes, (write) => write.rowId);
    if (values.length > 0) {
      await this.deps.data.writeAiValues(ref.companyId, ref.table, ref.field, lastPerRow(values, (entry) => entry.id), { via, inMeta: (client) => upsertCells(client, ref, cellWrites) });
    } else if (cellWrites.length > 0) {
      await upsertCells(this.deps.pool, ref, cellWrites);
    }

    // 5. The watermark passes every examined row up to the first candidate left unprocessed.
    let through = examined.length - 1;
    candidates.forEach((candidate, index) => {
      if (outcomes[index] === null && candidate.scanIndex !== null) through = Math.min(through, candidate.scanIndex - 1);
    });
    if (through >= 0) await advanceWatermark(this.deps.pool, ref.fieldId, examined[through]!.at, examined[through]!.id);

    if (results.length + failed > 0) {
      const tally = { ...this.deps.decisions.tally(results, failed), questions: 1 };
      await this.deps.decisions.announce(ref.companyId, systemActor(), "columns", via, tally);
      report.decided += results.length;
      report.review += tally.review;
      report.failed += failed;
    }
    if (stop) report.stoppedBy = stop;
    return results.length + failed;
  }
}
