import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { CONNECTION_TOOL_DEFINITIONS, connectionToolDeclarations, registerConnectionTools } from "../../src/connections/tools.js";
import type { ConnectionService } from "../../src/connections/service.js";
import { DataError } from "../../src/data/errors.js";
import manifest from "../../src/manifest.js";

const RUN = { agentId: "agent-1", runId: "run-1", companyId: "11111111-1111-4111-8111-111111111111", projectId: "p1" };
const AGENT = { kind: "agent", id: "agent-1", runId: "run-1" };

function setup(fail?: Error) {
  const harness = createTestHarness({ manifest, capabilities: ["agent.tools.register"] });
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const service = {
    list: async (...args: unknown[]) => { calls.push({ method: "list", args }); return []; },
    call: async (...args: unknown[]) => { calls.push({ method: "call", args }); if (fail) throw fail; return { status: 200, headers: {}, body: "hi" }; },
  } as unknown as ConnectionService;
  registerConnectionTools(harness.ctx, service);
  return { harness, calls };
}

describe("connection tools", () => {
  it("declares two tools and lists them in the manifest", () => {
    expect(connectionToolDeclarations().map((t) => t.name)).toEqual(["connections_list", "connections_call"]);
    expect(CONNECTION_TOOL_DEFINITIONS).toHaveLength(2);
    const names = manifest.tools?.map((t) => t.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["connections_list", "connections_call"]));
  });

  it("lists and calls with the run context's agent, never one from params", async () => {
    const { harness, calls } = setup();
    expect((await harness.executeTool("connections_list", {}, RUN)).error).toBeUndefined();
    expect(calls[0]).toEqual({ method: "list", args: [RUN.companyId, AGENT] });
    const res = await harness.executeTool("connections_call", { name: "crm", method: "GET", path: "/x", issueId: "i1", agentId: "evil" }, RUN);
    expect(res.error).toBeUndefined();
    expect(calls[1]).toEqual({ method: "call", args: [RUN.companyId, AGENT, "crm", { method: "GET", path: "/x", query: undefined, headers: undefined, body: undefined }, { kind: "direct" }, { issueId: "i1" }] });
  });

  it("validates params", async () => {
    const { harness, calls } = setup();
    expect((await harness.executeTool("connections_call", { name: "Bad Name" }, RUN)).error).toContain("name must match");
    expect((await harness.executeTool("connections_call", { name: "crm", method: "TRACE" }, RUN)).error).toContain("method");
    expect(calls).toEqual([]);
  });

  it("shows the agent only a DataError's message", async () => {
    expect((await setup(new DataError("forbidden", "no grant for crm")).harness.executeTool("connections_call", { name: "crm" }, RUN)).error).toContain("no grant for crm");
    expect((await setup(new Error("pg boom")).harness.executeTool("connections_call", { name: "crm" }, RUN)).error).toBe("error: internal error");
  });
});
