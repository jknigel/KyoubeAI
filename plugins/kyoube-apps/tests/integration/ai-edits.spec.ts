// tests/integration/ai-edits.spec.ts
import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { roleNameFor, schemaNameFor } from "../../src/db/company-scope.js";
import type { FetchLike } from "../../src/decisions/client.js";
import { getCells, listAiColumns, markManual } from "../../src/decisions/cells.js";
import { aiFixture, AGENT, OWNER, refundModel } from "./ai-fixture.js";

const C = "aaaaaaaa-9999-4999-8999-999999999999";
let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

/** One row in review ("maybe…", suggestion true) and one auto row ("refund", true). */
async function setup(overrides: Parameters<typeof aiFixture>[2] = {}) {
  const f = await aiFixture(C, "ai-edits.spec.ts", overrides);
  close = () => f.db.close();
  const [maybe, sure] = await f.data.insert(C, OWNER, "tickets", [{ subject: "maybe a refund?" }, { subject: "please refund me" }]);
  await f.addRefund();
  await f.ai.idle(C);
  const [ref] = await listAiColumns(f.db.pool, C);
  const cell = async (id: unknown) => (await getCells(f.db.pool, ref!.fieldId, [String(id)])).get(String(id)) ?? null;
  const outcome = async (id: unknown) => {
    const decisionId = (await cell(id))?.decisionId;
    const rows = await f.db.pool.query("SELECT outcome, outcome_via, outcome_by FROM kyoube_meta.decisions WHERE decision_id = $1", [decisionId]);
    return rows.rows[0] ?? null;
  };
  return { ...f, ref: ref!, maybe: String(maybe!.id), sure: String(sure!.id), cell, outcome };
}

/**
 * The refund model, with room for one thing to happen while the next row is being decided: after
 * the fill job read the row and before it writes the answer.
 */
function interposing() {
  const calls: string[] = [];
  const model = refundModel(calls);
  let pending: (() => Promise<unknown>) | null = null;
  const fetch: FetchLike = async (url, init) => {
    const step = pending;
    pending = null;
    await step?.();
    return model(url, init);
  };
  return { calls, fetch, whileDeciding: (step: () => Promise<unknown>) => { pending = step; } };
}

/** One statement as the company's own role: a row write the edit bookkeeping has not seen yet. */
async function asCompany(pool: Pool, sql: string, params: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO "${schemaNameFor(C)}"`);
    await client.query(`SET LOCAL ROLE "${roleNameFor(C)}"`);
    await client.query(sql, params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("edits to AI cells", () => {
  it("a person's edit equal to the suggestion confirms it", async () => {
    const f = await setup();
    expect(await f.cell(f.maybe)).toMatchObject({ status: "review", suggestion: "true" });
    await f.data.update(C, OWNER, "tickets", { ids: [f.maybe] }, { refund: true });
    expect(await f.cell(f.maybe)).toMatchObject({ status: "manual" });
    expect(await f.outcome(f.maybe)).toEqual({ outcome: "human_confirmed", outcome_via: "data_page", outcome_by: "owner-1" });
    // Protected: a refill leaves it alone.
    f.calls.length = 0;
    await f.data.update(C, OWNER, "tickets", { ids: [f.maybe] }, { subject: "maybe a refund? (updated)" });
    await f.ai.fillCompany(C);
    expect(f.calls).toHaveLength(0);
  });

  it("logs a person's different value as changed", async () => {
    const f = await setup();
    await f.data.update(C, OWNER, "tickets", { ids: [f.sure] }, { refund: false });
    expect(await f.outcome(f.sure)).toMatchObject({ outcome: "human_changed" });
    expect(await f.cell(f.sure)).toMatchObject({ status: "manual" });
  });

  it("makes an agent's or an app's edit manual without an outcome", async () => {
    const f = await setup();
    await f.data.update(C, AGENT, "tickets", { ids: [f.maybe] }, { refund: false });
    expect(await f.cell(f.maybe)).toMatchObject({ status: "manual" });
    expect(await f.outcome(f.maybe)).toMatchObject({ outcome: null });
    await f.data.update(C, OWNER, "tickets", { ids: [f.sure] }, { refund: false }, { app: "triage", version: 1 });
    expect(await f.cell(f.sure)).toMatchObject({ status: "manual" });
    expect(await f.outcome(f.sure)).toMatchObject({ outcome: null });
  });

  it("leaves AI cells alone when a save writes the same values back", async () => {
    const f = await setup();
    await f.data.update(C, OWNER, "tickets", { ids: [f.sure] }, { refund: true });
    await f.data.update(C, OWNER, "tickets", { ids: [f.maybe] }, { refund: null });
    expect(await f.cell(f.sure)).toMatchObject({ status: "auto" });
    expect(await f.cell(f.maybe)).toMatchObject({ status: "review" });
    expect(await f.outcome(f.sure)).toMatchObject({ outcome: null });
  });

  it("hands a cell cleared to empty back to the job", async () => {
    const f = await setup();
    await f.data.update(C, OWNER, "tickets", { ids: [f.sure] }, { refund: false });
    await f.data.update(C, OWNER, "tickets", { ids: [f.sure] }, { refund: null });
    expect(await f.cell(f.sure)).toBeNull();
    await f.ai.fillCompany(C);
    expect(await f.cell(f.sure)).toMatchObject({ status: "auto", suggestion: "true" });
  });

  it("makes a value given at insert manual", async () => {
    const f = await setup();
    const [row] = await f.data.insert(C, AGENT, "tickets", [{ subject: "thanks", refund: true }]);
    expect(await f.cell(row!.id)).toMatchObject({ status: "manual" });
    await f.ai.fillCompany(C);
    expect((await f.data.get(C, OWNER, "tickets", String(row!.id)))!.refund).toBe(true);
  });

  it("purges cells whose rows are gone", async () => {
    const f = await setup();
    await f.data.delete(C, OWNER, "tickets", { ids: [f.sure] });
    expect(await f.ai.purgeOrphans(C)).toBe(1);
    expect(await f.cell(f.sure)).toBeNull();
    expect(await f.cell(f.maybe)).not.toBeNull();
  });

  // Moved from ai-fill.spec.ts (Task 12): the fill half of it needs this task's edit bookkeeping.
  it("refills every cell that is not manual when the question changes", async () => {
    const f = await setup();
    await f.data.update(C, OWNER, "tickets", { ids: [f.maybe] }, { refund: false });
    f.calls.length = 0;
    await f.data.updateField(C, OWNER, "tickets", "refund", { decision: { question: { type: "check", statement: "The customer wants money back." }, sourceFields: ["subject"] } });
    await f.ai.idle(C);
    expect(f.calls).toEqual(['{"subject":"please refund me"}']);
    expect((await f.data.get(C, OWNER, "tickets", f.maybe))!.refund).toBe(false);
    expect((await f.data.get(C, OWNER, "tickets", f.sure))!.refund).toBe(true);
    expect(await f.cell(f.maybe)).toMatchObject({ status: "manual" });
  });
});

describe("edits made while a row is being decided", () => {
  it("keeps a person's value set between the fill's read and its write", async () => {
    const model = interposing();
    const f = await setup({ fetch: model.fetch });
    const [row] = await f.data.insert(C, OWNER, "tickets", [{ subject: "please refund me too" }]);
    const id = String(row!.id);
    model.whileDeciding(() => f.data.update(C, OWNER, "tickets", { ids: [id] }, { refund: false }));
    await f.ai.fillCompany(C);
    expect((await f.data.get(C, OWNER, "tickets", id))!.refund).toBe(false);
    expect(await f.cell(id)).toMatchObject({ status: "manual" });
    model.calls.length = 0;
    await f.ai.fillCompany(C);
    expect(model.calls).toHaveLength(0);
  });

  it("writes nothing for a row whose sources changed meanwhile, and asks again on the next run", async () => {
    const model = interposing();
    const f = await setup({ fetch: model.fetch });
    const [row] = await f.data.insert(C, OWNER, "tickets", [{ subject: "please refund me too" }]);
    const id = String(row!.id);
    model.whileDeciding(() => f.data.update(C, OWNER, "tickets", { ids: [id] }, { subject: "thanks, all sorted" }));
    await f.ai.fillCompany(C);
    // The answer was about the old text: neither the value nor an `auto` cell is kept.
    expect((await f.data.get(C, OWNER, "tickets", id))!.refund).toBeNull();
    expect(await f.cell(id)).toBeNull();
    model.calls.length = 0;
    await f.ai.fillCompany(C);
    expect(model.calls).toEqual(['{"subject":"thanks, all sorted"}']);
    expect((await f.data.get(C, OWNER, "tickets", id))!.refund).toBe(false);
    expect(await f.cell(id)).toMatchObject({ status: "auto", suggestion: "false" });
  });

  it("never writes over a cell that turned manual while it was being decided", async () => {
    const model = interposing();
    const f = await setup({ fetch: model.fetch });
    const [row] = await f.data.insert(C, OWNER, "tickets", [{ subject: "please refund me too" }]);
    const id = String(row!.id);
    // Someone's write committed just before the fill read the row; its bookkeeping lands while
    // the row is being decided.
    await asCompany(f.db.pool, "UPDATE tickets SET refund = false, updated_at = now() WHERE id = $1", [id]);
    model.whileDeciding(() => markManual(f.db.pool, f.ref, [id]));
    await f.ai.fillCompany(C);
    expect((await f.data.get(C, OWNER, "tickets", id))!.refund).toBe(false);
    expect(await f.cell(id)).toMatchObject({ status: "manual" });
  });
});
