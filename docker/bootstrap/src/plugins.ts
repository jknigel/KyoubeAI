import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { InstalledPlugin } from "./core-api.js";

export interface LocalPluginBundle {
  dir: string;
  name: string;
  pluginKey: string;
  version: string;
}

export type PluginAction = "install" | "upgrade" | "skip";

export interface PluginPlan {
  bundle: LocalPluginBundle;
  action: PluginAction;
  reason: string;
  installed: InstalledPlugin | null;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(manifestPath: string): Promise<{ id: string; version: string }> {
  const mod = (await import(pathToFileURL(manifestPath).href)) as { default?: { id?: unknown; version?: unknown } };
  const manifest = mod.default ?? {};
  if (typeof manifest.id !== "string" || typeof manifest.version !== "string") {
    throw new Error(`Invalid plugin manifest at ${manifestPath}: expected default export with id and version`);
  }
  return { id: manifest.id, version: manifest.version };
}

export async function scanPluginRoot(root: string): Promise<LocalPluginBundle[]> {
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const bundles: LocalPluginBundle[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifestPath = path.join(dir, "dist", "manifest.js");
    if (!(await exists(manifestPath))) continue;
    const manifest = await readManifest(manifestPath);
    bundles.push({ dir, name: entry.name, pluginKey: manifest.id, version: manifest.version });
  }
  return bundles.sort((a, b) => a.name.localeCompare(b.name));
}

export function planPluginInstalls(local: LocalPluginBundle[], installed: InstalledPlugin[]): PluginPlan[] {
  return local.map((bundle) => {
    const current = installed.find((plugin) => plugin.pluginKey === bundle.pluginKey) ?? null;
    if (!current || current.status === "uninstalled") {
      return { bundle, action: "install", reason: current ? "previously uninstalled" : "not installed", installed: current };
    }
    if (current.status === "disabled") {
      return { bundle, action: "skip", reason: "operator-disabled; leaving as-is", installed: current };
    }
    if (current.version !== bundle.version) {
      // `installed` is the transient status a row holds between the install
      // call and the worker activating it. Upstream's lifecycle rejects an
      // upgrade from it outright ("Plugin must be in 'ready' or
      // 'upgrade_pending' status to be upgraded", HTTP 400), so planning one
      // here would fail the whole run over a row that is about to settle.
      // Skipping leaves it for the next `ensure-plugins` cycle.
      if (current.status === "installed") {
        return { bundle, action: "skip", reason: "status installed is not ready yet; retried next cycle", installed: current };
      }
      return { bundle, action: "upgrade", reason: `version ${current.version} -> ${bundle.version}`, installed: current };
    }
    return { bundle, action: "skip", reason: `already at ${bundle.version} (${current.status})`, installed: current };
  });
}
