import { describe, expect, it } from "vitest";
import {
  answerStatus, assertRequestSize, MAX_REQUEST_BYTES, parseDecideRequest, parseQuestions, questionFingerprint,
  reviewThreshold, UNSURE, withUnsure, type Question,
} from "../../src/decisions/contract.js";
import { DataError } from "../../src/data/errors.js";

const queue: Question = { type: "choice", instructions: "Which team owns this ticket?", options: { billing: null, technical: "Bugs and outages" } };
const urgency: Question = { type: "score", instructions: "How soon?", levels: ["This week", "Today", "Within the hour"] };
const refund: Question = { type: "check", statement: "The customer asks for a refund." };

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (error) { return error instanceof DataError ? error.code : "not-a-data-error"; }
  return undefined;
}

describe("parseQuestions", () => {
  it("accepts the three question types", () => {
    expect(parseQuestions({ queue, urgency, refund })).toEqual({ queue, urgency, refund });
  });
  it("refuses keys outside ^[a-z][a-z0-9_]{0,39}$", () => {
    expect(code(() => parseQuestions({ Queue: queue }))).toBe("invalid");
    expect(code(() => parseQuestions({ ["a".repeat(41)]: queue }))).toBe("invalid");
  });
  it("needs 1 to 20 questions", () => {
    expect(code(() => parseQuestions({}))).toBe("invalid");
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`q${i}`, refund]));
    expect(code(() => parseQuestions(many))).toBe("invalid");
  });
  it("needs 2 to 254 real options on a choice; unsure does not count", () => {
    expect(code(() => parseQuestions({ q: { ...queue, options: { billing: null, unsure: null } } }))).toBe("invalid");
    const options254 = Object.fromEntries(Array.from({ length: 254 }, (_, i) => [`o${i}`, null]));
    expect(parseQuestions({ q: { ...queue, options: { ...options254, unsure: null } } }).q).toBeDefined();
    expect(code(() => parseQuestions({ q: { ...queue, options: { ...options254, o254: null } } }))).toBe("invalid");
  });
  it("needs 2 to 10 distinct score levels", () => {
    expect(code(() => parseQuestions({ q: { ...urgency, levels: ["only"] } }))).toBe("invalid");
    expect(code(() => parseQuestions({ q: { ...urgency, levels: Array.from({ length: 11 }, (_, i) => `l${i}`) } }))).toBe("invalid");
    expect(code(() => parseQuestions({ q: { ...urgency, levels: ["a", "a"] } }))).toBe("invalid");
  });
  it("refuses unknown keys and out-of-range thresholds", () => {
    expect(code(() => parseQuestions({ q: { ...refund, extra: true } }))).toBe("invalid");
    expect(code(() => parseQuestions({ q: { ...refund, review: 1.5 } }))).toBe("invalid");
  });
});

describe("parseDecideRequest", () => {
  it("takes text or an object as state", () => {
    expect(parseDecideRequest({ state: "hello", questions: { refund } }).state).toBe("hello");
    expect(parseDecideRequest({ state: { body: "hello" }, questions: { refund } }).state).toEqual({ body: "hello" });
    expect(code(() => parseDecideRequest({ state: "", questions: { refund } }))).toBe("invalid");
  });
});

describe("withUnsure", () => {
  it("adds an unsure option to a choice once", () => {
    const once = withUnsure(queue);
    expect(once.type === "choice" && Object.keys(once.options)).toEqual(["billing", "technical", UNSURE]);
    expect(withUnsure(once)).toEqual(once);
    expect(withUnsure(urgency)).toBe(urgency);
  });
});

describe("questionFingerprint", () => {
  it("ignores key order, review thresholds and the added unsure option", () => {
    const reordered: Question = { type: "choice", options: { technical: "Bugs and outages", billing: null }, instructions: "Which team owns this ticket?", review: 0.5 };
    expect(questionFingerprint(reordered)).toBe(questionFingerprint(queue));
    expect(questionFingerprint(withUnsure(queue))).toBe(questionFingerprint(queue));
    expect(questionFingerprint(queue)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("changes when the wording changes", () => {
    expect(questionFingerprint({ ...refund, statement: "The customer asks for money back." })).not.toBe(questionFingerprint(refund));
  });
});

describe("assertRequestSize", () => {
  it("allows a request at the limit and refuses one over it", () => {
    expect(() => assertRequestSize({ state: "x", questions: { refund } })).not.toThrow();
    expect(code(() => assertRequestSize({ state: "x".repeat(MAX_REQUEST_BYTES), questions: { refund } }))).toBe("too_large");
  });
  it("counts bytes, not characters", () => {
    // 40,000 "é" is 40,000 characters but 80,000 bytes, plus the rest of the JSON: still under.
    expect(() => assertRequestSize({ state: "é".repeat(40_000), questions: { refund } })).not.toThrow();
    // 50,000 "é" is 100,000 bytes: over, although it is only 50,000 characters.
    expect(code(() => assertRequestSize({ state: "é".repeat(50_000), questions: { refund } }))).toBe("too_large");
  });
  it("boundary: exactly MAX_REQUEST_BYTES passes, one byte more fails", () => {
    // Create state that when serialized is exactly MAX_REQUEST_BYTES
    // Using 49,103 "é" characters (2 bytes each) gives 98,206 bytes of state content
    const atLimit = "é".repeat(49_103);
    const atLimitRequest = { state: atLimit, questions: { refund } };
    const atLimitBytes = Buffer.byteLength(JSON.stringify(atLimitRequest), "utf8");

    // Verify it's exactly at the limit
    expect(atLimitBytes).toBe(MAX_REQUEST_BYTES);
    expect(() => assertRequestSize(atLimitRequest)).not.toThrow();

    // Create state that is exactly 1 byte over (49,103 "é" + "x")
    const overLimit = "é".repeat(49_103) + "x";
    const overLimitRequest = { state: overLimit, questions: { refund } };
    const overLimitBytes = Buffer.byteLength(JSON.stringify(overLimitRequest), "utf8");

    // Verify it's exactly 1 byte over the limit
    expect(overLimitBytes).toBe(MAX_REQUEST_BYTES + 1);
    expect(code(() => assertRequestSize(overLimitRequest))).toBe("too_large");
  });
});

describe("answerStatus", () => {
  it("uses the question's threshold or 0.9", () => {
    expect(reviewThreshold(refund)).toBe(0.9);
    expect(reviewThreshold({ ...refund, review: 0.6 })).toBe(0.6);
    expect(answerStatus(refund, true, 0.95)).toBe("auto");
    expect(answerStatus(refund, true, 0.85)).toBe("review");
    expect(answerStatus({ ...refund, review: 0.6 }, true, 0.85)).toBe("auto");
  });
  it("always reviews unsure and advisory answers", () => {
    expect(answerStatus(queue, UNSURE, 0.99)).toBe("review");
    expect(answerStatus({ ...queue, review: 0 }, UNSURE, 0.99)).toBe("review");
    expect(answerStatus(queue, "billing", 0.99, true)).toBe("review");
  });
});
