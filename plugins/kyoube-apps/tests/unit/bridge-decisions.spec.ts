import type { KyoubeRequest } from "@kyoube/app-sdk";
import { describe, expect, it } from "vitest";
import { APP_BUDGET, appErrorPayload, createAppGuard, handleAppMessage, routeAppRequest, type AppBridgeCallbacks } from "../../src/ui/apps/bridge.js";

const NONCE = "TESTnonce_0123456789-x";

function request(method: string, params: Record<string, unknown>, id = "1"): KyoubeRequest {
  return { kyoube: 1, id, method, params, nonce: NONCE } as unknown as KyoubeRequest;
}

function frame(overrides: Partial<AppBridgeCallbacks> = {}) {
  const posted: Array<Record<string, unknown>> = [];
  const target = { postMessage: (message: unknown) => { posted.push(message as Record<string, unknown>); } };
  const decided: Array<[string, Record<string, unknown>]> = [];
  const outcomes: unknown[][] = [];
  const guard = createAppGuard(NONCE, { onStop: () => {}, now: () => 1_000 });
  const callbacks: AppBridgeCallbacks = {
    context: () => ({}),
    onData: async () => ({ rows: [] }),
    onToast: () => {},
    onOpenApp: () => {},
    onDecide: async (set, input) => { decided.push([set, input]); return { decisionId: "d1", answers: {} }; },
    onDecisionOutcome: async (...args) => { outcomes.push(args); return { outcome: "human_confirmed" }; },
    isLive: () => true,
    guard,
    ...overrides,
  };
  const send = (data: unknown) => handleAppMessage({ source: target, data }, target, callbacks);
  return { posted, decided, outcomes, send };
}

describe("routing typed decisions", () => {
  it("routes decide and outcome requests", () => {
    expect(routeAppRequest(request("decisions.decide", { set: "triage", input: { rowId: "r1" } }))).toEqual({ kind: "decide", set: "triage", input: { rowId: "r1" } });
    expect(routeAppRequest(request("decisions.outcome", { decisionId: "d1", question: "urgent", value: "billing" }))).toEqual({ kind: "outcome", decisionId: "d1", question: "urgent", value: "billing" });
  });
  it("rejects a bad set name, a missing input, and an outcome value that is not a string or boolean", () => {
    expect(routeAppRequest(request("decisions.decide", { set: "Triage!", input: {} }))).toMatchObject({ kind: "reject", code: "invalid" });
    expect(routeAppRequest(request("decisions.decide", { set: "triage", input: "free text" }))).toMatchObject({ kind: "reject", code: "invalid" });
    expect(routeAppRequest(request("decisions.outcome", { decisionId: "d1", question: "urgent", value: { x: 1 } }))).toMatchObject({ kind: "reject", code: "invalid" });
  });
});

describe("handleAppMessage and typed decisions", () => {
  it("forwards a decision and replies with its result", async () => {
    const { send, posted, decided } = frame();
    await send(request("decisions.decide", { set: "triage", input: { values: { subject: "x" } } }, "7"));
    expect(decided).toEqual([["triage", { values: { subject: "x" } }]]);
    expect(posted.at(-1)).toMatchObject({ id: "7", result: { decisionId: "d1" } });
  });

  it("allows ten decisions per window and refuses the eleventh with limit, data calls unaffected", async () => {
    expect(APP_BUDGET.decisions).toBe(10);
    const { send, posted, decided } = frame();
    for (let i = 0; i < 11; i += 1) await send(request("decisions.decide", { set: "triage", input: { rowId: "r" } }, `d${i}`));
    expect(decided).toHaveLength(10);
    expect(posted.at(-1)).toEqual({ kyoube: 1, id: "d10", error: { code: "limit", message: "limit: too many decisions" } });
    await send(request("data.query", { table: "contacts" }, "q1"));
    expect(posted.at(-1)).toMatchObject({ id: "q1", result: { rows: [] } });
  });

  it("charges outcomes to the request budget only", async () => {
    const { send, outcomes } = frame();
    for (let i = 0; i < 12; i += 1) await send(request("decisions.outcome", { decisionId: "d1", question: "urgent", value: true }, `o${i}`));
    expect(outcomes).toHaveLength(12);
  });

  it("answers disabled when the runner has no decision callbacks", async () => {
    const { send, posted } = frame({ onDecide: undefined, onDecisionOutcome: undefined });
    await send(request("decisions.decide", { set: "triage", input: { rowId: "r" } }, "x"));
    expect(posted.at(-1)).toMatchObject({ id: "x", error: { code: "disabled" } });
  });

  it("shows the app the decision error codes the worker throws", () => {
    for (const code of ["disabled", "budget_exceeded", "too_large", "provider_rejected", "provider_unavailable", "timeout"]) {
      expect(appErrorPayload({ code: "WORKER_ERROR", message: `${code}: something` }).code).toBe(code);
    }
  });

  it("shows the app the guardrail's error codes too", () => {
    for (const code of ["held", "rejected_by_person", "guardrail_context_required"]) {
      expect(appErrorPayload({ code: "WORKER_ERROR", message: `${code}: something` }).code).toBe(code);
    }
    // A code named later in the message never wins over the one it starts with.
    expect(appErrorPayload({ code: "WORKER_ERROR", message: "forbidden: the confirmation was not answered by a person, so the action stays held" }).code).toBe("forbidden");
  });
});
