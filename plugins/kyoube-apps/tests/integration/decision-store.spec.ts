import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureCompany, resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import {
  DEFAULT_DECISION_SETTINGS, getDecisionSettings, getLoggedDecision, purgeDecisionData, recordDecisions, recordOutcome,
  releaseRequests, reserveRequests, setDecisionSettings, usageOn, utcDay, type DecisionLogRow,
} from "../../src/decisions/store.js";
import { createTestDatabase } from "./setup.js";

const C = "44444444-4444-4444-8444-444444444444";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/decision-store.spec.ts", "src/db/migrate.ts")));
  await ensureCompany(db.pool, C);
});
afterAll(async () => { await db.close(); });

function logRow(overrides: Partial<DecisionLogRow> = {}): DecisionLogRow {
  return {
    decisionId: randomUUID(), questionKey: "queue", companyId: C, surface: "agents", actorKind: "agent", actorId: "agent-1", runId: "run-1",
    via: null, fingerprint: "f".repeat(64), questionType: "choice", answer: "billing", confidence: 0.93, reviewThreshold: 0.9,
    status: "auto", model: "jev-1.13.0", latencyMs: 280, ...overrides,
  };
}

describe("decision settings", () => {
  it("defaults to everything off with a cap of 10,000, and patches field by field", async () => {
    expect(await getDecisionSettings(db.pool, C)).toEqual(DEFAULT_DECISION_SETTINGS);
    expect(await setDecisionSettings(db.pool, C, { agents: true })).toEqual({ ...DEFAULT_DECISION_SETTINGS, agents: true });
    expect(await setDecisionSettings(db.pool, C, { dailyCap: 50 })).toEqual({ ...DEFAULT_DECISION_SETTINGS, agents: true, dailyCap: 50 });
    // The Data-access settings beside them are untouched.
    const row = await db.pool.query("SELECT default_agent_level, hard_delete FROM kyoube_meta.company_settings WHERE company_id = $1", [C]);
    expect(row.rows[0]).toEqual({ default_agent_level: "none", hard_delete: false });
  });
});

describe("usage", () => {
  it("reserves up to the cap and no further, even when called concurrently", async () => {
    const day = "2026-01-01";
    const results = await Promise.all(Array.from({ length: 20 }, () => reserveRequests(db.pool, C, 1, 10, day)));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await usageOn(db.pool, C, day)).toBe(10);
    expect(await reserveRequests(db.pool, C, 1, 10, day)).toBe(false);
    await releaseRequests(db.pool, C, 3, day);
    expect(await usageOn(db.pool, C, day)).toBe(7);
    expect(await reserveRequests(db.pool, C, 5, 10, "2026-01-02")).toBe(true);
    expect(await reserveRequests(db.pool, C, 11, 10, "2026-01-03")).toBe(false);
  });
  it("never releases below zero", async () => {
    await releaseRequests(db.pool, C, 100, "2026-01-02");
    expect(await usageOn(db.pool, C, "2026-01-02")).toBe(0);
  });
  it("formats the UTC day", () => {
    expect(utcDay(Date.parse("2026-10-05T23:59:59Z"))).toBe("2026-10-05");
    expect(utcDay(Date.parse("2026-10-06T00:00:00Z"))).toBe("2026-10-06");
  });
});

describe("decision log", () => {
  it("records decisions and a later human outcome", async () => {
    const row = logRow();
    await recordDecisions(db.pool, [row, logRow({ decisionId: row.decisionId, questionKey: "urgency", questionType: "score", answer: "today", status: "review" })]);
    expect(await getLoggedDecision(db.pool, C, row.decisionId, "urgency")).toMatchObject({ answer: "today", status: "review", outcome: null, surface: "agents" });
    expect(await recordOutcome(db.pool, { companyId: C, decisionId: row.decisionId, questionKey: "urgency", outcome: "human_changed", via: "data_page", by: "user-1" })).toBe(true);
    expect(await getLoggedDecision(db.pool, C, row.decisionId, "urgency")).toMatchObject({ outcome: "human_changed" });
    // An outcome is recorded once: a second one changes nothing and says so.
    expect(await recordOutcome(db.pool, { companyId: C, decisionId: row.decisionId, questionKey: "urgency", outcome: "human_confirmed", via: "app", by: "user-2" })).toBe(false);
    expect(await getLoggedDecision(db.pool, C, row.decisionId, "urgency")).toMatchObject({ outcome: "human_changed" });
    expect(await recordOutcome(db.pool, { companyId: C, decisionId: randomUUID(), questionKey: "queue", outcome: "human_confirmed", via: "app", by: "u" })).toBe(false);
  });
  it("purges rows older than 90 days, both log and usage", async () => {
    const old = logRow();
    await recordDecisions(db.pool, [old]);
    await db.pool.query("UPDATE kyoube_meta.decisions SET created_at = now() - interval '91 days' WHERE decision_id = $1", [old.decisionId]);
    await reserveRequests(db.pool, C, 1, 10, "2020-01-01");
    const purged = await purgeDecisionData(db.pool);
    expect(purged.decisions).toBe(1);
    expect(purged.usage).toBeGreaterThanOrEqual(1);
    expect(await getLoggedDecision(db.pool, C, old.decisionId, "queue")).toBeNull();
  });
});
