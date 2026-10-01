import { describe, expect, it } from "vitest";
import { GOVERNED_KINDS, planGovernance, revertGovernance } from "../src/agent-rules/governance.js";

const PEOPLE = { defaultPolicy: "human_only", cap: "human_only" };

describe("planGovernance", () => {
  it("makes all five card kinds people-only and records that they had no entry", () => {
    const plan = planGovernance({});
    expect(plan.changed).toBe(true);
    for (const kind of GOVERNED_KINDS) expect(plan.next[kind]).toEqual(PEOPLE);
    expect(plan.previous).toEqual(Object.fromEntries(GOVERNED_KINDS.map((kind) => [kind, null])));
  });

  it("keeps other keys of an entry, and kinds it does not govern", () => {
    const plan = planGovernance({ request_confirmation: { cap: "anyone" }, connection_intent: { cap: "human_only" } });
    expect(plan.next.request_confirmation).toEqual(PEOPLE);
    expect(plan.next.connection_intent).toEqual({ cap: "human_only" });
    expect(plan.previous.request_confirmation).toEqual({ cap: "anyone" });
  });

  it("changes nothing once every kind is people-only", () => {
    const plan = planGovernance(planGovernance(null).next);
    expect(plan).toEqual({ next: plan.next, changed: false, previous: {} });
  });
});

describe("revertGovernance", () => {
  it("puts back what each recorded kind held", () => {
    const first = planGovernance({ request_confirmation: { cap: "anyone" } });
    const { next } = revertGovernance(first.next, first.previous);
    expect(next).toEqual({ request_confirmation: { cap: "anyone" } });
  });

  it("leaves a kind that was already people-only before KyoubeAI", () => {
    const first = planGovernance({ suggest_tasks: PEOPLE });
    expect(first.previous).not.toHaveProperty("suggest_tasks");
    expect(revertGovernance(first.next, first.previous).next.suggest_tasks).toEqual(PEOPLE);
  });

  it("without a record, removes only entries that are exactly what KyoubeAI writes", () => {
    const current = { ...planGovernance(null).next, ask_user_questions: { defaultPolicy: "human_only", cap: "human_only", note: "mine" } };
    const { next, changed } = revertGovernance(current, undefined);
    expect(changed).toBe(true);
    expect(next).toEqual({ ask_user_questions: { defaultPolicy: "human_only", cap: "human_only", note: "mine" } });
  });
});
