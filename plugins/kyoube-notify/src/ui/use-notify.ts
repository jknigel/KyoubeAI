import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { browserSubscription, deviceLabel, deviceState, readDeviceEnv, sameKey, subscribeBrowser, unsubscribeBrowser, type DeviceEnv, type DeviceState } from "./device.js";

export interface DeviceView { id: string; label: string; endpoint: string; createdAt: string; lastSuccessAt: string | null; lastError: string | null; lastErrorAt: string | null }
export interface NotifyPrefs { failures: boolean; comments: boolean }
export interface NotifyConfig { publicKey: string; prefs: NotifyPrefs; devices: DeviceView[]; canReceiveFailures?: boolean }

export interface NotifyDevice {
  loading: boolean;
  busy: boolean;
  state: DeviceState;
  config: NotifyConfig | null;
  thisDevice: DeviceView | null;
  error: string | null;
  retry(): void;
  turnOn(): Promise<void>;
  turnOff(): Promise<void>;
  sendTest(deviceId: string): Promise<void>;
  remove(deviceId: string): Promise<void>;
  setPrefs(patch: Partial<NotifyPrefs>): Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^\w+: /, "");

export function useNotifyDevice(): NotifyDevice {
  const actions = {
    config: usePluginAction("notify.config"),
    subscribe: usePluginAction("notify.subscribe"),
    unsubscribe: usePluginAction("notify.unsubscribe"),
    prefs: usePluginAction("notify.prefs"),
    test: usePluginAction("notify.test"),
  };
  // Ruling P1-R15 (kyoube-apps): action functions are not referentially stable, so effects read them through a ref.
  const ref = useRef(actions);
  ref.current = actions;
  const [env, setEnv] = useState<DeviceEnv>(() => readDeviceEnv());
  const [config, setConfig] = useState<NotifyConfig | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const current = readDeviceEnv();
    let cfg = (await ref.current.config({})) as NotifyConfig;
    let subscription = current.supported && current.secure ? await browserSubscription().catch(() => null) : null;
    // The server's key changed (its state was restored from elsewhere): this subscription can no longer be used.
    if (subscription && !sameKey(subscription.options.applicationServerKey, cfg.publicKey)) {
      await subscription.unsubscribe().catch(() => false);
      subscription = null;
      if (current.permission === "granted") {
        try {
          const json = await subscribeBrowser(cfg.publicKey);
          await ref.current.subscribe({ subscription: json, label: deviceLabel(navigator.userAgent) });
          cfg = (await ref.current.config({})) as NotifyConfig;
          subscription = await browserSubscription();
        } catch {
          subscription = null;
        }
      }
    }
    setEnv(readDeviceEnv());
    setConfig(cfg);
    setEndpoint(subscription?.endpoint ?? null);
  }, []);

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    load().catch((err: unknown) => { if (!cancelled) setError(message(err)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load, attempt]);

  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (err) {
      setError(message(err));
      setEnv(readDeviceEnv());
    } finally {
      setBusy(false);
    }
  }, [load]);

  const thisDevice = config?.devices.find((device) => device.endpoint === endpoint) ?? null;
  return {
    loading,
    busy,
    state: deviceState(env, thisDevice !== null),
    config,
    thisDevice,
    error,
    retry: () => { setError(null); setLoading(true); setAttempt((n) => n + 1); },
    turnOn: () => run(async () => {
      if (!config) throw new Error("The notification settings are not loaded yet.");
      const json = await subscribeBrowser(config.publicKey);
      await ref.current.subscribe({ subscription: json, label: deviceLabel(navigator.userAgent) });
    }),
    turnOff: () => run(async () => {
      const gone = await unsubscribeBrowser();
      const device = config?.devices.find((item) => item.endpoint === gone);
      if (device) await ref.current.unsubscribe({ deviceId: device.id });
    }),
    sendTest: (deviceId) => run(async () => {
      const outcome = (await ref.current.test({ deviceId })) as { result: string; error?: string };
      if (outcome.result !== "delivered") throw new Error(outcome.error ?? "The push service did not take the test.");
    }),
    remove: (deviceId) => run(() => ref.current.unsubscribe({ deviceId })),
    setPrefs: (patch) => run(() => ref.current.prefs(patch)),
  };
}
