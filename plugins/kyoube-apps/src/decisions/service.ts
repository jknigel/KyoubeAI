// src/decisions/service.ts
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { withMeta } from "../data/audit.js";
import { DataError } from "../data/errors.js";
import { assertLevel, type DataActor } from "../data/permissions.js";
import type { DataService } from "../data/service.js";
import { callSystemOne, REQUEST_DEADLINE_MS, type FetchLike } from "./client.js";
import {
  answerStatus, assertRequestSize, questionFingerprint, reviewThreshold, withUnsure,
  type Answer, type DecideRequest, type DecideResult, type Question, type Surface,
} from "./contract.js";
import type { ProviderResolver } from "./config.js";
import {
  getDecisionSettings, MAX_DAILY_CAP, recordDecisions, releaseRequests, reserveRequests, setDecisionSettings, usageOn, utcDay,
  type DecisionLogRow, type DecisionSettings,
} from "./store.js";

export interface DecisionActivity { companyId: string; actor: DataActor; surface: Surface | "settings"; via: string | null; summary: string; entityId: string }

export interface DecisionServiceDeps {
  pool: Pool;
  data: Pick<DataService, "levelFor" | "get" | "describeTable" | "assertAdmin">;
  providers: Pick<ProviderResolver, "resolve" | "settings">;
  fetch: FetchLike;
  onActivity?(event: DecisionActivity): Promise<void>;
  onActivityError?(error: unknown, event: DecisionActivity): void;
  /** The operator log. Never handed state, rows, questions or keys. */
  log?(message: string, meta: Record<string, unknown>): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export interface DecideOptions { via?: string | null; advisory?: boolean; includeProbabilities?: boolean; quiet?: boolean; deadlineMs?: number }
export interface RowsInput { table: string; ids: string[]; fields?: string[] }
export type RowDecision = { rowId: string; result: DecideResult } | { rowId: string; error: { code: string; message: string } };
export interface Tally { questions: number; rows: number; auto: number; review: number; failed: number; model: string | null }
export interface DecisionStatus { available: boolean; enabled: boolean; configured: boolean; provider: string | null; model: string | null; budget: { cap: number; used: number; remaining: number } }
export interface DecisionSettingsView {
  settings: DecisionSettings;
  provider: { configured: boolean; provider: string | null; model: string | null; keyResolves: boolean; problem: string | null };
  usage: { used: number; cap: number };
}

export const MAX_ROWS_PER_CALL = 50;
export const ROW_CONCURRENCY = 8;
/** Below the core's 30 s RPC timeout; row mode stops starting rows at REQUEST_DEADLINE_MS. */
export const CALL_DEADLINE_MS = 25_000;

const SURFACE_FLAG: Record<Surface, "agents" | "columns" | "apps" | "guardrail"> = { agents: "agents", columns: "columns", apps: "apps", guardrail: "guardrail" };
const SURFACE_NAME: Record<Surface, string> = { agents: "agents", columns: "AI columns", apps: "apps", guardrail: "the guardrail" };
const WHO: Record<DataActor["kind"], string> = { agent: "an agent", user: "a person", system: "Kyoube" };

const settingsPatchSchema = z.object({
  agents: z.boolean().optional(),
  columns: z.boolean().optional(),
  apps: z.boolean().optional(),
  guardrail: z.boolean().optional(),
  dailyCap: z.number().int().min(0).max(MAX_DAILY_CAP).optional(),
}).strict();

export async function runPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * The part of the daily cap the AI-column fill may use: 90%, rounded down, and nothing under a cap
 * of 10. One cap is shared by every use, so a big backfill must not leave agents, apps and the
 * guardrail with no budget for the rest of the day; they keep the last tenth, and can use the full cap.
 */
export function fillShare(cap: number): number {
  return cap < 10 ? 0 : Math.floor((cap * 9) / 10);
}

export class DecisionService {
  constructor(private readonly deps: DecisionServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  settingsFor(companyId: string): Promise<DecisionSettings> {
    return getDecisionSettings(this.deps.pool, companyId);
  }

  async assertEnabled(companyId: string, surface: Surface): Promise<DecisionSettings> {
    const settings = await this.settingsFor(companyId);
    if (!settings[SURFACE_FLAG[surface]]) {
      throw new DataError("disabled", `typed decisions for ${SURFACE_NAME[surface]} are switched off for this company; a company admin turns them on under Company Settings → Data access`);
    }
    return settings;
  }

  async status(companyId: string, actor: DataActor, surface: Surface): Promise<DecisionStatus> {
    assertLevel(await this.deps.data.levelFor(companyId, actor), "read", "check typed decisions");
    const settings = await this.settingsFor(companyId);
    let configured = false;
    let provider: string | null = null;
    let model: string | null = null;
    try {
      const found = await this.deps.providers.settings(companyId);
      if (found) { configured = true; provider = found.provider; model = found.model; }
    } catch {
      configured = false;
    }
    const used = await usageOn(this.deps.pool, companyId, utcDay(this.now()));
    const enabled = settings[SURFACE_FLAG[surface]];
    return { available: enabled && configured, enabled, configured, provider, model, budget: { cap: settings.dailyCap, used, remaining: Math.max(0, settings.dailyCap - used) } };
  }

  async decide(companyId: string, actor: DataActor, surface: Surface, request: DecideRequest, opts: DecideOptions = {}): Promise<DecideResult> {
    const settings = await this.assertEnabled(companyId, surface);
    assertLevel(await this.deps.data.levelFor(companyId, actor), "read", "make a typed decision");
    const result = await this.decideOne(companyId, actor, surface, settings, request, opts);
    if (!opts.quiet) await this.announce(companyId, actor, surface, opts.via ?? null, this.tally([result]));
    return result;
  }

  async decideRows(companyId: string, actor: DataActor, surface: Surface, input: RowsInput, questions: Record<string, Question>, opts: DecideOptions = {}): Promise<{ results: RowDecision[] }> {
    const ids = [...new Set(input.ids)];
    if (ids.length === 0 || ids.length > MAX_ROWS_PER_CALL) throw new DataError("invalid", `rows.ids takes 1 to ${MAX_ROWS_PER_CALL} ids`);
    const settings = await this.assertEnabled(companyId, surface);
    assertLevel(await this.deps.data.levelFor(companyId, actor), "read", "make a typed decision");
    const table = await this.deps.data.describeTable(companyId, actor, input.table);
    const known = new Map(table.fields.map((field) => [field.name, field]));
    let fields: string[];
    if (input.fields && input.fields.length > 0) {
      const unknown = input.fields.filter((name) => !known.has(name));
      if (unknown.length > 0) throw new DataError("invalid", `unknown field(s) on "${table.name}": ${unknown.join(", ")}`);
      fields = input.fields;
    } else {
      fields = table.fields.filter((field) => field.kind !== "relation" && field.kind !== "json").map((field) => field.name);
    }
    const started = this.now();
    const results: RowDecision[] = new Array(ids.length);
    await runPool(ids, ROW_CONCURRENCY, async (rowId, index) => {
      const elapsed = this.now() - started;
      if (elapsed >= REQUEST_DEADLINE_MS) {
        results[index] = { rowId, error: { code: "timeout", message: "timeout: not started within this call's time limit; send it again" } };
        return;
      }
      try {
        const row = await this.deps.data.get(companyId, actor, input.table, rowId);
        if (!row) throw new DataError("not_found", `row ${rowId} was not found`);
        const state = Object.fromEntries(fields.map((name) => [name, row[name] ?? null]));
        const deadlineMs = Math.min(REQUEST_DEADLINE_MS, CALL_DEADLINE_MS - elapsed);
        results[index] = { rowId, result: await this.decideOne(companyId, actor, surface, settings, { state, questions }, { ...opts, deadlineMs }) };
      } catch (error) {
        if (!(error instanceof DataError)) this.deps.log?.("row decision failed", { companyId, surface, error: String(error) });
        results[index] = { rowId, error: error instanceof DataError ? { code: error.code, message: error.message } : { code: "error", message: "error: internal error" } };
      }
    });
    const decided = results.filter((entry): entry is { rowId: string; result: DecideResult } => "result" in entry).map((entry) => entry.result);
    const tally = { ...this.tally(decided, results.length - decided.length), rows: ids.length, questions: Object.keys(questions).length };
    if (!opts.quiet) await this.announce(companyId, actor, surface, opts.via ?? null, tally);
    return { results };
  }

  tally(results: DecideResult[], failed = 0): Tally {
    const tally: Tally = { questions: 0, rows: results.length + failed, auto: 0, review: 0, failed, model: null };
    for (const result of results) {
      tally.model ??= result.model;
      const answers = Object.values(result.answers);
      tally.questions = Math.max(tally.questions, answers.length);
      for (const answer of answers) {
        if (answer.status === "auto") tally.auto += 1;
        else tally.review += 1;
      }
    }
    return tally;
  }

  async announce(companyId: string, actor: DataActor, surface: Surface, via: string | null, tally: Tally): Promise<void> {
    const onRows = tally.rows > 1 ? ` on ${tally.rows} row(s)` : "";
    const failed = tally.failed > 0 ? `, ${tally.failed} failed` : "";
    const model = tally.model ? ` (${tally.model})` : "";
    const summary = `${WHO[actor.kind]} asked ${tally.questions} question(s)${onRows}: ${tally.auto} auto, ${tally.review} review${failed}${model}`;
    await this.emit({ companyId, actor, surface, via, summary, entityId: via ?? surface });
  }

  async getSettings(companyId: string, actor: DataActor): Promise<DecisionSettingsView> {
    await this.deps.data.assertAdmin(companyId, actor);
    const settings = await this.settingsFor(companyId);
    const used = await usageOn(this.deps.pool, companyId, utcDay(this.now()));
    const provider: DecisionSettingsView["provider"] = { configured: false, provider: null, model: null, keyResolves: false, problem: null };
    try {
      const found = await this.deps.providers.settings(companyId);
      if (found) {
        provider.configured = true;
        provider.provider = found.provider;
        provider.model = found.model;
        await this.deps.providers.resolve(companyId);
        provider.keyResolves = true;
      }
    } catch (error) {
      provider.problem = error instanceof DataError ? error.message : "the provider settings could not be read";
    }
    return { settings, provider, usage: { used, cap: settings.dailyCap } };
  }

  async setSettings(companyId: string, actor: DataActor, patch: unknown): Promise<DecisionSettings> {
    await this.deps.data.assertAdmin(companyId, actor);
    const parsed = settingsPatchSchema.safeParse(patch ?? {});
    if (!parsed.success) throw new DataError("invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "settings"} ${issue.message}`).join("; "));
    const saved = await withMeta(
      this.deps.pool,
      (client) => setDecisionSettings(client, companyId, parsed.data),
      (result) => ({ companyId, actor, operation: "set_decision_settings", table: null, details: { ...result } }),
    );
    await this.emit({ companyId, actor, surface: "settings", via: null, summary: "settings updated", entityId: "settings" });
    return saved;
  }

  // ---- internals --------------------------------------------------------

  private async decideOne(companyId: string, actor: DataActor, surface: Surface, settings: DecisionSettings, request: DecideRequest, opts: DecideOptions): Promise<DecideResult> {
    const questions = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [key, withUnsure(question)]));
    assertRequestSize({ state: request.state, questions });
    const target = await this.deps.providers.resolve(companyId);
    const day = utcDay(this.now());
    const limit = surface === "columns" ? fillShare(settings.dailyCap) : settings.dailyCap;
    if (!(await reserveRequests(this.deps.pool, companyId, 1, limit, day))) {
      if (surface === "columns") {
        throw new DataError("budget_exceeded", `AI columns have used their share of today's typed decisions (UTC): ${limit} of the daily cap of ${settings.dailyCap}, with the rest kept for agents, apps and the guardrail; a company admin can raise the cap under Company Settings → Data access`);
      }
      throw new DataError("budget_exceeded", `this company has used its ${settings.dailyCap} typed decisions for today (UTC); a company admin can raise the cap under Company Settings → Data access`);
    }
    let raw;
    try {
      raw = await callSystemOne({ fetch: this.deps.fetch, sleep: this.deps.sleep, now: this.deps.now }, target, request.state, questions, opts.deadlineMs ?? REQUEST_DEADLINE_MS);
    } catch (error) {
      await releaseRequests(this.deps.pool, companyId, 1, day).catch((releaseError) => this.deps.log?.("decision budget release failed", { companyId, error: String(releaseError) }));
      this.deps.log?.("decision provider call failed", { companyId, surface, provider: target.provider, model: target.model, error: error instanceof Error ? error.message : String(error) });
      throw error instanceof DataError ? error : new DataError("provider_unavailable", "the provider call failed; try again later", { cause: error });
    }
    const answers: Record<string, Answer> = {};
    for (const [key, question] of Object.entries(questions)) {
      const answer = raw.answers[key]!;
      // The status comes from the confidence the caller sees and the log keeps, never the unrounded one.
      const confidence = round4(answer.confidence);
      answers[key] = {
        type: question.type,
        value: answer.value,
        confidence,
        status: answerStatus(question, answer.value, confidence, opts.advisory),
        ...(opts.includeProbabilities ? { probabilities: Object.fromEntries(Object.entries(answer.probabilities).map(([label, p]) => [label, round4(p)])) } : {}),
      };
    }
    const decisionId = randomUUID();
    const rows: DecisionLogRow[] = Object.entries(questions).map(([key, question]) => ({
      decisionId, questionKey: key, companyId, surface, actorKind: actor.kind, actorId: actor.id, runId: actor.runId ?? null,
      via: opts.via ?? null, fingerprint: questionFingerprint(question), questionType: question.type,
      answer: String(answers[key]!.value), confidence: answers[key]!.confidence, reviewThreshold: opts.advisory ? 1 : reviewThreshold(question),
      status: answers[key]!.status, model: raw.model, latencyMs: raw.latencyMs,
    }));
    let loggedId: string | null = decisionId;
    try {
      await recordDecisions(this.deps.pool, rows);
    } catch (error) {
      loggedId = null;
      this.deps.log?.("decision log write failed", { companyId, surface, error: String(error) });
    }
    return { decisionId: loggedId, model: raw.model, answers };
  }

  /** Ruling P2-R23 applies: the decision already happened, so a failed activity log is reported, not thrown. */
  private async emit(event: DecisionActivity): Promise<void> {
    if (!this.deps.onActivity) return;
    try {
      await this.deps.onActivity(event);
    } catch (error) {
      this.deps.onActivityError?.(error, event);
    }
  }
}
