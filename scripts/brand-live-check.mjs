#!/usr/bin/env node
/**
 * Loads a running stack's sign-in page (/auth) in headless Chrome and asks the
 * rendered DOM three things: the document title is the brand name, no visible
 * text says "Paperclip", and the lockup rendered with the brand as its label.
 * The React app renders client-side, so this is the one check that sees what
 * a person sees; curl-level checks live in scripts/smoke.sh.
 *
 *   node scripts/brand-live-check.mjs http://localhost:3199
 *
 * Exit 0 on pass, 1 on failure. With no Chrome installed it prints SKIPPED and
 * exits 2, which scripts/smoke.sh treats as a failure: CI runners have Chrome,
 * and a check that quietly skips is a check that stops running. An operator on
 * a machine without Chrome sets KYOUBE_ALLOW_NO_CHROME=1 to let the smoke pass
 * without it (or CHROME_PATH to point at one).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./lib/headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = (process.argv[2] ?? "http://localhost:3199").replace(/\/+$/, "");

function visibleText(dom) {
  return dom
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/g, " ");
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("SKIPPED: no Chrome found (set CHROME_PATH to run the brand live check)");
    return 2;
  }
  const brand = JSON.parse(await readFile(path.join(ROOT, "docker", "brand", "brand.json"), "utf8"));
  const profile = await mkdtemp(path.join(tmpdir(), "kyoube-brand-check-"));
  const problems = [];
  try {
    const dom = dumpDom(chrome, profile, `${base}/auth`, { virtualTimeBudgetMs: 10_000, network: true, windowSize: "1280,800" });
    if (!dom.includes(`<title>${brand.name}</title>`)) problems.push(`document title is not ${brand.name}`);
    const text = visibleText(dom);
    const leak = /.{0,40}Paperclip.{0,40}/.exec(text);
    if (leak) problems.push(`visible text still says Paperclip: "${leak[0].trim()}"`);
    if (!new RegExp(`aria-label="${brand.name}"`).test(dom)) problems.push("the sign-in lockup did not render with the brand as its label");
    if (!/Sign in to KyoubeAI|Create your KyoubeAI account/.test(text)) problems.push("the sign-in heading is not branded (is /auth still the sign-in route?)");
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  } finally {
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  if (problems.length === 0) {
    console.log(`brand-live-check: ${base}/auth is branded as ${brand.name}`);
    return 0;
  }
  console.log(`brand-live-check: FAIL`);
  for (const problem of problems) console.log(`  ${problem}`);
  return 1;
}

process.exitCode = await main();
