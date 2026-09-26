/**
 * A minimal Chrome DevTools Protocol driver for the live browser checks that
 * need a signed-in page (scripts/studio-live-check.mjs), and for
 * scripts/app-frame-check.mjs, whose ResizeObserver shape needs rendered
 * frames. The other checks only need `--dump-dom`
 * (scripts/lib/headless-chrome.mjs); these need to set a session cookie, run
 * script in the page, wait for the React app to settle, take screenshots or
 * see observers fire, which `--dump-dom` cannot do.
 *
 * No dependencies: Node's global WebSocket (22+) speaks to the browser, and
 * the browser is the one `findChrome()` already locates.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts headless Chrome with a throwaway profile and resolves its browser-level WebSocket URL. */
export async function launchChrome(chrome, { windowSize = "1440,900" } = {}) {
  const profile = await mkdtemp(path.join(tmpdir(), "kyoube-cdp-"));
  const proc = spawn(chrome, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${windowSize}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--hide-scrollbars",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`Chrome did not report a DevTools endpoint: ${buffer.slice(0, 400)}`)), 20_000);
    proc.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Chrome exited ${code} before it was ready: ${buffer.slice(0, 400)}`)); });
  });
  const close = async () => {
    proc.kill("SIGKILL");
    await sleep(200);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  return { wsUrl, close };
}

/** One WebSocket to the browser; page commands go through flattened target sessions. */
export class Cdp {
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error(`could not connect to ${wsUrl}`)), { once: true });
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString());
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  /** Resolves with the first event named `method` (for `sessionId`, when given) within `timeoutMs`. */
  waitFor(method, sessionId, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(listener); reject(new Error(`timed out waiting for ${method}`)); }, timeoutMs);
      const listener = (message) => {
        if (message.method !== method) return;
        if (sessionId && message.sessionId !== sessionId) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(message.params);
      };
      this.listeners.add(listener);
    });
  }

  close() { this.ws.close(); }
}

/** A page (tab) with the handful of operations the checks use. */
export class Page {
  static async open(cdp, { width = 1440, height = 900 } = {}) {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(cdp, sessionId);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Network.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    page.consoleErrors = [];
    cdp.listeners.add((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === "Runtime.exceptionThrown") page.consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? "exception");
    });
    return page;
  }

  constructor(cdp, sessionId) { this.cdp = cdp; this.sessionId = sessionId; }

  send(method, params) { return this.cdp.send(method, params, this.sessionId); }

  async setCookie(cookie) { await this.send("Network.setCookie", cookie); }

  async emulateColorScheme(scheme) {
    await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  }

  async goto(url, { settleMs = 1500, timeoutMs = 45_000 } = {}) {
    const loaded = this.cdp.waitFor("Page.loadEventFired", this.sessionId, timeoutMs);
    await this.send("Page.navigate", { url });
    await loaded;
    await sleep(settleMs);
  }

  /** Evaluates `expression` in the page and returns its JSON value. */
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`page script failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value;
  }

  /** Polls `expression` until it is truthy; resolves its value, or throws after `timeoutMs`. */
  async waitForFunction(expression, { timeoutMs = 20_000, intervalMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(expression).catch((error) => { last = error; return null; });
      if (last) return last;
      await sleep(intervalMs);
    }
    throw new Error(`timed out waiting for: ${expression.slice(0, 160)}`);
  }

  /** PNG screenshot of the viewport, or of the whole scrollable page with `fullPage`. */
  async screenshot({ fullPage = false } = {}) {
    const params = { format: "png" };
    if (fullPage) {
      const metrics = await this.send("Page.getLayoutMetrics");
      const size = metrics.cssContentSize ?? metrics.contentSize;
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
    }
    const { data } = await this.send("Page.captureScreenshot", params);
    return Buffer.from(data, "base64");
  }
}

/** Signs in through the core's Better Auth route and returns the session cookie the browser needs. */
export async function signIn(baseUrl, email, password) {
  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  const setCookie = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  for (const header of setCookie) {
    const match = /^([^=;]+\.session_token)=([^;]+)/.exec(header);
    if (match) return { name: match[1], value: match[2] };
  }
  throw new Error("sign-in succeeded but set no session cookie");
}
