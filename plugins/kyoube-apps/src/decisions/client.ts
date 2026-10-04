import { DataError } from "../data/errors.js";
import { withUnsure, type Question } from "./contract.js";

/**
 * The only file that knows the `/v1/systemone` wire format (TypeSafe's Jev, and the same format
 * served by OpenRouter, Vercel AI Gateway, Kev, Von and SGLang). Everything else speaks
 * contract.ts. `fetch` is injected: in the worker it is `ctx.http.fetch` (host-side, with the
 * core's SSRF checks); in tests it is a script.
 */
export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<FetchResponse>;

export interface ProviderTarget { provider: string; baseUrl: string; apiKey: string; model: string }
export interface RawAnswer { value: string | boolean; confidence: number; probabilities: Record<string, number> }
export interface ClientResult { model: string; answers: Record<string, RawAnswer>; latencyMs: number }
export interface ClientDeps { fetch: FetchLike; sleep?: (ms: number) => Promise<void>; now?: () => number }

/** Below the core's 30 s plugin RPC timeout, so the caller hears our error, not the host's. */
export const REQUEST_DEADLINE_MS = 20_000;
export const MAX_RETRIES = 2;

export function systemOneUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/systemone`;
}

export function toWireRequest(model: string, state: unknown, questions: Record<string, Question>): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(questions)) {
    const question = withUnsure(raw);
    if (question.type === "choice") wire[key] = { type: "choice", instructions: question.instructions, criteria: question.options };
    else if (question.type === "score") wire[key] = { type: "score", instructions: question.instructions, criteria: question.levels };
    else wire[key] = { type: "noul", instructions: question.statement };
  }
  return { model, state, questions: wire };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function numberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const n = finite(entry);
    if (n !== null) out[key] = n;
  }
  return out;
}

function unusable(key: string): DataError {
  return new DataError("provider_unavailable", `the provider returned an unusable answer for "${key}"`);
}

export function fromWireResponse(questions: Record<string, Question>, body: unknown, fallbackModel: string): Omit<ClientResult, "latencyMs"> {
  if (!body || typeof body !== "object") throw new DataError("provider_unavailable", "the provider returned an unreadable response");
  const record = body as { model?: unknown; answers?: unknown };
  const answers = (record.answers && typeof record.answers === "object" ? record.answers : {}) as Record<string, unknown>;
  const out: Record<string, RawAnswer> = {};
  for (const [key, raw] of Object.entries(questions)) {
    const question = withUnsure(raw);
    const wire = answers[key];
    if (!wire || typeof wire !== "object") throw unusable(key);
    const answer = wire as Record<string, unknown>;
    if (question.type === "choice") {
      const value = answer.choice;
      if (typeof value !== "string" || !Object.hasOwn(question.options, value)) throw unusable(key);
      const probabilities = numberMap(answer.probabilities);
      out[key] = { value, confidence: clamp01(finite(answer.confidence) ?? probabilities[value] ?? 0), probabilities };
    } else if (question.type === "score") {
      const byIndex = numberMap(answer.probabilities);
      const probabilities: Record<string, number> = {};
      let best: number | null = null;
      question.levels.forEach((label, index) => {
        const p = byIndex[String(index)];
        if (p === undefined) return;
        probabilities[label] = p;
        if (best === null || p > byIndex[String(best)]!) best = index;
      });
      let index: number | null = best;
      if (index === null) {
        const score = finite(answer.score);
        if (score === null) throw unusable(key);
        index = Math.min(question.levels.length - 1, Math.max(0, Math.round(score)));
      }
      out[key] = { value: question.levels[index]!, confidence: clamp01(finite(answer.confidence) ?? byIndex[String(index)] ?? 0), probabilities };
    } else {
      const p = finite(answer.noul);
      if (p === null || p < 0 || p > 1) throw unusable(key);
      out[key] = { value: p >= 0.5, confidence: Math.max(p, 1 - p), probabilities: { true: p, false: 1 - p } };
    }
  }
  return { model: typeof record.model === "string" && record.model.length > 0 ? record.model : fallbackModel, answers: out };
}

class Deadline extends Error {}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Deadline()), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function timeout(deadlineMs: number): DataError {
  return new DataError("timeout", `the provider did not answer within ${Math.max(1, Math.round(deadlineMs / 1000))} s`);
}

export async function callSystemOne(
  deps: ClientDeps,
  target: ProviderTarget,
  state: unknown,
  questions: Record<string, Question>,
  deadlineMs: number = REQUEST_DEADLINE_MS,
): Promise<ClientResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const deadline = started + deadlineMs;
  const init = {
    method: "POST" as const,
    headers: { authorization: `Bearer ${target.apiKey}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(toWireRequest(target.model, state, questions)),
  };
  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) throw timeout(deadlineMs);
    let failure: string;
    let wait: number | null = null;
    try {
      const response = await within(deps.fetch(systemOneUrl(target.baseUrl), init), remaining);
      if (response.status >= 200 && response.status < 300) {
        let parsed: unknown;
        try { parsed = JSON.parse(await response.text()); } catch { throw new DataError("provider_unavailable", "the provider returned an unreadable response"); }
        return { ...fromWireResponse(questions, parsed, target.model), latencyMs: now() - started };
      }
      if (response.status === 413) throw new DataError("too_large", "the provider says the request is too large, so send less state");
      if (response.status !== 429 && response.status !== 529 && response.status < 500) {
        throw new DataError("provider_rejected", `the provider rejected the request (HTTP ${response.status}); check the API key and model in the plugin settings`);
      }
      failure = `the provider answered HTTP ${response.status}`;
      wait = retryAfterMs(response.headers.get("retry-after"), now());
    } catch (error) {
      if (error instanceof DataError) throw error;
      if (error instanceof Deadline) throw timeout(deadlineMs);
      failure = "the provider could not be reached";
    }
    if (attempt >= MAX_RETRIES) throw new DataError("provider_unavailable", `${failure}; try again later`);
    const delay = wait ?? 500 * 2 ** attempt;
    if (now() + delay >= deadline) throw timeout(deadlineMs);
    await sleep(delay);
  }
}
