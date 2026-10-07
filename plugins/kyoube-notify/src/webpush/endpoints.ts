import { NotifyError } from "../errors.js";

/** One browser subscription as the worker stores it: the endpoint and the browser's keys, base64url. */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * The push services browsers use: Chrome, Edge and Android (FCM), Safari and
 * iOS (Apple), Firefox (Mozilla), and Edge on Windows (WNS). A subscription
 * elsewhere is refused, so a crafted "subscription" cannot make the server
 * send requests to an address of the attacker's choosing.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /\.push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

export function isAllowedEndpoint(endpoint: string, testEndpoint: string | null): boolean {
  if (testEndpoint && endpoint === testEndpoint) return true;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  return PUSH_HOSTS.some((host) => host.test(url.hostname));
}

const MAX_ENDPOINT = 2048;

/** Validates a browser's `PushSubscription.toJSON()` and returns what the worker stores. */
export function parseSubscription(raw: unknown, testEndpoint: string | null): PushTarget {
  const sub = (raw ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof sub.endpoint === "string" ? sub.endpoint : "";
  if (!endpoint || endpoint.length > MAX_ENDPOINT) throw new NotifyError("invalid", "subscription endpoint is missing or too long");
  if (!isAllowedEndpoint(endpoint, testEndpoint)) throw new NotifyError("invalid", "subscription endpoint is not a known push service");
  const p256dh = typeof sub.keys?.p256dh === "string" ? sub.keys.p256dh : "";
  const auth = typeof sub.keys?.auth === "string" ? sub.keys.auth : "";
  const point = Buffer.from(p256dh, "base64url");
  if (point.length !== 65 || point[0] !== 4) throw new NotifyError("invalid", "p256dh must be an uncompressed P-256 point");
  if (Buffer.from(auth, "base64url").length !== 16) throw new NotifyError("invalid", "auth must be 16 bytes");
  return { endpoint, p256dh, auth };
}
