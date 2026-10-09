import { describe, expect, it, vi } from "vitest";
import { GROUP_API_ROUTES, handleGroupsApiRequest } from "../../src/groups/api-routes.js";

const C = "88888888-8888-4888-8888-888888888888";
const service = {
  agentAccess: vi.fn(async () => [{ agentId: "a1", allowedUserIds: ["u1"] }]),
  recordSync: vi.fn(async () => {}),
};
const hosts = { listUserIds: async () => new Set(["u1"]), listAgentIds: async () => new Set(["a1"]) };
const input = (routeKey: string, actorType: string, body?: unknown) => ({ routeKey, companyId: C, actor: { actorType, actorId: "x" }, params: {}, query: {}, body }) as never;

describe("groups board routes", () => {
  it("declares both routes board-only", () => {
    expect(GROUP_API_ROUTES.map((r) => [r.routeKey, r.auth])).toEqual([["groups.agent_access", "board"], ["groups.sync_report", "board"]]);
  });
  it("ignores routes it does not own", async () => {
    expect(await handleGroupsApiRequest(service as never, input("apps.list", "user"), hosts)).toBeNull();
  });
  it("refuses an agent even if a route were mis-declared", async () => {
    expect((await handleGroupsApiRequest(service as never, input("groups.agent_access", "agent"), hosts))?.status).toBe(403);
  });
  it("prunes against live members and agents, then lists", async () => {
    const res = await handleGroupsApiRequest(service as never, input("groups.agent_access", "user"), hosts);
    expect(res).toEqual({ status: 200, body: { agents: [{ agentId: "a1", allowedUserIds: ["u1"] }] } });
    expect(service.agentAccess).toHaveBeenCalledWith(C, { userIds: new Set(["u1"]), agentIds: new Set(["a1"]) });
  });
  it("records a sync report and rejects a malformed one", async () => {
    expect(await handleGroupsApiRequest(service as never, input("groups.sync_report", "user", { companyId: C, syncedAt: "2026-10-09T10:00:00.000Z", error: null }), hosts)).toEqual({ status: 200, body: { ok: true } });
    expect((await handleGroupsApiRequest(service as never, input("groups.sync_report", "user", { companyId: C, syncedAt: 5 }), hosts))?.status).toBe(400);
  });
  it("surfaces a host failure as a 500, never an empty set", async () => {
    const failing = { ...hosts, listUserIds: async () => { throw new Error("boom"); } };
    expect((await handleGroupsApiRequest(service as never, input("groups.agent_access", "user"), failing))?.status).toBe(500);
  });
});
