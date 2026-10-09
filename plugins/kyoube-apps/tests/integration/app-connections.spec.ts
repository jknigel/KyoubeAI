// tests/integration/app-connections.spec.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppService } from "../../src/apps/service.js";
import { DataService } from "../../src/data/service.js";
import { resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

const C = "77777777-7777-4777-8777-777777777777";
const OWNER = { kind: "user" as const, id: "owner-1", runId: null };
const VIEWER = { kind: "user" as const, id: "viewer-1", runId: null };
const AGENT = { kind: "agent" as const, id: "agent-1", runId: "run-1" };
const ROLES: Record<string, string> = { "owner-1": "owner", "viewer-1": "viewer" };
const SOURCE = "<!doctype html><html><body><script>kyoube.ready()</script></body></html>";

const manifest = (slug: string, connections?: unknown[]) => ({ name: `App ${slug}`, slug, tables: [{ name: "tickets" }], ...(connections ? { connections } : {}) });

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let data: DataService;
let apps: AppService;
const calls: unknown[][] = [];

// stripe: read-only, crm: read-write, off: configured but its secret does not resolve.
const stubConnections = {
  status: async () => ({
    connections: [
      { name: "stripe", baseUrl: "https://api.stripe.com/v1/", auth: "bearer" as const, methods: "read" as const, available: true, problem: null },
      { name: "crm", baseUrl: "https://crm.example.com/", auth: "header" as const, methods: "read-write" as const, available: true, problem: null },
      { name: "off", baseUrl: "https://off.example.com/", auth: "basic" as const, methods: "read" as const, available: false, problem: "secret doesn't resolve" },
    ],
    problems: [],
  }),
  call: async (...args: unknown[]) => { calls.push(args); return { status: 200, headers: {}, body: "ok" }; },
};

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/app-connections.spec.ts", "src/db/migrate.ts")));
  data = new DataService({ pool: db.pool, resolveUserRole: async (_companyId, userId) => ROLES[userId] ?? null });
  apps = new AppService({ pool: db.pool, data, connections: stubConnections });
  await data.createTable(C, OWNER, { name: "tickets", fields: [{ name: "subject", kind: "text" }] });
  await data.setAgentGrant(C, OWNER, "agent-1", "schema");
});
afterAll(async () => { await db.close(); });

describe("publishing connections", () => {
  it("needs a person and a confirmation for new or changed connections, and audits them", async () => {
    await apps.create(C, OWNER, manifest("c-pub", [{ name: "stripe" }]), SOURCE);
    await expect(apps.publish(C, AGENT, "c-pub")).rejects.toMatchObject({ code: "forbidden" });
    await expect(apps.publish(C, OWNER, "c-pub")).rejects.toThrow("connectionsConfirmed");
    expect((await apps.publish(C, OWNER, "c-pub", undefined, { connectionsConfirmed: true })).currentVersion).toBe(1);
    const audit = await db.pool.query("SELECT details FROM kyoube_meta.audit WHERE company_id = $1 AND operation = 'app_publish' AND details->>'app' = 'c-pub'", [C]);
    expect(audit.rows[0]!.details).toMatchObject({ version: 1, connections: ["stripe"], connectionsConfirmed: true });
    // Same connections, new source: an agent may publish it.
    await apps.update(C, AGENT, "c-pub", manifest("c-pub", [{ name: "stripe" }]), SOURCE.replace("<body>", "<body><!--v2-->"));
    expect((await apps.publish(C, AGENT, "c-pub")).currentVersion).toBe(2);
    // Removing every connection only narrows.
    await apps.update(C, AGENT, "c-pub", manifest("c-pub"), SOURCE);
    expect((await apps.publish(C, AGENT, "c-pub")).currentVersion).toBe(3);
    // Rolling back to the version that had them adds one back: a change again.
    await expect(apps.rollback(C, AGENT, "c-pub", 2)).rejects.toMatchObject({ code: "forbidden" });
    expect((await apps.rollback(C, OWNER, "c-pub", 2, { connectionsConfirmed: true })).currentVersion).toBe(2);
  });

  it("keeps an agent out of added connections even when confirmed, and lets it remove one", async () => {
    await apps.create(C, AGENT, manifest("c-agent", [{ name: "stripe" }, { name: "crm" }]), SOURCE);
    await expect(apps.publish(C, AGENT, "c-agent", undefined, { connectionsConfirmed: true })).rejects.toMatchObject({ code: "forbidden" });
    await apps.publish(C, OWNER, "c-agent", undefined, { connectionsConfirmed: true });
    await apps.update(C, AGENT, "c-agent", manifest("c-agent", [{ name: "stripe" }]), SOURCE);
    expect((await apps.publish(C, AGENT, "c-agent")).currentVersion).toBe(2);
  });

  it("asks for each confirmation separately when decision sets and connections both change", async () => {
    const decisions = { triage: { table: "tickets", fields: ["subject"], questions: { urgent: { type: "check", statement: "Reply today." } } } };
    await apps.create(C, OWNER, { ...manifest("c-both", [{ name: "stripe" }]), decisions }, SOURCE);
    await expect(apps.publish(C, OWNER, "c-both", undefined, { decisionsConfirmed: true })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("connections") });
  });

  it("refuses a connection that is not set up, or access wider than the connection allows", async () => {
    await apps.create(C, OWNER, manifest("c-missing", [{ name: "nope" }]), SOURCE);
    await expect(apps.publish(C, OWNER, "c-missing", undefined, { connectionsConfirmed: true })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("nope") });
    await apps.create(C, OWNER, manifest("c-wide", [{ name: "stripe", access: "read-write" }]), SOURCE);
    await expect(apps.publish(C, OWNER, "c-wide", undefined, { connectionsConfirmed: true })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("stripe") });
  });

  it("refuses to publish connections when the installation has no connection service", async () => {
    const bare = new AppService({ pool: db.pool, data });
    await bare.create(C, OWNER, manifest("c-bare", [{ name: "stripe" }]), SOURCE);
    await expect(bare.publish(C, OWNER, "c-bare", undefined, { connectionsConfirmed: true })).rejects.toMatchObject({ code: "invalid" });
  });

  it("shows the publish preview what would be called", async () => {
    await apps.create(C, OWNER, manifest("c-prev", [{ name: "crm", access: "read-write" }, { name: "off" }, { name: "ghost" }]), SOURCE);
    const preview = await apps.publishPreview(C, OWNER, "c-prev");
    expect(preview.connections.changed).toBe(true);
    expect(preview.connections.list).toEqual([
      { name: "crm", access: "read-write", baseUrl: "https://crm.example.com/", auth: "header", methods: "read-write", available: true, missing: false, added: true, widened: false },
      { name: "off", access: "read", baseUrl: "https://off.example.com/", auth: "basic", methods: "read", available: false, missing: false, added: true, widened: false },
      { name: "ghost", access: "read", baseUrl: null, auth: null, methods: null, available: false, missing: true, added: true, widened: false },
    ]);
  });

  it("marks in the preview only what the next version adds or widens over the published one", async () => {
    await apps.create(C, OWNER, manifest("c-delta", [{ name: "stripe" }, { name: "crm" }]), SOURCE);
    await apps.publish(C, OWNER, "c-delta", undefined, { connectionsConfirmed: true });
    await apps.update(C, OWNER, "c-delta", manifest("c-delta", [{ name: "stripe" }, { name: "crm", access: "read-write" }, { name: "off" }]), SOURCE);
    const preview = await apps.publishPreview(C, OWNER, "c-delta");
    expect(preview.connections.changed).toBe(true);
    expect(preview.connections.list.map(({ name, added, widened }) => ({ name, added, widened }))).toEqual([
      { name: "stripe", added: false, widened: false },
      { name: "crm", added: false, widened: true },
      { name: "off", added: true, widened: false },
    ]);
  });
});

describe("runtime connections", () => {
  async function published(slug: string, connections?: unknown[]) {
    await apps.create(C, OWNER, manifest(slug, connections), SOURCE);
    await apps.publish(C, OWNER, slug, undefined, { connectionsConfirmed: true });
  }

  it("lists the declared connections with whether each is available", async () => {
    await published("c-ctx", [{ name: "stripe" }, { name: "crm", access: "read-write" }]);
    expect((await apps.runtime(C, VIEWER, "c-ctx", "")).context.connections).toEqual([
      { name: "stripe", access: "read", available: true }, { name: "crm", access: "read-write", available: true },
    ]);
    await published("c-ctx-none");
    expect((await apps.runtime(C, VIEWER, "c-ctx-none", "")).context.connections).toEqual([]);
  });

  it("refuses an undeclared name before the service, and passes the declared access otherwise", async () => {
    calls.length = 0;
    await published("c-call", [{ name: "stripe" }]);
    const raw = { method: "GET", path: "customers" };
    await expect(apps.runtimeConnection(C, VIEWER, "c-call", "crm", raw)).rejects.toMatchObject({ code: "forbidden" });
    await expect(apps.runtimeConnection(C, VIEWER, "c-call", "constructor", raw)).rejects.toMatchObject({ code: "forbidden" });
    expect(calls).toHaveLength(0);
    expect(await apps.runtimeConnection(C, VIEWER, "c-call", "stripe", raw)).toEqual({ status: 200, headers: {}, body: "ok" });
    expect(calls).toEqual([[C, VIEWER, "stripe", raw, { kind: "app", slug: "c-call", version: 1, declared: "read" }]]);
  });

  it("applies the same published-app gate as other runtime calls, and says disabled without a service", async () => {
    await apps.create(C, OWNER, manifest("c-draft", [{ name: "stripe" }]), SOURCE);
    await expect(apps.runtimeConnection(C, VIEWER, "c-draft", "stripe", {})).rejects.toMatchObject({ code: "not_found" });
    const bare = new AppService({ pool: db.pool, data });
    await published("c-off", [{ name: "stripe" }]);
    await expect(bare.runtimeConnection(C, VIEWER, "c-off", "stripe", {})).rejects.toMatchObject({ code: "disabled" });
  });
});
