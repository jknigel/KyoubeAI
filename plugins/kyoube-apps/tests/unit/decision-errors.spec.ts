import { describe, expect, it } from "vitest";
import { errorBody, statusForError } from "../../src/api-routes.js";
import { DataError } from "../../src/data/errors.js";
import { toolErrorText } from "../../src/tool-runtime.js";

describe("decision error codes", () => {
  it.each([
    ["disabled", 403], ["budget_exceeded", 429], ["too_large", 413], ["provider_rejected", 502],
    ["provider_unavailable", 503], ["timeout", 504], ["held", 409], ["rejected_by_person", 403],
    ["guardrail_context_required", 428],
  ] as const)("maps %s to HTTP %i", (code, status) => {
    expect(statusForError(new DataError(code, "x"))).toBe(status);
  });

  it("keeps the old codes", () => {
    expect(statusForError(new DataError("invalid", "x"))).toBe(400);
    expect(statusForError(new DataError("limit", "x"))).toBe(413);
    expect(statusForError(new Error("boom"))).toBe(500);
  });

  it("carries caller-safe details into the REST body without letting them replace error or code", () => {
    const error = new DataError("held", "the guardrail held this action", { details: { confirmationId: "card-1", code: "spoof", error: "spoof" } });
    expect(error.details).toEqual({ confirmationId: "card-1", code: "spoof", error: "spoof" });
    expect(errorBody(error)).toEqual({ confirmationId: "card-1", error: "held: the guardrail held this action", code: "held" });
  });

  it("puts details into the tool error text", () => {
    const error = new DataError("held", "wait for the person", { details: { confirmationId: "card-1" } });
    expect(toolErrorText(error)).toBe('held: wait for the person {"confirmationId":"card-1"}');
    expect(toolErrorText(new DataError("invalid", "bad"))).toBe("invalid: bad");
  });

  it("still records a cause only when one is given", () => {
    expect(new DataError("timeout", "x").cause).toBeUndefined();
    const cause = new Error("driver");
    expect(new DataError("timeout", "x", { cause }).cause).toBe(cause);
  });
});
