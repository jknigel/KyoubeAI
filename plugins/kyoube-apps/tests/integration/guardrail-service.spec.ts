// tests/integration/guardrail-service.spec.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataError } from "../../src/data/errors.js";
import { ensureCompany, resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import type { DecideResult } from "../../src/decisions/contract.js";
import type { GuardContext, GuardedAction } from "../../src/decisions/guardrail.js";
import { Guardrail, type GuardrailCard, type GuardrailIssue, type GuardrailIssues } from "../../src/decisions/guardrail-service.js";
import { findHold } from "../../src/decisions/holds.js";
import { createTestDatabase } from "./setup.js";

const C = "88888888-8888-4888-8888-888888888888";
const AGENT = { kind: "agent" as const, id: "agent-1", runId: "run-1" };
const OTHER_AGENT = { kind: "agent" as const, id: "agent-2", runId: "run-2" };
const ISSUE = "issue-mine";
const ISSUE_2 = "issue-mine-too";
const OTHER_ISSUE = "issue-theirs";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/guardrail-service.spec.ts", "src/db/migrate.ts")));
  await ensureCompany(db.pool, C);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.pool.query("DELETE FROM kyoube_meta.guardrail_holds"); });

const PASS: DecideResult = { decisionId: "d-1", model: "jev-1.13.0", answers: {
  matches_task: { type: "check", value: true, confidence: 0.97, status: "auto" },
  risk: { type: "score", value: "notable", confidence: 0.93, status: "auto" },
} };
const OFF_TASK: DecideResult = { decisionId: "d-2", model: "jev-1.13.0", answers: {
  matches_task: { type: "check", value: false, confidence: 0.96, status: "auto" },
  risk: { type: "score", value: "dangerous", confidence: 0.91, status: "auto" },
} };

type Card = GuardrailCard & { issueId: string; request: Parameters<GuardrailIssues["requestConfirmation"]>[1] };

function fakeIssues() {
  const issues = new Map<string, GuardrailIssue>([
    [ISSUE, { id: ISSUE, companyId: C, title: "Summarise last week's tickets", description: "Read only. Do not change or delete any data.", assigneeAgentId: "agent-1" }],
    [OTHER_ISSUE, { id: OTHER_ISSUE, companyId: C, title: "Another task", description: null, assigneeAgentId: "agent-2" }],
    [ISSUE_2, { id: ISSUE_2, companyId: C, title: "A second task", description: null, assigneeAgentId: "agent-1" }],
  ]);
  const cards: Card[] = [];
  const port: GuardrailIssues = {
    get: async (id, companyId) => { const issue = issues.get(id); return issue && issue.companyId === companyId ? issue : null; },
    requestConfirmation: async (issueId, interaction) => {
      const existing = cards.find((card) => card.request.idempotencyKey === interaction.idempotencyKey);
      if (existing) return existing;
      const card: Card = { id: `card-${cards.length + 1}`, kind: "request_confirmation", status: "pending", resolvedByUserId: null, resolvedByAgentId: null, issueId, request: interaction };
      cards.push(card);
      return card;
    },
    listInteractions: async (issueId) => cards.filter((card) => card.issueId === issueId),
  };
  return { cards, port };
}

function harness(initial: DecideResult | Error = OFF_TASK, opts: { guardrail?: boolean } = {}) {
  const decided: unknown[][] = [];
  let answer = initial;
  let clock = Date.parse("2026-10-05T12:00:00Z");
  const issues = fakeIssues();
  const guardrail = new Guardrail({
    pool: db.pool,
    decisions: {
      settingsFor: async () => ({ agents: false, columns: false, apps: false, guardrail: opts.guardrail ?? true, dailyCap: 100 }),
      decide: async (...args: unknown[]) => { decided.push(args); if (answer instanceof Error) throw answer; return answer; },
    } as never,
    issues: issues.port,
    agentName: async (id) => (id === "agent-1" ? "Builder" : null),
    now: () => clock,
  });
  return { guardrail, decided, cards: issues.cards, advance: (ms: number) => { clock += ms; }, answer: (next: DecideResult | Error) => { answer = next; } };
}

function drop(guard?: GuardContext, overrides: Partial<GuardedAction> = {}): GuardedAction {
  return { companyId: C, actor: AGENT, operation: "drop_table", table: "scratch", params: { table: "scratch" }, countRows: async () => 1204, guard, ...overrides };
}

async function failure(promise: Promise<unknown>): Promise<DataError | "resolved"> {
  try { await promise; return "resolved"; } catch (error) { if (error instanceof DataError) return error; throw error; }
}

describe("Guardrail.check", () => {
  it("never checks people, and does nothing while the guardrail is off", async () => {
    const off = harness(OFF_TASK, { guardrail: false });
    await off.guardrail.check(drop({ issueId: ISSUE }));
    await off.guardrail.check(drop(undefined, { actor: { kind: "user", id: "owner-1", runId: null } }));
    expect(off.decided).toHaveLength(0);
    const on = harness();
    await on.guardrail.check(drop(undefined, { actor: { kind: "user", id: "owner-1", runId: null } }));
    expect(on.decided).toHaveLength(0);
  });

  it("refuses an agent call that carries no agent id instead of letting it through", async () => {
    const { guardrail, decided, cards } = harness(PASS);
    const anonymous = drop({ issueId: ISSUE }, { actor: { kind: "agent", id: null, runId: null } });
    expect((await failure(guardrail.check(anonymous)) as DataError).code).toBe("guardrail_context_required");
    expect([decided.length, cards.length]).toEqual([0, 0]);
    // With the guardrail off there is nothing to check.
    await harness(PASS, { guardrail: false }).guardrail.check(anonymous);
  });

  it("needs the agent's own task", async () => {
    const { guardrail, decided } = harness();
    expect((await failure(guardrail.check(drop())) as DataError).code).toBe("guardrail_context_required");
    expect((await failure(guardrail.check(drop({ issueId: "nope" }))) as DataError).code).toBe("guardrail_context_required");
    const theirs = await failure(guardrail.check(drop({ issueId: OTHER_ISSUE })));
    expect((theirs as DataError).code).toBe("guardrail_context_required");
    expect((theirs as DataError).message).toContain("not assigned to you");
    expect(decided).toHaveLength(0);
  });

  it("lets a passing action through without a card, after asking about names, count and task only", async () => {
    const { guardrail, decided, cards } = harness(PASS);
    await guardrail.check(drop({ issueId: ISSUE }));
    expect(cards).toHaveLength(0);
    const [companyId, actor, surface, request, options] = decided[0]!;
    // 12 s for the provider, so the check, the count and the action itself fit the core's 30 s call.
    expect([companyId, actor, surface, options]).toEqual([C, AGENT, "guardrail", { via: "drop_table", deadlineMs: 12_000 }]);
    expect(request).toMatchObject({
      state: { action: { operation: "drop table", table: "scratch", affectedRows: 1204 }, task: "Summarise last week's tickets\n\nRead only. Do not change or delete any data." },
      questions: { matches_task: { type: "check" }, risk: { type: "score" } },
    });
  });

  it("holds a doubtful action behind a human-only card and remembers it", async () => {
    const { guardrail, cards } = harness(OFF_TASK);
    const held = await failure(guardrail.check(drop({ issueId: ISSUE }))) as DataError;
    expect(held.code).toBe("held");
    expect(held.details).toEqual({ confirmationId: "card-1" });
    // UI actions and the app bridge pass on only the message, so it names the card too.
    expect(held.message).toContain("(confirmation card-1)");
    expect(cards[0]!.request).toMatchObject({ resolverPolicy: "human_only", continuationPolicy: "wake_assignee", title: "Kyoube guardrail: allow this action?" });
    expect(cards[0]!.request.payload).toMatchObject({ prompt: "Agent Builder wants to drop table `scratch` (1,204 rows).", acceptLabel: "Allow once", rejectLabel: "Don't allow" });
    expect(await findHold(db.pool, C, "card-1")).toMatchObject({ agentId: "agent-1", issueId: ISSUE, operation: "drop_table", consumedAt: null });
  });

  it("holds the action when the check cannot run, and says so on the card", async () => {
    const { guardrail, cards } = harness(new DataError("provider_unavailable", "down"));
    expect((await failure(guardrail.check(drop({ issueId: ISSUE }))) as DataError).code).toBe("held");
    expect(cards[0]!.request.payload.detailsMarkdown).toContain("could not run (provider_unavailable)");
  });

  it("gives the same card to a repeated call while it is pending", async () => {
    const { guardrail, cards, decided } = harness(OFF_TASK);
    await failure(guardrail.check(drop({ issueId: ISSUE })));
    const again = await failure(guardrail.check(drop({ issueId: ISSUE }))) as DataError;
    const retry = await failure(guardrail.check(drop({ issueId: ISSUE, confirmationId: "card-1" }))) as DataError;
    expect([again.code, again.details?.confirmationId, retry.code, retry.details?.confirmationId]).toEqual(["held", "card-1", "held", "card-1"]);
    expect(cards).toHaveLength(1);
    expect(decided).toHaveLength(1);
  });

  it("runs the action once after a person allows it", async () => {
    const { guardrail, cards } = harness(OFF_TASK);
    await failure(guardrail.check(drop({ issueId: ISSUE })));
    Object.assign(cards[0]!, { status: "accepted", resolvedByUserId: "owner-1" });
    await guardrail.check(drop({ issueId: ISSUE, confirmationId: "card-1" }));
    const reused = await failure(guardrail.check(drop({ issueId: ISSUE, confirmationId: "card-1" }))) as DataError;
    expect(reused.code).toBe("conflict");
    expect(reused.message).toContain("already used");
  });

  it("lets an allowed external write through once, and holds it again with a different body", async () => {
    const { guardrail, cards } = harness(OFF_TASK);
    const write = (bodyHash: string): GuardedAction => ({
      companyId: C, actor: AGENT, operation: "connection_write", connection: "crm", method: "POST", path: "contacts/42",
      params: { connection: "crm", method: "POST", path: "contacts/42", queryHash: "q", bodyHash }, guard: { issueId: ISSUE },
    });
    const held = await failure(guardrail.check(write("b1"))) as DataError;
    expect(held.code).toBe("held");
    expect(cards[0]!.request.payload.prompt).toBe("Agent Builder wants to send a POST to connection crm at contacts/42.");
    Object.assign(cards[0]!, { status: "accepted", resolvedByUserId: "owner-1" });
    const other = await failure(guardrail.check(write("b2"))) as DataError;
    expect(other.code).toBe("held");
    expect(await failure(guardrail.check(write("b1")))).toBe("resolved");
    const again = await failure(guardrail.check(write("b1"))) as DataError;
    expect(again.code).toBe("held");
  });

  it("runs a plain retry that matches an allowed hold once, then checks the next identical call with the model as normal", async () => {
    const { guardrail, cards, decided } = harness(OFF_TASK);
    await failure(guardrail.check(drop({ issueId: ISSUE })));
    Object.assign(cards[0]!, { status: "accepted", resolvedByUserId: "owner-1" });
    await guardrail.check(drop({ issueId: ISSUE }));
    expect((await findHold(db.pool, C, "card-1"))!.consumedAt).not.toBeNull();
    // The hold is used up, so the next identical call is checked afresh (and held again).
    const next = await failure(guardrail.check(drop({ issueId: ISSUE }))) as DataError;
    expect([next.code, next.details?.confirmationId, decided.length]).toEqual(["held", "card-2", 2]);
  });

  it("does not count a card an agent answered", async () => {
    const { guardrail, cards } = harness(OFF_TASK);
    await failure(guardrail.check(drop({ issueId: ISSUE })));
    Object.assign(cards[0]!, { status: "accepted", resolvedByUserId: null, resolvedByAgentId: "agent-9" });
    expect((await failure(guardrail.check(drop({ issueId: ISSUE, confirmationId: "card-1" }))) as DataError).code).toBe("forbidden");
    expect((await findHold(db.pool, C, "card-1"))!.consumedAt).toBeNull();
    // A card both a person and an agent are recorded on is not a person's answer either.
    Object.assign(cards[0]!, { resolvedByUserId: "owner-1", resolvedByAgentId: "agent-9" });
    expect((await failure(guardrail.check(drop({ issueId: ISSUE, confirmationId: "card-1" }))) as DataError).code).toBe("forbidden");
    expect((await findHold(db.pool, C, "card-1"))!.consumedAt).toBeNull();
  });

  it("refuses for good when the person declines", async () => {
    const { guardrail, cards, decided } = harness(OFF_TASK);
    await failure(guardrail.check(drop({ issueId: ISSUE })));
    Object.assign(cards[0]!, { status: "rejected", resolvedByUserId: "owner-1" });
    expect((await failure(guardrail.check(drop({ issueId: ISSUE, confirmationId: "card-1" }))) as DataError).code).toBe("rejected_by_person");
    // Declined is not used: the same call, with or without the id, keeps getting the person's answer.
    expect((await failure(guardrail.check(drop({ issueId: ISSUE, confirmationId: "card-1" }))) as DataError).code).toBe("rejected_by_person");
    expect((await failure(guardrail.check(drop({ issueId: ISSUE }))) as DataError).code).toBe("rejected_by_person");
    expect((await findHold(db.pool, C, "card-1"))!.consumedAt).toBeNull();
    expect([cards.length, decided.length]).toEqual([1, 1]);
  });

  it("raises a new card without asking the model again when the old card closed without an answer", async () => {
    const { guardrail, cards, decided, answer } = harness(OFF_TASK);
    await failure(guardrail.check(drop({ issueId: ISSUE })));
    Object.assign(cards[0]!, { status: "cancelled" });
    answer(PASS);
    const held = await failure(guardrail.check(drop({ issueId: ISSUE }))) as DataError;
    expect([held.code, held.details?.confirmationId, decided.length]).toEqual(["held", "card-2", 1]);
    expect(cards[1]!.request.payload.detailsMarkdown).toContain("was not asked again");
    // The unanswered hold stays unused: it never released the action.
    expect((await findHold(db.pool, C, "card-1"))!.consumedAt).toBeNull();
    // Retrying with the closed card's id finds the next card instead of raising yet another.
    const stale = await failure(guardrail.check(drop({ issueId: ISSUE, confirmationId: "card-1" }))) as DataError;
    expect([stale.code, stale.details?.confirmationId, cards.length, decided.length]).toEqual(["held", "card-2", 2, 1]);
  });

  it("sends an expired declined hold to a person, never back to the model", async () => {
    const { guardrail, cards, decided, advance, answer } = harness(OFF_TASK);
    await failure(guardrail.check(drop({ issueId: ISSUE })));
    Object.assign(cards[0]!, { status: "rejected", resolvedByUserId: "owner-1" });
    advance(25 * 60 * 60 * 1000);
    // Even a model that would now let it through is not asked: only a person releases a held action.
    answer(PASS);
    const again = await failure(guardrail.check(drop({ issueId: ISSUE }))) as DataError;
    expect([again.code, again.details?.confirmationId, decided.length]).toEqual(["held", "card-2", 1]);
    expect(cards[1]!.request.payload.detailsMarkdown).toContain("was not asked again");
  });

  it("does not let the agent leave a held action behind by naming another of its tasks", async () => {
    const { guardrail, cards, decided } = harness(OFF_TASK);
    await failure(guardrail.check(drop({ issueId: ISSUE })));
    Object.assign(cards[0]!, { status: "rejected", resolvedByUserId: "owner-1" });
    const elsewhere = await failure(guardrail.check(drop({ issueId: ISSUE_2 }))) as DataError;
    expect([elsewhere.code, elsewhere.details?.confirmationId, cards[1]!.issueId, decided.length]).toEqual(["held", "card-2", ISSUE_2, 1]);
  });

  it("refuses a confirmation for a different action, task or agent", async () => {
    const { guardrail, cards } = harness(OFF_TASK);
    await failure(guardrail.check(drop({ issueId: ISSUE })));
    Object.assign(cards[0]!, { status: "accepted", resolvedByUserId: "owner-1" });
    const otherTable = drop({ issueId: ISSUE, confirmationId: "card-1" }, { table: "customers", params: { table: "customers" } });
    expect((await failure(guardrail.check(otherTable)) as DataError).code).toBe("invalid");
    const otherAgent = drop({ issueId: OTHER_ISSUE, confirmationId: "card-1" }, { actor: OTHER_AGENT });
    expect((await failure(guardrail.check(otherAgent)) as DataError).code).toBe("invalid");
    expect((await findHold(db.pool, C, "card-1"))!.consumedAt).toBeNull();
  });

  it("keeps on the hold the row count the person was shown", async () => {
    const { guardrail } = harness(OFF_TASK);
    await failure(guardrail.check(drop({ issueId: ISSUE })));
    expect(await findHold(db.pool, C, "card-1")).toMatchObject({ affectedRows: 1204, supersededBy: null });
    await failure(guardrail.check(drop({ issueId: ISSUE }, { operation: "rename_table", newName: "old_scratch", params: { table: "scratch", newName: "old_scratch" }, countRows: undefined })));
    expect(await findHold(db.pool, C, "card-2")).toMatchObject({ affectedRows: null });
  });

  it("asks the person again, without running it, when the action would now touch more rows than they allowed", async () => {
    const { guardrail, cards, decided } = harness(OFF_TASK);
    await failure(guardrail.check(drop({ issueId: ISSUE })));
    Object.assign(cards[0]!, { status: "accepted", resolvedByUserId: "owner-1" });
    const grown = drop({ issueId: ISSUE, confirmationId: "card-1" }, { countRows: async () => 1300 });
    const again = await failure(guardrail.check(grown)) as DataError;
    expect([again.code, again.details?.confirmationId, cards.length, decided.length]).toEqual(["held", "card-2", 2, 1]);
    expect(cards[1]!.request.payload.prompt).toBe("Agent Builder wants to drop table `scratch` (1,300 rows).");
    expect(cards[1]!.request.payload.detailsMarkdown).toContain("allowed this action when it would have touched 1,204 rows");
    expect(cards[1]!.request.resolverPolicy).toBe("human_only");
    expect(await findHold(db.pool, C, "card-1")).toMatchObject({ consumedAt: null, supersededBy: "card-2" });
    expect(await findHold(db.pool, C, "card-2")).toMatchObject({ affectedRows: 1300, consumedAt: null });
    // The old confirmation leads to the new card, by id or by a plain retry, and raises no third one.
    const stale = await failure(guardrail.check(grown)) as DataError;
    const plain = await failure(guardrail.check(drop({ issueId: ISSUE }, { countRows: async () => 1300 }))) as DataError;
    expect([stale.code, stale.details?.confirmationId, plain.code, plain.details?.confirmationId, cards.length]).toEqual(["held", "card-2", "held", "card-2", 2]);
    // Once the person allows the new count, the call runs once, whichever id it names.
    Object.assign(cards[1]!, { status: "accepted", resolvedByUserId: "owner-1" });
    expect(await failure(guardrail.check(grown))).toBe("resolved");
    expect((await findHold(db.pool, C, "card-2"))!.consumedAt).not.toBeNull();
    expect((await findHold(db.pool, C, "card-1"))!.consumedAt).toBeNull();
    expect(decided).toHaveLength(1);
  });

  it("runs an allowed action that now touches the same or fewer rows", async () => {
    const { guardrail, cards } = harness(OFF_TASK);
    await failure(guardrail.check(drop({ issueId: ISSUE })));
    Object.assign(cards[0]!, { status: "accepted", resolvedByUserId: "owner-1" });
    expect(await failure(guardrail.check(drop({ issueId: ISSUE }, { countRows: async () => 1100 })))).toBe("resolved");
    expect(cards).toHaveLength(1);
  });

  it("lets an allowed confirmation lapse after 24 hours", async () => {
    const { guardrail, cards, advance, decided } = harness(OFF_TASK);
    await failure(guardrail.check(drop({ issueId: ISSUE })));
    Object.assign(cards[0]!, { status: "accepted", resolvedByUserId: "owner-1" });
    advance(25 * 60 * 60 * 1000);
    const lapsed = await failure(guardrail.check(drop({ issueId: ISSUE, confirmationId: "card-1" }))) as DataError;
    expect(lapsed.code).toBe("conflict");
    expect(lapsed.message).toContain("expired");
    expect((await findHold(db.pool, C, "card-1"))!.consumedAt).toBeNull();
    // The lapsed hold never released the action, so the next call goes to a person, not the model.
    const next = await failure(guardrail.check(drop({ issueId: ISSUE }))) as DataError;
    expect([next.code, next.details?.confirmationId, decided.length]).toEqual(["held", "card-2", 1]);
  });
});
