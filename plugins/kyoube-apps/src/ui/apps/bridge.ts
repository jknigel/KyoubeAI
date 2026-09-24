import { isKyoubeRequest, KYOUBE_PROTOCOL, type KyoubeRequest } from "@kyoube/app-sdk";
import { APPS_PAGE_ROUTE } from "../../apps/page-route.js";
import { bridgeErrorMessage } from "../format.js";

export type RoutedRequest =
  | { kind: "hello" }
  | { kind: "data"; method: string; params: Record<string, unknown> }
  | { kind: "toast"; title: string; tone: string }
  | { kind: "openApp"; slug: string }
  | { kind: "reject"; code: string; message: string };

/** Mirrors `APP_SLUG_RE` in `src/apps/manifest.ts` — the host side of the same rule. */
const SLUG_RE = /^[a-z][a-z0-9-]{1,48}$/;
const MAX_TOAST_TITLE = 200;

/**
 * The data methods an app may reach, mirroring `RuntimeMethod` in
 * `src/apps/service.ts`. `isKyoubeRequest` has already checked the method
 * against the SDK's `ALLOWED_METHODS` by the time a request gets here, but
 * this is the app → host trust boundary: the router names the method it will
 * hand an action rather than deriving one by slicing an unvalidated string, so
 * an unknown method is rejected here instead of travelling to the worker.
 */
const DATA_METHODS = new Set(["query", "get", "count", "describe", "insert", "update", "delete"]);

/** The `DataError` codes the worker throws, as `<code>: <text>` (see `src/data/errors.ts`). */
const KNOWN_CODES = ["invalid", "forbidden", "not_found", "conflict", "limit"] as const;

/**
 * Keys that mean something to the JavaScript object model rather than to the
 * data layer. `isKyoubeRequest` already fails closed on an own `__proto__` at
 * the top of `params` (ruling P3-R12), but `params` carries whole structures —
 * a `where` tree, a `patch`, a list of rows — that travel on into the query
 * compiler and the row coercer, so the same names are refused at every depth.
 */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
/** How deep the walk goes. Nothing an app legitimately sends is anywhere near this; anything deeper is refused unread. */
const MAX_PARAM_DEPTH = 32;

/** Structured clone reproduces `{}` and `[]` as such; a Date, Map or ArrayBuffer is a leaf, with no string keys to poison. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * The reason `params` may not be forwarded, or null when it may. Walks plain
 * objects and arrays only, to a bounded depth — and treats "too deep to check"
 * as a refusal, so burying a poisoned key is not a way past this.
 *
 * `getOwnPropertyNames` rather than `Object.keys`: a non-enumerable own key is
 * still an own key. The values are read by name only after the key itself has
 * been cleared, and a structured clone has no getters, so nothing here runs
 * app-supplied code.
 */
function unsafeParams(value: unknown, depth: number): string | null {
  if (depth > MAX_PARAM_DEPTH) return `params are nested more than ${MAX_PARAM_DEPTH} levels deep`;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const reason = unsafeParams(entry, depth + 1);
      if (reason) return reason;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  const keys = Object.getOwnPropertyNames(value);
  for (const key of keys) {
    if (PROTOTYPE_KEYS.has(key)) return `params must not carry a "${key}" key`;
  }
  for (const key of keys) {
    const reason = unsafeParams(value[key], depth + 1);
    if (reason) return reason;
  }
  return null;
}

/**
 * The SDK's install handshake reuses `ui.toast` (it is posted before the host
 * has replied with anything, so it cannot use a method of its own); it asks for
 * the ready event, not a toast.
 *
 * It is recognised here rather than only inside `routeAppRequest` because the
 * handshake is the one request that is *not* charged to the frame's budget:
 * the SDK repeats it until an answer arrives (ruling P4-R29), and those repeats
 * must not eat the app's first twenty calls or trip the runaway stop.
 */
export function isAppHello(request: KyoubeRequest): boolean {
  return request.method === "ui.toast" && request.params.__hello === true;
}

export function routeAppRequest(request: KyoubeRequest): RoutedRequest {
  // Before the method is even looked at: whatever this turns out to be, these
  // params are not going anywhere.
  const unsafe = unsafeParams(request.params, 0);
  if (unsafe) return { kind: "reject", code: "invalid", message: unsafe };
  if (request.method === "ui.toast") {
    if (isAppHello(request)) return { kind: "hello" };
    const title = request.params.title;
    if (typeof title !== "string" || title.length === 0) return { kind: "reject", code: "invalid", message: "toast needs a title" };
    const tone = typeof request.params.tone === "string" ? request.params.tone : "info";
    return { kind: "toast", title: title.slice(0, MAX_TOAST_TITLE), tone };
  }
  if (request.method === "ui.openApp") {
    const slug = request.params.slug;
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) return { kind: "reject", code: "invalid", message: "openApp needs a valid slug" };
    return { kind: "openApp", slug };
  }
  const method = request.method.startsWith("data.") ? request.method.slice("data.".length) : "";
  if (!DATA_METHODS.has(method)) return { kind: "reject", code: "invalid", message: `unknown method "${request.method}"` };
  return { kind: "data", method, params: request.params };
}

/**
 * Turns a rejected `apps.data` action into the `{ code, message }` the app
 * sees as a `kyoube.Error`. The rejection is the host's plain
 * `PluginBridgeError` object, whose own `code` is a transport code
 * (`WORKER_ERROR`, `TIMEOUT`, …) and never the worker's — so the message
 * (`bridgeErrorMessage`, which reads that object rather than stringifying it)
 * is searched for the leftmost known `DataError` code token, the same way
 * `errorCodeFrom` does in the terminal plugin. The worker's wording reaches
 * the app unedited; it is already trusted to see everything this viewer may see.
 */
export function appErrorPayload(error: unknown): { code: string; message: string } {
  const message = bridgeErrorMessage(error);
  let bestIndex = -1;
  let bestCode = "error";
  for (const code of KNOWN_CODES) {
    const match = new RegExp(`\\b${code}\\b`).exec(message);
    if (match && (bestIndex === -1 || match.index < bestIndex)) {
      bestIndex = match.index;
      bestCode = code;
    }
  }
  return { code: bestCode, message };
}

/**
 * `"/acme/app-artifact/sales-crm" → "sales-crm"`; the gallery (`null`) for
 * `/app-artifact` itself or any other path. The route segment is read by
 * position — host pathnames are always `/<companyPrefix>/<route>…` — rather
 * than by searching for the first matching segment, which would read the
 * company prefix on `/app-artifact/<slug>` and miss an app whose own slug is
 * the route name. The segment itself comes from `src/apps/page-route.ts`,
 * the same constant the manifest registers the page under.
 */
export function parseAppsPath(pathname: string): { slug: string | null } {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[1] !== APPS_PAGE_ROUTE) return { slug: null };
  const slug = segments[2];
  return { slug: slug && SLUG_RE.test(slug) ? slug : null };
}

// ---- the app → host message bridge -------------------------------------
// `AppRunner` owns the iframe and the listener; everything a message does is
// decided here, so the source gate, the protocol gate, the id echo, and the
// reply shapes are testable without a DOM (and without the built SDK bundle).

/** The subset of `MessageEvent` the bridge reads. */
export interface AppMessageEvent { source: unknown; data: unknown }
/** The subset of `Window` the bridge posts to. */
export interface AppMessageTarget { postMessage(message: unknown, targetOrigin: string): void }

/** Why a runner stopped. Each has its own notice (`stopNotice`); all three are terminal for the mount. */
export type StopReason = "navigated" | "nonce" | "budget";

/** How many nonce mismatches this mount tolerates before it is killed (ruling P4-R18). */
const MAX_NONCE_MISMATCHES = 3;

/**
 * What one frame may spend (ruling P4-R20). The window slides: each call is
 * remembered by its own timestamp and forgotten `windowMs` later, so a busy app
 * is throttled to a rate rather than being cut off until some tick.
 *
 * `requests` covers every *request* the frame sends except the handshake —
 * ruling P4-R29: one the host goes on to refuse as invalid (a toast with no
 * title, an unusable slug) costs it the same listener, the same routing and the
 * same reply as a good one, so it is charged like one, and a loop of them trips
 * the runaway stop exactly as a loop of valid calls does. What is *not* charged
 * is a message `handleAppMessage` never acts on: `isKyoubeRequest` drops
 * anything malformed or naming a method outside the SDK's surface, and the
 * guard drops anything without this mount's nonce (three of those stop the
 * runner on their own). Nothing is spent on them because nothing is done about
 * them — and a page cannot stop another window posting to it in any case.
 * `toasts` is an additional, smaller ceiling on the one call that puts
 * something on the viewer's screen.
 *
 * The numbers are deliberately far above what a hand-written UI does and far
 * below what a loop does: 60 requests in 10 s is six a second — more than any
 * render pass, list refresh or form submit needs — and five toasts in 10 s is
 * already more notification than a person can read. `limitedWindows` is the
 * patience: an app that keeps hitting the ceiling for three windows running is
 * not busy, it is looping, and is stopped rather than served forever.
 */
export const APP_BUDGET = { windowMs: 10_000, requests: 60, toasts: 5, limitedWindows: 3 } as const;

/**
 * The per-mount state the bridge keeps for one running app: the handshake
 * nonce it must see on every request, the call budgets, and the strike counts
 * that kill the runner. `handleAppMessage` is otherwise a pure function of its
 * arguments — this is the one thing it has to remember between messages, so
 * the runner makes one guard per mount (keyed on the source, like the nonce
 * and the load counter) and hands it in.
 */
export interface AppGuard {
  /** True when `nonce` is this mount's. A mismatch is counted, and the third one stops the runner. */
  accepts(nonce: unknown): boolean;
  /** True when this call fits the frame's budget. A refusal is counted; three limited windows running stop the runner. */
  spend(kind: "request" | "toast"): boolean;
  /** The reason this runner stopped, or null while it is still running. */
  stopped(): StopReason | null;
  /** Records a stop the runner decided on itself (a second frame load). Idempotent. */
  stop(reason: StopReason): void;
}

export function createAppGuard(nonce: string, opts: { onStop: (reason: StopReason) => void; now?: () => number }): AppGuard {
  const now = opts.now ?? Date.now;
  let mismatches = 0;
  let reason: StopReason | null = null;
  // The calls still inside the window, oldest first; never longer than the
  // budget itself, because a call over the ceiling is refused rather than kept.
  const spent: Record<"request" | "toast", number[]> = { request: [], toast: [] };
  // The start of the window the last refusal fell in, and how many windows in a
  // row have had one.
  let limitedAt: number | null = null;
  let limitedRun = 0;

  const stop = (next: StopReason): void => {
    // Once only: the runner tears down on the first stop, and a second call
    // (from a message that raced it) must not re-run that teardown.
    if (reason !== null) return;
    reason = next;
    opts.onStop(next);
  };

  /**
   * One refusal. Refusals inside one window count once — an app that overshoots
   * by one call and one that overshoots by a thousand have both simply hit the
   * ceiling — and the run continues only while each limited window is followed
   * by the next (hence `2 * windowMs`: a refusal further out than that has a
   * clear window between it and the last, so the app was not being limited
   * throughout).
   */
  const refused = (at: number): void => {
    if (limitedAt !== null && at - limitedAt < APP_BUDGET.windowMs) return;
    limitedRun = limitedAt !== null && at - limitedAt < 2 * APP_BUDGET.windowMs ? limitedRun + 1 : 1;
    limitedAt = at;
    if (limitedRun >= APP_BUDGET.limitedWindows) stop("budget");
  };

  return {
    accepts(candidate: unknown): boolean {
      // A plain comparison, deliberately: the nonce is not a secret compared
      // against attacker-chosen input over a timing-observable channel — it is
      // a value only code the SDK installed in can know, and three wrong
      // guesses end the frame long before timing could tell anyone anything.
      if (typeof candidate === "string" && candidate === nonce) return true;
      mismatches += 1;
      if (mismatches >= MAX_NONCE_MISMATCHES) stop("nonce");
      return false;
    },
    spend(kind: "request" | "toast"): boolean {
      const at = now();
      const times = spent[kind];
      const max = kind === "request" ? APP_BUDGET.requests : APP_BUDGET.toasts;
      while (times.length > 0 && at - times[0]! >= APP_BUDGET.windowMs) times.shift();
      if (times.length >= max) {
        refused(at);
        return false;
      }
      times.push(at);
      return true;
    },
    stopped: () => reason,
    stop,
  };
}

/** What the runner shows in place of the frame once it has stopped. */
export function stopNotice(reason: StopReason): string {
  switch (reason) {
    case "navigated": return "This app navigated away and was stopped. Reload the page to start it again.";
    case "nonce": return "This app sent messages that did not come from its own runtime and was stopped. Reload the page to start it again.";
    case "budget": return "This app made too many requests and was stopped. Reload the page to start it again.";
  }
}

export interface AppBridgeCallbacks {
  /** The context handed to the app on the ready event; read late so it is never stale. */
  context: () => unknown;
  onData: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  onToast: (title: string, tone: string) => void;
  onOpenApp: (slug: string) => void;
  /** False once the runner has torn down, or once the app navigated its frame — nothing runs after that. */
  isLive: () => boolean;
  /** This mount's nonce and strike count (ruling P4-R18). */
  guard: AppGuard;
}

/**
 * Target origin `"*"` is the only value that can work: the sandboxed frame has
 * an opaque origin, which never matches a concrete target origin and cannot be
 * named. It is safe to widen because `target` is the app's own window — not an
 * arbitrary recipient — and carries only what that app asked for.
 */
const FRAME_ORIGIN = "*";

/**
 * Announces the app's context. Idempotent on the SDK side, so it may be sent
 * more than once — the SDK repeats its hello until one arrives (ruling P4-R29),
 * so more than one answer is the normal case rather than an edge one.
 *
 * The only caller is `handleAppMessage`'s hello branch, and that is the ruling:
 * the context (companyId, the viewer's id and level, the app's declared tables)
 * goes to the frame only in answer to a request carrying this mount's nonce.
 * Nothing announces it on a timer, on a load, or on a render — none of those
 * can tell whose document is in the frame.
 */
function postAppReady(target: AppMessageTarget, context: unknown): void {
  target.postMessage({ kyoube: KYOUBE_PROTOCOL, event: "ready", context }, FRAME_ORIGIN);
}

/**
 * Which mount an app context belongs to: `"<slug>@<version>"`. `AppRunner` keys
 * the frame on it (ruling P4-R29), so a newly published version — or a
 * different app — is a new mount with its own nonce, load counter and budget,
 * while a re-render carrying the same published version keeps the mount it has.
 *
 * The context is `unknown` here on purpose: it is whatever `apps.runtime`
 * returned, read through the host bridge, and this module never assumes a shape
 * it has not checked. A context missing an app identity yields one stable key,
 * which is the same behaviour as any single mount.
 */
export function appMountKey(context: unknown): string {
  const app = (context as { app?: { slug?: unknown; version?: unknown } } | null | undefined)?.app;
  return `${String(app?.slug)}@${String(app?.version)}`;
}

/**
 * Handles one `message` event from a running app. Four gates before anything
 * is trusted: the message must come from *this* app's frame (any other frame,
 * the opener, or a same-page script posting to `window` is dropped), it must be
 * a well-formed request for a method the SDK allows — `isKyoubeRequest` also
 * fails closed on an own `__proto__` key (ruling P3-R12) — the runner must
 * still be live, and the request must carry *this mount's* nonce.
 *
 * The liveness gate is checked before any callback runs, not only before a
 * reply (ruling P3-R18): a nested browsing context keeps the same WindowProxy
 * across navigations, so `event.source === target` still holds for a document
 * the app navigated *itself* to. The runner marks itself dead on that second
 * load, and from then on no message may reach `onData` (which would run under
 * the viewer's identity), `onToast`, `onOpenApp`, or the context announcement.
 *
 * The nonce gate (ruling P4-R18) closes the same hole from the other side, for
 * the window between the navigation and the runner's `load` handler: only code
 * the SDK was installed alongside can name this mount's nonce, so an arriving
 * document has nothing the bridge will act on. A mismatch is answered with
 * silence rather than an error — a sender that is not this app's runtime is
 * told nothing about why — and the third one kills the runner.
 *
 * The context announcement lives here and nowhere else (ruling P4-R29): the
 * `hello` branch is the *only* thing that posts it, so it is only ever sent to
 * a sender that proved it knows this mount's nonce.
 */
export async function handleAppMessage(event: AppMessageEvent, target: AppMessageTarget | null, callbacks: AppBridgeCallbacks): Promise<void> {
  if (!target || event.source !== target) return;
  const data = event.data;
  if (!isKyoubeRequest(data)) return;
  if (!callbacks.isLive()) return;
  if (!callbacks.guard.accepts(data.nonce)) return;
  const request: KyoubeRequest = data;
  const reply = (body: Record<string, unknown>) => {
    if (!callbacks.isLive()) return;
    target.postMessage({ kyoube: KYOUBE_PROTOCOL, id: request.id, ...body }, FRAME_ORIGIN);
  };
  // Ruling P4-R29: charged before the request is routed, so what it *turns out*
  // to be cannot change what it costs. A request refused as invalid, an
  // `openApp`, and a valid query all take one slot; only the handshake is free,
  // because the SDK repeats it until it is answered. Over budget, the app is
  // told so in its own error vocabulary — `limit` is a code the SDK already
  // surfaces and an app already handles, so a throttled call is one it can back
  // off from.
  //
  // A message that is not a *request* never gets this far: `isKyoubeRequest`
  // above drops anything malformed, or naming a method outside the SDK's
  // surface, without a callback and without a reply. Nothing is charged for it
  // because nothing is done about it — the budget bounds the work the host
  // performs, and a page cannot stop another window posting to it in any case.
  if (!isAppHello(request) && !callbacks.guard.spend("request")) {
    reply({ error: { code: "limit", message: "limit: too many requests" } });
    return;
  }
  const routed = routeAppRequest(request);
  switch (routed.kind) {
    case "hello":
      if (callbacks.isLive()) postAppReady(target, callbacks.context());
      return;
    case "toast":
      // An over-budget toast is dropped, not refused: the app is still answered
      // (a reply it never gets would hang its promise until the SDK's own 30 s
      // timeout), it simply does not reach the viewer's screen.
      if (callbacks.guard.spend("toast")) callbacks.onToast(routed.title, routed.tone);
      reply({ result: null });
      return;
    case "openApp":
      callbacks.onOpenApp(routed.slug);
      reply({ result: null });
      return;
    case "reject":
      reply({ error: { code: routed.code, message: routed.message } });
      return;
    case "data":
      try {
        // `reply` no-ops if the runner unmounted while this was in flight, so a
        // late resolution cannot post into a discarded frame.
        reply({ result: await callbacks.onData(routed.method, routed.params) });
      } catch (error) {
        reply({ error: appErrorPayload(error) });
      }
      return;
  }
}
