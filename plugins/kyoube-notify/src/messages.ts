import type { InteractionLike, IssueLike } from "./routing.js";
import type { PushMessage } from "./webpush/send.js";

export const TITLE_MAX = 120;
export const BODY_MAX = 160;

export interface ApprovalLike {
  id: string;
  type: string;
  payload?: Record<string, unknown> | null;
}

/** Shortens to at most `max` characters (code points, so an emoji is never cut in half), ending in "…". */
export function clip(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

const ref = (issue: IssueLike) => issue.identifier || issue.id;
const issueUrl = (prefix: string, issue: IssueLike) => `/${prefix}/issues/${encodeURIComponent(ref(issue))}`;
const message = (title: string, body: string, url: string, tag: string, urgency: PushMessage["urgency"]): PushMessage => ({ title: clip(title, TITLE_MAX), body: clip(body, BODY_MAX), url, tag, urgency });

/** What an agent asked, when the question carries no title of its own. */
const QUESTION_SUBJECT: Record<string, string> = {
  suggest_tasks: "some suggested tasks",
  ask_user_questions: "some questions",
  request_confirmation: "a confirmation",
  request_checkbox_confirmation: "a checklist",
  request_item_verdicts: "a verdict on some items",
  connection_intent: "a connection",
};

export function askMessage(input: { prefix: string; agentName: string; interaction: InteractionLike; issue: IssueLike }): PushMessage {
  const subject = input.interaction.title || input.interaction.summary || QUESTION_SUBJECT[input.interaction.kind] || "a question";
  return message(`${input.agentName} is asking: ${subject}`, [input.issue.identifier, input.issue.title].filter(Boolean).join(" · "), issueUrl(input.prefix, input.issue), `issue:${input.issue.id}`, "high");
}

const APPROVAL_LABELS: Record<string, string> = {
  hire_agent: "Hire an agent",
  approve_ceo_strategy: "CEO strategy",
  budget_override_required: "Budget override",
  request_board_approval: "Board approval",
};

export function approvalMessage(input: { prefix: string; approval: ApprovalLike; agentName: string | null }): PushMessage {
  const label = APPROVAL_LABELS[input.approval.type] ?? input.approval.type.replace(/_/g, " ");
  const name = typeof input.approval.payload?.name === "string" ? input.approval.payload.name : null;
  const who = input.agentName ? `requested by ${input.agentName}` : "requested by a person";
  const body = name ? `${name} · ${who}` : `${who.charAt(0).toUpperCase()}${who.slice(1)}`;
  return message(`Approval needed: ${label}`, body, `/${input.prefix}/approvals/${encodeURIComponent(input.approval.id)}`, `approval:${input.approval.id}`, "high");
}

export function statusMessage(input: { prefix: string; issue: IssueLike; kind: "done" | "blocked" }): PushMessage {
  return message(`${input.kind === "done" ? "Done" : "Blocked"}: ${input.issue.title}`, ref(input.issue), issueUrl(input.prefix, input.issue), `issue:${input.issue.id}`, "normal");
}

export function failureMessage(input: { prefix: string; agentName: string; agentId: string; runId: string }): PushMessage {
  return message(`${input.agentName}'s run failed`, "Open the run to see what went wrong.", `/${input.prefix}/agents/${encodeURIComponent(input.agentId)}/runs/${encodeURIComponent(input.runId)}`, `agent:${input.agentId}`, "normal");
}

export function commentMessage(input: { prefix: string; authorName: string; issue: IssueLike }): PushMessage {
  return message(`${input.authorName} commented on ${ref(input.issue)}`, input.issue.title, issueUrl(input.prefix, input.issue), `issue:${input.issue.id}`, "normal");
}

export function testMessage(): PushMessage {
  return message("KyoubeAI test", "Notifications work on this device.", "/", "kyoube-test", "normal");
}
