import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { DataError } from "../data/errors.js";
import type { DecideResult } from "./contract.js";
import {
  actionFingerprint, confirmationPayload, GUARD_QUESTIONS, guardPasses, guardState, HOLD_TTL_MS,
  type ConfirmationPayload, type GuardAgentAction, type GuardedAction,
} from "./guardrail.js";
import { consumeHold, createHold, findHold, findLiveHold, type Hold } from "./holds.js";
import type { DecisionService } from "./service.js";

export interface GuardrailIssue { id: string; companyId: string; title: string; description: string | null; assigneeAgentId: string | null }
export interface GuardrailCard { id: string; kind: string; status: string; resolvedByUserId?: string | null; resolvedByAgentId?: string | null }

/** The three `ctx.issues` calls the guardrail makes; a port so tests need no host. */
export interface GuardrailIssues {
  get(issueId: string, companyId: string): Promise<GuardrailIssue | null>;
  requestConfirmation(
    issueId: string,
    interaction: { title: string; payload: ConfirmationPayload; resolverPolicy: "human_only"; continuationPolicy: "wake_assignee"; idempotencyKey: string },
    companyId: string,
  ): Promise<{ id: string }>;
  listInteractions(issueId: string, companyId: string): Promise<GuardrailCard[]>;
}

export interface GuardrailDeps {
  pool: Pool;
  decisions: Pick<DecisionService, "settingsFor" | "decide">;
  issues: GuardrailIssues;
  agentName?(agentId: string, companyId: string): Promise<string | null>;
  log?(message: string, meta: Record<string, unknown>): void;
  now?(): number;
  newId?(): string;
}

/** The message names the card as well as `details`: UI actions and the app bridge pass on only the message. */
function held(cardId: string): DataError {
  return new DataError("held", `the company's guardrail is holding this action until a person allows it (confirmation ${cardId}). Stop and wait; when they have allowed it, send exactly the same call again with confirmationId ${cardId}`, { details: { confirmationId: cardId } });
}

function needsTask(reason: string): DataError {
  return new DataError("guardrail_context_required", `${reason}. This action is checked by the company's guardrail: pass issueId, the id of the task you are working on ($PAPERCLIP_TASK_ID)`);
}

const USED_UP = "this confirmation is already used: the action ran once with it, or its card closed without an answer. Send the call without confirmationId to have it checked again";

/**
 * The guardrail (spec §6). It runs for agent actors only, after the service has authorised the call
 * and before the change, while the company has `decisions_guardrail` on. It can only ever add
 * friction: a pass lets the call go ahead exactly as it would have, and anything else waits on a
 * human-only confirmation card. It never answers a card itself: kyoube.apps has no capability to.
 */
export class Guardrail {
  constructor(private readonly deps: GuardrailDeps) {}

  readonly check: GuardAgentAction = async (action) => {
    if (action.actor.kind !== "agent" || !action.actor.id) return;
    const settings = await this.deps.decisions.settingsFor(action.companyId);
    if (!settings.guardrail) return;
    const agentId = action.actor.id;
    const issue = await this.issueFor(action, agentId);
    const fingerprint = actionFingerprint(action);
    const now = this.now();
    const confirmationId = action.guard?.confirmationId;
    let hold: Hold | null;
    if (confirmationId) {
      hold = await findHold(this.deps.pool, action.companyId, confirmationId);
      if (!hold || hold.agentId !== agentId || hold.issueId !== issue.id || hold.fingerprint !== fingerprint) {
        throw new DataError("invalid", "this confirmationId belongs to a different call, agent or task. Send the call without it to have it checked");
      }
      if (hold.consumedAt) throw new DataError("conflict", USED_UP);
      if (Date.parse(hold.expiresAt) <= now) throw new DataError("conflict", "this confirmation expired after 24 hours. Send the call without confirmationId to have it checked again");
    } else {
      // A plain retry of a held call is the same retry: it reads the same card and never raises another.
      hold = await findLiveHold(this.deps.pool, { companyId: action.companyId, agentId, issueId: issue.id, fingerprint, now: new Date(now) });
    }
    if (hold && (await this.settle(action.companyId, hold, now)) === "allowed") return;
    await this.checkAfresh(action, agentId, issue, fingerprint);
  };

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async issueFor(action: GuardedAction, agentId: string): Promise<GuardrailIssue> {
    const issueId = action.guard?.issueId;
    if (!issueId) throw needsTask("issueId is missing");
    const issue = await this.deps.issues.get(issueId, action.companyId).catch(() => null);
    if (!issue || issue.companyId !== action.companyId) throw needsTask(`issue ${issueId} was not found in this company`);
    if (issue.assigneeAgentId !== agentId) throw needsTask(`issue ${issueId} is not assigned to you`);
    return issue;
  }

  /**
   * What became of an earlier hold's card. Allowed by a person: the hold is used up here, as the last
   * step before the action runs, and never before that answer is confirmed. Still waiting or answered
   * by anyone but a person: held, the hold untouched. Declined: refused, and the hold stays so the same
   * call keeps getting that answer. Closed without an answer: the hold is retired and the call is
   * checked afresh.
   */
  private async settle(companyId: string, hold: Hold, now: number): Promise<"allowed" | "closed"> {
    const card = (await this.deps.issues.listInteractions(hold.issueId, companyId)).find((candidate) => candidate.id === hold.cardId);
    const status = card?.status ?? "missing";
    if (status === "pending") throw held(hold.cardId);
    if (status === "rejected") {
      throw new DataError("rejected_by_person", "a person declined this action. Do not try it another way; ask them what they want instead");
    }
    if (status === "accepted") {
      if (!card!.resolvedByUserId || card!.resolvedByAgentId) {
        throw new DataError("forbidden", "the confirmation was not answered by a person, so the action stays held");
      }
      if (!(await consumeHold(this.deps.pool, hold.id, new Date(now)))) {
        throw new DataError("conflict", "this confirmation is already used or has expired. Send the call without confirmationId to have it checked again");
      }
      return "allowed";
    }
    await consumeHold(this.deps.pool, hold.id, new Date(now));
    return "closed";
  }

  private async checkAfresh(action: GuardedAction, agentId: string, issue: GuardrailIssue, fingerprint: string): Promise<void> {
    const affectedRows = action.countRows ? await action.countRows() : null;
    let outcome: { result: DecideResult } | { failure: string };
    try {
      const result = await this.deps.decisions.decide(
        action.companyId, action.actor, "guardrail",
        { state: guardState(action, affectedRows, issue), questions: GUARD_QUESTIONS },
        { via: action.operation },
      );
      if (guardPasses(result)) return;
      outcome = { result };
    } catch (error) {
      // Fail closed: a check that cannot run holds the action rather than letting it through.
      if (!(error instanceof DataError)) this.deps.log?.("guardrail check failed", { companyId: action.companyId, operation: action.operation, error: String(error) });
      outcome = { failure: error instanceof DataError ? error.code : "internal error" };
    }
    const holdId = this.deps.newId?.() ?? randomUUID();
    const agentName = (await this.deps.agentName?.(agentId, action.companyId).catch(() => null)) ?? agentId;
    const card = await this.deps.issues.requestConfirmation(issue.id, {
      title: "Kyoube guardrail: allow this action?",
      payload: confirmationPayload(agentName, action, affectedRows, outcome),
      resolverPolicy: "human_only",
      continuationPolicy: "wake_assignee",
      idempotencyKey: `kyoube-guardrail:${holdId}`,
    }, action.companyId);
    await createHold(this.deps.pool, {
      id: holdId, companyId: action.companyId, agentId, issueId: issue.id, cardId: card.id, fingerprint,
      operation: action.operation, expiresAt: new Date(this.now() + HOLD_TTL_MS),
    });
    throw held(card.id);
  }
}
