import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../kyoube-push-sw.js"), "utf8");

/** Runs kyoube-push-sw.js against a fake service worker global. */
function load({ windows = [] } = {}) {
  const listeners = {};
  const shown = [];
  const opened = [];
  const self = {
    location: { origin: "https://kyoube.example.com" },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url) => { opened.push(url); },
    },
  };
  new Function("self", SOURCE)(self);
  const fire = async (type, event) => {
    const waits = [];
    listeners[type]({ ...event, waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
  };
  return { listeners, shown, opened, fire };
}

describe("kyoube-push-sw.js", () => {
  it("shows the notification the worker sent", async () => {
    const sw = load();
    await sw.fire("push", { data: { json: () => ({ title: "Ada is asking: Ship it?", body: "ACM-1 · Launch post", url: "/ACM/issues/ACM-1", tag: "issue:1" }) } });
    expect(sw.shown).toEqual([{ title: "Ada is asking: Ship it?", options: expect.objectContaining({ body: "ACM-1 · Launch post", tag: "issue:1", renotify: true, data: { url: "/ACM/issues/ACM-1" }, icon: "/android-chrome-192x192.png" }) }]);
    expect(sw.shown[0].options).not.toHaveProperty("badge");
  });

  it("still shows something for an empty or unreadable push (iOS revokes permission for silent pushes)", async () => {
    const sw = load();
    await sw.fire("push", { data: null });
    await sw.fire("push", { data: { json: () => { throw new Error("bad"); } } });
    expect(sw.shown.map((item) => item.title)).toEqual(["KyoubeAI", "KyoubeAI"]);
  });

  it("only ever links to a path on this site", async () => {
    const sw = load();
    for (const url of ["https://evil.example.com/x", "//evil.example.com/x", "javascript:alert(1)", 42, "/\\evil.example.com/x", "/\t/evil.example.com", "/\n/evil.example.com"]) {
      await sw.fire("push", { data: { json: () => ({ title: "t", url }) } });
    }
    expect(sw.shown.map((item) => item.options.data.url)).toEqual(["/", "/", "/", "/", "/", "/", "/"]);
  });

  it("focuses an open KyoubeAI window and takes it to the page", async () => {
    const calls = [];
    const win = { url: "https://kyoube.example.com/ACM/dashboard", focus: async () => { calls.push("focus"); }, navigate: async (url) => { calls.push(url); } };
    const sw = load({ windows: [win] });
    const notification = { data: { url: "/ACM/issues/ACM-1" }, close: () => calls.push("close") };
    await sw.fire("notificationclick", { notification });
    expect(calls).toEqual(["close", "focus", "https://kyoube.example.com/ACM/issues/ACM-1"]);
    expect(sw.opened).toEqual([]);
  });

  it("opens a new window when none is open", async () => {
    const sw = load();
    await sw.fire("notificationclick", { notification: { data: { url: "/ACM/approvals/a1" }, close: () => {} } });
    expect(sw.opened).toEqual(["https://kyoube.example.com/ACM/approvals/a1"]);
  });

  it("never opens an off-site page from a notification's stored url", async () => {
    const sw = load();
    await sw.fire("notificationclick", { notification: { data: { url: "/\\evil.example.com/x" }, close: () => {} } });
    expect(sw.opened).toEqual(["https://kyoube.example.com/"]);
  });

  it("opens a window when an open client cannot be navigated", async () => {
    const win = { url: "https://kyoube.example.com/", focus: async () => {}, navigate: async () => { throw new Error("uncontrolled"); } };
    const sw = load({ windows: [win] });
    await sw.fire("notificationclick", { notification: { data: { url: "/ACM/issues/ACM-1" }, close: () => {} } });
    expect(sw.opened).toEqual(["https://kyoube.example.com/ACM/issues/ACM-1"]);
  });
});
