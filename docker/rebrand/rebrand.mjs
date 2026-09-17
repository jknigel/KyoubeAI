#!/usr/bin/env node
/**
 * KyoubeAI build-time brand transform. Runs inside docker/Dockerfile on the
 * pristine upstream layer (never on its own output), so a core bump is
 * re-branded by construction and drift fails the build:
 *
 *   node rebrand.mjs --root /app --brand /opt/kyoube/brand --verify --report
 *
 * Steps: text rules over the spec's file set → static artwork → the two SVGs
 * inside the main bundle → re-hash /assets and rewrite references → verify.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashContent, planRenames, rewriteReferences } from "./lib/assets.mjs";
import { SWEEP_ALLOWLIST, collectFiles, collectSweepFiles, isBinary, isCodeFile, knownResidualReason, sweepArea } from "./lib/files.mjs";
import { markPathFrom, parseSvgElements, renderFaviconSvg, renderManifest, renderThinkingSvg, replaceLockup, replaceThinkingIcon } from "./lib/svg.mjs";
import { NAME_RE, buildTextRules, displayMatches, findResidual, rewriteCode, rewriteText } from "./lib/text-rules.mjs";

export class RebrandError extends Error {}

const ICON_FILES = ["favicon.ico", "favicon-16x16.png", "favicon-32x32.png", "apple-touch-icon.png", "android-chrome-192x192.png", "android-chrome-512x512.png"];
const WORKTREE_ICON_FILES = ["worktree-favicon.ico", "worktree-favicon-16x16.png", "worktree-favicon-32x32.png"];
const OLD_THINKING = "paperclip-thinking.svg";

async function loadKit(brandDir) {
  const brand = JSON.parse(await readFile(path.join(brandDir, "brand.json"), "utf8"));
  const markSvg = await readFile(path.join(brandDir, "mark.svg"), "utf8");
  const lockupSvg = await readFile(path.join(brandDir, "lockup.svg"), "utf8");
  const icons = {};
  for (const name of ICON_FILES) icons[name] = await readFile(path.join(brandDir, "icons", name));
  const hash = createHash("sha256").update(JSON.stringify(brand)).update(markSvg).update(lockupSvg);
  for (const name of ICON_FILES) hash.update(icons[name]);
  const thinkingName = `${brand.name.toLowerCase()}-thinking.svg`;
  return { brand, markD: markPathFrom(markSvg), lockup: parseSvgElements(lockupSvg), icons, thinkingName, hash: hash.digest("hex") };
}

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

export async function runRebrand({ root, brandDir, verify = true, report = false, log = console.log }) {
  const kit = await loadKit(brandDir);
  const uiDist = path.join(root, "ui", "dist");
  const assetsDir = path.join(uiDist, "assets");
  const rules = buildTextRules(kit.brand);
  // The thinking icon is referenced from the bundle by URL; renaming the file
  // means rewriting that one reference too.
  rules.unshift({ kind: "phrase", from: new RegExp(`/${OLD_THINKING.replace(".", "\\.")}`, "g"), to: `/${kit.thinkingName}` });

  const counts = {};
  const anchors = { lockup: 0, thinking: 0 };
  const residual = [];
  const skippedBinary = [];
  const codeShaped = [];
  const notUtf8 = [];
  let filesTouched = 0;

  // 1. Text rules (+ the bundle SVG surgery on every asset JS; anchors are counted across all files).
  const collected = await collectFiles(root);
  for (const file of collected.files) {
    const raw = await readFile(file);
    if (isBinary(raw)) { skippedBinary.push(path.relative(root, file)); continue; }
    let text = raw.toString("utf8");
    const rel = path.relative(root, file).replace(/\\/g, "/");
    // A file that does not survive a UTF-8 round trip would be corrupted by
    // writing `text` back (a latin-1 byte becomes U+FFFD), so refuse it.
    if (!Buffer.from(text, "utf8").equals(raw)) { notUtf8.push(rel); continue; }
    const before = text;
    if (file.startsWith(assetsDir) && file.endsWith(".js")) {
      const lockup = replaceLockup(text, kit.lockup);
      anchors.lockup += lockup.matches;
      const thinking = replaceThinkingIcon(lockup.text, kit.markD);
      anchors.thinking += thinking.matches;
      text = thinking.text;
    }
    // `packages/**` code runs from source through tsx, so the name rule there
    // applies only in display context — a bare `Paperclip` is an identifier.
    const rewritten = isCodeFile(rel) ? rewriteCode(text, rules) : rewriteText(text, rules);
    text = rewritten.text;
    for (const [kind, n] of Object.entries(rewritten.counts)) counts[kind] = (counts[kind] ?? 0) + n;
    for (const context of rewritten.codeShaped ?? []) codeShaped.push(`${rel}: ${context}`);
    if (text !== before) { await writeFile(file, text); filesTouched += 1; }
    const left = isCodeFile(rel) ? [] : findResidual(text, 3);
    for (const context of left) residual.push(`${rel}: ${context}`);
  }

  // 2. Static artwork.
  for (const name of ICON_FILES) await writeFile(path.join(uiDist, name), kit.icons[name]);
  for (const name of WORKTREE_ICON_FILES) {
    if (await exists(path.join(uiDist, name))) await writeFile(path.join(uiDist, name), kit.icons[name.replace("worktree-", "")]);
  }
  await writeFile(path.join(uiDist, "favicon.svg"), renderFaviconSvg(kit.markD));
  if (await exists(path.join(uiDist, "worktree-favicon.svg"))) await writeFile(path.join(uiDist, "worktree-favicon.svg"), renderFaviconSvg(kit.markD));
  await writeFile(path.join(uiDist, kit.thinkingName), renderThinkingSvg(kit.markD));
  await rm(path.join(uiDist, OLD_THINKING), { force: true });
  const manifestPath = path.join(uiDist, "site.webmanifest");
  if (await exists(manifestPath)) await writeFile(manifestPath, renderManifest(await readFile(manifestPath, "utf8"), kit.brand));

  // 3. Re-hash asset names, then rewrite every reference under ui/dist.
  const assetNames = (await readdir(assetsDir)).sort();
  const entries = [];
  for (const name of assetNames) entries.push({ name, hash: hashContent(await readFile(path.join(assetsDir, name)), kit.hash) });
  const renames = planRenames(entries);
  for (const [from, to] of renames) await rename(path.join(assetsDir, from), path.join(assetsDir, to));
  let references = 0;
  for (const file of (await collectFiles(root)).files) {
    if (!file.startsWith(uiDist)) continue;
    const raw = await readFile(file);
    if (isBinary(raw)) continue;
    const { text, count } = rewriteReferences(raw.toString("utf8"), renames);
    if (count > 0) { await writeFile(file, text); references += count; }
  }

  // 4. Whole-image sweep. The residual list above only re-checks the files the
  // transform just cleaned, so it can never find the gap that matters: a tree
  // the file set never entered. This walks *everything* under --root and
  // counts what the name rule would still match, grouped into rows, and fails
  // the build for any row that is not a known source-not-executed tree.
  const sweep = new Map();
  const sweepContexts = new Map();
  const knownResiduals = [];
  for (const file of await collectSweepFiles(root)) {
    const raw = await readFile(file);
    if (isBinary(raw)) continue;
    const text = raw.toString("utf8");
    if (!text.includes("Paperclip")) continue;
    const rel = path.relative(root, file).replace(/\\/g, "/");
    const knownReason = knownResidualReason(rel);
    if (knownReason) {
      knownResiduals.push(`${rel} (${[...text.matchAll(NAME_RE)].length}): ${knownReason}`);
      continue;
    }
    const area = sweepArea(rel);
    // Bare identifiers in `packages` code are not residuals: `rewriteCode`
    // leaves them on purpose and reports them as code-shaped.
    const code = isCodeFile(rel);
    let hits = 0;
    for (const line of text.split("\n")) {
      const matches = code ? displayMatches(line) : [...line.matchAll(NAME_RE)].map((m) => m.index);
      for (const _index of matches) {
        hits += 1;
        if (!sweepContexts.has(area)) sweepContexts.set(area, []);
        const contexts = sweepContexts.get(area);
        if (contexts.length < 5) contexts.push(`${rel}: ${line.trim().slice(0, 100)}`);
      }
    }
    if (hits > 0) sweep.set(area, (sweep.get(area) ?? 0) + hits);
  }
  const sweepRows = [...sweep.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const sweepFailures = sweepRows.filter(([area]) => !SWEEP_ALLOWLIST.includes(area));

  // 5. Verify.
  const problems = [];
  if (anchors.lockup !== 1) problems.push(`lockup anchor matched ${anchors.lockup} times (expected 1) — upstream moved or changed PaperclipLockup`);
  if (anchors.thinking !== 1) problems.push(`loading-icon anchor matched ${anchors.thinking} times (expected 1) — upstream changed AnimatedPaperclipIcon`);
  if (residual.length > 0) problems.push(`the name rule still matches after rewriting:\n  ${residual.slice(0, 20).join("\n  ")}`);
  if (notUtf8.length > 0) problems.push(`not valid UTF-8, so the transform refused to rewrite it: ${notUtf8.join(", ")}`);
  for (const [area, n] of sweepFailures) {
    problems.push(`sweep: ${area} still carries ${n} display match(es) of the upstream name and is not a source-only tree:\n  ${(sweepContexts.get(area) ?? []).join("\n  ")}`);
  }
  if (await exists(manifestPath)) {
    const manifestName = JSON.parse(await readFile(manifestPath, "utf8")).name;
    if (manifestName !== kit.brand.name) problems.push(`site.webmanifest name is ${JSON.stringify(manifestName)}, expected ${JSON.stringify(kit.brand.name)}`);
  }
  const indexHtml = await readFile(path.join(uiDist, "index.html"), "utf8");
  if (!indexHtml.includes(`<title>${kit.brand.name}</title>`)) problems.push(`index.html does not carry <title>${kit.brand.name}</title>`);
  if (!indexHtml.includes("PAPERCLIP_RUNTIME_BRANDING_START")) problems.push("index.html lost the upstream runtime-branding marker block");
  // Every reference to a file under ui/dist/assets must resolve, whatever
  // extension it names (js, css, map, woff2, png, svg, …) and whatever form
  // it takes: `/assets/<name>` appears anywhere in ui/dist; a bare
  // `./<name>` or a `sourceMappingURL=<name>` comment only makes sense
  // *inside* assets/ itself and is resolved against the referring file's own
  // directory. `./` is excluded when it is really the tail of `../`, so a
  // map's embedded `sourcesContent` (which legitimately says `../foo.js`
  // relative to the pre-bundle source tree, not to assets/) is never treated
  // as a same-directory reference. `<name>` allows dots inside it so
  // `index-abc.js.map` is captured whole rather than truncated at the first
  // extension.
  const REF_NAME = "[A-Za-z0-9_.-]+\\.[A-Za-z0-9]+";
  const ABS_ASSET_RE = new RegExp(`/assets/(${REF_NAME})`, "g");
  const RELATIVE_RE = new RegExp(`(?<![A-Za-z0-9_./-])\\./(${REF_NAME})`, "g");
  const SOURCEMAP_RE = new RegExp(`sourceMappingURL=(${REF_NAME})`, "g");
  for (const file of (await collectFiles(root)).files) {
    if (!file.startsWith(uiDist)) continue;
    const raw = await readFile(file);
    if (isBinary(raw)) continue;
    const text = raw.toString("utf8");
    const rel = path.relative(root, file);
    const dir = path.dirname(file);
    for (const match of text.matchAll(ABS_ASSET_RE)) {
      if (!(await exists(path.join(assetsDir, match[1])))) problems.push(`${rel} references missing asset ${match[1]}`);
    }
    if (file.startsWith(assetsDir)) {
      for (const match of text.matchAll(RELATIVE_RE)) {
        if (!(await exists(path.join(dir, match[1])))) problems.push(`${rel} references missing asset ${match[1]}`);
      }
      for (const match of text.matchAll(SOURCEMAP_RE)) {
        if (!(await exists(path.join(dir, match[1])))) problems.push(`${rel} references missing asset ${match[1]}`);
      }
    }
  }
  if (verify && problems.length > 0) throw new RebrandError(`rebrand verification failed:\n- ${problems.join("\n- ")}`);

  const result = {
    counts, renamed: renames.size, references, filesTouched, residual, anchors, skippedBinary,
    skippedSymlinks: collected.skippedSymlinks, codeShaped, notUtf8,
    sweep: Object.fromEntries(sweepRows), sweepFailures: sweepFailures.map(([area]) => area), knownResiduals, problems,
  };
  if (report) {
    log(`rebrand: ${filesTouched} files rewritten (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}), ${renames.size} assets renamed, ${references} references rewritten`);
    log(`rebrand: anchors lockup=${anchors.lockup} thinking=${anchors.thinking}; residual ${residual.length}; binaries skipped ${skippedBinary.length}; symlinks skipped ${collected.skippedSymlinks.length}${collected.skippedSymlinks.length > 0 ? ` (${collected.skippedSymlinks.slice(0, 10).join(", ")})` : ""}`);
    log(`rebrand: code-shaped matches left alone: ${codeShaped.length}`);
    for (const context of codeShaped.slice(0, 20)) log(`rebrand:   ${context}`);
    log(`rebrand: whole-image sweep (name matches per tree; * = allowlisted source-only tree)`);
    if (sweepRows.length === 0) log("rebrand:   (every tree clean)");
    for (const [area, n] of sweepRows) log(`rebrand:   ${SWEEP_ALLOWLIST.includes(area) ? "*" : " "} ${area.padEnd(24)} ${n}`);
    for (const known of knownResiduals) log(`rebrand:   ! known residual ${known}`);
    for (const problem of problems) log(`rebrand: WARNING ${problem}`);
  }
  return result;
}

function parseArgs(argv) {
  const opts = { verify: false, report: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") opts.root = argv[++i];
    else if (arg === "--brand") opts.brandDir = argv[++i];
    else if (arg === "--verify") opts.verify = true;
    else if (arg === "--report") opts.report = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!opts.root || !opts.brandDir) throw new Error("usage: rebrand.mjs --root <dir> --brand <dir> [--verify] [--report]");
  return opts;
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    await runRebrand(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else if (process.argv.includes("--root")) {
  // Invoked as a CLI (a `--root` in argv) but not recognised as the entrypoint:
  // failing loudly beats exiting 0 having rebranded nothing, which in a
  // Dockerfile would bake an unbranded image that passes every later check.
  throw new Error(`rebrand.mjs was given --root but is not the entrypoint (argv[1]=${process.argv[1]}); refusing to exit having done nothing`);
}
