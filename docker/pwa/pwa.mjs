#!/usr/bin/env node
/**
 * KyoubeAI build-time installable app and Web Push support. Runs inside
 * docker/Dockerfile right after docker/rebrand, on the built core UI:
 *
 *   node pwa.mjs --root /app --pwa /opt/kyoube/pwa --report
 *
 * Every check runs before anything is written; any failure throws PwaError,
 * which stops the image build with the reason. See docs/mobile.md, "How it
 * survives core updates", for what each failure means at a core bump.
 *
 *   1. sw.js: the core's service worker must exist, have exactly one fetch
 *      listener and no push listener. One `importScripts` line is appended
 *      behind a `// kyoube-push` marker. (One worker per scope, so KyoubeAI's
 *      handlers must join the core's, not replace it.)
 *   2. site.webmanifest: must parse; `display` becomes `standalone` (iOS only
 *      allows Web Push for a standalone Home Screen app).
 *   3. index.html: `<meta name="apple-mobile-web-app-title"` exactly once; the
 *      two "capable" meta tags go right after it unless already present.
 *   4. The bundle should still call register("/sw.js"). Only a warning: the
 *      kyoube.notify card registers it itself.
 */
import { copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class PwaError extends Error {}

export const PUSH_SW = "kyoube-push-sw.js";
const MARKER = "// kyoube-push";
export const IMPORT_LINE = `importScripts("/${PUSH_SW}"); ${MARKER}`;
const APPLE_TITLE_RE = /<meta name="apple-mobile-web-app-title"[^>]*>/g;
const CAPABLE_TAGS = ['<meta name="apple-mobile-web-app-capable" content="yes" />', '<meta name="mobile-web-app-capable" content="yes" />'];

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

const count = (text, literal) => text.split(literal).length - 1;

export async function runPwa({ root, pwaDir, report = false, log = console.log, warn = console.warn }) {
  const dist = path.join(root, "ui", "dist");
  const swPath = path.join(dist, "sw.js");
  const manifestPath = path.join(dist, "site.webmanifest");
  const indexPath = path.join(dist, "index.html");
  const problems = [];

  const sw = await readOptional(swPath);
  if (sw === null) {
    problems.push("ui/dist/sw.js is missing: the core no longer ships a service worker; decide how the push handlers load (docs/mobile.md) before building");
  } else {
    if (sw.includes(MARKER)) problems.push(`sw.js already imports ${PUSH_SW}: the pwa step runs once, on the built core layer`);
    const fetchListeners = count(sw, 'addEventListener("fetch"');
    if (fetchListeners !== 1) problems.push(`core sw.js changed: expected one fetch listener, found ${fetchListeners}; check the import still belongs at its end`);
    if (/addEventListener\(\s*["']push["']/.test(sw)) problems.push("core sw.js now handles push itself: remove docker/pwa's import rather than stacking two push handlers");
  }

  let manifest = null;
  const manifestText = await readOptional(manifestPath);
  try {
    manifest = JSON.parse(manifestText ?? "");
  } catch {
    problems.push("ui/dist/site.webmanifest is not valid JSON");
  }

  const index = (await readOptional(indexPath)) ?? "";
  const titleTags = index.match(APPLE_TITLE_RE) ?? [];
  if (titleTags.length !== 1) problems.push(`index.html: <meta name="apple-mobile-web-app-title" matched ${titleTags.length} time(s), expected 1; the iOS tags are placed after it`);

  if (problems.length > 0) throw new PwaError(`pwa verification failed:\n- ${problems.join("\n- ")}`);

  let register = false;
  const assets = path.join(dist, "assets");
  for (const name of (await readdir(assets)).filter((file) => file.endsWith(".js"))) {
    if ((await readFile(path.join(assets, name), "utf8")).includes('register("/sw.js")')) { register = true; break; }
  }
  if (!register) warn('pwa: warning: the core bundle no longer calls register("/sw.js"); the kyoube.notify card registers it, so push still works');

  const missingTags = CAPABLE_TAGS.filter((tag) => !index.includes(tag.slice(0, tag.indexOf(" content"))));
  const indexOut = missingTags.length === 0 ? index : index.replace(APPLE_TITLE_RE, (tag) => `${tag}\n    ${missingTags.join("\n    ")}`);
  await writeFile(swPath, `${sw.replace(/\s*$/, "")}\n${IMPORT_LINE}\n`);
  await copyFile(path.join(pwaDir, PUSH_SW), path.join(dist, PUSH_SW));
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, display: "standalone" }, null, 2)}\n`);
  await writeFile(indexPath, indexOut);

  if (report) log(`pwa: manifest standalone, iOS tags ${missingTags.length > 0 ? "added" : "already present"}, sw.js imports /${PUSH_SW}${register ? "" : " (core no longer registers /sw.js)"}`);
  return { register };
}

function parseArgs(argv) {
  const opts = { report: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") opts.root = argv[++i];
    else if (arg === "--pwa") opts.pwaDir = argv[++i];
    else if (arg === "--report") opts.report = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!opts.root || !opts.pwaDir) throw new Error("usage: pwa.mjs --root <core tree> --pwa <dir> [--report]");
  return opts;
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    await runPwa(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
