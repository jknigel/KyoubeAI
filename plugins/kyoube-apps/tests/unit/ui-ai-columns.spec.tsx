// tests/unit/ui-ai-columns.spec.tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RowForm, rowFromValues } from "../../src/ui/forms.js";
import { aiDraftToSpec, AiColumnEditor, AiColumnHeader, emptyAiColumnDraft, percent, ReviewCell, rowFormFields, sendsText, suggestionValue } from "../../src/ui/AiColumns.js";
import type { UiField } from "../../src/ui/format.js";

const refund: UiField = { name: "refund", displayName: "Refund", description: null, kind: "boolean", required: false, position: 2,
  options: { decision: { question: { type: "check", statement: "Asks for a refund." }, sourceFields: ["subject", "body"] } } };
const subject: UiField = { name: "subject", displayName: "Subject", description: null, kind: "text", required: false, position: 0, options: {} };
const owner: UiField = { name: "owner", displayName: "Owner", description: null, kind: "relation", required: false, position: 1, options: { relationTable: "people" } };

describe("AI column UI", () => {
  it("says what the column sends and where", () => {
    expect(sendsText(refund, "openrouter")).toBe("Sends subject, body to openrouter");
    expect(sendsText(refund, null)).toBe("Sends subject, body to the company's provider");
    expect(percent(0.724)).toBe("72%");
    expect(percent(null)).toBe("?");
  });
  it("renders the header with the review count and Refill for schema access", () => {
    const html = renderToStaticMarkup(createElement(AiColumnHeader, { field: refund, provider: "openrouter", counts: { auto: 3, review: 12, manual: 0, error: 1 }, canSchema: true, onRefill: () => {} }));
    expect(html).toContain("AI");
    expect(html).toContain("Sends subject, body to openrouter");
    expect(html).toContain("12 to review");
    expect(html).toContain("Refill");
    expect(renderToStaticMarkup(createElement(AiColumnHeader, { field: refund, provider: null, counts: null, canSchema: false, onRefill: () => {} }))).not.toContain("Refill");
  });
  it("renders a review cell with Accept and Change", () => {
    const html = renderToStaticMarkup(createElement(ReviewCell, { suggestion: "billing", confidence: 0.72, canWrite: true, onAccept: () => {}, onChange: () => {} }));
    expect(html).toContain("Suggested: billing (72%)");
    expect(html).toContain("Accept");
    expect(html).toContain("Change");
    expect(renderToStaticMarkup(createElement(ReviewCell, { suggestion: "billing", confidence: 0.72, canWrite: false, onAccept: () => {}, onChange: () => {} }))).not.toContain("Accept");
  });
  it("turns a draft into a field spec for each question type", () => {
    const base = { ...emptyAiColumnDraft(), name: "queue", text: "Which team?", sources: ["subject"] };
    expect(aiDraftToSpec({ ...base, type: "choice", options: "billing: Payments and refunds\ntechnical" })).toEqual({
      name: "queue", kind: "select", options: { decision: { question: { type: "choice", instructions: "Which team?", options: { billing: "Payments and refunds", technical: null } }, sourceFields: ["subject"] } },
    });
    expect(aiDraftToSpec({ ...base, type: "score", options: "week\ntoday\nhour", review: "0.95" }).options.decision.question).toEqual({ type: "score", instructions: "Which team?", levels: ["week", "today", "hour"], review: 0.95 });
    expect(aiDraftToSpec({ ...base, name: "refund", type: "check", text: "Asks for a refund.", advisory: true })).toEqual({
      name: "refund", kind: "boolean", options: { decision: { question: { type: "check", statement: "Asks for a refund." }, sourceFields: ["subject"], advisory: true } },
    });
  });
  it("offers only plain, non-relation fields as sources", () => {
    const html = renderToStaticMarkup(createElement(AiColumnEditor, { draft: emptyAiColumnDraft(), fields: [subject, owner, refund], onChange: () => {} }));
    expect(html).toContain("subject");
    expect(html).not.toContain(">owner<");
    expect(html).not.toContain(">refund<");
  });
  it("turns a suggestion back into a value", () => {
    expect(suggestionValue(refund, "true")).toBe(true);
    expect(suggestionValue({ ...refund, kind: "select" }, "billing")).toBe("billing");
  });
  it("keeps AI columns out of the row forms", () => {
    const fields = rowFormFields([subject, refund]);
    expect(fields.map((field) => field.name)).toEqual(["subject"]);
    // The edit form's submitted row carries only the fields it shows.
    expect(rowFromValues(fields, { subject: "hello", refund: "true" })).toEqual({ subject: "hello" });
    const html = renderToStaticMarkup(createElement(RowForm, { fields, initial: { subject: "hello", refund: true }, submitLabel: "Save", onSubmit: async () => {}, onCancel: () => {} }));
    expect(html).toContain("Subject");
    expect(html).not.toContain("Refund");
  });
});
