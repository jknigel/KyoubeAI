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
  it("never gives a person without a row (a viewer) one, even in a group with agents (R19)", () => {
    expect(planPerson({ role: "viewer", original: null, liveAgentIds: LIVE, access: ACCESS, userId: "u-in" })).toBeNull();
    expect(planPerson({ role: "viewer", original: null, liveAgentIds: LIVE, access: ACCESS, userId: "u-out" })).toBeNull();
    expect(planPerson({ role: "operator", original: null, liveAgentIds: LIVE, access: ACCESS, userId: "u-in" })).toBeNull();
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
  /** Writes the core takes and then reports as failed (a timeout after the commit). */
  ghost = new Set<string>();
  constructor(public agents: AgentRow[], public members: MemberRow[]) {}
  private fail(key: string) { if (this.failing.has(key)) throw new Error(`refused ${key}`); }
  async listAgents() { return this.agents.map((row) => ({ ...row })); }
  async listMembers() { return this.members.map((row) => ({ ...row })); }
  async getPolicy(_c: string, id: string) { return structuredClone(this.policies.get(id) ?? null); }
  async setPolicy(_c: string, id: string, policy: Policy) { this.fail(`setPolicy:${id}`); this.writes.push(`policy ${id}`); this.policies.set(id, structuredClone(policy)); }
  async listUserGrants(_c: string, id: string) { return structuredClone(this.userGrants.get(id) ?? []); }
  async setUserGrants(_c: string, id: string, grants: Grant[]) {
    this.fail(`setUserGrants:${id}`);
    this.writes.push(`grants ${id}`);
    this.userGrants.set(id, structuredClone(grants));
    if (this.ghost.has(`setUserGrants:${id}`)) throw new Error(`timed out ${id}`);
  }
  async readGroupsRecord() { return structuredClone(this.record); }
  async writeGroupsRecord(_c: string, record: GroupsRecord) { this.fail("writeRecord"); this.record = structuredClone(record); }
}

const C = "11111111-1111-4111-8111-111111111111";
const agent = (id: string, reportsTo: string | null = null, status = "idle"): AgentRow => ({ id, name: id.toUpperCase(), status, reportsTo });
const INVITE: Grant = { permissionKey: "users:invite", scope: null };
const CHECKOUTS: Grant = { permissionKey: "tasks:manage_active_checkouts", scope: { projectIds: ["p1"] } };

function core() {
  const fake = new FakeCore([agent("a1"), agent("a2"), agent("a3", "boss"), agent("boss")], [
    { userId: "u-in", role: "operator", status: "active" }, { userId: "u-out", role: "operator", status: "active" },
    { userId: "admin", role: "admin", status: "active" }, { userId: "v", role: "viewer", status: "active" },
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

  it("gives a viewer in a group no grant and writes nothing for them (R19)", async () => {
    const fake = core();
    const withViewer = [{ agentId: "a1", allowedUserIds: ["u-in", "v"] }, { agentId: "a2", allowedUserIds: ["v"] }];
    const report = await applyGroups(fake, C, withViewer);
    expect(fake.userGrants.get("v")).toBeUndefined();
    expect(fake.writes).not.toContain("grants v");
    expect(fake.record.people.v).toBeUndefined();
    expect(report.people).not.toContain("v");
  });

  it("takes back a scoped grant an earlier version gave a viewer", async () => {
    const fake = core();
    fake.userGrants.set("v", [scoped(["a1"])]);
    fake.record = { ...structuredClone(EMPTY_GROUPS_RECORD), people: { v: { original: null, applied: scoped(["a1"]) } } };
    await applyGroups(fake, C, [{ agentId: "a1", allowedUserIds: ["v"] }]);
    expect(fake.userGrants.get("v")).toEqual([]);
    expect(fake.record.people.v).toBeUndefined();
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
    // The write stays pending (R8): the core's row is still one of KyoubeAI's, so the next pass retries.
    expect(fake.record.people["u-in"]).toEqual({ original: BROAD, applied: BROAD, pending: scoped(["a1", "a3", "boss"]) });
    fake.failing.clear();
    const retry = await applyGroups(fake, C, ACCESS);
    expect(fake.userGrants.get("u-in")).toEqual([scoped(["a1", "a3", "boss"])]);
    expect(retry.skipped).toEqual([]);
    expect(fake.record.people["u-in"]).toEqual({ original: BROAD, applied: scoped(["a1", "a3", "boss"]) });
  });
});

describe("applyGroups after an interrupted grant write", () => {
  const CHANGED = { id: "u-out", reason: "its assignment grant was changed by a person; KyoubeAI leaves it as they set it" };
  const ACCESS_A1 = [{ agentId: "a1", allowedUserIds: [] }];
  const ACCESS_BOTH = [{ agentId: "a1", allowedUserIds: [] }, { agentId: "a2", allowedUserIds: [] }];

  it("scopes a person whose first write was cut off after the write-ahead", async () => {
    const fake = core();
    // The process died after recording the pending row, before the core took it.
    fake.record = { protected: [], required: ["a1", "a2"], people: { "u-out": { original: BROAD, applied: BROAD, pending: scoped(["a3", "boss"]) } } };
    const report = await applyGroups(fake, C, ACCESS);
    expect(fake.userGrants.get("u-out")).toEqual([CHECKOUTS, scoped(["a3", "boss"])]);
    expect(report.skipped).not.toContainEqual(CHANGED);
    expect(fake.record.people["u-out"]).toEqual({ original: BROAD, applied: scoped(["a3", "boss"]) });
  });

  it("re-scopes a person whose re-scope was cut off, and keeps managing them", async () => {
    const fake = core();
    await applyGroups(fake, C, ACCESS_A1);
    expect(fake.userGrants.get("u-out")).toEqual([CHECKOUTS, scoped(["a2", "a3", "boss"])]);
    // a2 becomes restricted; the process dies after the write-ahead.
    fake.record = { ...fake.record, required: ["a1", "a2"], people: { ...fake.record.people, "u-out": { original: BROAD, applied: scoped(["a2", "a3", "boss"]), pending: scoped(["a3", "boss"]) } } };
    const report = await applyGroups(fake, C, ACCESS_BOTH);
    expect(fake.userGrants.get("u-out")).toEqual([CHECKOUTS, scoped(["a3", "boss"])]);
    expect(report.skipped).toEqual([]);
    expect(fake.record.people["u-out"]).toEqual({ original: BROAD, applied: scoped(["a3", "boss"]) });
    // Still managed, never "custom": undoing groups gives the original back.
    await applyGroups(fake, C, []);
    expect(fake.userGrants.get("u-out")).toEqual([CHECKOUTS, BROAD]);
  });

  it("adopts a write the core took but reported as failed, and can still undo it", async () => {
    const fake = core();
    fake.ghost.add("setUserGrants:u-out");
    const first = await applyGroups(fake, C, ACCESS);
    expect(first.failures).toContainEqual(expect.objectContaining({ id: "u-out", step: "grants" }));
    expect(fake.record.people["u-out"]).toEqual({ original: BROAD, applied: BROAD, pending: scoped(["a3", "boss"]) });
    fake.ghost.clear();
    fake.writes = [];
    const second = await applyGroups(fake, C, ACCESS);
    expect(fake.writes).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(fake.record.people["u-out"]).toEqual({ original: BROAD, applied: scoped(["a3", "boss"]) });
    await applyGroups(fake, C, []);
    expect(fake.userGrants.get("u-out")).toEqual([CHECKOUTS, BROAD]);
    expect(fake.record).toEqual(EMPTY_GROUPS_RECORD);
  });

  it("quietly drops the entry of a restore the core took before the record was cleared", async () => {
    const fake = core();
    await applyGroups(fake, C, ACCESS);
    // The core holds the original again; the process died before the entry was dropped.
    fake.userGrants.set("u-out", [CHECKOUTS, BROAD]);
    fake.record.people["u-out"] = { ...fake.record.people["u-out"]!, pending: BROAD };
    fake.writes = [];
    const report = await applyGroups(fake, C, []);
    expect(report.skipped).toEqual([]);
    expect(fake.writes).not.toContain("grants u-out");
    expect(fake.record.people["u-out"]).toBeUndefined();
    expect(fake.userGrants.get("u-out")).toEqual([CHECKOUTS, BROAD]);
  });

  it("leaves a suspended member alone and keeps their entry, then manages them again", async () => {
    const fake = core();
    await applyGroups(fake, C, ACCESS);
    const entry = structuredClone(fake.record.people["u-out"]);
    fake.members = fake.members.map((m) => (m.userId === "u-out" ? { ...m, status: "suspended" } : m));
    fake.writes = [];
    const widened = [{ agentId: "a1", allowedUserIds: ["u-in", "u-out"] }, { agentId: "a2", allowedUserIds: [] }];
    await applyGroups(fake, C, widened);
    expect(fake.writes).not.toContain("grants u-out");
    expect(fake.record.people["u-out"]).toEqual(entry);
    fake.members = fake.members.map((m) => (m.userId === "u-out" ? { ...m, status: "active" } : m));
    const report = await applyGroups(fake, C, widened);
    expect(report.skipped).toEqual([]);
    expect(fake.userGrants.get("u-out")).toEqual([CHECKOUTS, scoped(["a1", "a3", "boss"])]);
    await applyGroups(fake, C, []);
    expect(fake.userGrants.get("u-out")).toEqual([CHECKOUTS, BROAD]);
  });

  it("re-scopes a row a person set by hand back to the original (accepted R8 consequence)", async () => {
    const fake = core();
    await applyGroups(fake, C, ACCESS);
    fake.userGrants.set("u-out", [CHECKOUTS, BROAD]);
    const report = await applyGroups(fake, C, ACCESS);
    expect(report.skipped).toEqual([]);
    expect(fake.userGrants.get("u-out")).toEqual([CHECKOUTS, scoped(["a3", "boss"])]);
  });
});

describe("applyGroups without groups (R17)", () => {
  /** Records every port call the fake answers. */
  function counted(fake: FakeCore) {
    const calls: string[] = [];
    const port = new Proxy(fake, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => { calls.push(String(key)); return value.apply(target, args); };
      },
    });
    return { calls, port };
  }

  it("makes no host call but reading its record when no agent is restricted and nothing is left to undo", async () => {
    const { calls, port } = counted(core());
    expect(await applyGroups(port, C, [])).toEqual({ protected: [], unprotected: [], people: [], skipped: [], failures: [] });
    expect(calls).toEqual(["readGroupsRecord"]);
  });

  it("still undoes what an earlier group changed once the last group is gone", async () => {
    const fake = core();
    await applyGroups(fake, C, ACCESS);
    const { calls, port } = counted(fake);
    const report = await applyGroups(port, C, []);
    expect(calls).toContain("listAgents");
    expect(report.unprotected.sort()).toEqual(["a1", "a2"]);
    expect(fake.userGrants.get("u-out")).toEqual([CHECKOUTS, BROAD]);
    expect(fake.record).toEqual(EMPTY_GROUPS_RECORD);
    // And from then on, nothing more.
    const again = counted(fake);
    await applyGroups(again.port, C, []);
    expect(again.calls).toEqual(["readGroupsRecord"]);
  });

  for (const [what, record] of [
    ["protected agents", { ...EMPTY_GROUPS_RECORD, protected: ["a1"] }],
    ["required agents", { ...EMPTY_GROUPS_RECORD, required: ["a1"] }],
    ["people", { ...EMPTY_GROUPS_RECORD, people: { "u-out": { original: BROAD, applied: scoped(["a3"]) } } }],
  ] as const) {
    it(`goes through the undo path when the record still names ${what}`, async () => {
      const fake = core();
      fake.record = structuredClone(record) as GroupsRecord;
      const { calls, port } = counted(fake);
      await applyGroups(port, C, []);
      expect(calls).toContain("listAgents");
    });
  }
});

describe("parseAccess", () => {
  it("accepts the route body and rejects anything else", () => {
    expect(parseAccess([{ agentId: "a1", allowedUserIds: ["u"] }])).toEqual([{ agentId: "a1", allowedUserIds: ["u"] }]);
    expect(parseAccess("nope")).toBeNull();
    expect(parseAccess([{ agentId: 5 }])).toBeNull();
  });
});
