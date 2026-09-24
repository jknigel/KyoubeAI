import { describe, expect, it } from "vitest";
import { createCoreClient, CoreApiError } from "../src/core-api.js";

interface RecordedRequest { url: string; method: string; headers: Record<string, string>; body: unknown }

function fakeFetch(responder: (req: RecordedRequest) => { status: number; body?: unknown }) {
  const requests: RecordedRequest[] = [];
  const impl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => { headers[key] = value; });
    const record: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(record);
    const result = responder(record);
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, requests };
}

describe("createCoreClient", () => {
  it("sends the bearer token and parses plugin lists", async () => {
    const { impl, requests } = fakeFetch(() => ({
      status: 200,
      body: [{ id: "p1", pluginKey: "kyoube.terminal", version: "0.1.0", status: "ready", packagePath: "/opt/x", extra: 1 }],
    }));
    const client = createCoreClient({ apiBase: "http://app:3100/", apiKey: "k", fetchImpl: impl });
    const plugins = await client.listPlugins();
    expect(plugins).toEqual([{ id: "p1", pluginKey: "kyoube.terminal", version: "0.1.0", status: "ready", packagePath: "/opt/x" }]);
    expect(requests[0]?.url).toBe("http://app:3100/api/plugins");
    expect(requests[0]?.headers.authorization).toBe("Bearer k");
  });

  it("lists companies with the bearer token", async () => {
    const { impl, requests } = fakeFetch(() => ({
      status: 200,
      body: [{ id: "c1", name: "Acme", issuePrefix: "ACM", extra: 1 }, { id: "c2", name: "Beta", issuePrefix: "BET" }],
    }));
    const client = createCoreClient({ apiBase: "http://app:3100", apiKey: "k", fetchImpl: impl });
    expect(await client.listCompanies()).toEqual([{ id: "c1", name: "Acme" }, { id: "c2", name: "Beta" }]);
    expect(requests[0]).toMatchObject({ url: "http://app:3100/api/companies", method: "GET" });
    expect(requests[0]?.headers.authorization).toBe("Bearer k");
  });

  it("lists a company's skill library by slug and key", async () => {
    const { impl, requests } = fakeFetch(() => ({
      status: 200,
      body: [{ id: "s1", slug: "kyoube-data", key: "plugin/kyoube-apps/kyoube-data", name: "Kyoube Data", markdown: "…" }],
    }));
    const client = createCoreClient({ apiBase: "http://app:3100", apiKey: "k", fetchImpl: impl });
    expect(await client.listCompanySkills("c1")).toEqual([{ slug: "kyoube-data", key: "plugin/kyoube-apps/kyoube-data", name: "Kyoube Data" }]);
    expect(requests[0]).toMatchObject({ url: "http://app:3100/api/companies/c1/skills", method: "GET" });
  });

  it("asks the kyoube.apps worker to install its skills into one company", async () => {
    const { impl, requests } = fakeFetch(() => ({ status: 200, body: { data: { status: "created" }, apps: { status: "resolved" } } }));
    const client = createCoreClient({ apiBase: "http://app:3100", apiKey: "k", fetchImpl: impl });
    expect(await client.installPluginSkills("c1")).toEqual({ data: { status: "created" }, apps: { status: "resolved" } });
    expect(requests[0]).toMatchObject({ url: "http://app:3100/api/plugins/kyoube.apps/api/skills/install", method: "POST", body: { companyId: "c1" } });
    expect(requests[0]?.headers.authorization).toBe("Bearer k");
  });

  it("installs a local plugin with the upstream body shape", async () => {
    const { impl, requests } = fakeFetch(() => ({
      status: 200,
      body: { id: "p2", pluginKey: "kyoube.apps", version: "0.1.0", status: "ready", packagePath: "/opt/kyoube/plugins/apps" },
    }));
    const client = createCoreClient({ apiBase: "http://app:3100", apiKey: "k", fetchImpl: impl });
    const installed = await client.installLocalPlugin("/opt/kyoube/plugins/apps");
    expect(installed.pluginKey).toBe("kyoube.apps");
    expect(requests[0]).toMatchObject({
      url: "http://app:3100/api/plugins/install",
      method: "POST",
      body: { packageName: "/opt/kyoube/plugins/apps", isLocalPath: true },
    });
  });

  it("upgrades a plugin through the upgrade route by record id", async () => {
    const { impl, requests } = fakeFetch(() => ({
      status: 200,
      body: { id: "p2", pluginKey: "kyoube.terminal", version: "0.1.1", status: "ready", packagePath: "/opt/kyoube/plugins/terminal", extra: 1 },
    }));
    const client = createCoreClient({ apiBase: "http://app:3100", apiKey: "k", fetchImpl: impl });
    const upgraded = await client.upgradePlugin("6f1d0a1e-0000-4000-8000-000000000001");
    expect(upgraded).toEqual({ id: "p2", pluginKey: "kyoube.terminal", version: "0.1.1", status: "ready", packagePath: "/opt/kyoube/plugins/terminal" });
    expect(requests[0]).toMatchObject({
      url: "http://app:3100/api/plugins/6f1d0a1e-0000-4000-8000-000000000001/upgrade",
      method: "POST",
      // No `version`: upstream re-reads the stored packagePath from disk.
      body: {},
    });
    expect(requests[0]?.headers.authorization).toBe("Bearer k");
  });

  it("surfaces the capability-escalation rejection from the upgrade route", async () => {
    const message =
      'Upgrade for "p2" introduces new capabilities that require approval: activity.log.write. ' +
      "The previous version declared [plugin.state.read]. Please review and approve the capability escalation before upgrading.";
    const { impl } = fakeFetch(() => ({ status: 400, body: { error: message } }));
    const client = createCoreClient({ apiBase: "http://app:3100", apiKey: "k", fetchImpl: impl });
    await expect(client.upgradePlugin("p2")).rejects.toMatchObject({ status: 400, message });
  });

  it("soft-uninstalls by default and purges only when asked", async () => {
    const { impl, requests } = fakeFetch(() => ({ status: 200, body: { id: "p2", pluginKey: "kyoube.terminal", version: "0.1.1", status: "uninstalled", packagePath: null } }));
    const client = createCoreClient({ apiBase: "http://app:3100", apiKey: "k", fetchImpl: impl });
    await expect(client.uninstallPlugin("p2")).resolves.toBeUndefined();
    await client.uninstallPlugin("p2", { purge: true });
    expect(requests[0]).toMatchObject({ url: "http://app:3100/api/plugins/p2", method: "DELETE" });
    expect(requests[0]?.body).toBeUndefined();
    expect(requests[1]?.url).toBe("http://app:3100/api/plugins/p2?purge=true");
  });

  it("throws CoreApiError with status and body on non-2xx", async () => {
    const { impl } = fakeFetch(() => ({ status: 403, body: { error: "instance admin required" } }));
    const client = createCoreClient({ apiBase: "http://app:3100", apiKey: "k", fetchImpl: impl });
    await expect(client.listPlugins()).rejects.toMatchObject({ status: 403, message: "instance admin required" });
    await expect(client.listPlugins()).rejects.toBeInstanceOf(CoreApiError);
  });

  it("waitForHealth retries until the server answers", async () => {
    let calls = 0;
    const { impl } = fakeFetch(() => {
      calls += 1;
      return calls < 3 ? { status: 503 } : { status: 200, body: { status: "ok", version: "2026.831.1", deploymentMode: "authenticated" } };
    });
    const sleeps: number[] = [];
    const client = createCoreClient({ apiBase: "http://app:3100", fetchImpl: impl, sleep: async (ms) => { sleeps.push(ms); } });
    const health = await client.waitForHealth({ timeoutMs: 10_000, intervalMs: 250 });
    expect(health.version).toBe("2026.831.1");
    expect(sleeps).toEqual([250, 250]);
  });

  it("waitForHealth gives up after the timeout", async () => {
    const { impl } = fakeFetch(() => { throw new Error("connect ECONNREFUSED"); });
    let now = 0;
    const client = createCoreClient({
      apiBase: "http://app:3100",
      fetchImpl: impl,
      sleep: async (ms) => { now += ms; },
      now: () => now,
    });
    await expect(client.waitForHealth({ timeoutMs: 1000, intervalMs: 400 })).rejects.toThrow("did not become healthy");
  });

  it("drives the CLI auth challenge endpoints", async () => {
    const { impl, requests } = fakeFetch((req) => {
      if (req.url.endsWith("/api/cli-auth/challenges")) {
        return { status: 201, body: { id: "c1", token: "t", boardApiToken: "board-token", approvalPath: "/cli-auth/approve/c1", approvalUrl: null, pollPath: "/cli-auth/challenges/c1", expiresAt: "2030-01-01T00:00:00.000Z", suggestedPollIntervalMs: 1000 } };
      }
      if (req.url.includes("/api/cli-auth/challenges/c1?token=t")) return { status: 200, body: { status: "approved" } };
      if (req.url.endsWith("/api/cli-auth/me")) return { status: 200, body: { userId: "u1" } };
      return { status: 404 };
    });
    const client = createCoreClient({ apiBase: "http://app:3100", fetchImpl: impl });
    const challenge = await client.createCliAuthChallenge({ command: "kyoube setup", clientName: "kyoube" });
    expect(challenge.boardApiToken).toBe("board-token");
    expect(requests[0]?.body).toEqual({ command: "kyoube setup", clientName: "kyoube", requestedAccess: "instance_admin_required", requestedCompanyId: null });
    expect(await client.getCliAuthChallengeStatus(challenge.pollPath, challenge.token)).toBe("approved");
    expect(await client.whoAmI("board-token")).toEqual({ userId: "u1" });
    expect(requests[2]?.headers.authorization).toBe("Bearer board-token");
  });
});
