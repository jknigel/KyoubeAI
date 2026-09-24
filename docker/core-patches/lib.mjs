import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Expands one `dir/prefix-*.ext` style glob (a single `*`, in the basename only) under `root`. */
export async function expandGlob(root, glob) {
  const dir = path.dirname(glob);
  const base = path.basename(glob);
  const star = base.indexOf("*");
  if (star === -1) return [path.join(root, glob)];
  const prefix = base.slice(0, star);
  const suffix = base.slice(star + 1);
  let names;
  try {
    names = await readdir(path.join(root, dir));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix) && name.length >= prefix.length + suffix.length)
    .sort()
    .map((name) => path.join(root, dir, name));
}

/**
 * Applies one patch to one text and reports how many times it matched. The
 * decision about that count belongs to the caller: `applyPatches` compares
 * the total across files with `patch.expect`.
 */
export function applyToText(text, patch) {
  let count = 0;
  const out = text.replace(patch.pattern, (...args) => {
    count += 1;
    // Rebuild `$n` references by hand so a replacement string works the same
    // through this counting wrapper as it would passed to `replace` directly.
    const groups = args.slice(1, -2);
    return patch.replacement.replace(/\$(\d+)/g, (_, n) => groups[Number(n) - 1] ?? "");
  });
  return { text: out, count };
}

/**
 * Applies every patch under `root`. Returns a report; throws when a patch did
 * not match exactly `expect` times — the build must stop, not ship a core
 * with a fix silently missing (0) or applied somewhere it was not meant for (>expect).
 */
export async function applyPatches(root, patches, { dryRun = false } = {}) {
  const report = [];
  for (const patch of patches) {
    const files = (await Promise.all(patch.files.map((glob) => expandGlob(root, glob)))).flat();
    let total = 0;
    const touched = [];
    for (const file of files) {
      const before = await readFile(file, "utf8");
      const { text, count } = applyToText(before, patch);
      if (count === 0) continue;
      total += count;
      touched.push(path.relative(root, file));
      if (!dryRun) await writeFile(file, text);
    }
    report.push({ id: patch.id, matched: total, expect: patch.expect, files: touched });
    if (total !== patch.expect) {
      throw new Error(
        `core patch "${patch.id}" matched ${total} time(s) in ${files.length} candidate file(s), expected ${patch.expect}. ` +
          `Either the core release changed this code (redo the patch) or it now carries the upstream fix (delete the patch): ${patch.upstream}`,
      );
    }
  }
  return report;
}

/**
 * Explains a build on a different core than the patches are written for. The
 * usual cause is a `.env` left over from an earlier release: it pins
 * KYOUBE_CORE_VERSION, and `git pull` never updates `.env`, so the new
 * release's patches meet the old core and match nothing. Returns null when the
 * cores agree or the build did not say which core it uses.
 */
export function coreVersionHint(buildCore, patchedCore) {
  if (!buildCore || buildCore === patchedCore) return null;
  return (
    `this build uses core ${buildCore}, but this KyoubeAI release is made for core ${patchedCore}. ` +
    `If you did not mean to change the core, KYOUBE_CORE_VERSION (or the older PAPERCLIP_VERSION) in your .env ` +
    `is left over from an earlier release, and git pull does not update .env: set it to ${patchedCore}, ` +
    `or delete the line to follow the release's pin, then build again.`
  );
}
