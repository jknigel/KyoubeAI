import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planPluginInstalls, scanPluginRoot, type LocalPluginBundle } from "../src/plugins.js";

async function makeBundle(root: string, name: string, id: string, version: string) {
  await mkdir(path.join(root, name, "dist"), { recursive: true });
  await writeFile(
    path.join(root, name, "dist", "manifest.js"),
    `export default { id: ${JSON.stringify(id)}, apiVersion: 1, version: ${JSON.stringify(version)} };\n`,
  );
}

describe("scanPluginRoot", () => {
  it("returns one bundle per directory that has dist/manifest.js, sorted by name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kyoube-plugins-"));
    await makeBundle(root, "terminal", "kyoube.terminal", "0.1.0");
    await makeBundle(root, "apps", "kyoube.apps", "0.2.0");
    await mkdir(path.join(root, "not-a-plugin"));
    const bundles = await scanPluginRoot(root);
    expect(bundles).toEqual([
      { dir: path.join(root, "apps"), name: "apps", pluginKey: "kyoube.apps", version: "0.2.0" },
      { dir: path.join(root, "terminal"), name: "terminal", pluginKey: "kyoube.terminal", version: "0.1.0" },
    ]);
  });

  it("returns an empty list for a missing root", async () => {
    expect(await scanPluginRoot(path.join(os.tmpdir(), "does-not-exist-kyoube"))).toEqual([]);
  });
});

describe("planPluginInstalls", () => {
  const terminal: LocalPluginBundle = { dir: "/opt/kyoube/plugins/terminal", name: "terminal", pluginKey: "kyoube.terminal", version: "0.2.0" };

  it("installs when the plugin is absent", () => {
    const [plan] = planPluginInstalls([terminal], []);
    expect(plan).toMatchObject({ action: "install", installed: null });
  });

  it("reinstalls when the plugin was uninstalled", () => {
    const installed = { id: "1", pluginKey: "kyoube.terminal", version: "0.2.0", status: "uninstalled", packagePath: null };
    expect(planPluginInstalls([terminal], [installed])[0]).toMatchObject({ action: "install" });
  });

  it("upgrades when versions differ", () => {
    const installed = { id: "1", pluginKey: "kyoube.terminal", version: "0.1.0", status: "ready", packagePath: "/opt/kyoube/plugins/terminal" };
    expect(planPluginInstalls([terminal], [installed])[0]).toMatchObject({ action: "upgrade", reason: expect.stringContaining("0.1.0 -> 0.2.0") });
  });

  it("skips a version bump while the row is still at the transient `installed` status", () => {
    // Upstream only upgrades `ready`/`upgrade_pending` rows; asking it to
    // upgrade an `installed` one is a 400 that would fail the whole run.
    const installed = { id: "1", pluginKey: "kyoube.terminal", version: "0.1.0", status: "installed", packagePath: "/opt/kyoube/plugins/terminal" };
    expect(planPluginInstalls([terminal], [installed])[0]).toMatchObject({
      action: "skip",
      reason: expect.stringContaining("not ready yet"),
    });
  });

  it("skips when versions match and leaves disabled plugins alone", () => {
    const ready = { id: "1", pluginKey: "kyoube.terminal", version: "0.2.0", status: "ready", packagePath: null };
    expect(planPluginInstalls([terminal], [ready])[0]).toMatchObject({ action: "skip" });
    const disabled = { ...ready, version: "0.1.0", status: "disabled" };
    expect(planPluginInstalls([terminal], [disabled])[0]).toMatchObject({ action: "skip", reason: expect.stringContaining("disabled") });
  });
});
