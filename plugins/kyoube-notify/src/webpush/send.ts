import { createHash } from "node:crypto";
import { encryptPayload } from "./encrypt.js";
import type { PushTarget } from "./endpoints.js";
import { vapidAuthorization, type VapidKeys } from "./vapid.js";

/** What the service worker shows. `url` is a same-origin path; `tag` groups notifications about one thing. */
export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
  urgency: "high" | "normal";
}

export type PushTransport = (url: string, init: { method: "POST"; headers: Record<string, string>; body: Uint8Array }) => Promise<{ status: number }>;

export type SendOutcome =
  | { result: "delivered"; status: number }
  | { result: "gone"; status: number }
  | { result: "failed"; status: number | null; error: string };

export interface SendOptions {
  vapid: VapidKeys;
  subject: string;
  transport: PushTransport;
  nowSeconds: () => number;
  sleep: (ms: number) => Promise<void>;
  retryDelayMs?: number;
}

/** A day: a phone that is off longer than that doesn't need yesterday's "is asking". */
const TTL_SECONDS = "86400";

/** RFC 8030 `Topic`: at most 32 base64url characters. A newer push with the same topic replaces an undelivered older one. */
function topicOf(tag: string): string {
  return createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}

const retryable = (status: number) => status === 429 || status >= 500;

/**
 * Sends one notification to one device. 2xx is delivered; 404 and 410 mean
 * the browser dropped the subscription (the caller deletes it); 429, 5xx and
 * network errors get one retry after a short wait; anything else is a refusal
 * (a 403 usually means the keys changed) and is reported, not retried.
 */
export async function sendPush(target: PushTarget, message: PushMessage, options: SendOptions): Promise<SendOutcome> {
  const plaintext = Buffer.from(JSON.stringify({ title: message.title, body: message.body, url: message.url, tag: message.tag }));
  const body = encryptPayload({ plaintext, uaPublic: Buffer.from(target.p256dh, "base64url"), authSecret: Buffer.from(target.auth, "base64url") });
  const headers = {
    TTL: TTL_SECONDS,
    Urgency: message.urgency,
    Topic: topicOf(message.tag),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    Authorization: vapidAuthorization(target.endpoint, options.vapid, options.subject, options.nowSeconds()),
  };
  let last: SendOutcome = { result: "failed", status: null, error: "not sent" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await options.sleep(options.retryDelayMs ?? 2000);
    try {
      const { status } = await options.transport(target.endpoint, { method: "POST", headers, body });
      if (status >= 200 && status < 300) return { result: "delivered", status };
      if (status === 404 || status === 410) return { result: "gone", status };
      if (!retryable(status)) return { result: "failed", status, error: `push service refused the request (${status})` };
      last = { result: "failed", status, error: `push service answered ${status}` };
    } catch (error) {
      last = { result: "failed", status: null, error: `push service unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return last;
}
