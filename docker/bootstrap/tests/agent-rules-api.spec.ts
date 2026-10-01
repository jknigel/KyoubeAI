import { describe, expect, it } from "vitest";
import { createRulesApi, GUARD_PLUGIN_ROUTES } from "../src/agent-rules/api.js";
import { CoreApiError } from "../src/core-api.js";

interface Seen { url: string; method: string; body: unknown }

function fakeFetch(responder: (req: Seen) => { status: number; body?: unknown }) {
  const seen: Seen[] = [];
  const impl: typeof fetch = async (input, init) => {
    const req = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(req);
    const result = responder(req);
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
  };
  return { impl, seen };
}

const api = (impl: typeof fetch) => createRulesApi({ apiBase: "http://app:3100", apiKey: "k", fetchImpl: impl });

describe("createRulesApi", () => {
  it("reads and writes the company's resolver governance", async () => {
    const { impl, seen } = fakeFetch((req) => (req.method === "GET" ? { status: 200, body: { id: "c1", interactionResolverGovernance: { suggest_tasks: { cap: "anyone" } } } } : { status: 200, body: {} }));
    const client = api(impl);
    expect(await client.getGovernance("c1")).toEqual({ suggest_tasks: { cap: "anyone" } });
    await client.setGovernance("c1", { suggest_tasks: { cap: "human_only" } });
    expect(seen[1]).toEqual({ url: "http://app:3100/api/companies/c1", method: "PATCH", body: { interactionResolverGovernance: { suggest_tasks: { cap: "human_only" } } } });
  });

  it("treats a company without governance as an empty setting", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { id: "c1" } }));
    expect(await api(impl).getGovernance("c1")).toEqual({});
  });

  it("reads an agent's instructions bundle and its entry file", async () => {
    const { impl, seen } = fakeFetch((req) =>
      req.url.endsWith("/instructions-bundle")
        ? { status: 200, body: { mode: "managed", entryFile: "AGENTS.md", editable: true, legacyPromptTemplateActive: false, files: [{ path: "AGENTS.md" }, { path: "HEARTBEAT.md" }] } }
        : { status: 200, body: { path: "AGENTS.md", content: "You are an agent.\n" } });
    const client = api(impl);
    expect(await client.getInstructionsBundle("a 1")).toEqual({ mode: "managed", entryFile: "AGENTS.md", hasEntryFile: true, editable: true, legacyPromptTemplateActive: false });
    expect(await client.readInstructionsFile("a 1", "AGENTS.md")).toBe("You are an agent.\n");
    expect(seen.map((req) => req.url)).toEqual([
      "http://app:3100/api/agents/a%201/instructions-bundle",
      "http://app:3100/api/agents/a%201/instructions-bundle/file?path=AGENTS.md",
    ]);
  });

  it("never treats a file answer without content as an empty file", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { path: "AGENTS.md" } }));
    await expect(api(impl).readInstructionsFile("a1", "AGENTS.md")).rejects.toThrow(/no content/);
  });

  it("writes the entry file with PUT", async () => {
    const { impl, seen } = fakeFetch(() => ({ status: 200, body: {} }));
    await api(impl).writeInstructionsFile("a1", "AGENTS.md", "x");
    expect(seen[0]).toEqual({ url: "http://app:3100/api/agents/a1/instructions-bundle/file", method: "PUT", body: { path: "AGENTS.md", content: "x" } });
  });

  it("calls the guard plugin's board-only routes and reads the report defensively", async () => {
    const { impl, seen } = fakeFetch(() => ({ status: 200, body: { managers: ["m"], updated: ["m", 7], selfTest: { status: "weird" } } }));
    const report = await api(impl).reconcileGuard("c1");
    expect(seen[0]).toEqual({ url: `http://app:3100${GUARD_PLUGIN_ROUTES.reconcile}`, method: "POST", body: { companyId: "c1" } });
    expect(report).toEqual({ managers: ["m"], updated: ["m"], skipped: [], failures: [], selfTest: { status: "not_applicable", detail: "" } });
  });

  it("names the refused route when the plugin is missing", async () => {
    const { impl } = fakeFetch(() => ({ status: 404, body: { error: "Plugin not found" } }));
    const error = await api(impl).reconcileGuard("c1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CoreApiError);
    expect(error).toMatchObject({ status: 404, route: `POST ${GUARD_PLUGIN_ROUTES.reconcile}` });
  });
});
