import { describe, expect, it } from "vitest";
import { CORE_AGENT_PAGE_SCOPE, agentRedirectTarget, coreAgentPage, coreAvatarCss } from "../src/ui/agent-route.js";
import { assignTask, BoardApiError, boardPost, setAgentOnDuty } from "../src/ui/board-api.js";

describe("the core agent page", () => {
  it("recognises agent URLs and their tab, but not the list or the new-agent page", () => {
    expect(coreAgentPage("/BAP/agents/ai-manager")).toEqual({ ref: "ai-manager", tab: "dashboard" });
    expect(coreAgentPage("/BAP/agents/ai-manager/instructions")).toEqual({ ref: "ai-manager", tab: "instructions" });
    expect(coreAgentPage("/BAP/agents/ai-manager/runs/run-1")).toBeNull();
    expect(coreAgentPage("/BAP/agents/all")).toBeNull();
    expect(coreAgentPage("/BAP/agents/new")).toBeNull();
    expect(coreAgentPage("/BAP/team/ai-manager")).toBeNull();
  });

  it("sends only the default view to the profile, and keeps the classic view on request", () => {
    expect(agentRedirectTarget("/BAP/agents/ai-manager", "")).toBe("/team/ai-manager");
    expect(agentRedirectTarget("/BAP/agents/ai-manager/dashboard", "")).toBe("/team/ai-manager");
    expect(agentRedirectTarget("/BAP/agents/ai-manager/dashboard/", "?x=1")).toBe("/team/ai-manager");
    expect(agentRedirectTarget("/BAP/agents/ai-manager/dashboard", "?classic=1")).toBeNull();
    expect(agentRedirectTarget("/BAP/agents/ai-manager/configuration", "")).toBeNull();
    expect(agentRedirectTarget("/BAP/agents/all", "")).toBeNull();
  });

  it("paints the agent's character over the header icon of that agent only", () => {
    const css = coreAvatarCss({ name: "AI Delivery Lead", icon: "rocket" });
    expect(css).toContain(CORE_AGENT_PAGE_SCOPE);
    expect(css).toContain('button[data-slot="popover-trigger"]:has(> svg.lucide-rocket)');
    expect(css).toContain('url("data:image/svg+xml;charset=utf-8,%3Csvg');
    expect(css).toContain("var(--kyoube-tile-sky");
    // No icon, or one the core does not know, renders as the core's default: bot.
    expect(coreAvatarCss({ name: "AI Manager", icon: null })).toContain("svg.lucide-bot");
    expect(coreAvatarCss({ name: "AI Manager", icon: "not-real" })).toContain("svg.lucide-bot");
  });
});

describe("board API calls", () => {
  function stub(status: number, body: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(body === undefined ? "" : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("pauses and resumes through the documented routes, as the signed-in person", async () => {
    const { calls, fetchImpl } = stub(200, { id: "a1", status: "paused" });
    await setAgentOnDuty("a1", false, fetchImpl);
    await setAgentOnDuty("a1", true, fetchImpl);
    expect(calls.map((c) => c.url)).toEqual(["/api/agents/a1/pause", "/api/agents/a1/resume"]);
    expect(calls[0]!.init).toMatchObject({ method: "POST", credentials: "include" });
  });

  it("creates a task assigned to the agent, ready to start", async () => {
    const { calls, fetchImpl } = stub(201, { id: "i1", identifier: "BAP-12" });
    const issue = await assignTask("c1", "a1", "  Draft the newsletter ", "", fetchImpl);
    expect(issue.identifier).toBe("BAP-12");
    expect(calls[0]!.url).toBe("/api/companies/c1/issues");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ title: "Draft the newsletter", status: "todo", assigneeAgentId: "a1" });
  });

  it("reports the server's own message when the core refuses", async () => {
    const { fetchImpl } = stub(403, { error: "Board access required" });
    await expect(boardPost("/api/agents/a1/pause", {}, fetchImpl)).rejects.toEqual(new BoardApiError("Board access required", 403));
    const { fetchImpl: bare } = stub(500, undefined);
    await expect(boardPost("/api/x", {}, bare)).rejects.toThrow("The server answered 500");
  });
});
