import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { AiCellsView, AiColumnHooks, AiRowWrite, CellCounts, ReviewEntry } from "../data/ai-hooks.js";
import { DataError } from "../data/errors.js";
import { isAiColumn, type AiColumnDefinition } from "../data/field-kinds.js";
import type { AiSourceRow } from "../data/records-service.js";
import type { TableInfo } from "../data/schema-service.js";
import { systemActor, type DataService } from "../data/service.js";
import {
  advanceWatermark, cellRowIdsAfter, clearForRefill, countCells, deleteCells, errorRowIds, getCells, listAiColumns, markManual, resetWatermark, reviewCells, syncColumn, upsertCells, watermarkCeiling,
  type AiColumnRef, type CellWrite,
} from "./cells.js";
import { canonical, questionFingerprint, reviewThreshold, type DecideResult } from "./contract.js";
import { runPool, type DecisionService } from "./service.js";
import { recordOutcome, type Outcome } from "./store.js";

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
/**
 * A write's rows carry its transaction's start time (`now()`) and become visible only when it
 * commits, possibly after a later write's rows. So a scan never moves the watermark past the
 * database clock (read before its first page) less this: rows inside the window are read again
 * next run, and skipped there by their unchanged hash.
 */
export const WATERMARK_LAG_MS = 2 * 60_000;

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

/**
 * Whether a write left an AI value as it was. A form that saves a whole row writes every field
 * back; that must not turn the model's answers into "a person decided", whatever the cell says.
 */
function sameValue(before: unknown, after: unknown): boolean {
  if (before === null || after === null) return before === after;
  return String(before) === String(after);
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

  /** A broken operator log must never break a fill (nor reject `runPool`, see `decideBatch`). */
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
      rowsWritten: (event) => this.rowsWritten(event),
      counts: (companyId, table) => this.counts(companyId, table),
      listReview: (companyId, table, field, limit, offset) => this.listReview(companyId, table, field, limit, offset),
      refill: (companyId, table, field) => this.refill(companyId, table, field),
      cells: (companyId, table, rowIds) => this.cells(companyId, table, rowIds),
    };
  }

  async counts(companyId: string, table: TableInfo): Promise<Record<string, CellCounts>> {
    const refs = await listAiColumns(this.deps.pool, companyId, table.name);
    const counts = await countCells(this.deps.pool, refs.map((ref) => ref.fieldId));
    return Object.fromEntries(refs.map((ref) => [ref.field, counts.get(ref.fieldId)!]));
  }

  async listReview(companyId: string, table: TableInfo, field: string | null, limit: number, offset: number): Promise<ReviewEntry[]> {
    const refs = (await listAiColumns(this.deps.pool, companyId, table.name)).filter((ref) => field === null || ref.field === field);
    if (field !== null && refs.length === 0) throw new DataError("invalid", `"${field}" is not an AI column of "${table.name}"`);
    const entries: ReviewEntry[] = [];
    for (const ref of refs) {
      for (const cell of await reviewCells(this.deps.pool, ref.fieldId, limit + offset, 0)) {
        entries.push({ rowId: cell.rowId, field: ref.field, suggestion: cell.suggestion, confidence: cell.confidence, decisionId: cell.decisionId, updatedAt: cell.updatedAt });
      }
    }
    entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.rowId.localeCompare(b.rowId)));
    return entries.slice(offset, offset + limit);
  }

  async refill(companyId: string, table: TableInfo, field: string): Promise<void> {
    const ref = (await listAiColumns(this.deps.pool, companyId, table.name)).find((candidate) => candidate.field === field);
    if (!ref) throw new DataError("invalid", `"${field}" is not an AI column of "${table.name}"`);
    await clearForRefill(this.deps.pool, ref.fieldId);
    await resetWatermark(this.deps.pool, ref.fieldId);
    this.startBackground(companyId);
  }

  async cells(companyId: string, table: TableInfo, rowIds: string[]): Promise<AiCellsView> {
    const refs = await listAiColumns(this.deps.pool, companyId, table.name);
    const view: AiCellsView = { provider: (await this.deps.providerName?.(companyId)) ?? null, counts: {}, cells: {} };
    if (refs.length === 0) return view;
    const counts = await countCells(this.deps.pool, refs.map((ref) => ref.fieldId));
    for (const ref of refs) {
      view.counts[ref.field] = counts.get(ref.fieldId)!;
      const states = await getCells(this.deps.pool, ref.fieldId, rowIds);
      view.cells[ref.field] = Object.fromEntries([...states].map(([id, state]) => [id, { status: state.status, suggestion: state.suggestion, confidence: state.confidence }]));
    }
    return view;
  }

  /**
   * Writes to AI columns by anyone but the fill job (spec §4, "Edits and outcomes"): a new value
   * makes the cell `manual`, and a person's on a `review` or `auto` cell is logged as confirming
   * or changing that decision; an empty value hands the cell back to the job; a value left as it
   * was changes nothing.
   */
  async rowsWritten(event: AiRowWrite): Promise<void> {
    const fields = event.table.fields.filter((field) => isAiColumn(field) && event.fields.includes(field.name));
    if (fields.length === 0) return;
    const refs = await listAiColumns(this.deps.pool, event.companyId, event.table.name);
    // `markManual` refuses a call that names one row twice: one entry per row, the last one wins.
    const rows = lastPerRow(event.rows, (row) => String(row.id));
    const ids = rows.map((row) => String(row.id));
    // Only a person working in Kyoube itself confirms or changes a decision; an app's code could
    // write without anyone looking, so its writes never count as a human outcome.
    const person = event.actor.kind === "user" && event.actor.id && !event.via ? event.actor.id : null;
    for (const field of fields) {
      const ref = refs.find((candidate) => candidate.field === field.name);
      if (!ref) continue;
      const prior = await getCells(this.deps.pool, ref.fieldId, ids);
      const manual: string[] = [];
      const cleared: string[] = [];
      const outcomes: Array<{ decisionId: string; outcome: Outcome }> = [];
      for (const row of rows) {
        const id = String(row.id);
        const value = row[field.name] ?? null;
        if (sameValue(event.previous.get(id)?.[field.name] ?? null, value)) continue;
        const cell = prior.get(id);
        if (value === null) {
          if (cell) cleared.push(id);
          continue;
        }
        manual.push(id);
        if (cell && (cell.status === "review" || cell.status === "auto") && cell.decisionId) {
          outcomes.push({ decisionId: cell.decisionId, outcome: String(value) === cell.suggestion ? "human_confirmed" : "human_changed" });
        }
      }
      await markManual(this.deps.pool, ref, manual);
      await deleteCells(this.deps.pool, ref.fieldId, cleared);
      if (!person) continue;
      for (const entry of outcomes) {
        await recordOutcome(this.deps.pool, { companyId: event.companyId, decisionId: entry.decisionId, questionKey: AI_QUESTION_KEY, outcome: entry.outcome, via: "data_page", by: person });
      }
    }
  }

  /** Nightly: cells whose rows were deleted. Returns how many cells went. */
  async purgeOrphans(companyId: string): Promise<number> {
    let removed = 0;
    for (const ref of await listAiColumns(this.deps.pool, companyId)) {
      let after: string | null = null;
      for (;;) {
        const ids = await cellRowIdsAfter(this.deps.pool, ref.fieldId, after, SCAN_PAGE);
        if (ids.length === 0) break;
        const existing = new Set(await this.deps.data.existingRowIds(companyId, ref.table, ids));
        const gone = ids.filter((id) => !existing.has(id));
        await deleteCells(this.deps.pool, ref.fieldId, gone);
        removed += gone.length;
        if (ids.length < SCAN_PAGE) break;
        after = ids[ids.length - 1]!;
      }
    }
    return removed;
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
    const columns = await listAiColumns(this.deps.pool, companyId);
    // Per column, the rows this run has already asked about: the retry pass never asks twice.
    const asked = new Map(columns.map((ref) => [ref.fieldId, new Set<string>()]));
    let budget = this.rowsPerRun;
    // 1. New and changed rows, every column.
    for (const ref of columns) {
      if (budget <= 0 || report.stoppedBy || this.now() >= deadline) return report;
      budget -= await this.fillChanged(ref, budget, deadline, report, asked.get(ref.fieldId)!);
    }
    // 2. Cells that failed on an earlier run, with only what is left of the run's rows: a row that
    //    fails the same way every run can never crowd out new ones.
    for (const ref of columns) {
      if (budget <= 0 || report.stoppedBy || this.now() >= deadline) break;
      budget -= await this.retryFailed(ref, budget, deadline, report, asked.get(ref.fieldId)!);
    }
    return report;
  }

  /** Rows changed since the column's watermark, in (updated_at, id) order. Returns how many rows it used of the run's budget. */
  private async fillChanged(ref: AiColumnRef, budget: number, deadline: number, report: FillReport, asked: Set<string>): Promise<number> {
    const sources = ref.definition.sourceFields;
    const fingerprint = columnFingerprint(ref.definition);
    const mark = await syncColumn(this.deps.pool, ref, fingerprint);
    const ceiling = await watermarkCeiling(this.deps.pool, WATERMARK_LAG_MS);
    const candidates: Candidate[] = [];
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
        // Answered, or failed, on these very sources: a failed cell waits for the retry pass.
        if (cell && cell.sourceHash === hash) continue;
        if (asked.has(row.id)) continue;
        asked.add(row.id);
        candidates.push({ row, hash, scanIndex: examined.length - 1 });
        if (candidates.length >= budget) { more = false; break; }
      }
    }
    const outcomes = await this.decideBatch(ref, candidates, deadline, report);
    // The watermark passes every examined row up to the first candidate left unprocessed, and
    // never the ceiling (WATERMARK_LAG_MS).
    let through = examined.length - 1;
    candidates.forEach((candidate, index) => {
      if (outcomes[index] === null && candidate.scanIndex !== null) through = Math.min(through, candidate.scanIndex - 1);
    });
    if (through >= 0) await advanceWatermark(this.deps.pool, ref.fieldId, examined[through]!.at, examined[through]!.id, ceiling);
    return outcomes.filter((outcome) => outcome !== null).length;
  }

  /** Cells that failed on an earlier run, longest-waiting first. Returns how many rows it used of the run's budget. */
  private async retryFailed(ref: AiColumnRef, budget: number, deadline: number, report: FillReport, asked: Set<string>): Promise<number> {
    const sources = ref.definition.sourceFields;
    // Enough ids to make up for the ones this run has already asked about (and just failed on).
    const ids = (await errorRowIds(this.deps.pool, ref.fieldId, budget + asked.size)).filter((id) => !asked.has(id)).slice(0, budget);
    if (ids.length === 0) return 0;
    const rows = await this.deps.data.rowsForAi(ref.companyId, ref.table, ids, sources);
    const found = new Set(rows.map((row) => row.id));
    await deleteCells(this.deps.pool, ref.fieldId, ids.filter((id) => !found.has(id)));
    const fingerprint = columnFingerprint(ref.definition);
    const candidates = rows.map((row): Candidate => ({ row, hash: sourceHash(fingerprint, row.values, sources), scanIndex: null }));
    const outcomes = await this.decideBatch(ref, candidates, deadline, report);
    return outcomes.filter((outcome) => outcome !== null).length;
  }

  /**
   * Decides a batch eight at a time and writes it in one transaction: values for auto answers,
   * empty for review, and the cells with them. Returns each candidate's outcome; null means its
   * turn never came (stopped, or past the deadline) and the row was left as it was.
   */
  private async decideBatch(ref: AiColumnRef, candidates: Candidate[], deadline: number, report: FillReport): Promise<Array<FillOutcome | null>> {
    const { definition } = ref;
    const via = `${ref.table}.${ref.field}`;
    // `runPool` gives up on the first rejection while the other workers carry on, so this never
    // throws: every failure becomes the row's outcome (or, for a stop that never touched it, none).
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

    const values: Array<{ id: string; value: string | boolean | null; at: string }> = [];
    const writes: CellWrite[] = [];
    const results: DecideResult[] = [];
    let failed = 0;
    candidates.forEach((candidate, index) => {
      const outcome = outcomes[index];
      if (!outcome) return;
      if (outcome.kind === "error") {
        failed += 1;
        // The hash it failed on: unchanged, the row waits for the retry pass instead of the scan.
        writes.push({ rowId: candidate.row.id, status: "error", suggestion: null, confidence: null, decisionId: null, sourceHash: candidate.hash });
        return;
      }
      const answer = outcome.result.answers[AI_QUESTION_KEY]!;
      results.push(outcome.result);
      values.push({ id: candidate.row.id, value: answer.status === "auto" ? answer.value : null, at: candidate.row.updatedAt });
      writes.push({ rowId: candidate.row.id, status: answer.status, suggestion: String(answer.value), confidence: answer.confidence, decisionId: outcome.result.decisionId, sourceHash: candidate.hash });
    });
    const cellWrites = lastPerRow(writes, (write) => write.rowId);
    const answered = lastPerRow(values, (entry) => entry.id);
    // A write made while a row was being decided wins over the answer, which was about the row as
    // it was. A cell that turned `manual` since the scan (an edit whose bookkeeping landed late) is
    // passed over here; a row written since the scan is skipped by the write itself (its
    // `updated_at` no longer matches `at`). Neither gets the answer's cell: a manual cell keeps
    // its own, and a row written since is read again by the next run.
    const settled = await getCells(this.deps.pool, ref.fieldId, answered.map((entry) => entry.id));
    const pending = answered.filter((entry) => settled.get(entry.id)?.status !== "manual");
    const answeredIds = new Set(answered.map((entry) => entry.id));
    const cellsFor = (written: string[]): CellWrite[] => {
      const kept = new Set(written);
      return cellWrites.filter((write) => !answeredIds.has(write.rowId) || kept.has(write.rowId));
    };
    if (pending.length > 0) {
      await this.deps.data.writeAiValues(ref.companyId, ref.table, ref.field, pending, { via, inMeta: (client, written) => upsertCells(client, ref, cellsFor(written)) });
    } else {
      await upsertCells(this.deps.pool, ref, cellsFor([]));
    }

    if (results.length + failed > 0) {
      const tally = { ...this.deps.decisions.tally(results, failed), questions: 1 };
      await this.deps.decisions.announce(ref.companyId, systemActor(), "columns", via, tally);
      report.decided += results.length;
      report.review += tally.review;
      report.failed += failed;
    }
    if (stop) report.stoppedBy = stop;
    return outcomes;
  }
}
