#!/usr/bin/env node
/**
 * Asks a real browser whether the Terminal page's box holds still under xterm's
 * fit addon.
 *
 * The page sizes its terminal with `FitAddon.fit()` on mount, on session start
 * and from a `ResizeObserver` on the host `<div>`. `fit()` derives the row
 * count from the host's *computed* height — which, under the Paperclip UI's
 * Tailwind preflight (`box-sizing: border-box` on everything), includes the
 * host's own padding — and subtracts only the `.xterm` element's padding. So
 * any padding on the host is space `fit()` hands to rows that do not have it:
 * the terminal ends up taller than the host's content box. Upstream's plugin
 * page (`PluginPage.tsx`, a `space-y-4` wrapper with no height of its own)
 * gives the host nothing definite to fill, so the host is as tall as its
 * content, the oversized terminal enlarges it, the observer fires, and the
 * next `fit()` adds one more row. That loop is what "the terminal keeps
 * growing" was.
 *
 * No unit test can see this — it is layout, and the fit addon reads it from
 * `getComputedStyle`. So each shape below builds the DOM chain the plugin's
 * page actually lands in, with the plugin's own stylesheet (`ensureXtermStyles`)
 * and the same xterm + fit addon the UI bundle ships, runs the fits the page
 * would, and asks the browser:
 *
 *   1. the host's height after every fit is the height it had before the first
 *      one — a fit that enlarges its own container is the defect, whether it
 *      then runs away or stops after one step (it stops when a row is taller
 *      than the padding it swallows, which depends on the platform's font);
 *   2. the terminal screen lies inside the host's padding box — the same
 *      over-count shows as a clipped bottom row when the host *is* constrained.
 *
 * Shapes: the upstream plugin page (content-sized host) and a definite-height
 * container (constrained host). No network. Exit codes as browser-check.mjs:
 * 0 when every shape passes *or* no Chrome is installed (`SKIPPED`), 1 when a
 * shape fails or the browser cannot be driven.
 */
import esbuild from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./lib/headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = path.join(ROOT, "plugins", "kyoube-terminal");

/** The terminal options TerminalPage.tsx constructs xterm with. */
const TERMINAL_OPTIONS = { cursorBlink: true, fontSize: 13, scrollback: 5000, theme: { background: "#0b0f14" } };
/** How many fit → layout → fit rounds to run; the observer loop grows on every one. */
const FIT_ROUNDS = 30;

/**
 * Exactly what the UI bundle ships around the terminal: xterm, the fit addon
 * and the plugin's stylesheet injector, resolved from the plugin's own
 * node_modules so the versions under test are the pinned ones.
 */
async function bundleTerminal() {
  const result = await esbuild.build({
    stdin: {
      contents: [
        'import { Terminal } from "@xterm/xterm";',
        'import { FitAddon } from "@xterm/addon-fit";',
        'import { ensureXtermStyles } from "./src/ui/xterm-styles.ts";',
        "window.__kyoubeTerminal = { Terminal, FitAddon, ensureXtermStyles };",
      ].join("\n"),
      resolveDir: PLUGIN_DIR,
      loader: "ts",
    },
    absWorkingDir: PLUGIN_DIR,
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    target: ["es2022"],
    loader: { ".css": "text" },
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

/**
 * The page's own markup (TerminalPage.tsx: a flex column with a toolbar, the
 * host, and the two `<details>`), inside each ancestor chain under test.
 */
const PAGE = `
  <div style="display:flex;flex-direction:column;gap:12px;padding:16px;height:100%">
    <div style="height:28px">Terminal · No session</div>
    <div class="kyoube-terminal-host" id="host"></div>
    <details><summary>Sessions in this company</summary></details>
    <details><summary>Authenticate the agent harnesses</summary></details>
  </div>`;

const SHAPES = [
  {
    name: "upstream plugin page (content-sized host)",
    // Layout.tsx: <main class="flex-1 p-4 md:p-6 overflow-auto">; PluginPage.tsx:
    // <div class="space-y-4"><div class="min-h-(--sz-200px)">{page}</div></div>.
    // None of them has a definite height, so the page's h-full resolves to
    // auto and the host is as tall as whatever it contains.
    open: '<main style="height:753px;overflow:auto;padding:24px"><div><div style="min-height:200px">',
    close: "</div></div></main>",
  },
  {
    name: "definite-height container (constrained host)",
    // A container that does size the page: the host is a flex item that
    // shrinks to the room left, and the terminal has to fit inside it.
    open: '<div style="height:600px;display:flex;flex-direction:column">',
    close: "</div>",
  },
];

/** Runs after the bundle: opens the terminal the way the page does, fits repeatedly, reports. */
const CHECKER = `<script>(function () {
  var api = window.__kyoubeTerminal;
  var host = document.getElementById("host");
  var verdict;
  try {
    api.ensureXtermStyles();
    var term = new api.Terminal(${JSON.stringify(TERMINAL_OPTIONS)});
    var fit = new api.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    var before = host.getBoundingClientRect().height;
    var heights = [];
    var rows = [];
    var screens = [];
    for (var i = 0; i < ${FIT_ROUNDS}; i += 1) {
      fit.fit();
      void host.offsetHeight;
      heights.push(host.getBoundingClientRect().height);
      rows.push(term.rows);
      screens.push(host.querySelector(".xterm-screen").style.height);
    }
    var hostRect = host.getBoundingClientRect();
    var screen = host.querySelector(".xterm-screen").getBoundingClientRect();
    var style = getComputedStyle(host);
    verdict = {
      before: before,
      heights: heights,
      rows: rows,
      screens: screens,
      host: { top: hostRect.top, bottom: hostRect.bottom, paddingTop: parseFloat(style.paddingTop), paddingBottom: parseFloat(style.paddingBottom) },
      screen: { top: screen.top, bottom: screen.bottom },
    };
  } catch (error) {
    verdict = { error: String(error && error.stack || error) };
  }
  document.documentElement.setAttribute("data-kyoube-fit", JSON.stringify(verdict));
})();</script>`;

function pageFor(shape, bundle) {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>fit</title>",
    // Tailwind's preflight, as the Paperclip UI applies it to every element.
    "<style>*, ::before, ::after { box-sizing: border-box; } body { margin: 0; font-family: system-ui, sans-serif; }</style>",
    "</head><body>",
    shape.open,
    PAGE,
    shape.close,
    `<script>${bundle}</script>`,
    CHECKER,
    "</body></html>",
  ].join("\n");
}

/** The checker's verdict, read back off the attribute it set on `<html>`. */
function readVerdict(dom) {
  const match = /data-kyoube-fit="([^"]*)"/.exec(dom);
  if (!match) throw new Error("the checker script did not run (no data-kyoube-fit attribute in the dumped DOM)");
  const decoded = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return JSON.parse(decoded);
}

function summarise(values) {
  if (values.length <= 6) return values.join(", ");
  return `${values.slice(0, 3).join(", ")} … ${values.slice(-3).join(", ")}`;
}

function problemsFor(verdict) {
  if (verdict.error) return [`the checker threw: ${verdict.error}`];
  const problems = [];
  const moved = verdict.heights.filter((height) => Math.abs(height - verdict.before) > 0.5);
  if (moved.length > 0) {
    problems.push(
      `fitting changed the host's height: ${verdict.before}px before, then ${summarise(verdict.heights)}px ` +
      `(rows ${summarise(verdict.rows)})`,
    );
  }
  const contentTop = verdict.host.top + verdict.host.paddingTop;
  const contentBottom = verdict.host.bottom - verdict.host.paddingBottom;
  if (verdict.screen.top < contentTop - 0.5 || verdict.screen.bottom > contentBottom + 0.5) {
    problems.push(
      `the terminal screen (${verdict.screen.top}..${verdict.screen.bottom}px) does not lie inside the host's ` +
      `padding box (${contentTop}..${contentBottom}px): ${verdict.rows.at(-1)} rows for a ${verdict.screens.at(-1)} screen`,
    );
  }
  if (!(verdict.rows.at(-1) >= 1)) problems.push(`the terminal ended up with ${verdict.rows.at(-1)} rows`);
  return problems;
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("SKIPPED: no Chrome found (set CHROME_PATH to run the terminal fit check)");
    return 0;
  }
  console.log(`terminal-fit-check: ${chrome}`);
  const bundle = await bundleTerminal();
  const dir = await mkdtemp(path.join(tmpdir(), "kyoube-fit-check-"));
  const profile = await mkdtemp(path.join(tmpdir(), "kyoube-chrome-profile-"));
  let failures = 0;
  try {
    for (const [index, shape] of SHAPES.entries()) {
      const file = path.join(dir, `shape-${index}.html`);
      await writeFile(file, pageFor(shape, bundle), "utf8");
      let problems;
      try {
        problems = problemsFor(readVerdict(dumpDom(chrome, profile, file)));
      } catch (error) {
        problems = [error instanceof Error ? error.message : String(error)];
      }
      if (problems.length === 0) {
        console.log(`  ok    ${shape.name}`);
      } else {
        failures += 1;
        console.log(`  FAIL  ${shape.name}`);
        for (const problem of problems) console.log(`          ${problem}`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  console.log(failures === 0
    ? `terminal-fit-check: ${SHAPES.length} shapes, the terminal holds its size in all of them`
    : `terminal-fit-check: ${failures} of ${SHAPES.length} shapes failed`);
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
