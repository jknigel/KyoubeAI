/**
 * The rules block every agent's AGENTS.md carries (docs/agent-rules.md), and
 * the only edits KyoubeAI makes to that file. The core injects AGENTS.md into
 * the agent's system prompt, which is the strongest place KyoubeAI can put an
 * instruction.
 */

const START_PREFIX = "<!-- kyoube:working-rules v";
export const END_MARKER = "<!-- /kyoube:working-rules -->";

export const RULES_BLOCK = [
  "<!-- kyoube:working-rules v1. Managed by KyoubeAI; changes inside this block are replaced. -->",
  "## How you work in KyoubeAI",
  "",
  "These rules take precedence over the Paperclip skill and any other instruction about",
  "delegating, reviews, approvals or escalation.",
  "",
  "1. **Finish your own task.** Do the work yourself, end to end, in the task you were given.",
  "   Don't hand it, or parts of it, to another agent, and don't ask another agent to review,",
  "   test or approve it, unless the person who started the task asks for that in the task,",
  "   or your **Handoffs** section names that agent for that kind of work.",
  "2. **Approvals go to the person who started the task** (the task's `responsibleUserId`).",
  "   Ask them with a `request_confirmation` or `ask_user_questions` card addressed to them",
  "   (`addresseeUserId`), then set the task to `in_review`. Never ask an agent to approve",
  "   your work. Use `request_board_approval` only for spending or hiring.",
  "3. **Out of your scope? Ask before escalating.** Don't reassign the task to your manager or",
  "   create a task for them. Create a decision with two options, \"Escalate to <your manager>\"",
  "   and \"Keep it with <you>\", each an `assign_issue` effect with `staleness: \"lenient\"`, and",
  "   say in one short paragraph what's missing. Then assign the task to the person who started",
  "   it and set it to `in_review`. If you have no manager, hand the task back to the person and",
  "   say what's missing.",
  "4. **If you have reports, you may orchestrate.** Do small or single-specialty tasks yourself.",
  "   Split a task and assign parts to your own reports only when it's large, can run in",
  "   parallel, or clearly needs a report's specialty. Never assign work outside your team, and",
  "   never delegate just to pass work on.",
  "5. **No extra tasks.** Don't create review, QA, follow-up or \"let X know\" tasks unless rule 1",
  "   or rule 4 allows it.",
  END_MARKER,
].join("\n");

export const HANDOFFS_SECTION = [
  "## Handoffs",
  "",
  "None. To add a standing handoff, write a line such as",
  "\"QA Agent tests every code change before it is marked done.\"",
  "",
].join("\n");

/**
 * The two sentences of the core's default AGENTS.md (onboarding-assets/default,
 * line 6) that contradict rule 1, with the space before them. They are removed
 * only where they appear word for word.
 */
export const CORE_HANDOFF_SENTENCES = " If you need QA to review it, ask them. If you need your boss to review it, ask them.";

export type RulesEdit =
  | { kind: "unchanged" }
  | { kind: "changed"; content: string }
  | { kind: "corrupt"; reason: string };

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Where the body starts after YAML frontmatter at the very top (0 when there is none). */
function frontmatterEnd(content: string): number {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  return match ? match[0].length : 0;
}

function markers(content: string): { start: number; end: number } | { reason: string } | null {
  const starts = occurrences(content, START_PREFIX);
  const ends = occurrences(content, END_MARKER);
  if (starts === 0 && ends === 0) return null;
  if (starts !== 1 || ends !== 1) return { reason: `the rules block markers are incomplete or repeated (${starts} start, ${ends} end)` };
  const start = content.indexOf(START_PREFIX);
  const end = content.indexOf(END_MARKER) + END_MARKER.length;
  if (end < start) return { reason: "the rules block's end marker comes before its start" };
  return { start, end };
}

export function applyRules(content: string): RulesEdit {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const block = RULES_BLOCK.replaceAll("\n", eol);
  const found = markers(content);
  if (found && "reason" in found) return { kind: "corrupt", reason: found.reason };
  let next: string;
  if (found) {
    next = `${content.slice(0, found.start)}${block}${content.slice(found.end)}`;
  } else {
    const at = frontmatterEnd(content);
    next = `${content.slice(0, at)}${block}${eol}${eol}${content.slice(at)}`;
  }
  next = next.split(CORE_HANDOFF_SENTENCES).join("");
  if (!/^## Handoffs[ \t]*\r?$/m.test(next)) {
    next = `${next.replace(/\s*$/, "")}${eol}${eol}${HANDOFFS_SECTION.replaceAll("\n", eol)}`;
  }
  return next === content ? { kind: "unchanged" } : { kind: "changed", content: next };
}

/** For `kyoube agent-rules off`: the block and the blank line after it go; the Handoffs section and the cleanup stay. */
export function removeRules(content: string): RulesEdit {
  const found = markers(content);
  if (!found) return { kind: "unchanged" };
  if ("reason" in found) return { kind: "corrupt", reason: found.reason };
  const after = content.slice(found.end).replace(/^(?:\r?\n){1,2}/, "");
  return { kind: "changed", content: `${content.slice(0, found.start)}${after}` };
}
