import type { LicenseStatus, SnapshotUser } from "@kyoube/license";

// Shared by the worker and the UI: plain values and types only, nothing that
// imports Node, so the browser bundle stays clean.

export const PLUGIN_ID = "kyoube.license";
export const PLUGIN_VERSION = "0.1.0";
/** The core's Settings → Plugins list, where this plugin's page opens. */
export const PLUGINS_SETTINGS_PATH = "/company/settings/instance/plugins";
/** The Terminal plugin's page (plugins/kyoube-terminal, PAGE_ROUTE). */
export const TERMINAL_PATH = "/terminal";

export function removeCommand(email: string): string {
  return `kyoube users remove '${email.replace(/'/g, "'\\''")}'`;
}

export interface LicenceUser extends SnapshotUser {
  removeCommand: string;
}

export interface LicenceView {
  visible: true;
  status: LicenseStatus;
  instanceId: string | null;
  /** When `kyoube license --watch` last read the users. */
  snapshotAt: string;
  users: LicenceUser[];
}

export type LicenceStatusAnswer = LicenceView | { visible: false; reason: "not_admin" | "no_snapshot" };

export type ApplyAnswer = { ok: true; view: LicenceView } | { ok: false; message: string };
