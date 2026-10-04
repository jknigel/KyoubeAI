// tests/unit/ai-column-field.spec.ts
import { describe, expect, it } from "vitest";
import { DataError } from "../../src/data/errors.js";
import { aiColumnChoices, aiColumnKind, isAiColumn, normalizeFieldSpec } from "../../src/data/field-kinds.js";

const queue = { type: "choice", instructions: "Which team owns this ticket?", options: { billing: null, technical: "Bugs", unsure: null } };
const urgency = { type: "score", instructions: "How soon?", levels: ["week", "today", "hour"] };
const refund = { type: "check", statement: "The ticket asks for a refund." };

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (error) { return error instanceof DataError ? `${error.code}: ${error.message}` : "not-a-data-error"; }
  return undefined;
}

describe("AI column field specs", () => {
  it("makes a choice question a select whose choices are its options without unsure", () => {
    const spec = normalizeFieldSpec({ name: "queue", kind: "select", options: { decision: { question: queue, sourceFields: ["subject", "body", "subject"] } } });
    expect(spec.options.choices).toEqual(["billing", "technical"]);
    expect(spec.options.decision).toEqual({ question: queue, sourceFields: ["subject", "body"] });
    expect(isAiColumn(spec)).toBe(true);
  });
  it("makes a score question a select of its levels, in order, and a check a boolean", () => {
    expect(normalizeFieldSpec({ name: "urgency", kind: "select", options: { decision: { question: urgency, sourceFields: ["body"] } } }).options.choices).toEqual(["week", "today", "hour"]);
    const check = normalizeFieldSpec({ name: "refund", kind: "boolean", options: { decision: { question: refund, sourceFields: ["body"], advisory: true } } });
    expect(check.options).toEqual({ decision: { question: refund, sourceFields: ["body"], advisory: true } });
    expect(isAiColumn(normalizeFieldSpec({ name: "plain", kind: "text" }))).toBe(false);
  });
  it("exposes the kind and choices a question implies", () => {
    expect(aiColumnKind(refund as never)).toBe("boolean");
    expect(aiColumnKind(queue as never)).toBe("select");
    expect(aiColumnChoices(refund as never)).toBeUndefined();
  });
  it("refuses a kind that does not match the question", () => {
    expect(code(() => normalizeFieldSpec({ name: "refund", kind: "select", options: { decision: { question: refund, sourceFields: ["body"] } } }))).toMatch(/kind must be boolean/);
    expect(code(() => normalizeFieldSpec({ name: "queue", kind: "text", options: { decision: { question: queue, sourceFields: ["body"] } } }))).toMatch(/kind must be select/);
  });
  it("refuses required AI columns, hand-written choices, and more than 200 options", () => {
    expect(code(() => normalizeFieldSpec({ name: "refund", kind: "boolean", required: true, options: { decision: { question: refund, sourceFields: ["body"] } } }))).toMatch(/cannot be required/);
    expect(code(() => normalizeFieldSpec({ name: "queue", kind: "select", options: { choices: ["billing"], decision: { question: queue, sourceFields: ["body"] } } }))).toMatch(/come from its question/);
    const options = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`o${i}`, null]));
    expect(code(() => normalizeFieldSpec({ name: "big", kind: "select", options: { decision: { question: { ...queue, options }, sourceFields: ["body"] } } }))).toMatch(/at most 200/);
  });
  it("refuses a column that reads itself, bad source names, and a bad question", () => {
    expect(code(() => normalizeFieldSpec({ name: "refund", kind: "boolean", options: { decision: { question: refund, sourceFields: ["refund"] } } }))).toMatch(/cannot read itself/);
    expect(code(() => normalizeFieldSpec({ name: "refund", kind: "boolean", options: { decision: { question: refund, sourceFields: ["Body"] } } }))).toMatch(/^invalid/);
    expect(code(() => normalizeFieldSpec({ name: "refund", kind: "boolean", options: { decision: { question: refund, sourceFields: [] } } }))).toMatch(/^invalid/);
    expect(code(() => normalizeFieldSpec({ name: "refund", kind: "boolean", options: { decision: { question: { type: "check" }, sourceFields: ["body"] } } }))).toMatch(/options\.decision\.question/);
  });
});
