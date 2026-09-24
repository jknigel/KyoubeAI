import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppService } from "../../src/apps/service.js";
import { DataService } from "../../src/data/service.js";
import { resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

const C = "99999999-9999-4999-8999-999999999999";
const OWNER = { kind: "user" as const, id: "owner-1" };
const MEMBER = { kind: "user" as const, id: "member-1" };
const VIEWER = { kind: "user" as const, id: "viewer-1" };
const AGENT = { kind: "agent" as const, id: "agent-1", runId: "run-1" };
const ROLES: Record<string, string> = { "owner-1": "owner", "member-1": "member", "viewer-1": "viewer" };
const SOURCE = "<!doctype html><html><body><script>kyoube.ready()</script></body></html>";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let data: DataService;
let apps: AppService;

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/app-service.spec.ts", "src/db/migrate.ts")));
  data = new DataService({ pool: db.pool, resolveUserRole: async (_companyId, userId) => ROLES[userId] ?? null });
  apps = new AppService({ pool: db.pool, data });
  await data.createTable(C, OWNER, { name: "contacts", fields: [{ name: "name", kind: "text", required: true }] });
  await data.createTable(C, OWNER, { name: "notes", fields: [{ name: "body", kind: "text" }] });
  await data.setAgentGrant(C, OWNER, "agent-1", "write");
});
afterAll(async () => { await db.close(); });

describe("AppService", () => {
  it("members create drafts, admins publish, viewers only see published apps", async () => {
    await expect(apps.list("not-a-uuid", OWNER)).rejects.toThrow("is not a uuid");
    await expect(apps.create(C, VIEWER, { name: "CRM", slug: "crm", tables: [] }, SOURCE)).rejects.toThrow("forbidden");
    const created = await apps.create(C, MEMBER, { name: "CRM", slug: "crm", tables: [{ name: "contacts", access: "readwrite" }, { name: "notes" }] }, SOURCE, "v1");
    expect(created.app.status).toBe("draft");
    expect(await apps.list(C, VIEWER)).toEqual([]);
    expect((await apps.list(C, MEMBER)).map((app) => app.slug)).toEqual(["crm"]);
    await expect(apps.publish(C, MEMBER, "crm")).rejects.toThrow("forbidden");
    await expect(apps.runtime(C, VIEWER, "crm", "V")).rejects.toThrow("not published");
    const published = await apps.publish(C, OWNER, "crm");
    expect(published).toMatchObject({ status: "published", currentVersion: 1 });
    expect((await apps.list(C, VIEWER)).map((app) => app.slug)).toEqual(["crm"]);
  });

  it("refuses to publish when a declared table is missing", async () => {
    await apps.create(C, OWNER, { name: "Broken", slug: "broken", tables: [{ name: "ghost" }] }, SOURCE);
    await expect(apps.publish(C, OWNER, "broken")).rejects.toThrow('table "ghost" not found');
    await expect(apps.rollback(C, OWNER, "broken", 1)).rejects.toThrow('table "ghost" not found');
    await expect(apps.get(C, VIEWER, "broken")).rejects.toThrow("not_found");
  });

  it("new versions stay draft until published; rollback re-points", async () => {
    const v2 = await apps.update(C, AGENT, "crm", { name: "CRM", slug: "crm", tables: [{ name: "contacts", access: "readwrite" }] }, SOURCE.replace("ready()", "ready() /*v2*/"), "v2");
    expect(v2.version).toBe(2);
    expect((await apps.get(C, MEMBER, "crm")).version?.version).toBe(2);
    expect((await apps.get(C, VIEWER, "crm")).version?.version).toBe(1);
    expect((await apps.runtime(C, VIEWER, "crm", "V")).context.app.version).toBe(1);
    await apps.publish(C, OWNER, "crm", 2);
    expect((await apps.runtime(C, VIEWER, "crm", "V")).source).toContain("/*v2*/");
    await apps.rollback(C, OWNER, "crm", 1);
    expect((await apps.runtime(C, VIEWER, "crm", "V")).context.app.version).toBe(1);
  });

  it("runtime data calls honour app-declared tables and the viewer's level", async () => {
    const runtime = await apps.runtime(C, VIEWER, "crm", "Vera");
    expect(runtime.context).toMatchObject({ companyId: C, viewer: { id: "viewer-1", name: "Vera", level: "read" }, app: { slug: "crm", version: 1 }, tables: ["contacts", "notes"] });
    await apps.runtimeData(C, MEMBER, "crm", "insert", { table: "contacts", rows: [{ name: "Ada" }] });
    const rows = await apps.runtimeData(C, VIEWER, "crm", "query", { table: "contacts", limit: 10 }) as { rows: unknown[] };
    expect(rows.rows).toHaveLength(1);
    await expect(apps.runtimeData(C, VIEWER, "crm", "insert", { table: "contacts", rows: [{ name: "x" }] })).rejects.toThrow("forbidden");
    await expect(apps.runtimeData(C, MEMBER, "crm", "insert", { table: "notes", rows: [{ body: "x" }] })).rejects.toThrow("read access to \"notes\"");
    await expect(apps.runtimeData(C, MEMBER, "crm", "query", { table: "deals" })).rejects.toThrow("does not declare");
    await expect(apps.runtimeData(C, MEMBER, "crm", "explode" as never, {})).rejects.toThrow("invalid");
    await apps.archive(C, OWNER, "crm");
    await expect(apps.runtime(C, VIEWER, "crm", "V")).rejects.toThrow("not published");
  });

  it("resolves the role freshly for publish, rollback and archive (P4-R13)", async () => {
    const asked: boolean[] = [];
    // Cached: still an owner. Fresh: demoted to member, who may edit but not publish.
    const demotedData = new DataService({
      pool: db.pool,
      resolveUserRole: async (_companyId, _userId, fresh) => { asked.push(fresh); return fresh ? "member" : "owner"; },
    });
    const demotedApps = new AppService({ pool: db.pool, data: demotedData });
    await demotedApps.create(C, OWNER, { name: "Fresh", slug: "fresh", tables: [] }, SOURCE);
    await expect(demotedApps.publish(C, OWNER, "fresh")).rejects.toThrow("forbidden");
    await expect(demotedApps.rollback(C, OWNER, "fresh", 1)).rejects.toThrow("forbidden");
    await expect(demotedApps.archive(C, OWNER, "fresh")).rejects.toThrow("forbidden");
    // create (a write) took the cached answer; the three lifecycle calls each asked freshly.
    expect(asked).toEqual([false, true, true, true]);
    // Reads stay on the cache, which still says owner.
    asked.length = 0;
    expect((await demotedApps.list(C, OWNER)).map((app) => app.slug)).toContain("fresh");
    expect(asked).toEqual([false]);
  });

  // M2: an archived slug is immediately reusable, so an audit row that named
  // the app by slug alone could not say *which* app it was about.
  it("names the app by id as well as by slug in every lifecycle audit row", async () => {
    const audit = await db.pool.query<{ operation: string; details: { app: string; appId: string } }>(
      "SELECT operation, details FROM kyoube_meta.audit WHERE company_id = $1 AND operation LIKE 'app%' ORDER BY id",
      [C],
    );
    expect(new Set(audit.rows.map((row) => row.operation))).toEqual(new Set(["app_create", "app_update", "app_publish", "app_rollback", "app_archive"]));
    for (const row of audit.rows) {
      expect(row.details.app).toEqual(expect.any(String));
      expect(row.details.appId).toMatch(/^[0-9a-f-]{36}$/);
    }
    // The same slug, one app id per app that ever held it.
    const crm = audit.rows.filter((row) => row.details.app === "crm");
    expect(new Set(crm.map((row) => row.details.appId)).size).toBe(1);
  });

  // Ruling P4-R21: the actor on the row is the viewer, because that is whose
  // access the write ran under. Which app it was made *through* is the fact
  // that would otherwise be lost — an app's writes are indistinguishable from
  // the same person's writes on the Data page without it.
  it("records the app a row mutation was made through", async () => {
    const inserts = await db.pool.query<{ actor_kind: string; actor_id: string; details: { via?: { app: string; version: number } } }>(
      "SELECT actor_kind, actor_id, details FROM kyoube_meta.audit WHERE company_id = $1 AND operation = 'insert' AND table_name = 'contacts' ORDER BY id",
      [C],
    );
    expect(inserts.rows).toHaveLength(1);
    expect(inserts.rows[0]).toMatchObject({ actor_kind: "user", actor_id: "member-1" });
    expect(inserts.rows[0]?.details.via).toEqual({ app: "crm", version: 1 });
  });
});
