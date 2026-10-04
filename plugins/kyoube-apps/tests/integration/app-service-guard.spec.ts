// tests/integration/app-service-guard.spec.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppService, type AppServiceDeps } from "../../src/apps/service.js";
import { DataError } from "../../src/data/errors.js";
import { DataService } from "../../src/data/service.js";
import { resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import type { DecideResult } from "../../src/decisions/contract.js";
import type { GuardedAction } from "../../src/decisions/guardrail.js";
import { Guardrail, type GuardrailCard } from "../../src/decisions/guardrail-service.js";
import { createTestDatabase } from "./setup.js";

const C = "13131313-1313-4131-8131-131313131313";
const OWNER = { kind: "user" as const, id: "owner-1" };
const AGENT = { kind: "agent" as const, id: "agent-1", runId: "run-1" };
const SOURCE = "<!doctype html><html><body><script>kyoube.ready()</script></body></html>";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let data: DataService;
let apps: AppService;
const seen: GuardedAction[] = [];
let refuse = false;

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/app-service-guard.spec.ts", "src/db/migrate.ts")));
  data = new DataService({ pool: db.pool, resolveUserRole: async (_c, userId) => (userId === "owner-1" ? "owner" : null) });
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
    const v2 = (await apps.get(C, OWNER, "crm", 2)).version!;
    expect(seen[0]).toMatchObject({ operation: "app_publish", app: "crm", version: 2, params: { slug: "crm", version: 2, versionId: v2.id }, guard: { issueId: "issue-1" } });
    // "latest" is resolved before the check, so the person is shown (and allows) one exact version.
    await expect(apps.publish(C, AGENT, "crm", undefined, { guard: { issueId: "issue-1" } })).rejects.toThrow("held");
    expect(seen[1]).toMatchObject({ operation: "app_publish", app: "crm", version: 2, params: { slug: "crm", version: 2, versionId: v2.id } });
    expect((await apps.get(C, OWNER, "crm", "current")).app.currentVersion).toBe(1);
  });

  it("checks rollback and archive, never a person's call", async () => {
    await apps.publish(C, OWNER, "crm", 2);
    expect(seen).toHaveLength(0);
    const { app, version: v1 } = await apps.get(C, OWNER, "crm", 1);
    await apps.rollback(C, AGENT, "crm", 1, { guard: { issueId: "issue-1" } });
    await apps.archive(C, AGENT, "crm", { guard: { issueId: "issue-1" } });
    expect(seen.map((action) => [action.operation, action.version ?? null])).toEqual([["app_rollback", 1], ["app_archive", null]]);
    expect(seen.map((action) => action.params)).toEqual([{ slug: "crm", version: 1, versionId: v1!.id }, { slug: "crm", appId: app.id }]);
  });

  it("archives a missing app with the same not_found as without the guardrail, before any check", async () => {
    const guarded = await apps.archive(C, AGENT, "ghost", { guard: { issueId: "issue-1" } }).catch((error: unknown) => error);
    const unguarded = await new AppService({ pool: db.pool, data, decisions: {} as never } as AppServiceDeps).archive(C, AGENT, "ghost").catch((error: unknown) => error);
    expect(guarded).toMatchObject({ code: "not_found" });
    expect((guarded as DataError).message).toBe((unguarded as DataError).message);
    expect(seen).toHaveLength(0);
  });
});

describe("an allowed app action and a replacement app with the same slug", () => {
  const OFF_TASK: DecideResult = { decisionId: "d-1", model: "jev-1.13.0", answers: {
    matches_task: { type: "check", value: false, confidence: 0.96, status: "auto" },
    risk: { type: "score", value: "dangerous", confidence: 0.91, status: "auto" },
  } };

  // Card ids are unique per test: holds are keyed by company and card.
  function guardedApps(tag: string) {
    const decided: unknown[] = [];
    const cards: Array<GuardrailCard & { issueId: string }> = [];
    const guardrail = new Guardrail({
      pool: db.pool,
      decisions: {
        settingsFor: async () => ({ agents: false, columns: false, apps: false, guardrail: true, dailyCap: 100 }),
        decide: async (...args: unknown[]) => { decided.push(args); return OFF_TASK; },
      } as never,
      issues: {
        get: async (id, companyId) => ({ id, companyId, title: "Look after the board app", description: null, assigneeAgentId: "agent-1" }),
        requestConfirmation: async (issueId) => {
          const card = { id: `${tag}-${cards.length + 1}`, kind: "request_confirmation", status: "pending", resolvedByUserId: null, resolvedByAgentId: null, issueId };
          cards.push(card);
          return card;
        },
        listInteractions: async (issueId) => cards.filter((card) => card.issueId === issueId),
      },
    });
    const service = new AppService({ pool: db.pool, data, decisions: {} as never, guardAgentAction: guardrail.check } as AppServiceDeps);
    const allow = (id: string) => Object.assign(cards.find((card) => card.id === id)!, { status: "accepted", resolvedByUserId: "owner-1" });
    return { service, decided, cards, allow };
  }

  async function freshBoard(service: AppService) {
    await service.create(C, OWNER, { name: "Board", slug: "board", tables: [] }, SOURCE);
    await service.update(C, OWNER, "board", { name: "Board", slug: "board", tables: [] }, SOURCE, "v2");
  }

  it("never publishes the replacement under the old app's allowance", async () => {
    const { service, decided, cards, allow } = guardedApps("publish");
    const guard = { issueId: "issue-board" };
    await freshBoard(service);
    await expect(service.publish(C, AGENT, "board", 2, { guard })).rejects.toThrow("held");
    allow("publish-1");
    await service.archive(C, OWNER, "board");
    await freshBoard(service);
    await expect(service.publish(C, AGENT, "board", 2, { guard: { ...guard, confirmationId: "publish-1" } })).rejects.toMatchObject({ code: "invalid" });
    const retry = await service.publish(C, AGENT, "board", 2, { guard }).catch((error: unknown) => error);
    // A new check and a new card for the new app; the old allowance is never used.
    expect(retry).toMatchObject({ code: "held", details: { confirmationId: "publish-2" } });
    expect([decided.length, cards.length]).toEqual([2, 2]);
    expect((await service.get(C, OWNER, "board", "latest")).app.currentVersion).toBeNull();
    await service.archive(C, OWNER, "board");
  });

  it("never archives the replacement under the old app's allowance", async () => {
    const { service, decided, cards, allow } = guardedApps("archive");
    const guard = { issueId: "issue-board" };
    await freshBoard(service);
    await expect(service.archive(C, AGENT, "board", { guard })).rejects.toThrow("held");
    allow("archive-1");
    await service.archive(C, OWNER, "board");
    await freshBoard(service);
    await expect(service.archive(C, AGENT, "board", { guard: { ...guard, confirmationId: "archive-1" } })).rejects.toMatchObject({ code: "invalid" });
    await expect(service.archive(C, AGENT, "board", { guard })).rejects.toMatchObject({ code: "held", details: { confirmationId: "archive-2" } });
    expect([decided.length, cards.length]).toEqual([2, 2]);
    expect((await service.get(C, OWNER, "board", "latest")).app.status).toBe("draft");
  });
});
