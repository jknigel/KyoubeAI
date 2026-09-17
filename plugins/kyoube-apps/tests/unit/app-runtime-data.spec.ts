import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { AppService, type RuntimeMethod } from "../../src/apps/service.js";
import { AppStore } from "../../src/apps/store.js";
import type { AccessLevel, DataActor } from "../../src/data/permissions.js";
import type { DataService } from "../../src/data/service.js";

const C = "11111111-1111-4111-8111-111111111111";
const VIEWER: DataActor = { kind: "user", id: "viewer-1", runId: null };
const MANIFEST = { name: "CRM", slug: "crm", description: null, icon: null, tables: [{ name: "contacts", access: "readwrite" }, { name: "notes", access: "read" }], surfaces: ["page"] };
const SOURCE = "<!doctype html><html><body><script>kyoube.ready()</script></body></html>";
const WHERE = { field: "name", op: "eq", value: "Ada" };
const NOW = new Date("2026-09-05T10:00:00.000Z");

/**
 * A pool that answers the two SELECTs `AppStore` issues for one published app,
 * so the real store, the real gates, and the real parameter validators all run
 * — only Postgres and `DataService` are stood in for. (The integration suite
 * covers the same service against a real database; this spec is about which
 * `DataService` call each runtime method makes, and with what.)
 */
function stubPool(status: "draft" | "published" | "archived" = "published", sqls: string[] = []): Pool {
  const app = { id: "app-1", company_id: C, slug: "crm", name: "CRM", description: null, icon: null, status, current_version: 3, latest_version: 4, created_at: NOW, updated_at: NOW };
  const version = { id: "ver-1", version: 3, manifest: MANIFEST, source: SOURCE, created_by_kind: "user", created_by_id: "owner-1", notes: null, created_at: NOW };
  return { query: async (sql: string) => { sqls.push(sql); return sql.includes("app_versions") ? { rows: [version], rowCount: 1 } : { rows: [app], rowCount: 1 }; } } as unknown as Pool;
}

/** Records every DataService call; `levelFor` decides what the viewer may do. */
function stubData(level: AccessLevel) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const data = new Proxy({}, {
    get(_target, method: string) {
      if (method === "then") return undefined;
      return async (...args: unknown[]) => {
        calls.push({ method, args });
        if (method === "levelFor") return level;
        if (method === "count") return 7;
        return { method, args };
      };
    },
  }) as unknown as DataService;
  return { data, calls };
}

function serviceFor(level: AccessLevel = "write", pool: Pool = stubPool()) {
  const { data, calls } = stubData(level);
  const apps = new AppService({ pool, data });
  // `levelFor` runs on every entry point; the assertions below are about the
  // data call each method makes, so the gate call is filtered out of `calls`.
  return { apps, calls, dataCalls: () => calls.filter((call) => call.method !== "levelFor") };
}

const run = (apps: AppService, method: RuntimeMethod, params: Record<string, unknown>, actor: DataActor = VIEWER) => apps.runtimeData(C, actor, "crm", method, params);

describe("AppService.runtimeData", () => {
  it("delegates all seven methods to DataService with the viewer's own actor", async () => {
    const { apps, dataCalls } = serviceFor("write");
    expect(await run(apps, "describe", { table: "contacts" })).toMatchObject({ method: "describeTable" });
    await run(apps, "query", { table: "contacts", where: WHERE, orderBy: [{ field: "name", direction: "desc" }], limit: 10, offset: 5, fields: ["name"] });
    await run(apps, "get", { table: "contacts", id: "row-1" });
    expect(await run(apps, "count", { table: "contacts", where: WHERE })).toEqual({ count: 7 });
    await run(apps, "insert", { table: "contacts", rows: [{ name: "Ada" }] });
    await run(apps, "update", { table: "contacts", ids: ["row-1"], patch: { name: "Ada" } });
    await run(apps, "delete", { table: "contacts", where: WHERE });

    const made = dataCalls();
    expect(made.map((call) => call.method)).toEqual(["describeTable", "query", "get", "count", "insert", "update", "delete"]);
    // The viewer's actor, by reference — an app never substitutes its own.
    expect(made.every((call) => call.args[0] === C && call.args[1] === VIEWER && call.args[2] === "contacts")).toBe(true);
    expect(made[1]?.args[3]).toEqual({ where: WHERE, orderBy: [{ field: "name", direction: "desc" }], limit: 10, offset: 5, fields: ["name"] });
    expect(made[2]?.args[3]).toBe("row-1");
    expect(made[3]?.args[3]).toEqual(WHERE);
    expect(made[4]?.args[3]).toEqual([{ name: "Ada" }]);
    expect(made[5]?.args.slice(3, 5)).toEqual([{ ids: ["row-1"], where: undefined }, { name: "Ada" }]);
    expect(made[6]?.args[3]).toEqual({ ids: undefined, where: WHERE });
  });

  // Ruling P4-R21: the row still names the viewer as its actor — that is what
  // keeps an app from widening what its viewer may do — so "what it was changed
  // through" is a second fact, and only this method knows it. It comes from the
  // published version this call just resolved, never from the app's own message.
  it("tells DataService which app and version a write was made through", async () => {
    const { apps, dataCalls } = serviceFor("write");
    await run(apps, "insert", { table: "contacts", rows: [{ name: "Ada" }] });
    await run(apps, "update", { table: "contacts", ids: ["row-1"], patch: { name: "Ada" } });
    await run(apps, "delete", { table: "contacts", ids: ["row-1"] });
    const via = { app: "crm", version: 3 };
    expect(dataCalls().map((call) => call.args.at(-1))).toEqual([via, via, via]);
  });

  it("leaves a read unattributed — there is nothing to audit", async () => {
    const { apps, dataCalls } = serviceFor("write");
    await run(apps, "describe", { table: "contacts" });
    await run(apps, "query", { table: "contacts" });
    await run(apps, "get", { table: "contacts", id: "row-1" });
    await run(apps, "count", { table: "contacts" });
    for (const call of dataCalls()) expect(call.args.some((arg) => typeof arg === "object" && arg !== null && "app" in arg), call.method).toBe(false);
  });

  it("allows a write only where the published manifest says readwrite", async () => {
    const { apps, dataCalls } = serviceFor("write");
    for (const [method, params] of [["insert", { rows: [{ body: "x" }] }], ["update", { ids: ["row-1"], patch: { body: "x" } }], ["delete", { ids: ["row-1"] }]] as Array<[RuntimeMethod, Record<string, unknown>]>) {
      await expect(run(apps, method, { table: "notes", ...params })).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining('only has read access to "notes"') });
    }
    // Reads on the same table are fine, and an undeclared table is not reachable at all.
    await run(apps, "query", { table: "notes" });
    await expect(run(apps, "query", { table: "deals" })).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining('does not declare table "deals"') });
    expect(dataCalls().map((call) => call.method)).toEqual(["query"]);
  });

  it("reports a bad parameter shape as invalid before DataService is called", async () => {
    const { apps, dataCalls } = serviceFor("write");
    const cases: Array<[RuntimeMethod, Record<string, unknown>, string]> = [
      ["query", {}, "table is required"],
      ["query", { table: "contacts", orderBy: "x" }, "orderBy must be an array"],
      ["query", { table: "contacts", orderBy: [{ direction: "asc" }] }, "each orderBy entry needs a field name"],
      ["query", { table: "contacts", orderBy: [{ field: "name", direction: "sideways" }] }, "orderBy direction must be asc or desc"],
      ["query", { table: "contacts", limit: "10" }, "limit must be a number"],
      ["query", { table: "contacts", fields: [7] }, "fields must be an array of strings"],
      ["get", { table: "contacts" }, "id is required"],
      ["insert", { table: "contacts", rows: {} }, "rows must be an array"],
      ["update", { table: "contacts", ids: ["row-1"], patch: [] }, "patch must be an object"],
      ["update", { table: "contacts", ids: "row-1", patch: {} }, "ids must be an array"],
    ];
    for (const [method, params, message] of cases) {
      await expect(run(apps, method, params)).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining(message) });
    }
    // A method outside the runtime surface, and params that are not an object,
    // are refused the same way.
    await expect(run(apps, "sqlSelect" as RuntimeMethod, { table: "contacts" })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("unknown app data method") });
    await expect(run(apps, "query", null as unknown as Record<string, unknown>)).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("params must be an object") });
    expect(dataCalls()).toEqual([]);

    // A target with neither ids nor where is DataService's rule to enforce
    // ("provide exactly one of ids or where", records-service.ts), so the app
    // layer forwards the empty target rather than duplicating the check.
    await run(apps, "delete", { table: "contacts" });
    expect(dataCalls().at(-1)?.args[3]).toEqual({ ids: undefined, where: undefined });
  });

  it("refuses an actor with no access at open(), before the app is resolved", async () => {
    const { apps, calls, dataCalls } = serviceFor("none");
    await expect(run(apps, "query", { table: "contacts" })).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("open an app requires read access (you have none)") });
    await expect(apps.runtime(C, VIEWER, "crm", "")).rejects.toMatchObject({ code: "forbidden" });
    expect(calls.map((call) => call.method)).toEqual(["levelFor", "levelFor"]);
    expect(dataCalls()).toEqual([]);
  });
});

// Every runtime data call opens the app first, and `open()` used to resolve the
// app row twice: once itself, and once more inside `getVersion`, which took a
// slug and looked it up again. The record it already holds is the one to use.
describe("AppService app lookups", () => {
  const appReads = (sqls: string[]) => sqls.filter((sql) => sql.includes("FROM kyoube_meta.apps"));
  const versionReads = (sqls: string[]) => sqls.filter((sql) => sql.includes("FROM kyoube_meta.app_versions"));

  it("reads the app row once per open()", async () => {
    const sqls: string[] = [];
    const { apps } = serviceFor("read", stubPool("published", sqls));
    await apps.runtime(C, VIEWER, "crm", "");
    expect(appReads(sqls)).toHaveLength(1);
    expect(versionReads(sqls)).toHaveLength(1);
  });

  it("reads the app row once per get()", async () => {
    const sqls: string[] = [];
    const { apps } = serviceFor("write", stubPool("published", sqls));
    const result = await apps.get(C, VIEWER, "crm", 3);
    expect(result.version?.version).toBe(3);
    expect(appReads(sqls)).toHaveLength(1);
    expect(versionReads(sqls)).toHaveLength(1);
  });

  it("still resolves a version by slug where no record is in hand", async () => {
    const sqls: string[] = [];
    const store = new AppStore(stubPool("published", sqls));
    expect((await store.getVersion(C, "crm", "current"))?.version).toBe(3);
    expect(appReads(sqls)).toHaveLength(1);
  });
});

describe("AppService.update", () => {
  it("refuses a manifest whose slug is not the app being updated", async () => {
    const { apps } = serviceFor("write");
    await expect(apps.update(C, VIEWER, "crm", { ...MANIFEST, slug: "other-app" }, SOURCE)).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("manifest slug must match the app being updated") });
  });
});
