import { describe, expect, it } from "vitest";
import type { AgentRef, GuardReport, GuardRevertReport, InstructionsBundle, RulesApi } from "../src/agent-rules/api.js";
import { GUARD_PLUGIN_ROUTES } from "../src/agent-rules/api.js";
import { RULES_BLOCK } from "../src/agent-rules/block.js";
import type { Governance } from "../src/agent-rules/governance.js";
import { applyPass, revertPass } from "../src/agent-rules/pass.js";
import { EMPTY_STATE } from "../src/agent-rules/state.js";
import { CoreApiError } from "../src/core-api.js";

const NOW = new Date("2026-10-01T10:00:00Z");
const MANAGED: InstructionsBundle = { mode: "managed", entryFile: "AGENTS.md", hasEntryFile: true, editable: true, legacyPromptTemplateActive: false };
const QUIET_GUARD: GuardReport = { managers: [], updated: [], skipped: [], failures: [], selfTest: { status: "not_applicable", detail: "" } };

class FakeApi implements RulesApi {
  companies = [{ id: "c1", name: "Acme" }];
  agents: Record<string, AgentRef[]> = { c1: [{ id: "a1", name: "Writer", status: "idle" }, { id: "a2", name: "Gone", status: "terminated" }] };
  governance: Record<string, Governance> = { c1: {} };
  bundles: Record<string, InstructionsBundle> = {};
  files: Record<string, string> = { a1: "You are an agent.\n" };
  guard: GuardReport = QUIET_GUARD;
  calls: string[] = [];
  failing = new Set<string>();

  private check(key: string) {
    if (this.failing.has(key)) throw new Error(`refused ${key}`);
  }
  async listCompanies() { this.check("listCompanies"); return this.companies; }
  async listAgents(companyId: string) { this.check(`listAgents:${companyId}`); return this.agents[companyId] ?? []; }
  async getGovernance(companyId: string) { return structuredClone(this.governance[companyId] ?? {}); }
  async setGovernance(companyId: string, governance: Governance) { this.check(`setGovernance:${companyId}`); this.calls.push(`governance ${companyId}`); this.governance[companyId] = structuredClone(governance); }
  async getInstructionsBundle(agentId: string) { return this.bundles[agentId] ?? MANAGED; }
  async readInstructionsFile(agentId: string) { return this.files[agentId] ?? ""; }
  async writeInstructionsFile(agentId: string, _path: string, content: string) { this.check(`write:${agentId}`); this.calls.push(`write ${agentId}`); this.files[agentId] = content; }
  async reconcileGuard(companyId: string) {
    if (this.failing.has("guard404")) throw new CoreApiError(404, { error: "Plugin not found" }, "Plugin not found", `POST ${GUARD_PLUGIN_ROUTES.reconcile}`);
    this.calls.push(`guard ${companyId}`);
    return this.guard;
  }
  async revertGuard(companyId: string): Promise<GuardRevertReport> { this.calls.push(`unguard ${companyId}`); return { reverted: [], failures: [] }; }
  async pluginReady() { return true; }
}

const deps = (api: RulesApi) => ({ api, now: () => NOW });

describe("applyPass", () => {
  it("sets G1, reconciles G2 and writes the rules block, then records it all", async () => {
    const api = new FakeApi();
    const { report, state } = await applyPass(deps(api), EMPTY_STATE);
    expect(api.calls).toEqual(["governance c1", "guard c1", "write a1"]);
    expect(api.governance.c1?.request_confirmation).toEqual({ defaultPolicy: "human_only", cap: "human_only" });
    expect(api.files.a1?.startsWith(RULES_BLOCK)).toBe(true);
    expect(report.companies[0]).toMatchObject({ companyId: "c1", governance: "set", rulesUpdated: ["Writer"], writes: 2, failures: [] });
    expect(state.governancePrevious.c1?.request_confirmation).toBeNull();
    expect(state.lastPass).toEqual(report);
    expect(report.at).toBe(NOW.toISOString());
  });

  it("makes no writes on a second pass and keeps the first recorded governance", async () => {
    const api = new FakeApi();
    api.governance.c1 = { request_confirmation: { cap: "anyone" } };
    const first = await applyPass(deps(api), EMPTY_STATE);
    api.calls = [];
    const second = await applyPass(deps(api), first.state);
    expect(api.calls).toEqual(["guard c1"]);
    expect(second.report.companies[0]?.writes).toBe(0);
    expect(second.state.governancePrevious.c1?.request_confirmation).toEqual({ cap: "anyone" });
  });

  it("skips agents it may not edit and says why, without writing", async () => {
    const api = new FakeApi();
    api.agents.c1 = [
      { id: "ext", name: "External", status: "idle" },
      { id: "leg", name: "Legacy", status: "idle" },
      { id: "none", name: "Empty", status: "idle" },
      { id: "bad", name: "Broken", status: "idle" },
    ];
    api.bundles = { ext: { ...MANAGED, mode: "external" }, leg: { ...MANAGED, legacyPromptTemplateActive: true }, none: { ...MANAGED, hasEntryFile: false } };
    api.files = { bad: "<!-- kyoube:working-rules v1. x -->\nno end\n" };
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(report.companies[0]?.skipped).toEqual([
      { agent: "External", reason: "its instructions are not a managed bundle KyoubeAI can edit (mode external)" },
      { agent: "Legacy", reason: "it still uses the legacy prompt template" },
      { agent: "Empty", reason: "its instructions bundle has no AGENTS.md" },
      { agent: "Broken", reason: "AGENTS.md: the rules block markers are incomplete or repeated (1 start, 0 end)" },
    ]);
    expect(api.calls.filter((call) => call.startsWith("write"))).toEqual([]);
  });

  it("leaves an agent waiting for approval alone, without a skipped entry (the plugin's report lists it)", async () => {
    const api = new FakeApi();
    api.agents.c1 = [{ id: "a1", name: "Writer", status: "idle" }, { id: "p1", name: "Hire", status: "pending_approval" }];
    api.files.p1 = "You are new.\n";
    const bundlesRead: string[] = [];
    const getBundle = api.getInstructionsBundle.bind(api);
    api.getInstructionsBundle = async (agentId: string) => { bundlesRead.push(agentId); return getBundle(agentId); };
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(bundlesRead).toEqual(["a1"]);
    expect(api.calls.filter((call) => call.startsWith("write"))).toEqual(["write a1"]);
    expect(api.files.p1).toBe("You are new.\n");
    expect(report.companies[0]?.skipped).toEqual([]);
  });

  it("carries the guard's skipped agents, failures and a failed self-test", async () => {
    const api = new FakeApi();
    api.guard = {
      ...QUIET_GUARD,
      skipped: [{ agentId: "m", name: "CTO", reason: "has an authorization policy KyoubeAI does not change" }],
      failures: [{ agentId: "x", name: "QA", step: "grants", error: "nope" }],
      selfTest: { status: "fail", detail: "QA can still assign to its manager CTO (allow_grant)" },
    };
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(report.companies[0]?.skipped).toContainEqual({ agent: "CTO", reason: "has an authorization policy KyoubeAI does not change" });
    expect(report.companies[0]?.failures).toEqual([
      { step: "guard", agent: "QA", error: "grants: nope" },
      { step: "guard", error: "self-test failed: QA can still assign to its manager CTO (allow_grant)" },
    ]);
  });

  it("keeps going when one step or one agent fails", async () => {
    const api = new FakeApi();
    api.agents.c1 = [{ id: "a1", name: "Writer", status: "idle" }, { id: "a3", name: "Coder", status: "idle" }];
    api.files.a3 = "Code.\n";
    api.failing.add("setGovernance:c1");
    api.failing.add("write:a1");
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    const company = report.companies[0]!;
    expect(company.governance).toBe("failed");
    expect(company.failures.map((failure) => `${failure.step} ${failure.agent ?? ""}`.trim())).toEqual(["governance", "rules Writer"]);
    expect(company.rulesUpdated).toEqual(["Coder"]);
    expect(api.calls).toContain("guard c1");
  });

  it("says the guard plugin is missing, and still writes the rules block", async () => {
    const api = new FakeApi();
    api.failing.add("guard404");
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(report.companies[0]?.failures[0]?.error).toMatch(/^the kyoube\.agent-rules plugin is not installed or not ready \(POST \/api\/plugins\/kyoube\.agent-rules\/api\/reconcile → 404\)/);
    expect(report.companies[0]?.rulesUpdated).toEqual(["Writer"]);
  });

  it("records a failure to list companies and stops there", async () => {
    const api = new FakeApi();
    api.failing.add("listCompanies");
    const { report } = await applyPass(deps(api), EMPTY_STATE);
    expect(report.failures).toEqual([{ step: "list", error: "refused listCompanies" }]);
    expect(report.companies).toEqual([]);
  });

  it("records governance even when unchanged, to preserve pre-existing people-only settings", async () => {
    const api = new FakeApi();
    // Start with all five kinds already set to people-only
    api.governance.c1 = {
      request_confirmation: { defaultPolicy: "human_only", cap: "human_only" },
      request_checkbox_confirmation: { defaultPolicy: "human_only", cap: "human_only" },
      request_item_verdicts: { defaultPolicy: "human_only", cap: "human_only" },
      ask_user_questions: { defaultPolicy: "human_only", cap: "human_only" },
      suggest_tasks: { defaultPolicy: "human_only", cap: "human_only" },
    };
    const { report, state } = await applyPass(deps(api), EMPTY_STATE);
    // No governance write should have happened
    expect(api.calls.filter((call) => call.startsWith("governance"))).toEqual([]);
    // But the previous values should be recorded as empty (no change)
    expect(state.governancePrevious.c1).toEqual({});
  });
});

describe("revertPass", () => {
  it("puts governance back, asks the plugin to revert, removes the blocks and forgets the record", async () => {
    const api = new FakeApi();
    api.governance.c1 = { request_confirmation: { cap: "anyone" } };
    const applied = await applyPass(deps(api), EMPTY_STATE);
    api.calls = [];
    const { report, state } = await revertPass(deps(api), applied.state);
    expect(api.governance.c1).toEqual({ request_confirmation: { cap: "anyone" } });
    expect(api.calls).toEqual(["governance c1", "unguard c1", "write a1"]);
    expect(api.files.a1).toBe("You are an agent.\n\n## Handoffs\n\nNone. To add a standing handoff, write a line such as\n\"QA Agent tests every code change before it is marked done.\"\n");
    expect(state.governancePrevious).toEqual({});
    expect(report.mode).toBe("revert");
    expect(report.companies[0]?.governance).toBe("restored");
  });

  it("without a recorded value, removes only KyoubeAI's exact entries", async () => {
    const api = new FakeApi();
    await applyPass(deps(api), EMPTY_STATE);
    await revertPass(deps(api), EMPTY_STATE);
    expect(api.governance.c1).toEqual({});
  });

  it("with empty recorded governance (pre-existing people-only), makes no governance write", async () => {
    const api = new FakeApi();
    // Start with all five kinds already set to people-only
    api.governance.c1 = {
      request_confirmation: { defaultPolicy: "human_only", cap: "human_only" },
      request_checkbox_confirmation: { defaultPolicy: "human_only", cap: "human_only" },
      request_item_verdicts: { defaultPolicy: "human_only", cap: "human_only" },
      ask_user_questions: { defaultPolicy: "human_only", cap: "human_only" },
      suggest_tasks: { defaultPolicy: "human_only", cap: "human_only" },
    };
    // Run apply first to record empty previous
    const applied = await applyPass(deps(api), EMPTY_STATE);
    api.calls = [];
    // Now run revert with that state
    const { report, state } = await revertPass(deps(api), applied.state);
    // No governance write should happen since we're just restoring what was there
    expect(api.calls.filter((call) => call.startsWith("governance"))).toEqual([]);
    // Governance should be unchanged (still all people-only)
    expect(api.governance.c1).toEqual({
      request_confirmation: { defaultPolicy: "human_only", cap: "human_only" },
      request_checkbox_confirmation: { defaultPolicy: "human_only", cap: "human_only" },
      request_item_verdicts: { defaultPolicy: "human_only", cap: "human_only" },
      ask_user_questions: { defaultPolicy: "human_only", cap: "human_only" },
      suggest_tasks: { defaultPolicy: "human_only", cap: "human_only" },
    });
    expect(state.governancePrevious).toEqual({});
  });
});
