import { createHash } from "node:crypto";
import type { ScopeKey } from "@paperclipai/plugin-sdk";
import type { PushTarget } from "./webpush/endpoints.js";
import type { SendOutcome } from "./webpush/send.js";
import { generateVapidKeys, type VapidKeys } from "./webpush/vapid.js";

export interface DeviceRecord {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  createdAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface Prefs {
  failures: boolean;
  comments: boolean;
}

export interface StateLike {
  get(key: ScopeKey): Promise<unknown>;
  set(key: ScopeKey, value: unknown): Promise<void>;
  delete(key: ScopeKey): Promise<void>;
}

export const MAX_DEVICES = 10;

/** A short, stable id for a device, derived from its endpoint, so the UI never has to send the endpoint back. */
export function deviceIdOf(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
}

/**
 * Everything the plugin keeps, in instance-scoped plugin state (the core's
 * database, so the existing backups cover it). The state API has no user
 * scope, so per-person entries are keyed by user id: `subs:<userId>`,
 * `prefs:<userId>`. Everything lives in the `notify` namespace.
 */
export class NotifyStore {
  constructor(private readonly state: StateLike, private readonly now: () => number = Date.now) {}

  private key(stateKey: string): ScopeKey {
    return { scopeKind: "instance", namespace: "notify", stateKey };
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  async vapid(): Promise<VapidKeys> {
    const stored = (await this.state.get(this.key("vapid"))) as Partial<VapidKeys> | null;
    if (stored && typeof stored.publicKey === "string" && typeof stored.privateKey === "string") return { publicKey: stored.publicKey, privateKey: stored.privateKey };
    const keys = generateVapidKeys();
    await this.state.set(this.key("vapid"), keys);
    return keys;
  }

  async devices(userId: string): Promise<DeviceRecord[]> {
    const value = await this.state.get(this.key(`subs:${userId}`));
    return Array.isArray(value) ? (value as DeviceRecord[]) : [];
  }

  private async saveDevices(userId: string, devices: DeviceRecord[]): Promise<void> {
    if (devices.length === 0) await this.state.delete(this.key(`subs:${userId}`));
    else await this.state.set(this.key(`subs:${userId}`), devices);
  }

  async addDevice(userId: string, target: PushTarget, label: string): Promise<DeviceRecord> {
    const id = deviceIdOf(target.endpoint);
    const record: DeviceRecord = {
      id,
      endpoint: target.endpoint,
      p256dh: target.p256dh,
      auth: target.auth,
      label: label.trim().slice(0, 60) || "This device",
      createdAt: this.iso(),
      lastSuccessAt: null,
      lastError: null,
      lastErrorAt: null,
    };
    const others = (await this.devices(userId)).filter((device) => device.id !== id);
    await this.saveDevices(userId, [...others, record].slice(-MAX_DEVICES));
    return record;
  }

  async removeDevice(userId: string, deviceId: string): Promise<boolean> {
    const devices = await this.devices(userId);
    const kept = devices.filter((device) => device.id !== deviceId);
    if (kept.length === devices.length) return false;
    await this.saveDevices(userId, kept);
    return true;
  }

  /** Applies one send's outcomes for one person in a single write: gone devices are removed, the rest get their last result. */
  async applyOutcomes(userId: string, outcomes: Map<string, SendOutcome>): Promise<void> {
    const at = this.iso();
    const next = (await this.devices(userId)).flatMap((device): DeviceRecord[] => {
      const outcome = outcomes.get(device.id);
      if (!outcome) return [device];
      if (outcome.result === "gone") return [];
      if (outcome.result === "delivered") return [{ ...device, lastSuccessAt: at, lastError: null, lastErrorAt: null }];
      return [{ ...device, lastError: outcome.error, lastErrorAt: at }];
    });
    await this.saveDevices(userId, next);
  }

  async prefs(userId: string): Promise<Prefs> {
    const value = (await this.state.get(this.key(`prefs:${userId}`))) as Partial<Prefs> | null;
    return { failures: value?.failures === true, comments: value?.comments === true };
  }

  async setPrefs(userId: string, patch: Partial<Prefs>): Promise<Prefs> {
    const current = await this.prefs(userId);
    const next: Prefs = {
      failures: typeof patch.failures === "boolean" ? patch.failures : current.failures,
      comments: typeof patch.comments === "boolean" ? patch.comments : current.comments,
    };
    await this.state.set(this.key(`prefs:${userId}`), next);
    return next;
  }

  async lastStatus(issueId: string): Promise<string | null> {
    const value = await this.state.get(this.key(`issue-status:${issueId}`));
    return typeof value === "string" ? value : null;
  }

  async setStatus(issueId: string, status: string): Promise<void> {
    await this.state.set(this.key(`issue-status:${issueId}`), status);
  }

  /** True the first time it is called for a question; false after. */
  async claimInteraction(interactionId: string): Promise<boolean> {
    const key = this.key(`seen-interaction:${interactionId}`);
    if (await this.state.get(key)) return false;
    await this.state.set(key, this.iso());
    return true;
  }

  /** True when no failure push went out for this agent within `windowMs`; records now when it returns true. */
  async claimFailure(agentId: string, windowMs: number): Promise<boolean> {
    const key = this.key(`throttle:${agentId}`);
    const last = await this.state.get(key);
    if (typeof last === "number" && this.now() - last < windowMs) return false;
    await this.state.set(key, this.now());
    return true;
  }
}
