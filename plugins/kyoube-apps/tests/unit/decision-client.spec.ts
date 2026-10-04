import { describe, expect, it } from "vitest";
import { callSystemOne, fromWireResponse, systemOneUrl, toWireRequest, type FetchLike, type FetchResponse } from "../../src/decisions/client.js";
import type { Question } from "../../src/decisions/contract.js";
import { DataError } from "../../src/data/errors.js";

const questions: Record<string, Question> = {
  queue: { type: "choice", instructions: "Which team?", options: { billing: null, technical: "Bugs" } },
  urgency: { type: "score", instructions: "How soon?", levels: ["week", "today", "hour"] },
  refund: { type: "check", statement: "Asks for a refund." },
};
const target = { provider: "typesafe", baseUrl: "https://api.typesafe.ai", apiKey: "sk-secret-123", model: "jev-1.13.0" };
const ok = { model: "jev-1.13.0", answers: {
  queue: { type: "choice", choice: "technical", confidence: 0.78, probabilities: { technical: 0.85, billing: 0.1, unsure: 0.05 } },
  urgency: { type: "score", score: 1.0, confidence: 0.9, probabilities: { "0": 0.05, "1": 0.9, "2": 0.05 } },
  refund: { type: "noul", noul: 0.2 },
}, usage: { input_tokens: 300, output_tokens: 0 } };

function response(status: number, body: unknown, headers: Record<string, string> = {}): FetchResponse {
  return { status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

function scripted(...steps: Array<FetchResponse | Error | "hang">) {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const step = steps.shift() ?? response(500, {});
    if (step === "hang") return new Promise<FetchResponse>(() => {});
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetch, calls };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; return "resolved"; } catch (error) { return error instanceof DataError ? error.code : String(error); }
}

describe("wire translation", () => {
  it("builds the systemone URL from a base URL with or without a trailing slash", () => {
    expect(systemOneUrl("https://api.typesafe.ai")).toBe("https://api.typesafe.ai/v1/systemone");
    expect(systemOneUrl("https://openrouter.ai/api/")).toBe("https://openrouter.ai/api/v1/systemone");
  });
  it("maps Kyoube questions to the wire format and adds unsure", () => {
    expect(toWireRequest("jev-1.13.0", { body: "hi" }, questions)).toEqual({
      model: "jev-1.13.0",
      state: { body: "hi" },
      questions: {
        queue: { type: "choice", instructions: "Which team?", criteria: { billing: null, technical: "Bugs", unsure: "None of the options clearly fits" } },
        urgency: { type: "score", instructions: "How soon?", criteria: ["week", "today", "hour"] },
        refund: { type: "noul", instructions: "Asks for a refund." },
      },
    });
  });
  it("reads choice, score and noul answers", () => {
    const result = fromWireResponse(questions, ok, "fallback");
    expect(result.model).toBe("jev-1.13.0");
    expect(result.answers.queue).toEqual({ value: "technical", confidence: 0.78, probabilities: { technical: 0.85, billing: 0.1, unsure: 0.05 } });
    expect(result.answers.urgency).toEqual({ value: "today", confidence: 0.9, probabilities: { week: 0.05, today: 0.9, hour: 0.05 } });
    expect(result.answers.refund).toEqual({ value: false, confidence: 0.8, probabilities: { true: 0.2, false: 0.8 } });
  });
  it("falls back to the winning probability when confidence is missing, and to the rounded score without probabilities", () => {
    const sparse = { answers: {
      queue: { choice: "billing", probabilities: { billing: 0.7, technical: 0.3 } },
      urgency: { score: 1.6 },
      refund: { noul: 0.5 },
    } };
    const result = fromWireResponse(questions, sparse, "jev-1.13.0");
    expect(result.model).toBe("jev-1.13.0");
    expect(result.answers.queue!.confidence).toBe(0.7);
    expect(result.answers.urgency!.value).toBe("hour");
    expect(result.answers.urgency!.confidence).toBe(0);
    expect(result.answers.refund!.value).toBe(true);
  });
  it("treats a missing question or an option it was never given as an unusable answer", () => {
    expect(() => fromWireResponse(questions, { answers: { queue: ok.answers.queue, urgency: ok.answers.urgency } }, "m")).toThrow(/refund/);
    expect(() => fromWireResponse(questions, { answers: { ...ok.answers, queue: { choice: "sales" } } }, "m")).toThrow(DataError);
    expect(() => fromWireResponse(questions, { answers: { ...ok.answers, refund: { noul: 1.5 } } }, "m")).toThrow(DataError);
  });
});

describe("callSystemOne", () => {
  const instant = { sleep: async () => {} };

  it("posts to the provider with the bearer key and returns the answers", async () => {
    const { fetch, calls } = scripted(response(200, ok));
    const result = await callSystemOne({ fetch, ...instant }, target, "hello", questions);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]!.init.headers.authorization).toBe("Bearer sk-secret-123");
    expect(JSON.parse(calls[0]!.init.body).model).toBe("jev-1.13.0");
    expect(result.answers.queue!.value).toBe("technical");
  });

  it("retries 429 after Retry-After and 529 with backoff", async () => {
    const waits: number[] = [];
    const { fetch, calls } = scripted(response(429, {}, { "retry-after": "1" }), response(529, {}), response(200, ok));
    await callSystemOne({ fetch, sleep: async (ms) => void waits.push(ms) }, target, "hello", questions);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 1000]);
  });

  it("gives up after two retries", async () => {
    const { fetch, calls } = scripted(response(503, {}), response(503, {}), response(503, {}));
    expect(await codeOf(callSystemOne({ fetch, ...instant }, target, "hello", questions))).toBe("provider_unavailable");
    expect(calls).toHaveLength(3);
  });

  it("retries a network error", async () => {
    const { fetch, calls } = scripted(new Error("ECONNRESET"), response(200, ok));
    await callSystemOne({ fetch, ...instant }, target, "hello", questions);
    expect(calls).toHaveLength(2);
  });

  it("does not retry a rejected key or an oversized request", async () => {
    const rejected = scripted(response(401, { error: "bad key" }));
    expect(await codeOf(callSystemOne({ fetch: rejected.fetch, ...instant }, target, "hello", questions))).toBe("provider_rejected");
    expect(rejected.calls).toHaveLength(1);
    const big = scripted(response(413, {}));
    expect(await codeOf(callSystemOne({ fetch: big.fetch, ...instant }, target, "hello", questions))).toBe("too_large");
  });

  it("times out a provider that never answers", async () => {
    const { fetch } = scripted("hang");
    expect(await codeOf(callSystemOne({ fetch, ...instant }, target, "hello", questions, 30))).toBe("timeout");
  });

  it("never puts the key into an error message", async () => {
    const testCases: Array<{ step: FetchResponse; code: string }> = [
      { step: response(401, {}), code: "provider_rejected" },
      { step: response(503, {}), code: "provider_unavailable" },
      { step: response(200, "not json"), code: "provider_unavailable" },
    ];
    for (const { step, code } of testCases) {
      const { fetch } = scripted(step, step, step);
      const error = await callSystemOne({ fetch, ...instant }, target, "hello", questions).catch((e) => e);
      expect(error).toBeInstanceOf(DataError);
      expect((error as DataError).code).toBe(code);
      expect(String((error as Error).message)).not.toContain("sk-secret-123");
    }
  });

  it("times out reading the response body", async () => {
    const hangingBody: FetchResponse = { status: 200, headers: { get: () => null }, text: async () => new Promise<string>(() => {}) };
    const { fetch } = scripted(hangingBody);
    expect(await codeOf(callSystemOne({ fetch, ...instant }, target, "hello", questions, 30))).toBe("timeout");
  });
});
