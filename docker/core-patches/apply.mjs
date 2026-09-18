#!/usr/bin/env node
// Applies docker/core-patches/patches.mjs to a core tree, once, at image build
// time: `node apply.mjs --root /app [--dry-run] [--report]`. Exits non-zero
// (failing the build) when any patch does not match exactly as declared.
import { applyPatches } from "./lib.mjs";
import { PATCHES } from "./patches.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
};
const root = value("--root");
if (!root) {
  console.error("usage: apply.mjs --root <core tree> [--dry-run] [--report]");
  process.exit(2);
}
try {
  const report = await applyPatches(root, PATCHES, { dryRun: flag("--dry-run") });
  if (flag("--report") || report.length === 0) {
    if (report.length === 0) console.log("core-patches: none declared");
    for (const entry of report) console.log(`core-patches: ${entry.id} applied ${entry.matched}/${entry.expect} in ${entry.files.join(", ")}`);
  }
} catch (error) {
  console.error(`core-patches: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
