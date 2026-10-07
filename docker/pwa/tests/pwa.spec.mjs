import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMPORT_LINE, PUSH_SW, PwaError, runPwa } from "../pwa.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA_DIR = path.resolve(HERE, "..");
const FIXTURES = path.join(HERE, "fixtures");
const quiet = () => {};

let root;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "kyoube-pwa-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** A built core tree from the 1.4.1 fixtures, optionally edited to simulate an upstream change. */
async function coreTree({ sw, manifest, index, bundle = 'x.register("/sw.js").then(' } = {}) {
  const dist = path.join(root, "ui", "dist");
  await mkdir(path.join(dist, "assets"), { recursive: true });
  for (const [name, override] of [["sw.js", sw], ["site.webmanifest", manifest], ["index.html", index]]) {
    if (override === null) continue;
    if (override === undefined) await copyFile(path.join(FIXTURES, name), path.join(dist, name));
    else await writeFile(path.join(dist, name), override);
  }
  await writeFile(path.join(dist, "assets", "index-abc.js"), bundle);
}
const read = (rel) => readFile(path.join(root, "ui", "dist", rel), "utf8");
const fixture = (name) => readFile(path.join(FIXTURES, name), "utf8");

describe("runPwa on the 1.4.1 core", () => {
  it("makes the manifest standalone, adds the iOS tags, copies the handlers and imports them once", async () => {
    await coreTree();
    const lines = [];
    await runPwa({ root, pwaDir: PWA_DIR, report: true, log: (line) => lines.push(line), warn: quiet });
    expect(JSON.parse(await read("site.webmanifest"))).toMatchObject({ name: "KyoubeAI", display: "standalone" });
    const index = await read("index.html");
    expect(index.split('name="apple-mobile-web-app-capable" content="yes"').length - 1).toBe(1);
    expect(index.split('name="mobile-web-app-capable" content="yes"').length - 1).toBe(1);
    const sw = await read("sw.js");
    expect(sw.startsWith(await fixture("sw.js"))).toBe(true);
    expect(sw.trimEnd().endsWith(IMPORT_LINE)).toBe(true);
    expect(await read(PUSH_SW)).toBe(await readFile(path.join(PWA_DIR, PUSH_SW), "utf8"));
    expect(lines.join("\n")).toContain("pwa: manifest standalone, iOS tags added, sw.js imports /kyoube-push-sw.js");
  });

  it("refuses to run twice on the same tree", async () => {
    await coreTree();
    await runPwa({ root, pwaDir: PWA_DIR, log: quiet, warn: quiet });
    await expect(runPwa({ root, pwaDir: PWA_DIR, log: quiet, warn: quiet })).rejects.toThrow("already imports");
  });

  it("only warns when the core stops registering its worker, since the card registers it", async () => {
    await coreTree({ bundle: "nothing here" });
    const warnings = [];
    const result = await runPwa({ root, pwaDir: PWA_DIR, log: quiet, warn: (line) => warnings.push(line) });
    expect(result.register).toBe(false);
    expect(warnings.join("\n")).toContain('register("/sw.js")');
  });

  it("warns instead of throwing when the assets directory is missing", async () => {
    await coreTree();
    await rm(path.join(root, "ui", "dist", "assets"), { recursive: true });
    const warnings = [];
    const result = await runPwa({ root, pwaDir: PWA_DIR, log: quiet, warn: (line) => warnings.push(line) });
    expect(result.register).toBe(false);
    expect(warnings.join("\n")).toContain('register("/sw.js")');
  });

  it("keeps a meta tag upstream already added instead of doubling it", async () => {
    const index = (await fixture("index.html")).replace("<meta name=\"apple-mobile-web-app-title\"", '<meta name="mobile-web-app-capable" content="yes" />\n    <meta name="apple-mobile-web-app-title"');
    await coreTree({ index });
    await runPwa({ root, pwaDir: PWA_DIR, log: quiet, warn: quiet });
    expect((await read("index.html")).split('name="mobile-web-app-capable"').length - 1).toBe(1);
  });
});

describe("runPwa stops the build when the core changed", () => {
  const cases = [
    ["sw.js is gone", { sw: null }, "sw.js is missing"],
    ["sw.js has no fetch listener", { sw: "self.addEventListener('install', () => {});" }, "expected one fetch listener"],
    ["the core handles push itself", { sw: 'self.addEventListener("fetch", () => {});\nself.addEventListener("push", () => {});' }, "now handles push itself"],
    ["the manifest is not JSON", { manifest: "{ nope" }, "site.webmanifest is not valid JSON"],
    ["the manifest is null", { manifest: "null" }, "site.webmanifest is not a JSON object"],
    ["the manifest is an array", { manifest: "[]" }, "site.webmanifest is not a JSON object"],
    ["the iOS title tag is gone", { index: "<html><head></head></html>" }, 'apple-mobile-web-app-title" matched 0'],
  ];
  it.each(cases)("%s", async (_name, change, message) => {
    await coreTree(change);
    const error = await runPwa({ root, pwaDir: PWA_DIR, log: quiet, warn: quiet }).catch((err) => err);
    expect(error).toBeInstanceOf(PwaError);
    expect(error.message).toContain(message);
  });

  it("writes nothing when the service worker check fails", async () => {
    await coreTree({ sw: "self.addEventListener('install', () => {});" });
    await runPwa({ root, pwaDir: PWA_DIR, log: quiet, warn: quiet }).catch(() => {});
    expect(await read("sw.js")).toBe("self.addEventListener('install', () => {});");
    expect(JSON.parse(await read("site.webmanifest")).display).toBe("browser");
  });

  it("writes nothing when a check fails", async () => {
    await coreTree({ index: "<html><head></head></html>" });
    await runPwa({ root, pwaDir: PWA_DIR, log: quiet, warn: quiet }).catch(() => {});
    expect(await read("sw.js")).toBe(await fixture("sw.js"));
    expect(JSON.parse(await read("site.webmanifest")).display).toBe("browser");
  });
});
