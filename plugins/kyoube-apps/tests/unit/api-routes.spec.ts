import { describe, expect, it, vi } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { API_ROUTES, actorFromRequest, handleApiRequest, statusForError } from "../../src/api-routes.js";
import { DataError } from "../../src/data/errors.js";
import { createStubService } from "../stub-service.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";

function request(routeKey: string, overrides: Partial<PluginApiRequestInput> = {}): PluginApiRequestInput {
  // `routeKey` is deliberately untyped (a bare string) so tests can probe an
  // unknown key such as "nope"; fall back to a placeholder method/path in
  // that case instead of throwing, since `handleApiRequest` dispatches on
  // `routeKey` alone and never consults these for an unrecognized route.
  const route = API_ROUTES.find((entry) => entry.routeKey === routeKey);
  return { routeKey, method: route?.method ?? "GET", path: route?.path ?? "/", params: {}, query: {}, body: undefined, actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1", runId: "run-1" }, companyId: COMPANY, headers: {}, ...overrides };
}

describe("API_ROUTES", () => {
  it("declares GET routes with query company resolution and POST routes with body resolution", () => {
    expect(API_ROUTES.map((route) => route.routeKey)).toContain("rows.query");
    for (const route of API_ROUTES) {
      // Every data route serves boards and agent runs alike; only the skill
      // import is board-only (it is `kyoube ensure-plugins`' door, never an agent's).
      expect(route.auth, route.routeKey).toBe(route.routeKey === "skills.install" ? "board" : "board-or-agent");
      expect(route.capability).toBe("api.routes.register");
      expect(route.companyResolution).toEqual(route.method === "GET" ? { from: "query", key: "companyId" } : { from: "body", key: "companyId" });
    }
  });
});

describe("handleApiRequest", () => {
  it("maps actors and dispatches to the service", async () => {
    expect(actorFromRequest(request("tables.list"))).toEqual({ kind: "agent", id: "agent-1", runId: "run-1" });
    expect(actorFromRequest(request("tables.list", { actor: { actorType: "user", actorId: "u1", userId: "u1" } }))).toEqual({ kind: "user", id: "u1", runId: null });
    const { service, calls } = createStubService();
    const listed = await handleApiRequest(service, request("tables.list"));
    expect(listed.status).toBe(200);
    expect(calls[0]).toEqual({ method: "listTables", args: [COMPANY, { kind: "agent", id: "agent-1", runId: "run-1" }] });
    await handleApiRequest(service, request("rows.query", { params: { table: "deals" }, body: { companyId: COMPANY, where: { field: "stage", op: "eq", value: "won" }, limit: 5 } }));
    expect(calls[1]).toEqual({ method: "query", args: [COMPANY, { kind: "agent", id: "agent-1", runId: "run-1" }, "deals", { where: { field: "stage", op: "eq", value: "won" }, orderBy: undefined, limit: 5, offset: undefined, fields: undefined }] });
    await handleApiRequest(service, request("fields.update", { params: { table: "deals", field: "stage" }, body: { companyId: COMPANY, choices: ["a"] } }));
    expect(calls[2]).toEqual({ method: "updateField", args: [COMPANY, expect.anything(), "deals", "stage", { displayName: undefined, description: undefined, required: undefined, choices: ["a"] }] });
    const count = await handleApiRequest(service, request("rows.count", { params: { table: "deals" }, body: { companyId: COMPANY } }));
    expect(count.body).toEqual({ count: 3 });
  });

  it("returns 400 for invalid bodies, maps DataError codes, and 404 for unknown route keys", async () => {
    const { service } = createStubService();
    expect((await handleApiRequest(service, request("rows.insert", { params: { table: "deals" }, body: { companyId: COMPANY } }))).status).toBe(400);
    expect((await handleApiRequest(service, request("nope"))).status).toBe(404);
    const denied = createStubService(new DataError("forbidden", "no"));
    const response = await handleApiRequest(denied.service, request("tables.list"));
    expect(response).toEqual({ status: 403, body: { error: "forbidden: no", code: "forbidden" } });
    expect(statusForError(new DataError("limit", "x"))).toBe(413);
    expect(statusForError(new Error("boom"))).toBe(500);
  });

  // Ruling P2-R23: an actor with no id (empty or missing `actorId`) must never
  // reach the service — `handleApiRequest` refuses with 403 before dispatch,
  // rather than letting a hollow actor flow into `DataService`.
  it("returns 403 forbidden for an unauthenticated actor without dispatching to the service", async () => {
    const { service, calls } = createStubService();
    const emptyActorId = await handleApiRequest(service, request("tables.list", { actor: { actorType: "agent", actorId: "", agentId: "agent-1", runId: "run-1" } }));
    expect(emptyActorId).toEqual({ status: 403, body: { error: "forbidden: unauthenticated", code: "forbidden" } });
    const missingActorId = await handleApiRequest(service, request("access.me", { actor: { actorType: "user", actorId: undefined as unknown as string, userId: "u1" } }));
    expect(missingActorId).toEqual({ status: 403, body: { error: "forbidden: unauthenticated", code: "forbidden" } });
    expect(calls).toHaveLength(0);
  });

  // Ruling P2-R24: a non-DataError failure must never leak the raw JS/driver
  // error text to the caller; the optional `log` callback still gets the
  // real error for operators, and never the request body.
  it("returns a generic 500 for a non-DataError failure and logs the real one", async () => {
    const failing = createStubService(new Error("boom"));
    const log = vi.fn();
    const response = await handleApiRequest(failing.service, request("tables.list"), log);
    expect(response).toEqual({ status: 500, body: { error: "error: internal error", code: "error" } });
    expect(log).toHaveBeenCalledTimes(1);
    const [message, meta] = log.mock.calls[0]!;
    expect(typeof message).toBe("string");
    expect(meta).toMatchObject({ routeKey: "tables.list", companyId: COMPANY });
    expect(String(meta?.error)).toContain("boom");
    expect(meta).not.toHaveProperty("body");
  });
});
