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
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly state: StateLike, private readonly now: () => number = Date.now) {}

  private key(stateKey: string): ScopeKey {
    return { scopeKind: "instance", namespace: "notify", stateKey };
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Runs read-modify-write steps one at a time: the worker handles events concurrently. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async vapid(): Promise<VapidKeys> {
    return this.exclusive(async () => {
      const stored = (await this.state.get(this.key("vapid"))) as Partial<VapidKeys> | null;
      if (stored && typeof stored.publicKey === "string" && typeof stored.privateKey === "string") return { publicKey: stored.publicKey, privateKey: stored.privateKey };
      const keys = generateVapidKeys();
      await this.state.set(this.key("vapid"), keys);
      return keys;
    });
  }

  async devices(userId: string): Promise<DeviceRecord[]> {
    return this._devices(userId);
  }

  private async _devices(userId: string): Promise<DeviceRecord[]> {
    const value = await this.state.get(this.key(`subs:${userId}`));
    return Array.isArray(value) ? (value as DeviceRecord[]) : [];
  }

  private async saveDevices(userId: string, devices: DeviceRecord[]): Promise<void> {
    if (devices.length === 0) await this.state.delete(this.key(`subs:${userId}`));
    else await this.state.set(this.key(`subs:${userId}`), devices);
  }

  async addDevice(userId: string, target: PushTarget, label: string): Promise<DeviceRecord> {
    return this.exclusive(async () => {
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
      // A browser has one subscription: whoever turns it on last owns it, so a shared computer
      // never sends the previous person's notifications to the next person's screen.
      const ownerKey = this.key(`endpoint-owner:${id}`);
      const previous = await this.state.get(ownerKey);
      if (typeof previous === "string" && previous !== userId) {
        await this.saveDevices(previous, (await this._devices(previous)).filter((device) => device.id !== id));
      }
      await this.state.set(ownerKey, userId);
      const others = (await this._devices(userId)).filter((device) => device.id !== id);
      const all = [...others, record];
      await this.saveDevices(userId, all.slice(-MAX_DEVICES));
      for (const dropped of all.slice(0, -MAX_DEVICES)) await this.releaseOwner(userId, dropped.id);
      return record;
    });
  }

  /** Drops the ownership entry for a device, if it still points at this person. */
  private async releaseOwner(userId: string, deviceId: string): Promise<void> {
    const key = this.key(`endpoint-owner:${deviceId}`);
    if ((await this.state.get(key)) === userId) await this.state.delete(key);
  }

  async removeDevice(userId: string, deviceId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const devices = await this._devices(userId);
      const kept = devices.filter((device) => device.id !== deviceId);
      if (kept.length === devices.length) return false;
      await this.saveDevices(userId, kept);
      await this.releaseOwner(userId, deviceId);
      return true;
    });
  }

  /** Applies one send's outcomes for one person in a single write: gone devices are removed, the rest get their last result. */
  async applyOutcomes(userId: string, outcomes: Map<string, SendOutcome>): Promise<void> {
    return this.exclusive(async () => {
      const at = this.iso();
      const next = (await this._devices(userId)).flatMap((device): DeviceRecord[] => {
        const outcome = outcomes.get(device.id);
        if (!outcome) return [device];
        if (outcome.result === "gone") return [];
        if (outcome.result === "delivered") return [{ ...device, lastSuccessAt: at, lastError: null, lastErrorAt: null }];
        return [{ ...device, lastError: outcome.error, lastErrorAt: at }];
      });
      await this.saveDevices(userId, next);
      for (const [deviceId, outcome] of outcomes) if (outcome.result === "gone") await this.releaseOwner(userId, deviceId);
    });
  }

  async prefs(userId: string): Promise<Prefs> {
    return this._prefs(userId);
  }

  private async _prefs(userId: string): Promise<Prefs> {
    const value = (await this.state.get(this.key(`prefs:${userId}`))) as Partial<Prefs> | null;
    return { failures: value?.failures === true, comments: value?.comments === true };
  }

  async setPrefs(userId: string, patch: Partial<Prefs>): Promise<Prefs> {
    return this.exclusive(async () => {
      const current = await this._prefs(userId);
      const next: Prefs = {
        failures: typeof patch.failures === "boolean" ? patch.failures : current.failures,
        comments: typeof patch.comments === "boolean" ? patch.comments : current.comments,
      };
      await this.state.set(this.key(`prefs:${userId}`), next);
      return next;
    });
  }

  /** Stores the task's status and returns the one stored before (null if none), atomically. */
  async swapStatus(issueId: string, status: string): Promise<string | null> {
    return this.exclusive(async () => {
      const key = this.key(`issue-status:${issueId}`);
      const value = await this.state.get(key);
      if (value !== status) await this.state.set(key, status);
      return typeof value === "string" ? value : null;
    });
  }

  /** True the first time it is called for a question; false after. */
  async claimInteraction(interactionId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const key = this.key(`seen-interaction:${interactionId}`);
      if (await this.state.get(key)) return false;
      await this.state.set(key, this.iso());
      return true;
    });
  }

  /** True when no failure push went out for this agent within `windowMs`; records now when it returns true. */
  async claimFailure(agentId: string, windowMs: number): Promise<boolean> {
    return this.exclusive(async () => {
      const key = this.key(`throttle:${agentId}`);
      const now = this.now();
      const last = await this.state.get(key);
      if (typeof last === "number" && last <= now && now - last < windowMs) return false;
      await this.state.set(key, now);
      return true;
    });
  }
}
