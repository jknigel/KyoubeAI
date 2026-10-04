// tests/integration/guardrail-holds.spec.ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureCompany, resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import { consumeHold, createHold, findHold, findLiveHold, hasUnreleasedHold, purgeGuardrailHolds, supersedeHold } from "../../src/decisions/holds.js";
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
  return { id: randomUUID(), companyId: C, agentId: "agent-1", issueId: "issue-1", cardId: `card-${randomUUID()}`, fingerprint: "f".repeat(64), operation: "drop_table", affectedRows: 12, expiresAt: new Date(Date.now() + 86_400_000), ...overrides };
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

  it("finds an unused hold on the same agent and action, on any task, until it is due for purging", async () => {
    const f = "e".repeat(64);
    const ask = (overrides: Partial<{ agentId: string; fingerprint: string; now: Date }> = {}) =>
      hasUnreleasedHold(db.pool, { companyId: C, agentId: "agent-1", fingerprint: f, now: new Date(), ...overrides });
    expect(await ask()).toBe(false);
    const used = hold({ fingerprint: f });
    await createHold(db.pool, used);
    await consumeHold(db.pool, used.id);
    expect(await ask()).toBe(false);
    await createHold(db.pool, hold({ fingerprint: f, issueId: "issue-9", expiresAt: new Date(Date.now() - 6 * 86_400_000) }));
    expect(await ask()).toBe(true);
    expect(await ask({ agentId: "agent-2" })).toBe(false);
    expect(await ask({ fingerprint: "9".repeat(64) })).toBe(false);
    expect(await ask({ now: new Date(Date.now() + 2 * 86_400_000) })).toBe(false);
  });

  it("hands a superseded hold's place to its successor: never live, never used, never unreleased", async () => {
    const f = "5".repeat(64);
    const first = hold({ fingerprint: f, affectedRows: 3 });
    await createHold(db.pool, first);
    expect(await findHold(db.pool, C, first.cardId)).toMatchObject({ affectedRows: 3, supersededBy: null });
    const next = hold({ fingerprint: f, affectedRows: 5 });
    await createHold(db.pool, next);
    expect(await supersedeHold(db.pool, first.id, next.cardId)).toBe(true);
    expect(await supersedeHold(db.pool, first.id, "card-other")).toBe(false);
    expect(await findHold(db.pool, C, first.cardId)).toMatchObject({ supersededBy: next.cardId, consumedAt: null });
    expect(await consumeHold(db.pool, first.id)).toBe(false);
    expect(await findLiveHold(db.pool, { companyId: C, agentId: "agent-1", issueId: "issue-1", fingerprint: f, now: new Date() })).toMatchObject({ id: next.id });
    expect(await consumeHold(db.pool, next.id)).toBe(true);
    // The chain ran: the superseded hold no longer counts as an action no person released.
    expect(await hasUnreleasedHold(db.pool, { companyId: C, agentId: "agent-1", fingerprint: f, now: new Date() })).toBe(false);
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
