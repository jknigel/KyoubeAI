#!/usr/bin/env node
/**
 * Ruling P4-R22: ask a real browser where the app policy ends up.
 *
 * Everything else about `buildSrcdoc` is checked against the *string* it
 * produces (tests/unit/srcdoc.spec.ts), which can only ever assert what we
 * believe an HTML parser will do with those bytes — and the whole point of
 * ruling P3-R16 is that believing that is exactly the mistake. So each shape in
 * tests/fixtures/srcdoc-cases.ts is built with a stub SDK, written to a temp
 * file, and loaded in headless Chrome; a checker script appended after all app
 * content asks the browser's own DOM three things:
 *
 *   1. the Content-Security-Policy meta's parent element is HEAD (a meta the
 *      parser re-parented into the body governs nothing at all),
 *   2. it is the head's first element child, and no element in the document
 *      precedes it — so every app-authored node is parsed under the policy,
 *   3. the handshake nonce (ruling P4-R18) reached the SDK, and neither copy of
 *      it survived the SDK's install (ruling P4-R29): the global is gone and so
 *      is the `<script>` element that carried it, so app code can reach the
 *      nonce through neither `window` nor the DOM.
 *
 * No network: `--host-resolver-rules=MAP * ~NOTFOUND` fails every lookup, and
 * the policy under test blocks the fetch in the attacker fixtures regardless.
 *
 * Exit codes: 0 when every shape passes *or* no Chrome is installed (it prints
 * `SKIPPED: no Chrome found` and returns 0 — a developer without Chrome is not
 * a broken build), 1 when a shape fails or the browser cannot be driven.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { APP_CSP, buildSrcdoc, newAppNonce } from "../plugins/kyoube-apps/src/ui/apps/srcdoc.ts";
import { ALL_SRCDOC_CASES } from "../plugins/kyoube-apps/tests/fixtures/srcdoc-cases.ts";
import { dumpDom, findChrome } from "./lib/headless-chrome.mjs";

/**
 * Stands in for the real SDK bundle, which this script deliberately does not
 * build or import: what is under test is where the runner's head lands, not
 * what the SDK does once it is there. It does mirror what the SDK does at parse
 * time — read the nonce, delete the global, and remove the script element that
 * carried it, found the same way (`document.currentScript.previousElementSibling`
 * with its text checked) — so the browser gets to confirm both that a plain
 * `window.x = "…"` assignment really is deletable and that the element the SDK
 * looks for is the one the runner wrote.
 */
const STUB_SDK = `window.__kyoubeStub = (function () {
  var n = window.__kyoubeNonce;
  delete window.__kyoubeNonce;
  var self = document.currentScript;
  var previous = self ? self.previousElementSibling : null;
  var removable = !!previous && previous.tagName === "SCRIPT" && (previous.textContent || "").indexOf("window.__kyoubeNonce=") === 0;
  if (removable) previous.remove();
  return { sawNonce: typeof n === "string" && n.length >= 16, found: removable };
})();`;

/** Appended after every app-authored byte, so it sees the finished parse tree. */
const CHECKER = `<script>(function () {
  var metas = document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
  var meta = metas[0] || null;
  var head = document.head;
  var precede = [];
  if (meta) {
    var all = document.querySelectorAll("*");
    for (var i = 0; i < all.length; i += 1) {
      var el = all[i];
      if (el === meta || el === document.documentElement || el === head) continue;
      if (!(meta.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) precede.push(el.tagName);
    }
  }
  var nonceScripts = 0;
  var scripts = document.querySelectorAll("script");
  for (var j = 0; j < scripts.length; j += 1) {
    if ((scripts[j].textContent || "").indexOf("window.__kyoubeNonce=") === 0) nonceScripts += 1;
  }
  document.documentElement.setAttribute("data-kyoube-check", JSON.stringify({
    policies: metas.length,
    parent: meta && meta.parentElement ? meta.parentElement.tagName : null,
    firstInHead: !!meta && head.firstElementChild === meta,
    precede: precede,
    csp: meta ? meta.getAttribute("content") : null,
    stub: window.__kyoubeStub || null,
    nonceScripts: nonceScripts,
    nonceGlobal: "__kyoubeNonce" in window,
  }));
})();</script>`;

/** The checker's verdict, read back off the attribute it set on `<html>`. */
function readVerdict(dom) {
  const match = /data-kyoube-check="([^"]*)"/.exec(dom);
  if (!match) throw new Error("the checker script did not run (no data-kyoube-check attribute in the dumped DOM)");
  const decoded = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return JSON.parse(decoded);
}

function problemsFor(shape, verdict, dom, nonce) {
  const problems = [];
  if (verdict.policies !== 1) problems.push(`expected exactly one CSP meta, found ${verdict.policies}`);
  if (verdict.parent !== "HEAD") problems.push(`the CSP meta's parent is ${verdict.parent ?? "nothing"}, not HEAD`);
  if (!verdict.firstInHead) problems.push("the CSP meta is not the head's first element");
  if (verdict.precede.length > 0) problems.push(`elements parsed before the policy: ${verdict.precede.join(", ")}`);
  if (verdict.csp !== APP_CSP) problems.push(`the policy in the DOM is not the one we shipped: ${verdict.csp}`);
  if (!verdict.stub) problems.push("the SDK script did not run");
  else {
    if (!verdict.stub.sawNonce) problems.push("the SDK did not receive the handshake nonce");
    if (!verdict.stub.found) problems.push("the SDK did not find the nonce script where the placement contract says it is");
  }
  // Ruling P4-R29: after the SDK installs, app code can reach the nonce through
  // neither `window` nor the DOM.
  if (verdict.nonceGlobal) problems.push("the nonce global survived the SDK's delete — app code could read it");
  if (verdict.nonceScripts !== 0) problems.push(`the nonce script is still in the DOM (${verdict.nonceScripts} of them) — app code could read it back out`);
  // The value itself, not the shape of the assignment: this is the one check
  // that would still fail if the nonce leaked into some *other* node.
  if (dom.includes(nonce)) problems.push("the nonce's value is still somewhere in the serialised DOM");
  // The app's own content still has to be there, after the policy: a document
  // that lost it would pass every check above for the wrong reason.
  if (shape.marker !== null && !dom.includes(shape.marker)) problems.push(`the app's own content (${JSON.stringify(shape.marker)}) is missing from the DOM`);
  return problems;
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("SKIPPED: no Chrome found (set CHROME_PATH to run the app-policy browser check)");
    return 0;
  }
  console.log(`browser-check: ${chrome}`);
  const dir = await mkdtemp(path.join(tmpdir(), "kyoube-browser-check-"));
  const profile = await mkdtemp(path.join(tmpdir(), "kyoube-chrome-profile-"));
  let failures = 0;
  try {
    for (const [index, shape] of ALL_SRCDOC_CASES.entries()) {
      const file = path.join(dir, `case-${String(index).padStart(2, "0")}.html`);
      const nonce = newAppNonce();
      await writeFile(file, buildSrcdoc(shape.source, STUB_SDK, nonce) + CHECKER, "utf8");
      let problems;
      try {
        const dom = dumpDom(chrome, profile, file);
        problems = problemsFor(shape, readVerdict(dom), dom, nonce);
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
  const total = ALL_SRCDOC_CASES.length;
  console.log(failures === 0 ? `browser-check: ${total} app document shapes, all under the policy` : `browser-check: ${failures} of ${total} shapes failed`);
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
