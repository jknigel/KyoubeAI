import type { KyoubeRequest } from "@kyoube/app-sdk";
import { describe, expect, it } from "vitest";
import { APP_BUDGET, createAppGuard, handleAppMessage, routeAppRequest, type AppBridgeCallbacks } from "../../src/ui/apps/bridge.js";

const NONCE = "TESTnonce_0123456789-x";

function request(method: string, params: Record<string, unknown>, id = "1"): KyoubeRequest {
  return { kyoube: 1, id, method, params, nonce: NONCE } as unknown as KyoubeRequest;
}
const call = (name: unknown, req: unknown, id = "1") => request("connections.call", { name, request: req }, id);

function frame(overrides: Partial<AppBridgeCallbacks> = {}) {
  const posted: Array<Record<string, unknown>> = [];
  const target = { postMessage: (message: unknown) => { posted.push(message as Record<string, unknown>); } };
  const calls: Array<[string, Record<string, unknown>]> = [];
  const toasts: string[] = [];
  const guard = createAppGuard(NONCE, { onStop: () => {}, now: () => 1_000 });
  const callbacks: AppBridgeCallbacks = {
    context: () => ({}),
    onData: async () => ({ rows: [] }),
    onToast: (title) => { toasts.push(title); },
    onOpenApp: () => {},
    onConnection: async (name, req) => { calls.push([name, req]); return { status: 200, headers: {}, body: "ok" }; },
    isLive: () => true,
    guard,
    ...overrides,
  };
  const send = (data: unknown) => handleAppMessage({ source: target, data }, target, callbacks);
  return { posted, calls, toasts, send };
}

describe("routing connection calls", () => {
  it("routes a call, defaulting a missing request to {}", () => {
    expect(routeAppRequest(call("crm", { path: "/x" }))).toEqual({ kind: "connection", name: "crm", request: { path: "/x" } });
    expect(routeAppRequest(request("connections.call", { name: "crm" }))).toEqual({ kind: "connection", name: "crm", request: {} });
  });
  it("rejects a bad name and a non-object request", () => {
    expect(routeAppRequest(call("CRM!", {}))).toMatchObject({ kind: "reject", code: "invalid" });
    expect(routeAppRequest(call(7, {}))).toMatchObject({ kind: "reject", code: "invalid" });
    expect(routeAppRequest(call("crm", "GET /"))).toMatchObject({ kind: "reject", code: "invalid" });
    expect(routeAppRequest(call("crm", [1]))).toMatchObject({ kind: "reject", code: "invalid" });
  });
});

describe("handleAppMessage and connections", () => {
  it("forwards a call and replies with its result", async () => {
    const { send, posted, calls } = frame();
    await send(call("crm", { path: "/x" }, "7"));
    expect(calls).toEqual([["crm", { path: "/x" }]]);
    expect(posted.at(-1)).toMatchObject({ id: "7", result: { status: 200, body: "ok" } });
  });
  it("allows 30 per window, the 31st gets limit, data calls unaffected", async () => {
    expect(APP_BUDGET.connections).toBe(30);
    const { send, posted, calls } = frame();
    for (let i = 0; i < 31; i += 1) await send(call("crm", {}, `c${i}`));
    expect(calls).toHaveLength(30);
    expect(posted.at(-1)).toMatchObject({ id: "c30", error: { code: "limit" } });
    await send(request("data.query", { table: "t" }, "q1"));
    expect(posted.at(-1)).toMatchObject({ id: "q1", result: { rows: [] } });
  });
  it("counts a connection call toward the 60 requests", async () => {
    const { send, posted } = frame();
    for (let i = 0; i < 30; i += 1) await send(request("data.query", { table: "t" }, `d${i}`));
    for (let i = 0; i < 30; i += 1) await send(call("crm", {}, `c${i}`));
    await send(call("crm", {}, "over"));
    expect(posted.at(-1)).toMatchObject({ id: "over", error: { code: "limit", message: "limit: too many requests" } });
  });
  it("replies { code, message } for a failure", async () => {
    const { send, posted } = frame({ onConnection: async () => { throw { code: "WORKER_ERROR", message: "timeout: the service took too long" }; } });
    await send(call("crm", {}, "e"));
    expect(posted.at(-1)).toEqual({ kyoube: 1, id: "e", error: { code: "timeout", message: "timeout: the service took too long" } });
  });
  it("toasts once per connection name when disabled", async () => {
    const { send, toasts, posted } = frame({ onConnection: async () => { throw { code: "WORKER_ERROR", message: "disabled: connections are off" }; } });
    await send(call("crm", {}, "1"));
    await send(call("crm", {}, "2"));
    await send(call("mail", {}, "3"));
    expect(toasts).toHaveLength(2);
    expect(toasts[0]).toContain("crm");
    expect(posted.at(-1)).toMatchObject({ id: "3", error: { code: "disabled" } });
  });
  it("answers disabled without a callback", async () => {
    const { send, posted } = frame({ onConnection: undefined });
    await send(call("crm", {}, "x"));
    expect(posted.at(-1)).toMatchObject({ id: "x", error: { code: "disabled" } });
  });
});
