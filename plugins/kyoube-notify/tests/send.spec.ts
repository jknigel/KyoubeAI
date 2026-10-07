import { describe, expect, it } from "vitest";
import { generateVapidKeys } from "../src/webpush/vapid.js";
import { isAllowedEndpoint, parseSubscription } from "../src/webpush/endpoints.js";
import { sendPush, type PushMessage } from "../src/webpush/send.js";
import { decryptBody, fakeTransport, makeDevice } from "./helpers.js";

const MESSAGE: PushMessage = { title: "Ada is asking: Ship it?", body: "ACM-1 · Launch post", url: "/ACM/issues/ACM-1", tag: "issue:1", urgency: "high" };
const vapid = generateVapidKeys();

describe("isAllowedEndpoint", () => {
  it.each([
    ["https://fcm.googleapis.com/fcm/send/abc", true],
    ["https://web.push.apple.com/QGc7", true],
    ["https://updates.push.services.mozilla.com/wpush/v2/gAAA", true],
    ["https://wns2-par02p.notify.windows.com/w/?token=x", true],
    ["http://fcm.googleapis.com/fcm/send/abc", false],
    ["https://fcm.googleapis.com:8443/fcm/send/abc", false],
    ["https://user:pw@fcm.googleapis.com/fcm/send/abc", false],
    ["https://evil.example.com/fcm.googleapis.com", false],
    ["https://push.apple.com.evil.example/x", false],
    ["http://127.0.0.1:39123/push", false],
    ["not a url", false],
  ])("%s → %s", (endpoint, allowed) => {
    expect(isAllowedEndpoint(endpoint, null)).toBe(allowed);
  });

  it("allows exactly the smoke test's endpoint while it is configured", () => {
    expect(isAllowedEndpoint("http://127.0.0.1:39123/push", "http://127.0.0.1:39123/push")).toBe(true);
    expect(isAllowedEndpoint("http://127.0.0.1:39123/other", "http://127.0.0.1:39123/push")).toBe(false);
  });
});

describe("parseSubscription", () => {
  it("accepts a browser's PushSubscription JSON", () => {
    const { subscription } = makeDevice();
    expect(parseSubscription(subscription, null)).toEqual({ endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth });
  });

  it("refuses unknown push services and malformed keys", () => {
    const { subscription } = makeDevice();
    expect(() => parseSubscription({ ...subscription, endpoint: "https://evil.example.com/x" }, null)).toThrow("invalid: subscription endpoint is not a known push service");
    expect(() => parseSubscription({ ...subscription, keys: { ...subscription.keys, p256dh: "AAAA" } }, null)).toThrow("uncompressed P-256");
    expect(() => parseSubscription({ ...subscription, keys: { ...subscription.keys, auth: "AAAA" } }, null)).toThrow("16 bytes");
    expect(() => parseSubscription(null, null)).toThrow("invalid");
    expect(() => parseSubscription({ endpoint: `https://fcm.googleapis.com/${"x".repeat(2100)}`, keys: subscription.keys }, null)).toThrow("too long");
  });
});

describe("sendPush", () => {
  const options = (transport: ReturnType<typeof fakeTransport>["transport"], sleeps: number[] = []) => ({
    vapid, subject: "https://kyoube.example.com", transport, nowSeconds: () => 1_800_000_000, sleep: async (ms: number) => { sleeps.push(ms); },
  });

  it("posts an encrypted, VAPID-signed request with the push headers", async () => {
    const device = makeDevice();
    const { sent, transport } = fakeTransport([201]);
    const outcome = await sendPush(parseSubscription(device.subscription, null), MESSAGE, options(transport));
    expect(outcome).toEqual({ result: "delivered", status: 201 });
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request!.url).toBe(device.subscription.endpoint);
    expect(request!.headers).toMatchObject({ TTL: "86400", Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream" });
    expect(request!.headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(request!.headers.Topic).toMatch(/^[\w-]{32}$/);
    expect(JSON.parse(decryptBody(request!.body, device))).toEqual({ title: MESSAGE.title, body: MESSAGE.body, url: MESSAGE.url, tag: MESSAGE.tag });
  });

  it("reports a subscription the push service has dropped as gone", async () => {
    for (const status of [404, 410]) {
      const { transport } = fakeTransport([status]);
      expect(await sendPush(parseSubscription(makeDevice().subscription, null), MESSAGE, options(transport))).toEqual({ result: "gone", status });
    }
  });

  it("retries once after 2 s on 429, 5xx and network errors", async () => {
    const sleeps: number[] = [];
    const first = fakeTransport([429, 201]);
    expect(await sendPush(parseSubscription(makeDevice().subscription, null), MESSAGE, options(first.transport, sleeps))).toEqual({ result: "delivered", status: 201 });
    expect(sleeps).toEqual([2000]);
    const second = fakeTransport([503, 500]);
    expect(await sendPush(parseSubscription(makeDevice().subscription, null), MESSAGE, options(second.transport))).toEqual({ result: "failed", status: 500, error: "push service answered 500" });
    expect(second.sent).toHaveLength(2);
    const third = fakeTransport([new Error("ECONNRESET"), new Error("ECONNRESET")]);
    expect(await sendPush(parseSubscription(makeDevice().subscription, null), MESSAGE, options(third.transport))).toEqual({ result: "failed", status: null, error: "push service unreachable: ECONNRESET" });
  });

  it("does not retry a refusal such as 400 or 403", async () => {
    const { sent, transport } = fakeTransport([403]);
    expect(await sendPush(parseSubscription(makeDevice().subscription, null), MESSAGE, options(transport))).toEqual({ result: "failed", status: 403, error: "push service refused the request (403)" });
    expect(sent).toHaveLength(1);
  });
});
