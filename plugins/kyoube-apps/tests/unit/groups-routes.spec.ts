import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FORBIDDEN_MESSAGE, GROUP_API_ROUTES, handleGroupsApiRequest, keptMemberIds } from "../../src/groups/api-routes.js";
import { rulesTokenMatches } from "../../src/groups/rules-token.js";

const C = "88888888-8888-4888-8888-888888888888";
/** The kyoube CLI's rules token (ruling R18), in a temporary file. */
const TOKEN = "cd".repeat(32);
const TOKEN_DIR = mkdtempSync(path.join(os.tmpdir(), "kyoube-apps-rules-token-"));
const TOKEN_PATH = path.join(TOKEN_DIR, "rules-token");
writeFileSync(TOKEN_PATH, `${TOKEN}\n`, { mode: 0o600 });
let tokenPath = TOKEN_PATH;

const service = {
  agentAccess: vi.fn(async () => [{ agentId: "a1", allowedUserIds: ["u1"] }]),
  recordSync: vi.fn(async () => {}),
};
const ROLES: Record<string, string> = { owner: "owner", admin: "Admin", operator: "operator", viewer: "viewer" };
const hosts = {
  listUserIds: vi.fn(async () => new Set(["u1"])),
  listAgentIds: vi.fn(async () => new Set(["a1"])),
  resolveRoleFresh: vi.fn(async (_c: string, userId: string) => ROLES[userId] ?? null),
  rulesTokenMatches: vi.fn((presented: unknown) => rulesTokenMatches(tokenPath, presented)),
};
const input = (routeKey: string, actorType: string, body?: unknown, actorId = "owner") =>
  ({ routeKey, companyId: C, actor: { actorType, actorId, userId: actorType === "user" ? actorId : null }, params: {}, query: {}, body }) as never;
const access = { companyId: C };
const report = { companyId: C, syncedAt: "2026-10-09T10:00:00.000Z", error: null };
const FORBIDDEN = { status: 403, body: { error: FORBIDDEN_MESSAGE, code: "forbidden" } };

beforeEach(() => {
  vi.clearAllMocks();
  tokenPath = TOKEN_PATH;
});

describe("groups board routes", () => {
  it("declares both routes board-only POSTs, so the rules token never sits in a URL", () => {
    expect(GROUP_API_ROUTES.map((r) => [r.routeKey, r.method, r.path, r.auth])).toEqual([
      ["groups.agent_access", "POST", "/groups/agent-access", "board"],
      ["groups.sync_report", "POST", "/groups/sync-report", "board"],
    ]);
    expect(GROUP_API_ROUTES.every((r) => r.companyResolution?.from === "body")).toBe(true);
  });
  it("ignores routes it does not own", async () => {
    expect(await handleGroupsApiRequest(service as never, input("apps.list", "user"), hosts)).toBeNull();
  });
  it("refuses an agent even if a route were mis-declared, and even with the token", async () => {
    expect((await handleGroupsApiRequest(service as never, input("groups.agent_access", "agent", { ...access, rulesToken: TOKEN }), hosts))?.status).toBe(403);
    expect(hosts.resolveRoleFresh).not.toHaveBeenCalled();
    expect(service.agentAccess).not.toHaveBeenCalled();
  });
  it("prunes against live members and agents, then lists", async () => {
    const res = await handleGroupsApiRequest(service as never, input("groups.agent_access", "user", access), hosts);
    expect(res).toEqual({ status: 200, body: { agents: [{ agentId: "a1", allowedUserIds: ["u1"] }] } });
    expect(service.agentAccess).toHaveBeenCalledWith(C, { userIds: new Set(["u1"]), agentIds: new Set(["a1"]) });
  });
  it("records a sync report and rejects a malformed one", async () => {
    expect(await handleGroupsApiRequest(service as never, input("groups.sync_report", "user", report), hosts)).toEqual({ status: 200, body: { ok: true } });
    expect((await handleGroupsApiRequest(service as never, input("groups.sync_report", "user", { companyId: C, syncedAt: 5 }), hosts))?.status).toBe(400);
  });
  it("surfaces a host failure as a 500, never an empty set", async () => {
    const failing = { ...hosts, listUserIds: async () => { throw new Error("boom"); } };
    expect((await handleGroupsApiRequest(service as never, input("groups.agent_access", "user", access), failing))?.status).toBe(500);
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

// Rulings R13 and R18: "board" admits every signed-in person; these routes need the kyoube CLI's rules
// token or an owner or admin.
describe("groups board routes: rules token, or owner or admin", () => {
  for (const who of ["operator", "viewer", "stranger"]) {
    it(`refuses ${who === "stranger" ? "a non-member" : `an ${who}`} on the agent-access read, reading nothing`, async () => {
      expect(await handleGroupsApiRequest(service as never, input("groups.agent_access", "user", access, who), hosts)).toEqual(FORBIDDEN);
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
    it(`lets an ${who} without the token read agent access and record a sync (role compared case-insensitively)`, async () => {
      expect((await handleGroupsApiRequest(service as never, input("groups.agent_access", "user", access, who), hosts))?.status).toBe(200);
      expect((await handleGroupsApiRequest(service as never, input("groups.sync_report", "user", report, who), hosts))?.status).toBe(200);
      expect(service.recordSync).toHaveBeenCalledTimes(1);
    });
  }
  it("lets the kyoube CLI's token through for a board user who is not a member of the company", async () => {
    expect(await handleGroupsApiRequest(service as never, input("groups.agent_access", "user", { ...access, rulesToken: TOKEN }, "stranger"), hosts))
      .toEqual({ status: 200, body: { agents: [{ agentId: "a1", allowedUserIds: ["u1"] }] } });
    expect(await handleGroupsApiRequest(service as never, input("groups.sync_report", "user", { ...report, rulesToken: TOKEN }, "stranger"), hosts)).toEqual({ status: 200, body: { ok: true } });
    expect(service.recordSync).toHaveBeenCalledWith(C, { syncedAt: report.syncedAt, error: null });
    expect(hosts.resolveRoleFresh).not.toHaveBeenCalled();
  });
  it("refuses a wrong or short token to an operator, a viewer and a non-member, reading and recording nothing", async () => {
    for (const who of ["operator", "viewer", "stranger"]) {
      for (const rulesToken of [`${TOKEN.slice(0, -1)}e`, TOKEN.slice(0, 8), "", 7]) {
        expect(await handleGroupsApiRequest(service as never, input("groups.agent_access", "user", { ...access, rulesToken }, who), hosts)).toEqual(FORBIDDEN);
        expect(await handleGroupsApiRequest(service as never, input("groups.sync_report", "user", { ...report, rulesToken }, who), hosts)).toEqual(FORBIDDEN);
      }
    }
    expect(hosts.listUserIds).not.toHaveBeenCalled();
    expect(service.agentAccess).not.toHaveBeenCalled();
    expect(service.recordSync).not.toHaveBeenCalled();
  });
  it("refuses the token path when the token file is missing", async () => {
    tokenPath = path.join(TOKEN_DIR, "absent");
    expect(await handleGroupsApiRequest(service as never, input("groups.agent_access", "user", { ...access, rulesToken: TOKEN }, "stranger"), hosts)).toEqual(FORBIDDEN);
    expect(await handleGroupsApiRequest(service as never, input("groups.sync_report", "user", { ...report, rulesToken: TOKEN }, "stranger"), hosts)).toEqual(FORBIDDEN);
    expect(service.agentAccess).not.toHaveBeenCalled();
    expect(service.recordSync).not.toHaveBeenCalled();
  });
  it("answers 500, doing nothing, when the role cannot be read", async () => {
    const failing = { ...hosts, resolveRoleFresh: async () => { throw new Error("host down"); } };
    expect((await handleGroupsApiRequest(service as never, input("groups.sync_report", "user", report), failing))?.status).toBe(500);
    expect(service.recordSync).not.toHaveBeenCalled();
  });
});
