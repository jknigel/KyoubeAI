// tests/integration/ai-fill.spec.ts
import { afterEach, describe, expect, it } from "vitest";
import { countCells, getCells, listAiColumns } from "../../src/decisions/cells.js";
import { setDecisionSettings, usageOn, utcDay } from "../../src/decisions/store.js";
import { aiFixture, answer, failure, OWNER } from "./ai-fixture.js";

const C = "99999999-9999-4999-8999-999999999999";
let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

async function setup(overrides: Parameters<typeof aiFixture>[2] = {}) {
  const fixture = await aiFixture(C, "ai-fill.spec.ts", overrides);
  close = () => fixture.db.close();
  return fixture;
}

async function refunds(fixture: Awaited<ReturnType<typeof setup>>) {
  const { rows } = await fixture.data.query(C, OWNER, "tickets", { orderBy: [{ field: "subject" }] });
  return rows.map((row) => [row.subject, row.refund]);
}

describe("filling AI columns", () => {
  it("writes auto answers, leaves review cells empty with a suggestion, and logs once per batch", async () => {
    const f = await setup();
    await f.data.insert(C, OWNER, "tickets", [{ subject: "a: please refund me" }, { subject: "b: maybe a refund?" }, { subject: "c: thanks" }]);
    await f.addRefund();
    await f.ai.idle(C);
    expect(await refunds(f)).toEqual([["a: please refund me", true], ["b: maybe a refund?", null], ["c: thanks", false]]);
    const [ref] = await listAiColumns(f.db.pool, C);
    const ids = (await f.data.query(C, OWNER, "tickets", { orderBy: [{ field: "subject" }] })).rows.map((row) => String(row.id));
    const cells = await getCells(f.db.pool, ref!.fieldId, ids);
    expect(ids.map((id) => [cells.get(id)!.status, cells.get(id)!.suggestion])).toEqual([["auto", "true"], ["review", "true"], ["auto", "false"]]);
    const audit = await f.db.pool.query("SELECT details FROM kyoube_meta.audit WHERE operation = 'ai_fill'");
    expect(audit.rows).toEqual([{ details: { field: "refund", affected: 3, via: "tickets.refund" } }]);
    expect(f.activity.map((event) => event.summary)).toEqual(["Kyoube asked 1 question(s) on 3 row(s): 2 auto, 1 review (jev-1.13.0)"]);
    expect(JSON.stringify(f.activity)).not.toContain("refund me");
    expect(await usageOn(f.db.pool, C, utcDay())).toBe(3);
  });

  it("does not ask again until a source changes", async () => {
    const f = await setup();
    const [row] = await f.data.insert(C, OWNER, "tickets", [{ subject: "please refund me" }]);
    await f.addRefund();
    await f.ai.idle(C);
    expect(f.calls).toHaveLength(1);
    await f.ai.fillCompany(C);
    expect(f.calls).toHaveLength(1);
    await f.data.update(C, OWNER, "tickets", { ids: [String(row!.id)] }, { subject: "thanks, all sorted" });
    await f.ai.fillCompany(C);
    expect(f.calls).toHaveLength(2);
    expect(await refunds(f)).toEqual([["thanks, all sorted", false]]);
  });

  // The manual-cell half of this (a person's value survives the refill) needs Task 13's edit
  // bookkeeping and lives in ai-edits.spec.ts.
  it("asks every row again when the question changes", async () => {
    const f = await setup();
    await f.data.insert(C, OWNER, "tickets", [{ subject: "please refund me" }, { subject: "thanks" }]);
    await f.addRefund();
    await f.ai.idle(C);
    f.calls.length = 0;
    await f.data.updateField(C, OWNER, "tickets", "refund", { decision: { question: { type: "check", statement: "The customer wants money back." }, sourceFields: ["subject"] } });
    await f.ai.idle(C);
    expect(f.calls).toHaveLength(2);
    expect(await refunds(f)).toEqual([["please refund me", true], ["thanks", false]]);
  });

  it("stops at a provider error, keeps the budget, and retries the row next run", async () => {
    let down = true;
    const calls: string[] = [];
    const f = await setup({ fetch: async () => { calls.push("x"); return down ? failure(503) : answer({ answers: { value: { noul: 0.97 } } }); } });
    await f.data.insert(C, OWNER, "tickets", [{ subject: "please refund me" }]);
    await f.addRefund();
    await f.ai.idle(C);
    expect(await refunds(f)).toEqual([["please refund me", null]]);
    const [ref] = await listAiColumns(f.db.pool, C);
    const id = String((await f.data.query(C, OWNER, "tickets", {})).rows[0]!.id);
    expect((await getCells(f.db.pool, ref!.fieldId, [id])).get(id)!.status).toBe("error");
    expect(await usageOn(f.db.pool, C, utcDay())).toBe(0);
    down = false;
    await f.ai.fillCompany(C);
    expect(await refunds(f)).toEqual([["please refund me", true]]);
  });

  it("stops when today's budget is used up and carries on where it stopped", async () => {
    const f = await setup();
    await setDecisionSettings(f.db.pool, C, { dailyCap: 1 });
    await f.data.insert(C, OWNER, "tickets", [{ subject: "a refund" }, { subject: "b refund" }, { subject: "c refund" }]);
    await f.addRefund();
    await f.ai.idle(C);
    expect((await refunds(f)).filter(([, value]) => value === true)).toHaveLength(1);
    await setDecisionSettings(f.db.pool, C, { dailyCap: 100 });
    await f.ai.fillCompany(C);
    expect(await refunds(f)).toEqual([["a refund", true], ["b refund", true], ["c refund", true]]);
    expect(f.calls).toHaveLength(3);
  });

  it("retries failed cells only with what is left of the run, after new and changed rows", async () => {
    const f = await setup({ limits: { rowsPerRun: 2 } });
    // Over the 96 KB request limit: refused every run, before the provider or the budget.
    const outsized = "outsized ".repeat(12_000);
    await f.data.insert(C, OWNER, "tickets", [{ subject: `a ${outsized}` }, { subject: `b ${outsized}` }]);
    await f.addRefund();
    await f.ai.idle(C);
    const [ref] = await listAiColumns(f.db.pool, C);
    const errors = async () => (await countCells(f.db.pool, [ref!.fieldId])).get(ref!.fieldId)!.error;
    expect(await errors()).toBe(2);
    await f.data.insert(C, OWNER, "tickets", [{ subject: "c refund" }, { subject: "d refund" }]);
    // The run's two rows go to the new ones; the failed cells wait.
    expect(await f.ai.fillCompany(C)).toMatchObject({ decided: 2, failed: 0 });
    expect(f.calls).toHaveLength(2);
    const { rows } = await f.data.query(C, OWNER, "tickets", { orderBy: [{ field: "subject" }] });
    expect(rows.map((row) => [String(row.subject).slice(0, 1), row.refund])).toEqual([["a", null], ["b", null], ["c", true], ["d", true]]);
    expect(await errors()).toBe(2);
    // Nothing new: now they are retried (and fail again, without asking the provider).
    expect(await f.ai.fillCompany(C)).toMatchObject({ decided: 0, failed: 2 });
    expect(f.calls).toHaveLength(2);
  });

  it("takes at most the run's row limit and stops at its deadline", async () => {
    let clock = 0;
    const f = await setup({ limits: { rowsPerRun: 2, deadlineMs: 1_000 }, now: () => clock });
    await f.data.insert(C, OWNER, "tickets", [{ subject: "a refund" }, { subject: "b refund" }, { subject: "c refund" }]);
    await f.addRefund();
    await f.ai.idle(C);
    expect(f.calls).toHaveLength(2);
    clock = 10_000;
    const report = await f.ai.fillCompany(C, 5_000);
    expect(report.decided).toBe(0);
    clock = 20_000;
    await f.ai.fillCompany(C);
    expect(f.calls).toHaveLength(3);
  });

  it("does nothing for a company with AI columns switched off, and the job only visits companies with them on", async () => {
    const f = await setup();
    await f.data.insert(C, OWNER, "tickets", [{ subject: "please refund me" }]);
    await f.addRefund();
    await f.ai.idle(C);
    await setDecisionSettings(f.db.pool, C, { columns: false });
    await f.data.insert(C, OWNER, "tickets", [{ subject: "another refund" }]);
    expect((await f.ai.fillCompany(C)).stoppedBy).toBe("disabled");
    expect(await f.ai.runJob()).toEqual([]);
    expect(f.calls).toHaveLength(1);
  });
});
