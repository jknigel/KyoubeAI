import { beforeEach, describe, expect, it, vi } from "vitest";
import { GROUP_API_ROUTES, handleGroupsApiRequest, keptMemberIds } from "../../src/groups/api-routes.js";

const C = "88888888-8888-4888-8888-888888888888";
const service = {
  agentAccess: vi.fn(async () => [{ agentId: "a1", allowedUserIds: ["u1"] }]),
  recordSync: vi.fn(async () => {}),
};
const ROLES: Record<string, string> = { owner: "owner", admin: "Admin", operator: "operator", viewer: "viewer" };
const hosts = {
  listUserIds: vi.fn(async () => new Set(["u1"])),
  listAgentIds: vi.fn(async () => new Set(["a1"])),
  resolveRoleFresh: vi.fn(async (_c: string, userId: string) => ROLES[userId] ?? null),
};
const input = (routeKey: string, actorType: string, body?: unknown, actorId = "owner") =>
  ({ routeKey, companyId: C, actor: { actorType, actorId, userId: actorType === "user" ? actorId : null }, params: {}, query: {}, body }) as never;
const report = { companyId: C, syncedAt: "2026-10-09T10:00:00.000Z", error: null };
const FORBIDDEN = { status: 403, body: { error: "forbidden: company owner or admin required", code: "forbidden" } };

beforeEach(() => vi.clearAllMocks());

describe("groups board routes", () => {
  it("declares both routes board-only", () => {
    expect(GROUP_API_ROUTES.map((r) => [r.routeKey, r.auth])).toEqual([["groups.agent_access", "board"], ["groups.sync_report", "board"]]);
  });
  it("ignores routes it does not own", async () => {
    expect(await handleGroupsApiRequest(service as never, input("apps.list", "user"), hosts)).toBeNull();
  });
  it("refuses an agent even if a route were mis-declared", async () => {
    expect((await handleGroupsApiRequest(service as never, input("groups.agent_access", "agent"), hosts))?.status).toBe(403);
    expect(hosts.resolveRoleFresh).not.toHaveBeenCalled();
  });
  it("prunes against live members and agents, then lists", async () => {
    const res = await handleGroupsApiRequest(service as never, input("groups.agent_access", "user"), hosts);
    expect(res).toEqual({ status: 200, body: { agents: [{ agentId: "a1", allowedUserIds: ["u1"] }] } });
    expect(service.agentAccess).toHaveBeenCalledWith(C, { userIds: new Set(["u1"]), agentIds: new Set(["a1"]) });
  });
  it("records a sync report and rejects a malformed one", async () => {
    expect(await handleGroupsApiRequest(service as never, input("groups.sync_report", "user", report), hosts)).toEqual({ status: 200, body: { ok: true } });
    expect((await handleGroupsApiRequest(service as never, input("groups.sync_report", "user", { companyId: C, syncedAt: 5 }), hosts))?.status).toBe(400);
  });
  it("surfaces a host failure as a 500, never an empty set", async () => {
    const failing = { ...hosts, listUserIds: async () => { throw new Error("boom"); } };
    expect((await handleGroupsApiRequest(service as never, input("groups.agent_access", "user"), failing))?.status).toBe(500);
  });
});

// Ruling R14: suspended and pending members keep their groups; archived and absent ones are pruned.
describe("keptMemberIds", () => {
  it("lists archived members too, and keeps every user who is not archived", async () => {
    const list = vi.fn(async () => [
      { principalType: "user", principalId: "active", status: "active" },
      { principalType: "user", principalId: "suspended", status: "suspended" },
      { principalType: "user", principalId: "pending", status: "pending" },
      { principalType: "user", principalId: "archived", status: "archived" },
      { principalType: "agent", principalId: "agent-1", status: "active" },
    ]);
    expect(await keptMemberIds({ list }, C)).toEqual(new Set(["active", "suspended", "pending"]));
    expect(list).toHaveBeenCalledWith({ companyId: C, includeArchived: true });
  });
});

// Ruling R13: "board" admits every signed-in person; these routes need an owner or admin.
describe("groups board routes: owner or admin only", () => {
  for (const who of ["operator", "viewer", "stranger"]) {
    it(`refuses ${who === "stranger" ? "a non-member" : `an ${who}`} on the agent-access read, reading nothing`, async () => {
      expect(await handleGroupsApiRequest(service as never, input("groups.agent_access", "user", undefined, who), hosts)).toEqual(FORBIDDEN);
      expect(hosts.resolveRoleFresh).toHaveBeenCalledWith(C, who);
      expect(hosts.listUserIds).not.toHaveBeenCalled();
      expect(hosts.listAgentIds).not.toHaveBeenCalled();
      expect(service.agentAccess).not.toHaveBeenCalled();
    });
    it(`refuses ${who === "stranger" ? "a non-member" : `an ${who}`} on the sync report, recording nothing`, async () => {
      expect(await handleGroupsApiRequest(service as never, input("groups.sync_report", "user", report, who), hosts)).toEqual(FORBIDDEN);
      expect(service.recordSync).not.toHaveBeenCalled();
    });
  }
  for (const who of ["owner", "admin"]) {
    it(`lets an ${who} read agent access and record a sync (role compared case-insensitively)`, async () => {
      expect((await handleGroupsApiRequest(service as never, input("groups.agent_access", "user", undefined, who), hosts))?.status).toBe(200);
      expect((await handleGroupsApiRequest(service as never, input("groups.sync_report", "user", report, who), hosts))?.status).toBe(200);
      expect(service.recordSync).toHaveBeenCalledTimes(1);
    });
  }
  it("answers 500, doing nothing, when the role cannot be read", async () => {
    const failing = { ...hosts, resolveRoleFresh: async () => { throw new Error("host down"); } };
    expect((await handleGroupsApiRequest(service as never, input("groups.sync_report", "user", report), failing))?.status).toBe(500);
    expect(service.recordSync).not.toHaveBeenCalled();
  });
});
