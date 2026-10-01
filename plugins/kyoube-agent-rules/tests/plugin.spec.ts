import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { API_ROUTES, PLUGIN_ID, PLUGIN_VERSION } from "../src/manifest.js";
import { createAgentRulesPlugin, parseRecord, portFromContext } from "../src/plugin.js";
import { EMPTY_RECORD, type GuardPort } from "../src/guard.js";
import pkg from "../package.json" with { type: "json" };

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function request(routeKey: string, actorType: "user" | "agent" = "user", companyId = COMPANY) {
  return {
    routeKey,
    method: "POST",
    path: routeKey === "guard.reconcile" ? "/reconcile" : "/revert",
    params: {},
    query: {},
    body: { companyId },
    actor: { actorType, actorId: actorType === "user" ? "user-1" : "agent-1" },
    companyId,
    headers: {},
  };
}

function quietPort(overrides: Partial<GuardPort> = {}): GuardPort {
  return {
    listAgents: async () => [],
    getPolicy: async () => null,
    setPolicy: async () => {},
    listGrants: async () => [],
    setGrants: async () => {},
    previewAssign: async () => ({ allowed: true, reason: "x" }),
    readRecord: async () => ({ ...EMPTY_RECORD }),
    writeRecord: async () => {},
    ...overrides,
  };
}

async function started(port: GuardPort) {
  const harness = createTestHarness({ manifest });
  const plugin = createAgentRulesPlugin({ port: () => port });
  await plugin.definition.setup(harness.ctx);
  return plugin;
}

/** A promise the test settles by hand, to hold a port call open. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

/** Lets every already-queued continuation run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("kyoube.agent-rules manifest", () => {
  it("declares the two board-only routes the CLI calls, resolved from the body's companyId", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.version).toBe(pkg.version);
    expect(PLUGIN_VERSION).toBe(pkg.version);
    expect(API_ROUTES.map((route) => [route.routeKey, route.method, route.path, route.auth])).toEqual([
      ["guard.reconcile", "POST", "/reconcile", "board"],
      ["guard.revert", "POST", "/revert", "board"],
    ]);
    expect(API_ROUTES.every((route) => route.companyResolution?.from === "body" && route.companyResolution.key === "companyId")).toBe(true);
    expect(manifest.entrypoints).toEqual({ worker: "./dist/worker.js" });
  });
});

describe("kyoube.agent-rules routes", () => {
  it("answers 503 before setup", async () => {
    const plugin = createAgentRulesPlugin({ port: () => quietPort() });
    expect(await plugin.definition.onApiRequest!(request("guard.reconcile"))).toMatchObject({ status: 503 });
  });

  it("refuses an agent caller", async () => {
    const plugin = await started(quietPort());
    expect(await plugin.definition.onApiRequest!(request("guard.reconcile", "agent"))).toMatchObject({ status: 403 });
  });

  it("reconciles the body's company and returns the report", async () => {
    const plugin = await started(quietPort());
    const response = await plugin.definition.onApiRequest!(request("guard.reconcile"));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ managers: [], updated: [], selfTest: { status: "not_applicable" } });
  });

  it("reverts the body's company", async () => {
    const plugin = await started(quietPort());
    expect(await plugin.definition.onApiRequest!(request("guard.revert"))).toEqual({ status: 200, body: { reverted: [], failures: [] } });
  });

  it("answers 500 with the reason when the host refuses", async () => {
    const plugin = await started(quietPort({ listAgents: async () => { throw new Error("boom"); } }));
    const response = await plugin.definition.onApiRequest!(request("guard.reconcile"));
    expect(response).toMatchObject({ status: 500, body: { error: "guard.reconcile failed: boom" } });
  });

  it("answers 404 for a route key it does not own", async () => {
    const plugin = await started(quietPort());
    expect(await plugin.definition.onApiRequest!(request("other"))).toMatchObject({ status: 404 });
  });
});

describe("kyoube.agent-rules route serialization", () => {
  it("runs a revert for a company only after that company's reconcile has finished", async () => {
    const hold = gate();
    const calls: string[] = [];
    let held = false;
    const plugin = await started(quietPort({
      listAgents: async () => {
        calls.push("listAgents");
        // Only the first call (the reconcile's) is held open.
        if (!held) { held = true; await hold.opened; }
        return [];
      },
      readRecord: async () => {
        calls.push("readRecord");
        return { ...EMPTY_RECORD };
      },
    }));

    const reconcile = plugin.definition.onApiRequest!(request("guard.reconcile"));
    const revert = plugin.definition.onApiRequest!(request("guard.revert"));
    await settle();
    // The reconcile is held inside its first port call; the revert has made none.
    expect(calls).toEqual(["listAgents"]);

    hold.open();
    expect(await reconcile).toMatchObject({ status: 200 });
    expect(await revert).toEqual({ status: 200, body: { reverted: [], failures: [] } });
    // Reconcile is listAgents then readRecord; revert is readRecord then listAgents.
    expect(calls).toEqual(["listAgents", "readRecord", "readRecord", "listAgents"]);
  });

  it("does not serialize two different companies against each other", async () => {
    const hold = gate();
    const seen: string[] = [];
    const plugin = await started(quietPort({
      listAgents: async (companyId) => {
        seen.push(companyId);
        if (companyId === COMPANY) await hold.opened;
        return [];
      },
    }));

    const slow = plugin.definition.onApiRequest!(request("guard.reconcile", "user", COMPANY));
    const other = plugin.definition.onApiRequest!(request("guard.reconcile", "user", OTHER));
    // The other company's reconcile finishes while the first is still held.
    expect(await other).toMatchObject({ status: 200 });
    expect(seen).toEqual([COMPANY, OTHER]);

    hold.open();
    expect(await slow).toMatchObject({ status: 200 });
  });

  it("keeps serving a company after one of its calls fails", async () => {
    let fail = true;
    const plugin = await started(quietPort({
      listAgents: async () => {
        if (fail) { fail = false; throw new Error("boom"); }
        return [];
      },
    }));

    const failing = plugin.definition.onApiRequest!(request("guard.reconcile"));
    const next = plugin.definition.onApiRequest!(request("guard.reconcile"));
    expect(await failing).toMatchObject({ status: 500, body: { error: "guard.reconcile failed: boom" } });
    expect(await next).toMatchObject({ status: 200 });
  });
});

describe("portFromContext", () => {
  it("reaches the host only through the capabilities the manifest declares", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      agents: [{ id: "a1", companyId: COMPANY, name: "Dev", status: "idle", reportsTo: null } as never],
      principalGrants: [{ id: "g1", companyId: COMPANY, principalType: "agent", principalId: "a1", permissionKey: "tasks:assign", scope: null, grantedByUserId: null, createdAt: new Date(), updatedAt: new Date() } as never],
    });
    const port = portFromContext(harness.ctx);
    expect(await port.listAgents(COMPANY)).toEqual([{ id: "a1", name: "Dev", status: "idle", reportsTo: null }]);
    expect(await port.listGrants(COMPANY, "a1")).toEqual([{ permissionKey: "tasks:assign", scope: null }]);
    await port.setGrants(COMPANY, "a1", []);
    expect(await port.listGrants(COMPANY, "a1")).toEqual([]);
    await port.setPolicy(COMPANY, "a1", { assignmentPolicy: { mode: "protected" } });
    await port.writeRecord(COMPANY, { protected: ["a1"], scoped: [], broadRemoved: ["a1"] });
    expect(await port.readRecord(COMPANY)).toEqual({ protected: ["a1"], scoped: [], broadRemoved: ["a1"] });
    expect(await port.previewAssign(COMPANY, "a1", "a1")).toMatchObject({ allowed: true });
  });
});

describe("parseRecord", () => {
  it("tolerates a missing or hand-edited record", () => {
    expect(parseRecord(null)).toEqual(EMPTY_RECORD);
    expect(parseRecord({ protected: ["a", 3], scoped: "x" })).toEqual({ protected: ["a"], scoped: [], broadRemoved: [] });
  });
});
