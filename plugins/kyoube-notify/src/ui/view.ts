import type { NotifyConfig } from "./use-notify.js";

export const LOAD_FAILED_TEXT = "Could not load the notification settings.";

/**
 * What the card and page should render once the device state is known:
 * `loading` until the first load ends, `failed` when it ended without a config
 * (nothing that needs the config, such as Turn on or the toggles, may render),
 * `ready` otherwise.
 */
export function notifyView(device: { loading: boolean; config: NotifyConfig | null }): "loading" | "failed" | "ready" {
  if (device.loading) return "loading";
  return device.config ? "ready" : "failed";
}

/** The Something broke toggle works only for owners and admins; an older worker that does not say is treated as "no". */
export function canReceiveFailures(config: NotifyConfig | null): boolean {
  return config?.canReceiveFailures === true;
}
