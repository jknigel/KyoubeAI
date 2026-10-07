import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { MAX_DEVICES, NotifyStore, deviceIdOf } from "../src/store.js";
import { parseSubscription } from "../src/webpush/endpoints.js";
import { makeDevice } from "./helpers.js";

function setup(start = Date.parse("2026-10-07T10:00:00Z")) {
  const harness = createTestHarness({ manifest });
  let now = start;
  const store = new NotifyStore(harness.ctx.state, () => now);
  return { harness, store, advance: (ms: number) => { now += ms; } };
}
const target = () => parseSubscription(makeDevice().subscription, null);

describe("NotifyStore", () => {
  it("creates the VAPID key pair once and keeps it", async () => {
    const { store, harness } = setup();
    const first = await store.vapid();
    expect(await store.vapid()).toEqual(first);
    expect(harness.getState({ scopeKind: "instance", namespace: "notify", stateKey: "vapid" })).toEqual(first);
  });

  it("adds, replaces and removes a person's devices", async () => {
    const { store } = setup();
    const t = target();
    const added = await store.addDevice("u1", t, "iPhone");
    expect(added).toMatchObject({ id: deviceIdOf(t.endpoint), label: "iPhone", lastSuccessAt: null, createdAt: "2026-10-07T10:00:00.000Z" });
    await store.addDevice("u1", t, "iPhone again");
    expect((await store.devices("u1")).map((d) => d.label)).toEqual(["iPhone again"]);
    expect(await store.devices("u2")).toEqual([]);
    expect(await store.removeDevice("u2", added.id)).toBe(false);
    expect(await store.removeDevice("u1", added.id)).toBe(true);
    expect(await store.devices("u1")).toEqual([]);
  });

  it(`keeps at most ${MAX_DEVICES} devices, dropping the oldest`, async () => {
    const { store } = setup();
    const ids: string[] = [];
    for (let i = 0; i < MAX_DEVICES + 2; i += 1) ids.push((await store.addDevice("u1", target(), `d${i}`)).id);
    expect((await store.devices("u1")).map((d) => d.id)).toEqual(ids.slice(2));
  });

  it("records deliveries, refusals and dropped subscriptions in one write", async () => {
    const { store, advance } = setup();
    const a = await store.addDevice("u1", target(), "a");
    const b = await store.addDevice("u1", target(), "b");
    const c = await store.addDevice("u1", target(), "c");
    advance(60_000);
    await store.applyOutcomes("u1", new Map([
      [a.id, { result: "delivered", status: 201 }],
      [b.id, { result: "failed", status: 403, error: "push service refused the request (403)" }],
      [c.id, { result: "gone", status: 410 }],
    ]));
    const devices = await store.devices("u1");
    expect(devices.map((d) => d.id)).toEqual([a.id, b.id]);
    expect(devices[0]).toMatchObject({ lastSuccessAt: "2026-10-07T10:01:00.000Z", lastError: null });
    expect(devices[1]).toMatchObject({ lastSuccessAt: null, lastError: "push service refused the request (403)", lastErrorAt: "2026-10-07T10:01:00.000Z" });
  });

  it("defaults both opt-ins to off and merges changes", async () => {
    const { store } = setup();
    expect(await store.prefs("u1")).toEqual({ failures: false, comments: false });
    expect(await store.setPrefs("u1", { comments: true })).toEqual({ failures: false, comments: true });
    expect(await store.setPrefs("u1", { failures: true })).toEqual({ failures: true, comments: true });
  });

  it("claims a question once and a failure once per window", async () => {
    const { store, advance } = setup();
    expect(await store.claimInteraction("i1")).toBe(true);
    expect(await store.claimInteraction("i1")).toBe(false);
    expect(await store.claimFailure("agent-1", 30 * 60_000)).toBe(true);
    advance(29 * 60_000);
    expect(await store.claimFailure("agent-1", 30 * 60_000)).toBe(false);
    advance(2 * 60_000);
    expect(await store.claimFailure("agent-1", 30 * 60_000)).toBe(true);
  });

  it("remembers the last status it saw for a task", async () => {
    const { store } = setup();
    expect(await store.lastStatus("issue-1")).toBeNull();
    await store.setStatus("issue-1", "blocked");
    expect(await store.lastStatus("issue-1")).toBe("blocked");
  });
});
