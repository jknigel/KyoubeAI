import { createHash } from "node:crypto";
import { z } from "zod";
import { DataError } from "../data/errors.js";
import type { DataActor } from "../data/permissions.js";
import type { RowTarget } from "../data/records-service.js";
import { canonical, type DecideResult, type Question } from "./contract.js";

/**
 * The guardrail on risky agent actions (spec §6). This file holds what can be decided without a
 * database or a provider: which calls are covered, what the model is told about them, how a call is
 * fingerprinted, and what the confirmation card says. The guardrail can only ever hold an action:
 * a pass lets it go ahead exactly as it would without the guardrail.
 */
export type GuardedOperation = "drop_table" | "remove_field" | "rename_table" | "delete" | "update" | "app_publish" | "app_archive" | "app_rollback";

/** What an agent's call carries for the guardrail. Ids only; never data. */
export interface GuardContext { issueId?: string; confirmationId?: string }

export interface GuardedAction {
  companyId: string;
  actor: DataActor;
  operation: GuardedOperation;
  table?: string | null;
  field?: string | null;
  newName?: string | null;
  app?: string | null;
  version?: number | null;
  /** The exact call. It is hashed into the fingerprint and nothing else: never sent, logged or stored. */
  params: Record<string, unknown>;
  /** Rows the action would touch. Called only when the guardrail actually asks the model. */
  countRows?: () => Promise<number | null>;
  guard?: GuardContext;
}

export type GuardAgentAction = (action: GuardedAction) => Promise<void>;

/** Bulk means a `where` filter or more than this many ids. */
export const BULK_IDS = 20;
export const MAX_TASK_TEXT = 8_000;
export const HOLD_TTL_MS = 24 * 60 * 60 * 1000;

export function isBulkTarget(target: RowTarget): boolean {
  const where = target.where;
  const hasWhere = where !== undefined && where !== null && typeof where === "object" && Object.keys(where as object).length > 0;
  return hasWhere || (target.ids?.length ?? 0) > BULK_IDS;
}

/** The normalised parameters of a row update or delete: ids deduplicated and sorted. */
export function rowTargetParams(table: string, target: RowTarget): Record<string, unknown> {
  const ids = target.ids && target.ids.length > 0 ? [...new Set(target.ids)].sort() : null;
  return { table, ids, where: ids ? null : (target.where ?? null) };
}

/** Ties a person's "Allow once" to exactly one call: the same operation with the same parameters. */
export function actionFingerprint(action: Pick<GuardedAction, "operation" | "params">): string {
  return createHash("sha256").update(JSON.stringify(canonical({ operation: action.operation, params: action.params }))).digest("hex");
}

const OPERATION_TEXT: Record<GuardedOperation, string> = {
  drop_table: "drop table",
  remove_field: "remove field",
  rename_table: "rename table",
  delete: "delete rows",
  update: "update rows",
  app_publish: "publish app",
  app_archive: "archive app",
  app_rollback: "roll back app",
};

function rowCount(count: number): string {
  return `${count.toLocaleString("en-GB")} row${count === 1 ? "" : "s"}`;
}

export function describeAction(action: GuardedAction, affectedRows: number | null): string {
  switch (action.operation) {
    case "drop_table": return `drop table \`${action.table}\`${affectedRows === null ? "" : ` (${rowCount(affectedRows)})`}`;
    case "remove_field": return `remove field \`${action.field}\` from table \`${action.table}\``;
    case "rename_table": return `rename table \`${action.table}\` to \`${action.newName}\``;
    case "delete": return `delete ${affectedRows === null ? "rows" : rowCount(affectedRows)} from table \`${action.table}\``;
    case "update": return `update ${affectedRows === null ? "rows" : rowCount(affectedRows)} in table \`${action.table}\``;
    case "app_publish": return `publish app \`${action.app}\`${action.version === null || action.version === undefined ? " (latest version)" : ` version ${action.version}`}`;
    case "app_archive": return `archive app \`${action.app}\``;
    case "app_rollback": return `roll app \`${action.app}\` back to version ${action.version}`;
  }
}

export interface IssueText { title: string; description: string | null }

/**
 * What the model is told: the operation, the names it touches, how many rows, and the task. The
 * task text is what lets the check tell a reset the task asked for from one it did not. Row values
 * never appear: not the patch, not the filter, not the ids.
 */
export function guardState(action: GuardedAction, affectedRows: number | null, issue: IssueText): Record<string, unknown> {
  const subject: Record<string, unknown> = { operation: OPERATION_TEXT[action.operation] };
  for (const key of ["table", "field", "newName", "app", "version"] as const) {
    const value = action[key];
    if (value !== undefined && value !== null) subject[key] = value;
  }
  if (affectedRows !== null) subject.affectedRows = affectedRows;
  const task = [issue.title, issue.description ?? ""].filter((part) => part.trim().length > 0).join("\n\n").slice(0, MAX_TASK_TEXT);
  return { action: subject, task };
}

export const GUARD_QUESTIONS: Record<"matches_task" | "risk", Question> = {
  matches_task: { type: "check", statement: "The action is something the task explicitly asks for or clearly requires." },
  risk: {
    type: "score",
    instructions: "How risky is this action for the company's data and apps, given the task? Dangerous means real business data or something people rely on could be lost or broken.",
    levels: ["routine", "notable", "dangerous"],
  },
};

export function guardPasses(result: DecideResult): boolean {
  const matches = result.answers.matches_task;
  const risk = result.answers.risk;
  if (!matches || !risk) return false;
  // An allow-list, not "anything but dangerous": a value outside the two safe levels never passes.
  return matches.status === "auto" && risk.status === "auto" && matches.value === true && (risk.value === "routine" || risk.value === "notable");
}

export interface ConfirmationPayload { version: 1; prompt: string; detailsMarkdown: string; acceptLabel: string; rejectLabel: string }

function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** Why a card is raised: the check's answers, the check failing, or an earlier hold no person released. */
export type GuardOutcome = { result: DecideResult } | { failure: string } | { heldBefore: true };

export function confirmationPayload(agentName: string, action: GuardedAction, affectedRows: number | null, outcome: GuardOutcome): ConfirmationPayload {
  let details: string;
  if ("result" in outcome) {
    const matches = outcome.result.answers.matches_task;
    const risk = outcome.result.answers.risk;
    details = [
      "The guardrail's automatic check held this action:",
      "",
      `- Part of the task: ${matches ? `${matches.value === true ? "yes" : "no"} (${percent(matches.confidence)} sure)` : "unknown"}`,
      `- Risk: ${risk ? `${String(risk.value)} (${percent(risk.confidence)} sure)` : "unknown"}`,
    ].join("\n");
  } else if ("failure" in outcome) {
    details = `The guardrail's automatic check could not run (${outcome.failure}), so a person has to decide.`;
  } else {
    details = "The guardrail held this exact action before and no person allowed it, so the automatic check was not asked again: a person has to decide.";
  }
  details += "\n\nAllow it once, or don't. Allowing it lets the agent repeat exactly this call one time.";
  return { version: 1, prompt: `Agent ${agentName} wants to ${describeAction(action, affectedRows)}.`, detailsMarkdown: details, acceptLabel: "Allow once", rejectLabel: "Don't allow" };
}

/** The sentence every covered tool's description ends with. */
export const GUARD_NOTE = " If the company's guardrail is on, pass issueId (your task's id, $PAPERCLIP_TASK_ID); a held error means stop and wait for the person, then send the same call again with its confirmationId.";

/** Optional parameters on every covered tool and REST body. */
export const guardToolParams = {
  issueId: z.string().min(1).max(200).optional().describe("the id of the task you are working on ($PAPERCLIP_TASK_ID); needed when the company's guardrail is on"),
  confirmationId: z.string().min(1).max(200).optional().describe("only after a person allowed a held action: the confirmationId from the held error"),
};

const guardSource = z.object({ issueId: z.string().min(1).max(200).optional(), confirmationId: z.string().min(1).max(200).optional() });

/**
 * The two guard ids from a request body, tool parameters or action params; everything else is left
 * where it was. Undefined when the call carries neither, so a caller passes no guard at all then.
 */
export function guardFrom(source: unknown): GuardContext | undefined {
  const parsed = guardSource.safeParse(source ?? {});
  if (!parsed.success) throw new DataError("invalid", "issueId and confirmationId must be strings");
  const guard: GuardContext = {};
  if (parsed.data.issueId) guard.issueId = parsed.data.issueId;
  if (parsed.data.confirmationId) guard.confirmationId = parsed.data.confirmationId;
  return guard.issueId || guard.confirmationId ? guard : undefined;
}

/** `{ guard }` for an options object when the call carries guard ids, else `{}`: nothing is added. */
export function guardOption(source: unknown): { guard?: GuardContext } {
  const guard = guardFrom(source);
  return guard ? { guard } : {};
}
