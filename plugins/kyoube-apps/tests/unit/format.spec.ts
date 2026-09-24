import { describe, expect, it } from "vitest";
import {
  bridgeErrorMessage,
  emptyRow,
  errorText,
  formatCell,
  initialFormValue,
  nextSelectedAfterDrop,
  parseCellInput,
  resolveSelectedTable,
  type UiField,
  type UiTable,
} from "../../src/ui/format.js";

describe("format helpers", () => {
  it("formats cells for the grid", () => {
    expect(formatCell("text", null)).toBe("");
    expect(formatCell("boolean", true)).toBe("Yes");
    expect(formatCell("datetime", "2026-09-05T10:00:00.000Z")).toMatch(/2026/);
    expect(formatCell("multi_select", ["a", "b"])).toBe("a, b");
    expect(formatCell("json", { a: 1 })).toBe('{"a":1}');
    expect(formatCell("relation", "2f1d8e2a-1f0a-4c7b-9a2d-3b4c5d6e7f80")).toBe("2f1d8e2a…");
  });
  it("parses form input by kind", () => {
    expect(parseCellInput("integer", "42")).toBe(42);
    expect(parseCellInput("decimal", "")).toBeNull();
    expect(parseCellInput("boolean", "true")).toBe(true);
    expect(parseCellInput("multi_select", "a, b")).toEqual(["a", "b"]);
    expect(parseCellInput("json", '{"x":1}')).toEqual({ x: 1 });
    expect(() => parseCellInput("json", "{")).toThrow("JSON");
    expect(parseCellInput("text", " hi ")).toBe("hi");
  });
  it("builds an empty row from fields", () => {
    expect(emptyRow([{ name: "a", kind: "text", required: false, displayName: "A", description: null, options: {}, position: 0 }, { name: "b", kind: "boolean", required: false, displayName: "B", description: null, options: {}, position: 1 }])).toEqual({ a: "", b: false });
  });
});

// Ruling P3-R17: `usePluginAction` rejects with a plain `PluginBridgeError`
// object literal — `{ code, message, details }`, an interface with no class
// behind it (upstream 2026.831.1, `ui/src/plugins/bridge.ts`
// `extractBridgeError`) — so `instanceof Error` is false for every real host
// rejection and `String(error)` renders "[object Object]" in the UI.
describe("bridgeErrorMessage", () => {
  it("reads the message out of the host's plain rejection object", () => {
    expect(bridgeErrorMessage({ code: "WORKER_ERROR", message: "forbidden: viewers cannot write" })).toBe("forbidden: viewers cannot write");
    expect(bridgeErrorMessage({ code: "TIMEOUT", message: "the worker did not answer", details: undefined })).toBe("the worker did not answer");
  });
  it("still reads an Error, a bare string, and anything else", () => {
    expect(bridgeErrorMessage(new Error("boom"))).toBe("boom");
    expect(bridgeErrorMessage("plain text")).toBe("plain text");
    expect(bridgeErrorMessage(undefined)).toBe("error");
    expect(bridgeErrorMessage(null)).toBe("error");
    expect(bridgeErrorMessage({ code: "UNKNOWN" })).toBe("error");
    expect(bridgeErrorMessage({ message: 42 })).toBe("error");
    expect(bridgeErrorMessage("")).toBe("error");
  });
  it("is what errorText shows the user", () => {
    expect(errorText({ code: "WORKER_ERROR", message: 'not_found: app "crm" is not published' })).toBe('not_found: app "crm" is not published');
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText({})).toBe("error");
  });
});

// Fix round 1 (P2-R27 item 2): field.kind === "json" must be checked before
// Array.isArray, so a json cell holding an array round-trips through
// JSON.stringify/parseCellInput instead of being comma-joined and losing its
// structure (and failing to parse back as JSON).
function field(kind: UiField["kind"], overrides: Partial<UiField> = {}): UiField {
  return { name: "f", displayName: "F", description: null, kind, required: false, options: {}, position: 0, ...overrides };
}

describe("initialFormValue", () => {
  it("stringifies a json array as JSON, not a comma-join", () => {
    expect(initialFormValue(field("json"), [1, 2, 3])).toBe("[1,2,3]");
  });
  it("stringifies a json object as JSON", () => {
    expect(initialFormValue(field("json"), { a: 1 })).toBe('{"a":1}');
  });
  it("comma-joins a multi_select array", () => {
    expect(initialFormValue(field("multi_select"), ["a", "b"])).toBe("a, b");
  });
  it("stringifies a boolean", () => {
    expect(initialFormValue(field("boolean"), true)).toBe("true");
  });
  it("blanks null regardless of kind", () => {
    expect(initialFormValue(field("text"), null)).toBe("");
  });
  it("passes a date string through unchanged", () => {
    expect(initialFormValue(field("date"), "2026-09-05")).toBe("2026-09-05");
  });
});

// Fix round 1 (P2-R27 folded item): dropping a table must never re-select the
// table just dropped, and the auto-select effect must not clobber a valid
// selection while `tables.data` is transiently null (a refresh in flight).
function table(name: string): UiTable {
  return { name, displayName: name, description: null, fields: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

describe("nextSelectedAfterDrop", () => {
  it("picks the first remaining table, skipping the dropped one even if it sorts first", () => {
    expect(nextSelectedAfterDrop([table("a"), table("b")], "a")).toBe("b");
  });
  it("returns null once no tables remain", () => {
    expect(nextSelectedAfterDrop([table("a")], "a")).toBeNull();
  });
  it("returns null when the table list is null", () => {
    expect(nextSelectedAfterDrop(null, "a")).toBeNull();
  });
});

describe("resolveSelectedTable", () => {
  it("keeps the current selection while the table list is unknown (null = loading/refreshing)", () => {
    expect(resolveSelectedTable(null, "orders")).toBe("orders");
  });
  it("keeps the current selection when it still names a real table", () => {
    expect(resolveSelectedTable([table("orders"), table("customers")], "orders")).toBe("orders");
  });
  it("falls back to the first table once the selection no longer exists", () => {
    expect(resolveSelectedTable([table("customers")], "orders")).toBe("customers");
  });
  it("picks the first table when nothing is selected yet", () => {
    expect(resolveSelectedTable([table("a")], null)).toBe("a");
  });
  it("returns null when the table list is empty", () => {
    expect(resolveSelectedTable([], null)).toBeNull();
  });
});
