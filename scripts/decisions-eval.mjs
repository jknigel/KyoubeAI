// scripts/decisions-eval.mjs
// Runs the labelled fixtures in decisions-eval.fixtures.json against a real /v1/systemone provider.
// By hand, with your own key, never in CI: it costs money and needs the network. It reports, per
// question, how often the model is right, how many answers clear the review threshold (the ones
// Kyoube would act on), how often those are right, and latency. Use it to check a provider and
// model before switching a use on, and to tune review thresholds. Nothing is written anywhere
// unless --json is given.
//
//   KYOUBE_EVAL_API_KEY=… node scripts/decisions-eval.mjs --provider openrouter --model typesafe/jev-1.13
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const PRESETS = { typesafe: "https://api.typesafe.ai", openrouter: "https://openrouter.ai/api", vercel: "https://ai-gateway.vercel.sh/typesafe" };
export const UNSURE = "unsure";
const UNSURE_DESCRIPTION = "None of the options clearly fits";
const PRICE_PER_MTOK = 0.042;

export function parseArgs(argv) {
  const args = { provider: null, baseUrl: null, model: null, suite: null, limit: null, concurrency: 4, threshold: 0.9, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const take = () => { if (value === undefined) throw new Error(`${flag} needs a value`); i += 1; return value; };
    if (flag === "--provider") args.provider = take();
    else if (flag === "--base-url") args.baseUrl = take();
    else if (flag === "--model") args.model = take();
    else if (flag === "--suite") args.suite = take();
    else if (flag === "--limit") args.limit = Number(take());
    else if (flag === "--concurrency") args.concurrency = Number(take());
    else if (flag === "--threshold") args.threshold = Number(take());
    else if (flag === "--json") args.json = take();
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!args.model) throw new Error("--model is required (a pinned version, e.g. jev-1.13.0)");
  if (/latest$/i.test(args.model)) throw new Error(`"${args.model}" moves between releases; use a pinned model`);
  let baseUrl = args.baseUrl;
  if (!baseUrl) {
    if (!args.provider || !(args.provider in PRESETS)) throw new Error(`--provider must be one of ${Object.keys(PRESETS).join(", ")}, or give --base-url`);
    baseUrl = PRESETS[args.provider];
  }
  if (!baseUrl.startsWith("https://")) throw new Error("the base URL must start with https://");
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error("--concurrency must be a positive integer");
  if (!(args.threshold >= 0 && args.threshold <= 1)) throw new Error("--threshold must be between 0 and 1");
  return { baseUrl: baseUrl.replace(/\/+$/, ""), model: args.model, suite: args.suite, limit: args.limit, concurrency: args.concurrency, threshold: args.threshold, json: args.json };
}

export function toWire(model, state, questions) {
  const wire = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === "choice") wire[key] = { type: "choice", instructions: q.instructions, criteria: { ...q.options, ...(UNSURE in q.options ? {} : { [UNSURE]: UNSURE_DESCRIPTION }) } };
    else if (q.type === "score") wire[key] = { type: "score", instructions: q.instructions, criteria: q.levels };
    else wire[key] = { type: "noul", instructions: q.statement };
  }
  return { model, state, questions: wire };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function readAnswer(question, wire) {
  if (!wire || typeof wire !== "object") return null;
  if (question.type === "choice") {
    if (typeof wire.choice !== "string" || !(wire.choice in question.options || wire.choice === UNSURE)) return null;
    return { value: wire.choice, confidence: num(wire.confidence) ?? num(wire.probabilities?.[wire.choice]) ?? 0 };
  }
  if (question.type === "score") {
    const probabilities = wire.probabilities && typeof wire.probabilities === "object" ? wire.probabilities : {};
    let best = null;
    question.levels.forEach((_, index) => {
      const p = num(probabilities[String(index)]);
      if (p !== null && (best === null || p > num(probabilities[String(best)]))) best = index;
    });
    if (best === null) {
      const s = num(wire.score);
      if (s === null) return null;
      best = Math.min(question.levels.length - 1, Math.max(0, Math.round(s)));
    }
    return { value: question.levels[best], confidence: num(wire.confidence) ?? num(probabilities[String(best)]) ?? 0 };
  }
  const p = num(wire.noul);
  if (p === null || p < 0 || p > 1) return null;
  return { value: p >= 0.5, confidence: Math.max(p, 1 - p) };
}

export function percentile(values, p) {
  const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function summarise(outcomes, threshold) {
  const questions = {};
  for (const o of outcomes) {
    const key = `${o.suite}.${o.question}`;
    const q = (questions[key] ??= { n: 0, answered: 0, correct: 0, accuracy: 0, covered: 0, coverage: 0, coveredCorrect: 0, coveredAccuracy: 0 });
    q.n += 1;
    if (o.error || o.value === null) continue;
    q.answered += 1;
    const correct = o.value === o.expected;
    if (correct) q.correct += 1;
    if (o.confidence >= threshold && o.value !== UNSURE) {
      q.covered += 1;
      if (correct) q.coveredCorrect += 1;
    }
  }
  for (const q of Object.values(questions)) {
    q.accuracy = q.n ? q.correct / q.n : 0;
    q.coverage = q.n ? q.covered / q.n : 0;
    q.coveredAccuracy = q.covered ? q.coveredCorrect / q.covered : 0;
  }
  const latencies = [...new Set(outcomes.map((o) => o.request ?? o))].map((o) => o.latencyMs);
  return {
    threshold,
    questions,
    errors: outcomes.filter((o) => o.error).length,
    latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    inputTokens: outcomes.reduce((sum, o) => sum + (o.inputTokens ?? 0), 0),
  };
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;

export function formatReport(report) {
  const lines = [`threshold ${report.threshold}`, "", "question                  n   accuracy  coverage  covered-accuracy"];
  for (const [key, q] of Object.entries(report.questions)) lines.push(`${key.padEnd(24)} ${String(q.n).padStart(3)}   ${pct(q.accuracy).padStart(6)}    ${pct(q.coverage).padStart(6)}    ${pct(q.coveredAccuracy).padStart(6)}`);
  lines.push("", `errors ${report.errors}`, `latency p50 ${report.latency.p50 ?? "-"} ms, p95 ${report.latency.p95 ?? "-"} ms`);
  lines.push(`input tokens ${report.inputTokens} (about $${((report.inputTokens / 1e6) * PRICE_PER_MTOK).toFixed(4)} at $${PRICE_PER_MTOK}/M)`);
  return lines.join("\n");
}

export function validateFixtures(file) {
  if (file.version !== 1) throw new Error("fixtures version must be 1");
  const ids = new Set();
  const bySuite = {};
  for (const fixture of file.fixtures) {
    if (ids.has(fixture.id)) throw new Error(`duplicate fixture id ${fixture.id}`);
    ids.add(fixture.id);
    const suite = file.suites[fixture.suite];
    if (!suite) throw new Error(`${fixture.id}: unknown suite ${fixture.suite}`);
    for (const [key, question] of Object.entries(suite.questions)) {
      const expected = fixture.expected[key];
      const ok = question.type === "choice" ? typeof expected === "string" && expected in question.options
        : question.type === "score" ? question.levels.includes(expected)
        : typeof expected === "boolean";
      if (!ok) throw new Error(`${fixture.id}: expected.${key} is not a valid answer`);
    }
    if (JSON.stringify(fixture.state).length > 4000) throw new Error(`${fixture.id}: state too long`);
    bySuite[fixture.suite] = (bySuite[fixture.suite] ?? 0) + 1;
  }
  return { total: file.fixtures.length, bySuite };
}

async function runPool(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next; next += 1; await fn(items[index], index); }
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = process.env.KYOUBE_EVAL_API_KEY;
  if (!key) throw new Error("set KYOUBE_EVAL_API_KEY to the provider's API key");
  const file = JSON.parse(await readFile(new URL("./decisions-eval.fixtures.json", import.meta.url), "utf8"));
  validateFixtures(file);
  let fixtures = file.fixtures.filter((f) => !args.suite || f.suite === args.suite);
  if (args.limit) fixtures = fixtures.slice(0, args.limit);
  const outcomes = [];
  await runPool(fixtures, args.concurrency, async (fixture) => {
    const questions = file.suites[fixture.suite].questions;
    const started = Date.now();
    let body = null;
    let error = null;
    try {
      const response = await fetch(`${args.baseUrl}/v1/systemone`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(toWire(args.model, fixture.state, questions)) });
      if (!response.ok) error = `HTTP ${response.status}`;
      else body = await response.json();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const request = { latencyMs: error ? null : Date.now() - started };
    for (const [qkey, question] of Object.entries(questions)) {
      const answer = body ? readAnswer(question, body.answers?.[qkey]) : null;
      outcomes.push({ id: fixture.id, suite: fixture.suite, question: qkey, expected: fixture.expected[qkey], value: answer ? answer.value : null, confidence: answer ? answer.confidence : 0, error: error ?? (answer ? null : "unusable answer"), request, inputTokens: qkey === Object.keys(questions)[0] ? body?.usage?.input_tokens ?? 0 : 0 });
    }
    process.stderr.write(".");
  });
  process.stderr.write("\n");
  const report = summarise(outcomes, args.threshold);
  console.log(formatReport(report));
  if (args.json) await writeFile(args.json, JSON.stringify({ args: { ...args }, report, outcomes }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(String(error instanceof Error ? error.message : error)); process.exit(1); });
}
