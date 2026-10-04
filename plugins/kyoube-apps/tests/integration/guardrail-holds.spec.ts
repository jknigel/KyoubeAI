// tests/integration/guardrail-holds.spec.ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureCompany, resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { consumeHold, createHold, findHold, findLiveHold, purgeGuardrailHolds } from "../../src/decisions/holds.js";
import { createTestDatabase } from "./setup.js";

const C = "77777777-7777-4777-8777-777777777777";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(db.pool, migrationsDirFrom(import.meta.url.replace("tests/integration/guardrail-holds.spec.ts", "src/db/migrate.ts")));
  await ensureCompany(db.pool, C);
});
afterAll(async () => { await db.close(); });

function hold(overrides: Partial<Parameters<typeof createHold>[1]> = {}) {
  return { id: randomUUID(), companyId: C, agentId: "agent-1", issueId: "issue-1", cardId: `card-${randomUUID()}`, fingerprint: "f".repeat(64), operation: "drop_table", expiresAt: new Date(Date.now() + 86_400_000), ...overrides };
}

describe("guardrail holds", () => {
  it("stores a hold once per card and finds it by card", async () => {
    const input = hold();
    const created = await createHold(db.pool, input);
    expect(created).toMatchObject({ id: input.id, cardId: input.cardId, agentId: "agent-1", issueId: "issue-1", operation: "drop_table", consumedAt: null });
    const again = await createHold(db.pool, { ...input, id: randomUUID() });
    expect(again.id).toBe(input.id);
    expect(await findHold(db.pool, C, input.cardId)).toMatchObject({ id: input.id });
    expect(await findHold(db.pool, C, "card-missing")).toBeNull();
  });

  it("finds the live hold for the same agent, task and action only", async () => {
    const input = hold({ fingerprint: "a".repeat(64) });
    await createHold(db.pool, input);
    const now = new Date();
    expect(await findLiveHold(db.pool, { companyId: C, agentId: "agent-1", issueId: "issue-1", fingerprint: "a".repeat(64), now })).toMatchObject({ id: input.id });
    expect(await findLiveHold(db.pool, { companyId: C, agentId: "agent-2", issueId: "issue-1", fingerprint: "a".repeat(64), now })).toBeNull();
    expect(await findLiveHold(db.pool, { companyId: C, agentId: "agent-1", issueId: "issue-2", fingerprint: "a".repeat(64), now })).toBeNull();
    expect(await findLiveHold(db.pool, { companyId: C, agentId: "agent-1", issueId: "issue-1", fingerprint: "a".repeat(64), now: new Date(Date.now() + 2 * 86_400_000) })).toBeNull();
  });

  it("is used once, even when two retries race", async () => {
    const input = hold({ fingerprint: "b".repeat(64) });
    await createHold(db.pool, input);
    const results = await Promise.all([consumeHold(db.pool, input.id), consumeHold(db.pool, input.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await findHold(db.pool, C, input.cardId))!.consumedAt).not.toBeNull();
    expect(await findLiveHold(db.pool, { companyId: C, agentId: "agent-1", issueId: "issue-1", fingerprint: "b".repeat(64), now: new Date() })).toBeNull();
  });

  it("is never used once it has expired", async () => {
    const lapsed = hold({ fingerprint: "c".repeat(64), expiresAt: new Date(Date.now() - 60_000) });
    await createHold(db.pool, lapsed);
    expect(await consumeHold(db.pool, lapsed.id)).toBe(false);
    const live = hold({ fingerprint: "d".repeat(64) });
    await createHold(db.pool, live);
    expect(await consumeHold(db.pool, live.id, new Date(Date.now() + 2 * 86_400_000))).toBe(false);
    expect((await findHold(db.pool, C, lapsed.cardId))!.consumedAt).toBeNull();
    expect((await findHold(db.pool, C, live.cardId))!.consumedAt).toBeNull();
    expect(await consumeHold(db.pool, live.id, new Date())).toBe(true);
  });

  it("purges holds a week past their expiry", async () => {
    const old = hold({ expiresAt: new Date(Date.now() - 8 * 86_400_000) });
    const recent = hold({ expiresAt: new Date(Date.now() - 86_400_000) });
    await createHold(db.pool, old);
    await createHold(db.pool, recent);
    expect(await purgeGuardrailHolds(db.pool)).toBeGreaterThanOrEqual(1);
    expect(await findHold(db.pool, C, old.cardId)).toBeNull();
    expect(await findHold(db.pool, C, recent.cardId)).not.toBeNull();
  });
});
