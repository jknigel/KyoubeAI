// scripts/tests/decisions-eval.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { formatReport, parseArgs, percentile, readAnswer, summarise, toWire, validateFixtures } from "../decisions-eval.mjs";

const choice = { type: "choice", instructions: "Which team?", options: { billing: null, technical: null } };
const score = { type: "score", instructions: "How soon?", levels: ["This week", "Today", "Within the hour"] };
const check = { type: "check", statement: "Asks for a refund." };

test("parseArgs takes a preset or a custom https base URL and refuses moving aliases", () => {
  assert.deepEqual(parseArgs(["--provider", "openrouter", "--model", "typesafe/jev-1.13"]), { baseUrl: "https://openrouter.ai/api", model: "typesafe/jev-1.13", suite: null, limit: null, concurrency: 4, threshold: 0.9, json: null });
  assert.equal(parseArgs(["--base-url", "https://kev.example.com/", "--model", "kev-9b", "--suite", "triage", "--limit", "5"]).baseUrl, "https://kev.example.com");
  assert.throws(() => parseArgs(["--provider", "typesafe", "--model", "jev-latest"]), /pinned/);
  assert.throws(() => parseArgs(["--base-url", "http://kev.example.com", "--model", "kev"]), /https/);
  assert.throws(() => parseArgs(["--provider", "typesafe"]), /--model/);
});

test("toWire maps choice, score and check and adds unsure", () => {
  assert.deepEqual(toWire("jev-1.13.0", { a: 1 }, { q: choice, s: score, c: check }), {
    model: "jev-1.13.0",
    state: { a: 1 },
    questions: {
      q: { type: "choice", instructions: "Which team?", criteria: { billing: null, technical: null, unsure: "None of the options clearly fits" } },
      s: { type: "score", instructions: "How soon?", criteria: ["This week", "Today", "Within the hour"] },
      c: { type: "noul", instructions: "Asks for a refund." },
    },
  });
});

test("readAnswer reads each type like the plugin does", () => {
  assert.deepEqual(readAnswer(choice, { choice: "billing", confidence: 0.8 }), { value: "billing", confidence: 0.8 });
  assert.deepEqual(readAnswer(score, { score: 1.2, probabilities: { 0: 0.1, 1: 0.7, 2: 0.2 }, confidence: 0.7 }), { value: "Today", confidence: 0.7 });
  assert.deepEqual(readAnswer(check, { noul: 0.25 }), { value: false, confidence: 0.75 });
  assert.equal(readAnswer(choice, { choice: "sales" }), null);
});

test("summarise reports accuracy, coverage at the threshold and latency", () => {
  const outcomes = [
    { suite: "triage", question: "q", expected: "billing", value: "billing", confidence: 0.95, latencyMs: 200 },
    { suite: "triage", question: "q", expected: "billing", value: "technical", confidence: 0.6, latencyMs: 300 },
    { suite: "triage", question: "q", expected: "technical", value: "unsure", confidence: 0.99, latencyMs: 400 },
    { suite: "triage", question: "q", expected: "technical", value: null, confidence: 0, latencyMs: null, error: "provider_unavailable" },
  ];
  const report = summarise(outcomes, 0.9);
  assert.deepEqual(report.questions["triage.q"], { n: 4, answered: 3, correct: 1, accuracy: 0.25, covered: 1, coverage: 0.25, coveredCorrect: 1, coveredAccuracy: 1 });
  assert.equal(report.errors, 1);
  assert.equal(report.latency.p50, 300);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.match(formatReport(report), /triage\.q\s+4\s+25\.0%\s+25\.0%\s+100\.0%/);
});

test("the fixture file has 200 valid fixtures: 80 triage, 60 tagging, 60 screening", async () => {
  const file = JSON.parse(await readFile(new URL("../decisions-eval.fixtures.json", import.meta.url), "utf8"));
  assert.deepEqual(validateFixtures(file), { total: 200, bySuite: { triage: 80, tagging: 60, screening: 60 } });
});
