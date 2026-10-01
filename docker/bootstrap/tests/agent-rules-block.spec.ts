import { describe, expect, it } from "vitest";
import { applyRules, END_MARKER, HANDOFFS_SECTION, removeRules, RULES_BLOCK } from "../src/agent-rules/block.js";

/** The core's default AGENTS.md (server/src/onboarding-assets/default, 2026.916.1), as the rebrand leaves it, abridged. */
const CORE_DEFAULT = [
  "You are an agent at KyoubeAI company.",
  "",
  "## Execution Contract",
  "",
  "- Start actionable work in the same heartbeat.",
  "- Keep the work moving until it is done. If you need QA to review it, ask them. If you need your boss to review it, ask them.",
  "",
  "Do not let work sit here. You must always update your task with a comment.",
  "",
].join("\n");

function changed(content: string): string {
  const edit = applyRules(content);
  if (edit.kind !== "changed") throw new Error(`expected a change, got ${edit.kind}`);
  return edit.content;
}

describe("applyRules", () => {
  it("puts the block first, drops the core's handoff sentences and adds a Handoffs section", () => {
    const next = changed(CORE_DEFAULT);
    expect(next.startsWith(`${RULES_BLOCK}\n\nYou are an agent at KyoubeAI company.`)).toBe(true);
    expect(next).toContain("- Keep the work moving until it is done.\n");
    expect(next).not.toContain("If you need QA to review it");
    expect(next.endsWith(`\n\n${HANDOFFS_SECTION}`)).toBe(true);
  });

  it("is a no-op on its own output", () => {
    expect(applyRules(changed(CORE_DEFAULT))).toEqual({ kind: "unchanged" });
  });

  it("replaces an outdated or edited block and leaves everything around it byte for byte", () => {
    const old = `Intro\n<!-- kyoube:working-rules v0 old -->\nold text\n${END_MARKER}\nOutro\n\n## Handoffs\n\nQA reviews code.\n`;
    expect(changed(old)).toBe(`Intro\n${RULES_BLOCK}\nOutro\n\n## Handoffs\n\nQA reviews code.\n`);
  });

  it("keeps YAML frontmatter first", () => {
    const withFrontmatter = "---\nname: CTO\nreportsTo: ceo\n---\nYou are the CTO.\n\n## Handoffs\n\nNone.\n";
    expect(changed(withFrontmatter)).toBe(`---\nname: CTO\nreportsTo: ceo\n---\n${RULES_BLOCK}\n\nYou are the CTO.\n\n## Handoffs\n\nNone.\n`);
  });

  it("writes Windows line endings into a CRLF file and is stable on it", () => {
    const crlf = "You are an agent.\r\n\r\n## Handoffs\r\n\r\nNone.\r\n";
    const next = changed(crlf);
    expect(next.startsWith(`${RULES_BLOCK.replaceAll("\n", "\r\n")}\r\n\r\nYou are an agent.`)).toBe(true);
    expect(next.replaceAll("\r\n", "").includes("\n")).toBe(false);
    expect(applyRules(next)).toEqual({ kind: "unchanged" });
  });

  it("refuses to guess about incomplete or repeated markers", () => {
    expect(applyRules("<!-- kyoube:working-rules v1. x -->\nno end\n").kind).toBe("corrupt");
    expect(applyRules(`${RULES_BLOCK}\n${RULES_BLOCK}\n`).kind).toBe("corrupt");
    expect(applyRules(`${END_MARKER}\n<!-- kyoube:working-rules v1. x -->\n`).kind).toBe("corrupt");
  });

  it("leaves reworded handoff text and an existing Handoffs section alone", () => {
    const custom = "If you need QA to review it, ask the QA agent.\n\n## Handoffs\n\nQA Agent tests every change.\n";
    const next = changed(custom);
    expect(next).toContain("If you need QA to review it, ask the QA agent.");
    expect(next.match(/^## Handoffs$/gm)?.length).toBe(1);
  });

  it("handles an empty file", () => {
    expect(changed("")).toBe(`${RULES_BLOCK}\n\n${HANDOFFS_SECTION}`);
  });
});

describe("removeRules", () => {
  it("removes the block and the blank line after it, and nothing else", () => {
    const original = "You are an agent.\n\n## Handoffs\n\nNone.\n";
    expect(removeRules(changed(original))).toEqual({ kind: "changed", content: original });
  });

  it("is a no-op without a block", () => {
    expect(removeRules("You are an agent.\n")).toEqual({ kind: "unchanged" });
  });

  it("refuses to guess about incomplete markers", () => {
    expect(removeRules("<!-- kyoube:working-rules v1. x -->\n").kind).toBe("corrupt");
  });
});
