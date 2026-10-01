import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { failureLines, summarize, type PassReport } from "../src/agent-rules/report.js";
import { assertStateWritable, EMPTY_STATE, mergeGovernancePrevious, readState, resolveStatePath, writeState } from "../src/agent-rules/state.js";

const report: PassReport = {
  at: "2026-10-01T10:00:00.000Z",
  mode: "apply",
  failures: [],
  companies: [{
    companyId: "c1",
    name: "Acme",
    governance: "set",
    guard: { managers: ["m"], updated: ["m"], skipped: [], failures: [], selfTest: { status: "pass", detail: "ok" } },
    rulesUpdated: ["Writer"],
    skipped: [{ agent: "Bot", reason: "it still uses the legacy prompt template" }],
    failures: [{ step: "rules", agent: "Coder", error: "PUT failed" }],
    writes: 3,
  }],
};

describe("report lines", () => {
  it("summarizes a pass in one stable line", () => {
    expect(summarize(report)).toBe("kyoube: agent rules: 1 company, 3 changes, 1 skipped, 1 failure; self-test pass");
    expect(summarize({ ...report, mode: "revert" })).toBe("kyoube: agent rules removed: 1 company, 3 changes, 1 failure");
  });

  it("lists every failure with its company and agent", () => {
    expect(failureLines({ ...report, failures: [{ step: "list", error: "core down" }] })).toEqual([
      "kyoube: agent rules: list failed: core down",
      "kyoube: agent rules: Acme / Coder: rules failed: PUT failed",
    ]);
  });
});

describe("state file", () => {
  it("lives in .kyoube under the home volume", () => {
    expect(resolveStatePath("/kyoubeai")).toBe("/kyoubeai/.kyoube/agent-rules.json");
  });

  it("reads as empty when missing, and as empty with a warning when malformed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-rules-"));
    const file = path.join(dir, ".kyoube", "agent-rules.json");
    expect(await readState(file)).toEqual(EMPTY_STATE);
    await writeState(file, EMPTY_STATE);
    await writeFile(file, "{not json");
    const warnings: string[] = [];
    expect(await readState(file, (line) => warnings.push(line))).toEqual(EMPTY_STATE);
    expect(warnings[0]).toContain("ignoring malformed");
  });

  it("round-trips and leaves no temporary file behind", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-rules-"));
    const file = path.join(dir, ".kyoube", "agent-rules.json");
    const state = { version: 1 as const, governancePrevious: { c1: { suggest_tasks: null } }, lastPass: report };
    await writeState(file, state);
    expect(await readState(file)).toEqual(state);
    expect(await readdir(path.dirname(file))).toEqual(["agent-rules.json"]);
    expect((await readFile(file, "utf8")).endsWith("\n")).toBe(true);
  });
});

describe("mergeGovernancePrevious", () => {
  it("keeps the value already on disk, whichever of two passes recorded it", () => {
    expect(mergeGovernancePrevious({ c1: { request_confirmation: null } }, { c1: {} })).toEqual({ c1: { request_confirmation: null } });
    expect(mergeGovernancePrevious({ c1: {} }, { c1: { request_confirmation: null } })).toEqual({ c1: { request_confirmation: null } });
    expect(mergeGovernancePrevious({ c1: { suggest_tasks: { cap: "anyone" } } }, { c1: { suggest_tasks: null, ask_user_questions: null } }))
      .toEqual({ c1: { suggest_tasks: { cap: "anyone" }, ask_user_questions: null } });
  });

  it("keeps companies present in only one input", () => {
    expect(mergeGovernancePrevious({ c1: { request_confirmation: null } }, { c2: { suggest_tasks: null } }))
      .toEqual({ c1: { request_confirmation: null }, c2: { suggest_tasks: null } });
  });
});

describe("assertStateWritable", () => {
  it("creates the directory and leaves nothing behind", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-rules-"));
    const file = path.join(dir, ".kyoube", "agent-rules.json");
    await assertStateWritable(file);
    expect(await readdir(path.dirname(file))).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("rejects for a directory it cannot write, and leaves the state file untouched", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kyoube-rules-"));
    const stateDir = path.join(dir, ".kyoube");
    const file = path.join(stateDir, "agent-rules.json");
    await mkdir(stateDir);
    await writeFile(file, "{\"version\":1}\n");
    await chmod(stateDir, 0o555);
    try {
      await expect(assertStateWritable(file)).rejects.toThrow(/EACCES/);
      expect(await readFile(file, "utf8")).toBe("{\"version\":1}\n");
      expect(await readdir(stateDir)).toEqual(["agent-rules.json"]);
    } finally {
      await chmod(stateDir, 0o755);
    }
  });
});
