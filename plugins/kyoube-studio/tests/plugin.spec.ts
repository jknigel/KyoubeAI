import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createStudioPlugin } from "../src/plugin.js";
import type { HomeSnapshot, TeamSnapshot } from "../src/model.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-09-24T09:00:00Z");
const at = (minutes: number) => new Date(NOW - minutes * 60_000);

function agent(id: string, companyId: string, name: string, status: string, icon: string | null = null) {
  return { id, companyId, name, urlKey: name.toLowerCase().replace(/\s+/g, "-"), role: "general", title: null, icon, status, reportsTo: null, lastHeartbeatAt: at(10), createdAt: at(1000), updatedAt: at(5) } as never;
}
function issue(id: string, companyId: string, identifier: string, status: string, assigneeAgentId: string | null, minutesAgo: number) {
  return { id, companyId, identifier, title: `Task ${identifier}`, status, assigneeAgentId, hiddenAt: null, createdAt: at(minutesAgo + 10), updatedAt: at(minutesAgo), completedAt: status === "done" ? at(minutesAgo) : null } as never;
}

async function setup(clock = { now: NOW }) {
  const harness = createTestHarness({ manifest });
  harness.seed({
    agents: [agent("a1", COMPANY, "Ambassador Content Agent", "running", "sparkles"), agent("a2", COMPANY, "AI Manager", "idle"), agent("x1", OTHER, "Someone Else", "running")],
    issues: [issue("i1", COMPANY, "BAP-1", "in_progress", "a1", 1), issue("i2", COMPANY, "BAP-2", "in_review", "a2", 20), issue("i3", COMPANY, "BAP-3", "done", "a2", 60), issue("x9", OTHER, "OTH-9", "in_review", "x1", 1)],
    approvals: [{ id: "ap1", companyId: COMPANY, type: "request_board_approval", status: "pending", requestedByAgentId: "a2", requestedByUserId: null, payload: { title: "New pricing page" }, decisionNote: null, decidedByUserId: null, decidedAt: null, createdAt: at(3), updatedAt: at(3) } as never],
    accessMembers: [
      { id: "m1", companyId: COMPANY, principalType: "user", principalId: "owner-1", status: "active", membershipRole: "owner", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
      { id: "m2", companyId: COMPANY, principalType: "user", principalId: "member-1", status: "active", membershipRole: "member", grants: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    ] as never,
  });
  const plugin = createStudioPlugin({ now: () => clock.now });
  await plugin.definition.setup(harness.ctx);
  return { harness, clock };
}

describe("kyoube.studio worker", () => {
  it("serves the team roster for the caller's company only", async () => {
    const { harness } = await setup();
    const team = await harness.getData<TeamSnapshot>("team", { companyId: COMPANY });
    expect(team.members.map((m) => m.name)).toEqual(["Ambassador Content Agent", "AI Manager"]);
    expect(team.members[0]).toMatchObject({ state: "working", detail: "Task BAP-1", icon: "sparkles" });
  });

  it("serves Home: what needs you, the team, the week and the latest updates", async () => {
    const { harness } = await setup();
    const home = await harness.getData<HomeSnapshot>("home", { companyId: COMPANY });
    expect(home.needs.map((n) => n.kind)).toEqual(["approval", "review"]);
    expect(home.needs[0]!.title).toBe("Approval requested: New pricing page");
    expect(home.needsTotal).toBe(2);
    expect(home.doneThisWeek).toBe(1);
    expect(home.updates[0]!.identifier).toBe("BAP-1");
    expect(home.steps).toEqual({ hireAgent: true, giveTask: true, teamwork: false });
  });

  it("serves the Workspace figures and marks owners and admins", async () => {
    const { harness } = await setup();
    expect(await harness.getData("workspace", { companyId: COMPANY, userId: "owner-1" })).toMatchObject({ agents: 2, people: 2, openTasks: 2, isAdmin: true });
    expect(await harness.getData("workspace", { companyId: COMPANY, userId: "member-1" })).toMatchObject({ isAdmin: false });
  });

  it("serves an agent's profile, with its own notes on the task it is working on", async () => {
    const { harness } = await setup();
    harness.seed({ issueComments: [
      { id: "c1", companyId: COMPANY, issueId: "i1", authorAgentId: "a1", authorUserId: null, body: "Drafted post 1 of 3", createdAt: at(5), updatedAt: at(5) },
      { id: "c2", companyId: COMPANY, issueId: "i1", authorAgentId: null, authorUserId: "owner-1", body: "Looks good", createdAt: at(4), updatedAt: at(4) },
    ] as never });
    const profile = await harness.getData<{ found: boolean; state: string; current: { task: { identifier: string }; notes: Array<{ text: string }> } }>("agent", { companyId: COMPANY, agentRef: "ambassador-content-agent" });
    expect(profile.found).toBe(true);
    expect(profile.state).toBe("working");
    expect(profile.current.task.identifier).toBe("BAP-1");
    expect(profile.current.notes.map((n) => n.text)).toEqual(["Drafted post 1 of 3"]);
    expect(await harness.getData("agent", { companyId: COMPANY, agentRef: "someone-else" })).toEqual({ found: false });
    await expect(harness.getData("agent", { companyId: COMPANY })).rejects.toThrow(/agentRef is required/);
  });

  it("reads an agent's profile fresh, not from the roster's short cache", async () => {
    const { harness } = await setup();
    await harness.getData("team", { companyId: COMPANY });
    harness.seed({ agents: [agent("a3", COMPANY, "New Hire", "idle")] });
    const profile = await harness.getData<{ found: boolean }>("agent", { companyId: COMPANY, agentRef: "new-hire" });
    expect(profile.found).toBe(true);
  });

  it("refuses a call without a company", async () => {
    const { harness } = await setup();
    await expect(harness.getData("team", {})).rejects.toThrow(/companyId is required/);
  });

  it("reuses one snapshot for a few seconds, then reads again", async () => {
    const { harness, clock } = await setup();
    await harness.getData("team", { companyId: COMPANY });
    harness.seed({ agents: [agent("a3", COMPANY, "New Hire", "idle")] });
    expect((await harness.getData<TeamSnapshot>("team", { companyId: COMPANY })).total).toBe(2);
    clock.now += 10_000;
    expect((await harness.getData<TeamSnapshot>("team", { companyId: COMPANY })).total).toBe(3);
  });
});
