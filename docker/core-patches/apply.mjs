#!/usr/bin/env node
// Applies docker/core-patches/patches.mjs to a core tree, once, at image build
// time: `node apply.mjs --root /app [--core-version <tag>] [--dry-run] [--report]`.
// Exits non-zero (failing the build) when any patch does not match exactly as
// declared. `--core-version` is the core tag the build uses; when it is not the
// one the patches are written for, a failure leads with that.
import { applyPatches, coreVersionHint } from "./lib.mjs";
import { CORE_VERSION, PATCHES } from "./patches.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
};
const root = value("--root");
if (!root) {
  console.error("usage: apply.mjs --root <core tree> [--core-version <tag>] [--dry-run] [--report]");
  process.exit(2);
}
const buildCore = value("--core-version");
const hint = coreVersionHint(buildCore, CORE_VERSION);
try {
  const report = await applyPatches(root, PATCHES, { dryRun: flag("--dry-run") });
  if (flag("--report") || report.length === 0) {
    if (report.length === 0) console.log("core-patches: none declared");
    for (const entry of report) console.log(`core-patches: ${entry.id} applied ${entry.matched}/${entry.expect} in ${entry.files.join(", ")}`);
  }
  if (hint) console.error(`core-patches: note: built on core ${buildCore}; these patches are written for core ${CORE_VERSION} and still matched`);
} catch (error) {
  if (hint) console.error(`core-patches: ${hint}`);
  console.error(`core-patches: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
