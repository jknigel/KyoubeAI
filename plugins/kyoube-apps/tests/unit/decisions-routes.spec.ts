// tests/unit/decisions-routes.spec.ts
import { describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { DataError } from "../../src/data/errors.js";
import { DECISION_API_ROUTES, handleDecisionsApiRequest } from "../../src/decisions/api-routes.js";
import type { DecisionService } from "../../src/decisions/service.js";
import { decisionToolDeclarations } from "../../src/decisions/tools.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const refund = { type: "check", statement: "Asks for a refund." };

function stub(fail?: Error) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const service = new Proxy({}, {
    get: (_t, method: string) => method === "then" ? undefined : async (...args: unknown[]) => {
      calls.push({ method, args });
      if (fail) throw fail;
      return { method };
    },
  }) as unknown as DecisionService;
  return { service, calls };
}

function request(overrides: Partial<PluginApiRequestInput>): PluginApiRequestInput {
  return { routeKey: "decisions.decide", method: "POST", path: "/decisions/decide", params: {}, query: {}, body: {}, actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1", runId: "run-1" }, companyId: COMPANY, headers: {}, ...overrides };
}

describe("decision routes", () => {
  it("declares two board-or-agent routes", () => {
    expect(DECISION_API_ROUTES.map((route) => [route.routeKey, route.method, route.path, route.auth])).toEqual([
      ["decisions.decide", "POST", "/decisions/decide", "board-or-agent"],
      ["decisions.status", "GET", "/decisions/status", "board-or-agent"],
    ]);
  });

  it("leaves other routes alone", async () => {
    expect(await handleDecisionsApiRequest(stub().service, request({ routeKey: "tables.list" }))).toBeNull();
  });

  it("decides free-form state for the agents use, as the calling agent", async () => {
    const { service, calls } = stub();
    const response = await handleDecisionsApiRequest(service, request({ body: { companyId: COMPANY, state: "Refund please", questions: { refund } } }));
    expect(response).toEqual({ status: 200, body: { method: "decide" } });
    expect(calls[0]).toEqual({ method: "decide", args: [COMPANY, { kind: "agent", id: "agent-1", runId: "run-1" }, "agents", { state: "Refund please", questions: { refund } }, { includeProbabilities: false }] });
  });

  it("decides rows", async () => {
    const { service, calls } = stub();
    await handleDecisionsApiRequest(service, request({ body: { companyId: COMPANY, rows: { table: "tickets", ids: ["a"] }, questions: { refund }, includeProbabilities: true } }));
    expect(calls[0]!.method).toBe("decideRows");
    expect(calls[0]!.args.slice(2)).toEqual(["agents", { table: "tickets", ids: ["a"] }, { refund }, { includeProbabilities: true }]);
  });

  it("needs exactly one of state and rows", async () => {
    const { service, calls } = stub();
    expect((await handleDecisionsApiRequest(service, request({ body: { companyId: COMPANY, questions: { refund } } })))!.status).toBe(400);
    expect((await handleDecisionsApiRequest(service, request({ body: { companyId: COMPANY, state: "x", rows: { table: "t", ids: ["a"] }, questions: { refund } } })))!.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("reports status for the agents use", async () => {
    const { service, calls } = stub();
    await handleDecisionsApiRequest(service, request({ routeKey: "decisions.status", method: "GET", path: "/decisions/status", body: undefined }));
    expect(calls[0]!.method).toBe("status");
    expect(calls[0]!.args[2]).toBe("agents");
  });

  it("maps decision errors and hides internal ones", async () => {
    const budget = await handleDecisionsApiRequest(stub(new DataError("budget_exceeded", "cap reached")).service, request({ body: { companyId: COMPANY, state: "x", questions: { refund } } }));
    expect(budget).toEqual({ status: 429, body: { error: "budget_exceeded: cap reached", code: "budget_exceeded" } });
    const logs: string[] = [];
    const boom = await handleDecisionsApiRequest(stub(new Error("socket hang up")).service, request({ body: { companyId: COMPANY, state: "x", questions: { refund } } }), (message) => void logs.push(message));
    expect(boom).toEqual({ status: 500, body: { error: "error: internal error", code: "error" } });
    expect(logs).toEqual(["decisions request failed"]);
  });

  it("refuses an unauthenticated caller", async () => {
    const response = await handleDecisionsApiRequest(stub().service, request({ actor: { actorType: "agent", actorId: "" } }));
    expect(response!.status).toBe(403);
  });
});

describe("decision tools", () => {
  it("declares decisions_decide and decisions_status with JSON schemas", () => {
    const tools = decisionToolDeclarations();
    expect(tools.map((tool) => tool.name)).toEqual(["decisions_decide", "decisions_status"]);
    expect(JSON.stringify(tools[0]!.parametersSchema)).toContain("questions");
  });
});
