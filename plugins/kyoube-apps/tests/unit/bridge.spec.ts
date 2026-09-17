import type { KyoubeRequest } from "@kyoube/app-sdk";
import { describe, expect, it } from "vitest";
import { APPS_PAGE_ROUTE, appsPagePath } from "../../src/apps/page-route.js";
import { APP_BUDGET, appErrorPayload, appMountKey, createAppGuard, handleAppMessage, parseAppsPath, routeAppRequest, stopNotice, type AppBridgeCallbacks, type StopReason } from "../../src/ui/apps/bridge.js";
import { newAppNonce } from "../../src/ui/apps/srcdoc.js";

/** The nonce the runner inlined into this mount's srcdoc; every request the SDK sends carries it. */
const NONCE = "TESTnonce_0123456789-x";

/** Builds a request the way the SDK does, bypassing the `KyoubeMethod` union for the rejection cases. */
function request(method: string, params: Record<string, unknown>, id = "1"): KyoubeRequest {
  return { kyoube: 1, id, method, params, nonce: NONCE } as unknown as KyoubeRequest;
}

/** A stand-in for the iframe's contentWindow that records what the bridge posts back. */
function fakeFrame(overrides: Partial<AppBridgeCallbacks> = {}, guardOpts: { now?: () => number } = {}) {
  const posted: unknown[] = [];
  const target = { postMessage: (message: unknown) => { posted.push(message); } };
  const toasts: Array<[string, string]> = [];
  const opened: string[] = [];
  const dataCalls: Array<[string, Record<string, unknown>]> = [];
  const stops: StopReason[] = [];
  // Mirrors AppRunner: the guard's stop clears liveness, so a killed runner
  // runs no callback and posts nothing from then on.
  let live = true;
  const guard = createAppGuard(NONCE, { onStop: (reason) => { live = false; stops.push(reason); }, ...guardOpts });
  const callbacks: AppBridgeCallbacks = {
    context: () => ({ app: "crm" }),
    onData: async (method, params) => { dataCalls.push([method, params]); return { rows: [] }; },
    onToast: (title, tone) => { toasts.push([title, tone]); },
    onOpenApp: (slug) => { opened.push(slug); },
    isLive: () => live,
    guard,
    ...overrides,
  };
  const send = (data: unknown, source: unknown = target) => handleAppMessage({ source, data }, target, callbacks);
  return { target, posted, toasts, opened, dataCalls, stops, guard, send };
}

describe("routeAppRequest", () => {
  it("routes hello, data, toast, and openApp requests", () => {
    expect(routeAppRequest({ kyoube: 1, id: "hello", method: "ui.toast", params: { __hello: true }, nonce: NONCE })).toEqual({ kind: "hello" });
    expect(routeAppRequest({ kyoube: 1, id: "1", method: "data.query", params: { table: "contacts", limit: 5 }, nonce: NONCE })).toEqual({ kind: "data", method: "query", params: { table: "contacts", limit: 5 } });
    expect(routeAppRequest({ kyoube: 1, id: "2", method: "ui.toast", params: { title: "Saved", tone: "success" }, nonce: NONCE })).toEqual({ kind: "toast", title: "Saved", tone: "success" });
    expect(routeAppRequest({ kyoube: 1, id: "3", method: "ui.toast", params: { title: 5 }, nonce: NONCE })).toEqual({ kind: "reject", code: "invalid", message: "toast needs a title" });
    expect(routeAppRequest({ kyoube: 1, id: "4", method: "ui.openApp", params: { slug: "crm" }, nonce: NONCE })).toEqual({ kind: "openApp", slug: "crm" });
    expect(routeAppRequest({ kyoube: 1, id: "5", method: "ui.openApp", params: { slug: "Bad!" }, nonce: NONCE })).toMatchObject({ kind: "reject" });
  });
  it("defaults the toast tone and caps the title", () => {
    expect(routeAppRequest({ kyoube: 1, id: "6", method: "ui.toast", params: { title: "Hi" }, nonce: NONCE })).toEqual({ kind: "toast", title: "Hi", tone: "info" });
    expect(routeAppRequest({ kyoube: 1, id: "7", method: "ui.toast", params: { title: "x".repeat(500), tone: 9 }, nonce: NONCE })).toEqual({ kind: "toast", title: "x".repeat(200), tone: "info" });
    expect(routeAppRequest({ kyoube: 1, id: "8", method: "ui.toast", params: { title: "" }, nonce: NONCE })).toMatchObject({ kind: "reject", code: "invalid" });
  });
  it("rejects methods outside the app data surface", () => {
    expect(routeAppRequest(request("data.drop_table", {}))).toEqual({ kind: "reject", code: "invalid", message: 'unknown method "data.drop_table"' });
    expect(routeAppRequest(request("ui.confirm", {}))).toMatchObject({ kind: "reject", code: "invalid" });
    expect(routeAppRequest(request("query", {}))).toMatchObject({ kind: "reject", code: "invalid" });
  });

  // Ruling P4-R21 (the apps side of P3-R12): `isKyoubeRequest` fails closed on
  // an own `__proto__` at the *top* of `params`, but a filter, a patch, or a
  // row is an arbitrarily nested structure that reaches the worker's compilers
  // and Object.assign-shaped code. postMessage's structured clone makes own
  // data properties for these names exactly as JSON.parse does, so they are
  // rejected wherever they sit.
  it("rejects an own __proto__, constructor or prototype key at any depth", () => {
    const nested = (path: string[], key: string): Record<string, unknown> => {
      const leaf = JSON.parse(`{"${key}": {"polluted": true}}`) as unknown;
      return path.reduceRight<Record<string, unknown>>((inner, step) => ({ [step]: inner }), leaf as Record<string, unknown>);
    };
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(routeAppRequest(request("data.update", nested(["patch"], key))), key).toMatchObject({ kind: "reject", code: "invalid" });
      expect(routeAppRequest(request("data.query", nested(["where", "and"], key))), key).toMatchObject({ kind: "reject", code: "invalid" });
      // Inside an array, too: `rows` and `{ or: [...] }` are both arrays of objects.
      expect(routeAppRequest(request("data.insert", { table: "contacts", rows: [{ name: "Ada" }, JSON.parse(`{"${key}": {}}`)] })), key).toMatchObject({ kind: "reject", code: "invalid" });
      expect(routeAppRequest(request("ui.toast", { title: "Hi", meta: JSON.parse(`{"${key}": {}}`) })), key).toMatchObject({ kind: "reject", code: "invalid" });
    }
  });

  it("refuses params nested deeper than the walk goes, rather than stopping early", () => {
    let deep: unknown = JSON.parse('{"__proto__": {"polluted": true}}');
    for (let i = 0; i < 40; i += 1) deep = { inner: deep };
    // Too deep to prove safe is refused, not accepted: the poisoned key below
    // level 32 must never reach the worker just because it was buried.
    expect(routeAppRequest(request("data.update", { table: "contacts", patch: deep }))).toMatchObject({ kind: "reject", code: "invalid" });
    let shallow: unknown = { leaf: true };
    for (let i = 0; i < 40; i += 1) shallow = { inner: shallow };
    expect(routeAppRequest(request("data.update", { table: "contacts", patch: shallow }))).toMatchObject({ kind: "reject", code: "invalid" });
  });

  it("leaves ordinary params — and those names as values — alone", () => {
    expect(routeAppRequest(request("data.query", { table: "contacts", where: { and: [{ field: "name", op: "eq", value: "__proto__" }, { or: [{ field: "role", op: "eq", value: "constructor" }] }] } })))
      .toMatchObject({ kind: "data", method: "query" });
    // The names are only ever keys: a row that stores the *string* "prototype"
    // in a field, or a field literally called "protoype", is ordinary data.
    expect(routeAppRequest(request("data.insert", { table: "contacts", rows: [{ name: "prototype", note: null, tags: ["__proto__"] }] })))
      .toMatchObject({ kind: "data", method: "insert" });
    // `{ __proto__: ... }` written as a literal sets the prototype instead of
    // creating an own key, so there is nothing there to reject.
    expect(routeAppRequest(request("data.update", { table: "contacts", patch: { __proto__: { polluted: true } } }))).toMatchObject({ kind: "data", method: "update" });
  });
});

describe("handleAppMessage", () => {
  it("ignores anything that is not a well-formed request from this frame", async () => {
    const frame = fakeFrame();
    await frame.send(request("data.query", { table: "contacts" }), { other: "window" });
    await frame.send({ kyoube: 1, id: "1", method: "data.evil", params: {}, nonce: NONCE });
    await frame.send({ kyoube: "1", id: "1", method: "data.query", params: {} });
    await frame.send({ kyoube: 1, id: "1", method: "data.query", params: JSON.parse('{"__proto__": {}}'), nonce: NONCE });
    await frame.send("hello");
    await handleAppMessage({ source: null, data: request("data.query", {}) }, null, { context: () => null, onData: async () => null, onToast: () => {}, onOpenApp: () => {}, isLive: () => true, guard: createAppGuard(NONCE, { onStop: () => {} }) });
    expect(frame.posted).toEqual([]);
  });
  // Ruling P4-R29: this is the *only* thing that sends the viewer's context to
  // the frame. Nothing announces it on a load, because a load cannot say whose
  // document arrived — an app that assigns `location` while its own srcdoc is
  // still parsing leaves that document without ever firing one, so the first
  // load a runner sees can be the attacker's.
  it("answers the SDK handshake with the ready event", async () => {
    const frame = fakeFrame();
    await frame.send({ kyoube: 1, id: "hello", method: "ui.toast", params: { __hello: true }, nonce: NONCE });
    expect(frame.posted).toEqual([{ kyoube: 1, event: "ready", context: { app: "crm" } }]);
  });

  it("answers every hello, so the SDK's retries are idempotent", async () => {
    const frame = fakeFrame();
    const ready = { kyoube: 1, event: "ready", context: { app: "crm" } };
    for (const id of ["hello", "hello", "hello"]) await frame.send({ kyoube: 1, id, method: "ui.toast", params: { __hello: true }, nonce: NONCE });
    expect(frame.posted).toEqual([ready, ready, ready]);
    // The handshake shows no toast and spends no budget, however often it is repeated.
    expect(frame.toasts).toEqual([]);
    expect(frame.stops).toEqual([]);
  });

  it("says nothing at all to a hello that does not carry this mount's nonce", async () => {
    const frame = fakeFrame();
    await frame.send({ kyoube: 1, id: "hello", method: "ui.toast", params: { __hello: true }, nonce: "not-the-nonce-xx" });
    await frame.send({ kyoube: 1, id: "hello", method: "ui.toast", params: { __hello: true } });
    expect(frame.posted).toEqual([]);
  });
  it("echoes the request id on every reply and routes ui calls", async () => {
    const frame = fakeFrame();
    await frame.send({ kyoube: 1, id: "t1", method: "ui.toast", params: { title: "Saved", tone: "success" }, nonce: NONCE });
    await frame.send({ kyoube: 1, id: "o1", method: "ui.openApp", params: { slug: "crm" }, nonce: NONCE });
    await frame.send({ kyoube: 1, id: "r1", method: "ui.openApp", params: { slug: "Bad!" }, nonce: NONCE });
    expect(frame.toasts).toEqual([["Saved", "success"]]);
    expect(frame.opened).toEqual(["crm"]);
    expect(frame.posted).toEqual([
      { kyoube: 1, id: "t1", result: null },
      { kyoube: 1, id: "o1", result: null },
      { kyoube: 1, id: "r1", error: { code: "invalid", message: "openApp needs a valid slug" } },
    ]);
  });
  it("forwards a data result and shapes a worker rejection as { code, message }", async () => {
    const frame = fakeFrame({ onData: async (method, params) => ({ method, params }) });
    await frame.send({ kyoube: 1, id: "d1", method: "data.query", params: { table: "contacts" }, nonce: NONCE });
    expect(frame.posted).toEqual([{ kyoube: 1, id: "d1", result: { method: "query", params: { table: "contacts" } } }]);

    // The real rejection: `usePluginAction` throws the host's plain
    // PluginBridgeError object, never an Error (ruling P3-R17).
    const failing = fakeFrame({ onData: async () => { throw { code: "WORKER_ERROR", message: 'forbidden: app "crm" does not declare table "notes"' }; } });
    await failing.send({ kyoube: 1, id: "d2", method: "data.insert", params: { table: "notes" }, nonce: NONCE });
    expect(failing.posted).toEqual([{ kyoube: 1, id: "d2", error: { code: "forbidden", message: 'forbidden: app "crm" does not declare table "notes"' } }]);
  });
  it("posts nothing once the runner is no longer live", async () => {
    let live = true;
    const frame = fakeFrame({ isLive: () => live, onData: async () => { live = false; return { rows: [] }; } });
    await frame.send({ kyoube: 1, id: "d3", method: "data.query", params: { table: "contacts" }, nonce: NONCE });
    expect(frame.posted).toEqual([]);
  });
  // Ruling P3-R18: a frame that navigated itself is the same WindowProxy, so
  // the source gate still passes for the attacker's document — the runner
  // marks itself dead instead, and a dead runner runs no callback at all (not
  // just no reply): no data call carries the viewer's identity, no toast, no
  // navigation, and no re-announced context.
  it("runs no callback at all once the runner is dead", async () => {
    const frame = fakeFrame({ isLive: () => false });
    await frame.send({ kyoube: 1, id: "d4", method: "data.query", params: { table: "contacts" }, nonce: NONCE });
    await frame.send({ kyoube: 1, id: "t4", method: "ui.toast", params: { title: "Saved" }, nonce: NONCE });
    await frame.send({ kyoube: 1, id: "o4", method: "ui.openApp", params: { slug: "crm" }, nonce: NONCE });
    await frame.send({ kyoube: 1, id: "r4", method: "ui.openApp", params: { slug: "Bad!" }, nonce: NONCE });
    await frame.send({ kyoube: 1, id: "hello", method: "ui.toast", params: { __hello: true }, nonce: NONCE });
    expect(frame.dataCalls).toEqual([]);
    expect(frame.toasts).toEqual([]);
    expect(frame.opened).toEqual([]);
    expect(frame.posted).toEqual([]);
  });
});

// Ruling P4-R18: the runner mints a nonce per mount and inlines it ahead of the
// SDK, so only code the SDK is installed in can name it. A Kyoube-shaped message
// without this mount's nonce did not come from the app document the runner
// rendered — the likeliest source being a document the frame navigated *itself*
// to, which keeps the same WindowProxy and so passes the source gate.
describe("handleAppMessage nonce", () => {
  it("runs nothing for a request whose nonce is not this mount's", async () => {
    const frame = fakeFrame();
    await frame.send({ kyoube: 1, id: "n1", method: "data.query", params: { table: "contacts" }, nonce: "some-other-nonce-x" });
    await frame.send({ kyoube: 1, id: "n2", method: "ui.toast", params: { title: "Saved" }, nonce: "" });
    await frame.send({ kyoube: 1, id: "n3", method: "ui.openApp", params: { slug: "crm" }, nonce: `${NONCE}x` });
    expect(frame.dataCalls).toEqual([]);
    expect(frame.toasts).toEqual([]);
    expect(frame.opened).toEqual([]);
    // Silence, not an error reply: a message from something that is not this
    // app's runtime is told nothing at all about why it was ignored.
    expect(frame.posted).toEqual([]);
  });

  it("kills the runner on the third mismatch, and keeps serving the real app until then", async () => {
    const frame = fakeFrame();
    const wrong = (id: string) => frame.send({ kyoube: 1, id, method: "data.query", params: { table: "contacts" }, nonce: "wrong-nonce-here-x" });
    await wrong("n1");
    await wrong("n2");
    expect(frame.stops).toEqual([]);
    // Two strikes in, the app's own requests still work.
    await frame.send({ kyoube: 1, id: "ok", method: "data.query", params: { table: "contacts" }, nonce: NONCE });
    expect(frame.dataCalls).toEqual([["query", { table: "contacts" }]]);
    await wrong("n3");
    expect(frame.stops).toEqual(["nonce"]);
    expect(frame.guard.stopped()).toBe("nonce");
    // Dead: even a correctly nonced request runs nothing now.
    await frame.send({ kyoube: 1, id: "late", method: "data.query", params: { table: "contacts" }, nonce: NONCE });
    expect(frame.dataCalls).toHaveLength(1);
  });

  it("stops once, whatever arrives afterwards", async () => {
    const frame = fakeFrame();
    for (let i = 0; i < 8; i += 1) await frame.send({ kyoube: 1, id: `n${i}`, method: "ui.toast", params: { title: "x" }, nonce: "not-the-nonce-xx" });
    expect(frame.stops).toEqual(["nonce"]);
  });

  // Ruling P4-R19 as narrowed by P4-R29: the runner is keyed on the app's
  // identity and version, so a different published document is a different
  // mount. What that has to buy is checked here on the pieces a unit test can
  // reach: two mounts share no nonce and no strike count, so one app's frame
  // cannot spend another's tolerance or be killed by it. (The remount itself is
  // React's `key`, exercised by the manual check documented on `AppRunner`.)
  it("gives each mount its own nonce and its own strike count", async () => {
    const first = fakeFrame();
    const second = fakeFrame();
    for (const id of ["a", "b"]) await first.send({ kyoube: 1, id, method: "ui.toast", params: { title: "x" }, nonce: "not-the-nonce-xx" });
    expect(first.stops).toEqual([]);
    // The second mount starts clean: two strikes on the first buy nothing here.
    await second.send({ kyoube: 1, id: "c", method: "ui.toast", params: { title: "x" }, nonce: "not-the-nonce-xx" });
    expect(second.stops).toEqual([]);
    expect(newAppNonce()).not.toBe(newAppNonce());
  });

  it("names a notice for every way a runner can stop", () => {
    for (const reason of ["navigated", "nonce", "budget"] as const) {
      expect(stopNotice(reason)).toMatch(/stopped\./);
      expect(stopNotice(reason)).toMatch(/Reload the page/);
    }
    expect(new Set((["navigated", "nonce", "budget"] as const).map(stopNotice)).size).toBe(3);
  });
});

// Ruling P4-R20: an app is agent-written code running on a viewer's session,
// and every data call it makes costs the worker a round trip under that
// viewer's identity. A runaway loop must cost the host a bounded amount and
// then be stopped, rather than being answered forever.
describe("call budgets", () => {
  const dataRequest = (id: string) => ({ kyoube: 1, id, method: "data.query", params: { table: "contacts" }, nonce: NONCE });
  const toastRequest = (id: string) => ({ kyoube: 1, id, method: "ui.toast", params: { title: "Hi" }, nonce: NONCE });

  it("answers 60 data calls in a 10 s window and refuses the rest with limit", async () => {
    let clock = 1_000;
    const frame = fakeFrame({}, { now: () => clock });
    for (let i = 0; i < APP_BUDGET.requests; i += 1) await frame.send(dataRequest(`d${i}`));
    expect(frame.dataCalls).toHaveLength(60);

    await frame.send(dataRequest("over"));
    expect(frame.dataCalls).toHaveLength(60);
    expect(frame.posted.at(-1)).toEqual({ kyoube: 1, id: "over", error: { code: "limit", message: "limit: too many requests" } });

    // The window slides rather than resetting on a tick: the first 60 calls
    // age out exactly 10 s after they were made, and the app is served again.
    clock += APP_BUDGET.windowMs;
    await frame.send(dataRequest("after"));
    expect(frame.dataCalls).toHaveLength(61);
  });

  it("shows 5 toasts in a window and drops the rest, still answering the app", async () => {
    let clock = 0;
    const frame = fakeFrame({}, { now: () => clock });
    for (let i = 0; i < 7; i += 1) await frame.send(toastRequest(`t${i}`));
    expect(frame.toasts).toHaveLength(5);
    // A dropped toast is still replied to: without a reply the app's promise
    // would hang until the SDK's own 30 s timeout, which is worse than a toast
    // nobody saw. The two over-budget calls are the last two replies.
    expect(frame.posted).toHaveLength(7);
    expect(frame.posted.every((message) => (message as { result?: unknown }).result === null)).toBe(true);
  });

  // Ruling P4-R29: one request ceiling over everything the frame sends, plus a
  // second, smaller one on the calls that reach the viewer's screen.
  it("counts every kind of request against the one ceiling, and toasts against a second", async () => {
    const clock = 0;
    const frame = fakeFrame({}, { now: () => clock });
    for (let i = 0; i < 7; i += 1) await frame.send(toastRequest(`t${i}`));
    expect(frame.toasts).toHaveLength(5);
    // Seven toasts are seven requests: 53 of the 60 are left.
    for (let i = 0; i < APP_BUDGET.requests - 7; i += 1) await frame.send(dataRequest(`d${i}`));
    expect(frame.dataCalls).toHaveLength(53);
    await frame.send(dataRequest("over"));
    expect(frame.dataCalls).toHaveLength(53);
    expect(frame.posted.at(-1)).toMatchObject({ error: { code: "limit" } });
  });

  it("charges a request that is rejected before it reaches anything", async () => {
    const clock = 0;
    const frame = fakeFrame({}, { now: () => clock });
    // Unknown methods and malformed params cost the host the same listener and
    // the same event loop as a good call, so they cost the app the same slot —
    // otherwise a runaway loop of nonsense would never trip the stop.
    const junk = (id: string) => frame.send({ kyoube: 1, id, method: "data.query", params: JSON.parse('{"patch":{"__proto__":{}}}'), nonce: NONCE });
    for (let i = 0; i < APP_BUDGET.requests; i += 1) await junk(`j${i}`);
    expect(frame.posted).toHaveLength(60);
    expect(frame.posted.at(-1)).toMatchObject({ error: { code: "invalid" } });
    // The 61st is refused for being over budget, not for being malformed.
    await junk("over");
    expect(frame.posted.at(-1)).toEqual({ kyoube: 1, id: "over", error: { code: "limit", message: "limit: too many requests" } });
    // ...and so is a well-formed call that arrives behind the spam.
    await frame.send(dataRequest("good"));
    expect(frame.dataCalls).toEqual([]);
  });

  it("charges a rejected openApp and a good one alike, and never the handshake", async () => {
    const clock = 0;
    const frame = fakeFrame({}, { now: () => clock });
    await frame.send({ kyoube: 1, id: "r1", method: "ui.openApp", params: { slug: "Bad!" }, nonce: NONCE });
    await frame.send({ kyoube: 1, id: "o1", method: "ui.openApp", params: { slug: "crm" }, nonce: NONCE });
    // 58 of the 60 are left after those two — the refused one cost the same as the served one.
    for (let i = 0; i < APP_BUDGET.requests - 2; i += 1) await frame.send(dataRequest(`d${i}`));
    expect(frame.dataCalls).toHaveLength(58);
    await frame.send(dataRequest("over"));
    expect(frame.posted.at(-1)).toMatchObject({ error: { code: "limit" } });
    // The handshake is free at any point, including once the frame is over
    // budget: the SDK repeats it until it is answered (ruling P4-R29).
    await frame.send({ kyoube: 1, id: "hello", method: "ui.toast", params: { __hello: true }, nonce: NONCE });
    expect(frame.posted.at(-1)).toEqual({ kyoube: 1, event: "ready", context: { app: "crm" } });
  });

  it("stops a frame that spams requests it knows will be rejected", async () => {
    let clock = 0;
    const frame = fakeFrame({}, { now: () => clock });
    const spam = async (label: string) => {
      for (let i = 0; i < APP_BUDGET.requests + 2; i += 1) {
        await frame.send({ kyoube: 1, id: `${label}-${i}`, method: "ui.toast", params: { title: 7 }, nonce: NONCE });
      }
    };
    await spam("w1");
    expect(frame.stops).toEqual([]);
    clock += APP_BUDGET.windowMs;
    await spam("w2");
    expect(frame.stops).toEqual([]);
    clock += APP_BUDGET.windowMs;
    await spam("w3");
    expect(frame.stops).toEqual(["budget"]);
  });

  // A message that is not a request at all never reaches the budget: the
  // protocol gate drops it before the liveness and nonce gates, without a
  // callback and without a reply. That is the cheapest possible response —
  // cheaper than accounting for it — and it is the same response the page would
  // give any other window's postMessage. What the budget bounds is what the
  // *host does*, which is nothing at all here.
  it("does not charge a message the protocol gate drops", async () => {
    const clock = 0;
    const frame = fakeFrame({}, { now: () => clock });
    for (let i = 0; i < 200; i += 1) await frame.send({ kyoube: 1, id: `x${i}`, method: "ui.confirm", params: {}, nonce: NONCE });
    for (let i = 0; i < 200; i += 1) await frame.send("not even an object");
    expect(frame.posted).toEqual([]);
    expect(frame.stops).toEqual([]);
    // The frame's whole budget is still there for its real work.
    for (let i = 0; i < APP_BUDGET.requests; i += 1) await frame.send(dataRequest(`d${i}`));
    expect(frame.dataCalls).toHaveLength(60);
  });

  it("stops the runner after three consecutive limited windows", async () => {
    let clock = 0;
    const frame = fakeFrame({}, { now: () => clock });
    const overspend = async (label: string) => { for (let i = 0; i < 7; i += 1) await frame.send(toastRequest(`${label}-${i}`)); };
    await overspend("w1");
    expect(frame.stops).toEqual([]);
    clock += APP_BUDGET.windowMs;
    await overspend("w2");
    expect(frame.stops).toEqual([]);
    clock += APP_BUDGET.windowMs;
    await overspend("w3");
    expect(frame.stops).toEqual(["budget"]);
    expect(frame.guard.stopped()).toBe("budget");

    // Dead: the app is answered no further, whatever it sends.
    const before = frame.posted.length;
    await frame.send(dataRequest("late"));
    expect(frame.dataCalls).toEqual([]);
    expect(frame.posted).toHaveLength(before);
  });

  it("forgets the run once a window goes by without a refusal", async () => {
    let clock = 0;
    const frame = fakeFrame({}, { now: () => clock });
    const overspend = async (label: string) => { for (let i = 0; i < 7; i += 1) await frame.send(toastRequest(`${label}-${i}`)); };
    await overspend("w1");
    clock += APP_BUDGET.windowMs;
    await overspend("w2");
    // Quiet for long enough that the two limited windows are no longer a run:
    // a busy app that briefly overshoots twice is not a runaway one.
    clock += 3 * APP_BUDGET.windowMs;
    await overspend("w4");
    await overspend("w4b");
    expect(frame.stops).toEqual([]);
    expect(frame.guard.stopped()).toBeNull();
  });
});

// Ruling P4-R29: the runner keys the frame on this, so it decides when a mount
// is replaced (fresh nonce, load counter and budget) and when it is kept.
describe("appMountKey", () => {
  it("changes with the app and with the published version, and with nothing else", () => {
    const context = (slug: string, version: number) => ({ companyId: "c1", viewer: { id: "u1", name: "", level: "read" }, app: { slug, name: "CRM", version }, tables: ["contacts"] });
    expect(appMountKey(context("crm", 3))).toBe("crm@3");
    expect(appMountKey(context("crm", 3))).toBe(appMountKey(context("crm", 3)));
    expect(appMountKey(context("crm", 4))).not.toBe(appMountKey(context("crm", 3)));
    expect(appMountKey(context("orders", 3))).not.toBe(appMountKey(context("crm", 3)));
    // The viewer changing is not a new document — the same published version is
    // still running, and re-keying on it would restart the app under someone's feet.
    const other = { ...context("crm", 3), viewer: { id: "u2", name: "", level: "schema" } };
    expect(appMountKey(other)).toBe(appMountKey(context("crm", 3)));
  });
  it("is a stable string for a context that names no app", () => {
    for (const value of [null, undefined, {}, { app: null }, "nonsense", 7]) {
      expect(typeof appMountKey(value), String(value)).toBe("string");
    }
    expect(appMountKey(null)).toBe(appMountKey(undefined));
  });
});

describe("parseAppsPath", () => {
  it("extracts the app slug after /app-artifact", () => {
    expect(parseAppsPath("/acme/app-artifact")).toEqual({ slug: null });
    expect(parseAppsPath("/acme/app-artifact/")).toEqual({ slug: null });
    expect(parseAppsPath("/acme/app-artifact/sales-crm")).toEqual({ slug: "sales-crm" });
    expect(parseAppsPath("/acme/app-artifact/sales-crm/extra")).toEqual({ slug: "sales-crm" });
    expect(parseAppsPath("/acme/data")).toEqual({ slug: null });
  });
  it("ignores a segment that is not a valid slug", () => {
    expect(parseAppsPath("/acme/app-artifact/Sales%20CRM")).toEqual({ slug: null });
    expect(parseAppsPath("/acme/app-artifact/..")).toEqual({ slug: null });
  });
  it("reads the route segment by position, not by searching for \"app-artifact\"", () => {
    expect(parseAppsPath("/acme/app-artifact/app-artifact")).toEqual({ slug: "app-artifact" });
    expect(parseAppsPath("/app-artifact/data/app-artifact/crm")).toEqual({ slug: null });
    expect(parseAppsPath("/app-artifact/app-artifact/crm")).toEqual({ slug: "crm" });
  });
  it("never claims upstream's own /<company>/apps route (the Connectors catalogue)", () => {
    expect(parseAppsPath("/acme/apps")).toEqual({ slug: null });
    expect(parseAppsPath("/acme/apps/sales-crm")).toEqual({ slug: null });
  });
  it("registers the page under the same segment the parser reads", () => {
    expect(APPS_PAGE_ROUTE).toBe("app-artifact");
    expect(appsPagePath()).toBe("/app-artifact");
    expect(appsPagePath("sales-crm")).toBe("/app-artifact/sales-crm");
  });
});

describe("appErrorPayload", () => {
  it("reports the leftmost known code in the worker's own message", () => {
    expect(appErrorPayload(new Error('forbidden: app "crm" does not declare table "notes"'))).toEqual({ code: "forbidden", message: 'forbidden: app "crm" does not declare table "notes"' });
    expect(appErrorPayload(new Error("limit: the query exceeded its time limit"))).toMatchObject({ code: "limit" });
  });
  // Ruling P3-R17: the host rejects with a plain `{ code, message, details }`
  // object (`extractBridgeError` in upstream's ui/src/plugins/bridge.ts), whose
  // `code` is a transport code — the worker's DataError code is in the message,
  // which the server passes through unchanged into the 502 body.
  it("reads the host's plain rejection object, not its [object Object] string", () => {
    expect(appErrorPayload({ code: "WORKER_ERROR", message: "forbidden: viewers cannot write" })).toEqual({ code: "forbidden", message: "forbidden: viewers cannot write" });
    expect(appErrorPayload({ code: "WORKER_ERROR", message: 'not_found: app "crm" is not published', details: undefined })).toEqual({ code: "not_found", message: 'not_found: app "crm" is not published' });
    expect(appErrorPayload({ code: "TIMEOUT", message: "the worker did not answer in time" })).toEqual({ code: "error", message: "the worker did not answer in time" });
  });
  it("falls back to a generic code and message for anything else", () => {
    expect(appErrorPayload(new Error("boom"))).toEqual({ code: "error", message: "boom" });
    expect(appErrorPayload("not an error")).toEqual({ code: "error", message: "not an error" });
    expect(appErrorPayload(undefined)).toEqual({ code: "error", message: "error" });
    expect(appErrorPayload({ code: "UNKNOWN" })).toEqual({ code: "error", message: "error" });
  });
});
