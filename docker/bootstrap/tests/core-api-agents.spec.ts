import { describe, expect, it } from "vitest";
import { createCoreClient } from "../src/core-api.js";

function stubFetch(body: unknown, seen: string[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push(`${init?.method ?? "GET"} ${String(url)} ${headers.authorization ?? ""}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("listAgents", () => {
  it("lists a company's agents with their adapter type and status", async () => {
    const seen: string[] = [];
    const client = createCoreClient({
      apiBase: "http://core:3100/",
      apiKey: "k",
      fetchImpl: stubFetch([{ id: "a1", name: "CEO", adapterType: "claude_local", status: "idle", adapterConfig: { env: {} } }], seen),
    });
    expect(await client.listAgents("c 1")).toEqual([{ id: "a1", name: "CEO", adapterType: "claude_local", status: "idle" }]);
    expect(seen).toEqual(["GET http://core:3100/api/companies/c%201/agents Bearer k"]);
  });

  it("tolerates an { agents: [...] } envelope", async () => {
    const client = createCoreClient({ apiBase: "http://core:3100", fetchImpl: stubFetch({ agents: [{ id: "a2", adapterType: "pi_local" }] }, []) });
    expect(await client.listAgents("c1")).toEqual([{ id: "a2", name: "", adapterType: "pi_local", status: "" }]);
  });
});
