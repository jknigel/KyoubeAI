// tests/integration/ai-review.spec.ts
import { afterEach, describe, expect, it } from "vitest";
import { DataError } from "../../src/data/errors.js";
import { aiFixture, OWNER } from "./ai-fixture.js";

const C = "bbbbbbbb-9999-4999-8999-999999999999";
let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

async function setup() {
  const f = await aiFixture(C, "ai-review.spec.ts");
  close = () => f.db.close();
  const [maybe, sure] = await f.data.insert(C, OWNER, "tickets", [{ subject: "maybe a refund?" }, { subject: "please refund me" }]);
  await f.addRefund();
  await f.ai.idle(C);
  return { ...f, maybe: String(maybe!.id), sure: String(sure!.id) };
}

describe("reviewing AI columns", () => {
  it("counts cells per status in describe", async () => {
    const f = await setup();
    expect((await f.data.describeTable(C, OWNER, "tickets")).aiColumns).toEqual({ refund: { auto: 1, review: 1, manual: 0, error: 0 } });
  });

  it("lists review cells without row values", async () => {
    const f = await setup();
    const { rows } = await f.data.listReview(C, OWNER, "tickets", {});
    expect(rows).toEqual([{ rowId: f.maybe, field: "refund", suggestion: "true", confidence: 0.6, decisionId: expect.any(String), updatedAt: expect.any(String) }]);
    expect(JSON.stringify(rows)).not.toContain("maybe a refund");
    await expect(f.data.listReview(C, OWNER, "tickets", { field: "subject" })).rejects.toThrow(/not an AI column/);
  });

  it("shows the cells of visible rows with the provider name", async () => {
    const f = await setup();
    const view = await f.data.aiCells(C, OWNER, "tickets", [f.maybe, f.sure]);
    expect(view.provider).toBe("typesafe");
    expect(view.counts.refund).toEqual({ auto: 1, review: 1, manual: 0, error: 0 });
    expect(view.cells.refund![f.maybe]).toEqual({ status: "review", suggestion: "true", confidence: 0.6 });
  });

  it("refills every cell that is not manual", async () => {
    const f = await setup();
    await f.data.update(C, OWNER, "tickets", { ids: [f.maybe] }, { refund: false });
    f.calls.length = 0;
    expect(await f.data.refillAiColumn(C, OWNER, "tickets", "refund")).toEqual({ ok: true });
    await f.ai.idle(C);
    expect(f.calls).toHaveLength(1);
    await expect(f.data.refillAiColumn(C, { kind: "agent", id: "nobody", runId: null }, "tickets", "refund")).rejects.toBeInstanceOf(DataError);
  });
});
