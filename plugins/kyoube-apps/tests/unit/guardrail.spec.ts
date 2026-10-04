// tests/unit/guardrail.spec.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseQuestions, type DecideResult } from "../../src/decisions/contract.js";
import {
  actionFingerprint, confirmationPayload, describeAction, GUARD_QUESTIONS, guardFrom, guardPasses, guardState,
  isBulkTarget, MAX_TASK_TEXT, rowTargetParams, type GuardedAction,
} from "../../src/decisions/guardrail.js";

const AGENT = { kind: "agent" as const, id: "agent-1", runId: "run-1" };
const C = "11111111-1111-4111-8111-111111111111";
const ID = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;

function action(overrides: Partial<GuardedAction> = {}): GuardedAction {
  return { companyId: C, actor: AGENT, operation: "drop_table", table: "tickets", params: { table: "tickets" }, ...overrides };
}

function result(matches: boolean, matchesStatus: "auto" | "review", risk: string, riskStatus: "auto" | "review"): DecideResult {
  return {
    decisionId: "d-1",
    model: "jev-1.13.0",
    answers: {
      matches_task: { type: "check", value: matches, confidence: 0.96, status: matchesStatus },
      risk: { type: "score", value: risk, confidence: 0.91, status: riskStatus },
    },
  };
}

describe("isBulkTarget", () => {
  it("covers a where filter or more than 20 ids, and nothing smaller", () => {
    expect(isBulkTarget({ ids: Array.from({ length: 20 }, (_, i) => ID(i)) })).toBe(false);
    expect(isBulkTarget({ ids: Array.from({ length: 21 }, (_, i) => ID(i)) })).toBe(true);
    expect(isBulkTarget({ where: { field: "stage", op: "eq", value: "lead" } })).toBe(true);
    expect(isBulkTarget({ where: {} })).toBe(false);
    expect(isBulkTarget({})).toBe(false);
  });
});

describe("actionFingerprint", () => {
  it("is the same for the same call, whatever the id order or key order", () => {
    const a = actionFingerprint({ operation: "delete", params: rowTargetParams("tickets", { ids: [ID(2), ID(1), ID(2)] }) });
    const b = actionFingerprint({ operation: "delete", params: { where: null, ids: [ID(1), ID(2)], table: "tickets" } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("changes with the operation, the target or the patch", () => {
    const base = actionFingerprint({ operation: "update", params: { ...rowTargetParams("tickets", { where: { field: "x", op: "eq", value: 1 } }), patch: { status: "closed" } } });
    expect(actionFingerprint({ operation: "update", params: { ...rowTargetParams("tickets", { where: { field: "x", op: "eq", value: 1 } }), patch: { status: "open" } } })).not.toBe(base);
    expect(actionFingerprint({ operation: "update", params: { ...rowTargetParams("tickets", { where: { field: "x", op: "eq", value: 2 } }), patch: { status: "closed" } } })).not.toBe(base);
    expect(actionFingerprint({ operation: "drop_table", params: { table: "tickets" } })).not.toBe(actionFingerprint({ operation: "drop_table", params: { table: "contacts" } }));
  });
});

describe("describeAction", () => {
  it("names the operation, the names and the count, never values", () => {
    expect(describeAction(action(), 1204)).toBe("drop table `tickets` (1,204 rows)");
    expect(describeAction(action(), null)).toBe("drop table `tickets`");
    expect(describeAction(action({ operation: "remove_field", field: "email", params: {} }), null)).toBe("remove field `email` from table `tickets`");
    expect(describeAction(action({ operation: "rename_table", newName: "old_tickets", params: {} }), null)).toBe("rename table `tickets` to `old_tickets`");
    expect(describeAction(action({ operation: "delete", params: {} }), 1)).toBe("delete 1 row from table `tickets`");
    expect(describeAction(action({ operation: "update", params: {} }), null)).toBe("update rows in table `tickets`");
    expect(describeAction(action({ operation: "app_publish", table: null, app: "crm", version: null, params: {} }), null)).toBe("publish app `crm` (latest version)");
    expect(describeAction(action({ operation: "app_publish", table: null, app: "crm", version: 3, params: {} }), null)).toBe("publish app `crm` version 3");
    expect(describeAction(action({ operation: "app_archive", table: null, app: "crm", params: {} }), null)).toBe("archive app `crm`");
    expect(describeAction(action({ operation: "app_rollback", table: null, app: "crm", version: 2, params: {} }), null)).toBe("roll app `crm` back to version 2");
  });
});

describe("guardState", () => {
  it("sends the action's names and count plus the task text, and nothing from params", () => {
    const update = action({ operation: "update", params: { table: "tickets", ids: null, where: { field: "owner", op: "eq", value: "Ada Lovelace" }, patch: { notes: "secret customer note" } } });
    const state = guardState(update, 31, { title: "Close stale tickets", description: "Close tickets older than 90 days." });
    expect(state).toEqual({ action: { operation: "update rows", table: "tickets", affectedRows: 31 }, task: "Close stale tickets\n\nClose tickets older than 90 days." });
    expect(JSON.stringify(state)).not.toContain("secret customer note");
    expect(JSON.stringify(state)).not.toContain("Ada Lovelace");
  });
  it("cuts the task text to 8,000 characters and copes with no description", () => {
    const long = guardState(action(), null, { title: "T", description: "x".repeat(20_000) });
    expect((long.task as string).length).toBe(MAX_TASK_TEXT);
    expect(guardState(action(), null, { title: "Only a title", description: null }).task).toBe("Only a title");
  });
});

describe("GUARD_QUESTIONS and guardPasses", () => {
  it("are valid questions", () => {
    expect(parseQuestions(GUARD_QUESTIONS)).toEqual(GUARD_QUESTIONS);
  });
  it("are the questions the real-model check screens with", () => {
    // scripts/decisions-eval.mjs measures the guardrail on its `screening` suite; a change to the
    // questions here has to be measured there too.
    const fixtures = JSON.parse(readFileSync(new URL("../../../../scripts/decisions-eval.fixtures.json", import.meta.url), "utf8")) as { suites: Record<string, { questions: unknown }> };
    expect(fixtures.suites.screening!.questions).toEqual(GUARD_QUESTIONS);
  });
  it("passes only when both answers are auto, the action matches the task and the risk is not dangerous", () => {
    expect(guardPasses(result(true, "auto", "routine", "auto"))).toBe(true);
    expect(guardPasses(result(true, "auto", "notable", "auto"))).toBe(true);
    expect(guardPasses(result(true, "auto", "dangerous", "auto"))).toBe(false);
    expect(guardPasses(result(false, "auto", "routine", "auto"))).toBe(false);
    expect(guardPasses(result(true, "review", "routine", "auto"))).toBe(false);
    expect(guardPasses(result(true, "auto", "routine", "review"))).toBe(false);
    expect(guardPasses({ decisionId: null, model: "m", answers: {} })).toBe(false);
  });
  it("passes only the two known safe risk levels, nothing else the model could return", () => {
    expect(guardPasses(result(true, "auto", "unsure", "auto"))).toBe(false);
    expect(guardPasses(result(true, "auto", "Routine", "auto"))).toBe(false);
    expect(guardPasses(result(true, "auto", "", "auto"))).toBe(false);
  });
});

describe("confirmationPayload", () => {
  it("names the agent and the action and shows the check's answers", () => {
    const payload = confirmationPayload("Builder", action(), 1204, { result: result(false, "auto", "dangerous", "auto") });
    expect(payload).toMatchObject({ version: 1, prompt: "Agent Builder wants to drop table `tickets` (1,204 rows).", acceptLabel: "Allow once", rejectLabel: "Don't allow" });
    expect(payload.detailsMarkdown).toContain("- Part of the task: no (96% sure)");
    expect(payload.detailsMarkdown).toContain("- Risk: dangerous (91% sure)");
    expect(payload.detailsMarkdown).toContain("exactly this call one time");
  });
  it("says when the model was not asked because a person has to release an earlier hold", () => {
    const payload = confirmationPayload("Builder", action(), null, { heldBefore: true });
    expect(payload.prompt).toBe("Agent Builder wants to drop table `tickets`.");
    expect(payload.detailsMarkdown).toContain("held this exact action before and no person allowed it");
  });
  it("says when the check could not run", () => {
    const payload = confirmationPayload("agent-1", action(), null, { failure: "provider_unavailable" });
    expect(payload.detailsMarkdown).toContain("could not run (provider_unavailable)");
  });
  it("asks again with the new count when an allowed action grew", () => {
    const payload = confirmationPayload("Builder", action({ operation: "delete", params: { table: "tickets", ids: null, where: {} } }), 5, { grown: { allowed: 3 } });
    expect(payload.prompt).toBe("Agent Builder wants to delete 5 rows from table `tickets`.");
    expect(payload.detailsMarkdown).toContain("A person allowed this action when it would have touched 3 rows. It would now touch 5 rows, so it did not run");
  });
});

describe("guardFrom", () => {
  it("keeps only issueId and confirmationId", () => {
    expect(guardFrom({ companyId: C, issueId: "i-1", confirmationId: "card-1", table: "x" })).toEqual({ issueId: "i-1", confirmationId: "card-1" });
    expect(guardFrom({ issueId: "i-1" })).toEqual({ issueId: "i-1" });
  });
  it("is undefined when the call carries neither id, so callers pass no guard at all", () => {
    expect(guardFrom(undefined)).toBeUndefined();
    expect(guardFrom({ companyId: C, table: "x" })).toBeUndefined();
  });
  it("refuses values that are not strings", () => {
    expect(() => guardFrom({ issueId: 42 })).toThrow(/issueId and confirmationId must be strings/);
  });
});
