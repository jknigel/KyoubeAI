import { describe, expect, it } from "vitest";
import {
  LEGACY_ENV_KEYS, agentRulesChecks, claudeCredentialDetail, exposureWarning, harnessChecks, harnessesInUseCheck, legacyEnvCheck, legacyHomeLinkCheck, skillsCheck, systemPackagesCheck,
} from "../src/commands/doctor.js";
import { HARNESSES, type HarnessStatus } from "../src/harnesses.js";
import { EMPTY_STATE, type AgentRulesState } from "../src/agent-rules/state.js";
import type { PassReport } from "../src/agent-rules/report.js";

const both = [{ slug: "kyoube-data", key: "plugin/kyoube-apps/kyoube-data", name: "Kyoube Data" }, { slug: "kyoube-apps", key: "plugin/kyoube-apps/kyoube-apps", name: "Kyoube Apps" }];

describe("skillsCheck", () => {
  it("passes when every company's library holds both Kyoube skills", () => {
    const check = skillsCheck([{ id: "c1", name: "Acme" }, { id: "c2", name: "Beta" }], new Map([["c1", both], ["c2", both]]));
    expect(check).toMatchObject({ name: "skills", ok: true });
    expect(check.detail).toContain("2/2 companies");
  });

  it("fails and names the companies that are missing a Kyoube skill", () => {
    const check = skillsCheck([{ id: "c1", name: "Acme" }, { id: "c2", name: "Beta" }], new Map([["c1", both], ["c2", [both[0]!]]]));
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("Beta");
    expect(check.detail).toContain("kyoube-apps");
    expect(check.detail).not.toContain("Acme");
  });

  it("passes with a note when there is no company yet", () => {
    const check = skillsCheck([], new Map());
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("no company");
  });

  it("recognises a skill by its library key when the slug was changed", () => {
    const renamed = both.map((skill) => ({ ...skill, slug: "renamed-by-admin" }));
    expect(skillsCheck([{ id: "c1", name: "Acme" }], new Map([["c1", renamed]])).ok).toBe(true);
  });
});

describe("exposureWarning", () => {
  it("only warns for public exposure without https", () => {
    expect(exposureWarning({}, "http://localhost:3100")).toBeNull();
    expect(exposureWarning({ PAPERCLIP_DEPLOYMENT_EXPOSURE: "public" }, "https://ai.example.com")).toBeNull();
    expect(exposureWarning({ PAPERCLIP_DEPLOYMENT_EXPOSURE: "public" }, "http://ai.example.com")).toContain("https");
  });

  it("treats an explicit private exposure the same as the default", () => {
    expect(exposureWarning({ PAPERCLIP_DEPLOYMENT_EXPOSURE: "private" }, "http://localhost:3100")).toBeNull();
  });

  it("names the offending public URL value in the warning", () => {
    const warning = exposureWarning({ PAPERCLIP_DEPLOYMENT_EXPOSURE: "public" }, "http://ai.example.com");
    expect(warning).toContain("http://ai.example.com");
  });
});

describe("legacyEnvCheck", () => {
  it("reports none when compose passed no legacy keys", () => {
    expect(legacyEnvCheck({})).toEqual({ name: "legacy env", ok: true, detail: "none" });
    expect(legacyEnvCheck({ KYOUBE_LEGACY_ENV_KEYS: "  " }).detail).toBe("none");
  });

  it("names each legacy key and its replacement", () => {
    const check = legacyEnvCheck({ KYOUBE_LEGACY_ENV_KEYS: "PAPERCLIP_PUBLIC_URL PAPERCLIP_VERSION" });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("PAPERCLIP_PUBLIC_URL -> KYOUBE_PUBLIC_URL");
    expect(check.detail).toContain("PAPERCLIP_VERSION -> KYOUBE_CORE_VERSION");
    expect(check.detail).toContain("migrate-from-0.1.sh");
  });

  it("maps the three keys the compose file still accepts", () => {
    expect(LEGACY_ENV_KEYS).toEqual({
      PAPERCLIP_PUBLIC_URL: "KYOUBE_PUBLIC_URL",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "KYOUBE_DEPLOYMENT_EXPOSURE",
      PAPERCLIP_VERSION: "KYOUBE_CORE_VERSION",
    });
  });
});

describe("legacyHomeLinkCheck", () => {
  it("is quiet without the migration marker", async () => {
    expect(await legacyHomeLinkCheck("/kyoubeai", async () => false)).toEqual({ name: "legacy home link", ok: true, detail: "none" });
  });

  it("explains the compatibility link while the marker exists", async () => {
    const seen: string[] = [];
    const check = await legacyHomeLinkCheck("/kyoubeai", async (file) => { seen.push(file); return true; });
    expect(seen).toEqual(["/kyoubeai/.migrated-from-paperclip-home"]);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("/paperclip -> /kyoubeai");
    expect(check.detail).toContain("--check");
  });
});

function status(name: string, binPath: string | null, version: string | null = "1.0"): HarnessStatus {
  const spec = HARNESSES.find((entry) => entry.name === name)!;
  return {
    spec,
    path: binPath,
    origin: binPath === null ? null : binPath.startsWith("/kyoubeai/") ? "yours" : "core image",
    version: binPath === null ? null : version,
  };
}

describe("harnessChecks", () => {
  it("prints one ok line per installed harness", () => {
    const checks = harnessChecks([status("claude", "/usr/local/bin/claude"), status("pi", null), status("hermes", "/kyoubeai/.local/bin/hermes", null)]);
    expect(checks).toEqual([
      { name: "claude cli", ok: true, detail: "1.0 — core image (/usr/local/bin/claude)" },
      { name: "hermes cli", ok: true, detail: "does not run — reinstall: kyoube harness install hermes — yours (/kyoubeai/.local/bin/hermes)" },
    ]);
  });

  it("says how to install one when there is none", () => {
    expect(harnessChecks([status("claude", null)])).toEqual([
      { name: "harnesses", ok: true, detail: "none installed — see README → Harnesses (kyoube harness install <name>)" },
    ]);
  });
});

describe("harnessesInUseCheck", () => {
  const statuses = [status("claude", "/usr/local/bin/claude"), status("pi", null), status("hermes", null)];

  it("passes when every harness agents use is installed", () => {
    expect(harnessesInUseCheck(statuses, new Map([["claude_local", 2], ["process", 1]]))).toEqual({
      name: "harnesses in use", ok: true, detail: "claude_local (2), process (1)",
    });
  });

  it("fails and names the install command for a missing harness", () => {
    const check = harnessesInUseCheck(statuses, new Map([["pi_local", 6], ["hermes_local", 1]]));
    expect(check.ok).toBe(false);
    expect(check.detail).toBe("hermes_local (1), pi_local (6) — not installed: pi, hermes (kyoube harness install pi; kyoube harness install hermes)");
  });

  it("is quiet with no agents", () => {
    expect(harnessesInUseCheck(statuses, new Map())).toEqual({ name: "harnesses in use", ok: true, detail: "no agents yet" });
  });

  it("fails when an installed harness does not run", () => {
    const broken = [status("claude", "/usr/local/bin/claude"), status("pi", "/kyoubeai/.local/bin/pi"), status("hermes", "/kyoubeai/.local/bin/hermes", null)];
    expect(harnessesInUseCheck(broken, new Map([["hermes_local", 1], ["pi_local", 2]]))).toEqual({
      name: "harnesses in use", ok: false, detail: "hermes_local (1), pi_local (2) — does not run: hermes (kyoube harness install hermes)",
    });
  });

  it("does not fail for a broken harness no agent uses", () => {
    const broken = [status("claude", "/usr/local/bin/claude"), status("hermes", "/kyoubeai/.local/bin/hermes", null)];
    expect(harnessesInUseCheck(broken, new Map([["claude_local", 1]]))).toEqual({ name: "harnesses in use", ok: true, detail: "claude_local (1)" });
  });

  it("names both the missing and the broken harnesses, missing first", () => {
    const mixed = [status("claude", "/usr/local/bin/claude"), status("pi", null), status("hermes", "/kyoubeai/.local/bin/hermes", null)];
    expect(harnessesInUseCheck(mixed, new Map([["pi_local", 6], ["hermes_local", 1]]))).toEqual({
      name: "harnesses in use",
      ok: false,
      detail: "hermes_local (1), pi_local (6) — not installed: pi (kyoube harness install pi) — does not run: hermes (kyoube harness install hermes)",
    });
  });
});

describe("systemPackagesCheck", () => {
  it("lists the kept packages", () => {
    expect(systemPackagesCheck("ffmpeg\ntree\n", "ok 2", "/kyoubeai/.kyoube/apt-restore.log")).toEqual({
      name: "system packages", ok: true, detail: "2 kept: ffmpeg, tree",
    });
  });

  it("explains how to keep one when there is none", () => {
    expect(systemPackagesCheck(null, null, "/log").detail).toBe("none kept (sudo apt install <package> keeps one across restarts and updates)");
  });

  it("fails when the reinstall at start failed, naming the log", () => {
    const check = systemPackagesCheck("gone-in-trixie\n", "failed 100", "/kyoubeai/.kyoube/apt-restore.log");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("/kyoubeai/.kyoube/apt-restore.log");
    expect(check.detail).toContain("gone-in-trixie");
  });

  it("shortens a long list", () => {
    const list = Array.from({ length: 11 }, (_, i) => `pkg${i}`).join("\n");
    expect(systemPackagesCheck(list, "ok 0", "/log").detail).toBe("11 kept: pkg0, pkg1, pkg2, pkg3, pkg4, pkg5, pkg6, pkg7, … (3 more)");
  });
});

describe("claudeCredentialDetail", () => {
  it("reports when the unmanaged login's access token runs out", () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: "x", expiresAt: Date.UTC(2026, 9, 1, 12) } });
    expect(claudeCredentialDetail(raw, "/kyoubeai/.claude/.credentials.json")).toBe(
      "present (/kyoubeai/.claude/.credentials.json); access token until 2026-10-01T12:00:00.000Z, which Claude refreshes itself",
    );
  });

  it("says what the file is for when it is missing, and survives a broken file", () => {
    expect(claudeCredentialDetail(null, "/f")).toBe("not found (/f) — only agents without an AI connection use it");
    expect(claudeCredentialDetail("{", "/f")).toBe("present but unreadable (/f)");
  });
});

describe("agentRulesChecks", () => {
  const NOW = Date.parse("2026-10-01T10:00:00Z");
  const pass = (overrides: Partial<PassReport> = {}): PassReport => ({
    at: "2026-10-01T09:59:00.000Z",
    mode: "apply",
    failures: [],
    companies: [{
      companyId: "c1", name: "Acme", governance: "already", rulesUpdated: [], writes: 0, failures: [],
      skipped: [{ agent: "Bot", reason: "it still uses the legacy prompt template" }],
      guard: { managers: ["m"], updated: [], skipped: [], failures: [], selfTest: { status: "pass", detail: "ok" } },
    }],
    ...overrides,
  });
  const state = (lastPass: PassReport | null): AgentRulesState => ({ ...EMPTY_STATE, lastPass });

  it("is ok and quiet when switched off", () => {
    expect(agentRulesChecks({ KYOUBE_AGENT_RULES: "off" }, state(null), NOW)).toEqual([{ name: "agent rules", ok: true, detail: "off (KYOUBE_AGENT_RULES=off)" }]);
  });

  it("fails before the first pass", () => {
    expect(agentRulesChecks({}, state(null), NOW)[0]).toMatchObject({ name: "agent rules", ok: false });
  });

  it("is ok for a fresh, clean pass and lists skipped agents on their own line", () => {
    const [main, skipped] = agentRulesChecks({}, state(pass()), NOW);
    expect(main).toEqual({ name: "agent rules", ok: true, detail: "in force in 1 company (self-test passed in 1) as of 2026-10-01T09:59:00.000Z" });
    expect(skipped).toEqual({ name: "agent rules skipped", ok: true, detail: "Acme / Bot: it still uses the legacy prompt template" });
  });

  it("fails on a stale pass", () => {
    expect(agentRulesChecks({}, state(pass({ at: "2026-10-01T09:50:00.000Z" })), NOW)[0]?.detail).toContain("more than 5 minutes ago");
  });

  it("fails on a recorded failure and names the first", () => {
    const failing = pass();
    failing.companies[0]!.failures = [{ step: "guard", error: "the core no longer accepts POST /x (404): gone" }, { step: "rules", agent: "Coder", error: "nope" }];
    expect(agentRulesChecks({}, state(failing), NOW)[0]).toEqual({ name: "agent rules", ok: false, detail: "Acme: guard failed: the core no longer accepts POST /x (404): gone (and 1 more)" });
  });

  it("fails after off while the switch is still on", () => {
    expect(agentRulesChecks({}, state(pass({ mode: "revert" })), NOW)[0]?.detail).toContain("removed at");
  });
});
