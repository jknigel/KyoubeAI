import { describe, expect, it } from "vitest";
import { MAX_PLAINTEXT } from "../src/webpush/encrypt.js";
import { BODY_MAX, TITLE_MAX, approvalMessage, askMessage, clip, commentMessage, failureMessage, statusMessage, testMessage } from "../src/messages.js";

const issue = { id: "11111111-1111-4111-8111-111111111111", identifier: "ACM-1", title: "Launch post", status: "done" };

describe("messages", () => {
  it("says who is asking what, and links to the task", () => {
    expect(askMessage({ prefix: "ACM", agentName: "Ada", interaction: { id: "q1", kind: "request_confirmation", status: "pending", title: "Ship it?" }, issue })).toEqual({
      title: "Ada is asking: Ship it?", body: "ACM-1 · Launch post", url: "/ACM/issues/ACM-1", tag: `issue:${issue.id}`, urgency: "high",
    });
    expect(askMessage({ prefix: "ACM", agentName: "Ada", interaction: { id: "q1", kind: "ask_user_questions", status: "pending" }, issue }).title).toBe("Ada is asking: some questions");
  });

  it("never carries question summaries, even if present", () => {
    const msg = askMessage({ prefix: "ACM", agentName: "Ada", interaction: { id: "q1", kind: "request_confirmation", status: "pending", summary: "Please review the attached contract terms…" }, issue });
    expect(msg.title).toBe("Ada is asking: a confirmation");
    expect(msg.body).not.toContain("contract");
    expect(msg.body).not.toContain("summary");
  });

  it("names the approval and who asked for it", () => {
    expect(approvalMessage({ prefix: "ACM", approval: { id: "a1", type: "hire_agent", payload: { name: "Mo", role: "designer" } }, agentName: "Ada" })).toEqual({
      title: "Approval needed: Hire an agent", body: "Mo · requested by Ada", url: "/ACM/approvals/a1", tag: "approval:a1", urgency: "high",
    });
    expect(approvalMessage({ prefix: "ACM", approval: { id: "a2", type: "something_new", payload: null }, agentName: null }).title).toBe("Approval needed: something new");
    expect(approvalMessage({ prefix: "ACM", approval: { id: "a2", type: "budget_override_required" }, agentName: null }).body).toBe("Requested by a person");
  });

  it("covers done, blocked, failures, comments and the test", () => {
    expect(statusMessage({ prefix: "ACM", issue, kind: "done" })).toMatchObject({ title: "Done: Launch post", body: "ACM-1", url: "/ACM/issues/ACM-1", urgency: "normal" });
    expect(statusMessage({ prefix: "ACM", issue, kind: "blocked" }).title).toBe("Blocked: Launch post");
    expect(failureMessage({ prefix: "ACM", agentName: "Ada", agentId: "ag1", runId: "r1" })).toEqual({
      title: "Ada's run failed", body: "Open the run to see what went wrong.", url: "/ACM/agents/ag1/runs/r1", tag: "agent:ag1", urgency: "normal",
    });
    expect(commentMessage({ prefix: "ACM", authorName: "Lin", issue })).toMatchObject({ title: "Lin commented on ACM-1", body: "Launch post", tag: `issue:${issue.id}` });
    expect(testMessage()).toEqual({ title: "KyoubeAI test", body: "Notifications work on this device.", url: "/", tag: "kyoube-test", urgency: "normal" });
  });

  it("falls back to the task id when the task has no identifier", () => {
    expect(statusMessage({ prefix: "ACM", issue: { ...issue, identifier: null }, kind: "done" }).url).toBe(`/ACM/issues/${issue.id}`);
  });

  it("clips long text and stays small", () => {
    const long = "🙂 Ship the very long launch post ".repeat(400);
    const message = askMessage({ prefix: "ACM", agentName: long, interaction: { id: "q", kind: "request_confirmation", status: "pending", title: long }, issue: { ...issue, title: long } });
    expect([...message.title].length).toBeLessThanOrEqual(TITLE_MAX);
    expect([...message.body].length).toBeLessThanOrEqual(BODY_MAX);
    expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(MAX_PLAINTEXT);
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("abc", 4)).toBe("abc");
  });
});
