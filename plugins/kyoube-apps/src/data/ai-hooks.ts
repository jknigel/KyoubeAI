// src/data/ai-hooks.ts
import type { DataActor } from "./permissions.js";
import type { TableInfo } from "./schema-service.js";
import type { ViaApp } from "./service.js";

/**
 * The seam between the Data layer and the AI-column code in `src/decisions/` (docs/decisions.md).
 * `DataService` calls these through `attach()`; it never imports the decisions module, because
 * `DecisionService` itself depends on `DataService`. Nothing in here carries row values out of
 * the plugin: `rowsWritten` hands rows to in-process bookkeeping only.
 */
export type CellStatus = "auto" | "review" | "manual" | "error";
export interface CellCounts { auto: number; review: number; manual: number; error: number }

export interface AiRowWrite {
  companyId: string;
  actor: DataActor;
  table: TableInfo;
  /** The rows as they are after the write (`RETURNING *`). */
  rows: Array<Record<string, unknown>>;
  /**
   * By row id, the AI columns' values the write replaced, read in the write's own statement: a
   * write that leaves a value as it was changes nothing. Empty for an insert: a new row had none.
   */
  previous: Map<string, Record<string, unknown>>;
  /** The fields the write set: every field for an insert, the patch's keys for an update. */
  fields: string[];
  /** Set when a running app made the write on its viewer's behalf (ruling P4-R21). */
  via: ViaApp | null;
}

export interface ReviewEntry { rowId: string; field: string; suggestion: string | null; confidence: number | null; decisionId: string | null; updatedAt: string }
export interface AiCellView { status: CellStatus; suggestion: string | null; confidence: number | null }
export interface AiCellsView {
  /** The company's provider name (`typesafe`, `openrouter`, …), for "Sends … to …"; null when none is set. */
  provider: string | null;
  counts: Record<string, CellCounts>;
  cells: Record<string, Record<string, AiCellView>>;
}

export interface AiColumnHooks {
  /** Throws `disabled` unless the company has AI columns switched on. */
  assertEnabled(companyId: string): Promise<void>;
  /** An AI column was created or its question changed: fill the company in the background. */
  changed(companyId: string): void;
  /** Rows written by anyone but the fill job, after the write committed. */
  rowsWritten(event: AiRowWrite): Promise<void>;
  counts(companyId: string, table: TableInfo): Promise<Record<string, CellCounts>>;
  listReview(companyId: string, table: TableInfo, field: string | null, limit: number, offset: number): Promise<ReviewEntry[]>;
  refill(companyId: string, table: TableInfo, field: string): Promise<void>;
  cells(companyId: string, table: TableInfo, rowIds: string[]): Promise<AiCellsView>;
}
