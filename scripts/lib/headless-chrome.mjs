/**
 * Drives the Chrome the machine already has, headless, for the browser checks
 * (scripts/browser-check.mjs, scripts/terminal-fit-check.mjs). Nothing here is
 * a test: it finds the browser and dumps the DOM a page ends up with, and each
 * check decides what that DOM has to say.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const CHROME_CANDIDATES = {
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"],
};

/** `CHROME_PATH` wins; otherwise the first candidate that exists (or that answers `--version` from PATH). */
export function findChrome() {
  const explicit = process.env.CHROME_PATH;
  if (explicit) return existsSync(explicit) ? explicit : null;
  for (const candidate of CHROME_CANDIDATES[process.platform] ?? []) {
    if (candidate.includes(path.sep) || candidate.includes("/")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (!probe.error) return candidate;
  }
  return null;
}

/**
 * Loads `target` in headless Chrome and returns the serialised DOM once the
 * virtual-time budget has run out. `target` is a file path or an `http(s)://`
 * URL; `network: true` drops the resolver rule (`--host-resolver-rules=MAP *
 * ~NOTFOUND`, which otherwise fails every lookup) so a live check can reach the
 * local stack. `windowSize` ("width,height" in CSS pixels) sets the viewport for
 * checks that measure against it; headless Chrome's own default is small and
 * not worth depending on.
 */
export function dumpDom(chrome, profile, target, { virtualTimeBudgetMs = 3000, windowSize, network = false } = {}) {
  const isUrl = /^https?:\/\//.test(target);
  const result = spawnSync(chrome, [
    "--headless=new",
    "--dump-dom",
    ...(windowSize ? [`--window-size=${windowSize}`] : []),
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    // No network for file-based checks; a live check against the local stack keeps DNS.
    ...(network ? [] : ["--host-resolver-rules=MAP * ~NOTFOUND"]),
    `--virtual-time-budget=${virtualTimeBudgetMs}`,
    `--user-data-dir=${profile}`,
    isUrl ? target : `file://${target.replace(/\\/g, "/")}`,
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
  if (result.error) throw new Error(`could not run ${chrome}: ${result.error.message}`);
  // A non-zero exit is a browser that did not finish the page — a crash, a
  // timeout, a bad flag. Taking whatever it happened to print would report a
  // pass on a DOM nobody finished building.
  if (result.status !== 0) {
    throw new Error(`${chrome} exited ${result.status}: ${String(result.stderr).slice(0, 500)}`);
  }
  if (typeof result.stdout !== "string" || result.stdout.length === 0) {
    throw new Error(`${chrome} produced no DOM: ${String(result.stderr).slice(0, 500)}`);
  }
  return result.stdout;
}
