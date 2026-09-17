import { describe, expect, it } from "vitest";
import { actionErrorFrom, bridgeErrorMessage, errorCodeFrom } from "../src/ui/error-code.js";

describe("errorCodeFrom", () => {
  it("extracts the code from a bare '<code>: <text>' message", () => {
    expect(errorCodeFrom(new Error("forbidden: this session belongs to another user"))).toBe("forbidden");
  });

  it("extracts the code from a message the host wrapped with its own prefix", () => {
    expect(errorCodeFrom(new Error("Plugin action failed: forbidden: this session belongs to another user"))).toBe("forbidden");
  });

  it('returns "error" when the message contains no known code', () => {
    expect(errorCodeFrom(new Error("Something went wrong"))).toBe("error");
  });

  it('returns "error" for a non-Error value', () => {
    expect(errorCodeFrom({ weird: true })).toBe("error");
  });

  it('returns "error" for undefined', () => {
    expect(errorCodeFrom(undefined)).toBe("error");
  });

  // Ruling P3-R17 carry-over: `usePluginAction` rejects with a plain
  // `PluginBridgeError` object literal — `{ code, message, details }`, an
  // interface with no class behind it (upstream 2026.831.1,
  // `ui/src/plugins/bridge.ts` `extractBridgeError`) — never an `Error`. The
  // old `instanceof Error ? message : String(error)` read every real host
  // rejection as the string "[object Object]", so this scan never found a
  // known code and every action failure surfaced as the generic "error".
  it("reads the code out of the host's plain rejection object, not its [object Object] string", () => {
    expect(errorCodeFrom({ code: "WORKER_ERROR", message: "forbidden: owner or admin role required" })).toBe("forbidden");
  });
});

describe("bridgeErrorMessage", () => {
  it("reads the message out of the host's plain rejection object", () => {
    expect(bridgeErrorMessage({ code: "WORKER_ERROR", message: "forbidden: owner or admin role required" })).toBe("forbidden: owner or admin role required");
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
});

// Phase 1 deferred minor: the page's banner showed only the extracted code ("Error: limit"),
// so the worker's own sentence — the part that says *which* limit, or *which* session is gone —
// never reached the operator.
describe("actionErrorFrom", () => {
  it("puts the worker's own text in the banner, not just the code", () => {
    expect(actionErrorFrom({ code: "WORKER_ERROR", message: "limit: at most 3 open sessions per user; close one first" })).toEqual({
      code: "limit",
      text: "Error: limit: at most 3 open sessions per user; close one first",
    });
  });

  it("keeps the role hint in front of the worker's text when opening is forbidden", () => {
    expect(actionErrorFrom({ code: "WORKER_ERROR", message: "forbidden: owner or admin role required" }, "Your company role cannot open a terminal.")).toEqual({
      code: "forbidden",
      text: "Your company role cannot open a terminal. (forbidden: owner or admin role required)",
    });
  });

  it("does not claim a role problem for a forbidden the caller gave no hint for", () => {
    expect(actionErrorFrom(new Error("forbidden: this session belongs to another user"))).toEqual({
      code: "forbidden",
      text: "Error: forbidden: this session belongs to another user",
    });
  });

  // P1-R20 (e): a session pruned between two list refreshes answers `not_found` on attach; the
  // page needs the code to know it must refresh the list, and the text to say what happened.
  it("reports not_found for a session the sweep already pruned", () => {
    expect(actionErrorFrom({ code: "WORKER_ERROR", message: "not_found: no session term-abc" })).toEqual({
      code: "not_found",
      text: "Error: not_found: no session term-abc",
    });
  });
});
