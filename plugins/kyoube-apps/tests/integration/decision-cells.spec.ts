import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataService } from "../../src/data/service.js";
import { resetCompanyCache } from "../../src/db/company-scope.js";
import { migrationsDirFrom, runMetaMigrations } from "../../src/db/migrate.js";
import {
  advanceWatermark,
  cellRowIdsAfter,
  clearForRefill,
  countCells,
  deleteCells,
  errorRowIds,
  getCells,
  listAiColumns,
  markManual,
  resetWatermark,
  reviewCells,
  syncColumn,
  upsertCells,
  watermarkCeiling,
  type AiColumnRef,
} from "../../src/decisions/cells.js";
import { createTestDatabase } from "./setup.js";

const C = "88888888-8888-4888-8888-888888888888";
const OWNER = { kind: "user" as const, id: "owner-1" };
const R1 = "11111111-0000-4000-8000-000000000001";
const R2 = "11111111-0000-4000-8000-000000000002";
const R3 = "11111111-0000-4000-8000-000000000003";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let service: DataService;
let ref: AiColumnRef;

beforeAll(async () => {
  db = await createTestDatabase();
  resetCompanyCache();
  await runMetaMigrations(
    db.pool,
    migrationsDirFrom(import.meta.url.replace("tests/integration/decision-cells.spec.ts", "src/db/migrate.ts")),
  );
  service = new DataService({ pool: db.pool, resolveUserRole: async () => "owner" });
  service.attach({
    aiColumns: {
      assertEnabled: async () => {},
      changed: () => {},
      rowsWritten: async () => {},
      counts: async () => ({}),
      listReview: async () => [],
      refill: async () => {},
      cells: async () => ({ provider: null, counts: {}, cells: {} }),
    },
  });
  await service.createTable(C, OWNER, { name: "tickets", fields: [{ name: "subject", kind: "text" }] });
  await service.addField(C, OWNER, "tickets", {
    name: "refund",
    kind: "boolean",
    options: {
      decision: {
        question: { type: "check", statement: "Asks for a refund." },
        sourceFields: ["subject"],
      },
    },
  });
  [ref] = await listAiColumns(db.pool, C) as [AiColumnRef];
});
afterAll(async () => {
  await db.close();
});

const write = (rowId: string, status: "auto" | "review" | "error" | "manual", suggestion: string | null = "true") =>
  ({
    rowId,
    status,
    suggestion,
    confidence: 0.8,
    decisionId: null,
    sourceHash: `h-${rowId}`,
  });

describe("decision cells", () => {
  it("lists AI columns of active tables with their definition", () => {
    expect(ref).toMatchObject({
      companyId: C,
      table: "tickets",
      field: "refund",
      kind: "boolean",
      definition: { sourceFields: ["subject"] },
    });
  });

  it("keeps the watermark while the fingerprint holds and resets it when the question changes", async () => {
    expect(await syncColumn(db.pool, ref, "fp-1")).toEqual({
      fingerprint: "fp-1",
      at: null,
      id: null,
    });
    await advanceWatermark(db.pool, ref.fieldId, "2026-10-05 10:00:00.123456+00", R1);
    const kept = await syncColumn(db.pool, ref, "fp-1");
    expect(kept.id).toBe(R1);
    // Microseconds survive the round trip: the watermark is text, never a JS Date.
    expect(kept.at).toMatch(/:00\.123456/);
    expect(await syncColumn(db.pool, ref, "fp-2")).toEqual({ fingerprint: "fp-2", at: null, id: null });
    await advanceWatermark(db.pool, ref.fieldId, "2026-10-05 10:00:00+00", R1);
    await resetWatermark(db.pool, ref.fieldId);
    expect((await syncColumn(db.pool, ref, "fp-2")).at).toBeNull();
  });

  it("never moves the watermark past its ceiling, the database clock less the lag", async () => {
    const ceiling = await watermarkCeiling(db.pool, 120_000);
    const clock = await db.pool.query("SELECT $1::timestamptz BETWEEN now() - interval '121 seconds' AND now() - interval '119 seconds' AS near", [ceiling]);
    expect(clock.rows[0]).toEqual({ near: true });
    expect((await syncColumn(db.pool, ref, "fp-3")).at).toBeNull();
    // A scan that went past the ceiling stops at its first position: the instant, the nil uuid.
    await advanceWatermark(db.pool, ref.fieldId, "2026-10-05 10:00:00.5+00", R2, "2026-10-05 10:00:00.25+00");
    const capped = await syncColumn(db.pool, ref, "fp-3");
    expect([capped.at, capped.id]).toEqual([expect.stringMatching(/:00\.25\+/), "00000000-0000-0000-0000-000000000000"]);
    // One that stopped short of it keeps its own position.
    await advanceWatermark(db.pool, ref.fieldId, "2026-10-05 10:00:00.125+00", R2, "2026-10-05 10:00:00.25+00");
    const short = await syncColumn(db.pool, ref, "fp-3");
    expect([short.at, short.id]).toEqual([expect.stringMatching(/:00\.125\+/), R2]);
  });

  it("upserts cells but never overwrites a manual one", async () => {
    await upsertCells(db.pool, ref, [write(R1, "auto"), write(R2, "review"), write(R3, "error", null)]);
    await markManual(db.pool, ref, [R2]);
    await upsertCells(db.pool, ref, [write(R2, "auto", "false")]);
    const cells = await getCells(db.pool, ref.fieldId, [R1, R2, R3]);
    expect(cells.get(R1)).toMatchObject({
      status: "auto",
      suggestion: "true",
      sourceHash: `h-${R1}`,
    });
    expect(cells.get(R2)).toMatchObject({ status: "manual", suggestion: "true" });
    expect(await errorRowIds(db.pool, ref.fieldId, 10)).toEqual([R3]);
  });

  it("counts, lists review cells and pages row ids", async () => {
    await upsertCells(db.pool, ref, [write(R1, "review")]);
    expect((await countCells(db.pool, [ref.fieldId])).get(ref.fieldId)).toEqual({
      auto: 0,
      review: 1,
      manual: 1,
      error: 1,
    });
    expect((await reviewCells(db.pool, ref.fieldId, 10, 0)).map((cell) => cell.rowId)).toEqual([R1]);
    expect(await cellRowIdsAfter(db.pool, ref.fieldId, null, 2)).toEqual([R1, R2]);
    expect(await cellRowIdsAfter(db.pool, ref.fieldId, R2, 2)).toEqual([R3]);
  });

  it("clears every non-manual cell for a refill and deletes on request", async () => {
    await clearForRefill(db.pool, ref.fieldId);
    expect([...(await getCells(db.pool, ref.fieldId, [R1, R2, R3])).keys()]).toEqual([R2]);
    await deleteCells(db.pool, ref.fieldId, [R2]);
    expect((await getCells(db.pool, ref.fieldId, [R2])).size).toBe(0);
  });

  it("goes with its field", async () => {
    await upsertCells(db.pool, ref, [write(R1, "auto")]);
    await service.removeField(C, OWNER, "tickets", "refund");
    const left = await db.pool.query("SELECT count(*)::int AS n FROM kyoube_meta.decision_cells");
    expect(left.rows[0].n).toBe(0);
    expect(await listAiColumns(db.pool, C)).toEqual([]);
  });
});
