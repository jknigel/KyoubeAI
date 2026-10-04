// tests/integration/ai-fixture.ts
import { DataError } from "../../src/data/errors.js";
import { DataService } from "../../src/data/service.js";
import { resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import type { FetchLike, FetchResponse } from "../../src/decisions/client.js";
import { AiColumnService, type AiColumnServiceDeps } from "../../src/decisions/columns.js";
import { DecisionService, type DecisionActivity } from "../../src/decisions/service.js";
import { setDecisionSettings } from "../../src/decisions/store.js";
import { createTestDatabase } from "./setup.js";

export const OWNER = { kind: "user" as const, id: "owner-1", runId: null };
export const AGENT = { kind: "agent" as const, id: "agent-1", runId: "run-1" };

export function answer(body: unknown): FetchResponse {
  return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}
export function failure(status: number): FetchResponse {
  return { status, headers: { get: () => null }, text: async () => "{}" };
}

/**
 * The model behind every AI-column test: a check that is confident for "refund", unsure for
 * "maybe", confidently false otherwise; "outage" makes the provider fail. The state is the row's
 * source fields, so the decision follows the row's text.
 */
export function refundModel(calls: string[]): FetchLike {
  return async (_url, init) => {
    const body = JSON.parse(init.body) as { state: Record<string, unknown> };
    const text = JSON.stringify(body.state).toLowerCase();
    calls.push(text);
    if (text.includes("outage")) return failure(503);
    const p = text.includes("maybe") ? 0.6 : text.includes("refund") ? 0.97 : 0.03;
    return answer({ model: "jev-1.13.0", answers: { value: { type: "noul", noul: p } } });
  };
}

export async function aiFixture(companyId: string, file: string, overrides: { fetch?: FetchLike; limits?: AiColumnServiceDeps["limits"]; now?: () => number } = {}) {
  const db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace(`tests/integration/${file}`, "src/db/migrate.ts").replace("tests/integration/ai-fixture.ts", "src/db/migrate.ts")));
  const calls: string[] = [];
  const activity: DecisionActivity[] = [];
  const data = new DataService({ pool: db.pool, resolveUserRole: async (_c, userId) => (userId === "owner-1" ? "owner" : null) });
  const decisions = new DecisionService({
    pool: db.pool,
    data,
    providers: {
      settings: async () => ({ provider: "typesafe" as const, baseUrl: "https://api.typesafe.ai", model: "jev-1.13.0", apiKeyRef: {} }),
      resolve: async () => ({ provider: "typesafe", baseUrl: "https://api.typesafe.ai", model: "jev-1.13.0", apiKey: "k" }),
    },
    fetch: overrides.fetch ?? refundModel(calls),
    sleep: async () => {},
    onActivity: async (event) => void activity.push(event),
  });
  const ai = new AiColumnService({ pool: db.pool, data, decisions, providerName: async () => "typesafe", limits: overrides.limits, now: overrides.now });
  data.attach({ aiColumns: ai.hooks() });
  await data.createTable(companyId, OWNER, { name: "tickets", fields: [{ name: "subject", kind: "text" }] });
  await setDecisionSettings(db.pool, companyId, { columns: true, agents: true, dailyCap: 10_000 });
  await data.setAgentGrant(companyId, OWNER, "agent-1", "write");
  const addRefund = (extra: Record<string, unknown> = {}) => data.addField(companyId, OWNER, "tickets", {
    name: "refund", kind: "boolean", options: { decision: { question: { type: "check", statement: "The ticket asks for a refund." }, sourceFields: ["subject"], ...extra } },
  });
  return { db, data, decisions, ai, calls, activity, addRefund, isDisabled: (error: unknown) => error instanceof DataError && error.code === "disabled" };
}
