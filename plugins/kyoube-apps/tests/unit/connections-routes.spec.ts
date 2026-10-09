import { describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { statusForError } from "../../src/api-routes.js";
import { CONNECTION_API_ROUTES, handleConnectionsApiRequest } from "../../src/connections/api-routes.js";
import type { ConnectionService } from "../../src/connections/service.js";
import { DataError } from "../../src/data/errors.js";
import manifest from "../../src/manifest.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";

function stub(fail?: Error) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const service = {
    list: async (...args: unknown[]) => {
      calls.push({ method: "list", args });
      return [{ name: "crm", baseUrl: "https://api.example.com", auth: "bearer", methods: "read-write", available: true, access: "read" }];
    },
    call: async (...args: unknown[]) => {
      calls.push({ method: "call", args });
      if (fail) throw fail;
      return { status: 200, headers: {}, body: "ok" };
    },
  } as unknown as ConnectionService;
  return { service, calls };
}

function request(overrides: Partial<PluginApiRequestInput>): PluginApiRequestInput {
  return { routeKey: "connections.call", method: "POST", path: "/connections/crm/call", params: { name: "crm" }, query: {}, body: { companyId: COMPANY }, actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1", runId: "run-1" }, companyId: COMPANY, headers: {}, ...overrides };
}

function keys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keys(v, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.push(k); keys(v, out); }
  return out;
}

describe("connection routes", () => {
  it("declares two board-or-agent routes, listed in the manifest", () => {
    expect(CONNECTION_API_ROUTES.map((r) => [r.routeKey, r.method, r.path, r.auth])).toEqual([
      ["connections.list", "GET", "/connections", "board-or-agent"],
      ["connections.call", "POST", "/connections/:name/call", "board-or-agent"],
    ]);
    expect(manifest.apiRoutes?.map((r) => r.routeKey)).toEqual(expect.arrayContaining(["connections.list", "connections.call"]));
  });

  it("leaves other routes alone", async () => {
    expect(await handleConnectionsApiRequest(stub().service, request({ routeKey: "tables.list" }))).toBeNull();
  });

  it("lists summaries with no secret anywhere", async () => {
    const { service } = stub();
    const res = await handleConnectionsApiRequest(service, request({ routeKey: "connections.list", method: "GET", path: "/connections", params: {} }));
    expect(res?.status).toBe(200);
    expect((res!.body as { connections: unknown[] }).connections).toHaveLength(1);
    expect(keys(res!.body).filter((k) => /secret/i.test(k))).toEqual([]);
  });

  it("calls as the request's actor, never one named in the body", async () => {
    const { service, calls } = stub();
    const res = await handleConnectionsApiRequest(service, request({ body: { companyId: COMPANY, method: "GET", path: "/x", query: { a: "1" }, issueId: "i1", actor: { kind: "system", id: "x" }, agentId: "other" } }));
    expect(res).toEqual({ status: 200, body: { status: 200, headers: {}, body: "ok" } });
    expect(calls[0]!.args).toEqual([COMPANY, { kind: "agent", id: "agent-1", runId: "run-1" }, "crm", { method: "GET", path: "/x", query: { a: "1" }, headers: undefined, body: undefined }, { kind: "direct" }, { issueId: "i1" }]);
  });

  it("maps a refusal through statusForError", async () => {
    for (const code of ["forbidden", "disabled", "held"] as const) {
      const error = new DataError(code, `${code} thing`);
      const res = await handleConnectionsApiRequest(stub(error).service, request({}));
      expect(res?.status).toBe(statusForError(error));
      expect(res?.body).toMatchObject({ code });
    }
    expect((await handleConnectionsApiRequest(stub(new DataError("forbidden", "no grant")).service, request({})))?.status).toBe(403);
  });

  it("rejects a malformed name with 400 before calling the service", async () => {
    const { service, calls } = stub();
    const res = await handleConnectionsApiRequest(service, request({ params: { name: "Bad Name!" } }));
    expect(res?.status).toBe(400);
    expect(res?.body).toMatchObject({ code: "invalid" });
    expect(calls).toEqual([]);
  });

  it("masks a raw error", async () => {
    const res = await handleConnectionsApiRequest(stub(new Error("pg secret")).service, request({}));
    expect(res).toEqual({ status: 500, body: { error: "error: internal error", code: "error" } });
  });

  it("refuses an actor with no id", async () => {
    const res = await handleConnectionsApiRequest(stub().service, request({ actor: { actorType: "agent", actorId: "" } }));
    expect(res?.status).toBe(403);
  });
});
