#!/usr/bin/env node
/**
 * Proves the first-run wizard's escape hatch works in a real browser against
 * a running KyoubeAI: docker/core-patches adds "Skip for now" under an error
 * on the wizard's Connect step, and pressing it hires the agent without a
 * signed-in harness.
 *
 *   node scripts/onboarding-live-check.mjs <base-url> <email> <password> <board-token>
 *
 * It creates its own agentless company ("Onboarding Check"), whose dashboard
 * opens the wizard at the agent step; names the agent; picks the Claude
 * subscription tile and presses Connect, which fails on a fresh instance
 * (nobody is signed in, and the server runs in `authenticated` mode); then
 * presses Skip and expects the wizard's final step and the agent to exist.
 * Exit 0 on success, 1 on a failure, 2 when no Chrome is available.
 * Screenshots go to STUDIO_SHOTS_DIR when it is set.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Cdp, Page, launchChrome, signIn } from "./lib/cdp.mjs";
import { findChrome } from "./lib/headless-chrome.mjs";

const SKIP_LABEL = "Skip for now and connect the harness later from the Terminal page";
const AGENT_NAME = "Onboarding Check Agent";

const [baseArg, email, password, boardToken] = process.argv.slice(2);
const base = (baseArg ?? "").replace(/\/+$/, "");
const shotsDir = process.env.STUDIO_SHOTS_DIR || null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(pathname, { method = "GET", body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${boardToken}`, "Content-Type": "application/json", Origin: base },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${pathname}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

/** Clicks the first visible, enabled button in the wizard whose text is `label` (or starts with it, for a tile). */
function clickButton(label, { prefix = false } = {}) {
  return `(() => {
    const wizard = document.querySelector('[data-testid="onboarding-wizard"]');
    const matches = (text) => ${prefix ? "text.startsWith" : "text ==="}(${JSON.stringify(label)});
    const button = wizard && [...wizard.querySelectorAll("button")].find((b) => b.getClientRects().length > 0 && !b.disabled && matches(b.textContent.trim()));
    if (!button) return false;
    button.click();
    return true;
  })()`;
}

async function main() {
  if (!base || !email || !password || !boardToken) {
    console.log("usage: onboarding-live-check.mjs <base-url> <email> <password> <board-token>");
    return 1;
  }
  const chrome = findChrome();
  if (!chrome) {
    console.log("SKIPPED: no Chrome found (set CHROME_PATH to run the onboarding live check)");
    return 2;
  }
  const problems = [];
  const company = await api("/api/companies", { method: "POST", body: { name: "Onboarding Check" } });
  const { wsUrl, close } = await launchChrome(chrome);
  const cdp = await Cdp.connect(wsUrl);
  let page;
  try {
    page = await Page.open(cdp, { width: 1440, height: 900 });
    const cookie = await signIn(base, email, password);
    await page.setCookie({ ...cookie, url: base });
    if (shotsDir) await mkdir(shotsDir, { recursive: true });

    // An agentless company's dashboard opens the wizard at the agent step.
    await page.goto(`${base}/${company.issuePrefix}/dashboard`);
    await page.waitForFunction(`!!document.querySelector('[data-testid="onboarding-wizard"] input')`, { timeoutMs: 30_000 });
    await page.evaluate(`(() => {
      const input = [...document.querySelectorAll('[data-testid="onboarding-wizard"] input')].find((i) => i.getClientRects().length > 0);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(AGENT_NAME)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await page.waitForFunction(clickButton("Next"), { timeoutMs: 10_000 });
    // Connect a model: the Claude subscription tile, then Connect.
    await page.waitForFunction(clickButton("Claude", { prefix: true }), { timeoutMs: 15_000 });
    await sleep(1500);
    await page.waitForFunction(clickButton("Connect"), { timeoutMs: 15_000 });
    try {
      await page.waitForFunction(`[...document.querySelectorAll('[data-testid="onboarding-wizard"] button')].some((b) => b.textContent.trim() === ${JSON.stringify(SKIP_LABEL)})`, { timeoutMs: 45_000 });
    } catch {
      problems.push(`the Connect step showed no "${SKIP_LABEL}" control after the sign-in failed`);
    }
    if (shotsDir) await writeFile(path.join(shotsDir, "onboarding-connect.png"), await page.screenshot());
    if (problems.length === 0) {
      await page.waitForFunction(clickButton(SKIP_LABEL), { timeoutMs: 5_000 });
      try {
        await page.waitForFunction(`(document.querySelector('[data-testid="onboarding-wizard"]')?.innerText ?? "").includes("is ready to work")`, { timeoutMs: 45_000 });
      } catch {
        problems.push("pressing Skip did not reach the wizard's final step");
      }
      if (shotsDir) await writeFile(path.join(shotsDir, "onboarding-skipped.png"), await page.screenshot());
      const agents = await api(`/api/companies/${company.id}/agents`);
      const hired = agents.filter((agent) => agent.name === AGENT_NAME);
      if (hired.length !== 1) problems.push(`expected one agent named "${AGENT_NAME}" after the skip, found ${hired.length}`);
      else if (hired[0].adapterType !== "claude_local") problems.push(`the skipped hire used ${hired[0].adapterType}, not the chosen claude_local`);
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    if (page && shotsDir) await writeFile(path.join(shotsDir, "onboarding-failure.png"), await page.screenshot()).catch(() => {});
  } finally {
    cdp.close();
    await close();
  }
  if (problems.length === 0) {
    console.log(`onboarding-live-check: ${base} lets a new company skip the harness sign-in and still hire its first agent`);
    return 0;
  }
  console.log("onboarding-live-check: FAIL");
  for (const problem of problems) console.log(`  ${problem}`);
  return 1;
}

process.exit(await main());
