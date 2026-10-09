import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppService } from "../../src/apps/service.js";
import { DataService } from "../../src/data/service.js";
import { resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

const C = "66666666-6666-4666-8666-666666666666";
const OWNER = { kind: "user" as const, id: "owner-1", runId: null };
const INSIDE = { kind: "user" as const, id: "in-1", runId: null };
const OUTSIDE = { kind: "user" as const, id: "out-1", runId: null };
const AGENT = { kind: "agent" as const, id: "agent-1", runId: "run-1" };
const ROLES: Record<string, string> = { "owner-1": "owner", "in-1": "operator", "out-1": "operator" };
const SOURCE = "<!doctype html><html><body><script>kyoube.ready()</script></body></html>";
const NO_ACCESS = "You don't have access to this app. Ask a company admin.";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let apps: AppService;
let restrictedId = "";

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/app-groups.spec.ts", "src/db/migrate.ts")));
  const data = new DataService({ pool: db.pool, resolveUserRole: async (_c, id) => ROLES[id] ?? null });
  await data.setAgentGrant(C, OWNER, "agent-1", "schema");
  // The gate the plugin wires from GroupService: OUTSIDE cannot see the restricted app.
  apps = new AppService({ pool: db.pool, data, hiddenApps: async (_c, userId) => (userId === "out-1" ? new Set([restrictedId]) : new Set()) });
  await data.createTable(C, OWNER, { name: "refunds", fields: [{ name: "amount", kind: "integer" }] });
  restrictedId = (await apps.create(C, OWNER, { name: "Refunds", slug: "refunds", tables: [{ name: "refunds" }] }, SOURCE)).app.id;
  await apps.publish(C, OWNER, "refunds");
  await apps.create(C, OWNER, { name: "Open", slug: "open", tables: [] }, SOURCE);
  await apps.publish(C, OWNER, "open");
});
afterAll(async () => { await db.close(); });

describe("app access by group", () => {
  it("hides the restricted app from the gallery of someone outside its groups", async () => {
    expect((await apps.list(C, OUTSIDE)).map((app) => app.slug)).toEqual(["open"]);
    expect((await apps.list(C, INSIDE)).map((app) => app.slug).sort()).toEqual(["open", "refunds"]);
  });
  it("refuses every per-app path with the no-access message", async () => {
    await expect(apps.get(C, OUTSIDE, "refunds")).rejects.toThrow(NO_ACCESS);
    await expect(apps.runtime(C, OUTSIDE, "refunds", "")).rejects.toThrow(NO_ACCESS);
    await expect(apps.runtimeData(C, OUTSIDE, "refunds", "query", { table: "refunds" })).rejects.toThrow(NO_ACCESS);
    await expect(apps.update(C, OUTSIDE, "refunds", { name: "Refunds", slug: "refunds", tables: [] }, SOURCE)).rejects.toThrow(NO_ACCESS);
  });
  it("refuses publish, rollback, preview and archive too", async () => {
    const admin = { kind: "user" as const, id: "out-1", runId: null };
    ROLES["out-1"] = "owner";
    try {
      await expect(apps.publish(C, admin, "refunds")).rejects.toThrow(NO_ACCESS);
      await expect(apps.rollback(C, admin, "refunds", 1)).rejects.toThrow(NO_ACCESS);
      await expect(apps.publishPreview(C, admin, "refunds")).rejects.toThrow(NO_ACCESS);
      await expect(apps.archive(C, admin, "refunds")).rejects.toThrow(NO_ACCESS);
    } finally { ROLES["out-1"] = "operator"; }
  });
  it("lets members, owners and agents through", async () => {
    await expect(apps.runtime(C, INSIDE, "refunds", "")).resolves.toMatchObject({ context: { app: { slug: "refunds" } } });
    await expect(apps.get(C, OWNER, "refunds")).resolves.toMatchObject({ app: { slug: "refunds" } });
    await expect(apps.get(C, AGENT, "refunds")).resolves.toMatchObject({ app: { slug: "refunds" } });
  });
  it("leaves an app in no group open", async () => {
    await expect(apps.runtime(C, OUTSIDE, "open", "")).resolves.toMatchObject({ context: { app: { slug: "open" } } });
  });
});
