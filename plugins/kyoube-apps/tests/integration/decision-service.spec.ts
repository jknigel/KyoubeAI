// tests/integration/decision-service.spec.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataError } from "../../src/data/errors.js";
import type { DataActor } from "../../src/data/permissions.js";
import { ensureCompany, resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import type { FetchLike, FetchResponse } from "../../src/decisions/client.js";
import type { Question } from "../../src/decisions/contract.js";
import { DecisionService, type DecisionActivity, type DecisionServiceDeps } from "../../src/decisions/service.js";
import { setDecisionSettings, usageOn, utcDay } from "../../src/decisions/store.js";
import { createTestDatabase } from "./setup.js";

const C = "55555555-5555-4555-8555-555555555555";
const AGENT: DataActor = { kind: "agent", id: "agent-1", runId: "run-1" };
const ADMIN: DataActor = { kind: "user", id: "admin-1", runId: null };
const ROW_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROW_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const queue: Question = { type: "choice", instructions: "Which team?", options: { billing: null, technical: null } };
const refund: Question = { type: "check", statement: "Asks for a refund." };

let db: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/decision-service.spec.ts", "src/db/migrate.ts")));
  await ensureCompany(db.pool, C);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.pool.query("DELETE FROM kyoube_meta.decisions");
  await db.pool.query("DELETE FROM kyoube_meta.decision_usage");
  await setDecisionSettings(db.pool, C, { agents: true, columns: false, apps: false, guardrail: false, dailyCap: 100 });
});

function ok(answers: Record<string, unknown>): FetchResponse {
  return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ model: "jev-1.13.0", answers }) };
}
const good = { queue: { choice: "billing", confidence: 0.95 }, refund: { noul: 0.97 } };

function harness(overrides: Partial<DecisionServiceDeps> = {}, fetchImpl?: FetchLike) {
  const activity: DecisionActivity[] = [];
  const fetches: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch: FetchLike = fetchImpl ?? (async (_url, init) => {
    fetches.push(init.body);
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return ok(good);
  });
  const rows: Record<string, Record<string, unknown>> = {
    [ROW_A]: { id: ROW_A, subject: "Card charged twice", body: "Please refund", owner: ROW_B, meta: { x: 1 } },
    [ROW_B]: { id: ROW_B, subject: "App crashes", body: "On launch", owner: null, meta: null },
  };
  const data = {
    levelFor: async (_c: string, actor: DataActor) => (actor.id === "nobody" ? "none" : "write"),
    // Ids ending in "cccc…" are missing rows; any other id is a generic ticket, so the
    // concurrency test below really reaches the provider for every row.
    get: async (_c: string, _a: DataActor, _t: string, id: string) => rows[id] ?? (id.endsWith("cccccccccccc") ? null : { id, subject: "Generic", body: "x", owner: null, meta: null }),
    describeTable: async () => ({ name: "tickets", displayName: "Tickets", description: null, createdAt: "", updatedAt: "", fields: [
      { name: "subject", kind: "text", position: 0 }, { name: "body", kind: "long_text", position: 1 },
      { name: "owner", kind: "relation", position: 2 }, { name: "meta", kind: "json", position: 3 },
    ] }),
    assertAdmin: async (_c: string, actor: DataActor) => { if (actor.id !== "admin-1") throw new DataError("forbidden", "only company admins manage data access"); },
  };
  const providers = {
    settings: async () => ({ provider: "typesafe" as const, baseUrl: "https://api.typesafe.ai", model: "jev-1.13.0", apiKeyRef: {} }),
    resolve: async () => ({ provider: "typesafe", baseUrl: "https://api.typesafe.ai", model: "jev-1.13.0", apiKey: "k" }),
  };
  const service = new DecisionService({
    pool: db.pool, data: data as never, providers, fetch, sleep: async () => {},
    onActivity: async (event) => void activity.push(event), ...overrides,
  });
  return { service, activity, fetches, maxInFlight: () => maxInFlight };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "resolved"; } catch (error) { return error instanceof DataError ? error.code : String(error); }
}

describe("decide", () => {
  it("answers, sets statuses, logs every question, counts one request and records one activity line", async () => {
    const { service, activity } = harness();
    const result = await service.decide(C, AGENT, "agents", { state: "Please refund", questions: { queue, refund } });
    expect(result.model).toBe("jev-1.13.0");
    expect(result.answers.queue).toEqual({ type: "choice", value: "billing", confidence: 0.95, status: "auto" });
    expect(result.answers.refund).toMatchObject({ value: true, status: "auto" });
    expect(result.decisionId).toMatch(/^[0-9a-f-]{36}$/);
    const logged = await db.pool.query("SELECT question_key, answer, status, actor_kind, run_id FROM kyoube_meta.decisions ORDER BY question_key");
    expect(logged.rows).toEqual([
      { question_key: "queue", answer: "billing", status: "auto", actor_kind: "agent", run_id: "run-1" },
      { question_key: "refund", answer: "true", status: "auto", actor_kind: "agent", run_id: "run-1" },
    ]);
    expect(await usageOn(db.pool, C, utcDay())).toBe(1);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.summary).toBe("an agent asked 2 question(s): 2 auto, 0 review (jev-1.13.0)");
    expect(JSON.stringify(activity)).not.toContain("Please refund");
  });

  it("adds probabilities only when asked", async () => {
    const { service } = harness();
    const plain = await service.decide(C, AGENT, "agents", { state: "x", questions: { refund } });
    expect(plain.answers.refund!.probabilities).toBeUndefined();
    const full = await service.decide(C, AGENT, "agents", { state: "x", questions: { refund } }, { includeProbabilities: true });
    expect(full.answers.refund!.probabilities).toEqual({ true: 0.97, false: 0.03 });
  });

  it("sends unsure and advisory answers to review", async () => {
    const { service } = harness({}, async () => ok({ queue: { choice: "unsure", confidence: 0.99 }, refund: { noul: 0.99 } }));
    const result = await service.decide(C, AGENT, "agents", { state: "x", questions: { queue, refund } });
    expect(result.answers.queue!.status).toBe("review");
    expect(result.answers.refund!.status).toBe("auto");
    const advisory = await service.decide(C, AGENT, "agents", { state: "x", questions: { refund } }, { advisory: true });
    expect(advisory.answers.refund!.status).toBe("review");
  });

  it("refuses when the use is off, the provider is missing, or the caller has no access", async () => {
    const { service } = harness();
    expect(await codeOf(service.decide(C, AGENT, "apps", { state: "x", questions: { refund } }))).toBe("disabled");
    expect(await codeOf(service.decide(C, { kind: "agent", id: "nobody" }, "agents", { state: "x", questions: { refund } }))).toBe("forbidden");
    const missing = harness({ providers: { settings: async () => null, resolve: async () => { throw new DataError("disabled", "no provider"); } } }).service;
    expect(await codeOf(missing.decide(C, AGENT, "agents", { state: "x", questions: { refund } }))).toBe("disabled");
  });

  it("stops at the daily cap without calling the provider", async () => {
    await setDecisionSettings(db.pool, C, { dailyCap: 1 });
    const { service, fetches } = harness();
    await service.decide(C, AGENT, "agents", { state: "x", questions: { refund } });
    expect(await codeOf(service.decide(C, AGENT, "agents", { state: "x", questions: { refund } }))).toBe("budget_exceeded");
    expect(fetches).toHaveLength(1);
  });

  it("releases the slot when the provider fails", async () => {
    const { service } = harness({}, async () => ({ status: 401, headers: { get: () => null }, text: async () => "{}" }));
    expect(await codeOf(service.decide(C, AGENT, "agents", { state: "x", questions: { refund } }))).toBe("provider_rejected");
    expect(await usageOn(db.pool, C, utcDay())).toBe(0);
  });

  it("releases the slot on the day it was reserved", async () => {
    let clock = Date.parse("2026-10-05T23:59:59.900Z");
    const { service } = harness({ now: () => clock }, async () => { clock = Date.parse("2026-10-06T00:00:00.500Z"); return { status: 401, headers: { get: () => null }, text: async () => "{}" }; });
    await codeOf(service.decide(C, AGENT, "agents", { state: "x", questions: { refund } }));
    expect(await usageOn(db.pool, C, "2026-10-05")).toBe(0);
    expect(await usageOn(db.pool, C, "2026-10-06")).toBe(0);
  });

  it("still answers when the log cannot be written", async () => {
    const failingPool = new Proxy(db.pool, {
      get(target, prop, receiver) {
        if (prop === "query") return (sql: string, params?: unknown[]) => (String(sql).includes("INSERT INTO kyoube_meta.decisions") ? Promise.reject(new Error("disk full")) : target.query(sql, params));
        return Reflect.get(target, prop, receiver);
      },
    });
    const logs: string[] = [];
    const { service } = harness({ pool: failingPool as never, log: (message) => void logs.push(message) });
    const result = await service.decide(C, AGENT, "agents", { state: "x", questions: { refund } });
    expect(result.decisionId).toBeNull();
    expect(result.answers.refund!.value).toBe(true);
    expect(logs).toContain("decision log write failed");
  });
});

describe("decideRows", () => {
  it("reads each row under the caller, skips relation and json fields, and reports per row", async () => {
    const { service, fetches, activity } = harness();
    const missing = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const { results } = await service.decideRows(C, AGENT, "agents", { table: "tickets", ids: [ROW_A, missing] }, { queue });
    expect(results[0]).toMatchObject({ rowId: ROW_A, result: { answers: { queue: { value: "billing" } } } });
    expect(results[1]).toEqual({ rowId: missing, error: { code: "not_found", message: `not_found: row ${missing} was not found` } });
    expect(JSON.parse(fetches[0]!).state).toEqual({ subject: "Card charged twice", body: "Please refund" });
    expect(activity).toHaveLength(1);
    expect(activity[0]!.summary).toBe("an agent asked 1 question(s) on 2 row(s): 1 auto, 0 review, 1 failed (jev-1.13.0)");
  });

  it("dedupes repeated row ids", async () => {
    const { service, fetches } = harness();
    const { results } = await service.decideRows(C, AGENT, "agents", { table: "tickets", ids: [ROW_A, ROW_A, ROW_B] }, { refund });
    expect(results.map((row) => row.rowId)).toEqual([ROW_A, ROW_B]);
    expect(fetches).toHaveLength(2);
    expect(await usageOn(db.pool, C, utcDay())).toBe(2);
  });

  it("sends only the fields asked for and refuses unknown ones", async () => {
    const { service, fetches } = harness();
    await service.decideRows(C, AGENT, "agents", { table: "tickets", ids: [ROW_A], fields: ["subject"] }, { refund });
    expect(JSON.parse(fetches[0]!).state).toEqual({ subject: "Card charged twice" });
    expect(await codeOf(service.decideRows(C, AGENT, "agents", { table: "tickets", ids: [ROW_A], fields: ["nope"] }, { refund }))).toBe("invalid");
  });

  it("runs at most eight rows at a time and takes at most 50", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`);
    const { service, maxInFlight, fetches } = harness();
    await service.decideRows(C, AGENT, "agents", { table: "tickets", ids }, { refund });
    expect(fetches).toHaveLength(20);
    expect(maxInFlight()).toBeGreaterThan(1);
    expect(maxInFlight()).toBeLessThanOrEqual(8);
    const tooMany = Array.from({ length: 51 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`);
    expect(await codeOf(service.decideRows(C, AGENT, "agents", { table: "tickets", ids: tooMany }, { refund }))).toBe("invalid");
  });
});

describe("status and settings", () => {
  it("reports availability and the remaining budget", async () => {
    const { service } = harness();
    await service.decide(C, AGENT, "agents", { state: "x", questions: { refund } });
    expect(await service.status(C, AGENT, "agents")).toEqual({ available: true, enabled: true, configured: true, provider: "typesafe", model: "jev-1.13.0", budget: { cap: 100, used: 1, remaining: 99 } });
    expect((await service.status(C, AGENT, "apps")).available).toBe(false);
  });

  it("lets only admins read and change the settings, and audits the change", async () => {
    const { service, activity } = harness();
    expect(await codeOf(service.getSettings(C, AGENT))).toBe("forbidden");
    const view = await service.getSettings(C, ADMIN);
    expect(view.provider).toEqual({ configured: true, provider: "typesafe", model: "jev-1.13.0", keyResolves: true, problem: null });
    expect(await service.setSettings(C, ADMIN, { apps: true, dailyCap: 500 })).toMatchObject({ agents: true, apps: true, dailyCap: 500 });
    expect(await codeOf(service.setSettings(C, ADMIN, { dailyCap: -1 }))).toBe("invalid");
    expect(await codeOf(service.setSettings(C, ADMIN, { everything: true }))).toBe("invalid");
    const audit = await db.pool.query("SELECT operation FROM kyoube_meta.audit WHERE company_id = $1 AND operation = 'set_decision_settings'", [C]);
    expect(audit.rowCount).toBe(1);
    expect(activity.at(-1)!.summary).toBe("settings updated");
  });

  it("shows why the key does not resolve", async () => {
    const { service } = harness({ providers: { settings: async () => ({ provider: "typesafe", baseUrl: "https://api.typesafe.ai", model: "jev-1.13.0", apiKeyRef: {} }), resolve: async () => { throw new DataError("disabled", "the typed-decisions API key could not be read"); } } });
    expect((await service.getSettings(C, ADMIN)).provider).toMatchObject({ configured: true, keyResolves: false, problem: "disabled: the typed-decisions API key could not be read" });
  });
});
