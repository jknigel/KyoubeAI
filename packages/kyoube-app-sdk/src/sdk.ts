import { startHello } from "./handshake.js";
import { isKyoubeReady, isKyoubeResponse, KYOUBE_PROTOCOL, type KyoubeMethod } from "./protocol.js";

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

class KyoubeAppError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = "KyoubeAppError"; this.code = code; }
}

/**
 * The nonce arrives in a `<script>` the runner writes immediately above this one (the placement
 * contract is documented on `buildSrcdoc` in the plugin's `src/ui/apps/srcdoc.ts`), so it is in the
 * DOM as well as on `window`. Deleting the global is therefore only half the job: `document.body
 * .innerHTML`, a `querySelectorAll("script")` sweep, or `document.head.firstChild.nextSibling
 * .textContent` would all read it straight back out. This removes that element, and only that
 * element — it is checked to be the script the runner wrote before it goes, so an SDK that somehow
 * ended up somewhere else removes nothing.
 */
function scrubNonceScript(): void {
  if (typeof document === "undefined") return;
  const self = document.currentScript;
  const previous = self ? self.previousElementSibling : null;
  if (!previous || previous.tagName !== "SCRIPT") return;
  if ((previous.textContent ?? "").indexOf("window.__kyoubeNonce=") !== 0) return;
  previous.remove();
}

(function install() {
  // Ruling P4-R18: the runner writes the mount's handshake nonce into a global immediately
  // above this script, inside the head it prepends — so this line runs before any app-authored
  // byte has been parsed. Read it once, delete the global, and remove the element that carried
  // it: from here on the value exists only in this closure, and app code (which shares the realm,
  // and could otherwise read either the property or the script's own text) has no way to reach
  // it. Both happen before the frame check below, so neither copy survives whatever document this
  // ends up in; `window.x = …` creates a configurable property, so the delete really does go.
  const holder = globalThis as { __kyoubeNonce?: unknown };
  const nonce = typeof holder.__kyoubeNonce === "string" ? holder.__kyoubeNonce : "";
  delete holder.__kyoubeNonce;
  scrubNonceScript();
  if (typeof window === "undefined" || window.parent === window) return;
  // Ruling P4-R37: `window.parent` is `[Replaceable]` — app code may assign over it. Bind the
  // host's window here, at install, before any app-authored byte has been parsed, and use this
  // binding for every post and for the `event.source` check below. Reading the property at post
  // time instead would let `window.parent = interceptor`, assigned by the app afterwards, capture
  // everything the SDK sends (the nonce included) and forge what it receives.
  const parentWindow = window.parent;
  const pending = new Map<string, Pending>();
  let context: unknown = null;
  const readyListeners: Array<(context: unknown) => void> = [];
  let counter = 0;
  // Assigned once the handshake starts, below; the listener is registered first so a `ready` that
  // answers the very first hello is never missed.
  let helloAnswered = (): void => {};

  window.addEventListener("message", (event) => {
    if (event.source !== parentWindow) return;
    const message: unknown = event.data;
    if (isKyoubeReady(message)) {
      // The host may answer more than once (it answers every hello it accepts, and the retries
      // below mean there is usually more than one in flight): the later context simply replaces
      // the earlier, and the waiting listeners have already been drained.
      helloAnswered();
      context = message.context;
      for (const listener of readyListeners.splice(0)) listener(context);
      return;
    }
    if (!isKyoubeResponse(message)) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new KyoubeAppError(message.error.code, message.error.message));
    else entry.resolve(message.result);
  });

  function call(method: KyoubeMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = `k${++counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (pending.delete(id)) reject(new KyoubeAppError("timeout", `${method} timed out`)); }, 30_000);
      pending.set(id, { resolve, reject, timer });
      parentWindow.postMessage({ kyoube: KYOUBE_PROTOCOL, id, method, params, nonce }, "*");
    });
  }

  const kyoube = {
    version: KYOUBE_PROTOCOL,
    get context() { return context; },
    ready(): Promise<unknown> { return context ? Promise.resolve(context) : new Promise((resolve) => readyListeners.push(resolve)); },
    data: {
      query: (table: string, spec: Record<string, unknown> = {}) => call("data.query", { ...spec, table }),
      get: (table: string, id: string) => call("data.get", { table, id }),
      count: (table: string, where?: unknown) => call("data.count", { table, where }),
      describe: (table: string) => call("data.describe", { table }),
      insert: (table: string, rows: unknown[]) => call("data.insert", { table, rows }),
      update: (table: string, target: Record<string, unknown>, patch: Record<string, unknown>) => call("data.update", { table, ...target, patch }),
      delete: (table: string, target: Record<string, unknown>) => call("data.delete", { table, ...target }),
    },
    ui: {
      toast: (title: string, tone: "info" | "success" | "warn" | "error" = "info") => call("ui.toast", { title, tone }),
      openApp: (slug: string) => call("ui.openApp", { slug }),
    },
    Error: KyoubeAppError,
  };
  Object.defineProperty(window, "kyoube", { value: Object.freeze(kyoube), writable: false, configurable: false });
  // Ruling P4-R29: the host announces the context only in answer to this hello — never on a frame
  // load, which cannot say whose document arrived — so a hello posted before the runner's listener
  // is attached would otherwise leave the app waiting forever. It is repeated until answered, then
  // bounded so a frame nobody is listening to falls silent rather than posting for the life of the
  // page.
  helloAnswered = startHello(
    () => { parentWindow.postMessage({ kyoube: KYOUBE_PROTOCOL, id: "hello", method: "ui.toast", params: { __hello: true }, nonce }, "*"); },
    { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); } },
  );
})();
