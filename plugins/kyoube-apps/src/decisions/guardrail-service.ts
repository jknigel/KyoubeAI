import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { DataError } from "../data/errors.js";
import {
  actionFingerprint, confirmationPayload, GUARD_DEADLINE_MS, GUARD_QUESTIONS, guardPasses, guardState, HOLD_TTL_MS,
  type ConfirmationPayload, type GuardAgentAction, type GuardedAction, type GuardOutcome,
} from "./guardrail.js";
import { consumeHold, createHold, findHold, findLiveHold, hasUnreleasedHold, supersedeHold, type Hold } from "./holds.js";
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

/** How many replacement cards a stale confirmationId is followed through; a real chain is far shorter. */
const MAX_SUPERSEDED_HOPS = 20;

/** What became of a hold's card: allowed (and used up), closed without an answer, or allowed for fewer rows than the call now touches. */
type Settled = "allowed" | "closed" | { grown: { allowed: number; now: number } };

/**
 * The guardrail (spec §6). It runs for agent actors only, after the service has authorised the call
 * and before the change, while the company has `decisions_guardrail` on. It can only ever add
 * friction: a pass lets the call go ahead exactly as it would have, and anything else waits on a
 * human-only confirmation card. It never answers a card itself: kyoube.apps has no capability to.
 *
 * Once an agent's action has been held, only a person releases it. While the agent has an unused hold
 * on that exact action (its card declined, closed without an answer, or the hold expired), the model
 * is not asked again, on any task: a new card goes straight to a person. Otherwise the agent could
 * ask the model until it passed.
 *
 * A hold binds to what the person was shown: the exact call, the table's own identity (a table
 * dropped and made again under the same name is another table), and the number of rows. An allowed
 * call that would now touch more rows than its card said does not run; a new card asks again.
 */
export class Guardrail {
  constructor(private readonly deps: GuardrailDeps) {}

  readonly check: GuardAgentAction = async (action) => {
    if (action.actor.kind !== "agent") return;
    const settings = await this.deps.decisions.settingsFor(action.companyId);
    if (!settings.guardrail) return;
    const agentId = action.actor.id;
    // Fail closed: an agent call the guardrail cannot tie to an agent is refused, never let through.
    if (!agentId) throw new DataError("guardrail_context_required", "this agent call carries no agent id, so the company's guardrail cannot check it against the agent's task");
    const issue = await this.issueFor(action, agentId);
    const fingerprint = actionFingerprint(action);
    const now = this.now();
    const confirmationId = action.guard?.confirmationId;
    const liveHold = () => findLiveHold(this.deps.pool, { companyId: action.companyId, agentId, issueId: issue.id, fingerprint, now: new Date(now) });
    let hold: Hold | null;
    if (confirmationId) {
      const named = await this.namedHold(action.companyId, confirmationId, agentId, issue.id, fingerprint);
      if (named.consumedAt) throw new DataError("conflict", "this confirmation was already used: the action ran once. Send the call without confirmationId to have it checked again");
      if (Date.parse(named.expiresAt) <= now) throw new DataError("conflict", "this confirmation expired after 24 hours. Send the call without confirmationId to ask a person again");
      const settled = await this.settle(action, named, now);
      if (settled === "allowed") return;
      if (settled !== "closed") return this.askAgain(action, agentId, issue, fingerprint, named, settled.grown);
      // That card closed without an answer. The newest hold on this call may already carry its next card.
      hold = await liveHold();
      if (hold?.id === named.id) hold = null;
    } else {
      // A plain retry of a held call is the same retry: it reads the same card and never raises another.
      hold = await liveHold();
    }
    if (hold) {
      const settled = await this.settle(action, hold, now);
      if (settled === "allowed") return;
      if (settled !== "closed") return this.askAgain(action, agentId, issue, fingerprint, hold, settled.grown);
    }
    await this.checkOrHold(action, agentId, issue, fingerprint, now);
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
   * The hold a confirmationId names, checked against this call. When a person was asked again because
   * the call grew, the card that replaced it is the one that counts, so the old id leads there.
   */
  private async namedHold(companyId: string, cardId: string, agentId: string, issueId: string, fingerprint: string): Promise<Hold> {
    let named = await findHold(this.deps.pool, companyId, cardId);
    if (!named || named.agentId !== agentId || named.issueId !== issueId || named.fingerprint !== fingerprint) {
      throw new DataError("invalid", "this confirmationId belongs to a different call, agent or task. Send the call without it to have it checked");
    }
    for (let hops = 0; named.supersededBy && hops < MAX_SUPERSEDED_HOPS; hops += 1) {
      const next = await findHold(this.deps.pool, companyId, named.supersededBy);
      if (!next) break;
      named = next;
    }
    return named;
  }

  /**
   * What became of an earlier hold's card. Allowed by a person: the hold is used up here, as the last
   * step before the action runs, and never before that answer is confirmed; a used hold is the only
   * kind that means the action ran. Allowed, but the call would now touch more rows than the card
   * showed: "grown", the hold left unused for the next card to replace. Still waiting or answered by
   * anyone but a person: held. Declined: refused, so the same call keeps getting that answer while the
   * hold lives. Closed without an answer: "closed", the hold left unused, so the next card goes to a
   * person without asking the model.
   */
  private async settle(action: GuardedAction, hold: Hold, now: number): Promise<Settled> {
    const companyId = action.companyId;
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
      if (hold.affectedRows !== null && action.countRows) {
        const rows = await action.countRows();
        if (rows !== null && rows > hold.affectedRows) return { grown: { allowed: hold.affectedRows, now: rows } };
      }
      if (!(await consumeHold(this.deps.pool, hold.id, new Date(now)))) {
        throw new DataError("conflict", "this confirmation is already used or has expired. Send the call without confirmationId to have it checked again");
      }
      return "allowed";
    }
    return "closed";
  }

  /** Ask the model, unless an earlier hold on this exact action was never released; either way, anything short of a pass raises a card. */
  private async checkOrHold(action: GuardedAction, agentId: string, issue: GuardrailIssue, fingerprint: string, now: number): Promise<void> {
    const affectedRows = action.countRows ? await action.countRows() : null;
    let outcome: GuardOutcome;
    if (await hasUnreleasedHold(this.deps.pool, { companyId: action.companyId, agentId, fingerprint, now: new Date(now) })) {
      outcome = { heldBefore: true };
    } else {
      try {
        const result = await this.deps.decisions.decide(
          action.companyId, action.actor, "guardrail",
          { state: guardState(action, affectedRows, issue), questions: GUARD_QUESTIONS },
          { via: action.operation, deadlineMs: GUARD_DEADLINE_MS },
        );
        if (guardPasses(result)) return;
        outcome = { result };
      } catch (error) {
        // Fail closed: a check that cannot run holds the action rather than letting it through.
        if (!(error instanceof DataError)) this.deps.log?.("guardrail check failed", { companyId: action.companyId, operation: action.operation, error: String(error) });
        outcome = { failure: error instanceof DataError ? error.code : "internal error" };
      }
    }
    const holdId = this.deps.newId?.() ?? randomUUID();
    const card = await this.raise(action, agentId, issue, affectedRows, outcome, `kyoube-guardrail:${holdId}`);
    await createHold(this.deps.pool, {
      id: holdId, companyId: action.companyId, agentId, issueId: issue.id, cardId: card.id, fingerprint,
      operation: action.operation, affectedRows, expiresAt: new Date(this.now() + HOLD_TTL_MS),
    });
    throw held(card.id);
  }

  /**
   * An allowed call that would now touch more rows than its card showed: it does not run. A new card
   * asks the person again with the new count, without the model (a person already decided this call
   * once), and replaces the old hold. The key makes a racing or repeated retry find the same card.
   */
  private async askAgain(action: GuardedAction, agentId: string, issue: GuardrailIssue, fingerprint: string, hold: Hold, grown: { allowed: number; now: number }): Promise<never> {
    const card = await this.raise(action, agentId, issue, grown.now, { grown: { allowed: grown.allowed } }, `kyoube-guardrail:${hold.id}:rows:${grown.now}`);
    await createHold(this.deps.pool, {
      id: this.deps.newId?.() ?? randomUUID(), companyId: action.companyId, agentId, issueId: issue.id, cardId: card.id, fingerprint,
      operation: action.operation, affectedRows: grown.now, expiresAt: new Date(this.now() + HOLD_TTL_MS),
    });
    await supersedeHold(this.deps.pool, hold.id, card.id);
    throw held(card.id);
  }

  private async raise(action: GuardedAction, agentId: string, issue: GuardrailIssue, affectedRows: number | null, outcome: GuardOutcome, idempotencyKey: string): Promise<{ id: string }> {
    const agentName = (await this.deps.agentName?.(agentId, action.companyId).catch(() => null)) ?? agentId;
    return this.deps.issues.requestConfirmation(issue.id, {
      title: "Kyoube guardrail: allow this action?",
      payload: confirmationPayload(agentName, action, affectedRows, outcome),
      resolverPolicy: "human_only",
      continuationPolicy: "wake_assignee",
      idempotencyKey,
    }, action.companyId);
  }
}
