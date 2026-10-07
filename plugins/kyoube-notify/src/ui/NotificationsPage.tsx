import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import type { DeviceState } from "./device.js";
import { ensureStyles } from "./styles.js";
import { useNotifyDevice, type DeviceView } from "./use-notify.js";

const STATE_TEXT: Record<DeviceState, string> = {
  on: "Notifications are on for this device.",
  off: "Notifications are off for this device.",
  "ios-install": "Add KyoubeAI to your Home Screen first: tap Share, then Add to Home Screen, then open KyoubeAI from there.",
  insecure: "This KyoubeAI is open over http://. Notifications need an https:// address (see docs/mobile.md).",
  denied: "This browser blocks notifications from KyoubeAI. Allow them in the browser's or the phone's settings.",
  unsupported: "This browser cannot receive push notifications.",
};

function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

export function deliveryText(device: DeviceView, now = Date.now()): string {
  const failedLast = device.lastError && device.lastErrorAt && (!device.lastSuccessAt || Date.parse(device.lastErrorAt) > Date.parse(device.lastSuccessAt));
  if (failedLast) return `Last attempt failed: ${device.lastError}`;
  if (device.lastSuccessAt) return `Last delivered ${ago(device.lastSuccessAt, now)}`;
  return `Added ${ago(device.createdAt, now)}`;
}

export function NotificationsPage(_props: PluginPageProps) {
  ensureStyles();
  const device = useNotifyDevice();
  if (device.loading) return <div className="kn-page" data-kyoube-page="notifications">Loading…</div>;
  const prefs = device.config?.prefs ?? { failures: false, comments: false };
  const others = device.config?.devices.filter((item) => item.id !== device.thisDevice?.id) ?? [];
  return (
    <div className="kn-page" data-kyoube-page="notifications">
      <h1>Notifications</h1>
      <section className="kn-section">
        <h3>This device</h3>
        <p>{STATE_TEXT[device.state]}</p>
        {device.thisDevice && <p>{deliveryText(device.thisDevice)}</p>}
        {device.error && <p className="kn-error">{device.error}</p>}
        <div className="kn-actions">
          {device.state === "off" && <button type="button" className="kn-btn" data-primary="" disabled={device.busy} onClick={() => { void device.turnOn(); }}>Turn on</button>}
          {device.state === "on" && device.thisDevice && (
            <>
              <button type="button" className="kn-btn" disabled={device.busy} onClick={() => { void device.sendTest(device.thisDevice!.id); }}>Send a test</button>
              <button type="button" className="kn-btn" disabled={device.busy} onClick={() => { void device.turnOff(); }}>Turn off</button>
            </>
          )}
        </div>
      </section>
      <section className="kn-section">
        <h3>Always sent</h3>
        <p>When an agent asks you something, when an approval is waiting for a decision, and when a task you created or are assigned is done or blocked.</p>
      </section>
      <section className="kn-section">
        <h3>Also tell me</h3>
        <label className="kn-row">
          <span>Something broke<small>An agent's run failed. Owners and admins only; at most one per agent every 30 minutes.</small></span>
          <input type="checkbox" className="kn-toggle" checked={prefs.failures} disabled={device.busy} onChange={(event) => { void device.setPrefs({ failures: event.target.checked }); }} />
        </label>
        <label className="kn-row">
          <span>Comments on my tasks<small>A person or an agent commented on a task you created or are assigned.</small></span>
          <input type="checkbox" className="kn-toggle" checked={prefs.comments} disabled={device.busy} onChange={(event) => { void device.setPrefs({ comments: event.target.checked }); }} />
        </label>
      </section>
      {others.length > 0 && (
        <section className="kn-section">
          <h3>Your other devices</h3>
          {others.map((item) => (
            <div className="kn-row" key={item.id}>
              <span>{item.label}<small>{deliveryText(item)}</small></span>
              <button type="button" className="kn-btn" disabled={device.busy} onClick={() => { void device.remove(item.id); }}>Remove</button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
