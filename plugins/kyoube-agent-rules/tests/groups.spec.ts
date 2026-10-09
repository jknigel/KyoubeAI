import { describe, expect, it } from "vitest";
import { applyGroups, EMPTY_GROUPS_RECORD, NO_AGENT, parseAccess, planPerson, type GroupsPort, type GroupsRecord, type MemberRow } from "../src/groups.js";
import { isProtected, withProtection, type AgentRow, type Grant, type Policy } from "../src/policy.js";

const BROAD: Grant = { permissionKey: "tasks:assign", scope: null };
const scoped = (ids: string[]): Grant => ({ permissionKey: "tasks:assign", scope: { agentIds: ids } });
const LIVE = ["a1", "a2", "a3", "boss"];
const ACCESS = [{ agentId: "a1", allowedUserIds: ["u-in"] }, { agentId: "a2", allowedUserIds: [] }];

describe("planPerson", () => {
  it("scopes an operator's broad grant to every live agent but the forbidden ones", () => {
    expect(planPerson({ role: "operator", original: BROAD, liveAgentIds: LIVE, access: ACCESS, userId: "u-in" })).toEqual(scoped(["a3", "boss", "a1"].sort()));
    expect(planPerson({ role: "operator", original: BROAD, liveAgentIds: LIVE, access: ACCESS, userId: "u-out" })).toEqual(scoped(["a3", "boss"]));
  });
  it("never writes an empty scope", () => {
    expect(planPerson({ role: "operator", original: BROAD, liveAgentIds: ["a2"], access: ACCESS, userId: "u-out" })).toEqual(scoped([NO_AGENT]));
  });
  it("gives a viewer only their own group agents, and nothing when they have none", () => {
    expect(planPerson({ role: "viewer", original: null, liveAgentIds: LIVE, access: ACCESS, userId: "u-in" })).toEqual(scoped(["a1"]));
    expect(planPerson({ role: "viewer", original: null, liveAgentIds: LIVE, access: ACCESS, userId: "u-out" })).toBeNull();
  });
  it("restores the original for owners, admins, and when no agent is restricted", () => {
    expect(planPerson({ role: "admin", original: BROAD, liveAgentIds: LIVE, access: ACCESS, userId: "u-out" })).toEqual(BROAD);
    expect(planPerson({ role: "operator", original: BROAD, liveAgentIds: LIVE, access: [], userId: "u-out" })).toEqual(BROAD);
  });
  it("leaves a grant someone scoped by hand alone", () => {
    expect(planPerson({ role: "operator", original: scoped(["a3"]), liveAgentIds: LIVE, access: ACCESS, userId: "u-out" })).toBe("custom");
  });
  it("ignores restricted agents that are no longer live", () => {
    // a2 is gone: only a1 still restricts u-out.
    expect(planPerson({ role: "operator", original: BROAD, liveAgentIds: ["a1", "a3"], access: ACCESS, userId: "u-out" })).toEqual(scoped(["a3"]));
    // Neither restricted agent is live, so nothing is restricted: the original row comes back,
    // and a viewer whose only group agent is gone gets nothing.
    expect(planPerson({ role: "operator", original: BROAD, liveAgentIds: ["a3"], access: ACCESS, userId: "u-out" })).toEqual(BROAD);
    expect(planPerson({ role: "viewer", original: null, liveAgentIds: ["a3"], access: ACCESS, userId: "u-in" })).toBeNull();
  });
});

class FakeCore implements GroupsPort {
  policies = new Map<string, Policy>();
  userGrants = new Map<string, Grant[]>();
  record: GroupsRecord = structuredClone(EMPTY_GROUPS_RECORD);
  writes: string[] = [];
  failing = new Set<string>();
  constructor(public agents: AgentRow[], public members: MemberRow[]) {}
  private fail(key: string) { if (this.failing.has(key)) throw new Error(`refused ${key}`); }
  async listAgents() { return this.agents.map((row) => ({ ...row })); }
  async listMembers() { return this.members.map((row) => ({ ...row })); }
  async getPolicy(_c: string, id: string) { return structuredClone(this.policies.get(id) ?? null); }
  async setPolicy(_c: string, id: string, policy: Policy) { this.fail(`setPolicy:${id}`); this.writes.push(`policy ${id}`); this.policies.set(id, structuredClone(policy)); }
  async listUserGrants(_c: string, id: string) { return structuredClone(this.userGrants.get(id) ?? []); }
  async setUserGrants(_c: string, id: string, grants: Grant[]) { this.fail(`setUserGrants:${id}`); this.writes.push(`grants ${id}`); this.userGrants.set(id, structuredClone(grants)); }
  async readGroupsRecord() { return structuredClone(this.record); }
  async writeGroupsRecord(_c: string, record: GroupsRecord) { this.fail("writeRecord"); this.record = structuredClone(record); }
}

const C = "11111111-1111-4111-8111-111111111111";
const agent = (id: string, reportsTo: string | null = null, status = "idle"): AgentRow => ({ id, name: id.toUpperCase(), status, reportsTo });
const INVITE: Grant = { permissionKey: "users:invite", scope: null };
const CHECKOUTS: Grant = { permissionKey: "tasks:manage_active_checkouts", scope: { projectIds: ["p1"] } };

function core() {
  const fake = new FakeCore([agent("a1"), agent("a2"), agent("a3", "boss"), agent("boss")], [
    { userId: "u-in", role: "operator" }, { userId: "u-out", role: "operator" }, { userId: "admin", role: "admin" }, { userId: "v", role: "viewer" },
  ]);
  fake.userGrants.set("u-in", [BROAD]);
  fake.userGrants.set("u-out", [BROAD, CHECKOUTS]);
  fake.userGrants.set("admin", [BROAD, INVITE]);
  return fake;
}

describe("applyGroups", () => {
  it("protects group agents and scopes operators, keeping every other grant", async () => {
    const fake = core();
    const report = await applyGroups(fake, C, ACCESS);
    expect(isProtected(fake.policies.get("a1") ?? null) && isProtected(fake.policies.get("a2") ?? null)).toBe(true);
    expect(fake.userGrants.get("u-out")).toEqual([CHECKOUTS, scoped(["a3", "boss"])]);
    expect(fake.userGrants.get("u-in")).toEqual([scoped(["a1", "a3", "boss"])]);
    expect(fake.userGrants.get("admin")).toEqual([BROAD, INVITE]);
    expect(fake.userGrants.get("v")).toBeUndefined();
    expect(report.protected.sort()).toEqual(["a1", "a2"]);
    expect(fake.record.required.sort()).toEqual(["a1", "a2"]);
    expect(fake.record.people["u-out"]).toEqual({ original: BROAD, applied: scoped(["a3", "boss"]) });
  });

  it("is idempotent", async () => {
    const fake = core();
    await applyGroups(fake, C, ACCESS);
    fake.writes = [];
    await applyGroups(fake, C, ACCESS);
    expect(fake.writes).toEqual([]);
  });

  it("undoes everything when the last group agent goes", async () => {
    const fake = core();
    await applyGroups(fake, C, ACCESS);
    const report = await applyGroups(fake, C, []);
    expect(isProtected(fake.policies.get("a1") ?? null)).toBe(false);
    expect(fake.userGrants.get("u-out")).toEqual([CHECKOUTS, BROAD]);
    expect(fake.userGrants.get("u-in")).toEqual([BROAD]);
    expect(fake.record).toEqual(EMPTY_GROUPS_RECORD);
    expect(report.unprotected.sort()).toEqual(["a1", "a2"]);
  });

  it("never unprotects a manager, and never protects over a policy it cannot extend", async () => {
    const fake = core();
    fake.policies.set("a2", { somethingElse: true });
    const report = await applyGroups(fake, C, [{ agentId: "boss", allowedUserIds: ["u-in"] }, { agentId: "a2", allowedUserIds: [] }]);
    expect(report.skipped).toContainEqual({ id: "a2", reason: "has an authorization policy KyoubeAI does not change" });
    await applyGroups(fake, C, []);
    // boss manages a3, so the manager rule still wants it protected.
    expect(isProtected(fake.policies.get("boss") ?? null)).toBe(true);
  });

  it("does not record an agent that was already protected by someone else", async () => {
    const fake = core();
    fake.policies.set("a1", withProtection(null));
    await applyGroups(fake, C, ACCESS);
    expect(fake.record.protected).not.toContain("a1");
    await applyGroups(fake, C, []);
    expect(isProtected(fake.policies.get("a1") ?? null)).toBe(true);
  });

  it("leaves a grant a person changed after KyoubeAI wrote it", async () => {
    const fake = core();
    await applyGroups(fake, C, ACCESS);
    fake.userGrants.set("u-out", [CHECKOUTS, scoped(["a1"])]);
    const report = await applyGroups(fake, C, ACCESS);
    expect(fake.userGrants.get("u-out")).toEqual([CHECKOUTS, scoped(["a1"])]);
    expect(report.skipped).toContainEqual({ id: "u-out", reason: "its assignment grant was changed by a person; KyoubeAI leaves it as they set it" });
    expect(fake.record.people["u-out"]).toBeUndefined();
  });

  it("restores a person promoted to admin, and drops someone who left", async () => {
    const fake = core();
    await applyGroups(fake, C, ACCESS);
    fake.members = fake.members.map((m) => (m.userId === "u-out" ? { ...m, role: "admin" } : m)).filter((m) => m.userId !== "u-in");
    await applyGroups(fake, C, ACCESS);
    expect(fake.userGrants.get("u-out")).toEqual([CHECKOUTS, BROAD]);
    expect(fake.record.people["u-in"]).toBeUndefined();
  });

  it("reports a failed grant write and carries on with the next person", async () => {
    const fake = core();
    fake.failing.add("setUserGrants:u-in");
    const report = await applyGroups(fake, C, ACCESS);
    expect(report.failures).toContainEqual(expect.objectContaining({ id: "u-in", step: "grants" }));
    expect(fake.userGrants.get("u-out")).toEqual([CHECKOUTS, scoped(["a3", "boss"])]);
    // The failed person is not remembered as changed, so the next pass simply retries.
    expect(fake.record.people["u-in"]).toBeUndefined();
    fake.failing.clear();
    await applyGroups(fake, C, ACCESS);
    expect(fake.userGrants.get("u-in")).toEqual([scoped(["a1", "a3", "boss"])]);
  });
});

describe("parseAccess", () => {
  it("accepts the route body and rejects anything else", () => {
    expect(parseAccess([{ agentId: "a1", allowedUserIds: ["u"] }])).toEqual([{ agentId: "a1", allowedUserIds: ["u"] }]);
    expect(parseAccess("nope")).toBeNull();
    expect(parseAccess([{ agentId: 5 }])).toBeNull();
  });
});
