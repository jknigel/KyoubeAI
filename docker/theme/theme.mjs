#!/usr/bin/env node
/**
 * KyoubeAI build-time theme ("Studio"). Runs inside docker/Dockerfile on the
 * pristine core layer, after docker/core-patches and before docker/rebrand
 * (so the rebrand's asset re-hashing covers the theme's stylesheet too):
 *
 *   node theme.mjs --root /app --theme /opt/kyoube/theme --report
 *
 * Steps, all checked before anything is written:
 *   1. TEXT_RULES (rules.mjs): display-text renames and the dark default,
 *      each matching exactly its declared count.
 *   2. ANCHORS and SECTIONS (anchors.mjs): the hooks theme.css relies on.
 *   3. Tokens: every core custom property theme.css overrides must still be
 *      declared by the core's own stylesheet.
 * Then it writes the rewritten files, copies theme.css to
 * ui/dist/assets/kyoube-theme.css and the fonts to ui/dist/fonts/kyoube/,
 * links the stylesheet right after the core's in index.html, and inlines
 * boot.js after it (the flag that applies the Studio layout before the
 * Studio plugin's UI has loaded).
 *
 * Any failed check throws ThemeError, which fails the image build with every
 * problem listed. See docs/theme.md for what to do after a core bump.
 */
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyToText, expandGlob } from "../core-patches/lib.mjs";
import { ANCHORS, SECTIONS } from "./anchors.mjs";
import { TEXT_RULES } from "./rules.mjs";

export class ThemeError extends Error {}

export const THEME_ASSET = "kyoube-theme.css";
export const FONT_DIR = "fonts/kyoube";
const CORE_STYLESHEET_RE = /<link rel="stylesheet"[^>]*href="\/assets\/index-[^"]+\.css"[^>]*>/g;

/** Custom properties theme.css sets that belong to the core (not our own --kyoube-*). */
export function overriddenTokens(themeCss) {
  const withoutComments = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const names = new Set();
  for (const match of withoutComments.matchAll(/(--[a-z0-9-]+)\s*:/g)) {
    if (!match[1].startsWith("--kyoube-")) names.add(match[1]);
  }
  return [...names].sort();
}

/** Routes (`to:"/x"`) between `start` and the next `end` in `text`, or null when either literal is missing. */
export function sectionRoutes(text, start, end) {
  const from = text.indexOf(start);
  if (from === -1) return null;
  const to = text.indexOf(end, from + start.length);
  if (to === -1) return null;
  return [...text.slice(from, to).matchAll(/to:"(\/[^"]*)"/g)].map((m) => m[1]);
}

/** The text of every file matched by `globs`, as a Map path → text, read once and shared by the checks. */
async function loadFiles(root, globs, cache) {
  const files = (await Promise.all(globs.map((glob) => expandGlob(root, glob)))).flat();
  for (const file of files) if (!cache.has(file)) cache.set(file, await readFile(file, "utf8"));
  return files;
}

export async function runTheme({ root, themeDir, dryRun = false, report = false, log = console.log }) {
  const uiDist = path.join(root, "ui", "dist");
  const indexPath = path.join(uiDist, "index.html");
  const problems = [];
  const texts = new Map();
  const touched = new Set();

  const indexBefore = await readFile(indexPath, "utf8");
  if (indexBefore.includes(THEME_ASSET)) {
    throw new ThemeError(`${path.relative(root, indexPath)} already links ${THEME_ASSET}: the theme runs once, on the pristine core layer`);
  }

  // 1. Text rules, applied in memory and in order.
  const ruleReport = [];
  for (const rule of TEXT_RULES) {
    const files = await loadFiles(root, rule.files, texts);
    let matched = 0;
    for (const file of files) {
      const { text, count } = applyToText(texts.get(file), rule);
      if (count === 0) continue;
      matched += count;
      texts.set(file, text);
      touched.add(file);
    }
    ruleReport.push(`${rule.id} ${matched}/${rule.expect}`);
    if (matched !== rule.expect) {
      problems.push(`text rule "${rule.id}" matched ${matched} time(s) in ${files.length} file(s), expected ${rule.expect}: the core changed this code; update the pattern in docker/theme/rules.mjs`);
    }
  }

  // 2. Anchors and sidebar sections, checked against the rewritten text.
  let anchorsOk = 0;
  for (const anchor of ANCHORS) {
    const files = await loadFiles(root, anchor.files, texts);
    let count = 0;
    for (const file of files) count += texts.get(file).split(anchor.literal).length - 1;
    if (count >= anchor.min) anchorsOk += 1;
    else problems.push(`anchor "${anchor.id}" matched ${count} time(s), expected at least ${anchor.min} (${anchor.why}): update docker/theme/theme.css and anchors.mjs for the new core`);
  }
  const bundleFiles = await loadFiles(root, ["ui/dist/assets/*.js"], texts);
  const sectionReport = [];
  for (const section of SECTIONS) {
    let routes = null;
    for (const file of bundleFiles) {
      routes = sectionRoutes(texts.get(file), section.start, section.end);
      if (routes) break;
    }
    if (!routes) {
      problems.push(`sidebar section "${section.id}" not found (between ${section.start} and ${section.end})`);
      continue;
    }
    const missing = section.expected.filter((route) => !routes.includes(route));
    const added = routes.filter((route) => !section.expected.includes(route));
    if (section.mode === "exact" && (missing.length > 0 || added.length > 0)) {
      problems.push(`sidebar section "${section.id}" changed: added [${added.join(", ")}], removed [${missing.join(", ")}]. The skin hides this section, so give any new link a card on the Studio Workspace page, then update SECTIONS in docker/theme/anchors.mjs`);
    } else if (missing.length > 0) {
      problems.push(`sidebar section "${section.id}" no longer links [${missing.join(", ")}]: update docker/theme/theme.css and anchors.mjs`);
    }
    sectionReport.push(`${section.id}=${routes.length}${added.length > 0 ? ` (new: ${added.join(" ")})` : ""}`);
  }

  // 3. Tokens: what theme.css overrides must still exist in the core's CSS.
  const themeCss = await readFile(path.join(themeDir, "theme.css"), "utf8");
  if (/Paperclip/.test(themeCss)) problems.push("theme.css mentions the upstream name; the rebrand sweep would flag it");
  const bootJs = (await readFile(path.join(themeDir, "boot.js"), "utf8")).trim();
  if (/<\/script/i.test(bootJs) || /Paperclip/.test(bootJs)) problems.push("boot.js must not contain a closing script tag or the upstream name");
  const cssFiles = (await readdir(path.join(uiDist, "assets"))).filter((name) => name.endsWith(".css")).map((name) => path.join(uiDist, "assets", name));
  let coreCss = "";
  for (const file of cssFiles) coreCss += await readFile(file, "utf8");
  const tokens = overriddenTokens(themeCss);
  const undeclared = tokens.filter((token) => !coreCss.includes(`${token}:`));
  if (undeclared.length > 0) {
    problems.push(`the core no longer declares ${undeclared.join(", ")}: find what replaced them and update docker/theme/theme.css`);
  }

  // 4. The stylesheet link goes right after the core's.
  const coreLinks = indexBefore.match(CORE_STYLESHEET_RE) ?? [];
  if (coreLinks.length !== 1) problems.push(`index.html has ${coreLinks.length} core stylesheet links, expected 1`);

  if (problems.length > 0) throw new ThemeError(`theme verification failed:\n- ${problems.join("\n- ")}`);

  const fonts = (await readdir(path.join(themeDir, "fonts"))).filter((name) => name.endsWith(".woff2") || name === "OFL.txt").sort();
  if (!dryRun) {
    for (const file of touched) if (file !== indexPath) await writeFile(file, texts.get(file));
    const indexAfterRules = texts.get(indexPath) ?? indexBefore;
    const indexThemed = indexAfterRules.replace(CORE_STYLESHEET_RE, (link) => `${link}\n    <link rel="stylesheet" href="/assets/${THEME_ASSET}">\n    <script>${bootJs}</script>`);
    await writeFile(indexPath, indexThemed);
    await writeFile(path.join(uiDist, "assets", THEME_ASSET), themeCss);
    await mkdir(path.join(uiDist, FONT_DIR), { recursive: true });
    for (const name of fonts) await copyFile(path.join(themeDir, "fonts", name), path.join(uiDist, FONT_DIR, name));
  }

  const result = { rules: ruleReport, anchors: anchorsOk, sections: sectionReport, tokens: tokens.length, fonts: fonts.length, files: touched.size };
  if (report) {
    log(`theme: ${TEXT_RULES.length} text rules applied in ${touched.size} file(s): ${ruleReport.join(", ")}`);
    log(`theme: anchors ${anchorsOk}/${ANCHORS.length}; sidebar sections ${sectionReport.join(", ")}`);
    log(`theme: ${tokens.length} core tokens overridden, all still declared by the core`);
    log(`theme: ${dryRun ? "would link" : "linked"} /assets/${THEME_ASSET} after the core stylesheet; ${fonts.length} font files in /${FONT_DIR}`);
  }
  return result;
}

function parseArgs(argv) {
  const opts = { dryRun: false, report: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") opts.root = argv[++i];
    else if (arg === "--theme") opts.themeDir = argv[++i];
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--report") opts.report = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!opts.root || !opts.themeDir) throw new Error("usage: theme.mjs --root <core tree> --theme <dir> [--dry-run] [--report]");
  return opts;
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    await runTheme(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
