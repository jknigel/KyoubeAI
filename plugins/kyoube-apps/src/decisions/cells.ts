import type { Pool, PoolClient } from "pg";
import type { CellCounts, CellStatus } from "../data/ai-hooks.js";
import type { AiColumnDefinition, FieldKind } from "../data/field-kinds.js";

/**
 * AI-column bookkeeping in kyoube_meta. Read and written with the login role (the pool, or a
 * scoped transaction after `asOwner()`): a company role cannot see kyoube_meta at all.
 */
type Db = Pool | PoolClient;

export interface AiColumnRef {
  fieldId: string;
  tableId: string;
  companyId: string;
  table: string;
  field: string;
  kind: FieldKind;
  definition: AiColumnDefinition;
}
export interface CellState {
  rowId: string;
  status: CellStatus;
  suggestion: string | null;
  confidence: number | null;
  decisionId: string | null;
  sourceHash: string | null;
  updatedAt: string;
}
export interface CellWrite {
  rowId: string;
  status: CellStatus;
  suggestion: string | null;
  confidence: number | null;
  decisionId: string | null;
  sourceHash: string | null;
}
export interface Watermark {
  fingerprint: string;
  at: string | null;
  id: string | null;
}

interface CellRow {
  row_id: string;
  status: CellStatus;
  suggestion: string | null;
  confidence: number | null;
  decision_id: string | null;
  source_hash: string | null;
  updated_at: Date;
}
const CELL_COLUMNS = "row_id, status, suggestion, confidence, decision_id, source_hash, updated_at";

function toState(row: CellRow): CellState {
  return {
    rowId: row.row_id,
    status: row.status,
    suggestion: row.suggestion,
    confidence: row.confidence,
    decisionId: row.decision_id,
    sourceHash: row.source_hash,
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listAiColumns(
  pool: Pool,
  companyId: string,
  table?: string,
): Promise<AiColumnRef[]> {
  const result = await pool.query<{
    field_id: string;
    table_id: string;
    table_name: string;
    field_name: string;
    kind: FieldKind;
    decision: AiColumnDefinition;
  }>(
    `SELECT f.id AS field_id, t.id AS table_id, t.name AS table_name, f.name AS field_name, f.kind, f.options -> 'decision' AS decision
       FROM kyoube_meta.fields f JOIN kyoube_meta.tables t ON t.id = f.table_id
      WHERE t.company_id = $1 AND t.status = 'active' AND f.options ? 'decision' AND ($2::text IS NULL OR t.name = $2)
      ORDER BY t.name, f.position, f.name`,
    [companyId, table ?? null],
  );
  return result.rows.map((row) => ({
    fieldId: row.field_id,
    tableId: row.table_id,
    companyId,
    table: row.table_name,
    field: row.field_name,
    kind: row.kind,
    definition: row.decision,
  }));
}

/** Registers the column, keeping its watermark only while the fingerprint is unchanged. */
export async function syncColumn(pool: Pool, ref: AiColumnRef, fingerprint: string): Promise<Watermark> {
  const result = await pool.query<{ fingerprint: string; at: string | null; id: string | null }>(
    `INSERT INTO kyoube_meta.decision_columns (field_id, company_id, table_id, fingerprint) VALUES ($1, $2, $3, $4)
     ON CONFLICT (field_id) DO UPDATE SET
       scanned_through_at = CASE WHEN decision_columns.fingerprint = EXCLUDED.fingerprint THEN decision_columns.scanned_through_at END,
       scanned_through_id = CASE WHEN decision_columns.fingerprint = EXCLUDED.fingerprint THEN decision_columns.scanned_through_id END,
       fingerprint = EXCLUDED.fingerprint,
       updated_at = now()
     RETURNING fingerprint, scanned_through_at::text AS at, scanned_through_id::text AS id`,
    [ref.fieldId, ref.companyId, ref.tableId, fingerprint],
  );
  return result.rows[0]!;
}

/**
 * The database's clock less `lagMs`, as text like `updated_at::text`. Read before a scan, it is the
 * furthest that scan may move the watermark (see `advanceWatermark`).
 */
export async function watermarkCeiling(pool: Pool, lagMs: number): Promise<string> {
  const result = await pool.query<{ at: string }>("SELECT (now() - $1::int * interval '1 millisecond')::text AS at", [lagMs]);
  return result.rows[0]!.at;
}

/**
 * `at` is the `updated_at::text` the scan read: microseconds, which a JS Date would lose. With a
 * `ceiling`, the watermark goes no further than (ceiling, nil uuid), the first position at that
 * instant: whichever of the two positions comes first is kept.
 */
export async function advanceWatermark(pool: Pool, fieldId: string, at: string, id: string, ceiling: string | null = null): Promise<void> {
  await pool.query(
    `UPDATE kyoube_meta.decision_columns AS c SET scanned_through_at = w.at, scanned_through_id = w.id, updated_at = now()
       FROM (SELECT v.at, v.id FROM (VALUES ($2::timestamptz, $3::uuid), ($4::timestamptz, '00000000-0000-0000-0000-000000000000'::uuid)) AS v(at, id)
              WHERE v.at IS NOT NULL ORDER BY v.at, v.id LIMIT 1) AS w
      WHERE c.field_id = $1`,
    [fieldId, at, id, ceiling],
  );
}

export async function resetWatermark(pool: Pool, fieldId: string): Promise<void> {
  await pool.query(
    "UPDATE kyoube_meta.decision_columns SET scanned_through_at = NULL, scanned_through_id = NULL, updated_at = now() WHERE field_id = $1",
    [fieldId],
  );
}

export async function getCells(db: Db, fieldId: string, rowIds: string[]): Promise<Map<string, CellState>> {
  if (rowIds.length === 0) return new Map();
  const result = await db.query<CellRow>(
    `SELECT ${CELL_COLUMNS} FROM kyoube_meta.decision_cells WHERE field_id = $1 AND row_id = ANY($2::uuid[])`,
    [fieldId, rowIds],
  );
  return new Map(result.rows.map((row) => [row.row_id, toState(row)]));
}

/** The fill job's write. A cell a person or agent set (`manual`) is never overwritten. */
export async function upsertCells(db: Db, ref: AiColumnRef, writes: CellWrite[]): Promise<void> {
  if (writes.length === 0) return;
  await db.query(
    `INSERT INTO kyoube_meta.decision_cells (field_id, row_id, company_id, table_id, status, suggestion, confidence, decision_id, source_hash, updated_at)
     SELECT $1, w.row_id, $2, $3, w.status, w.suggestion, w.confidence, w.decision_id, w.source_hash, now()
       FROM unnest($4::uuid[], $5::text[], $6::text[], $7::float8[], $8::uuid[], $9::text[]) AS w(row_id, status, suggestion, confidence, decision_id, source_hash)
     ON CONFLICT (field_id, row_id) DO UPDATE SET
       status = EXCLUDED.status, suggestion = EXCLUDED.suggestion, confidence = EXCLUDED.confidence,
       decision_id = EXCLUDED.decision_id, source_hash = EXCLUDED.source_hash, updated_at = now()
     WHERE decision_cells.status <> 'manual'`,
    [
      ref.fieldId,
      ref.companyId,
      ref.tableId,
      writes.map((w) => w.rowId),
      writes.map((w) => w.status),
      writes.map((w) => w.suggestion),
      writes.map((w) => w.confidence),
      writes.map((w) => w.decisionId),
      writes.map((w) => w.sourceHash),
    ],
  );
}

/** A value someone other than the fill job set. The last suggestion stays for the record. */
export async function markManual(db: Db, ref: AiColumnRef, rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) return;
  await db.query(
    `INSERT INTO kyoube_meta.decision_cells (field_id, row_id, company_id, table_id, status, updated_at)
     SELECT $1, unnest($4::uuid[]), $2, $3, 'manual', now()
     ON CONFLICT (field_id, row_id) DO UPDATE SET status = 'manual', updated_at = now()`,
    [ref.fieldId, ref.companyId, ref.tableId, rowIds],
  );
}

export async function deleteCells(db: Db, fieldId: string, rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) return;
  await db.query("DELETE FROM kyoube_meta.decision_cells WHERE field_id = $1 AND row_id = ANY($2::uuid[])", [
    fieldId,
    rowIds,
  ]);
}

export async function clearForRefill(pool: Pool, fieldId: string): Promise<void> {
  await pool.query("DELETE FROM kyoube_meta.decision_cells WHERE field_id = $1 AND status <> 'manual'", [fieldId]);
}

export async function errorRowIds(pool: Pool, fieldId: string, limit: number): Promise<string[]> {
  const result = await pool.query<{ row_id: string }>(
    "SELECT row_id FROM kyoube_meta.decision_cells WHERE field_id = $1 AND status = 'error' ORDER BY updated_at, row_id LIMIT $2",
    [fieldId, limit],
  );
  return result.rows.map((row) => row.row_id);
}

export async function countCells(pool: Pool, fieldIds: string[]): Promise<Map<string, CellCounts>> {
  const counts = new Map<string, CellCounts>(
    fieldIds.map((id) => [id, { auto: 0, review: 0, manual: 0, error: 0 }]),
  );
  if (fieldIds.length === 0) return counts;
  const result = await pool.query<{ field_id: string; status: CellStatus; n: number }>(
    "SELECT field_id, status, count(*)::int AS n FROM kyoube_meta.decision_cells WHERE field_id = ANY($1::uuid[]) GROUP BY field_id, status",
    [fieldIds],
  );
  for (const row of result.rows) counts.get(row.field_id)![row.status] = row.n;
  return counts;
}

export async function reviewCells(pool: Pool, fieldId: string, limit: number, offset: number): Promise<CellState[]> {
  const result = await pool.query<CellRow>(
    `SELECT ${CELL_COLUMNS} FROM kyoube_meta.decision_cells WHERE field_id = $1 AND status = 'review' ORDER BY updated_at DESC, row_id LIMIT $2 OFFSET $3`,
    [fieldId, limit, offset],
  );
  return result.rows.map(toState);
}

export async function cellRowIdsAfter(
  pool: Pool,
  fieldId: string,
  after: string | null,
  limit: number,
): Promise<string[]> {
  const result = await pool.query<{ row_id: string }>(
    "SELECT row_id FROM kyoube_meta.decision_cells WHERE field_id = $1 AND ($2::uuid IS NULL OR row_id > $2::uuid) ORDER BY row_id LIMIT $3",
    [fieldId, after, limit],
  );
  return result.rows.map((row) => row.row_id);
}
