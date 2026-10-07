export type DeviceState = "insecure" | "ios-install" | "unsupported" | "denied" | "off" | "on";

export interface DeviceEnv {
  secure: boolean;
  ios: boolean;
  standalone: boolean;
  supported: boolean;
  permission: "default" | "granted" | "denied";
}

export function readDeviceEnv(win: Window | undefined = typeof window === "undefined" ? undefined : window): DeviceEnv {
  if (!win) return { secure: false, ios: false, standalone: false, supported: false, permission: "default" };
  const nav = win.navigator as Navigator & { standalone?: boolean };
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  const standalone = nav.standalone === true || (typeof win.matchMedia === "function" && win.matchMedia("(display-mode: standalone)").matches);
  const supported = "serviceWorker" in nav && "PushManager" in win && "Notification" in win;
  const permission = supported ? ((win as Window & { Notification: { permission: DeviceEnv["permission"] } }).Notification.permission) : "default";
  return { secure: win.isSecureContext === true, ios, standalone, supported, permission };
}

/** What the card and page show. Order matters: an iPhone outside the Home Screen reports push as unsupported, so it is told how to install first. */
export function deviceState(env: DeviceEnv, registeredHere: boolean): DeviceState {
  if (!env.secure) return "insecure";
  if (env.ios && !env.standalone) return "ios-install";
  if (!env.supported) return "unsupported";
  if (env.permission === "denied") return "denied";
  return registeredHere && env.permission === "granted" ? "on" : "off";
}

export function deviceLabel(ua: string): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "this computer";
  return `${browser} on ${os}`;
}

/** base64url → bytes, in the browser (no Buffer). */
export function keyBytes(b64u: string): Uint8Array {
  const b64 = b64u.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64u.length + 3) % 4);
  const binary = atob(b64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function sameKey(key: ArrayBuffer | null | undefined, publicKey: string): boolean {
  if (!key) return false;
  const a = new Uint8Array(key);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export async function browserSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration ? registration.pushManager.getSubscription() : null;
}

/**
 * Asks for permission first, inside the person's tap (iOS only allows the
 * prompt from a user gesture), then registers the core's /sw.js (harmless if
 * the core already did, and push keeps working if it ever stops) and
 * subscribes with the instance's key.
 */
export async function subscribeBrowser(publicKey: string): Promise<PushSubscriptionJSON> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications are blocked for this site." : "Notifications were not allowed.");
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing && sameKey(existing.options.applicationServerKey, publicKey)) return existing.toJSON();
  if (existing) await existing.unsubscribe();
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
  return subscription.toJSON();
}

/** Unsubscribes this browser and returns the endpoint it had, or null. */
export async function unsubscribeBrowser(): Promise<string | null> {
  const subscription = await browserSubscription();
  if (!subscription) return null;
  await subscription.unsubscribe();
  return subscription.endpoint;
}
