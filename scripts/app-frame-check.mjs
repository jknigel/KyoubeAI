#!/usr/bin/env node
/**
 * Asks a real browser whether the Apps page's frame fills the room under it
 * without making the page scroll.
 *
 * The app runs in an `<iframe>` at the bottom of the Apps page. Upstream's
 * plugin page gives that frame nothing to fill: `Layout.tsx` puts the page in
 * `<main class="flex-1 p-4 md:p-6 overflow-auto">`, `PluginPage.tsx` wraps it in
 * `<div class="space-y-4"><div class="min-h-(--sz-200px)">`, and none of those
 * boxes has a definite height, so a percentage height on the frame resolves to
 * `auto` — and the plugin's UI bundle ships no stylesheet of its own, so a
 * Tailwind class upstream never compiled (`min-h-[600px]`) does nothing at all.
 * The frame ended up at the browser's default 150px: "so tiny".
 *
 * `frame-height.ts` sizes the frame from measurements instead: it finds the
 * nearest scrolling ancestor (upstream's `main` on desktop; the page itself on
 * mobile, where `main` is `overflow-visible` and `body` scrolls), and gives the
 * frame exactly the room between its top edge and that container's content
 * box, so the container never has to scroll — down to a floor, below which the
 * page scrolls rather than the app being squashed.
 *
 * No unit test can see this — it is layout, and the measurements come from
 * `getBoundingClientRect`/`clientHeight`. So each shape below builds the DOM
 * chain the plugin's page actually lands in (upstream `Layout.tsx` +
 * `PluginPage.tsx` at 2026.831.1, desktop and mobile), runs the plugin's own
 * sizing code against it, and asks the browser:
 *
 *   1. the scroll container has nothing to scroll (`scrollHeight <= clientHeight`);
 *   2. the frame's bottom edge, plus the padding that follows it, lands on the
 *      container's content-box bottom — as large as possible, not just large;
 *   3. where the container is too short for the floor, the frame holds the
 *      floor and the container scrolls instead;
 *   4. when a sibling above the frame grows after mount (the source panel
 *      opening), the observers shrink the frame to match.
 *
 * The pages load over CDP (scripts/lib/cdp.mjs), not `--dump-dom`. Shape 4
 * depends on ResizeObserver, whose callbacks are delivered only when the
 * browser renders a frame, and `--dump-dom` under a virtual-time budget runs
 * the page's timers without reliably rendering any: the observers fired or
 * not by chance, and the shape failed on CI for commits that never touched it.
 *
 * No network. Exit codes as browser-check.mjs: 0 when every shape passes *or*
 * no Chrome is installed (`SKIPPED`), 1 when a shape fails or the browser
 * cannot be driven.
 */
import esbuild from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Cdp, Page, launchChrome } from "./lib/cdp.mjs";
import { findChrome } from "./lib/headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = path.join(ROOT, "plugins", "kyoube-apps");

/**
 * What an `<iframe>` with no height of its own measures — the defect: the
 * browser's default 150px content box plus the 1px border AppRunner puts on
 * each edge.
 */
const DEFAULT_IFRAME_HEIGHT = 150 + 2;
/** How much the sibling above the frame grows in the observer shape. */
const GROWTH = 200;
/** The viewport for shapes that do not set their own; the desktop shells are at most 1000px tall. */
const DESKTOP_WINDOW = "1440,1000";

/** Exactly the sizing code the UI bundle ships, resolved from the plugin's own source. */
async function bundleFrameSizing() {
  const result = await esbuild.build({
    stdin: {
      contents: [
        'import { fitFrame, keepFrameFitted, scrollContainerOf, MIN_FRAME_HEIGHT } from "./src/ui/apps/frame-height.ts";',
        "window.__kyoubeFrame = { fitFrame, keepFrameFitted, scrollContainerOf, MIN_FRAME_HEIGHT };",
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
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

/**
 * The Runner's own markup (AppsPage.tsx): a flex column with 16px padding and
 * an 8px gap holding the toolbar, an optional panel above the frame (the
 * source panel, an error line) and the frame itself, last. The frame carries
 * what AppRunner.tsx puts on it: block display, full width, a 1px border.
 */
function page({ panelHeight = 0 } = {}) {
  return `
  <div style="display:flex;flex-direction:column;gap:8px;padding:16px;height:100%">
    <div style="height:28px">← Apps · crm</div>
    <div id="panel" style="height:${panelHeight}px"></div>
    <iframe id="frame" title="Kyoube app" style="display:block;width:100%;border:1px solid #888;box-sizing:border-box"></iframe>
  </div>`;
}

/** PluginPage.tsx around the page slot. `min-h-(--sz-200px)` is not in upstream's compiled CSS, so the inner div is plain. */
const PLUGIN_PAGE_OPEN = '<div class="space-y-4"><div>';
const PLUGIN_PAGE_CLOSE = "</div></div>";

/**
 * Layout.tsx on desktop: `flex h-dvh flex-col overflow-clip` root, a
 * `min-h-0 flex-1 flex` row of sidebar + content column, the header, then a
 * `flex flex-1 min-h-0` row holding `<main class="flex-1 p-4 md:p-6 overflow-auto">`.
 * `shell` stands in for `100dvh`.
 */
function desktopShell(shell) {
  return {
    open: `<div style="display:flex;flex-direction:column;height:${shell}px;overflow:clip">
      <div style="display:flex;flex:1;min-height:0;overflow:clip">
        <div style="width:240px;flex-shrink:0"></div>
        <div style="display:flex;flex-direction:column;min-width:0;height:100%;flex:1">
          <div style="height:57px">header</div>
          <div style="display:flex;flex:1;min-height:0">
            <main id="main" style="flex:1;padding:24px;overflow:auto;scrollbar-gutter:stable">${PLUGIN_PAGE_OPEN}`,
    close: `${PLUGIN_PAGE_CLOSE}</main></div></div></div></div>`,
    body: "clip",
  };
}

/**
 * Layout.tsx on mobile: `min-h-dvh` block root, a sticky header, and
 * `<main class="flex-1 p-4 overflow-visible pb-(--sz-calc-14)">` — `body`
 * scrolls, `main` does not. The viewport is the container here.
 */
const MOBILE_SHELL = {
  open: `<div style="min-height:100dvh">
    <div style="width:100%">
      <div style="display:flex;flex-direction:column;min-width:0;width:100%">
        <div style="position:sticky;top:0;height:57px">header</div>
        <div style="display:block">
          <main id="main" style="flex:1;padding:16px 16px 56px;overflow:visible">${PLUGIN_PAGE_OPEN}`,
  close: `${PLUGIN_PAGE_CLOSE}</main></div></div></div></div>`,
  body: "visible",
};

const SHAPES = [
  {
    name: "desktop: the frame meets main's content box, main does not scroll",
    shell: desktopShell(800),
    page: page(),
    trailing: 16, // the Runner's bottom padding
  },
  {
    name: "desktop with the source panel open: the frame gives up the room and main still does not scroll",
    shell: desktopShell(1000),
    page: page({ panelHeight: 420 }),
    trailing: 16,
  },
  {
    name: "desktop, short window: the frame holds its floor and main scrolls instead",
    shell: desktopShell(500),
    page: page(),
    trailing: 16,
    expectFloor: true,
  },
  {
    name: "mobile: body scrolls, the frame meets the viewport bottom through main's padding",
    shell: MOBILE_SHELL,
    page: page(),
    trailing: 16 + 56, // the Runner's bottom padding, then main's pb-(--sz-calc-14)
    windowSize: "412,915", // a phone; the viewport is the container here, so its size is the test's
  },
  {
    name: "desktop, a sibling grows after mount: the observers shrink the frame",
    shell: desktopShell(1000),
    page: page(),
    trailing: 16,
    grow: true,
  },
];

/** Runs after the bundle: sizes the frame the way AppRunner does on mount, then reports what the browser laid out. */
function checkerFor(shape) {
  return `<script>(function () {
  var api = window.__kyoubeFrame;
  var frame = document.getElementById("frame");
  var verdict;
  function measure() {
    var container = api.scrollContainerOf(frame);
    var scroller = container || document.documentElement;
    var rect = frame.getBoundingClientRect();
    var contentBottom;
    if (container) {
      var style = getComputedStyle(container);
      contentBottom = container.getBoundingClientRect().top + container.clientTop + container.clientHeight - parseFloat(style.paddingBottom);
    } else {
      contentBottom = document.documentElement.clientHeight;
    }
    return {
      container: container ? container.tagName.toLowerCase() : "viewport",
      frame: { top: rect.top, bottom: rect.bottom, height: rect.height, styleHeight: frame.style.height },
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      contentBottom: contentBottom,
    };
  }
  function finish(extra) {
    document.documentElement.setAttribute("data-kyoube-frame", JSON.stringify(Object.assign(verdict, extra || {})));
  }
  try {
    document.body.style.overflow = ${JSON.stringify(shape.shell.body)};
    var before = frame.getBoundingClientRect().height;
    var dispose = ${shape.grow ? "api.keepFrameFitted(frame)" : "(api.fitFrame(frame), null)"};
    void frame.offsetHeight;
    verdict = { before: before, minHeight: api.MIN_FRAME_HEIGHT, fitted: measure() };
    ${shape.grow ? `
    document.getElementById("panel").style.height = "${GROWTH}px";
    setTimeout(function () { finish({ afterGrow: measure() }); if (dispose) dispose(); }, 200);
    return;` : ""}
    finish();
  } catch (error) {
    verdict = { error: String(error && error.stack || error) };
    finish();
  }
})();</script>`;
}

function pageFor(shape, bundle) {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>frame</title>",
    // Tailwind's preflight, as the Paperclip UI applies it to every element.
    "<style>*, ::before, ::after { box-sizing: border-box; } html, body { margin: 0; font-family: system-ui, sans-serif; }</style>",
    "</head><body>",
    shape.shell.open,
    shape.page,
    shape.shell.close,
    `<script>${bundle}</script>`,
    checkerFor(shape),
    "</body></html>",
  ].join("\n");
}

/** The checker's verdict, read back off the attribute it set on `<html>`. */
/** Loads `file` in `page` at `windowSize` ("width,height") and waits for the checker's verdict. */
async function readVerdict(page, file, windowSize) {
  const [width, height] = windowSize.split(",").map(Number);
  await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await page.goto(`file://${file.replace(/\\/g, "/")}`, { settleMs: 0 });
  const raw = await page.waitForFunction("document.documentElement.getAttribute('data-kyoube-frame')", { timeoutMs: 10_000 })
    .catch(() => null);
  if (!raw) throw new Error("the checker script did not run (no data-kyoube-frame attribute on the page)");
  return JSON.parse(raw);
}

const px = (value) => `${Math.round(value * 100) / 100}px`;

/** What one laid-out state has to satisfy; `label` names it in the report. */
function problemsForState(state, shape, label) {
  const problems = [];
  const scrolls = state.scrollHeight > state.clientHeight;
  const floored = Math.abs(state.frame.height - shape.minHeight) <= 1;
  if (shape.expectFloor) {
    if (!floored) problems.push(`${label}: expected the frame to hold its ${shape.minHeight}px floor, got ${px(state.frame.height)}`);
    if (!scrolls) problems.push(`${label}: expected the too-short ${state.container} to scroll, but scrollHeight ${state.scrollHeight} <= clientHeight ${state.clientHeight}`);
    return problems;
  }
  if (scrolls) {
    problems.push(`${label}: the ${state.container} scrolls — scrollHeight ${state.scrollHeight} > clientHeight ${state.clientHeight} (frame ${px(state.frame.height)})`);
  }
  const gap = state.contentBottom - (state.frame.bottom + shape.trailing);
  if (Math.abs(gap) > 1) {
    problems.push(`${label}: the frame's bottom (${px(state.frame.bottom)} + ${shape.trailing}px after it) misses the ${state.container}'s content bottom (${px(state.contentBottom)}) by ${px(gap)}`);
  }
  return problems;
}

function problemsFor(verdict, shape) {
  if (verdict.error) return [`the checker threw: ${verdict.error}`];
  const problems = [];
  if (Math.abs(verdict.before - DEFAULT_IFRAME_HEIGHT) > 1) {
    problems.push(`the harness no longer reproduces the defect: the unsized frame was ${px(verdict.before)}, not the browser's ${DEFAULT_IFRAME_HEIGHT}px`);
  }
  const expectations = { ...shape, minHeight: verdict.minHeight };
  problems.push(...problemsForState(verdict.fitted, expectations, "after mount"));
  if (shape.grow) {
    if (!verdict.afterGrow) {
      problems.push("the observer shape never reported its second measurement");
    } else {
      problems.push(...problemsForState(verdict.afterGrow, expectations, `after the sibling grew ${GROWTH}px`));
      const shrunk = verdict.fitted.frame.height - verdict.afterGrow.frame.height;
      if (Math.abs(shrunk - GROWTH) > 1) {
        problems.push(`after the sibling grew ${GROWTH}px the frame shrank ${px(shrunk)} (${px(verdict.fitted.frame.height)} → ${px(verdict.afterGrow.frame.height)})`);
      }
    }
  }
  return problems;
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("SKIPPED: no Chrome found (set CHROME_PATH to run the app frame check)");
    return 0;
  }
  console.log(`app-frame-check: ${chrome}`);
  const bundle = await bundleFrameSizing();
  const dir = await mkdtemp(path.join(tmpdir(), "kyoube-frame-check-"));
  let browser;
  let cdp;
  let failures = 0;
  try {
    browser = await launchChrome(chrome, { windowSize: DESKTOP_WINDOW });
    cdp = await Cdp.connect(browser.wsUrl);
    const page = await Page.open(cdp);
    for (const [index, shape] of SHAPES.entries()) {
      const file = path.join(dir, `shape-${index}.html`);
      await writeFile(file, pageFor(shape, bundle), "utf8");
      let problems;
      let verdict;
      try {
        verdict = await readVerdict(page, file, shape.windowSize ?? DESKTOP_WINDOW);
        problems = problemsFor(verdict, shape);
      } catch (error) {
        problems = [error instanceof Error ? error.message : String(error)];
      }
      const sized = verdict?.fitted ? ` (${px(verdict.before)} → ${px(verdict.fitted.frame.height)}${verdict.afterGrow ? ` → ${px(verdict.afterGrow.frame.height)}` : ""})` : "";
      if (problems.length === 0) {
        console.log(`  ok    ${shape.name}${sized}`);
      } else {
        failures += 1;
        console.log(`  FAIL  ${shape.name}${sized}`);
        for (const problem of problems) console.log(`          ${problem}`);
      }
    }
  } finally {
    cdp?.close();
    await browser?.close();
    await rm(dir, { recursive: true, force: true });
  }
  console.log(failures === 0
    ? `app-frame-check: ${SHAPES.length} shapes, the frame fills the page without scrolling it in all of them`
    : `app-frame-check: ${failures} of ${SHAPES.length} shapes failed`);
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
