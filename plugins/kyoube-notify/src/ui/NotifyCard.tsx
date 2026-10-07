import { useState } from "react";
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { NOTIFICATIONS_ROUTE } from "../manifest.js";
import { useCompanyNavigation } from "./navigation.js";
import { ensureStyles } from "./styles.js";
import { useNotifyDevice } from "./use-notify.js";

export const CARD_COPY: Record<"off" | "ios-install" | "insecure" | "denied", { title: string; body: string }> = {
  off: { title: "Get notified on this device", body: "Hear when an agent asks you something, when an approval is waiting, and when one of your tasks is done or blocked." },
  "ios-install": { title: "Add KyoubeAI to your Home Screen", body: "iPhone and iPad send notifications only to apps on the Home Screen. Tap Share, then Add to Home Screen, then open KyoubeAI from there." },
  insecure: { title: "Notifications need a secure address", body: "This KyoubeAI is open over http://. Phones only allow notifications from an https:// address. Your administrator can set one up (see docs/mobile.md)." },
  denied: { title: "Notifications are blocked", body: "This browser is blocking notifications from KyoubeAI. Allow them in the browser's or the phone's settings, then come back here." },
};

const DISMISS_KEY = "kyoube.notify.card-dismissed";

function readDismissed(): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
}

function writeDismissed(): void {
  try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* storage blocked: the card comes back next visit */ }
}

/** The Home card: a prompt until this device is on (dismissible per device), then one quiet line. */
export function NotifyCard(_props: PluginWidgetProps) {
  ensureStyles();
  const device = useNotifyDevice();
  const navigation = useCompanyNavigation();
  const [dismissed, setDismissed] = useState(readDismissed);
  if (device.loading || device.state === "unsupported") return <span data-kyoube-notify="hidden" />;
  const settings = navigation.linkProps(`/${NOTIFICATIONS_ROUTE}`);
  if (device.state === "on") {
    return <div className="kn-line" data-kyoube-notify="line">Notifications are on for this device · <a {...settings}>Settings</a></div>;
  }
  if (dismissed) return <span data-kyoube-notify="hidden" />;
  const copy = CARD_COPY[device.state];
  return (
    <div className="kn-card" data-kyoube-notify="card">
      <h3>{copy.title}</h3>
      <p>{copy.body}</p>
      {device.error && <p className="kn-error">{device.error}</p>}
      <div className="kn-actions">
        {device.state === "off" && <button type="button" className="kn-btn" data-primary="" disabled={device.busy} onClick={() => { void device.turnOn(); }}>Turn on</button>}
        <button type="button" className="kn-btn" onClick={() => { writeDismissed(); setDismissed(true); }}>Not now</button>
      </div>
    </div>
  );
}
