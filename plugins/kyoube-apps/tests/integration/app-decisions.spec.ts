// tests/integration/app-decisions.spec.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppService } from "../../src/apps/service.js";
import { DataService } from "../../src/data/service.js";
import { resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { createTestDatabase } from "./setup.js";

export const C = "66666666-6666-4666-8666-666666666666";
export const OWNER = { kind: "user" as const, id: "owner-1", runId: null };
export const VIEWER = { kind: "user" as const, id: "viewer-1", runId: null };
export const STRANGER = { kind: "user" as const, id: "stranger-1", runId: null };
export const AGENT = { kind: "agent" as const, id: "agent-1", runId: "run-1" };
const ROLES: Record<string, string> = { "owner-1": "owner", "viewer-1": "viewer" };
export const SOURCE = "<!doctype html><html><body><script>kyoube.ready()</script></body></html>";
export const URGENT = { type: "check", statement: "The ticket needs a reply today." };
export const TRIAGE_SET = { table: "tickets", fields: ["subject", "body"], questions: { urgent: URGENT } };

export function manifest(slug: string, decisions?: Record<string, unknown>, tables: string[] = ["tickets"]) {
  return { name: `App ${slug}`, slug, tables: tables.map((name) => ({ name })), ...(decisions ? { decisions } : {}) };
}

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let data: DataService;
let apps: AppService;

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/app-decisions.spec.ts", "src/db/migrate.ts")));
  data = new DataService({ pool: db.pool, resolveUserRole: async (_companyId, userId) => ROLES[userId] ?? null });
  apps = new AppService({ pool: db.pool, data });
  await data.createTable(C, OWNER, { name: "tickets", fields: [
    { name: "subject", kind: "text", required: true }, { name: "body", kind: "long_text" }, { name: "priority", kind: "integer" },
  ] });
  await data.setAgentGrant(C, OWNER, "agent-1", "schema");
});
// Task 17 adds publish's fifth parameter; until then the call is widened so this commit stays typecheck-clean.
const publishConfirmed = (slug: string) => (apps.publish as (...args: unknown[]) => Promise<unknown>).call(apps, C, OWNER, slug, undefined, { decisionsConfirmed: true });
afterAll(async () => { await db.close(); });

describe("decision set fields", () => {
  it("refuses to save a set naming a field its table does not have", async () => {
    await expect(apps.create(C, OWNER, manifest("fields-bad", { triage: { ...TRIAGE_SET, fields: ["subject", "nope"] } }), SOURCE))
      .rejects.toThrow('decision set "triage" names field(s) nope that table "tickets" does not have');
  });

  it("saves a set whose table does not exist yet, and refuses to publish it", async () => {
    const later = { table: "later", fields: ["x"], questions: { urgent: URGENT } };
    await apps.create(C, OWNER, manifest("fields-later", { triage: later }, ["later"]), SOURCE);
    await expect(publishConfirmed("fields-later")).rejects.toMatchObject({ code: "not_found" });
  });

  it("checks the fields again at publish", async () => {
    await data.createTable(C, OWNER, { name: "leads", fields: [{ name: "name", kind: "text" }, { name: "notes", kind: "long_text" }] });
    await apps.create(C, OWNER, manifest("fields-gone", { triage: { table: "leads", fields: ["name", "notes"], questions: { urgent: URGENT } } }, ["leads"]), SOURCE);
    await data.removeField(C, OWNER, "leads", "notes");
    await expect(publishConfirmed("fields-gone")).rejects.toThrow("notes");
  });
});
