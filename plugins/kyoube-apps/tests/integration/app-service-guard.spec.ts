// tests/integration/app-service-guard.spec.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppService, type AppServiceDeps } from "../../src/apps/service.js";
import { DataError } from "../../src/data/errors.js";
import { DataService } from "../../src/data/service.js";
import { resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import type { GuardedAction } from "../../src/decisions/guardrail.js";
import { createTestDatabase } from "./setup.js";

const C = "13131313-1313-4131-8131-131313131313";
const OWNER = { kind: "user" as const, id: "owner-1" };
const AGENT = { kind: "agent" as const, id: "agent-1", runId: "run-1" };
const SOURCE = "<!doctype html><html><body><script>kyoube.ready()</script></body></html>";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let apps: AppService;
const seen: GuardedAction[] = [];
let refuse = false;

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/app-service-guard.spec.ts", "src/db/migrate.ts")));
  const data = new DataService({ pool: db.pool, resolveUserRole: async (_c, userId) => (userId === "owner-1" ? "owner" : null) });
  // `decisions` is Milestone 3's dependency; publishing an app without decision sets never reaches it.
  apps = new AppService({
    pool: db.pool,
    data,
    decisions: {} as never,
    guardAgentAction: async (action) => {
      seen.push(action);
      if (refuse) throw new DataError("held", "wait", { details: { confirmationId: "card-1" } });
    },
  } as AppServiceDeps);
  await data.setAgentGrant(C, OWNER, "agent-1", "schema");
  await apps.create(C, OWNER, { name: "CRM", slug: "crm", tables: [] }, SOURCE);
  await apps.publish(C, OWNER, "crm");
  await apps.update(C, OWNER, "crm", { name: "CRM", slug: "crm", tables: [] }, SOURCE, "v2");
});
afterAll(async () => { await db.close(); });
beforeEach(() => { seen.length = 0; refuse = false; });

describe("the guard hook in AppService", () => {
  it("holds an agent's publish and leaves the published version alone", async () => {
    refuse = true;
    await expect(apps.publish(C, AGENT, "crm", 2, { guard: { issueId: "issue-1" } })).rejects.toThrow("held");
    expect(seen[0]).toMatchObject({ operation: "app_publish", app: "crm", version: 2, params: { slug: "crm", version: 2 }, guard: { issueId: "issue-1" } });
    // "latest" is resolved before the check, so the person is shown (and allows) one exact version.
    await expect(apps.publish(C, AGENT, "crm", undefined, { guard: { issueId: "issue-1" } })).rejects.toThrow("held");
    expect(seen[1]).toMatchObject({ operation: "app_publish", app: "crm", version: 2, params: { slug: "crm", version: 2 } });
    expect((await apps.get(C, OWNER, "crm", "current")).app.currentVersion).toBe(1);
  });

  it("checks rollback and archive, never a person's call", async () => {
    await apps.publish(C, OWNER, "crm", 2);
    expect(seen).toHaveLength(0);
    await apps.rollback(C, AGENT, "crm", 1, { guard: { issueId: "issue-1" } });
    await apps.archive(C, AGENT, "crm", { guard: { issueId: "issue-1" } });
    expect(seen.map((action) => [action.operation, action.version ?? null])).toEqual([["app_rollback", 1], ["app_archive", null]]);
    expect(seen.map((action) => action.params)).toEqual([{ slug: "crm", version: 1 }, { slug: "crm" }]);
  });
});
