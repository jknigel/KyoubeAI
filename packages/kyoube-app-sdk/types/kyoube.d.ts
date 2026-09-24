/**
 * Typings for the window.kyoube runtime available inside KyoubeAI apps.
 *
 * There is nothing else on `window` to reach for. The runner writes one other global,
 * `window.__kyoubeNonce` — the per-mount handshake nonce this SDK stamps on every message it
 * sends (ruling P4-R18) — and before any app-authored script runs the SDK reads it, `delete`s the
 * global, and removes the `<script>` element that carried it (ruling P4-R29), so app code can
 * reach it through neither `window` nor the DOM. It is deliberately not part of this surface: an
 * app cannot post its own requests to the host, and the host accepts none that this SDK did not
 * send — including the handshake the app's context is released against.
 */
export interface KyoubeContext {
  companyId: string;
  /**
   * The person running the app. `name` is always `""` in v1 — the host action
   * context carries ids, not display names, and the runtime does not invent
   * one — so show `id`, or nothing. `level` is the viewer's own Data access,
   * which the app can never exceed: branch on it to hide controls that would
   * only be refused by the worker.
   */
  viewer: { id: string | null; name: string; level: "none" | "read" | "write" | "schema" };
  app: { slug: string; name: string; version: number };
  tables: string[];
}
export type Where = { field: string; op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains" | "starts_with" | "is_null" | "is_not_null"; value?: unknown } | { and: Where[] } | { or: Where[] } | { not: Where };
export interface QuerySpec { where?: Where; orderBy?: Array<{ field: string; direction?: "asc" | "desc" }>; limit?: number; offset?: number; fields?: string[] }
export type Row = Record<string, unknown> & { id: string; created_at: string; updated_at: string };
export interface KyoubeData {
  query(table: string, spec?: QuerySpec): Promise<{ rows: Row[]; limit: number; offset: number }>;
  get(table: string, id: string): Promise<Row | null>;
  count(table: string, where?: Where): Promise<{ count: number }>;
  describe(table: string): Promise<{ name: string; displayName: string; fields: Array<{ name: string; kind: string; required: boolean; options: { choices?: string[]; relationTable?: string } }> }>;
  insert(table: string, rows: Record<string, unknown>[]): Promise<Row[]>;
  update(table: string, target: { ids?: string[]; where?: Where }, patch: Record<string, unknown>): Promise<{ affected: number; rows: Row[] }>;
  delete(table: string, target: { ids?: string[]; where?: Where }): Promise<{ affected: number }>;
}
export interface Kyoube {
  version: 1;
  context: KyoubeContext | null;
  ready(): Promise<KyoubeContext>;
  data: KyoubeData;
  ui: { toast(title: string, tone?: "info" | "success" | "warn" | "error"): Promise<void>; openApp(slug: string): Promise<void> };
  Error: new (code: string, message: string) => Error & { code: string };
}
declare global {
  interface Window { kyoube: Kyoube }
  const kyoube: Kyoube;
}
export {};
