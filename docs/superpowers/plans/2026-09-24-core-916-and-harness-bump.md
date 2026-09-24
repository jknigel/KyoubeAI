# Core 2026.916.1 and Harness Bump Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move KyoubeAI onto Paperclip core 2026.916.1 (image and plugin SDK) with the newest Claude Code, pi and Hermes, keep the Studio design, the rebrand and the onboarding escape hatch working on it, and prepare KyoubeAI 1.3.0 on the branch without deploying it anywhere.

**Architecture:** The image stays a Dockerfile `FROM` the pinned core image, with three build-time transforms (`docker/core-patches`, `docker/theme`, `docker/rebrand`) and four plugins. Core 2026.916.1 makes a new "streamlined" sidebar the default, rebuilds the agent page and the first-run wizard, renames the core's Apps area to Connectors and moves the pi transcript parser into a code-split chunk. Each transform is re-targeted at the new bundle and keeps its exact-match build-time checks; the Studio plugin follows the new agent routes and header; the smoke test gains a live check of the onboarding skip.

**Tech Stack:** Docker (BuildKit), Node 24 ESM build scripts, TypeScript + React 19 plugins on `@paperclipai/plugin-sdk`, Vitest, pnpm workspaces, headless Chrome over CDP for live checks.

**Spec:** There is no separate design document. The request (2026-09-24): "Update the Claude, Pi and Hermes Agent harnesses to the latest versions. Update Paperclip to the latest upstream version as well." Standing instructions from the same session: the Studio redesign must survive upstream updates, and nothing is deployed to any instance. The research behind every change is in **Findings** below; each finding was reproduced against the real `ghcr.io/paperclipai/paperclip:2026.916.1` image, and every code block in this plan was run against it (unit tests, the build-time transforms, and a full `scripts/smoke.sh`).

## Findings (verified 2026-09-24)

1. **Latest releases.** Core and plugin SDK 2026.916.1 (stable; `beta` is 2026.921.0-beta.1). Claude Code 2.1.281 (the core image bundles 2.1.278). pi 0.87.1. Hermes release `v2026.9.21` = commit `d337b736aa1e8ebecfab043842d13e4a2d2f48a3`, installer sha256 `00f9080c6452bf87f03ef2fffb4b2c23b9f43f946aaae956e4c547d17e310b22`, `hermes --version` 0.21.4. `pi --version` prints `0.87.1` and `claude --version` prints `2.1.281 (Claude Code)`, which is what the Dockerfile asserts.
2. **The SDK bump alone is clean.** With only the pins changed, all four plugins typecheck, build and pass their tests.
3. **Fixed upstream:** the Instructions tab's "Discard unsaved agent configuration changes?" loop (#12502). The README's workaround goes.
4. **Not fixed upstream:** pi still turns every `message_end` (the wake prompt, tool results) into agent text. The parser now lives in a code-split chunk (`AiConnectionCredentialStep-*.js`), so the patch's file glob widens to `ui/dist/assets/*.js`; its pattern is unchanged.
5. **The onboarding skip is still needed and was rebuilt.** The new wizard's **Connect a model** step offers Claude/OpenAI subscription tiles and "Use API key instead". In `authenticated` mode (KyoubeAI's) a subscription cannot be finished: the server's `assertLocalOperator` answers "Only the local operator can connect this machine's CLI account." to anyone but the implicit operator of a `local_trusted` instance. The wizard has no close button and re-opens for an agentless company, so a subscription user is stuck exactly as before. Four new patches add **Skip for now and connect the harness later from the Terminal page**; walked live, the skip hires the agent and the wizard reaches "… is ready to work!". The old two patches no longer match anything.
6. **The streamlined shell is the default** (`enableStreamlinedUi` is on unless an instance turns it off). Its sidebar: New Task, Search, Dashboard, Inbox; **Work** (Tasks, Projects, Routines, Artifacts, plugin slots); a new **Org** section (Agents, Skills, Connectors, Audit); Recent tasks. There is no agent list and no Organization section. The Studio skin already lands (search field, New task, Build, Team, Workspace, Home); only the Org section leaks, so one gated rule hides it. The legacy-shell rules and checks go.
7. **Connectors.** Upstream now calls its outside-tools area Connectors in the sidebar, page title and most breadcrumbs, which already keeps "Apps" for KyoubeAI's Apps. Only three access-profile breadcrumbs still say "Apps". The eleven Connections rules no longer match (one would now rename an unrelated gateway heading), so they are replaced by one Connectors rule. **This changes the name decided for 1.2.0 ("Connections") to upstream's "Connectors";** see the note to the reviewer at the end.
8. **The agent page was rebuilt.** A contextual sidebar replaces the tabs; the default view is `overview` (`/agents/<ref>/overview`, and the bare URL redirects there); the header avatar is `<div role="img" aria-label="<name> avatar">`; every view renders inside `.agent-settings-content agent-settings-<view>`. Runs, costs and budgets moved under Audit (`/activity/runs?agentId=…`); `/org` redirects to `/agents/all` (the org chart is a view there); `/timeline` and `/costs` redirect under `/activity`.
9. **Dark cards.** The core now sets `--card` equal to `--background` in dark mode and paints the agent overview's sections with `--card`. KyoubeAI's cards are a step lighter, so the borderless sections sat in grey bands; one ungated rule fixes that.
10. **Rebrand sweep.** New upstream development material (`announcements/`, `ui/connect-flow-preview.html`, `ui/connect-model-preview.html`, the root `.env.example`) needs allowlisting. After that: `residual 0`, code-shaped 0, and the smoke's "no display-text Paperclip in the main bundle" grep passes.
11. **Announcements** are on by default and fetched from `pages.paperclip.ing` (Paperclip's product news). The compose file turns them off.
12. **`X-Forwarded-Host`** is only believed from a peer that `TRUST_PROXY` trusts. The compose file passes `TRUST_PROXY` through; `uniquelocal` covers a proxy or tunnel container on the same Docker network.
13. **49 migrations** (`0231`–`0279`) run on first start: back up first.
14. **Unchanged, re-verified:** the plugin stream bridge still answers 501; the server still passes `hostVersion` `0.0.0` to plugins; plugin tools still reach a run only through an MCP gateway created for agents with a connection; project read access is unchanged; `ui/src/plugins/bridge.ts`, `ui/src/pages/PluginPage.tsx` and `ui/src/plugins/slots.tsx` are identical; upstream's `docker-entrypoint.sh`, `CMD` and `ENTRYPOINT` are identical; the board API routes Studio calls (pause, resume, create issue) and `adapterConfig.paperclipSkillSync` are unchanged; the dashboard's structure (widget slot, live-runs heading, `/costs` metric link) is unchanged.

## Global Constraints

- Versions, exactly: `KYOUBE_CORE_VERSION=2026.916.1`; `@paperclipai/plugin-sdk` `2026.916.1`; `CLAUDE_CODE_VERSION=2.1.281`; `PI_VERSION=0.87.1`; `HERMES_COMMIT=d337b736aa1e8ebecfab043842d13e4a2d2f48a3`; `HERMES_INSTALLER_SHA256=00f9080c6452bf87f03ef2fffb4b2c23b9f43f946aaae956e4c547d17e310b22`; `HERMES_VERSION=0.21.4`.
- Release numbers: KyoubeAI `1.3.0`; `kyoube.studio` `0.2.0`. Other plugins keep their versions.
- Work on branch `chore/core-and-harness-bump` only. Commit locally at the end of each task. Never push, merge, tag or publish without the user's explicit request.
- Never deploy. Do not touch the `bap-ai-os` compose project or its containers (`bap-ai-os-app-1`, `bap-ai-os-db-1`), `/home/ajknigel/BAP-AI-OS`, or the `kyoube-studio` preview stack, and never retag `kyoubeai:dev`. The smoke test uses its own project (`kyoube-smoke`, port 3199, image `kyoubeai:smoke`) and removes it when it ends.
- Core patches and theme text rules match exactly their declared `expect`. Never relax a count to make a build pass.
- `docker/theme` changes presentation only. Every rule that hides or moves core UI stays gated on Studio (`theme.spec.mjs` lints this).
- The core's outside-tools area is "Connectors"; "Apps" means KyoubeAI's own Apps.
- Docs keep the repository's voice: plain sentences, what changed for someone running KyoubeAI.

## Review Focus

1. **Agent names with quotes, backslashes or line breaks** must not break the avatar rule's attribute selector. Task 5's `cssString` test pins it.
2. **Every agent URL people have**: bare, `/overview`, the pre-2026.916 `/dashboard` (old bookmarks and Studio links), a trailing slash, `?classic=1`, and every other view. Task 5's redirect test pins each one.
3. **The onboarding skip fires only from the new button** (an explicit `true`), never from a click event or the normal Connect button, and leaves the API-key path alone. Task 2's tests run the patched code for each case; Task 8's live check proves the button against a real build, and fails against an unpatched core.
4. **Deployments behind a reverse proxy or tunnel** now need `TRUST_PROXY`. Task 7 passes it through compose, checks the rendered compose config, and Task 9 documents it.
5. **With the Studio plugin disabled the whole stock sidebar returns**, including the new Org section. Task 8's live check disables `kyoube.studio` and waits for the Org section's Audit link.

---

## File map

| File | Change | Task |
|---|---|---|
| `docker/Dockerfile`, `.env.example`, `scripts/smoke.env`, `docker-compose.yml`, `plugins/*/package.json`, `pnpm-lock.yaml` | core and SDK pins (by `scripts/bump-core.sh`) | 1 |
| `docker/core-patches/patches.mjs`, `tests/patches.spec.mjs` | pi glob; four new onboarding patches replace two | 2 |
| `docker/theme/rules.mjs`, `anchors.mjs`, `theme.css`, `tests/theme.spec.mjs`, `tests/fixtures/core-2026.916.1.mjs` (new), `tests/fixtures/core-2026.831.1.mjs` (deleted); `plugins/kyoube-studio/tests/links.spec.ts` | streamlined shell, Connectors, agent page | 3 |
| `docker/rebrand/lib/files.mjs`, `tests/rebrand.spec.mjs` | sweep allowlist | 4 |
| `plugins/kyoube-studio/src/ui/agent-route.ts`, `links.ts`, `nav.tsx`, `Home.tsx`, `Profile.tsx`, `src/profile.ts`, `src/manifest.ts`, `package.json`, tests | agent routes and header, canonical links, 0.2.0 | 5 |
| `docker/Dockerfile` | harness versions | 6 |
| `docker-compose.yml`, `.env.example` | announcements off, `TRUST_PROXY` | 7 |
| `scripts/smoke.sh`, `scripts/studio-live-check.mjs`, `scripts/onboarding-live-check.mjs` (new), `scripts/migrate-from-0.1.sh` | live checks for 916; the legacy-path count the new check exposed | 8 |
| `README.md`, `CHANGELOG.md`, `package.json`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/{theme,upgrading,branding,architecture,governance,apps}.md`, plugin manifest comments | docs and 1.3.0 | 9 |

---

### Task 1: Pin the core image and plugin SDK to 2026.916.1

**Files:**
- Modify (by script): `docker/Dockerfile:2`, `.env.example:21`, `scripts/smoke.env`, `docker-compose.yml` (`PAPERCLIP_VERSION` default), `plugins/*/package.json`, `pnpm-lock.yaml`
- Add: `docs/superpowers/plans/2026-09-24-core-916-and-harness-bump.md` (this plan) and its row in `docs/superpowers/plans/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the pin every later task builds on; `scripts/check-pins.sh` prints `pins consistent: 2026.916.1`.

- [ ] **Step 1: Make sure the core image is local**

```bash
docker image inspect ghcr.io/paperclipai/paperclip:2026.916.1 >/dev/null 2>&1 \
  || docker pull ghcr.io/paperclipai/paperclip:2026.916.1
docker image inspect ghcr.io/paperclipai/paperclip:2026.916.1 --format '{{.Id}}'
```

Expected: an image id. If `docker pull` keeps printing "Retrying in N seconds" for the same layers, use the recipe in **Appendix A** and run this step again.

- [ ] **Step 2: Bump every pin with the repository's script**

```bash
bash scripts/bump-core.sh 2026.916.1
```

Expected, at the end: `pins consistent: 2026.916.1` and `Bumped the core pins to 2026.916.1.`

- [ ] **Step 3: Confirm nothing else still pins the old core**

```bash
grep -n "2026.831.1" docker/Dockerfile .env.example scripts/smoke.env docker-compose.yml plugins/*/package.json
```

Expected: no output.

- [ ] **Step 4: Run the type check and the unit tests**

```bash
pnpm -r typecheck && pnpm -r test
```

Expected: every package passes. (The transforms' tests still use 2026.831.1 fixtures until Tasks 2–4; the image does not build yet.)

- [ ] **Step 5: Add this plan to the plans index**

````bash
git apply <<'PATCH'
diff --git a/docs/superpowers/plans/README.md b/docs/superpowers/plans/README.md
index 498aa0f..1445c3e 100644
--- a/docs/superpowers/plans/README.md
+++ b/docs/superpowers/plans/README.md
@@ -10,6 +10,7 @@ Execute in order; each phase ends with working, tested software and its own exit
 | 3 | [Apps](2026-09-05-phase-3-apps.md) | Sandboxed single-file apps over the data layer: storage, `window.kyoube` SDK, runner, tools, skill | 2 |
 | 4 | [Hardening & release](2026-09-05-phase-4-hardening-release.md) | GHCR images, pin lock-step tooling, weekly upstream canary, backups, security/governance docs, 1.0.0 | 0–3 |
 | 5 | [White-label](2026-09-13-white-label.md) | Build-time brand transform, home/database rename, KYOUBE_* keys, 0.1.x migration, 0.2.0 | 0–4 |
+| 6 | [Core 2026.916.1 and harness bump](2026-09-24-core-916-and-harness-bump.md) | Core and SDK 2026.916.1, Claude Code 2.1.281, pi 0.87.1, Hermes 0.21.4; transforms and Studio re-targeted at the streamlined shell; 1.3.0 | 0–5 |
 
 Plan 5 implements `../specs/2026-09-13-white-label-design.md`.
 
PATCH
````

- [ ] **Step 6: Commit**

```bash
git add docker/Dockerfile .env.example scripts/smoke.env docker-compose.yml plugins/*/package.json pnpm-lock.yaml \
  docs/superpowers/plans/2026-09-24-core-916-and-harness-bump.md docs/superpowers/plans/README.md
git commit -F - <<'MSG'
chore(core): pin the core image and plugin SDK to 2026.916.1
MSG
```

---

### Task 2: Core patches for 2026.916.1

**Files:**
- Modify: `docker/core-patches/patches.mjs` (whole file)
- Test: `docker/core-patches/tests/patches.spec.mjs` (whole file)

**Interfaces:**
- Consumes: `applyPatches(root, patches, { dryRun })`, `applyToText(text, patch)` and `expandGlob(root, glob)` from `docker/core-patches/lib.mjs` (unchanged).
- Produces: `PATCHES` with ids `pi-transcript-non-assistant-messages`, `onboarding-skip-harness-primary`, `onboarding-skip-harness-login`, `onboarding-skip-harness-gate`, `onboarding-skip-harness-button`; `SKIP_HARNESS_LABEL = "Skip for now and connect the harness later from the Terminal page"` (Task 8's live check clicks this exact text). `SKIP_HARNESS_MESSAGE` is removed.

- [ ] **Step 1: Write the failing tests**

Replace `docker/core-patches/tests/patches.spec.mjs` with:

````js
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatches, applyToText, expandGlob } from "../lib.mjs";
import { PATCHES, SKIP_HARNESS_LABEL } from "../patches.mjs";

// Excerpts of core 2026.916.1's minified UI, copied verbatim. The pi parser
// lives in a code-split chunk (AiConnectionCredentialStep-DHV6zd1f.js); the
// onboarding wizard in the main bundle (index-5zyW-AFc.js).

// The message_update / message_end / tool_execution_start branches of the pi
// transcript parser, so the pattern is proven to anchor on message_end alone.
const PI_HANDLER_2026_916_1 =
  'if(r==="message_start")return[];if(r==="message_update"){const s=hn(n.assistantMessageEvent);if(s){const o=tt(s.type);if(o==="thinking_delta"){const a=tt(s.delta);if(a)return[{kind:"thinking",ts:t,text:a,delta:!0}]}if(o==="text_delta"){const a=tt(s.delta);if(a)return[{kind:"assistant",ts:t,text:a,delta:!0}]}if(o==="thinking_end"){const a=tt(s.content);if(a)return[{kind:"thinking",ts:t,text:a}]}if(o==="text_end"){const a=tt(s.content);if(a)return[{kind:"assistant",ts:t,text:a}]}}return[]}' +
  'if(r==="message_end"){const s=hn(n.message);if(s){const o=s.content,{text:a,thinking:l}=gn(o),c=[];return l&&c.push({kind:"thinking",ts:t,text:l}),a&&c.push({kind:"assistant",ts:t,text:a}),c}return[]}' +
  'if(r==="tool_execution_start"){return[{kind:"tool_call",ts:t,name:"x"}]}';

// The Connect step's primary action (`handleConnectStepPrimary`).
const CONNECT_PRIMARY_2026_916_1 =
  'function pn(){if(Je==="ready"&&Ft){It&&window.open(It,"_blank","noreferrer,noopener"),qe("waiting");return}Je!=="connecting"&&(zs||ma())}';

// The subscription sign-in inside the hire handler (`handleGiveHeartbeat`, `ma`).
const LOCAL_LOGIN_2026_916_1 =
  'if(Le!=="api"&&vr&&gt&&!lt()&&!bt&&!Oe.storedLogin.data){if(await qn.connect(),!es())return;ze.current={companyId:$e,binding:{provider:gt,method:"subscription",mode:"responsible_user"}}}';

// The environment-test gate further down the same handler.
const ENV_GATE_2026_916_1 =
  'if(ct){const pr=(De&&Wt.current===yr&&!sH(De)?De:null)??await wn(Sa,yr,es);if(!pr||!es())return;if(sH(pr)){P(pr.status==="fail"?"The environment test failed. Fix the reported checks before you hire this agent.":"No working authentication was found. Fix the reported checks before you hire this agent.");return}}';

// The wizard's error line followed by its footer navigation: two array
// children of the step body.
const ERROR_AND_FOOTER_2026_916_1 =
  'tn&&(0,t.jsx)("div",{className:"mt-3",children:(0,t.jsx)("p",{className:"text-xs text-destructive",children:tn})}),' +
  '(Y||_===1)&&(0,t.jsx)(Pwe,{onBack:_===4&&Je!=="idle"?Vs:Mze({currentStep:_,entryStep:S})?()=>I(Ha(_)):void 0,primaryLabel:_===1?"Continue":_===5?"Get started":_===4?Hn.label:"Next",primaryIcon:_===4?Hn.icon:void 0,loadingLabel:_===1?"Creating...":_===4?"Connecting":"Launching...",loading:_===3||_===4?!1:B,primaryDisabled:_===1?!M.trim()||B:_===3?!H.trim():_===4?Hn.disabled||B:B||en,onPrimary:()=>{_===1?kr():_===3?I(4):_===4?pn():Gn()}})';

const patch = (id) => PATCHES.find((entry) => entry.id === id);
const piPatch = patch("pi-transcript-non-assistant-messages");
const primaryPatch = patch("onboarding-skip-harness-primary");
const loginPatch = patch("onboarding-skip-harness-login");
const gatePatch = patch("onboarding-skip-harness-gate");
const buttonPatch = patch("onboarding-skip-harness-button");

/** A bundle fragment carrying every region the declared patches target, once each. */
const FULL_BUNDLE_2026_916_1 =
  `const x=1;${PI_HANDLER_2026_916_1};${CONNECT_PRIMARY_2026_916_1}` +
  `async function ma(){try{${LOCAL_LOGIN_2026_916_1}${ENV_GATE_2026_916_1}}catch{}}const y=[${ERROR_AND_FOOTER_2026_916_1}];`;

function declaredSafely(entry) {
  expect(entry).toBeDefined();
  expect(entry.upstream).toContain("github.com/paperclipai/paperclip");
  expect(entry.expect).toBe(1);
  expect(entry.pattern.flags).toContain("g");
}

/** Runs the (patched or unpatched) pi handler as the parser would, with the minified helpers stubbed. */
function runPiHandler(code, message) {
  const hn = (value) => (typeof value === "object" && value !== null && !Array.isArray(value) ? value : null);
  const tt = (value, fallback = "") => (typeof value === "string" ? value : fallback);
  const gn = (content) => ({ text: content.filter((c) => c.type === "text").map((c) => c.text).join(""), thinking: "" });
  const fn = new Function("r", "n", "t", "hn", "tt", "gn", `${code};return "fell-through"`);
  return fn("message_end", { message }, "2026-09-24T00:00:00Z", hn, tt, gn);
}

describe("pi-transcript-non-assistant-messages", () => {
  it("is declared with the safety fields every patch needs", () => declaredSafely(piPatch));

  it("looks in every chunk, since the parser moved out of the main bundle", () => {
    expect(piPatch.files).toEqual(["ui/dist/assets/*.js"]);
  });

  it("matches the 2026.916.1 handler exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(PI_HANDLER_2026_916_1, piPatch);
    expect(count).toBe(1);
    expect(text).toContain('if(r==="message_end"){const s=hn(n.message);if(s&&s.role!=="assistant")return[];if(s){');
    const renamed = PI_HANDLER_2026_916_1.replaceAll("hn(", "Qx(").replaceAll("const s=", "const Z=").replaceAll("if(s){", "if(Z){").replaceAll("s.content", "Z.content");
    expect(applyToText(renamed, piPatch).count).toBe(1);
  });

  it("does not match again once applied, so a core that already carries the fix fails the build", () => {
    const once = applyToText(PI_HANDLER_2026_916_1, piPatch).text;
    expect(applyToText(once, piPatch).count).toBe(0);
  });

  it("keeps the assistant's text and drops the wake prompt and tool results — proven by running the patched code", () => {
    const text = (s) => [{ type: "text", text: s }];
    const before = PI_HANDLER_2026_916_1;
    const after = applyToText(before, piPatch).text;
    expect(runPiHandler(before, { role: "user", content: text("## KyoubeAI Resume Delta") })).toEqual([{ kind: "assistant", ts: "2026-09-24T00:00:00Z", text: "## KyoubeAI Resume Delta" }]);
    expect(runPiHandler(before, { role: "toolResult", content: text("=== doc revisions ===") })).toHaveLength(1);
    expect(runPiHandler(after, { role: "user", content: text("## KyoubeAI Resume Delta") })).toEqual([]);
    expect(runPiHandler(after, { role: "toolResult", content: text("=== doc revisions ===") })).toEqual([]);
    expect(runPiHandler(after, { role: "assistant", content: text("Done — the pack is sent.") })).toEqual([{ kind: "assistant", ts: "2026-09-24T00:00:00Z", text: "Done — the pack is sent." }]);
    expect(runPiHandler(after, null)).toEqual([]);
  });
});

/** Runs the (patched or unpatched) Connect primary action with the wizard's state stubbed. */
function runConnectPrimary(code, { phase = "idle", needsLogin = false, loggingIn = false, arg } = {}) {
  const calls = { hires: [], opened: [], phases: [] };
  const window = { open: (...args) => calls.opened.push(args) };
  const pn = new Function("Je", "Ft", "It", "qe", "zs", "ma", "window", `${code};return pn`)(
    phase, needsLogin, "https://claude.example/auth", (next) => calls.phases.push(next), loggingIn,
    (...args) => { calls.hires.push(args); }, window,
  );
  if (arg === undefined) pn(); else pn(arg);
  return calls;
}

describe("onboarding-skip-harness-primary", () => {
  it("is declared with the safety fields every patch needs", () => declaredSafely(primaryPatch));

  it("matches the 2026.916.1 primary action exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(CONNECT_PRIMARY_2026_916_1, primaryPatch);
    expect(count).toBe(1);
    expect(text).toContain("function pn(){if(arguments[0]===!0){ma(!0);return}");
    const renamed = CONNECT_PRIMARY_2026_916_1.replaceAll("Je", "$q").replaceAll("ma()", "Zz()").replaceAll("pn", "Aa");
    expect(applyToText(renamed, primaryPatch).count).toBe(1);
  });

  it("does not match again once applied", () => {
    const once = applyToText(CONNECT_PRIMARY_2026_916_1, primaryPatch).text;
    expect(applyToText(once, primaryPatch).count).toBe(0);
  });

  it("hands an explicit `true` straight to the hire handler, and otherwise behaves as before — proven by running the patched code", () => {
    const after = applyToText(CONNECT_PRIMARY_2026_916_1, primaryPatch).text;
    // The skip goes to the hire, even mid sign-in.
    expect(runConnectPrimary(after, { arg: true, phase: "ready", needsLogin: true }).hires).toEqual([[true]]);
    expect(runConnectPrimary(after, { arg: true, phase: "connecting" }).hires).toEqual([[true]]);
    // No argument: upstream's behaviour, unchanged.
    expect(runConnectPrimary(after, {}).hires).toEqual([[]]);
    const signIn = runConnectPrimary(after, { phase: "ready", needsLogin: true });
    expect(signIn.hires).toEqual([]);
    expect(signIn.opened).toHaveLength(1);
    expect(signIn.phases).toEqual(["waiting"]);
    expect(runConnectPrimary(after, { phase: "connecting" }).hires).toEqual([]);
    expect(runConnectPrimary(after, { loggingIn: true }).hires).toEqual([]);
    // A click event is not a skip.
    expect(runConnectPrimary(after, { arg: { type: "click" } }).hires).toEqual([[]]);
  });
});

/** Runs the (patched or unpatched) sign-in block inside a plain async function, as the hire handler holds it. */
async function runLocalLogin(code, { mode = "subscription", arg } = {}) {
  const calls = { connects: 0 };
  const fn = new Function(
    "Le", "vr", "gt", "lt", "bt", "Oe", "qn", "es", "ze", "$e",
    `return async function ma(){${code}return "hired"}`,
  )(
    mode, true, "anthropic", () => null, null, { storedLogin: { data: null } },
    { connect: async () => { calls.connects += 1; throw new Error("Only the local operator can connect this machine's CLI account."); } },
    () => true, { current: null }, "company-1",
  );
  let outcome;
  try { outcome = arg === undefined ? await fn() : await fn(arg); } catch (error) { outcome = `threw: ${error.message}`; }
  return { ...calls, outcome };
}

describe("onboarding-skip-harness-login", () => {
  it("is declared with the safety fields every patch needs", () => declaredSafely(loginPatch));

  it("matches the 2026.916.1 sign-in block exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(LOCAL_LOGIN_2026_916_1, loginPatch);
    expect(count).toBe(1);
    expect(text).toContain('if(arguments[0]!==!0&&Le!=="api"&&vr&&gt&&!lt()&&!bt&&!Oe.storedLogin.data){if(await qn.connect(),');
    const renamed = LOCAL_LOGIN_2026_916_1.replaceAll("Le", "$k").replaceAll("qn.", "Ww.").replaceAll("Oe.", "Uu.");
    expect(applyToText(renamed, loginPatch).count).toBe(1);
  });

  it("does not match again once applied", () => {
    const once = applyToText(LOCAL_LOGIN_2026_916_1, loginPatch).text;
    expect(applyToText(once, loginPatch).count).toBe(0);
  });

  it("skips the sign-in only on an explicit `true` — proven by running the patched code", async () => {
    const after = applyToText(LOCAL_LOGIN_2026_916_1, loginPatch).text;
    const blocked = await runLocalLogin(LOCAL_LOGIN_2026_916_1);
    expect(blocked).toEqual({ connects: 1, outcome: "threw: Only the local operator can connect this machine's CLI account." });
    expect(await runLocalLogin(after)).toEqual(blocked);
    expect(await runLocalLogin(after, { arg: { type: "click" } })).toEqual(blocked);
    expect(await runLocalLogin(after, { arg: true })).toEqual({ connects: 0, outcome: "hired" });
    // An API key never signs in, skip or not.
    expect(await runLocalLogin(after, { mode: "api" })).toEqual({ connects: 0, outcome: "hired" });
  });
});

/** Runs the (patched or unpatched) environment gate inside a plain async function, as the hire handler holds it. */
async function runEnvGate(code, { envResult, arg } = {}) {
  const calls = { probes: 0, errors: [] };
  const blocks = (result) => result.status === "fail" || result.authMissing === true;
  const fn = new Function(
    "ct", "De", "Wt", "yr", "sH", "wn", "Sa", "es", "P",
    `return async function ma(){${code}return "hired"}`,
  )(
    true, null, { current: false }, false, blocks,
    async () => { calls.probes += 1; return envResult; }, {}, () => true, (message) => calls.errors.push(message),
  );
  const outcome = arg === undefined ? await fn() : await fn(arg);
  return { ...calls, outcome };
}

describe("onboarding-skip-harness-gate", () => {
  it("is declared with the safety fields every patch needs", () => declaredSafely(gatePatch));

  it("matches the 2026.916.1 gate exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(ENV_GATE_2026_916_1, gatePatch);
    expect(count).toBe(1);
    expect(text).toContain("if(ct&&arguments[0]!==!0){const pr=(De&&Wt.current===yr&&!sH(De)?De:null)??await wn(Sa,yr,es);");
    // Upstream's own messages are kept.
    expect(text).toContain('"The environment test failed. Fix the reported checks before you hire this agent."');
    const renamed = ENV_GATE_2026_916_1.replaceAll("ct", "$c").replaceAll("pr", "Rr").replaceAll("sH(", "Ss(").replaceAll("P(", "Pp(");
    expect(applyToText(renamed, gatePatch).count).toBe(1);
  });

  it("does not match again once applied", () => {
    const once = applyToText(ENV_GATE_2026_916_1, gatePatch).text;
    expect(applyToText(once, gatePatch).count).toBe(0);
  });

  it("still blocks a failed probe, and skips the probe only on an explicit `true` — proven by running the patched code", async () => {
    const after = applyToText(ENV_GATE_2026_916_1, gatePatch).text;
    const fail = { status: "fail" };
    const before = await runEnvGate(ENV_GATE_2026_916_1, { envResult: fail });
    expect(before).toEqual({ probes: 1, errors: ["The environment test failed. Fix the reported checks before you hire this agent."], outcome: undefined });
    expect(await runEnvGate(after, { envResult: fail })).toEqual(before);
    expect(await runEnvGate(after, { envResult: fail, arg: { type: "click" } })).toEqual(before);
    expect(await runEnvGate(after, { envResult: { status: "warn", authMissing: true } })).toEqual({ probes: 1, errors: ["No working authentication was found. Fix the reported checks before you hire this agent."], outcome: undefined });
    expect(await runEnvGate(after, { envResult: fail, arg: true })).toEqual({ probes: 0, errors: [], outcome: "hired" });
    expect(await runEnvGate(after, { envResult: { status: "pass" } })).toEqual({ probes: 1, errors: [], outcome: "hired" });
  });
});

/** Evaluates the (patched or unpatched) error+footer children with the wizard's render scope stubbed. */
function renderErrorAndFooter(code, { step, error, loading = false }) {
  const t = { jsx: (type, props) => ({ type, props }) };
  const primaryCalls = [];
  const fn = new Function(
    "t", "tn", "Y", "Pwe", "Je", "Vs", "Mze", "I", "Ha", "_", "S", "Hn", "B", "M", "H", "en", "kr", "pn", "Gn",
    `return [${code}]`,
  );
  const children = fn(
    t, error, true, "FooterNav", "idle", () => {}, () => true, () => {}, (n) => n - 1, step, 3,
    { label: "Connect", icon: "arrow", disabled: false }, loading, { trim: () => "Co" }, { trim: () => "Ada" }, false,
    () => {}, (...args) => { primaryCalls.push(args); }, () => {},
  );
  return { children, primaryCalls };
}

describe("onboarding-skip-harness-button", () => {
  it("is declared with the safety fields every patch needs", () => declaredSafely(buttonPatch));

  it("matches the 2026.916.1 error line and footer exactly once, whatever the minifier called the identifiers", () => {
    const { count, text } = applyToText(ERROR_AND_FOOTER_2026_916_1, buttonPatch);
    expect(count).toBe(1);
    expect(text).toContain('_===4&&tn&&(0,t.jsx)("div",{className:"mt-2"');
    expect(text).toContain("onClick:()=>pn(!0)");
    // The footer call is re-emitted untouched.
    expect(text).toContain(ERROR_AND_FOOTER_2026_916_1.slice(ERROR_AND_FOOTER_2026_916_1.indexOf("(Y||")));
    const renamed = ERROR_AND_FOOTER_2026_916_1.replaceAll("tn", "$e").replaceAll("(0,t.jsx)", "(0,Kt.jsx)").replaceAll("pn()", "Qq()").replaceAll("_===", "St===").replaceAll("currentStep:_", "currentStep:St").replaceAll("Ha(_)", "Ha(St)");
    expect(applyToText(renamed, buttonPatch).count).toBe(1);
  });

  it("does not match again once applied", () => {
    const once = applyToText(ERROR_AND_FOOTER_2026_916_1, buttonPatch).text;
    expect(applyToText(once, buttonPatch).count).toBe(0);
  });

  it("renders the skip control only on step 4 under an error, and it calls the primary action with `true` — proven by running the patched code", () => {
    const after = applyToText(ERROR_AND_FOOTER_2026_916_1, buttonPatch).text;
    const message = "Could not verify the local subscription. Run the sign-in command shown for this connection, finish signing in, then try Connect again.";
    const before = renderErrorAndFooter(ERROR_AND_FOOTER_2026_916_1, { step: 4, error: message });
    expect(before.children).toHaveLength(2);
    expect(before.children[1].type).toBe("FooterNav");

    const shown = renderErrorAndFooter(after, { step: 4, error: message });
    expect(shown.children).toHaveLength(3);
    expect(shown.children[0].props.children.props.children).toBe(message);
    const button = shown.children[1].props.children;
    expect(button.type).toBe("button");
    expect(button.props.type).toBe("button");
    expect(button.props.children).toBe(SKIP_HARNESS_LABEL);
    expect(button.props.disabled).toBe(false);
    button.props.onClick();
    expect(shown.primaryCalls).toEqual([[true]]);
    expect(shown.children[2].type).toBe("FooterNav");
    expect(shown.children[2].props.primaryLabel).toBe("Connect");

    // Any other step, or no error: the slot is falsy, so React renders nothing there.
    expect(renderErrorAndFooter(after, { step: 3, error: message }).children[1]).toBeFalsy();
    expect(renderErrorAndFooter(after, { step: 5, error: message }).children[1]).toBeFalsy();
    expect(renderErrorAndFooter(after, { step: 4, error: null }).children[0]).toBeFalsy();
    expect(renderErrorAndFooter(after, { step: 4, error: null }).children[1]).toBeFalsy();
    // While a hire is in flight the control is disabled.
    expect(renderErrorAndFooter(after, { step: 4, error: message, loading: true }).children[1].props.children.props.disabled).toBe(true);
  });
});

describe("applyPatches", () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "core-patches-"));
    await mkdir(path.join(root, "ui", "dist", "assets"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("expands a single-star glob in the basename", async () => {
    await writeFile(path.join(root, "ui/dist/assets/index-AAAA.js"), "");
    await writeFile(path.join(root, "ui/dist/assets/index-AAAA.js.map"), "");
    await writeFile(path.join(root, "ui/dist/assets/other-BBBB.js"), "");
    expect((await expandGlob(root, "ui/dist/assets/index-*.js")).map((f) => path.basename(f))).toEqual(["index-AAAA.js"]);
    expect((await expandGlob(root, "ui/dist/assets/*.js")).map((f) => path.basename(f))).toEqual(["index-AAAA.js", "other-BBBB.js"]);
    expect(await expandGlob(root, "nope/*.js")).toEqual([]);
  });

  it("rewrites the bundle in place and reports it", async () => {
    const file = path.join(root, "ui/dist/assets/index-5zyW-AFc.js");
    await writeFile(file, FULL_BUNDLE_2026_916_1);
    const report = await applyPatches(root, PATCHES);
    expect(report).toEqual(PATCHES.map((entry) => ({ id: entry.id, matched: 1, expect: 1, files: ["ui/dist/assets/index-5zyW-AFc.js"] })));
    const patched = await readFile(file, "utf8");
    expect(patched).toContain('.role!=="assistant")return[]');
    expect(patched).toContain("arguments[0]!==!0");
    expect(patched).toContain(SKIP_HARNESS_LABEL);
  });

  it("finds the pi parser in a code-split chunk", async () => {
    await writeFile(path.join(root, "ui/dist/assets/index-5zyW-AFc.js"), FULL_BUNDLE_2026_916_1.replace(PI_HANDLER_2026_916_1, ""));
    await writeFile(path.join(root, "ui/dist/assets/AiConnectionCredentialStep-DHV6zd1f.js"), PI_HANDLER_2026_916_1);
    const report = await applyPatches(root, PATCHES);
    expect(report.find((entry) => entry.id === piPatch.id).files).toEqual(["ui/dist/assets/AiConnectionCredentialStep-DHV6zd1f.js"]);
  });

  it("fails — without writing — when a patch matches zero times or more than declared", async () => {
    const file = path.join(root, "ui/dist/assets/index-5zyW-AFc.js");
    await writeFile(file, "nothing here");
    await expect(applyPatches(root, PATCHES)).rejects.toThrow(/matched 0 time\(s\).*expected 1/);
    await writeFile(file, FULL_BUNDLE_2026_916_1 + FULL_BUNDLE_2026_916_1);
    await expect(applyPatches(root, PATCHES)).rejects.toThrow(/matched 2 time\(s\).*expected 1/);
    // A bundle that carries only one region still fails the build on the
    // others, so a core that moved one of them cannot ship half a fix.
    await writeFile(file, PI_HANDLER_2026_916_1);
    await expect(applyPatches(root, PATCHES)).rejects.toThrow(/onboarding-skip-harness-primary.*matched 0 time\(s\)/);
  });

  it("dry-run reports without touching the file", async () => {
    const file = path.join(root, "ui/dist/assets/index-5zyW-AFc.js");
    await writeFile(file, FULL_BUNDLE_2026_916_1);
    const report = await applyPatches(root, PATCHES, { dryRun: true });
    expect(report.map((entry) => entry.matched)).toEqual(PATCHES.map(() => 1));
    expect(await readFile(file, "utf8")).toBe(FULL_BUNDLE_2026_916_1);
  });
});
````

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm -C docker/core-patches test
```

Expected: `Tests  19 failed | 7 passed (26)`, starting with `looks in every chunk, since the parser moved out of the main bundle` and `onboarding-skip-harness-primary > is declared with the safety fields every patch needs`.

- [ ] **Step 3: Replace the patch list**

Replace `docker/core-patches/patches.mjs` with:

````js
/**
 * Every fix KyoubeAI applies to the upstream core at image build time.
 *
 * This list is meant to be empty. An entry exists only while an upstream bug
 * is fixed here first and the same fix is on its way upstream (`upstream`
 * names the issue or pull request); it is deleted the moment a core bump
 * carries the upstream fix. `apply.mjs` enforces the exit: each pattern must
 * match exactly `expect` times across the files it names, so a core release
 * that no longer has the bug — or that changed the code's shape — fails the
 * build with the patch's id, which is the cue to remove (or redo) it.
 *
 * Patterns are written against the compiled, minified bundle the image ships
 * (`ui/dist`), so they anchor on string literals and code shape, never on
 * minifier-chosen identifier names. See CONTRIBUTING.md, "Never patch the core".
 */

/**
 * The label of the control the `onboarding-skip-harness-*` patches add under
 * a failed Connect step. Exported for the tests.
 */
export const SKIP_HARNESS_LABEL = "Skip for now and connect the harness later from the Terminal page";

export const PATCHES = [
  {
    id: "pi-transcript-non-assistant-messages",
    title: "pi adapter: do not render tool results and the wake prompt as agent text",
    upstream: "https://github.com/paperclipai/paperclip (packages/adapters/pi-local/src/ui/parse-stdout.ts, message_end handler; PR pending)",
    // pi emits `message_end` for every message it appends to its session —
    // the user turn (the "Resume Delta" wake prompt) and each `toolResult`
    // (raw command output) as well as the assistant's own text — and the
    // parser turned all of them into `assistant` transcript entries, so the
    // task chat showed the prompt and every tool output as agent bubbles in
    // the body font (tool output twice: it is also threaded onto its tool
    // card). Only an assistant message may become agent text.
    // Since core 2026.916 the pi transcript parser is code-split into a chunk
    // whose name the bundler picks (AiConnectionCredentialStep-*.js in
    // 2026.916.1), so the patch looks in every chunk; `expect` still pins it
    // to exactly one match.
    files: ["ui/dist/assets/*.js"],
    pattern: /if\((\w+)==="message_end"\)\{const (\w+)=(\w+)\((\w+)\.message\);if\(\2\)\{/g,
    replacement: 'if($1==="message_end"){const $2=$3($4.message);if($2&&$2.role!=="assistant")return[];if($2){',
    expect: 1,
  },
  // ── onboarding: "Skip for now" under a failed Connect step ──────────────
  // Step 2 of the first-run agent wizard ("Connect a model") will not hire the
  // agent until the chosen harness is signed in. On a fresh KyoubeAI install
  // nothing is: the server runs in `authenticated` mode, where the wizard's
  // Claude/OpenAI subscription sign-in ends in "Only the local operator can
  // connect this machine's CLI account" (upstream only lets the implicit local
  // operator of a `local_trusted` instance finish it), and the Terminal page
  // where `claude login` works sits behind the wizard, which has no close
  // button. An API key still works; a subscription has no way forward.
  //
  // Four patches, one feature. The footer gets a "Skip for now" button while
  // step 4 shows an error; it calls the step's primary action with `true`,
  // which goes straight to the hire handler with `true`, which then skips the
  // two checks that need a signed-in harness (the local sign-in and the
  // environment test). Both handlers are plain function declarations, so
  // `arguments[0]` reads that flag without the pattern reaching a parameter
  // list, and every existing call passes nothing (or a click event), so only
  // the new button skips. The agent is created with the chosen harness and
  // no credential; signing in from the Terminal page afterwards is enough.
  {
    id: "onboarding-skip-harness-primary",
    title: "onboarding: the Connect step's primary action accepts a skip flag",
    upstream: "https://github.com/paperclipai/paperclip (ui/src/components/OnboardingWizard.tsx, handleConnectStepPrimary; feature request pending)",
    files: ["ui/dist/assets/*.js"],
    pattern: /function ([\w$]+)\(\)\{if\(([\w$]+)==="ready"&&([\w$]+)\)\{([\w$]+)&&window\.open\(\4,"_blank","noreferrer,noopener"\),([\w$]+)\("waiting"\);return\}\2!=="connecting"&&\(([\w$]+)\|\|([\w$]+)\(\)\)\}/g,
    replacement: 'function $1(){if(arguments[0]===!0){$7(!0);return}if($2==="ready"&&$3){$4&&window.open($4,"_blank","noreferrer,noopener"),$5("waiting");return}$2!=="connecting"&&($6||$7())}',
    expect: 1,
  },
  {
    id: "onboarding-skip-harness-login",
    title: "onboarding: a skipped hire does not start the subscription sign-in",
    upstream: "https://github.com/paperclipai/paperclip (ui/src/components/OnboardingWizard.tsx, handleGiveHeartbeat, localLogin.connect(); feature request pending)",
    files: ["ui/dist/assets/*.js"],
    pattern: /if\(([\w$]+)!=="api"&&([\w$]+)&&([\w$]+)&&!([\w$]+)\(\)&&!([\w$]+)&&!([\w$]+)\.storedLogin\.data\)\{if\(await ([\w$]+)\.connect\(\),/g,
    replacement: 'if(arguments[0]!==!0&&$1!=="api"&&$2&&$3&&!$4()&&!$5&&!$6.storedLogin.data){if(await $7.connect(),',
    expect: 1,
  },
  {
    id: "onboarding-skip-harness-gate",
    title: "onboarding: a skipped hire does not run the environment test",
    upstream: "https://github.com/paperclipai/paperclip (ui/src/components/OnboardingWizard.tsx, handleGiveHeartbeat, blocksAgentCreate gate; feature request pending)",
    files: ["ui/dist/assets/*.js"],
    pattern: /if\(([\w$]+)\)\{const ([\w$]+)=(\([^;]*?\))\?\?await ([\w$]+)\(([\w$,]*)\);if\(!\2\|\|!([\w$]+)\(\)\)return;if\(([\w$]+)\(\2\)\)\{([\w$]+)\(\2\.status==="fail"\?"The environment test failed\. Fix the reported checks before you hire this agent\.":"No working authentication was found\. Fix the reported checks before you hire this agent\."\);return\}\}/g,
    replacement: 'if($1&&arguments[0]!==!0){const $2=$3??await $4($5);if(!$2||!$6())return;if($7($2)){$8($2.status==="fail"?"The environment test failed. Fix the reported checks before you hire this agent.":"No working authentication was found. Fix the reported checks before you hire this agent.");return}}',
    expect: 1,
  },
  {
    id: "onboarding-skip-harness-button",
    title: "onboarding: offer \"Skip for now\" under an error on the Connect step",
    upstream: "https://github.com/paperclipai/paperclip (ui/src/components/OnboardingWizard.tsx, error block and FooterNav; feature request pending)",
    // Anchors on the error line and on the footer's own literals ("Continue",
    // "Connecting", the step numbers), and captures the step ($5), the busy
    // flag ($7) and the Connect step's primary action ($8) from the footer's
    // props. The footer call is re-emitted verbatim ($3).
    files: ["ui/dist/assets/*.js"],
    pattern: /([\w$]+)&&\(0,([\w$]+)\.jsx\)\("div",\{className:"mt-3",children:\(0,\2\.jsx\)\("p",\{className:"text-xs text-destructive",children:\1\}\)\}\),(\(([\w$]+)\|\|([\w$]+)===1\)&&\(0,\2\.jsx\)\(([\w$]+),\{onBack:[^;]*?,primaryLabel:\5===1\?"Continue":[^;]*?,loadingLabel:\5===1\?"Creating\.\.\.":\5===4\?"Connecting":"Launching\.\.\.",loading:\5===3\|\|\5===4\?!1:([\w$]+),primaryDisabled:[^;]*?,onPrimary:\(\)=>\{\5===1\?[\w$]+\(\):\5===3\?[\w$]+\(4\):\5===4\?([\w$]+)\(\):[\w$]+\(\)\}\}\))/g,
    replacement:
      '$1&&(0,$2.jsx)("div",{className:"mt-3",children:(0,$2.jsx)("p",{className:"text-xs text-destructive",children:$1})}),' +
      `$5===4&&$1&&(0,$2.jsx)("div",{className:"mt-2",children:(0,$2.jsx)("button",{type:"button",className:"text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors",disabled:$7,onClick:()=>$8(!0),children:${JSON.stringify(SKIP_HARNESS_LABEL)}})}),` +
      "$3",
    expect: 1,
  },
];
````

- [ ] **Step 4: Run the tests again**

```bash
pnpm -C docker/core-patches test
```

Expected: `Tests  26 passed (26)`.

- [ ] **Step 5: Prove the patches against the real bundle**

```bash
docker run --rm --user root --entrypoint bash -v "$PWD/docker:/src:ro" ghcr.io/paperclipai/paperclip:2026.916.1 -c \
  'mkdir -p /opt/kp && cp /src/core-patches/*.mjs /opt/kp/ && gosu node node /opt/kp/apply.mjs --root /app --dry-run --report'
```

Expected, exactly five lines:

```
core-patches: pi-transcript-non-assistant-messages applied 1/1 in ui/dist/assets/AiConnectionCredentialStep-DHV6zd1f.js
core-patches: onboarding-skip-harness-primary applied 1/1 in ui/dist/assets/index-5zyW-AFc.js
core-patches: onboarding-skip-harness-login applied 1/1 in ui/dist/assets/index-5zyW-AFc.js
core-patches: onboarding-skip-harness-gate applied 1/1 in ui/dist/assets/index-5zyW-AFc.js
core-patches: onboarding-skip-harness-button applied 1/1 in ui/dist/assets/index-5zyW-AFc.js
```

- [ ] **Step 6: Commit**

```bash
git add docker/core-patches/patches.mjs docker/core-patches/tests/patches.spec.mjs
git commit -F - <<'MSG'
fix(core-patches): follow core 2026.916.1 (pi parser chunk, new onboarding wizard)

The pi transcript fix now looks in every chunk: the parser moved into a
code-split chunk. The first-run wizard was rebuilt, and in authenticated
mode its subscription sign-in can only fail, so four new patches replace
the two old ones and bring back "Skip for now" under a Connect error.
MSG
```

---

### Task 3: The Studio theme on the streamlined shell

**Files:**
- Modify: `docker/theme/rules.mjs` (whole file), `docker/theme/anchors.mjs` (whole file), `docker/theme/theme.css` (two blocks)
- Create: `docker/theme/tests/fixtures/core-2026.916.1.mjs` (generated)
- Delete: `docker/theme/tests/fixtures/core-2026.831.1.mjs`
- Test: `docker/theme/tests/theme.spec.mjs`; `plugins/kyoube-studio/tests/links.spec.ts` (it reads `SECTIONS`)

**Interfaces:**
- Consumes: `runTheme`, `sectionRoutes`, `overriddenTokens`, `ThemeError`, `THEME_ASSET` from `docker/theme/theme.mjs` (unchanged); `docker/theme/tests/fixtures/extract.mjs` (unchanged).
- Produces: `TEXT_RULES` (8 rules), `ANCHORS` (16), `SECTIONS` with ids `top`, `work`, `org`. `org` is the only `mode: "exact"` section, with `expected: ["/agents", "/skills", "/apps", "/activity"]`; Task 5's Workspace cards must cover it.

- [ ] **Step 1: Point the theme tests at 2026.916.1**

````bash
git apply <<'PATCH'
diff --git a/docker/theme/tests/theme.spec.mjs b/docker/theme/tests/theme.spec.mjs
index 658d1d0..375e81f 100644
--- a/docker/theme/tests/theme.spec.mjs
+++ b/docker/theme/tests/theme.spec.mjs
@@ -6,7 +6,7 @@ import { afterEach, beforeEach, describe, expect, it } from "vitest";
 import { SECTIONS } from "../anchors.mjs";
 import { TEXT_RULES } from "../rules.mjs";
 import { THEME_ASSET, ThemeError, overriddenTokens, runTheme, sectionRoutes } from "../theme.mjs";
-import { BUNDLE, CORE_CSS, INDEX_HTML } from "./fixtures/core-2026.831.1.mjs";
+import { BUNDLE, CORE_CSS, INDEX_HTML } from "./fixtures/core-2026.916.1.mjs";
 
 const THEME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
 const quiet = () => {};
@@ -15,44 +15,39 @@ let root;
 beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "kyoube-theme-")); });
 afterEach(async () => { await rm(root, { recursive: true, force: true }); });
 
-/** A core tree with the real 2026.831.1 excerpts, optionally edited to simulate an upstream change. */
+/** A core tree with the real 2026.916.1 excerpts, optionally edited to simulate an upstream change. */
 async function coreTree({ bundle = BUNDLE, css = CORE_CSS, html = INDEX_HTML } = {}) {
   const assets = path.join(root, "ui", "dist", "assets");
   await mkdir(assets, { recursive: true });
   await writeFile(path.join(root, "ui", "dist", "index.html"), html);
-  await writeFile(path.join(assets, "index-BHbrFFmp.js"), bundle);
-  await writeFile(path.join(assets, "index-BU41-p9M.css"), css);
+  await writeFile(path.join(assets, "index-5zyW-AFc.js"), bundle);
+  await writeFile(path.join(assets, "index-tk1F4est.css"), css);
 }
 
 const read = (rel) => readFile(path.join(root, rel), "utf8");
 const count = (text, literal) => text.split(literal).length - 1;
 
-describe("runTheme on core 2026.831.1", () => {
+describe("runTheme on core 2026.916.1", () => {
   it("applies every text rule exactly as declared and reports it", async () => {
     await coreTree();
     const lines = [];
     const result = await runTheme({ root, themeDir: THEME_DIR, report: true, log: (line) => lines.push(line) });
     expect(result.rules).toHaveLength(TEXT_RULES.length);
     for (const rule of TEXT_RULES) expect(result.rules).toContain(`${rule.id} ${rule.expect}/${rule.expect}`);
-    expect(lines.join("\n")).toMatch(/theme: anchors \d+\/\d+; sidebar sections top=6, work=9, organization=6/);
+    expect(lines.join("\n")).toMatch(/theme: anchors \d+\/\d+; sidebar sections top=6, work=8, org=4/);
   });
 
-  it("renames Dashboard to Home and the core's Apps area to Connections", async () => {
+  it("renames Dashboard to Home in both sidebars and the core's last Apps breadcrumbs to Connectors", async () => {
     await coreTree();
     await runTheme({ root, themeDir: THEME_DIR, log: quiet });
-    const bundle = await read("ui/dist/assets/index-BHbrFFmp.js");
-    expect(bundle).toContain('to:"/dashboard",label:"Home"');
+    const bundle = await read("ui/dist/assets/index-5zyW-AFc.js");
+    // Both sidebars (streamlined and legacy) are renamed; the mobile bar's own "Home" link was already there.
+    expect(count(bundle, 'to:"/dashboard",label:"Home"')).toBe(3);
     expect(bundle).not.toContain('to:"/dashboard",label:"Dashboard"');
-    expect(count(bundle, '{label:"Connections",href:"/apps"}')).toBe(10);
+    expect(bundle).toContain('[{label:"Home"}]');
+    expect(count(bundle, '{label:"Connectors",href:"/apps"}')).toBe(3);
     expect(bundle).not.toContain('{label:"Apps",href:"/apps"}');
-    expect(bundle).toContain('to:"/apps/connections",label:"Connected apps"');
-    expect(bundle).toContain('to:"/apps",label:"Connections"');
-    // KyoubeAI's own Apps page is a different route and is untouched by these rules.
-    expect(bundle).not.toContain('{label:"Connections"},{label:"Connections"}');
     expect(bundle).toMatch(/[\w$]+\(\[\{label:[\w$]+\.displayName\?\?[\w$]+\.pluginDisplayName\}\]\)/);
-    // The agent page's default tab opens the Studio profile, so it is called Overview.
-    expect(bundle).toContain('{value:"dashboard",label:"Overview"}');
-    expect(bundle).not.toContain('{value:"dashboard",label:"Dashboard"}');
   });
 
   it("makes dark the default and links the theme after the core stylesheet with the boot flag", async () => {
@@ -60,7 +55,7 @@ describe("runTheme on core 2026.831.1", () => {
     await runTheme({ root, themeDir: THEME_DIR, log: quiet });
     const html = await read("ui/dist/index.html");
     expect(html).toContain('const fallback = "dark";');
-    const core = html.indexOf('/assets/index-BU41-p9M');
+    const core = html.indexOf('/assets/index-tk1F4est');
     const theme = html.indexOf(`/assets/${THEME_ASSET}`);
     expect(core).toBeGreaterThan(-1);
     expect(theme).toBeGreaterThan(core);
@@ -75,7 +70,7 @@ describe("runTheme on core 2026.831.1", () => {
     await coreTree();
     await runTheme({ root, themeDir: THEME_DIR, dryRun: true, log: quiet });
     expect(await read("ui/dist/index.html")).toBe(INDEX_HTML);
-    expect(await read("ui/dist/assets/index-BHbrFFmp.js")).toBe(BUNDLE);
+    expect(await read("ui/dist/assets/index-5zyW-AFc.js")).toBe(BUNDLE);
   });
 
   it("refuses to run twice on the same tree", async () => {
@@ -96,7 +91,7 @@ describe("runTheme when the core changes", () => {
   }
 
   it("names a text rule whose target moved", async () => {
-    const message = await failureFor({ bundle: BUNDLE.replace('to:"/dashboard",label:"Dashboard"', 'to:"/dashboard",label:"Overview"') });
+    const message = await failureFor({ bundle: BUNDLE.replaceAll('to:"/dashboard",label:"Dashboard"', 'to:"/dashboard",label:"Overview"') });
     expect(message).toContain('text rule "home-sidebar-label" matched 0 time(s)');
   });
 
@@ -106,21 +101,21 @@ describe("runTheme when the core changes", () => {
   });
 
   it("names a hook the skin relies on", async () => {
-    const message = await failureFor({ bundle: BUNDLE.replace('ariaLabel:"New agent"', 'ariaLabel:"Add agent"') });
-    expect(message).toContain('anchor "nav-agents-section"');
+    const message = await failureFor({ bundle: BUNDLE.replace("} avatar`", "} portrait`") });
+    expect(message).toContain('anchor "agent-avatar-label"');
   });
 
-  it("stops when the hidden Organization section gains a link", async () => {
-    const bundle = BUNDLE.replace('label:"Organization",collapsible', 'label:"Organization",collapsible:x,y:[{to:"/reports",label:"Reports"}],z');
+  it("stops when the hidden Org section gains a link", async () => {
+    const bundle = BUNDLE.replace('label:"Org",collapsible', 'label:"Org",collapsible:x,y:[{to:"/reports",label:"Reports"}],z');
     const message = await failureFor({ bundle });
-    expect(message).toContain('sidebar section "organization" changed: added [/reports]');
+    expect(message).toContain('sidebar section "org" changed: added [/reports]');
   });
 
   it("only reports a new link in a section the skin keeps", async () => {
     await coreTree({ bundle: BUNDLE.replace('label:"Work",collapsible', 'label:"Work",collapsible:x,y:[{to:"/reports",label:"Reports"}],z') });
     const lines = [];
     await runTheme({ root, themeDir: THEME_DIR, report: true, log: (line) => lines.push(line) });
-    expect(lines.join("\n")).toContain("work=10 (new: /reports)");
+    expect(lines.join("\n")).toContain("work=9 (new: /reports)");
   });
 
   it("names a token the core stopped declaring", async () => {
PATCH
````

- [ ] **Step 2: Make the Workspace coverage test read every hidden section**

In `plugins/kyoube-studio/tests/links.spec.ts`, replace the test `has a card for every link the theme hides from the sidebar` with:

```ts
  it("has a card for every link the theme hides from the sidebar", async () => {
    // @ts-expect-error -- plain ES module outside this package
    const { SECTIONS } = await import("../../../docker/theme/anchors.mjs");
    // Every section the skin hides whole is declared "exact" in anchors.mjs.
    const hidden = SECTIONS.filter((section: { mode: string }) => section.mode === "exact").flatMap((section: { expected: string[] }) => section.expected);
    expect(hidden.length).toBeGreaterThan(0);
    const hiddenElsewhere = ["/artifacts", "/skills", "/terminal"];
    // A card covers a route when it links it or a page under it (All agents covers /agents).
    const covered = (route: string) => routes.some((to) => to === route || to.startsWith(`${route}/`));
    expect([...hidden, ...hiddenElsewhere].filter((route: string) => !covered(route))).toEqual([]);
  });
```

- [ ] **Step 3: Run the theme tests and watch them fail**

```bash
pnpm -C docker/theme test
```

Expected: FAIL, `Failed to load url ./fixtures/core-2026.916.1.mjs` (the fixture does not exist yet).

- [ ] **Step 4: Replace the text rules**

Replace `docker/theme/rules.mjs` with:

````js
/**
 * Display-text changes the KyoubeAI theme makes to the core's compiled UI.
 *
 * Like docker/core-patches, every rule anchors on string literals and code
 * shape, never on minifier-chosen identifier names (`[\w$]+` stands in for
 * those), and must match exactly `expect` times across the files it names.
 * A core release that moves or rewords one of these strings therefore stops
 * the build here with the rule's id instead of shipping a half-renamed UI.
 * The fix is to look at the new code and update the pattern, never to relax
 * `expect`.
 *
 * Unlike core-patches these are permanent: they are product decisions (what
 * a page is called), not bug fixes waiting for upstream. They change text
 * and one theme default only; no behaviour.
 *
 * Rules run in order, so a later rule sees the output of an earlier one.
 */

const BUNDLE = ["ui/dist/assets/*.js"];

export const TEXT_RULES = [
  // ── "Dashboard" is called Home ───────────────────────────────────────────
  // The mobile bottom bar already says Home; the desktop sidebar, the page's
  // breadcrumb and the links back to it now agree. (The agent page's default
  // view has been called Overview upstream since core 2026.916.)
  {
    id: "home-sidebar-label",
    files: BUNDLE,
    pattern: /to:"\/dashboard",label:"Dashboard"/g,
    replacement: 'to:"/dashboard",label:"Home"',
    // The streamlined sidebar (the default) and the legacy one an instance
    // can still opt back into both ship in the bundle.
    expect: 2,
  },
  {
    id: "home-breadcrumb",
    files: BUNDLE,
    pattern: /\[\{label:"Dashboard"\}\]/g,
    replacement: '[{label:"Home"}]',
    expect: 1,
  },
  {
    id: "home-live-runs-breadcrumb",
    files: BUNDLE,
    pattern: /\{label:"Dashboard",href:"\/dashboard"\}/g,
    replacement: '{label:"Home",href:"/dashboard"}',
    expect: 1,
  },
  {
    id: "home-live-runs-backlink",
    files: BUNDLE,
    pattern: /(to:"\/dashboard",className:"[^"]*",children:\[\(0,[\w$]+\.jsx\)\([\w$]+,\{className:"h-3\.5 w-3\.5"\}\),)"Dashboard"\]/g,
    replacement: '$1"Home"]',
    expect: 1,
  },
  {
    id: "home-command-palette",
    files: BUNDLE,
    pattern: /(\("\/dashboard"\),children:\[\(0,[\w$]+\.jsx\)\([\w$]+,\{className:"mr-2 h-4 w-4"\}\),)"Dashboard"\]/g,
    replacement: '$1"Home"]',
    expect: 1,
  },

  // ── The core's integrations area is Connectors everywhere ──────────────
  // Upstream renamed its "Apps" area to Connectors (sidebar, page title and
  // most breadcrumbs) in 2026.916, which already keeps "Apps" free for
  // KyoubeAI's own Apps. Three access-profile pages still say "Apps" in their
  // breadcrumb; they say Connectors here too.
  {
    id: "connectors-breadcrumbs",
    files: BUNDLE,
    pattern: /\{label:"Apps",href:"\/apps"\}/g,
    replacement: '{label:"Connectors",href:"/apps"}',
    expect: 3,
  },

  // ── A plugin page is titled by its page ──────────────────────────────────
  // The host titles every plugin page "Plugins › <plugin name>" (so the
  // Data page read "Plugins › Kyoube Data & Apps"). KyoubeAI's plugin pages
  // are first-class destinations, so the breadcrumb shows the page slot's own
  // name ("Data", "Workspace"), falling back to the plugin's.
  {
    id: "plugin-page-title",
    files: BUNDLE,
    pattern: /([\w$]+)\(\[\{label:"Plugins",href:"\/company\/settings\/instance\/plugins"\},\{label:([\w$]+)\.pluginDisplayName\}\]\)/g,
    replacement: "$1([{label:$2.displayName??$2.pluginDisplayName}])",
    expect: 1,
  },

  // ── Dark is the default theme ─────────────────────────────────────────────
  // index.html's boot script picks the theme before React mounts, and the
  // core's ThemeProvider starts from whatever it picked. With no stored
  // choice it used the OS preference; KyoubeAI opens dark. A choice made with
  // the theme toggle is stored and still wins.
  {
    id: "dark-by-default",
    files: ["ui/dist/index.html"],
    pattern: /const fallback = prefersDark \? "dark" : "light";/g,
    replacement: 'const fallback = "dark";',
    expect: 1,
  },
];
````

- [ ] **Step 5: Replace the anchors and sidebar sections**

Replace `docker/theme/anchors.mjs` with:

````js
/**
 * What theme.css's skin relies on in the core's compiled UI, checked at build
 * time after TEXT_RULES ran.
 *
 * The skin is written to fail safe: every structural rule is gated on the
 * Studio plugin's own markup, and a selector that stops matching just shows
 * the stock look. These checks exist so that a core bump that moves a hook is
 * caught at build time with a named reason, instead of being discovered as a
 * slowly un-themed sidebar.
 *
 * ANCHORS: a literal that must appear at least `min` times in the bundle.
 * SECTIONS: the routes the core's sidebar puts in one section, compared with
 * the set the skin was written for. A section the skin hides must match its
 * set exactly: a new link there would otherwise disappear from the sidebar
 * without a home on the Workspace page.
 */

const BUNDLE = ["ui/dist/assets/*.js"];

export const ANCHORS = [
  { id: "nav-search-link", files: BUNDLE, literal: 'to:"/search",label:"Search"', min: 1, why: "the search field restyle targets the /search nav link" },
  { id: "nav-home-link", files: BUNDLE, literal: 'to:"/dashboard",label:"Home"', min: 1, why: "the Home icon swap targets the /dashboard nav link" },
  { id: "nav-new-task", files: BUNDLE, literal: '"New Task"', min: 1, why: "the New task button restyle targets the sidebar's compose button" },
  { id: "icon-square-pen", files: BUNDLE, literal: '"square-pen"', min: 1, why: "the New task button is found by its lucide-square-pen icon class" },
  { id: "icon-class-names", files: BUNDLE, literal: "lucide-${", min: 1, why: "icons must keep their per-name lucide-<name> class" },
  { id: "nav-work-section", files: BUNDLE, literal: 'label:"Work",collapsible', min: 1, why: "the Work header row is hidden so Tasks and Projects join the top group" },
  { id: "nav-org-section", files: BUNDLE, literal: 'label:"Org",collapsible', min: 1, why: "the Org section (Agents, Skills, Connectors, Audit) moves to the Workspace page" },
  { id: "slot-sidebar", files: BUNDLE, literal: 'slotTypes:["sidebar"]', min: 1, why: "the Studio Build group and Team roster render in the sidebar slot" },
  { id: "slot-sidebar-panel", files: BUNDLE, literal: 'slotTypes:["sidebarPanel"]', min: 1, why: "the Workspace link renders in the sidebar panel slot" },
  { id: "slot-dashboard-widget", files: BUNDLE, literal: 'slotTypes:["dashboardWidget"]', min: 1, why: "the Studio Home renders in the dashboard widget slot" },
  { id: "dashboard-live-runs-heading", files: BUNDLE, literal: 'className:"mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground",children:', min: 1, why: "the stock live-runs panel is found by its heading" },
  { id: "plugin-page-back-link", files: BUNDLE, literal: '{className:"h-4 w-4 mr-1"}),"Back"]', min: 1, why: "KyoubeAI's plugin pages drop the host's Back link (a link to /dashboard above the page)" },
  { id: "agent-page-content", files: BUNDLE, literal: '"agent-settings-content ', min: 1, why: "the core agent page is recognised by its agent-settings-content wrapper, whose header holds the name and avatar" },
  { id: "agent-page-view-class", files: BUNDLE, literal: "`agent-settings-${", min: 1, why: "the wrapper also carries agent-settings-<view>; the overview's sections are found by agent-settings-overview" },
  { id: "agent-avatar-label", files: BUNDLE, literal: "} avatar`", min: 1, why: "the agent's character is painted over the header avatar, found by its aria-label \"<name> avatar\"" },
  { id: "theme-boot-script", files: ["ui/dist/index.html"], literal: 'const key = "paperclip.theme";', min: 1, why: "the dark-by-default boot script" },
];

/**
 * Each entry: the literal that opens the section in the Sidebar component,
 * the literal that ends it, the routes expected between them, and whether
 * the skin hides the section (exact match required) or only a few of its
 * links (listed routes must still be present; additions are reported).
 */
export const SECTIONS = [
  {
    id: "top",
    start: '"New Task"',
    end: 'label:"Work",collapsible',
    expected: ["/search", "/dashboard", "/inbox", "/decisions", "/status", "/board-chat"],
    mode: "contains",
  },
  {
    id: "work",
    start: 'label:"Work",collapsible',
    end: 'slotTypes:["sidebar"]',
    expected: ["/issues", "/projects", "/routines", "/artifacts", "/cases", "/pipelines", "/goals", "/workspaces"],
    mode: "contains",
  },
  {
    // The streamlined shell's Org section. It ends where the component's
    // legacy branch begins (the Organization section an instance that opts
    // out of the streamlined shell still gets); when upstream deletes that
    // branch this entry reports "not found", which is the cue to pick the
    // next literal after the Org section instead.
    id: "org",
    start: 'label:"Org",collapsible',
    end: 'label:"Organization",collapsible',
    // Every one of these must have a card on the Studio Workspace page
    // (plugins/kyoube-studio/src/ui/links.ts, WORKSPACE_GROUPS).
    expected: ["/agents", "/skills", "/apps", "/activity"],
    mode: "exact",
  },
];
````

- [ ] **Step 6: Retarget the skin's Org section and agent page rules**

````bash
git apply <<'PATCH'
diff --git a/docker/theme/theme.css b/docker/theme/theme.css
index d4f08e1..479d735 100644
--- a/docker/theme/theme.css
+++ b/docker/theme/theme.css
@@ -246,13 +246,10 @@ div:has(> div > aside > nav), div:has(> div > div > aside > nav) { background: v
 :is(:root[data-kyoube-shell="studio"] aside:has(> nav button > svg.lucide-square-pen), aside:has([data-kyoube-studio="team"])) nav a:is([href$="/routines"], [href$="/artifacts"], [href$="/skills"]):not([data-kyoube-nav]),
 :is(:root[data-kyoube-shell="studio"] aside:has(> nav button > svg.lucide-square-pen), aside:has([data-kyoube-studio="team"])) nav div:not([class]):has(> a:is([href$="/routines"], [href$="/artifacts"], [href$="/skills"]):not([data-kyoube-nav])) { display: none; }
 
-/* The stock Agents and Organization sections are replaced by the Studio
-   Team roster and the Workspace page. The Work section also contains agent
-   and /org links (inside the roster), hence the :not(). */
-:is(:root[data-kyoube-shell="studio"] aside:has(> nav button > svg.lucide-square-pen), aside:has([data-kyoube-studio="team"])) nav > div:has(a[href*="/agents/"]):not(:has([data-kyoube-studio])),
-:is(:root[data-kyoube-shell="studio"] aside:has(> nav button > svg.lucide-square-pen), aside:has([data-kyoube-studio="team"])) nav > div:has(button[aria-label="New agent"]):not(:has([data-kyoube-studio])),
-:is(:root[data-kyoube-shell="studio"] aside:has(> nav button > svg.lucide-square-pen), aside:has([data-kyoube-studio="team"])) nav > div:has(a[href$="/org"]):not(:has([data-kyoube-studio])),
-:is(:root[data-kyoube-shell="studio"] aside:has(> nav button > svg.lucide-square-pen), aside:has([data-kyoube-studio="team"])) nav > div:has(a[href$="/company/settings"]):not(:has([data-kyoube-studio])) { display: none; }
+/* The Org section (Agents, Skills, Connectors, Audit) moves to the Workspace
+   page; the Studio Team roster above it replaces the agent list. Found by
+   holding both its first and its last link, which no other section does. */
+:is(:root[data-kyoube-shell="studio"] aside:has(> nav button > svg.lucide-square-pen), aside:has([data-kyoube-studio="team"])) nav > div:has(a[href$="/agents"]):has(a[href$="/activity"]):not(:has([data-kyoube-studio])) { display: none; }
 
 /* Terminal lives on the Workspace page. */
 :is(:root[data-kyoube-shell="studio"] aside:has(> nav button > svg.lucide-square-pen), aside:has([data-kyoube-studio="team"])) nav div:has(> [data-kyoube-nav="terminal"]) { display: none; }
@@ -280,12 +277,12 @@ div:has(> div > aside > nav), div:has(> div > div > aside > nav) { background: v
 main div:has(> div > [data-kyoube-page]) > div:first-child:has(> a[href$="/dashboard"]):not(:has([data-kyoube-page])) { display: none; }
 
 /* ── The core agent page ──────────────────────────────────────────────── */
-/* An agent's page is the Studio profile (/team/<agent>); the core's own tabs
-   (Instructions, Skills, Configuration, Runs, …) keep the core header, set
-   like the profile's: the name in the display face. The Studio plugin paints
-   the agent's character over the header icon, since only it knows which
-   agent is on screen. Recognised by the page's own tab bar. */
-:root[data-kyoube-shell="studio"] main:has([role="tab"][id$="-trigger-instructions"]):has([role="tab"][id$="-trigger-budget"]) div:has(> button[data-slot="popover-trigger"]) > div h2 {
+/* An agent's page is the Studio profile (/team/<agent>); the core's own views
+   (Instructions, Skills, Harness / Runtime, …) keep the core header, set like
+   the profile's: the name in the display face. The Studio plugin paints the
+   agent's character over the header avatar, since only it knows which agent
+   is on screen. Recognised by the page's agent-settings-content wrapper. */
+:root[data-kyoube-shell="studio"] .agent-settings-content > header h1 {
   font-family: var(--kyoube-font-display);
   font-weight: 400;
   font-size: 34px;
@@ -293,6 +290,13 @@ main div:has(> div > [data-kyoube-page]) > div:first-child:has(> a[href$="/dashb
   letter-spacing: -0.01em;
 }
 
+/* The core paints every section of the agent overview with --card, which it
+   sets equal to --background in dark mode. KyoubeAI's cards are a step lighter
+   than the page, so the overview's borderless sections (Recent tasks, Audit)
+   would sit in grey bands; they sit on the page instead. The bordered cards
+   keep the card colour. */
+.agent-settings-overview section:not(.border) { background-color: transparent; }
+
 /* ── Home (the dashboard) ──────────────────────────────────────────────── */
 /* The Studio Home widget renders in the dashboard's plugin-widget slot,
    which sits below the stock charts. Lift it to the top, full width, without
PATCH
````

- [ ] **Step 7: Cut the 2026.916.1 fixture from the pristine core and drop the old one**

```bash
dist="$(mktemp -d)/dist"
id=$(docker create ghcr.io/paperclipai/paperclip:2026.916.1)
docker cp "$id":/app/ui/dist "$dist" && docker rm "$id"
node docker/theme/tests/fixtures/extract.mjs "$dist" docker/theme/tests/fixtures/core-2026.916.1.mjs
git rm -q docker/theme/tests/fixtures/core-2026.831.1.mjs
```

Expected: `wrote docker/theme/tests/fixtures/core-2026.916.1.mjs: 19 regions, 5320 characters, 52/52 tokens`.

- [ ] **Step 8: Run the theme and Studio tests**

```bash
pnpm -C docker/theme test && pnpm -C plugins/kyoube-studio test
```

Expected: theme `Tests  18 passed (18)`; Studio `Tests  64 passed (64)`.

- [ ] **Step 9: Prove the theme against the real bundle, after the patches, as the Dockerfile runs it**

```bash
docker run --rm --user root --entrypoint bash -v "$PWD/docker:/src:ro" ghcr.io/paperclipai/paperclip:2026.916.1 -c '
  mkdir -p /opt/kyoube/core-patches /opt/kyoube/theme
  cp /src/core-patches/*.mjs /opt/kyoube/core-patches/
  cp /src/theme/theme.mjs /src/theme/rules.mjs /src/theme/anchors.mjs /src/theme/theme.css /src/theme/boot.js /opt/kyoube/theme/
  cp -r /src/theme/fonts /opt/kyoube/theme/fonts
  gosu node node /opt/kyoube/core-patches/apply.mjs --root /app >/dev/null
  gosu node node /opt/kyoube/theme/theme.mjs --root /app --theme /opt/kyoube/theme --report'
```

Expected:

```
theme: 8 text rules applied in 2 file(s): home-sidebar-label 2/2, home-breadcrumb 1/1, home-live-runs-breadcrumb 1/1, home-live-runs-backlink 1/1, home-command-palette 1/1, connectors-breadcrumbs 3/3, plugin-page-title 1/1, dark-by-default 1/1
theme: anchors 16/16; sidebar sections top=6, work=8, org=4
theme: 52 core tokens overridden, all still declared by the core
theme: linked /assets/kyoube-theme.css after the core stylesheet; 5 font files in /fonts/kyoube
```

- [ ] **Step 10: Commit**

```bash
git add docker/theme plugins/kyoube-studio/tests/links.spec.ts
git commit -F - <<'MSG'
feat(theme): target core 2026.916.1's streamlined shell

Hide the new Org section (its links are on the Workspace page), find the
rebuilt agent page by its wrapper and avatar label, keep the overview's
borderless sections off grey bands, and swap the Connections renames for
the three breadcrumbs upstream still calls "Apps". The legacy-shell rules
and checks go; the fixture is cut from 2026.916.1.
MSG
```

---

### Task 4: Rebrand sweep allowlist for 2026.916.1

**Files:**
- Modify: `docker/rebrand/lib/files.mjs` (`SWEEP_ALLOWLIST` and its comment)
- Test: `docker/rebrand/tests/rebrand.spec.mjs` (two tests in "the whole-image sweep")

**Interfaces:**
- Consumes: `runRebrand({ root, brandDir, verify, report, log })` returning `{ sweep, sweepFailures, … }` (unchanged).
- Produces: `SWEEP_ALLOWLIST` gains `.env.example`, `announcements`, `ui/connect-flow-preview.html`, `ui/connect-model-preview.html`.

- [ ] **Step 1: Write the failing tests**

````bash
git apply <<'PATCH'
diff --git a/docker/rebrand/tests/rebrand.spec.mjs b/docker/rebrand/tests/rebrand.spec.mjs
index f83e782..b093af5 100644
--- a/docker/rebrand/tests/rebrand.spec.mjs
+++ b/docker/rebrand/tests/rebrand.spec.mjs
@@ -224,6 +224,28 @@ describe("runRebrand", () => {
       expect(result.codeShaped.join("\n")).toContain("packages/foo/src/y.ts");
     });
 
+    it("allows the upstream development material core 2026.916 added", async () => {
+      const { root, brandDir } = await makeTree({
+        "announcements/examples/staging/current.json": '{ "alt": "Paperclip. Ideas become work." }\n',
+        "ui/connect-flow-preview.html": "<title>Connect flow — Paperclip onboarding</title>\n",
+        "ui/connect-model-preview.html": "<title>Connect a model — Paperclip onboarding</title>\n",
+        ".env.example": "# Optional Paperclip ID Gmail OAuth broker.\n",
+      });
+      const result = await runRebrand({ root, brandDir, verify: true, report: false, log: () => {} });
+      expect(result.sweepFailures).toEqual([]);
+      expect(result.sweep.announcements).toBe(1);
+      expect(result.sweep["ui/connect-flow-preview.html"]).toBe(1);
+      expect(result.sweep["ui/connect-model-preview.html"]).toBe(1);
+      expect(result.sweep[".env.example"]).toBe(1);
+    });
+
+    it("still fails on a preview page or root file nobody has triaged", async () => {
+      const preview = await makeTree({ "ui/other-preview.html": "<title>Paperclip preview</title>\n" });
+      await expect(runRebrand({ ...preview, verify: true, report: false, log: () => {} })).rejects.toThrow(/sweep: ui still carries 1 display match/);
+      const rootFile = await makeTree({ "NOTICE.txt": "Paperclip is great.\n" });
+      await expect(runRebrand({ ...rootFile, verify: true, report: false, log: () => {} })).rejects.toThrow(/sweep: \. still carries 1 display match/);
+    });
+
     it("prints the table, the code-shaped list and the skipped counts under --report", async () => {
       const { root, brandDir } = await makeTree();
       const lines = [];
PATCH
````

- [ ] **Step 2: Run them and watch the allowlist test fail**

```bash
pnpm -C docker/rebrand test
```

Expected: `Tests  1 failed | 94 passed (95)`; the failure is `allows the upstream development material core 2026.916 added`, with `sweep: announcements still carries 1 display match(es)`.

- [ ] **Step 3: Allowlist the new upstream development material**

````bash
git apply <<'PATCH'
diff --git a/docker/rebrand/lib/files.mjs b/docker/rebrand/lib/files.mjs
index c734b4d..5f7bde9 100644
--- a/docker/rebrand/lib/files.mjs
+++ b/docker/rebrand/lib/files.mjs
@@ -61,7 +61,8 @@ export function isCodeFile(relToRoot) {
  * upstream name in: material shipped in the image that the running product
  * never reads. Everything else must be zero after the transform, or `--verify`
  * fails the build. Determined empirically by running the sweep against
- * `ghcr.io/paperclipai/paperclip:2026.831.1` and triaging every row.
+ * `ghcr.io/paperclipai/paperclip:2026.831.1` and triaging every row (and again
+ * on each core bump; entries marked 2026.916 were added for that release).
  *
  * - `ui/src`, `ui/storybook`, `ui/index.html`, `ui/public`, `ui/README.md`,
  *   `ui/package.json`: the board is served from `ui/dist`, which is NOT
@@ -78,6 +79,15 @@ export function isCodeFile(relToRoot) {
  * - `.claude`, `.github`, `design`, `docker`, `evals`, `patches`, `releases`,
  *   `report`, `screenshots`, `scripts`, `tests`, `tools`: upstream's own
  *   development material.
+ * - `announcements` (2026.916): the source of upstream's hosted announcement
+ *   feed and its examples. The server fetches the feed from
+ *   PAPERCLIP_ANNOUNCEMENTS_FEED_URL and never reads this tree, and
+ *   docker-compose.yml turns announcements off.
+ * - `ui/connect-flow-preview.html`, `ui/connect-model-preview.html` (2026.916):
+ *   Vite entry points for upstream's onboarding previews, like `ui/index.html`;
+ *   the board is served from `ui/dist`.
+ * - `.env.example` (2026.916): upstream's sample environment file; the image
+ *   never reads it (KyoubeAI's own is the one in this repository).
  *
  * An entry may be a multi-segment prefix or an exact file path; the longest
  * match names the row a file is counted under, otherwise it is counted under
@@ -85,8 +95,10 @@ export function isCodeFile(relToRoot) {
  */
 export const SWEEP_ALLOWLIST = [
   ".claude",
+  ".env.example",
   ".github",
   "LICENSE",
+  "announcements",
   "cli",
   "design",
   "doc/plans",
@@ -104,6 +116,8 @@ export const SWEEP_ALLOWLIST = [
   "tests",
   "tools",
   "ui/README.md",
+  "ui/connect-flow-preview.html",
+  "ui/connect-model-preview.html",
   "ui/index.html",
   "ui/package.json",
   "ui/public",
PATCH
````

- [ ] **Step 4: Run the tests again**

```bash
pnpm -C docker/rebrand test
```

Expected: `Tests  95 passed (95)`.

- [ ] **Step 5: Prove the whole transform chain on the real image**

```bash
docker run --rm --user root --entrypoint bash -v "$PWD/docker:/src:ro" ghcr.io/paperclipai/paperclip:2026.916.1 -c '
  mkdir -p /opt/kyoube/core-patches /opt/kyoube/theme /opt/kyoube/rebrand
  cp /src/core-patches/*.mjs /opt/kyoube/core-patches/
  cp /src/theme/theme.mjs /src/theme/rules.mjs /src/theme/anchors.mjs /src/theme/theme.css /src/theme/boot.js /opt/kyoube/theme/
  cp -r /src/theme/fonts /opt/kyoube/theme/fonts; cp -r /src/brand /opt/kyoube/brand
  cp /src/rebrand/rebrand.mjs /opt/kyoube/rebrand/; cp -r /src/rebrand/lib /opt/kyoube/rebrand/lib
  gosu node node /opt/kyoube/core-patches/apply.mjs --root /app >/dev/null
  gosu node node /opt/kyoube/theme/theme.mjs --root /app --theme /opt/kyoube/theme >/dev/null
  gosu node node /opt/kyoube/rebrand/rebrand.mjs --root /app --brand /opt/kyoube/brand --verify --report 2>&1 | grep -E "^rebrand: [0-9]+ files|anchors lockup|code-shaped"'
```

Expected:

```
rebrand: 1213 files rewritten (name 7432, phrase 336, url 269), 269 assets renamed, 1443 references rewritten
rebrand: anchors lockup=1 thinking=1; residual 0; binaries skipped 0; symlinks skipped 0
rebrand: code-shaped matches left alone: 0
```

- [ ] **Step 6: Commit**

```bash
git add docker/rebrand/lib/files.mjs docker/rebrand/tests/rebrand.spec.mjs
git commit -F - <<'MSG'
fix(rebrand): allowlist core 2026.916.1's new development material
MSG
```

---

### Task 5: Studio follows the rebuilt agent page and the new routes (kyoube.studio 0.2.0)

**Files:**
- Modify: `plugins/kyoube-studio/src/ui/agent-route.ts` (whole file), `src/ui/links.ts`, `src/ui/nav.tsx`, `src/ui/Home.tsx`, `src/profile.ts`, `src/ui/Profile.tsx`, `src/manifest.ts`, `package.json`
- Test: `plugins/kyoube-studio/tests/agent-route.spec.ts`, `tests/profile.spec.ts`, `tests/ui.spec.tsx`, `tests/links.spec.ts`

**Interfaces:**
- Consumes: `characterFor(icon, name): { tint, svg }` from `src/characters.ts` (unchanged); `SECTIONS` from Task 3.
- Produces: `coreAgentPage(pathname): { ref: string; tab: string } | null` (default tab is now `"overview"`); `agentRedirectTarget(pathname, search): string | null`; `CORE_AGENT_HEADER = ".agent-settings-content > header"`; `cssString(value: string): string`; `coreAvatarCss({ name, icon }): string`. `CORE_AGENT_PAGE_SCOPE` and the icon list are removed; `nav.tsx` keeps calling `agentRedirectTarget`, `coreAgentPage` and `coreAvatarCss` with the same signatures.

- [ ] **Step 1: Write the failing tests**

````bash
git apply <<'PATCH'
diff --git a/plugins/kyoube-studio/tests/agent-route.spec.ts b/plugins/kyoube-studio/tests/agent-route.spec.ts
index ab2ba5b..53bd75f 100644
--- a/plugins/kyoube-studio/tests/agent-route.spec.ts
+++ b/plugins/kyoube-studio/tests/agent-route.spec.ts
@@ -1,10 +1,10 @@
 import { describe, expect, it } from "vitest";
-import { CORE_AGENT_PAGE_SCOPE, agentRedirectTarget, coreAgentPage, coreAvatarCss } from "../src/ui/agent-route.js";
+import { CORE_AGENT_HEADER, agentRedirectTarget, coreAgentPage, coreAvatarCss, cssString } from "../src/ui/agent-route.js";
 import { assignTask, BoardApiError, boardPost, setAgentOnDuty } from "../src/ui/board-api.js";
 
 describe("the core agent page", () => {
-  it("recognises agent URLs and their tab, but not the list or the new-agent page", () => {
-    expect(coreAgentPage("/BAP/agents/ai-manager")).toEqual({ ref: "ai-manager", tab: "dashboard" });
+  it("recognises agent URLs and their view, but not the list or the new-agent page", () => {
+    expect(coreAgentPage("/BAP/agents/ai-manager")).toEqual({ ref: "ai-manager", tab: "overview" });
     expect(coreAgentPage("/BAP/agents/ai-manager/instructions")).toEqual({ ref: "ai-manager", tab: "instructions" });
     expect(coreAgentPage("/BAP/agents/ai-manager/runs/run-1")).toBeNull();
     expect(coreAgentPage("/BAP/agents/all")).toBeNull();
@@ -12,24 +12,31 @@ describe("the core agent page", () => {
     expect(coreAgentPage("/BAP/team/ai-manager")).toBeNull();
   });
 
-  it("sends only the default view to the profile, and keeps the classic view on request", () => {
+  it("sends only the default view to the profile, under either name, and keeps the classic view on request", () => {
     expect(agentRedirectTarget("/BAP/agents/ai-manager", "")).toBe("/team/ai-manager");
+    expect(agentRedirectTarget("/BAP/agents/ai-manager/overview", "")).toBe("/team/ai-manager");
+    expect(agentRedirectTarget("/BAP/agents/ai-manager/overview/", "?x=1")).toBe("/team/ai-manager");
+    // The name before core 2026.916; old links and bookmarks still carry it.
     expect(agentRedirectTarget("/BAP/agents/ai-manager/dashboard", "")).toBe("/team/ai-manager");
-    expect(agentRedirectTarget("/BAP/agents/ai-manager/dashboard/", "?x=1")).toBe("/team/ai-manager");
-    expect(agentRedirectTarget("/BAP/agents/ai-manager/dashboard", "?classic=1")).toBeNull();
-    expect(agentRedirectTarget("/BAP/agents/ai-manager/configuration", "")).toBeNull();
+    expect(agentRedirectTarget("/BAP/agents/ai-manager/overview", "?classic=1")).toBeNull();
+    expect(agentRedirectTarget("/BAP/agents/ai-manager/runtime", "")).toBeNull();
+    expect(agentRedirectTarget("/BAP/agents/ai-manager/instructions", "")).toBeNull();
     expect(agentRedirectTarget("/BAP/agents/all", "")).toBeNull();
   });
 
-  it("paints the agent's character over the header icon of that agent only", () => {
+  it("paints the agent's character over that agent's header avatar only", () => {
     const css = coreAvatarCss({ name: "AI Delivery Lead", icon: "rocket" });
-    expect(css).toContain(CORE_AGENT_PAGE_SCOPE);
-    expect(css).toContain('button[data-slot="popover-trigger"]:has(> svg.lucide-rocket)');
+    expect(css).toContain(`${CORE_AGENT_HEADER} [role="img"][aria-label="AI Delivery Lead avatar"]`);
     expect(css).toContain('url("data:image/svg+xml;charset=utf-8,%3Csvg');
     expect(css).toContain("var(--kyoube-tile-sky");
-    // No icon, or one the core does not know, renders as the core's default: bot.
-    expect(coreAvatarCss({ name: "AI Manager", icon: null })).toContain("svg.lucide-bot");
-    expect(coreAvatarCss({ name: "AI Manager", icon: "not-real" })).toContain("svg.lucide-bot");
+    expect(css).toContain("> * { opacity: 0; }");
+  });
+
+  it("quotes an agent name that would otherwise break the selector", () => {
+    expect(cssString('Ada "The Builder"')).toBe('"Ada \\"The Builder\\""');
+    expect(cssString("back\\slash")).toBe('"back\\\\slash"');
+    expect(cssString("two\nlines")).toBe('"two lines"');
+    expect(coreAvatarCss({ name: 'Ada "The Builder"', icon: null })).toContain('[aria-label="Ada \\"The Builder\\" avatar"]');
   });
 });
 
diff --git a/plugins/kyoube-studio/tests/profile.spec.ts b/plugins/kyoube-studio/tests/profile.spec.ts
index 1f9c500..931c5e4 100644
--- a/plugins/kyoube-studio/tests/profile.spec.ts
+++ b/plugins/kyoube-studio/tests/profile.spec.ts
@@ -84,13 +84,13 @@ describe("buildProfile", () => {
     expect(agentSkills({ id: "x", name: "x", status: "idle" })).toEqual([]);
   });
 
-  it("links the core's own tabs and keeps the classic dashboard reachable", () => {
+  it("links the core's own agent views, its runs under Audit, and keeps the core overview reachable", () => {
     expect(profileOf("writer").links).toEqual({
       instructions: "/agents/ambassador-content-agent/instructions",
       skills: "/agents/ambassador-content-agent/skills",
-      runs: "/agents/ambassador-content-agent/runs",
-      settings: "/agents/ambassador-content-agent/configuration",
-      classic: "/agents/ambassador-content-agent/dashboard?classic=1",
+      runs: "/activity/runs?agentId=writer",
+      settings: "/agents/ambassador-content-agent/runtime",
+      classic: "/agents/ambassador-content-agent/overview?classic=1",
     });
   });
 
diff --git a/plugins/kyoube-studio/tests/ui.spec.tsx b/plugins/kyoube-studio/tests/ui.spec.tsx
index ea7364f..d0a3e8a 100644
--- a/plugins/kyoube-studio/tests/ui.spec.tsx
+++ b/plugins/kyoube-studio/tests/ui.spec.tsx
@@ -133,8 +133,10 @@ describe("Workspace", () => {
     installBridge({ workspace: { agents: 5, people: 2, projects: 3, openTasks: 7, isAdmin: false } });
     const html = render(WorkspacePage);
     expect(html).toContain('data-kyoube-page="workspace"');
-    expect(html).toContain('href="/BAP/org"');
+    expect(html).toContain('href="/BAP/agents/all"');
+    expect(html).toContain('href="/BAP/activity/costs"');
     expect(html).toContain('href="/BAP/apps"');
+    expect(html).not.toContain('href="/BAP/org"');
     expect(html).toContain("5 agents");
     expect(html).not.toContain('href="/BAP/terminal"');
     installBridge({ workspace: { agents: 1, people: 1, projects: 0, openTasks: 0, isAdmin: true } });
@@ -180,7 +182,7 @@ describe("agent profile", () => {
     stats: { doneThisWeek: 9, open: 3, spentMonthlyCents: 310, budgetMonthlyCents: 0 },
     skills: ["Kyoube Data", "Humanizer"],
     worksWith: [{ id: "m1", name: "AI Manager", icon: null, href: "/team/ai-manager", relation: "Its manager" }],
-    links: { instructions: "/agents/ambassador-content-agent/instructions", skills: "/agents/ambassador-content-agent/skills", runs: "/agents/ambassador-content-agent/runs", settings: "/agents/ambassador-content-agent/configuration", classic: "/agents/ambassador-content-agent/dashboard?classic=1" },
+    links: { instructions: "/agents/ambassador-content-agent/instructions", skills: "/agents/ambassador-content-agent/skills", runs: "/activity/runs?agentId=writer", settings: "/agents/ambassador-content-agent/runtime", classic: "/agents/ambassador-content-agent/overview?classic=1" },
   };
 
   it("parses the team path", () => {
@@ -199,14 +201,15 @@ describe("agent profile", () => {
     expect(html).toContain('role="switch" aria-checked="true"');
     expect(html).toContain(">On duty");
     expect(html).toContain('href="/BAP/agents/ambassador-content-agent/instructions"');
-    expect(html).toContain('href="/BAP/agents/ambassador-content-agent/configuration"');
+    expect(html).toContain('href="/BAP/agents/ambassador-content-agent/runtime"');
+    expect(html).toContain('href="/BAP/activity/runs?agentId=writer"');
     expect(html).toContain("Working now");
     expect(html).toContain("Writing post 2");
     expect(html).toContain('href="/BAP/issues/BAP-45"');
     expect(html).toContain("Kyoube Data");
     expect(html).toContain("Its manager");
     expect(html).toContain("Tasks done this week");
-    expect(html).toContain('href="/BAP/agents/ambassador-content-agent/dashboard?classic=1"');
+    expect(html).toContain('href="/BAP/agents/ambassador-content-agent/overview?classic=1"');
   });
 
   it("shows the task lists on the Tasks tab", () => {
PATCH
````

Then, in `plugins/kyoube-studio/tests/links.spec.ts`, add after the test `has a card for every link the theme hides from the sidebar`:

```ts
  it("links the core's canonical routes, not the ones it only redirects", () => {
    // Core 2026.916 folded the org chart into All agents and moved timeline and costs under Audit.
    expect(routes.filter((to) => ["/org", "/timeline", "/costs"].includes(to))).toEqual([]);
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm -C plugins/kyoube-studio test
```

Expected: `Tests  7 failed | 59 passed (66)`: the four agent-route tests, `links the core's canonical routes…`, the profile links test and `Workspace > links every card into the app…`.

- [ ] **Step 3: Rewrite the agent route module**

Replace `plugins/kyoube-studio/src/ui/agent-route.ts` with:

````ts
/**
 * How the Studio layout meets the core's own agent page (`/<co>/agents/<ref>/<view>`).
 *
 * The core page has fixed views and no plugin slot, so the Concept C profile
 * is a Studio page (`/<co>/team/<ref>`). The core page's default view sends
 * people to the profile instead: "overview" since core 2026.916, "dashboard"
 * before it, and the bare agent URL, which the core resolves to its default.
 * Its other views (Instructions, Skills, Harness / Runtime, …) stay the
 * core's, with the agent's character in their header. `?classic=1` keeps the
 * core's own overview.
 */
import { characterFor } from "../characters.js";

const CORE_AGENT_PAGE = /^\/[^/]+\/agents\/([^/]+)(?:\/([^/]+))?\/?$/;
const NOT_AN_AGENT = new Set(["new", "all"]);
/** The core's default agent view, under its current and its previous name. */
const DEFAULT_VIEWS = new Set(["overview", "dashboard"]);

/** The agent a core agent URL is about, and which view, or null for other pages. */
export function coreAgentPage(pathname: string): { ref: string; tab: string } | null {
  const match = CORE_AGENT_PAGE.exec(pathname);
  if (!match) return null;
  const ref = decodeURIComponent(match[1]!);
  if (NOT_AN_AGENT.has(ref)) return null;
  return { ref, tab: match[2] ? decodeURIComponent(match[2]) : "overview" };
}

/** Where the Studio layout sends a core agent URL: its default view goes to the profile; everything else stays. */
export function agentRedirectTarget(pathname: string, search: string): string | null {
  if (/(?:^|[?&])classic=1(?:&|$)/.test(search)) return null;
  const page = coreAgentPage(pathname);
  if (!page || !DEFAULT_VIEWS.has(page.tab)) return null;
  return `/team/${encodeURIComponent(page.ref)}`;
}

/**
 * The core agent page's header, recognised by the page's own wrapper: every
 * view renders inside `.agent-settings-content`, whose first `<header>` holds
 * the agent's avatar and name.
 */
export const CORE_AGENT_HEADER = ".agent-settings-content > header";

/** `value` as a double-quoted CSS string, safe inside an attribute selector. */
export function cssString(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&").replace(/[\r\n\f]/g, " ")}"`;
}

/**
 * CSS that paints an agent's character over the avatar in the core agent
 * page's header, for the agent on screen. The core labels that avatar
 * "<agent name> avatar" (role="img"), so the rule matches that agent's header
 * only, and when the core changes that markup the selector simply stops
 * matching.
 */
export function coreAvatarCss(agent: { name: string; icon: string | null }): string {
  const { tint, svg } = characterFor(agent.icon, agent.name);
  const avatar = `${CORE_AGENT_HEADER} [role="img"][aria-label=${cssString(`${agent.name} avatar`)}]`;
  const image = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
  return [
    `${avatar} { background: ${image} center / 100% no-repeat, var(--kyoube-tile-${tint}, #e9e9ec); width: 56px; height: 56px; border-radius: 30%; }`,
    `${avatar} > * { opacity: 0; }`,
  ].join("\n");
}
````

- [ ] **Step 4: Point the links at the core's canonical routes and bump the version**

````bash
git apply <<'PATCH'
diff --git a/plugins/kyoube-studio/src/ui/links.ts b/plugins/kyoube-studio/src/ui/links.ts
index 5d62429..c9f13d9 100644
--- a/plugins/kyoube-studio/src/ui/links.ts
+++ b/plugins/kyoube-studio/src/ui/links.ts
@@ -22,27 +22,27 @@ export interface WorkspaceGroup {
 
 /**
  * Everything the Studio sidebar moves off the sidebar. docker/theme hides the
- * core's Organization section (and Artifacts, Skills and Terminal), so every
- * link it hid must have a card here: docker/theme/anchors.mjs lists the
- * Organization routes it expects, and tests/links.spec.ts checks each one
- * appears below.
+ * core's Org section (and Artifacts, Skills and Terminal), so every link it
+ * hid must have a card here: docker/theme/anchors.mjs lists the Org routes it
+ * expects, and tests/links.spec.ts checks each one appears below. Routes are
+ * the core's canonical ones (2026.916 moved the org chart onto All agents and
+ * timeline and costs under Audit).
  */
 export const WORKSPACE_GROUPS: WorkspaceGroup[] = [
   {
     title: "People and agents",
     cards: [
       { id: "team", title: "Team", description: "Every agent's profile and what it is doing now.", to: "/team", icon: "users", tone: "teal", meta: "agents" },
-      { id: "org", title: "Org chart", description: "Who reports to whom, people and agents together.", to: "/org", icon: "org", tone: "teal" },
-      { id: "agents", title: "All agents", description: "Every agent in one table, with model and controls.", to: "/agents/all", icon: "sliders", tone: "teal" },
+      { id: "agents", title: "All agents", description: "Every agent as a list or an org chart, with model and controls.", to: "/agents/all", icon: "org", tone: "teal" },
       { id: "members", title: "Members and invites", description: "Invite people and choose what they can do.", to: "/company/settings/members", icon: "mail", tone: "sky", meta: "people" },
     ],
   },
   {
     title: "Oversight",
     cards: [
-      { id: "activity", title: "Activity", description: "Every change people and agents made, newest first.", to: "/activity", icon: "history", tone: "sky" },
-      { id: "timeline", title: "Timeline", description: "Tasks and runs laid out over time.", to: "/timeline", icon: "timeline", tone: "sky" },
-      { id: "costs", title: "Costs", description: "Spend by agent, project and model, with budgets.", to: "/costs", icon: "dollar", tone: "amber" },
+      { id: "activity", title: "Audit", description: "Every change people and agents made, newest first.", to: "/activity", icon: "history", tone: "sky" },
+      { id: "timeline", title: "Timeline", description: "Tasks and runs laid out over time.", to: "/activity/timeline", icon: "timeline", tone: "sky" },
+      { id: "costs", title: "Costs", description: "Spend by agent, project and model, with budgets.", to: "/activity/costs", icon: "dollar", tone: "amber" },
       { id: "approvals", title: "Approvals", description: "Decisions agents are waiting on.", to: "/approvals", icon: "shield", tone: "amber" },
     ],
   },
@@ -52,7 +52,7 @@ export const WORKSPACE_GROUPS: WorkspaceGroup[] = [
       { id: "skills", title: "Skills", description: "Reusable know-how you can give to agents.", to: "/skills", icon: "book", tone: "violet" },
       { id: "artifacts", title: "Artifacts", description: "Files and documents agents produced.", to: "/artifacts", icon: "package", tone: "violet" },
       { id: "projects", title: "Projects", description: "Every project and its working folder.", to: "/projects", icon: "folder", tone: "violet", meta: "projects" },
-      { id: "connections", title: "Connections", description: "Outside tools your agents are allowed to use.", to: "/apps", icon: "plug", tone: "rose" },
+      { id: "connectors", title: "Connectors", description: "Outside tools your agents are allowed to use.", to: "/apps", icon: "plug", tone: "rose" },
     ],
   },
   {
diff --git a/plugins/kyoube-studio/src/ui/nav.tsx b/plugins/kyoube-studio/src/ui/nav.tsx
index 6cc128e..e42129c 100644
--- a/plugins/kyoube-studio/src/ui/nav.tsx
+++ b/plugins/kyoube-studio/src/ui/nav.tsx
@@ -106,7 +106,7 @@ export function StudioTeam(_props: PluginSidebarProps) {
   return (
     <div data-kyoube-studio="team" className="ks-team">
       <SectionLabel text={total > 0 ? `Team · ${total}` : "Team"}>
-        <a {...navigation.linkProps("/org")} className="ks-icon-btn" title="Org chart" aria-label="Org chart"><Icon name="org" size={14} /></a>
+        <a {...navigation.linkProps("/agents/all")} className="ks-icon-btn" title="All agents and the org chart" aria-label="All agents and the org chart"><Icon name="org" size={14} /></a>
         <a {...navigation.linkProps("/agents/new")} className="ks-icon-btn" title="Hire an agent" aria-label="Hire an agent"><Icon name="plus" size={14} /></a>
       </SectionLabel>
       {team.loading ? (
diff --git a/plugins/kyoube-studio/src/ui/Home.tsx b/plugins/kyoube-studio/src/ui/Home.tsx
index 3d65ae9..d51d1b4 100644
--- a/plugins/kyoube-studio/src/ui/Home.tsx
+++ b/plugins/kyoube-studio/src/ui/Home.tsx
@@ -81,7 +81,7 @@ export function StudioHome(_props: PluginWidgetProps) {
             <span className="ks-step-text"><b>Give it a task</b><span>Plain words are enough</span></span>
           </a>
           <span className="ks-arrow" aria-hidden="true"><Icon name="arrow" size={18} /></span>
-          <a {...navigation.linkProps("/org")} className="ks-step" data-done={steps.teamwork}>
+          <a {...navigation.linkProps("/agents/all")} className="ks-step" data-done={steps.teamwork}>
             <span className="ks-check" data-done={steps.teamwork}>{steps.teamwork ? <Icon name="check" size={12} /> : "3"}</span>
             <span className="ks-step-text"><b>Let the team work together</b><span>Agents hand work to each other and keep memory</span></span>
             {team.length > 0 ? (
diff --git a/plugins/kyoube-studio/src/profile.ts b/plugins/kyoube-studio/src/profile.ts
index 9fe4a91..963578f 100644
--- a/plugins/kyoube-studio/src/profile.ts
+++ b/plugins/kyoube-studio/src/profile.ts
@@ -70,7 +70,7 @@ export interface AgentProfile {
   stats: { doneThisWeek: number; open: number; spentMonthlyCents: number; budgetMonthlyCents: number };
   skills: string[];
   worksWith: WorkRelation[];
-  /** The core's own agent tabs, for the profile's tab row. */
+  /** The core's own agent pages, for the profile's tab row. */
   links: { instructions: string; skills: string; runs: string; settings: string; classic: string };
 }
 
@@ -100,7 +100,7 @@ export function profileHref(agent: Pick<AgentLike, "id" | "urlKey">): string {
   return `/team/${encodeURIComponent(agent.urlKey || agent.id)}`;
 }
 
-/** One of the core's own agent pages (instructions, skills, runs, configuration, dashboard). */
+/** One of the core's own agent views (instructions, skills, runtime, overview). */
 export function coreAgentHref(agent: Pick<AgentLike, "id" | "urlKey">, tab: string): string {
   return `/agents/${encodeURIComponent(agent.urlKey || agent.id)}/${tab}`;
 }
@@ -235,9 +235,10 @@ export function buildProfile(
     links: {
       instructions: coreAgentHref(agent, "instructions"),
       skills: coreAgentHref(agent, "skills"),
-      runs: coreAgentHref(agent, "runs"),
-      settings: coreAgentHref(agent, "configuration"),
-      classic: `${coreAgentHref(agent, "dashboard")}?classic=1`,
+      // Since core 2026.916 an agent's runs live under Audit, filtered to it.
+      runs: `/activity/runs?agentId=${encodeURIComponent(agent.id)}`,
+      settings: coreAgentHref(agent, "runtime"),
+      classic: `${coreAgentHref(agent, "overview")}?classic=1`,
     },
   };
 }
diff --git a/plugins/kyoube-studio/src/ui/Profile.tsx b/plugins/kyoube-studio/src/ui/Profile.tsx
index fbc2942..b3d251e 100644
--- a/plugins/kyoube-studio/src/ui/Profile.tsx
+++ b/plugins/kyoube-studio/src/ui/Profile.tsx
@@ -295,7 +295,7 @@ function Profile({ agentRef, view }: { agentRef: string; view: "overview" | "tas
           </div>
         </div>
       )}
-      <p className="ks-classic"><a {...navigation.linkProps(profile.links.classic)}>Run charts and costs in the classic view</a></p>
+      <p className="ks-classic"><a {...navigation.linkProps(profile.links.classic)}>Open the core's own agent overview</a></p>
     </div>
   );
 }
diff --git a/plugins/kyoube-studio/src/manifest.ts b/plugins/kyoube-studio/src/manifest.ts
index 255628f..33cda8d 100644
--- a/plugins/kyoube-studio/src/manifest.ts
+++ b/plugins/kyoube-studio/src/manifest.ts
@@ -3,3 +3,3 @@ import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
 export const PLUGIN_ID = "kyoube.studio";
-export const PLUGIN_VERSION = "0.1.0";
+export const PLUGIN_VERSION = "0.2.0";
 /** The Workspace page's route under a company: `/<prefix>/workspace`. */
diff --git a/plugins/kyoube-studio/package.json b/plugins/kyoube-studio/package.json
index 01ea141..64d3d6d 100644
--- a/plugins/kyoube-studio/package.json
+++ b/plugins/kyoube-studio/package.json
@@ -2,3 +2,3 @@
   "name": "@kyoube/plugin-studio",
-  "version": "0.1.0",
+  "version": "0.2.0",
   "description": "KyoubeAI's Studio layout: the Home page, the team roster and Build group in the sidebar, and the Workspace page (Paperclip plugin)",
PATCH
````

- [ ] **Step 5: Run the tests and the type check**

```bash
pnpm -C plugins/kyoube-studio test && pnpm -C plugins/kyoube-studio typecheck
```

Expected: `Tests  66 passed (66)` and no type errors.

- [ ] **Step 6: Commit**

```bash
git add plugins/kyoube-studio
git commit -F - <<'MSG'
feat(studio): follow core 2026.916.1's agent page and routes (0.2.0)

/agents/<ref> and /agents/<ref>/overview open the Studio profile (the old
/dashboard still does); the character is painted over the core header's
"<name> avatar"; Runs, Settings and the classic link use the core's new
views; the Workspace page, Team and Home link All agents, Audit and the
/activity pages instead of the redirecting /org, /timeline and /costs.
MSG
```

---

### Task 6: Harness versions

**Files:**
- Modify: `docker/Dockerfile:40-64` (`PI_VERSION`, `CLAUDE_CODE_VERSION`, the Hermes pins and their comments)

**Interfaces:**
- Consumes: Tasks 1–5 (the image build runs every transform and builds every plugin).
- Produces: an image whose `claude`, `pi` and `hermes` report the pinned versions.

- [ ] **Step 1: Bump the harness pins**

````bash
git apply <<'PATCH'
diff --git a/docker/Dockerfile b/docker/Dockerfile
index 9aa8af0..c2d898c 100644
--- a/docker/Dockerfile
+++ b/docker/Dockerfile
@@ -39,9 +39,9 @@ RUN pnpm -r build \
 FROM ghcr.io/paperclipai/paperclip:${KYOUBE_CORE_VERSION}
-ARG PI_VERSION=0.85.1
+ARG PI_VERSION=0.87.1
 # Claude Code. The base image installs `@anthropic-ai/claude-code@latest` at
 # *its* build time, so the copy it carries is whatever was current when upstream
-# cut the pinned release (2.1.258 in 2026.831.1). Pinning it here replaces that
+# cut the pinned release (2.1.278 in 2026.916.1). Pinning it here replaces that
 # copy in place -- the same root-owned global install under /usr/local -- so the
 # version is a deliberate, reproducible choice, asserted below.
-ARG CLAUDE_CODE_VERSION=2.1.267
+ARG CLAUDE_CODE_VERSION=2.1.281
 # Hermes publishes release tags (vYYYY.M.D) but no package; the installer clones
@@ -60,6 +60,6 @@ ARG CLAUDE_CODE_VERSION=2.1.267
 # version off `hermes --version`.
-# HERMES_COMMIT is release v2026.9.7.
-ARG HERMES_COMMIT=2237be355906fbe6065ce1815711eee52b2d646e
-ARG HERMES_INSTALLER_SHA256=5854b15670b51a8daae8f59ddfa917062de9f74be261eb73b4b8d719710f8968
-ARG HERMES_VERSION=0.21.1
+# HERMES_COMMIT is release v2026.9.21.
+ARG HERMES_COMMIT=d337b736aa1e8ebecfab043842d13e4a2d2f48a3
+ARG HERMES_INSTALLER_SHA256=00f9080c6452bf87f03ef2fffb4b2c23b9f43f946aaae956e4c547d17e310b22
+ARG HERMES_VERSION=0.21.4
 USER root
PATCH
````

- [ ] **Step 2: Build the image (this is the harness test: the Dockerfile asserts every version)**

```bash
docker build -f docker/Dockerfile --build-arg KYOUBE_VERSION=core916-check -t kyoubeai:core916-check . 2>&1 | tee "$(mktemp -d)/build.log" | grep -E "core-patches:|^#[0-9]+ .*theme:|rebrand: [0-9]+ files|Hermes Agent v|ERROR" 
```

Expected: the build succeeds; the log shows the five `core-patches:` lines, the four `theme:` lines, `rebrand: 1213 files rewritten …` and `Hermes Agent v0.21.4 (…)`. Allow 20–30 minutes on a cold cache (Hermes and Playwright download).

- [ ] **Step 3: Read the versions from the image**

```bash
docker run --rm --entrypoint sh kyoubeai:core916-check -c \
  'claude --version; pi --version; HOME=/tmp HERMES_HOME=/tmp/.hermes hermes --version | head -1'
```

Expected:

```
2.1.281 (Claude Code)
0.87.1
Hermes Agent v0.21.4 (…)
```

- [ ] **Step 4: Remove the check image**

```bash
docker rmi kyoubeai:core916-check
```

- [ ] **Step 5: Commit**

```bash
git add docker/Dockerfile
git commit -F - <<'MSG'
chore(harness): Claude Code 2.1.281, pi 0.87.1, Hermes 0.21.4 (v2026.9.21)
MSG
```

---

### Task 7: Compose defaults for 2026.916: announcements off, `TRUST_PROXY` passed through

**Files:**
- Modify: `docker-compose.yml` (the `app` service's `environment`), `.env.example` (Reachability)

**Interfaces:**
- Consumes: nothing.
- Produces: `PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false"` and `TRUST_PROXY: ${TRUST_PROXY:-}` in the rendered `app` environment.

- [ ] **Step 1: Write the check and watch it fail**

```bash
docker compose -p kyoube-config-check --env-file scripts/smoke.env -f docker-compose.yml config --format json \
  | jq -e '.services.app.environment | .PAPERCLIP_ANNOUNCEMENTS_ENABLED == "false" and has("TRUST_PROXY")'
```

Expected: `false`, exit code 1.

- [ ] **Step 2: Add the two settings**

````bash
git apply <<'PATCH'
diff --git a/docker-compose.yml b/docker-compose.yml
index 10bdab3..d796437 100644
--- a/docker-compose.yml
+++ b/docker-compose.yml
@@ -59,2 +59,11 @@ services:
       BETTER_AUTH_TRUSTED_ORIGINS: ${BETTER_AUTH_TRUSTED_ORIGINS:-}
+      # Since core 2026.916 the server honours X-Forwarded-Host only from a
+      # proxy it trusts. Behind a reverse proxy or tunnel container on the same
+      # Docker network (Caddy, Traefik, nginx, cloudflared) set
+      # TRUST_PROXY=uniquelocal in .env; empty (the default) trusts no proxy,
+      # which is right when people reach the app directly. See docs/upgrading.md.
+      TRUST_PROXY: ${TRUST_PROXY:-}
+      # The core shows Paperclip's hosted announcement cards (upstream's product
+      # news, fetched from its website) unless this is "false".
+      PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false"
       BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?set BETTER_AUTH_SECRET in .env}
diff --git a/.env.example b/.env.example
index 47f96bb..3ad25a7 100644
--- a/.env.example
+++ b/.env.example
@@ -17,2 +17,7 @@ KYOUBE_DEPLOYMENT_EXPOSURE=private
 BETTER_AUTH_TRUSTED_ORIGINS=
+# Behind a reverse proxy or tunnel (Caddy, Traefik, nginx, cloudflared)? The
+# core only believes forwarded headers from a proxy it trusts: `uniquelocal`
+# trusts one on the same Docker network. Leave empty when people reach the app
+# directly.
+TRUST_PROXY=
 
PATCH
````

- [ ] **Step 3: Run the check again**

Run the command from Step 1. Expected: `true`, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml .env.example
git commit -F - <<'MSG'
chore(compose): turn off the core's announcements and pass TRUST_PROXY through
MSG
```

---

### Task 8: Smoke and live checks for 2026.916

**Files:**
- Create: `scripts/onboarding-live-check.mjs`
- Modify: `scripts/studio-live-check.mjs`, `scripts/smoke.sh`, `scripts/migrate-from-0.1.sh` (the legacy-path count)

**Interfaces:**
- Consumes: `launchChrome`, `Cdp`, `Page`, `signIn` from `scripts/lib/cdp.mjs` and `findChrome` from `scripts/lib/headless-chrome.mjs` (unchanged); the skip label from Task 2; the hooks from Tasks 3 and 5.
- Produces: `node scripts/onboarding-live-check.mjs <base-url> <email> <password> <board-token>` (exit 0 pass, 1 fail, 2 no Chrome), called by `scripts/smoke.sh` after the Studio check.

- [ ] **Step 1: Write the onboarding live check**

Create `scripts/onboarding-live-check.mjs`:

````js
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
````

- [ ] **Step 2: Prove the check has teeth: it must fail on an unpatched core**

```bash
docker run -d --name kyoube-onboarding-probe -p 127.0.0.1:3196:3100 \
  -e PORT=3100 -e SERVE_UI=true -e PAPERCLIP_DEPLOYMENT_MODE=authenticated -e PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  -e PAPERCLIP_PUBLIC_URL=http://localhost:3196 -e BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:3196 \
  -e BETTER_AUTH_SECRET=onboarding-probe-secret-0123456789abcdef0123 -e PAPERCLIP_ANNOUNCEMENTS_ENABLED=false \
  ghcr.io/paperclipai/paperclip:2026.916.1
B=http://localhost:3196; J="$(mktemp)"
for i in $(seq 1 90); do curl -fsS $B/api/health >/dev/null 2>&1 && break; sleep 2; done
post() { curl -sS -c "$J" -b "$J" -H 'Content-Type: application/json' -H "Origin: $B" -X POST "$B$1" --data "$2"; }
post /api/auth/sign-up/email '{"name":"Probe","email":"probe@kyoube.local","password":"probe-password-123"}' >/dev/null
post /api/bootstrap/claim '{}' >/dev/null
T=$(post /api/board-api-keys '{"name":"probe"}' | jq -r .token)
node scripts/onboarding-live-check.mjs $B probe@kyoube.local probe-password-123 "$T"; echo "rc=$?"
docker rm -f kyoube-onboarding-probe
```

Expected: `onboarding-live-check: FAIL`, `the Connect step showed no "Skip for now and connect the harness later from the Terminal page" control after the sign-in failed`, `rc=1`.

- [ ] **Step 3: Update the Studio live check for the streamlined shell and the new agent page**

````bash
git apply <<'PATCH'
diff --git a/scripts/studio-live-check.mjs b/scripts/studio-live-check.mjs
index 340a038..e470fae 100644
--- a/scripts/studio-live-check.mjs
+++ b/scripts/studio-live-check.mjs
@@ -9,9 +9,10 @@
  *
  *   node scripts/studio-live-check.mjs <base-url> <email> <password> <company-prefix> [board-token]
  *
- * It also opens an agent through the core's own URL and checks that the
- * Studio profile answers, that the core's agent tabs show the agent's
- * character, and that `?classic=1` keeps the core's view. With a board token
+ * It also opens an agent through the core's own URLs and checks that the
+ * Studio profile answers, that the core's agent views show the agent's
+ * character and display-face name, and that `?classic=1` keeps the core's
+ * overview. With a board token
  * it disables kyoube.studio, checks that the stock sidebar comes back, and
  * enables it again. Screenshots of Home (dark and light), an agent profile and
  * the Workspace page are written to STUDIO_SHOTS_DIR when that is set, for a
@@ -52,8 +53,9 @@ const INSPECT = `(() => {
     teamShown: shown(team),
     teamRows: team ? team.querySelectorAll(".ks-row").length : 0,
     firstAgentHref: team && team.querySelector(".ks-row") ? team.querySelector(".ks-row").getAttribute("href") : null,
-    orgShown: shown(coreLink("/org")),
-    stockAgentsShown: !!nav && [...nav.querySelectorAll('a[href*="/agents/"]')].some((a) => !a.closest("[data-kyoube-studio]") && shown(a)),
+    // The core's Org section (Agents, Skills, Connectors, Audit) moves to the Workspace page.
+    orgShown: shown(coreLink("/activity")),
+    stockAgentsShown: shown(coreLink("/agents")),
     coreRoutinesShown: shown(coreLink("/routines")),
     studioRoutinesShown: shown(nav && nav.querySelector('a[data-kyoube-nav="routines"]')),
     buildBeforeData: !!build && !!data && !!(build.compareDocumentPosition(data) & Node.DOCUMENT_POSITION_FOLLOWING),
@@ -141,35 +143,39 @@ async function main() {
       const back = [...document.querySelectorAll("main a")].find((a) => a.textContent.trim() === "Back");
       return { cards, backShown: !!back && back.getClientRects().length > 0, title: document.title };
     })()`);
-    for (const route of ["/org", "/timeline", "/costs", "/activity", "/company/settings", "/apps", "/skills", "/artifacts"]) {
+    for (const route of ["/agents/all", "/activity/timeline", "/activity/costs", "/activity", "/company/settings", "/apps", "/skills", "/artifacts"]) {
       if (!workspace.cards.some((href) => href && href.endsWith(route))) problems.push(`workspace: no card links ${route}`);
     }
     if (workspace.backShown) problems.push("workspace: the host's Back link is still shown");
     if (/Plugins/.test(workspace.title)) problems.push(`workspace: page title still names the plugin area (${workspace.title})`);
     if (shotsDir) await writeFile(path.join(shotsDir, "workspace-light.png"), await page.screenshot());
 
-    // The agent profile (Concept C): the core's agent URL opens it, the core's
-    // own tabs carry the agent's character, and ?classic=1 keeps the core view.
+    // The agent profile (Concept C): the core's agent URLs open it, the core's
+    // own views carry the agent's character, and ?classic=1 keeps the core view.
     const agentRef = facts.firstAgentHref ? decodeURIComponent(facts.firstAgentHref.split("/team/")[1] || "") : "";
     if (!agentRef) problems.push("profile: the team roster has no agent link to follow");
     else {
-      await page.goto(`${base}/${prefix}/agents/${encodeURIComponent(agentRef)}`);
-      try {
-        await page.waitForFunction(`location.pathname.endsWith("/team/${encodeURIComponent(agentRef)}") && !!document.querySelector('[data-kyoube-page="team"] h1') && !!document.querySelector('[data-kyoube-page="team"] [role="switch"]')`, { timeoutMs: 20_000 });
-        if (shotsDir) await writeFile(path.join(shotsDir, "profile-light.png"), await page.screenshot());
-      } catch {
-        problems.push(`profile: /agents/${agentRef} did not open the Studio profile (at ${await page.evaluate("location.pathname")})`);
+      const agentUrl = `${base}/${prefix}/agents/${encodeURIComponent(agentRef)}`;
+      for (const view of ["", "/overview"]) {
+        await page.goto(`${agentUrl}${view}`);
+        try {
+          await page.waitForFunction(`location.pathname.endsWith("/team/${encodeURIComponent(agentRef)}") && !!document.querySelector('[data-kyoube-page="team"] h1') && !!document.querySelector('[data-kyoube-page="team"] [role="switch"]')`, { timeoutMs: 20_000 });
+          if (shotsDir && view === "") await writeFile(path.join(shotsDir, "profile-light.png"), await page.screenshot());
+        } catch {
+          problems.push(`profile: /agents/${agentRef}${view} did not open the Studio profile (at ${await page.evaluate("location.pathname")})`);
+        }
       }
-      await page.goto(`${base}/${prefix}/agents/${encodeURIComponent(agentRef)}/skills`);
+      await page.goto(`${agentUrl}/skills`);
       try {
-        await page.waitForFunction(`(() => { const b = document.querySelector('main button[data-slot="popover-trigger"]'); return !!b && getComputedStyle(b).backgroundImage.startsWith('url("data:image/svg+xml'); })()`, { timeoutMs: 20_000 });
+        await page.waitForFunction(`(() => { const avatar = document.querySelector('.agent-settings-content > header [role="img"]'); return !!avatar && getComputedStyle(avatar).backgroundImage.startsWith('url("data:image/svg+xml'); })()`, { timeoutMs: 20_000 });
       } catch {
         problems.push("profile: the core agent page's header does not show the agent's character");
       }
-      const firstTab = await page.evaluate(`document.querySelector('[role="tab"][id$="-trigger-dashboard"]')?.textContent?.trim() ?? null`);
-      if (firstTab !== "Overview") problems.push(`profile: the core agent page's first tab reads ${JSON.stringify(firstTab)}, expected "Overview"`);
-      await page.goto(`${base}/${prefix}/agents/${encodeURIComponent(agentRef)}/dashboard?classic=1`, { settleMs: 2500 });
-      if (!(await page.evaluate(`location.pathname.endsWith("/dashboard")`))) problems.push("profile: ?classic=1 did not keep the core's own agent dashboard");
+      const nameFont = await page.evaluate(`(() => { const name = document.querySelector('.agent-settings-content > header h1'); return name ? getComputedStyle(name).fontFamily : null; })()`);
+      if (!nameFont || !nameFont.includes("Instrument Serif")) problems.push(`profile: the core agent page's name is not in the display face (${JSON.stringify(nameFont)})`);
+      if (shotsDir) await writeFile(path.join(shotsDir, "agent-core-light.png"), await page.screenshot());
+      await page.goto(`${agentUrl}/overview?classic=1`, { settleMs: 2500 });
+      if (!(await page.evaluate(`location.pathname.endsWith("/overview")`))) problems.push("profile: ?classic=1 did not keep the core's own agent overview");
     }
 
     // Secondary sidebars (company settings) are <aside><nav> too; the skin must leave them whole.
@@ -192,9 +198,9 @@ async function main() {
         await api(`/api/plugins/${studio.id}/disable`, "POST");
         try {
           await page.goto(`${base}/${prefix}/dashboard`, { settleMs: 500 });
-          await page.waitForFunction(`(() => { const a = [...document.querySelectorAll("aside nav a")].find((x) => (x.getAttribute("href") || "").endsWith("/org")); return !!a && a.getClientRects().length > 0; })()`, { timeoutMs: 15_000 });
+          await page.waitForFunction(`(() => { const a = [...document.querySelectorAll("aside nav a")].find((x) => (x.getAttribute("href") || "").endsWith("/activity")); return !!a && a.getClientRects().length > 0; })()`, { timeoutMs: 15_000 });
         } catch {
-          problems.push("with kyoube.studio disabled, the stock sidebar (Organization section) did not come back within 15 s");
+          problems.push("with kyoube.studio disabled, the stock sidebar (Org section) did not come back within 15 s");
         } finally {
           await api(`/api/plugins/${studio.id}/enable`, "POST");
         }
PATCH
````

- [ ] **Step 4: Call the onboarding check from the smoke, check the Connectors rename there, and let the post-restore checks count the check's company**

````bash
git apply <<'PATCH'
diff --git a/scripts/smoke.sh b/scripts/smoke.sh
index 3124383..899e383 100755
--- a/scripts/smoke.sh
+++ b/scripts/smoke.sh
@@ -94,7 +94,8 @@ grep -q 'data-kyoube-shell' "$TMP/index.html" || { echo "index.html lacks the St
 grep -q 'const fallback = "dark";' "$TMP/index.html" || { echo "index.html does not default to the dark theme" >&2; exit 1; }
 [[ "$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "$BASE_URL/fonts/kyoube/InstrumentSerif-Regular-latin.woff2")" == "200 font/woff2"* ]] || { echo "the Instrument Serif font is not served" >&2; exit 1; }
 grep -q 'to:"/dashboard",label:"Home"' "$TMP/main.js" || { echo "the sidebar does not call the dashboard Home" >&2; exit 1; }
-grep -q 'label:"Connected apps"' "$TMP/main.js" || { echo "the core's Apps area was not renamed Connections" >&2; exit 1; }
+grep -q '{label:"Connectors",href:"/apps"}' "$TMP/main.js" || { echo "the core's last Apps breadcrumbs were not renamed Connectors" >&2; exit 1; }
+! grep -q '{label:"Apps",href:"/apps"}' "$TMP/main.js" || { echo "a core breadcrumb still calls the Connectors area Apps" >&2; exit 1; }
 echo "    $THEME_CSS is linked after the core stylesheet; fonts, dark default and renames are in place"
 
 echo "==> home and database names"
@@ -346,6 +347,19 @@ elif [[ "$STUDIO_LIVE_RC" != "0" ]]; then
   exit "$STUDIO_LIVE_RC"
 fi
 
+echo "==> the first-run wizard can skip the harness sign-in"
+# docker/core-patches adds "Skip for now" under an error on the wizard's
+# Connect step. This stack has no harness signed in, so Connect fails and the
+# skip must still hire the agent. The check creates its own agentless company.
+ONBOARDING_LIVE_RC=0
+node "$ROOT/scripts/onboarding-live-check.mjs" "$BASE_URL" smoke@kyoube.local smoke-password-123 "$TOKEN" || ONBOARDING_LIVE_RC=$?
+if [[ "$ONBOARDING_LIVE_RC" == "2" ]]; then
+  [[ "${KYOUBE_ALLOW_NO_CHROME:-0}" == "1" ]] || { echo "onboarding-live-check skipped for want of Chrome; install Chrome, set CHROME_PATH, or re-run with KYOUBE_ALLOW_NO_CHROME=1" >&2; exit 1; }
+  echo "    onboarding-live-check SKIPPED (KYOUBE_ALLOW_NO_CHROME=1)"
+elif [[ "$ONBOARDING_LIVE_RC" != "0" ]]; then
+  exit "$ONBOARDING_LIVE_RC"
+fi
+
 echo "==> the worker installs the Kyoube skills into the new company by itself (company.created)"
 # The company was created after `kyoube setup`, so nothing but the worker's
 # event subscription can have put the skills there. The import is asynchronous.
@@ -759,13 +773,15 @@ grep -q "kyoube.terminal@${BUMP2}=ready" "$TMP/doctor.log" \
   || { echo "kyoube doctor did not report kyoube.terminal@${BUMP2}=ready:" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
 grep -q "kyoube.files@${FILES_SHIPPED}=ready" "$TMP/doctor.log" \
   || { echo "kyoube doctor did not report kyoube.files@${FILES_SHIPPED}=ready:" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
-grep -Eq '^ok +skills .*1/1 companies' "$TMP/doctor.log" \
-  || { echo "kyoube doctor did not report the Kyoube skills present in the restored company:" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
+# Every restored company: the smoke's own, and the one onboarding-live-check created.
+COMPANY_COUNT="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies" | jq 'length')"
+grep -Eq "^ok +skills .* ${COMPANY_COUNT}/${COMPANY_COUNT} companies" "$TMP/doctor.log" \
+  || { echo "kyoube doctor did not report the Kyoube skills present in all ${COMPANY_COUNT} restored companies:" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
 # The restored stack started with a company already in place, which is the
 # upgrade case: the entrypoint's ensure-plugins pass must have asked the worker
 # to install the skills there (the worker cannot do it from its own start-up).
 for i in $(seq 1 60); do
-  compose logs --no-color app 2>/dev/null | grep -q 'Kyoube skills ensured in 1/1 companies' && break
+  compose logs --no-color app 2>/dev/null | grep -q "Kyoube skills ensured in ${COMPANY_COUNT}/${COMPANY_COUNT} companies" && break
   sleep 2
   [[ $i -eq 60 ]] && { echo "the entrypoint's ensure-plugins never reported the Kyoube skills ensured after the restore:" >&2; compose logs --no-color app 2>/dev/null | grep 'kyoube:' >&2; exit 1; }
 done
PATCH
````

- [ ] **Step 5: Stop the migration check counting skill keys as paths**

The onboarding check's company leaves an agent hired through the wizard, and such an agent lists the core's built-in skills (`paperclipai/paperclip/paperclip`, …) in `adapter_config.paperclipSkillSync`. `count_legacy_paths` matched any `/paperclip/` in the config text, so the smoke's migration rehearsal saw 2 legacy paths instead of the 1 it plants, and on a real migrated install `--check` could never reach 0. Count only JSON strings that start with `/paperclip/`:

````bash
git apply <<'PATCH'
diff --git a/scripts/migrate-from-0.1.sh b/scripts/migrate-from-0.1.sh
index 074269f..25197d8 100755
--- a/scripts/migrate-from-0.1.sh
+++ b/scripts/migrate-from-0.1.sh
@@ -63,8 +63,10 @@ admin_role() {
 
 # Rows whose absolute path still starts with /paperclip/: every `cwd` column in
 # the core database (execution/project workspaces, operations, runtime services)
-# plus agents' adapter configs. Generic over the schema so a core bump that adds
-# a table needs no change here.
+# plus every JSON string in agents' adapter configs that starts with it. Only a
+# string's start counts: the core's own skill keys (`paperclipai/paperclip/…`,
+# listed in paperclipSkillSync) contain "/paperclip/" but are names, not paths.
+# Generic over the schema so a core bump that adds a table needs no change here.
 count_legacy_paths() {
   local admin db out
   admin="$(admin_role)" || { echo "migrate: neither a kyoubeai nor a paperclip role — is the db service up?" >&2; return 1; }
@@ -82,7 +84,7 @@ BEGIN
     total := total + n;
   END LOOP;
   IF to_regclass('public.agents') IS NOT NULL THEN
-    EXECUTE 'SELECT count(*) FROM agents WHERE adapter_config::text LIKE ''%/paperclip/%''' INTO n;
+    EXECUTE 'SELECT count(*) FROM agents WHERE adapter_config::text LIKE ''%"/paperclip/%''' INTO n;
     total := total + n;
   END IF;
   RAISE NOTICE 'legacy_paths=%', total;
PATCH
````

(Checked against a smoke database holding both kinds of agent: the old predicate counts 2, the new one 1, the planted `"cwd": "/paperclip/workspaces/legacy"`.)

- [ ] **Step 6: Syntax-check the scripts**

```bash
node --check scripts/studio-live-check.mjs && node --check scripts/onboarding-live-check.mjs && bash -n scripts/smoke.sh && bash -n scripts/migrate-from-0.1.sh && echo ok
```

Expected: `ok`.

- [ ] **Step 7: Run the full smoke**

```bash
shots="$(mktemp -d)"; STUDIO_SHOTS_DIR="$shots" bash scripts/smoke.sh 2>&1 | tee "$shots/smoke.log" | grep -E "^==> |live-check"; echo "shots: $shots"
```

Expected: every `==>` stage, then `studio-live-check: http://localhost:3199/… renders the Studio design and falls back to the stock sidebar without the plugin`, `onboarding-live-check: … lets a new company skip the harness sign-in and still hire its first agent`, and finally `==> smoke passed`. Allow 30–45 minutes.

- [ ] **Step 8: Look at the screenshots**

Open `home-dark.png`, `workspace-light.png`, `profile-light.png`, `agent-core-light.png` and `onboarding-connect.png` in `$shots`. Check: the sidebar has no Org section and reads Home, Inbox, Tasks, Projects, Build, Team, Workspace; the core agent page shows the character and the serif name with no grey bands; the Connect step shows the skip link under the error.

- [ ] **Step 9: Commit**

```bash
git add scripts/onboarding-live-check.mjs scripts/studio-live-check.mjs scripts/smoke.sh scripts/migrate-from-0.1.sh
git commit -F - <<'MSG'
test(smoke): live checks for core 2026.916.1 and the onboarding skip

The onboarding check leaves a second company, so the post-restore checks
count companies instead of assuming one, and migrate-from-0.1.sh stops
counting the core's skill keys (paperclipai/paperclip/...) as legacy paths.
MSG
```

---

### Task 9: Docs, changelog and version 1.3.0

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `package.json`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/theme.md`, `docs/upgrading.md`, `docs/branding.md`, `docs/architecture.md`, `docs/governance.md`, `docs/apps.md`, `plugins/kyoube-files/src/manifest.ts`, `plugins/kyoube-terminal/src/manifest.ts`, `plugins/kyoube-studio/src/manifest.ts` (comments only)

**Interfaces:**
- Consumes: the numbers and behaviour established by Tasks 1–8.
- Produces: KyoubeAI `1.3.0`.

- [ ] **Step 1: Apply the documentation changes**

````bash
git apply <<'PATCH'
diff --git a/README.md b/README.md
index 4bca04d..8fa5b3f 100644
--- a/README.md
+++ b/README.md
@@ -66,16 +66,16 @@ The compose port binding listens on every interface, so reaching the UI from ano
    ```
    Approve the login link it prints. From then on plugins install and upgrade automatically at start-up.
 3. Check everything: `docker compose exec app kyoube doctor`.
-4. Authenticate the agent harnesses: either put provider API keys in `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`) or, once the Terminal plugin is installed, run `claude login`, `pi`, and `hermes setup` from the Terminal page. Credentials persist on the `kyoubeai-home` volume. The first-run wizard's **Connect** step probes the harness you pick; if nothing is authenticated yet, choose **Skip for now and connect the harness later** — the agent is created anyway, and it starts working once the harness is logged in from the Terminal page.
+4. Authenticate the agent harnesses: either put provider API keys in `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`) or, once the Terminal plugin is installed, run `claude login`, `pi`, and `hermes setup` from the Terminal page. Credentials persist on the `kyoubeai-home` volume. The first-run wizard's **Connect a model** step checks the harness you pick. An API key typed there works at once; a Claude or OpenAI subscription cannot be signed in from the wizard on a KyoubeAI server, so if nothing is signed in yet choose **Skip for now and connect the harness later from the Terminal page** — the agent is created anyway, and it starts working once the harness is logged in from the Terminal page.
 
 ## Studio
 
 KyoubeAI opens dark, in the palette and type of the KyoubeAI website. The sidebar keeps what you use
 every day: a search field, one **New task** button, Home, Inbox, Tasks and Projects, a **Build** group
 (Data, Apps, Routines) and a **Team** roster where every agent has a face, a live status dot and a line
-saying what it is doing. Everything else (Org chart, Activity, Timeline, Costs, Approvals, Skills,
-Artifacts, Connections, Settings, and for owners and admins Plugins and Terminal) is on the
-**Workspace** page at the bottom of the sidebar, and still one ⌘K away.
+saying what it is doing. Everything else (All agents and the org chart, Audit, Timeline, Costs,
+Approvals, Skills, Artifacts, Connectors, Settings, and for owners and admins Plugins and Terminal) is
+on the **Workspace** page at the bottom of the sidebar, and still one ⌘K away.
 
 **Home** replaces the stock dashboard's top half: how many things need you, a getting-started strip for
 new workspaces, **Needs you** (approvals, reviews, blocked tasks, agents in error), **Your team right
@@ -85,7 +85,8 @@ icon picked in its settings and its name.
 Each agent has a **profile** (`/<company>/team/<agent>`): its character and status, whom it reports to,
 an **On duty** switch, **Chat** and **Assign task**, what it is working on now with its latest notes,
 recent work, the week's numbers, its skills and who it works with. Every link to an agent opens the
-profile; its Instructions, Skills, Runs and Settings tabs open the core's own agent pages.
+profile; its Instructions, Skills and Settings tabs open the core's own agent views, and Runs opens
+the agent's runs under Audit.
 
 It is two parts, neither of which edits the core: `docker/theme/` (a build-time stylesheet, boot flag
 and label renames, checked against every core bump) and the `kyoube.studio` plugin. If the plugin is
@@ -99,7 +100,7 @@ Security note: the terminal is equivalent to shell access to the whole instance
 
 ## Data
 
-Every company gets its own isolated PostgreSQL schema in the `kyoube` database (separate from the core's own database). People use it from the **Data** page; agents use the REST routes under `/api/plugins/kyoube.apps/api/` with the `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` and `PAPERCLIP_COMPANY_ID` every run already carries, guided by the managed **Kyoube Data** skill. The same operations exist as `kyoube.apps:data_*` tools, but core 2026.831.1 only hands those to a run through an MCP gateway, which it creates only for agents that already have an MCP connection — so the skill leads with the API.
+Every company gets its own isolated PostgreSQL schema in the `kyoube` database (separate from the core's own database). People use it from the **Data** page; agents use the REST routes under `/api/plugins/kyoube.apps/api/` with the `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` and `PAPERCLIP_COMPANY_ID` every run already carries, guided by the managed **Kyoube Data** skill. The same operations exist as `kyoube.apps:data_*` tools, but the core (2026.831.1 through 2026.916.1) only hands those to a run through an MCP gateway, which it creates only for agents that already have an MCP connection — so the skill leads with the API.
 
 **Giving an agent access takes two steps.** The **Kyoube Data** and **Kyoube Apps** skills land in every company's skill library by themselves: `kyoube ensure-plugins` installs them into every company at each container start, the first visit to a company's pages does the same, and a company created later gets them on creation (`kyoube setup` and `kyoube doctor` confirm it). Then, per agent: enable the skills on the agent's **Skills** tab, and grant a level under **Company Settings → Data access**. Enabling a skill only puts its text in front of the agent; nothing runs until a task calls for company data.
 
@@ -176,13 +177,6 @@ copies, logs, health, rotating the board key, and resource limits.
 Full instructions, what to read before a core bump, and how to roll back (databases migrate
 forward only — restore from backup) are in **[docs/upgrading.md](docs/upgrading.md)**.
 
-Known upstream issue in core 2026.831.1 (fixed upstream in [#12502](https://github.com/paperclipai/paperclip/pull/12502),
-not yet in a stable release): open an agent's **Instructions** tab once and the next tab change can
-raise a "Discard unsaved agent configuration changes?" prompt that re-opens as fast as it is answered.
-The instructions editor normalises the default AGENTS.md on load and the page takes that as an edit.
-Per agent, open Instructions and press **Save** once; after that the prompt stays away. KyoubeAI will
-move to the next stable core release that carries the fix.
-
 ## How it stays upstream-compatible
 
 - The image is built `FROM` a pinned upstream release of the core (Paperclip, `KYOUBE_CORE_VERSION`);
diff --git a/CONTRIBUTING.md b/CONTRIBUTING.md
index 2eb7d93..6234a50 100644
--- a/CONTRIBUTING.md
+++ b/CONTRIBUTING.md
@@ -98,8 +98,8 @@ presentation only, and both failing the build when upstream moves what they rely
   lists what it leaves alone.
 - `docker/theme/` applies the Studio design: it overrides the core's CSS tokens, adds a stylesheet
   aimed only at stable hooks (route links, ARIA labels, icon names, our own `data-kyoube-*`
-  markers), inlines a small boot flag, and renames a few labels (Dashboard → Home, the core's Apps
-  area → Connections) and the default theme (dark). Every rule declares how often it must match, and
+  markers), inlines a small boot flag, and renames a few labels (Dashboard → Home, the core's last
+  "Apps" breadcrumbs → Connectors) and the default theme (dark). Every rule declares how often it must match, and
   every rule that hides or moves core UI is gated on the Studio plugin being present, so a miss shows
   the stock layout. It may not change behaviour: anything that needs data or logic goes in
   `plugins/kyoube-studio`, on the public SDK. `docs/theme.md` has the details.
diff --git a/SECURITY.md b/SECURITY.md
index 1ed74b2..9486af1 100644
--- a/SECURITY.md
+++ b/SECURITY.md
@@ -92,7 +92,7 @@ Terminal output is pulled, never pushed: the page polls `terminal.wait`, which i
 session's owner and company exactly like `attach` (a session in another company answers `not_found`,
 another user's `forbidden`), so there is no per-session secret to guard and no channel that could be
 listed or guessed. The SSE stream channel the original design relied on is gone: upstream core
-2026.831.1 never wires its plugin stream bridge (the route answers 501), which is why the terminal
+(2026.831.1 through 2026.916.1) never wires its plugin stream bridge (the route answers 501), which is why the terminal
 does not use it.
 
 ## Data
@@ -219,7 +219,7 @@ against the plugin's `readRoles` (default: every role) or `writeRoles` (default:
 `viewer`) under **Settings → Plugins → Kyoube Files**. Reads take the same 30-second membership cache as
 the Data page; every mutation reads the members API afresh, so a demoted or removed member can browse
 for at most 30 more seconds and can change nothing from the moment the change lands. Project
-visibility in core 2026.831.1 is company-wide (`project:read` is granted to every active member in its
+visibility in core 2026.831.1 through 2026.916.1 is company-wide (`project:read` is granted to every active member in its
 simple permissions mode), so the company role is the right unit here; if a future core adds
 per-project membership the plugin will need to consult it, and this section will say so. The project
 must be in the host's company scope: `getPrimaryWorkspace` answers `null` otherwise, and a
diff --git a/docs/theme.md b/docs/theme.md
index b6fa155..171f247 100644
--- a/docs/theme.md
+++ b/docs/theme.md
@@ -19,29 +19,32 @@ KyoubeAI's own look ("Studio") comes from two parts, and neither edits the core:
   Tasks and Projects; a **Build** group (Data, Apps, Routines); a **Team** roster with each agent's
   character, a live status dot and what they are doing; and **Workspace** at the bottom. The collapsed
   rail keeps the same order, icons and faces only.
-- **Moved to the Workspace page.** Org chart, all agents, members and invites, Activity, Timeline,
-  Costs, Approvals, Skills, Artifacts, Projects, Connections, Settings, and (for owners and admins)
-  Plugins and Terminal. Every one is still reachable from ⌘K and its own URL.
+- **Moved to the Workspace page.** All agents (with the org chart), members and invites, Audit,
+  Timeline, Costs, Approvals, Skills, Artifacts, Projects, Connectors, Settings, and (for owners and
+  admins) Plugins and Terminal: the core's whole Org section, and the Artifacts and Skills links. Every
+  one is still reachable from ⌘K and its own URL.
 - **Home** (the dashboard). A greeting that says how many things need you; a three-step getting-started
   strip until each step is done (or dismissed); **Needs you** (approvals, reviews, blocked tasks, agents
   in error, each with one verb); **Your team right now**; and **Latest updates**. The core's metrics
   and charts follow below; its live-runs panel, which the team panel replaces, is hidden.
-- **Renames.** Dashboard is called **Home** (the mobile bar already said so). The core's Apps area,
-  which connects outside tools, is called **Connections**, and its own "Connections" sub-page is
-  **Connected apps**. KyoubeAI's Apps (AI-built apps over company data) keep their name. A plugin
-  page is titled by its page ("Data", "Workspace") instead of "Plugins › <plugin>", and KyoubeAI's own
-  pages drop the host's Back link.
+- **Renames.** Dashboard is called **Home** (the mobile bar already said so). The core calls its
+  outside-tools area **Connectors** (since 2026.916), which keeps "Apps" for KyoubeAI's Apps (AI-built
+  apps over company data); the three access-profile pages that still said "Apps" in their breadcrumb
+  say Connectors too. A plugin page is titled by its page ("Data", "Workspace") instead of
+  "Plugins › <plugin>", and KyoubeAI's own pages drop the host's Back link.
 - **Agent profile** (`/<company>/team/<agent>`, the Concept C page). A header with the agent's
   character and live status, its name in the display face, its title, whom it reports to and the
   harness it runs on; an **On duty** switch, **Chat** (opens the task you would talk to it in) and
   **Assign task**. Tabs: **Overview** (what it is working on now with its own latest notes, recent work,
   tasks done this week, open tasks, spend this month, its skills, who it works with) and **Tasks** are
-  Studio's; **Instructions**, **Skills**, **Runs** and **Settings** open the core's own agent tabs.
-  Every link to an agent's default view opens the profile: the roster, Home, the org chart, the agents
-  list and the task assignee links alike (the plugin redirects the core's `/agents/<agent>` and
-  `/agents/<agent>/dashboard`). The core's agent page keeps its other tabs, with the agent's character
-  and display-face name in its header and its first tab renamed **Overview**, which leads back to the
-  profile. `/agents/<agent>/dashboard?classic=1` still shows the core's own view with its run charts.
+  Studio's; **Instructions**, **Skills** and **Settings** open the core's own agent views, and **Runs**
+  opens the core's Audit runs filtered to the agent. Every link to an agent's default view opens the
+  profile: the roster, Home, the org chart, the agents list and the task assignee links alike (the
+  plugin redirects the core's `/agents/<agent>` and `/agents/<agent>/overview`, and the
+  `/agents/<agent>/dashboard` of cores before 2026.916). The core's agent page keeps its other views,
+  with the agent's character over its header avatar and its name in the display face; its **Overview**
+  entry leads back to the profile. `/agents/<agent>/overview?classic=1` still shows the core's own
+  overview.
 - **Characters.** Each agent gets a face drawn from the icon picked in its settings (tint, hairstyle,
   accessory) and its name (skin tone, hair colour), so two agents with the same icon still differ. An
   agent with no icon gets a face from its name; `bot`, `cpu` and `circuit-board` are robots. The
@@ -59,6 +62,11 @@ KyoubeAI's own look ("Studio") comes from two parts, and neither edits the core:
 | Studio plugin | the published plugin SDK (slots, `order`, `useHostNavigation`, `useHostLocation`, `ctx.agents/issues/approvals`) | the SDK pin, the plugin's tests, the smoke, and the weekly upstream-beta run |
 | Agent profile actions | the core's documented board API (`POST /api/agents/{id}/pause`, `/resume`, `POST /api/companies/{id}/issues`), called as the signed-in person | the core's own permission checks; the live check follows an agent through the profile and the core tabs |
 
+**Shell.** Core 2026.916 made its streamlined shell (a Work section, an Org section and Recent tasks)
+the default, and the skin targets it. An instance can switch back to the legacy shell under
+Settings → Experimental → **Streamlined UI**; Studio still renders there, but the legacy sidebar's
+Agents and Organization sections stay visible.
+
 **Fail safe.** Every skin rule that hides or moves core UI applies only while the Studio layout is on:
 the Studio roster (`[data-kyoube-studio="team"]`) is on the page, or `boot.js` has flagged the page
 (`<html data-kyoube-shell="studio">`) while the plugin's UI loads. The flag clears itself after six
@@ -75,9 +83,10 @@ the gate.
 3. `scripts/smoke.sh` checks the served theme with curl, then `scripts/studio-live-check.mjs` signs
    in with headless Chrome and checks the design as rendered: dark by default, the Studio sidebar,
    Home above the charts, the Workspace page, an agent opened through the core's own URL landing on
-   the profile (and the core agent tabs showing its character), and the stock sidebar returning when
-   `kyoube.studio` is disabled. It saves screenshots to `STUDIO_SHOTS_DIR`, which CI uploads as the
-   `studio-screenshots` artifact.
+   the profile (and the core agent views showing its character), and the stock sidebar returning when
+   `kyoube.studio` is disabled. `scripts/onboarding-live-check.mjs` then walks the first-run wizard to
+   a skipped harness sign-in (the onboarding patches in docker/core-patches). Both save screenshots to
+   `STUDIO_SHOTS_DIR`, which CI uploads as the `studio-screenshots` artifact.
 4. The weekly `upstream-beta` workflow does all of this against the core's `:beta` image.
 
 ## After a core bump
@@ -85,8 +94,8 @@ the gate.
 Read the `theme:` lines in the build log:
 
 ```
-theme: 20 text rules applied in 3 file(s): home-sidebar-label 1/1, …
-theme: anchors 17/17; sidebar sections top=6, work=9, organization=6
+theme: 8 text rules applied in 2 file(s): home-sidebar-label 2/2, …
+theme: anchors 16/16; sidebar sections top=6, work=8, org=4
 theme: 52 core tokens overridden, all still declared by the core
 theme: linked /assets/kyoube-theme.css after the core stylesheet; 5 font files in /fonts/kyoube
 ```
@@ -98,16 +107,18 @@ visible. When the build stops, the message says what to change:
 |---|---|
 | `text rule "<id>" matched N time(s) … expected M` | Find the string in the new bundle and update the pattern in `docker/theme/rules.mjs`. Never relax `expect`. |
 | `anchor "<id>" matched 0 time(s)` | The hook the skin uses moved. Update the selector in `theme.css` and the anchor in `anchors.mjs`. |
-| `sidebar section "organization" changed: added [/x]` | The skin hides that section, so give the new link a card in `plugins/kyoube-studio/src/ui/links.ts`, then update `SECTIONS` in `anchors.mjs`. |
+| `sidebar section "org" changed: added [/x]` | The skin hides that section, so give the new link a card in `plugins/kyoube-studio/src/ui/links.ts`, then update `SECTIONS` in `anchors.mjs`. |
+| `sidebar section "org" not found` | The literal that ends the Org section's scan (the legacy shell's Organization section) is gone upstream. Set that entry's `end` in `SECTIONS` to the next literal after the Org section in the Sidebar component. |
 | `the core no longer declares --x` | Find the token that replaced it in the core's `index.css` and update `theme.css`. |
 
 Then refresh the test fixture from the new core image and look at the Studio screenshots from the
 smoke:
 
 ```bash
+dist="$(mktemp -d)/dist"
 id=$(docker create ghcr.io/paperclipai/paperclip:<version>)
-docker cp "$id":/app/ui/dist /tmp/core-dist && docker rm "$id"
-node docker/theme/tests/fixtures/extract.mjs /tmp/core-dist docker/theme/tests/fixtures/core-<version>.mjs
+docker cp "$id":/app/ui/dist "$dist" && docker rm "$id"
+node docker/theme/tests/fixtures/extract.mjs "$dist" docker/theme/tests/fixtures/core-<version>.mjs
 ```
 
 and point `theme.spec.mjs` at the new fixture.
diff --git a/docs/upgrading.md b/docs/upgrading.md
index 0db9687..f604d5c 100644
--- a/docs/upgrading.md
+++ b/docs/upgrading.md
@@ -51,6 +51,36 @@ A plugin stuck in another status has its own log under **Settings → Plugins 
 If a plugin is deliberately disabled by an operator, `ensure-plugins` leaves it alone and says so —
 that is not a failure, but `doctor` will not call it `ready` either.
 
+## Upgrading to 1.3.0 (core 2026.916.1)
+
+KyoubeAI 1.3.0 moves to core 2026.916.1, a large upstream release. Read this before you rebuild.
+
+- **Back up first.** The core adds 49 database migrations (`0231` to `0279`). They run on the first
+  start and cannot be undone: `bash scripts/backup.sh`.
+- **Behind a reverse proxy or tunnel, set `TRUST_PROXY`.** The core now believes `X-Forwarded-Host`
+  only from a proxy it trusts. If sign-in or saving fails with an origin error behind Caddy, Traefik,
+  nginx or a Cloudflare tunnel, set `TRUST_PROXY` in `.env`: `uniquelocal` trusts a proxy container
+  on the same Docker network, and a proxy on the host needs its address (for example `172.17.0.1`).
+  Leave it empty when people reach the app directly.
+- **The streamlined shell is the default.** The core's new sidebar replaces the old one, and Studio
+  is built for it. Settings → Experimental → **Streamlined UI** switches back, but the Studio sidebar
+  then shows the legacy Agents and Organization sections.
+- **Some pages moved.** The org chart is a view on All agents; Timeline, Costs and an agent's runs are
+  under Audit (`/activity/timeline`, `/activity/costs`, `/activity/runs`). Old URLs redirect, and the
+  Workspace page links the new places.
+- **Onboarding changed.** The first-run wizard's **Connect a model** step offers a Claude or OpenAI
+  subscription or an API key. A subscription cannot be signed in from the wizard on a KyoubeAI server;
+  use **Skip for now and connect the harness later from the Terminal page**, then run `claude login`
+  on the Terminal page.
+- **Announcements stay off.** The core now shows Paperclip's hosted announcement cards by default;
+  KyoubeAI's `docker-compose.yml` turns them off (`PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false"`).
+- **Agent credentials are no longer echoed.** Agent API responses redact plaintext `env` values.
+  Nothing in KyoubeAI reads them; a script of your own might.
+- **The native runner gate is open.** `enableNativeRunner` now defaults to on for self-hosted
+  instances. Nothing switches automatically, and existing agents keep their adapters.
+- **Harnesses.** The image carries Claude Code 2.1.281, pi 0.87.1 and Hermes 0.21.4 (release
+  v2026.9.21). Their logins on the `kyoubeai-home` volume carry over.
+
 ## Upgrading from 0.1.x
 
 0.2.0 renamed what the container and the database are called (see the CHANGELOG's *Breaking* list):
diff --git a/docs/branding.md b/docs/branding.md
index 1550784..ea899c4 100644
--- a/docs/branding.md
+++ b/docs/branding.md
@@ -28,7 +28,7 @@ The Studio design (colours, sidebar, Home, label renames such as Dashboard → H
    go through a code-aware path: the phrase and URL rules apply unconditionally, and the name rule is
    held back only where a match is both outside any string or comment on its line *and*
    identifier-shaped (`import { Paperclip }`, `<Paperclip …>`, `icon: Paperclip`). Those are printed
-   as `code-shaped matches left alone` rather than rewritten; on core 2026.831.1 there are **none**.
+   as `code-shaped matches left alone` rather than rewritten; on core 2026.916.1 there are **none**.
    `.sql` is deliberately excluded — see the residual record below.
 2. **Artwork.** Favicons and PWA icons come from `docker/brand/icons/`; `favicon.svg` and the
    loading animation (`/kyoubeai-thinking.svg`) are rendered from `docker/brand/mark.svg`; the
@@ -101,7 +101,7 @@ Read the `rebrand:` block in the build log, in this order:
    in `docker/rebrand/lib/files.mjs`) or is more upstream source (extend `SWEEP_ALLOWLIST`, with the
    reason). Rows growing is normal — upstream writes more source — only *new rows* matter.
 3. **The code-shaped list.** Matches in `packages` code the transform left alone as identifiers.
-   It is empty on 2026.831.1; anything appearing there is either a genuine new identifier (fine) or
+   It is empty on 2026.916.1; anything appearing there is either a genuine new identifier (fine) or
    display text the classifier misread (add the exact string to `phrases` in `brand.json`).
 4. **The `known residual` lines** — currently only the hash-pinned `packages/db` migrations.
 
@@ -110,6 +110,18 @@ fixture in `docker/rebrand/tests/svg.spec.mjs`).
 
 ## Residual identifiers on core 2026.831.1
 
+On core 2026.916.1 (KyoubeAI 1.3.0, checked 2026-09-24) the build's header lines are
+
+```
+rebrand: 1213 files rewritten (name 7432, phrase 336, url 269), 269 assets renamed, 1443 references rewritten
+rebrand: anchors lockup=1 thinking=1; residual 0; binaries skipped 0; symlinks skipped 0
+rebrand: code-shaped matches left alone: 0
+```
+
+and the sweep gained three allowlisted rows for upstream's new development material
+(`announcements`, the `ui/connect-*-preview.html` pages and the root `.env.example`). The lists below
+were compiled on 2026.831.1; the kinds of identifier are the same on 2026.916.1.
+
 Verified against the built image on 2026-09-14, after the final review fix wave (the history at the
 end of this section says what each round closed). That build's `rebrand:` header lines were
 
diff --git a/docs/architecture.md b/docs/architecture.md
index 2db8474..1157f29 100644
--- a/docs/architecture.md
+++ b/docs/architecture.md
@@ -101,7 +101,7 @@ exact residual this leaves: `SECURITY.md`.
 A local adapter run (`claude_local`, `pi_local`, `hermes_local`) reaches Kyoube over REST: every run is
 started with `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` (a run-scoped agent token) and `PAPERCLIP_COMPANY_ID`
 in its environment, and the managed skills tell the agent to call the plugin's API routes (next section)
-with them. That is the primary path because of how core 2026.831.1 delivers plugin tools: they are
+with them. That is the primary path because of how the core (2026.831.1 through 2026.916.1) delivers plugin tools: they are
 listed by its tool gateway, but a run only receives a gateway MCP server (`/mcp/gateways/<id>`) when the
 agent's effective tool profile permits at least one installed `mcp_remote`/`local_stdio` connection —
 `buildPaperclipRuntimeMcpServers` in upstream's `heartbeat.ts` returns nothing otherwise, and the
diff --git a/docs/governance.md b/docs/governance.md
index d2eda01..ed23b43 100644
--- a/docs/governance.md
+++ b/docs/governance.md
@@ -15,7 +15,7 @@ both right before you hand an agent broad tool access:
    this exact call allowed right now***.
 
 **Which gate applies depends on how the agent reaches Kyoube.** The core's profiles and policies govern
-tool calls that pass through its MCP gateway, and core 2026.831.1 only gives a run that gateway
+tool calls that pass through its MCP gateway, and the core (2026.831.1 through 2026.916.1) only gives a run that gateway
 when the agent already has an installed MCP connection (see `architecture.md`, "Agent run → Kyoube").
 The managed skills therefore lead with Kyoube's REST routes, which every run can call with its own
 `PAPERCLIP_API_KEY` — and a REST call is checked by gate 1 only. If you want gate 2 as well (an
diff --git a/docs/apps.md b/docs/apps.md
index c17cac6..7261bc9 100644
--- a/docs/apps.md
+++ b/docs/apps.md
@@ -131,7 +131,7 @@ company as `?companyId=…` on `GET` or `"companyId"` in every `POST` body. Ever
 | Roll back | `POST /apps/{slug}/rollback` | `version` |
 | Archive | `POST /apps/{slug}/archive` | — |
 
-The same operations exist as `kyoube.apps:apps_*` tools, but core 2026.831.1 only hands plugin tools
+The same operations exist as `kyoube.apps:apps_*` tools, but the core (2026.831.1 through 2026.916.1) only hands plugin tools
 to a run through an MCP gateway, which it creates only for agents that already have an MCP connection
 (`architecture.md`, "Agent run → Kyoube"); the skill therefore leads with the API.
 
diff --git a/plugins/kyoube-files/src/manifest.ts b/plugins/kyoube-files/src/manifest.ts
index 0c66390..d38ac9d 100644
--- a/plugins/kyoube-files/src/manifest.ts
+++ b/plugins/kyoube-files/src/manifest.ts
@@ -8,7 +8,7 @@ export const TAB_SLOT_ID = "project-files";
 const ROLES = ["owner", "admin", "operator", "member", "viewer"];
 
 // `minimumHostVersion` is deliberately absent, for the reason recorded in the
-// terminal plugin's manifest: core 2026.831.1 compares it against a host version
+// terminal plugin's manifest: core 2026.831.1 (still in 2026.916.1) compares it against a host version
 // it never sets, so any minimum would reject the install.
 const manifest: PaperclipPluginManifestV1 = {
   id: PLUGIN_ID,
diff --git a/plugins/kyoube-terminal/src/manifest.ts b/plugins/kyoube-terminal/src/manifest.ts
index 8b05576..907b967 100644
--- a/plugins/kyoube-terminal/src/manifest.ts
+++ b/plugins/kyoube-terminal/src/manifest.ts
@@ -4,7 +4,7 @@ export const PLUGIN_ID = "kyoube.terminal";
 export const PLUGIN_VERSION = "0.2.4";
 export const PAGE_ROUTE = "terminal";
 
-// We intentionally do not set `minimumHostVersion`. Core 2026.831.1 compares
+// We intentionally do not set `minimumHostVersion`. Core 2026.831.1 (still in 2026.916.1) compares
 // it against `instanceInfo.hostVersion`, which the server never actually sets (it
 // defaults to "0.0.0"), so declaring any minimum here would reject the install
 // outright. Revisit once upstream wires a real host version through `initialize`.
diff --git a/plugins/kyoube-studio/src/manifest.ts b/plugins/kyoube-studio/src/manifest.ts
index 255628f..33cda8d 100644
--- a/plugins/kyoube-studio/src/manifest.ts
+++ b/plugins/kyoube-studio/src/manifest.ts
@@ -19,3 +19,3 @@ export const SIDEBAR_ORDER = { build: 10, data: 20, apps: 30, routines: 40, team
 // `minimumHostVersion` is deliberately absent, for the reason recorded in the
-// terminal plugin's manifest: core 2026.831.1 compares it against a host version
+// terminal plugin's manifest: core 2026.831.1 (still in 2026.916.1) compares it against a host version
 // it never sets, so any minimum would reject the install.
PATCH
````

- [ ] **Step 2: Add the 1.3.0 changelog entry and bump the version**

````bash
git apply <<'PATCH'
diff --git a/CHANGELOG.md b/CHANGELOG.md
index 9babda9..bf9f078 100644
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -4,6 +4,51 @@ All notable changes to KyoubeAI are recorded here, in terms of what changed for
 building on it. The format is loosely [Keep a Changelog](https://keepachangelog.com/); versioning is
 [SemVer](https://semver.org/).
 
+## 1.3.0 - 2026-09-24
+
+### Changed
+
+- **Core 2026.916.1.** The image is built on Paperclip 2026.916.1 (from 2026.831.1), and every
+  plugin on `@paperclipai/plugin-sdk` 2026.916.1. Upstream's highlights: AI credentials managed as
+  Connections, a streamlined sidebar and a rebuilt agent page, a new first-run wizard, native chat
+  connectors and agent email (experimental), and 49 database migrations. Read
+  [docs/upgrading.md](docs/upgrading.md#upgrading-to-130-core-20269161) before you rebuild: back up
+  first, and set `TRUST_PROXY` behind a reverse proxy or tunnel.
+- **Harnesses.** Claude Code 2.1.281 (from 2.1.267), pi 0.87.1 (from 0.85.1) and Hermes 0.21.4,
+  release v2026.9.21 (from 0.21.1).
+- **Studio on the streamlined shell.** The sidebar skin now targets the core's new default sidebar:
+  its Org section (Agents, Skills, Connectors, Audit) moves to the Workspace page like the old
+  Organization section did, and the Workspace page links the core's new places (All agents with the
+  org chart, Audit, `/activity/timeline`, `/activity/costs`). `kyoube.studio` 0.2.0 follows the
+  rebuilt agent page: `/agents/<agent>` and `/agents/<agent>/overview` open the Studio profile (the
+  old `/dashboard` URL still does), the agent's character is painted over the core header's avatar,
+  **Runs** opens the agent's runs under Audit, **Settings** opens Harness / Runtime, and
+  `?classic=1` keeps the core's own overview.
+- **Connectors.** Upstream now calls its outside-tools area Connectors, which already keeps "Apps" for
+  KyoubeAI's Apps, so the theme drops its Connections renames and only fixes the three breadcrumbs
+  that still said "Apps".
+- **Announcements off.** `docker-compose.yml` sets `PAPERCLIP_ANNOUNCEMENTS_ENABLED=false`, so the
+  core's hosted Paperclip announcement cards do not appear, and passes `TRUST_PROXY` through from
+  `.env`.
+
+### Fixed
+
+- The agent **Instructions** tab no longer loops on "Discard unsaved agent configuration changes?";
+  core 2026.916 carries the upstream fix (#12502), so the README's workaround is gone.
+- The first-run wizard's **Skip for now** works again on the new wizard: its Connect step cannot sign
+  a Claude or OpenAI subscription in on a KyoubeAI server (the core allows that only to the local
+  operator of a `local_trusted` instance), and the wizard has no close button. The four
+  `onboarding-skip-harness-*` core patches add **Skip for now and connect the harness later from the
+  Terminal page** under any Connect error; it hires the agent without the sign-in and the environment
+  test. `scripts/onboarding-live-check.mjs` walks the wizard to that skip on every smoke run.
+- The pi transcript fix (`pi-transcript-non-assistant-messages`) follows the parser into the
+  code-split chunk it moved to; upstream still has the bug.
+- On the core's agent overview, sections without a border no longer sit in grey bands (the core
+  paints them with the card colour, which KyoubeAI's dark theme sets a step lighter than the page).
+- `scripts/migrate-from-0.1.sh --check` no longer counts the core's own skill keys
+  (`paperclipai/paperclip/…`, stored in an agent's config once it has skills) as legacy
+  `/paperclip/` paths, so the count can reach 0 and the compatibility link can go.
+
 ## 1.2.0 - 2026-09-24
 
 ### Added
diff --git a/package.json b/package.json
index ec06c69..d2f8a8b 100644
--- a/package.json
+++ b/package.json
@@ -1,6 +1,6 @@
 {
   "name": "kyoubeai",
-  "version": "1.2.0",
+  "version": "1.3.0",
   "private": true,
   "type": "module",
   "description": "Multi-user AI operating system for organisations",
PATCH
````

- [ ] **Step 3: Check that no stale statement is left**

```bash
grep -rn "Connected apps\|12502\|core 2026.831.1 only\|Org chart, Activity" README.md docs/theme.md docs/upgrading.md CONTRIBUTING.md docs/apps.md docs/governance.md docs/architecture.md
jq -r .version package.json
```

Expected: no `grep` output, then `1.3.0`.

- [ ] **Step 4: Run the tests (manifest comments changed)**

```bash
pnpm -r typecheck && pnpm -r test
```

Expected: every package passes.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md package.json CONTRIBUTING.md SECURITY.md docs plugins/kyoube-files/src/manifest.ts plugins/kyoube-terminal/src/manifest.ts plugins/kyoube-studio/src/manifest.ts
git commit -F - <<'MSG'
docs: KyoubeAI 1.3.0 on core 2026.916.1
MSG
```

---

### Task 10: Final verification

**Files:** none changed.

- [ ] **Step 1: Everything green from a clean install**

```bash
pnpm install --frozen-lockfile && bash scripts/check-pins.sh && pnpm -r typecheck && pnpm -r test
```

Expected: `pins consistent: 2026.916.1`; every package passes (core-patches 26, theme 18, rebrand 95, studio 66, plus the unchanged packages).

- [ ] **Step 2: The branch holds exactly this work**

```bash
git log --oneline main..HEAD
git status --short
```

Expected: nine commits (Tasks 1–9) and a clean tree apart from the untracked `.claude/`.

- [ ] **Step 3: Nothing was deployed**

```bash
docker ps --format '{{.Names}} {{.Image}}' | grep -E "bap-ai-os|kyoube-studio" 
```

Expected: the same containers and images as before this plan started (`bap-ai-os-app-1` still runs its old image). Nothing in this plan touches them.

---

## Appendix A: Getting the core image when `docker pull` stalls

On this machine `docker pull ghcr.io/paperclipai/paperclip:2026.916.1` retried the two largest layers indefinitely, while the registry's blob CDN served them fine in parallel ranges. This loads the same image, checksum-verified:

```bash
set -euo pipefail
work="$(mktemp -d)"; cd "$work"; mkdir -p oci/blobs/sha256
repo=paperclipai/paperclip; tag=2026.916.1
token=$(curl -fsS "https://ghcr.io/token?scope=repository:$repo:pull" | jq -r .token)
auth=(-H "Authorization: Bearer $token")
index=$(curl -fsS "${auth[@]}" -H "Accept: application/vnd.oci.image.index.v1+json" "https://ghcr.io/v2/$repo/manifests/$tag")
arch=$(docker version --format '{{.Server.Arch}}')
digest=$(echo "$index" | jq -r --arg a "$arch" '.manifests[] | select(.platform.architecture==$a and .platform.os=="linux") | .digest')
curl -fsS "${auth[@]}" -H "Accept: application/vnd.oci.image.manifest.v1+json" -o manifest.json "https://ghcr.io/v2/$repo/manifests/$digest"
for d in $(jq -r '.config.digest, .layers[].digest' manifest.json); do
  h=${d#sha256:}; size=$(jq -r --arg d "$d" '[.config, .layers[]] | map(select(.digest==$d)) | .[0].size' manifest.json)
  url=$(curl -sS -o /dev/null -w '%{redirect_url}' "${auth[@]}" "https://ghcr.io/v2/$repo/blobs/$d")
  n=8; chunk=$(( (size + n - 1) / n ))
  for i in $(seq 0 $((n-1))); do
    s=$((i*chunk)); e=$((s+chunk-1)); (( e >= size )) && e=$((size-1)); (( s > e )) && continue
    curl -fsS --retry 5 -r "$s-$e" -o "part.$i" "$url" &
  done; wait
  cat $(ls part.* | sort -t. -k2 -n) > "oci/blobs/sha256/$h"; rm -f part.*
  echo "$h  oci/blobs/sha256/$h" | sha256sum -c --quiet
done
jq -n --arg c "blobs/sha256/$(jq -r '.config.digest[7:]' manifest.json)" \
      --argjson l "$(jq '[.layers[].digest | "blobs/sha256/" + .[7:]]' manifest.json)" \
      --arg t "ghcr.io/$repo:$tag" '[{Config:$c, RepoTags:[$t], Layers:$l}]' > oci/manifest.json
tar -C oci -cf image.tar . && docker load -i image.tar && rm -rf "$work"
```

## Note to the reviewer: one decision changes

1.2.0 renamed the core's "Apps" area to **Connections** (and its sub-page to "Connected apps") so that "Apps" meant only KyoubeAI's Apps. Core 2026.916 renamed that area itself, to **Connectors**, everywhere: sidebar, page title, breadcrumbs, search placeholder and its own copy ("Connect Airtable's …", "Search connectors…"). Keeping "Connections" now means renaming upstream's word in a dozen places and still leaving "connectors" in its sentences. This plan adopts upstream's **Connectors**, which keeps the goal (no clash with KyoubeAI's Apps) with one rule instead of eleven. If you would rather keep "Connections", say so before Task 3; it is one extra rule set in `docker/theme/rules.mjs` and a card title in `links.ts`.
