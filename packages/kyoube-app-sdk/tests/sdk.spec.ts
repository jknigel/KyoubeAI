import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Ruling P4-R37 (extending P4-R29). `window.parent` is `[Replaceable]`: app code that assigns
 * `window.parent = interceptor` after the SDK installed would, if the SDK read the property at
 * post time, capture every message it sends — the handshake nonce included. The SDK therefore
 * binds the parent once, at install, before any app-authored byte has been parsed.
 *
 * These tests install the SDK the way the runner does: the nonce on the global, a window whose
 * `parent` is not itself, and no document at all (the node environment), so `scrubNonceScript`
 * takes its early return exactly as it would in a frame with no `currentScript`.
 */

interface Posted { message: Record<string, unknown>; targetOrigin: string }

type Listener = (event: { source: unknown; data: unknown }) => void;

function installEnv(nonce: string) {
  const posts: Posted[] = [];
  const parent = { postMessage: (message: unknown, targetOrigin: string) => void posts.push({ message: message as Record<string, unknown>, targetOrigin }) };
  const listeners: Listener[] = [];
  const win = {
    parent: parent as unknown,
    addEventListener: (type: string, listener: Listener) => { if (type === "message") listeners.push(listener); },
  };
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).__kyoubeNonce = nonce;
  return {
    posts,
    parent,
    /** What `window.kyoube` ended up being, after the SDK's `defineProperty`. */
    sdk: () => (win as unknown as { kyoube: { ready(): Promise<unknown>; data: { query(table: string, spec?: Record<string, unknown>): Promise<unknown> } } }).kyoube,
    /** Replaces `window.parent` the way hostile app code would, after install. */
    hijack: () => {
      const stolen: unknown[] = [];
      win.parent = { postMessage: (message: unknown) => void stolen.push(message) };
      return stolen;
    },
    deliver: (event: { source: unknown; data: unknown }) => { for (const listener of listeners) listener(event); },
  };
}

async function install(nonce: string) {
  const env = installEnv(nonce);
  vi.resetModules();
  await import("../src/sdk.js");
  return env;
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).__kyoubeNonce;
});

describe("SDK install", () => {
  it("posts to the parent captured at install, even after app code replaces window.parent", async () => {
    vi.useFakeTimers();
    const env = await install("nonce-abcdefghijklmnop");
    // The handshake is posted synchronously at install, before any app code could run.
    expect(env.posts).toHaveLength(1);
    expect(env.posts[0]!.message).toMatchObject({ id: "hello", nonce: "nonce-abcdefghijklmnop" });
    // The nonce is gone from the global the runner wrote it to.
    expect((globalThis as Record<string, unknown>).__kyoubeNonce).toBeUndefined();

    const stolen = env.hijack();
    const call = env.sdk().data.query("contacts", { limit: 1 });
    // The interceptor sees nothing; the real parent got the request, nonce and all.
    expect(stolen).toEqual([]);
    expect(env.posts).toHaveLength(2);
    const request = env.posts[1]!.message;
    expect(request).toMatchObject({ method: "data.query", nonce: "nonce-abcdefghijklmnop", params: { table: "contacts", limit: 1 } });

    env.deliver({ source: env.parent, data: { kyoube: 1, id: request.id, result: [{ id: 1 }] } });
    await expect(call).resolves.toEqual([{ id: 1 }]);
    expect(stolen).toEqual([]);
  });

  it("accepts host messages only from the parent captured at install", async () => {
    vi.useFakeTimers();
    const env = await install("nonce-abcdefghijklmnop");
    const impostor = { postMessage: () => {} };
    env.hijack();

    // A `ready` from the window app code substituted is not the host's.
    env.deliver({ source: impostor, data: { kyoube: 1, event: "ready", context: { companyId: "spoofed" } } });
    let resolved: unknown = "pending";
    void env.sdk().ready().then((context) => { resolved = context; });
    await Promise.resolve();
    expect(resolved).toBe("pending");

    env.deliver({ source: env.parent, data: { kyoube: 1, event: "ready", context: { companyId: "c1" } } });
    await Promise.resolve();
    expect(resolved).toEqual({ companyId: "c1" });
    // Answered: the retry schedule stops rather than posting for the life of the page.
    const posted = env.posts.length;
    vi.advanceTimersByTime(10_000);
    expect(env.posts).toHaveLength(posted);
  });
});
