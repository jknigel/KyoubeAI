export type UiFieldKind = "text" | "long_text" | "integer" | "decimal" | "boolean" | "date" | "datetime" | "json" | "select" | "multi_select" | "relation" | "email" | "url";
export interface UiField { name: string; displayName: string; description: string | null; kind: UiFieldKind; required: boolean; options: { choices?: string[]; relationTable?: string }; position: number }
export interface UiTable { name: string; displayName: string; description: string | null; fields: UiField[]; createdAt: string; updatedAt: string }

export function formatCell(kind: UiFieldKind | "system", value: unknown): string {
  if (value === null || value === undefined) return "";
  switch (kind) {
    case "boolean": return value ? "Yes" : "No";
    case "datetime": return new Date(String(value)).toLocaleString();
    case "multi_select": return Array.isArray(value) ? value.join(", ") : String(value);
    case "json": return JSON.stringify(value);
    case "relation": return `${String(value).slice(0, 8)}…`;
    default: return String(value);
  }
}

export function parseCellInput(kind: UiFieldKind, text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "" && kind !== "boolean") return null;
  switch (kind) {
    case "integer": case "decimal": return Number(trimmed);
    case "boolean": return trimmed === "true";
    case "multi_select": return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
    case "json":
      try { return JSON.parse(trimmed); } catch { throw new Error("Invalid JSON"); }
    default: return trimmed;
  }
}

export function emptyRow(fields: UiField[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const field of fields) row[field.name] = field.kind === "boolean" ? false : "";
  return row;
}

/**
 * The message text of a rejected host bridge call (ruling P3-R17). A rejection
 * from `usePluginAction` is *not* an `Error`: upstream's `extractBridgeError`
 * (2026.831.1, `ui/src/plugins/bridge.ts`) returns a plain object literal
 * `{ code, message, details }` — `PluginBridgeError` is an interface, with no
 * class behind it — so `String(error)` on one renders "[object Object]" and
 * loses the worker's wording entirely. The worker's own message travels
 * verbatim in `message` (the worker answers with `createErrorResponse(id,
 * code, err.message)` and the server copies that into the 502 body), and
 * `details` carries the JSON-RPC `data`, which the worker never sets — so
 * `message` is the one field to read. Anything with no usable message reads
 * "error" rather than a stringified object.
 */
export function bridgeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || "error";
  if (typeof error === "string") return error || "error";
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "error";
}

/** What the Data and Apps pages show the user when a bridge call fails. */
export function errorText(error: unknown): string {
  return bridgeErrorMessage(error);
}

/**
 * Prefill value for `RowForm`'s per-field text state. `kind === "json"` must
 * be checked before `Array.isArray`: a json cell can hold an array, and that
 * still needs `JSON.stringify` (round-trippable through `parseCellInput`),
 * not a comma-join (which drops structure and fails to parse back as JSON).
 */
export function initialFormValue(field: UiField, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (field.kind === "json") return JSON.stringify(value);
  if (Array.isArray(value)) return (value as string[]).join(", ");
  return String(value);
}

/** First remaining table name after dropping `droppedName`, or `null` if none remain. */
export function nextSelectedAfterDrop(tables: UiTable[] | null, droppedName: string): string | null {
  return tables?.find((item) => item.name !== droppedName)?.name ?? null;
}

/**
 * Decide which table name should stay selected given the current table list.
 * Returns `selected` unchanged while `tables` is `null` — per
 * `PluginDataResult.data`'s documented contract ("`null` while loading or on
 * error"), that covers not just the initial load but every `refresh()`, so
 * treating "unknown yet" the same as "invalid" would drop a good selection
 * on every schema-changing refresh. Once `tables` is a real (possibly empty)
 * array, keeps `selected` only if it still names a table in that array,
 * otherwise falls back to the first table, or `null` if the list is empty.
 */
export function resolveSelectedTable(tables: UiTable[] | null, selected: string | null): string | null {
  if (!tables) return selected;
  if (selected && tables.some((item) => item.name === selected)) return selected;
  return tables[0]?.name ?? null;
}
