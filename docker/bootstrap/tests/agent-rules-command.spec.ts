import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GuardReport, RulesApi } from "../src/agent-rules/api.js";
import { EMPTY_STATE, writeState } from "../src/agent-rules/state.js";
import { agentRulesEnabled, PASS_INTERVAL_MS, PLUGIN_POLL_MS, PLUGIN_WAIT_MS, runAgentRules } from "../src/commands/agent-rules.js";
import { NO_KEY_EXIT_CODE } from "../src/commands/ensure-plugins.js";
import type { KyoubeConfig } from "../src/config.js";

const QUIET_GUARD: GuardReport = { managers: [], updated: [], skipped: [], failures: [], selfTest: { status: "not_applicable", detail: "" } };

function api(overrides: Partial<RulesApi> = {}): RulesApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listCompanies: async () => [{ id: "c1", name: "Acme" }],
    listAgents: async () => [],
    getGovernance: async () => ({ request_confirmation: { defaultPolicy: "human_only", cap: "human_only" }, request_checkbox_confirmation: { defaultPolicy: "human_only", cap: "human_only" }, request_item_verdicts: { defaultPolicy: "human_only", cap: "human_only" }, ask_user_questions: { defaultPolicy: "human_only", cap: "human_only" }, suggest_tasks: { defaultPolicy: "human_only", cap: "human_only" } }),
    setGovernance: async () => { calls.push("governance"); },
    getInstructionsBundle: async () => ({ mode: "managed", entryFile: "AGENTS.md", hasEntryFile: true, editable: true, legacyPromptTemplateActive: false }),
    readInstructionsFile: async () => ({ content: "", revisionId: null }),
    writeInstructionsFile: async () => {},
    reconcileGuard: async () => { calls.push("guard"); return QUIET_GUARD; },
    revertGuard: async () => { calls.push("unguard"); return { reverted: [], failures: [] }; },
    pluginReady: async () => true,
    ...overrides,
  };
}

async function setup(fake = api()) {
  const home = await mkdtemp(path.join(os.tmpdir(), "kyoube-cmd-"));
  const config = { version: 1, home, paperclipApiUrl: "http://app:3100", dataDatabaseUrl: "x", hermesHome: "x", pluginRoot: "x", publicUrl: "x", imageVersion: "x" } as KyoubeConfig;
  const lines: string[] = [];
  const sleeps: number[] = [];
  const deps = {
    readConfig: async () => config,
    createApi: () => fake,
    waitForHealth: async () => {},
    sleep: async (ms: number) => { sleeps.push(ms); },
    log: (line: string) => lines.push(line),
    now: () => new Date("2026-10-01T10:00:00Z"),
  };
  return { home, lines, sleeps, deps, fake };
}

const ENV = { KYOUBE_BOARD_API_KEY: "k" };

describe("agentRulesEnabled", () => {
  it("is on unless KYOUBE_AGENT_RULES is off", () => {
    expect(agentRulesEnabled({})).toBe(true);
    expect(agentRulesEnabled({ KYOUBE_AGENT_RULES: "on" })).toBe(true);
    expect(agentRulesEnabled({ KYOUBE_AGENT_RULES: " OFF " })).toBe(false);
  });
});

describe("runAgentRules", () => {
  it("needs a mode", async () => {
    const { deps, lines } = await setup();
    expect(await runAgentRules([], {}, ENV, deps)).toBe(1);
    expect(lines[0]).toContain("usage: kyoube agent-rules");
  });

  it("does nothing when switched off", async () => {
    const { deps, lines, fake } = await setup();
    expect(await runAgentRules([], { watch: true }, { ...ENV, KYOUBE_AGENT_RULES: "off" }, deps)).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(lines).toEqual(["kyoube: agent rules are off (KYOUBE_AGENT_RULES=off); nothing to do"]);
  });

  it("--once runs one pass, saves the state file and logs the summary", async () => {
    const { deps, lines, home, fake } = await setup();
    expect(await runAgentRules([], { once: true }, ENV, deps)).toBe(0);
    expect(fake.calls).toEqual(["guard"]);
    expect(lines).toEqual(["kyoube: agent rules: 1 company, 0 changes, 0 skipped, 0 failures; self-test not applicable"]);
    const saved = JSON.parse(await readFile(path.join(home, ".kyoube", "agent-rules.json"), "utf8"));
    expect(saved.lastPass.mode).toBe("apply");
  });

  it("--once exits 1 and prints each failure", async () => {
    const { deps, lines } = await setup(api({ reconcileGuard: async () => { throw new Error("boom"); } }));
    expect(await runAgentRules([], { once: true }, ENV, deps)).toBe(1);
    expect(lines).toContain("kyoube: agent rules: Acme: guard failed: boom");
  });

  it("--once without a board key says so", async () => {
    const { deps } = await setup();
    expect(await runAgentRules([], { once: true }, {}, deps)).toBe(NO_KEY_EXIT_CODE);
  });

  it("--watch passes once a minute and logs an unchanged summary only once", async () => {
    const { deps, lines, sleeps, fake } = await setup();
    expect(await runAgentRules([], { watch: true }, ENV, { ...deps, maxPasses: 3 })).toBe(0);
    expect(fake.calls).toEqual(["guard", "guard", "guard"]);
    expect(sleeps).toEqual([PASS_INTERVAL_MS, PASS_INTERVAL_MS]);
    expect(lines).toHaveLength(1);
  });

  it("waits for the plugin worker before a pass", async () => {
    let probes = 0;
    const { deps, lines, sleeps, fake } = await setup(api({ pluginReady: async () => ++probes > 2 }));
    expect(await runAgentRules([], { watch: true }, ENV, { ...deps, maxPasses: 1 })).toBe(0);
    expect(sleeps).toEqual([PLUGIN_POLL_MS, PLUGIN_POLL_MS]);
    expect(fake.calls).toEqual(["guard"]);
    expect(lines).toEqual(["kyoube: agent rules: 1 company, 0 changes, 0 skipped, 0 failures; self-test not applicable"]);
  });

  it("runs the pass anyway once the plugin has had its time, so a plugin that never comes up is reported", async () => {
    const { deps, sleeps, fake } = await setup(api({ pluginReady: async () => false }));
    expect(await runAgentRules([], { once: true }, ENV, deps)).toBe(0);
    expect(sleeps).toHaveLength(PLUGIN_WAIT_MS / PLUGIN_POLL_MS);
    expect(fake.calls).toEqual(["guard"]);
  });

  it("off reverts even while the switch is off", async () => {
    const { deps, lines, fake } = await setup();
    expect(await runAgentRules(["off"], {}, { ...ENV, KYOUBE_AGENT_RULES: "off" }, deps)).toBe(0);
    // No recorded previous values, so the five people-only entries are removed: one governance write.
    expect(fake.calls).toEqual(["governance", "unguard"]);
    expect(lines[0]).toBe("kyoube: agent rules removed: 1 company, 1 change, 0 failures");
  });

  it("--once aborts before any pass if state file is unwritable", async () => {
    const { deps, lines, home, fake } = await setup();
    // Make .kyoube a regular file so mkdir fails
    await writeFile(path.join(home, ".kyoube"), "blocked");
    expect(await runAgentRules([], { once: true }, ENV, deps)).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(lines.some((line) => line.includes("agent rules pass failed"))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("--once aborts before any remote write when the state directory is read-only", async () => {
    const { deps, lines, home, fake } = await setup();
    const stateDir = path.join(home, ".kyoube");
    await mkdir(stateDir);
    await chmod(stateDir, 0o555);
    try {
      expect(await runAgentRules([], { once: true }, ENV, deps)).toBe(1);
      expect(fake.calls).toEqual([]);
      expect(lines.some((line) => line.includes("agent rules pass failed"))).toBe(true);
    } finally {
      await chmod(stateDir, 0o755);
    }
  });

  it("keeps the governance another pass saved while this one ran", async () => {
    let statePath = "";
    // This pass finds the five kinds already people-only, so it records nothing for c1; the other
    // pass, which set them, recorded what was there before.
    const { deps, home } = await setup(api({
      reconcileGuard: async () => {
        await writeState(statePath, { ...EMPTY_STATE, governancePrevious: { c1: { request_confirmation: null } } });
        return QUIET_GUARD;
      },
    }));
    statePath = path.join(home, ".kyoube", "agent-rules.json");
    expect(await runAgentRules([], { once: true }, ENV, deps)).toBe(0);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    expect(saved.governancePrevious).toEqual({ c1: { request_confirmation: null } });
    expect(saved.lastPass.mode).toBe("apply");
  });

  it.skipIf(process.getuid?.() === 0)("saves its own record when it cannot re-read the file, and says so", async () => {
    let statePath = "";
    const { deps, lines, home } = await setup(api({
      reconcileGuard: async () => {
        await writeState(statePath, EMPTY_STATE);
        await chmod(statePath, 0o000);
        return QUIET_GUARD;
      },
    }));
    statePath = path.join(home, ".kyoube", "agent-rules.json");
    expect(await runAgentRules([], { once: true }, ENV, deps)).toBe(1);
    expect(lines.some((line) => line.startsWith(`kyoube: agent rules: could not save ${statePath}: EACCES`))).toBe(true);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    expect(saved.governancePrevious).toEqual({ c1: {} });
    expect(saved.lastPass.mode).toBe("apply");
  });

  it("off saves its record as it is, so the governance it put back is forgotten", async () => {
    const { deps, home } = await setup(api({ getGovernance: async () => ({ request_confirmation: { cap: "anyone" } }) }));
    const statePath = path.join(home, ".kyoube", "agent-rules.json");
    expect(await runAgentRules([], { once: true }, ENV, deps)).toBe(0);
    expect(JSON.parse(await readFile(statePath, "utf8")).governancePrevious.c1.request_confirmation).toEqual({ cap: "anyone" });
    expect(await runAgentRules(["off"], {}, ENV, deps)).toBe(0);
    expect(JSON.parse(await readFile(statePath, "utf8")).governancePrevious).toEqual({});
  });
});
