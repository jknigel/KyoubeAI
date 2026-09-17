# White-label Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every surface a user, an agent or an operator sees says KyoubeAI instead of Paperclip, and stays that way across core (upstream) image bumps without anyone re-doing the rename.

**Architecture:** A dependency-free Node script (`docker/rebrand/rebrand.mjs`) runs inside `docker/Dockerfile` right after the upstream `FROM` layer's expensive tool installs: it rewrites display text with one case-sensitive word-boundary rule, swaps artwork, replaces two SVGs inside the minified UI bundle, re-hashes the immutable `/assets` file names, and fails the build when anything upstream slipped past the rules. The container's home moves to `/kyoubeai`, the Postgres role/database become `kyoubeai`, `.env` keys become `KYOUBE_*` (compose maps them onto the upstream env names), and a one-off script migrates 0.1.x installs.

**Tech Stack:** Node 24 ESM (no runtime dependencies in the transform), Vitest 5, `@resvg/resvg-js` (dev-time icon rendering only), Docker Compose v5 nested interpolation (`${A:-${B:-x}}`, `${A:+text}`), PostgreSQL 17 (`ALTER ROLE … RENAME`, `ALTER DATABASE … RENAME`), bash.

**Spec:** `docs/superpowers/specs/2026-09-13-white-label-design.md`. Read it first; §1 lists the exceptions that are *kept on purpose*, and this plan never "fixes" one of them.

> **Post-execution notes (2026-09-14).** The white-label work is implemented and accepted; where the code differs from the snippets below, the code and the rulings recorded in `.superpowers/sdd/2026-09-13-white-label/progress.md` are authoritative. **Verification (Task 16).** `pnpm typecheck && pnpm test && pnpm build && node scripts/browser-check.mjs && node scripts/terminal-fit-check.mjs && node scripts/app-frame-check.mjs && bash scripts/check-pins.sh` is green: 469 unit tests in 46 files — `docker/rebrand` 70/5, `docker/bootstrap` 67/8, `packages/kyoube-app-sdk` 10/3, `plugins/kyoube-terminal` 110/11, `plugins/kyoube-apps` 212/19 — plus 23 browser document shapes, 2 terminal-fit shapes, 5 app-frame shapes and the pin check at `2026.831.1`. `KEEP=1 bash scripts/smoke.sh` passed in **372 s** over 26 stages on a warm image cache (build layers all `CACHED`, including the rebrand stage, so the build log's `rebrand: 389 files rewritten (url 75, name 3067, phrase 72), 221 assets renamed, 954 references rewritten` / `anchors lockup=1 thinking=1; residual 0; binaries skipped 0` describe the image under test); `brand-live-check` reports `http://localhost:3199/auth is branded as KyoubeAI`, and the four served icons are byte-identical to `docker/brand/icons/`. Ten signed-in pages were read over CDP (dashboard, agents list, an agent's page + Configuration + Skills tabs, Settings → Plugins, Terminal, Apps, Skills library): nine show no "Paperclip" at all — not even the Skills library's key column, whose keys are not in the rendered text — and agent-facing text is branded (`/app/skills/paperclip/SKILL.md` has zero display-text matches of the name rule, its four remaining lines being the `X-Paperclip-Run-Id` header; `heartbeat.js` carries `"KyoubeAI task context:"`). **Real 0.1.x → 0.2.0 rehearsal.** A v0.1.5 worktree on the prebuilt `kyoubeai:v012` image, brought up on :3198 with `HOME=/paperclip`, the `paperclip` role and database, a `paperclip-home` volume and a served `<title>Paperclip</title>`, then migrated by `scripts/migrate-from-0.1.sh` with a backup: the three `.env` keys were rewritten to `KYOUBE_*`, the role and database renamed through `kyoube_migrator`, the home volume copied with the marker, the 0.2.0 image built over the same `kyoubeai:v012` tag, and the app came back healthy serving `<title>KyoubeAI</title>` — the pre-migration company, agent and board API key all intact (`GET /api/plugins` 200 on the old token), `kyoube doctor` reporting `legacy env none` and `legacy home link /paperclip -> /kyoubeai compatibility link active`, both plugins reaching `ready` at 0.2.3 / 0.4.2, `--check` reporting `1 stored path(s) still start with /paperclip/`, and `/auth` branded. (`doctor` also says `FAIL board key missing`: the rehearsal created its key over the API and never ran `kyoube setup`, so none was stored on disk — an artefact of the rehearsal, not of the migration.) **Rulings that deviated from the snippets below.** The plan's `/paperclip-thinking.svg answers 404` assertion is unreachable — upstream's SPA catch-all serves `index.html` (200) for every unmatched path — so the smoke asserts the response is *not* `image/svg+xml` instead. `MSYS_NO_PATHCONV=1` is a per-command prefix on `docker run`, never a global export: exported, it also stops Git Bash converting `COMPOSE_ENV_FILES` and every compose call fails. The Postgres rename goes through a temporary `kyoube_migrator` superuser that renames the bootstrap role in place (`ALTER ROLE paperclip RENAME TO kyoubeai`), because that role owns pinned system objects and can be neither reassigned nor dropped; the migrator's existence is the step's idempotence marker. In the transform, `.` counts as a token boundary in `rewriteReferences`, and the dangling-reference check resolves three reference forms (`/assets/<name>`, a guarded `./<name>` inside `assets`, and `sourceMappingURL=<name>`) at any extension, relative forms resolved against the referring file. The plan's `findResidual` fixture used letters as filler, which the name rule classifies as an identifier; the filler is `.` and the rule is unchanged. **Residual identifiers** are recorded in `docs/branding.md` ("Residual identifiers on core 2026.831.1"), measured on the built image rather than guessed. **Two display-text leaks outside the transform's file set** were found by the live sweep and are follow-up work, not part of the kept-by-design set: Settings → Plugins lists upstream's bundled and example plugins with 11 descriptions saying "Paperclip", which `GET /api/plugins/examples` reads out of `packages/plugins/**/package.json` and `**/src/manifest.ts` — paths the `packages` root in `docker/rebrand/lib/files.mjs` excludes because it admits only `dist/` (plus `skills-catalog`/`teams-catalog`); and `/app/skills/paperclip/scripts/paperclip-upload-artifact.sh` says "to the current Paperclip instance" in its usage text, the `skills` root's extension allowlist being `.md`/`.json`/`.yaml`/`.yml`. Fixed in fix round 1: the transform's file set now covers `packages/plugins/**` sources and skill scripts; the smoke asserts `GET /api/plugins/examples` is branded. **Manual acceptance still owed:** a real heartbeat run whose transcript shows "KyoubeAI task context:" (it needs a provider key, so no automated check reaches it), and the migration of the user's own 0.1.x deployment. The release itself — the `0.2.0` tag, the `package.json` version and the GHCR publish — remains the user's call. **Final review fix wave (2026-09-14).** The whole-branch review found one Critical and five Important issues. The Critical one (C1) was a wrong premise in the spec's §0 and §B.1: the workspace packages are **not** served from `packages/*/dist`. The image's CMD loads tsx, every `@paperclipai/*` package's `exports` map points at `./src/*.ts`, and three packages ship no `dist` at all — so `packages/**/src` is the live code and everything the transform had been rewriting under `packages/*/dist` was dead. Hermes agents were being told they work "in a Paperclip-managed company", adapter config labels and Skills-tab origin labels said Paperclip, and the `[paperclip]` log-prefix emitters in `packages/adapter-utils/src` had never been rewritten while the rebranded UI bundle already expected `[kyoubeai]` — a behaviour regression, not only a cosmetic one. The `packages` root now admits all of `packages/**`; code files there go through a new `rewriteCode` that applies the phrase and URL rules unconditionally and holds the name rule back only where a match is outside any string/comment on its line *and* identifier-shaped (`import { Paperclip }`, `<Paperclip`, `icon: Paperclip`). That second condition is a deliberate narrowing of the controller's ruling, which said "outside a string or comment" alone: run against the image, the quote/comment test on its own classified ~85 display strings as code — every adapter's multi-line template-literal `docs` block and the LLM-wiki plugin's JSX text — while the image contains **zero** bare-identifier uses of the name (every one is a `PaperclipXxx` camelCase identifier the rule already excludes). `--verify`'s residual check (I1) was tautological, so the build now also sweeps all of `/app`, counts name matches per tree, prints the table, and fails for any tree outside a documented allowlist of never-executed upstream source; that sweep is what found `cli/README.md`, `ui/index.html`, `.claude/skills`, `doc/plans`, `docs/docs.json`, a systemd unit under `packages/tailscale-https-broker` (now rewritten) and the three hash-pinned `packages/db` migrations. On I5 the residual path was taken with evidence: `packages/db/src/client.ts`'s `loadAppliedMigrations` reads `SELECT hash FROM drizzle.__drizzle_migrations` and resolves it through `mapHashesToMigrationFiles`, which hashes the files on disk, so rewriting `0105_instance_scoped_environments.sql` would make an upgraded install replay it; the seeded description is a documented, build-reported residual instead. I2 added a smoke stage that renames the disaster-recovery backup to the 0.1.x file names and restores it, proving `scripts/restore.sh`'s legacy-name path end to end; I3 made the migration's refusal name the `git pull && docker compose up` cause and print the working `docker compose rm -sf app && docker volume rm <vol>` remedy; I4 added `--no-role-passwords` to the snapshot and documented restoring `cluster.sql` by hand. **New build counts:** `738 files rewritten (url 221, name 4187, phrase 320)` (was 523 / name 3566), `residual 0`, `code-shaped matches left alone: 0`, `lockup=1 thinking=1`, and every non-allowlisted sweep row at zero.

## Global Constraints

- Core image pin stays `ghcr.io/paperclipai/paperclip:2026.831.1`; the Dockerfile ARG is renamed `KYOUBE_CORE_VERSION` (was `PAPERCLIP_VERSION`) but its value does not change. `@paperclipai/plugin-sdk` stays `2026.831.1`.
- The generic name rule, verbatim from the spec: replace `Paperclip` (case-sensitive) when it is **not preceded by** `[A-Za-z0-9_$-]` and **not followed by** `[A-Za-z0-9_$]`. Lowercase `paperclip` is never touched except through the explicit phrase and URL maps.
- Never rename: `PAPERCLIP_*` environment variable names inside the container; skill keys and slugs; enum values (`paperclip_runner`, `paperclip_managed`); CSS classes and localStorage keys; package names; the `X-Paperclip-Run-Id` header; the `FROM` image reference; upstream's copyright notice in `LICENSE`.
- Brand values come from `docker/brand/brand.json` (`name` is `KyoubeAI`); nothing in `docker/rebrand/` hard-codes the name.
- New container home: `/kyoubeai` (`HOME`, `PAPERCLIP_HOME`, `PAPERCLIP_CONFIG=/kyoubeai/instances/default/config.json`, `HERMES_HOME=/kyoubeai/.hermes`). Postgres superuser role and database: `kyoubeai`. Compose volume: `kyoubeai-home`. Migration marker: `/kyoubeai/.migrated-from-paperclip-home`.
- Operator keys: `KYOUBE_PUBLIC_URL`, `KYOUBE_DEPLOYMENT_EXPOSURE`, `KYOUBE_CORE_VERSION`; legacy `PAPERCLIP_PUBLIC_URL`, `PAPERCLIP_DEPLOYMENT_EXPOSURE`, `PAPERCLIP_VERSION` keep working for this release through nested defaults.
- Plugin versions this release ships: `kyoube.terminal` 0.2.3, `kyoube.apps` 0.4.2. Product version 0.2.0 (breaking). The user commits and tags; tasks end with a commit step, but **do not push**.
- ESM + strict TypeScript for `docker/bootstrap` and the plugins (`.js` suffix on relative imports); the transform and its tests are plain `.mjs`. Conventional Commits. The working copy is CRLF (git normalises to LF); write files back with the line endings the file already has.
- `docs/superpowers/**` (specs, plans) is engineering history: never rewrite "Paperclip" there.
- Deviations from the spec, decided while planning (the spec stays as written; these rulings win): (a) the standalone loading icon (`kyoubeai-thinking.svg`) is rendered by the transform at build time from `mark.svg`, not committed to the kit (spec §3); (b) the Postgres rename goes through a temporary superuser that *renames* the bootstrap role (`ALTER ROLE paperclip RENAME TO kyoubeai`) instead of the spec §7's create + `REASSIGN OWNED` + drop, because the bootstrap superuser owns pinned system objects and can be neither reassigned nor dropped (verified); (c) the count of stored `/paperclip/` paths and the legacy role/database check live in `scripts/migrate-from-0.1.sh --check` rather than in `kyoube doctor` (spec §5/§6), so the bootstrap CLI gains no Postgres driver; doctor reports `legacy env` and `legacy home link`; (d) CI's migration rehearsal (spec §8) is synthetic — it turns the smoke stack into the 0.1.x layout and migrates it — and the rehearsal against a real 0.1.x image is Task 16 Step 5, run once by hand.
- Facts verified on 2026-09-13 that the code below relies on: Compose v5.3.1 resolves `${KYOUBE_X:-${PAPERCLIP_X:-fallback}}` and `${VAR:+text}`; `pg_isready -U kyoubeai -d kyoubeai` exits 0 on a cluster where neither exists; the bootstrap superuser can be renamed by a *different* superuser session (`ALTER ROLE paperclip RENAME TO kyoubeai`) but not reassigned or dropped; a SCRAM password survives the rename; upstream's sign-in page is `/auth`; `/assets` is served `maxAge: 1y, immutable`; the lockup anchor is `viewBox:"22.5 22.5 121 27"` and the loading icon anchor is `className:"paperclip-thinking-icon-path",d:"…"`, both in the main `index-*.js` chunk.

---

## File structure

```
docker/brand/                         # A. the brand kit (data)
├─ brand.json                          # name, description, colours, urls, phrases
├─ mark.svg                            # one stroked path, 24×24 (favicon, loading icon, lockup mark)
├─ lockup.svg                          # mark + <text> wordmark, viewBox 0 0 124 28
└─ icons/                              # rendered by scripts/render-brand-icons.mjs, committed
   ├─ favicon.ico favicon-16x16.png favicon-32x32.png apple-touch-icon.png
   └─ android-chrome-192x192.png android-chrome-512x512.png
docker/rebrand/                       # B. the build-time transform (workspace package @kyoube/rebrand)
├─ package.json                        # name, type: module, scripts.test = vitest run
├─ rebrand.mjs                         # CLI: --root --brand [--verify] [--report]; orchestration
├─ lib/text-rules.mjs                  # NAME_RE, buildTextRules(brand), rewriteText(), findResidual()
├─ lib/svg.mjs                         # parseSvgElements(), replaceLockup(), replaceThinkingIcon(), renderFaviconSvg(), renderThinkingSvg(), renderManifest()
├─ lib/assets.mjs                      # planRenames(), rewriteReferences(), hashContent()
├─ lib/files.mjs                       # collectFiles(root), isBinary(), readText/writeText
└─ tests/*.spec.mjs                    # one spec per lib module + rebrand.spec.mjs (synthetic tree)
scripts/render-brand-icons.mjs        # dev-time: mark.svg → icons/*.png + favicon.ico + thinking.svg
scripts/brand-live-check.mjs          # headless Chrome against a running stack: title, no "Paperclip", lockup
scripts/lib/headless-chrome.mjs       # dumpDom() learns `network: true` and URL targets
scripts/migrate-from-0.1.sh           # D. one-off migration (+ --check)
scripts/bump-core.sh                  # renamed from bump-paperclip.sh
docker/Dockerfile                     # rebrand stage; HOME relocation; ARG KYOUBE_CORE_VERSION
docker/entrypoint.sh                  # home default /kyoubeai; compatibility link on marker
docker-compose.yml, .env.example, scripts/smoke.env, docker/postgres-init/01-kyoube.sh
scripts/{backup,restore,smoke,check-pins}.sh, renovate.json, .github/workflows/*.yml
docker/bootstrap/src/{config,core-api,skills,plugins}.ts, commands/{doctor,setup,ensure-plugins,write-config,cli}.ts
plugins/kyoube-{terminal,apps}/…      # config paths, hints, skills text, versions
README.md, docs/*.md, docs/branding.md (new), SECURITY.md, CONTRIBUTING.md, LICENSE, CHANGELOG.md, package.json
```

---

## Phase A — Brand kit and the build-time transform

### Task 1: Brand kit and icon renderer

**Files:**
- Create: `docker/brand/brand.json`, `docker/brand/mark.svg`, `docker/brand/lockup.svg`
- Create: `scripts/render-brand-icons.mjs`
- Create (generated, committed): `docker/brand/icons/{favicon.ico,favicon-16x16.png,favicon-32x32.png,apple-touch-icon.png,android-chrome-192x192.png,android-chrome-512x512.png}`
- Modify: `package.json` (root devDependency `@resvg/resvg-js`)
- Test: `docker/rebrand/tests/kit.spec.mjs` (written in Task 2 once the package exists; this task's check is the renderer's own assertions)

**Interfaces:**
- Produces: the kit files every later task reads. `brand.json` shape: `{ name, shortName, description, themeColor, urls: { home, docs, feedback, tos, repo }, phrases: Record<string,string> }`. `mark.svg` contains exactly one `<path d="…">`. `lockup.svg` contains one `<path>` and one `<text>`.

- [ ] **Step 1: Write `docker/brand/brand.json`**

```json
{
  "name": "KyoubeAI",
  "shortName": "KyoubeAI",
  "description": "AI operating system for organisations",
  "themeColor": "#18181b",
  "urls": {
    "home": "https://github.com/jknigel/KyoubeAI",
    "docs": "https://github.com/jknigel/KyoubeAI/tree/main/docs",
    "feedback": "https://github.com/jknigel/KyoubeAI/issues",
    "tos": "https://github.com/jknigel/KyoubeAI/blob/main/LICENSE",
    "repo": "https://github.com/jknigel/KyoubeAI"
  },
  "phrases": {
    "/Users/paperclip/workspace": "/Users/you/workspace",
    "[paperclip]": "[kyoubeai]"
  }
}
```

- [ ] **Step 2: Write `docker/brand/mark.svg`** (one stroked path; the "K" is two subpaths of a single `d`, which is what the loading animation and favicon both need)

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M6 4v16M18 4l-11 8 11 8"/>
</svg>
```

- [ ] **Step 3: Write `docker/brand/lockup.svg`** (the wordmark is `<text>` in Inter, which the host UI already loads; `fill` on the root is `currentColor`, exactly like upstream's lockup, so it follows the theme)

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 124 28" fill="currentColor">
  <path d="M6 4v16M18 4l-11 8 11 8" transform="translate(0 2)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="30" y="21" font-family="Inter, system-ui, sans-serif" font-weight="600" font-size="19" letter-spacing="-0.02em">KyoubeAI</text>
</svg>
```

- [ ] **Step 4: Add the renderer dependency**

Run: `pnpm add -Dw @resvg/resvg-js@^2.6.2`
Expected: `package.json` gains the devDependency, `pnpm-lock.yaml` updates, install succeeds (it ships prebuilt binaries for win32/linux/darwin).

- [ ] **Step 5: Write `scripts/render-brand-icons.mjs`**

```js
#!/usr/bin/env node
/**
 * Renders the committed brand icons from docker/brand/mark.svg. Run it after
 * changing the mark; the outputs are committed so the image build needs no
 * rasteriser. PNG icons get a rounded dark plate behind a light stroke so they
 * read on any launcher background; the SVG favicon stays theme-aware (Task 3).
 *
 *   node scripts/render-brand-icons.mjs
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRAND = path.join(ROOT, "docker", "brand");
const ICONS = path.join(BRAND, "icons");

/** The single path the mark is made of; the renderer and the transform both key on it. */
export function markPath(markSvg) {
  const paths = [...markSvg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
  if (paths.length !== 1) throw new Error(`mark.svg must contain exactly one <path>, found ${paths.length}`);
  return paths[0];
}

/** A plate + stroke composition sized for launchers; `size` is the output pixel size. */
function plateSvg(d, size, brand) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
<rect width="24" height="24" rx="5" fill="${brand.themeColor}"/>
<path d="${d}" fill="none" stroke="#e4e4e7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

function renderPng(svg, size) {
  return new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
}

/** ICO container holding one PNG entry (valid since Windows Vista; every browser reads it). */
export function pngToIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0);
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // offset: header + one entry
  return Buffer.concat([header, entry, png]);
}

async function main() {
  const brand = JSON.parse(await readFile(path.join(BRAND, "brand.json"), "utf8"));
  const d = markPath(await readFile(path.join(BRAND, "mark.svg"), "utf8"));
  await mkdir(ICONS, { recursive: true });
  const outputs = [
    ["favicon-16x16.png", 16],
    ["favicon-32x32.png", 32],
    ["apple-touch-icon.png", 180],
    ["android-chrome-192x192.png", 192],
    ["android-chrome-512x512.png", 512],
  ];
  for (const [name, size] of outputs) {
    await writeFile(path.join(ICONS, name), renderPng(plateSvg(d, size, brand), size));
    console.log(`wrote icons/${name}`);
  }
  await writeFile(path.join(ICONS, "favicon.ico"), pngToIco(renderPng(plateSvg(d, 48, brand), 48), 48));
  console.log("wrote icons/favicon.ico");
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) await main();
```

- [ ] **Step 6: Render and eyeball**

Run: `node scripts/render-brand-icons.mjs && ls -l docker/brand/icons`
Expected: six files; each PNG a few hundred bytes to ~10 KB; `favicon.ico` ≈ the 48px PNG + 22 bytes. Open `docker/brand/icons/android-chrome-512x512.png` with the Read tool to confirm a dark rounded plate with a light "K".

- [ ] **Step 7: Commit**

```bash
git add docker/brand scripts/render-brand-icons.mjs package.json pnpm-lock.yaml
git commit -m "feat(brand): add the KyoubeAI brand kit and icon renderer"
```

---

### Task 2: `@kyoube/rebrand` package and the text rules

**Files:**
- Create: `docker/rebrand/package.json`, `docker/rebrand/lib/text-rules.mjs`
- Modify: `pnpm-workspace.yaml`
- Test: `docker/rebrand/tests/text-rules.spec.mjs`, `docker/rebrand/tests/kit.spec.mjs`

**Interfaces:**
- Produces:
  - `NAME_RE: RegExp` (global, the spec's rule)
  - `buildTextRules(brand): Rule[]` where `Rule = { kind: "phrase" | "url" | "name", from: string | RegExp, to: string }`
  - `rewriteText(text: string, rules: Rule[]): { text: string, counts: Record<string, number> }` — counts keyed by rule kind
  - `findResidual(text: string, max = 5): string[]` — up to `max` 80-char contexts around remaining `NAME_RE` matches

- [ ] **Step 1: Package skeleton**

`docker/rebrand/package.json`:
```json
{
  "name": "@kyoube/rebrand",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Build-time transform that brands the upstream image as KyoubeAI (docker/Dockerfile runs rebrand.mjs after FROM)",
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^5.0.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "docker/bootstrap"
  - "docker/rebrand"
  - "plugins/*"
  - "packages/*"
```

Run: `pnpm install` — Expected: the new workspace package links; `pnpm -r test` will now include it (no `typecheck` script, so `pnpm typecheck` skips it — intended, the package is plain JS).

- [ ] **Step 2: Write the failing tests** — `docker/rebrand/tests/text-rules.spec.mjs`

```js
import { describe, expect, it } from "vitest";
import { NAME_RE, buildTextRules, findResidual, rewriteText } from "../lib/text-rules.mjs";

const brand = {
  name: "KyoubeAI",
  urls: {
    home: "https://example.test/home",
    docs: "https://example.test/docs",
    feedback: "https://example.test/feedback",
    tos: "https://example.test/tos",
    repo: "https://example.test/repo",
  },
  phrases: { "/Users/paperclip/workspace": "/Users/you/workspace", "[paperclip]": "[kyoubeai]" },
};
const rules = buildTextRules(brand);
const run = (text) => rewriteText(text, rules).text;

describe("the generic name rule", () => {
  it.each([
    ['children:"Welcome to Paperclip"', 'children:"Welcome to KyoubeAI"'],
    ["Paperclip's current default", "KyoubeAI's current default"],
    ['"Paperclip-managed folder."', '"KyoubeAI-managed folder."'],
    ["**Paperclip** skill", "**KyoubeAI** skill"],
    ["[Paperclip](https://x)", "[KyoubeAI](https://x)"],
    ['"Paperclip task context:"', '"KyoubeAI task context:"'],
    ["/^Paperclip exhausted the bounded/", "/^KyoubeAI exhausted the bounded/"],
    ["title:t=\"Paperclip\"", "title:t=\"KyoubeAI\""],
  ])("rewrites display text %j", (input, expected) => {
    expect(run(input)).toBe(expected);
  });

  it.each([
    "e?.metadata?.managedByPaperclip===!0",
    "manifest.minimumPaperclipVersion",
    "function PaperclipLockup(){}",
    "readPaperclipSkillSyncPreference(config)",
    "class PaperclipCloudConnector {}",
    'header("X-Paperclip-Run-Id")',
    'e.set("X-Paperclip-Route",p)',
    "PAPERCLIP_API_URL=$PAPERCLIP_RUN_ID",
    '"paperclipai/paperclip/paperclip"',
    'managedMode:"paperclip_managed"',
    '"paperclip:inbox:filters"',
    ".paperclip-mention-chip{}",
    "https://telemetry.paperclip.ing/ingest",
    "https://pages.paperclip.ing",
    'new URL(t,"https://paperclip.invalid")',
  ])("leaves the identifier %j alone", (input) => {
    expect(run(input)).toBe(input);
  });

  it("is symmetric: a message and the regex that matches it change together", () => {
    const server = 'throw new Error("Paperclip could not restore the revision.")';
    const ui = 'if(/^Paperclip could not/.test(m))';
    expect(run(server)).toContain("KyoubeAI could not restore");
    expect(run(ui)).toContain("/^KyoubeAI could not/");
  });
});

describe("phrase overrides", () => {
  it("apply before the name rule and only to the exact text", () => {
    expect(run('placeholder:"/Users/paperclip/workspace"')).toBe('placeholder:"/Users/you/workspace"');
    expect(run('n.startsWith("[paperclip]")')).toBe('n.startsWith("[kyoubeai]")');
    expect(run('"[paperclip-runner]"')).toBe('"[paperclip-runner]"');
  });
});

describe("the URL map", () => {
  it.each([
    ['href:"https://docs.paperclip.ing/"', 'href:"https://example.test/docs"'],
    ['"https://docs.paperclip.ing/guides/x#y"', '"https://example.test/docs"'],
    ['"https://paperclip.ing/feedback"', '"https://example.test/feedback"'],
    ['"https://paperclip.ing/tos"', '"https://example.test/tos"'],
    ['href:"https://paperclip.ing/ee"', 'href:"https://example.test/home"'],
    ['P1e="https://github.com/paperclipai/paperclip"', 'P1e="https://example.test/repo"'],
    ['"https://github.com/paperclipai/paperclip/blob/master/doc/INSTALLING.md#x"', '"https://example.test/repo"'],
    ["[Paperclip](https://paperclip.ing) on", "[KyoubeAI](https://example.test/home) on"],
    ['url:"https://paperclip.ing"}', 'url:"https://example.test/home"}'],
  ])("maps %j", (input, expected) => {
    expect(run(input)).toBe(expected);
  });

  it("does not touch the telemetry, pages or invalid hosts", () => {
    for (const keep of ["https://telemetry.paperclip.ing/feedback-traces", "https://pages.paperclip.ing/x", "https://paperclip.invalid"]) {
      expect(run(keep)).toBe(keep);
    }
  });
});

describe("counts and residuals", () => {
  it("reports how many replacements each rule kind made", () => {
    const { counts } = rewriteText('Paperclip and Paperclip, https://paperclip.ing/tos, [paperclip]', rules);
    expect(counts).toEqual({ phrase: 1, url: 1, name: 2 });
  });

  it("finds what the rule would still match, with context", () => {
    expect(findResidual("nothing here")).toEqual([]);
    const residual = findResidual("x".repeat(50) + "Paperclip rules" + "y".repeat(50));
    expect(residual).toHaveLength(1);
    expect(residual[0]).toContain("Paperclip rules");
    expect(residual[0].length).toBeLessThanOrEqual(80);
  });

  it("exports the rule as a global regex", () => {
    expect(NAME_RE.flags).toContain("g");
    expect("a Paperclip b Paperclip".match(NAME_RE)).toHaveLength(2);
  });
});
```

And `docker/rebrand/tests/kit.spec.mjs` (pins the kit's contract the transform relies on):

```js
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BRAND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../brand");
const read = (name) => readFile(path.join(BRAND, name), "utf8");

describe("docker/brand", () => {
  it("brand.json carries every field the transform reads", async () => {
    const brand = JSON.parse(await read("brand.json"));
    expect(brand.name).toBe("KyoubeAI");
    expect(typeof brand.shortName).toBe("string");
    expect(typeof brand.description).toBe("string");
    expect(brand.themeColor).toMatch(/^#[0-9a-f]{6}$/);
    for (const key of ["home", "docs", "feedback", "tos", "repo"]) expect(brand.urls[key]).toMatch(/^https:\/\//);
    expect(typeof brand.phrases).toBe("object");
  });

  it("mark.svg is a single stroked path in a 24×24 box", async () => {
    const svg = await read("mark.svg");
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect([...svg.matchAll(/<path\b/g)]).toHaveLength(1);
    expect(svg).not.toMatch(/<(rect|circle|text|g)\b/);
  });

  it("lockup.svg is one path and one text element", async () => {
    const svg = await read("lockup.svg");
    expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);
    expect([...svg.matchAll(/<path\b/g)]).toHaveLength(1);
    expect([...svg.matchAll(/<text\b/g)]).toHaveLength(1);
    expect(svg).toContain(">KyoubeAI</text>");
  });

  it("the six icon files are committed and non-empty", async () => {
    for (const name of ["favicon.ico", "favicon-16x16.png", "favicon-32x32.png", "apple-touch-icon.png", "android-chrome-192x192.png", "android-chrome-512x512.png"]) {
      const bytes = await readFile(path.join(BRAND, "icons", name));
      expect(bytes.length, name).toBeGreaterThan(100);
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @kyoube/rebrand test`
Expected: `text-rules.spec.mjs` fails with "Cannot find module '../lib/text-rules.mjs'"; `kit.spec.mjs` passes (Task 1 wrote the kit).

- [ ] **Step 4: Write `docker/rebrand/lib/text-rules.mjs`**

```js
/**
 * The three text rules, applied in this order to every text file in the image:
 * exact phrase overrides (brand.json `phrases`), the URL map, then the generic
 * name rule. See the spec §B.2 for why the name rule is case-sensitive and
 * word-bounded: capitalised `Paperclip` is display text, everything else is an
 * identifier that upstream's own code compares against.
 */

/** Display-text form of the upstream name: not inside a camelCase identifier, not after a hyphen (headers), never lowercase. */
export const NAME_RE = /(?<![A-Za-z0-9_$-])Paperclip(?![A-Za-z0-9_$])/g;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function buildTextRules(brand) {
  const rules = [];
  for (const [from, to] of Object.entries(brand.phrases ?? {})) {
    rules.push({ kind: "phrase", from: new RegExp(escapeRegExp(from), "g"), to });
  }
  const { urls } = brand;
  // Longest / most specific first, so `paperclip.ing/feedback` never falls
  // through to the bare-host rule.
  rules.push(
    { kind: "url", from: /https:\/\/docs\.paperclip\.ing(?:\/[A-Za-z0-9./_#?=%-]*)?/g, to: urls.docs },
    { kind: "url", from: /https:\/\/paperclip\.ing\/feedback\b/g, to: urls.feedback },
    { kind: "url", from: /https:\/\/paperclip\.ing\/tos\b/g, to: urls.tos },
    { kind: "url", from: /https:\/\/paperclip\.ing\/ee\b/g, to: urls.home },
    { kind: "url", from: /https:\/\/github\.com\/paperclipai\/paperclip(?:\/[A-Za-z0-9./_#?=%-]*)?/g, to: urls.repo },
    { kind: "url", from: /https:\/\/paperclip\.ing(?=["'`)}\]\s,]|$)/g, to: urls.home },
  );
  rules.push({ kind: "name", from: NAME_RE, to: brand.name });
  return rules;
}

export function rewriteText(text, rules) {
  const counts = {};
  let out = text;
  for (const rule of rules) {
    let n = 0;
    out = out.replace(rule.from, () => { n += 1; return rule.to; });
    if (n > 0) counts[rule.kind] = (counts[rule.kind] ?? 0) + n;
  }
  return { text: out, counts };
}

/** Contexts (≤ 80 chars) around what the name rule would still match — empty means clean. */
export function findResidual(text, max = 5) {
  const found = [];
  for (const match of text.matchAll(NAME_RE)) {
    const start = Math.max(0, match.index - 35);
    found.push(text.slice(start, start + 80).replace(/\s+/g, " "));
    if (found.length >= max) break;
  }
  return found;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @kyoube/rebrand test`
Expected: all green. If the "does not touch … invalid hosts" case fails, the bare-host lookahead is wrong — it must only fire when the character after `paperclip.ing` is a quote, backtick, `)`, `}`, `]`, whitespace, comma or end of input.

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml docker/rebrand
git commit -m "feat(rebrand): text rules for the build-time brand transform"
```

---

### Task 3: SVG surgery, favicon/thinking SVGs and the manifest

**Files:**
- Create: `docker/rebrand/lib/svg.mjs`
- Test: `docker/rebrand/tests/svg.spec.mjs`

**Interfaces:**
- Produces:
  - `parseSvgElements(svg): { viewBox: string, elements: Array<{ tag: "path" | "text", attrs: Record<string,string>, text: string | null }> }`
  - `markPathFrom(markSvg): string` — the single `d`
  - `jsxProps(attrs, extra?): string` — a minified JS object literal with React prop names (`stroke-width` → `strokeWidth`)
  - `replaceLockup(js, lockup): { text, matches }` where `lockup = parseSvgElements(lockupSvg)`; throws unless `matches === 1`? **No** — returns `matches` and lets the orchestrator decide, so the verify step can report "0 in this file" per file and "1 overall".
  - `replaceThinkingIcon(js, markD): { text, matches }`
  - `renderFaviconSvg(markD): string`, `renderThinkingSvg(markD): string`, `renderManifest(upstreamJson, brand): string`
  - `THINKING_PATH_LENGTH = "85.717"`

- [ ] **Step 1: Write the failing tests** — `docker/rebrand/tests/svg.spec.mjs`

```js
import { describe, expect, it } from "vitest";
import {
  THINKING_PATH_LENGTH, jsxProps, markPathFrom, parseSvgElements, renderFaviconSvg, renderManifest,
  renderThinkingSvg, replaceLockup, replaceThinkingIcon,
} from "../lib/svg.mjs";

const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M6 4v16M18 4l-11 8 11 8"/>
</svg>`;
const LOCKUP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 124 28" fill="currentColor">
  <path d="M6 4v16M18 4l-11 8 11 8" transform="translate(0 2)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="30" y="21" font-family="Inter, system-ui, sans-serif" font-weight="600" font-size="19" letter-spacing="-0.02em">KyoubeAI</text>
</svg>`;

// The exact minified shape upstream 2026.831.1 ships (two of its ten paths, shortened).
const UPSTREAM_LOCKUP = 'function DXn({decorative:e=!1,title:t="Paperclip",className:n,...r}){return(0,s.jsxs)("svg",{...r,className:n,viewBox:"22.5 22.5 121 27",fill:"currentColor",role:e?void 0:"img","aria-hidden":e?!0:void 0,"aria-label":e?void 0:t,focusable:"false",children:[(0,s.jsx)("path",{d:"M131.15 48.4902V31.9902H133.922Z"}),(0,s.jsx)("path",{d:"M46.2611 33.6556L34.7307 44.6408Z"})]})}';
const UPSTREAM_THINKING = 'function VXn({className:e,...t}){return(0,s.jsx)("svg",{viewBox:"-1 -1 26 26",className:U("paperclip-thinking-icon",e),"aria-hidden":"true",...t,children:(0,s.jsx)("path",{className:"paperclip-thinking-icon-path",d:"M16 6 l-8.414 8.586 a2.000 2.000 0 0 0 2.828 2.828",fill:"none",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round"})})}';

describe("parseSvgElements / markPathFrom / jsxProps", () => {
  it("reads the viewBox and the path/text children with their attributes", () => {
    const lockup = parseSvgElements(LOCKUP);
    expect(lockup.viewBox).toBe("0 0 124 28");
    expect(lockup.elements.map((e) => e.tag)).toEqual(["path", "text"]);
    expect(lockup.elements[0].attrs.d).toBe("M6 4v16M18 4l-11 8 11 8");
    expect(lockup.elements[0].attrs["stroke-width"]).toBe("2");
    expect(lockup.elements[1].text).toBe("KyoubeAI");
  });

  it("markPathFrom returns the single d and rejects anything else", () => {
    expect(markPathFrom(MARK)).toBe("M6 4v16M18 4l-11 8 11 8");
    expect(() => markPathFrom(MARK.replace("</svg>", '<path d="M0 0"/></svg>'))).toThrow(/exactly one/);
  });

  it("jsxProps converts SVG attribute names to React props and quotes values", () => {
    expect(jsxProps({ d: "M0 0", "stroke-width": "2", "font-family": "Inter, x", "stroke-linecap": "round", transform: "translate(0 2)" }))
      .toBe('{d:"M0 0",strokeWidth:"2",fontFamily:"Inter, x",strokeLinecap:"round",transform:"translate(0 2)"}');
    expect(jsxProps({ x: "30" }, { children: "KyoubeAI" })).toBe('{x:"30",children:"KyoubeAI"}');
  });
});

describe("replaceLockup", () => {
  it("swaps the viewBox and the path-only children for the kit's mark and wordmark, through the same jsx helper", () => {
    const { text, matches } = replaceLockup(UPSTREAM_LOCKUP, parseSvgElements(LOCKUP));
    expect(matches).toBe(1);
    expect(text).toContain('viewBox:"0 0 124 28"');
    expect(text).not.toContain("M131.15");
    expect(text).toContain('(0,s.jsx)("path",{d:"M6 4v16M18 4l-11 8 11 8",transform:"translate(0 2)",fill:"none",stroke:"currentColor",strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round"})');
    expect(text).toContain('(0,s.jsx)("text",{x:"30",y:"21",fontFamily:"Inter, system-ui, sans-serif",fontWeight:"600",fontSize:"19",letterSpacing:"-0.02em",children:"KyoubeAI"})');
    // Everything around the children array is untouched: the aria wiring still reads the title prop.
    expect(text).toContain('"aria-label":e?void 0:t,focusable:"false",children:[');
    expect(text.endsWith("]})}")).toBe(true);
  });

  it("reports 0 matches on a file without the anchor and 2 on a doubled one", () => {
    expect(replaceLockup("nothing", parseSvgElements(LOCKUP)).matches).toBe(0);
    expect(replaceLockup(UPSTREAM_LOCKUP + UPSTREAM_LOCKUP, parseSvgElements(LOCKUP)).matches).toBe(2);
  });
});

describe("replaceThinkingIcon", () => {
  it("replaces the animated path and pins pathLength so upstream's dash keyframes still draw the whole mark", () => {
    const { text, matches } = replaceThinkingIcon(UPSTREAM_THINKING, "M6 4v16M18 4l-11 8 11 8");
    expect(matches).toBe(1);
    expect(text).toContain(`className:"paperclip-thinking-icon-path",d:"M6 4v16M18 4l-11 8 11 8",pathLength:"${THINKING_PATH_LENGTH}",fill:"none"`);
    expect(text).not.toContain("M16 6 l-8.414");
  });
});

describe("renderFaviconSvg / renderThinkingSvg", () => {
  it("favicon keeps upstream's theme-aware stroke colours around the mark", () => {
    const svg = renderFaviconSvg("M6 4v16");
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain("prefers-color-scheme: dark");
    expect(svg).toContain('d="M6 4v16"');
    expect(svg).not.toContain("8.414");
  });

  it("thinking svg keeps the keyframes and pins pathLength", () => {
    const svg = renderThinkingSvg("M6 4v16");
    expect(svg).toContain("@keyframes draw");
    expect(svg).toContain("stroke-dasharray:0.000 85.717");
    expect(svg).toContain(`pathLength="${THINKING_PATH_LENGTH}"`);
    expect(svg).toContain('d="M6 4v16"');
  });
});

describe("renderManifest", () => {
  it("rewrites the names, description and colours and keeps the icon entries", () => {
    const upstream = JSON.stringify({ id: "/", name: "Paperclip", short_name: "Paperclip", description: "x", theme_color: "#000", background_color: "#000", icons: [{ src: "/android-chrome-192x192.png", sizes: "192x192", type: "image/png" }] });
    const out = JSON.parse(renderManifest(upstream, { name: "KyoubeAI", shortName: "KyoubeAI", description: "AI OS", themeColor: "#18181b" }));
    expect(out).toMatchObject({ id: "/", name: "KyoubeAI", short_name: "KyoubeAI", description: "AI OS", theme_color: "#18181b", background_color: "#18181b" });
    expect(out.icons).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @kyoube/rebrand test` → "Cannot find module '../lib/svg.mjs'".

- [ ] **Step 3: Write `docker/rebrand/lib/svg.mjs`**

```js
/**
 * The two SVGs that live *inside* the minified UI bundle (the sign-in lockup and
 * the loading animation) and the three static SVG/JSON artwork files. Anchored
 * on strings upstream's build does not minify (attribute values), never on
 * minified identifiers; the jsx helper name is captured from the match.
 */

/** Upstream's paperclip path length, hard-coded in its dash keyframes; pathLength normalises our mark to it. */
export const THINKING_PATH_LENGTH = "85.717";

const ELEMENT_RE = /<(path|text)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
const ATTR_RE = /([A-Za-z:-]+)="([^"]*)"/g;

export function parseSvgElements(svg) {
  const viewBox = /<svg\b[^>]*\bviewBox="([^"]+)"/.exec(svg)?.[1];
  if (!viewBox) throw new Error("svg has no viewBox");
  const elements = [];
  for (const match of svg.matchAll(ELEMENT_RE)) {
    const attrs = {};
    for (const attr of match[2].matchAll(ATTR_RE)) attrs[attr[1]] = attr[2];
    elements.push({ tag: match[1], attrs, text: match[3] === undefined ? null : match[3].trim() });
  }
  return { viewBox, elements };
}

export function markPathFrom(markSvg) {
  const paths = parseSvgElements(markSvg).elements.filter((e) => e.tag === "path");
  if (paths.length !== 1 || !paths[0].attrs.d) throw new Error(`mark.svg must contain exactly one <path> with a d attribute, found ${paths.length}`);
  return paths[0].attrs.d;
}

const toProp = (name) => (name === "viewBox" ? name : name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));

export function jsxProps(attrs, extra = {}) {
  const entries = Object.entries(attrs).filter(([name]) => name !== "class" && name !== "xmlns");
  const parts = entries.map(([name, value]) => `${toProp(name)}:${JSON.stringify(value)}`);
  for (const [name, value] of Object.entries(extra)) parts.push(`${name}:${JSON.stringify(value)}`);
  return `{${parts.join(",")}}`;
}

// `viewBox:"22.5 22.5 121 27"`, then the remaining attributes (no brackets in
// them), then a children array made only of ("path",{d:"…"}) elements.
const LOCKUP_RE = /viewBox:"22\.5 22\.5 121 27"([^[\]]{0,600}?)children:\[((?:\(0,([A-Za-z_$][\w$]*)\.jsx\)\("path",\{d:"[^"]*"\}\),?)+)\]/g;

export function replaceLockup(js, lockup) {
  let matches = 0;
  const text = js.replace(LOCKUP_RE, (_all, between, _children, helper) => {
    matches += 1;
    const children = lockup.elements.map((el) => {
      const extra = el.tag === "text" && el.text !== null ? { children: el.text } : {};
      return `(0,${helper}.jsx)(${JSON.stringify(el.tag)},${jsxProps(el.attrs, extra)})`;
    });
    return `viewBox:${JSON.stringify(lockup.viewBox)}${between}children:[${children.join(",")}]`;
  });
  return { text, matches };
}

const THINKING_RE = /className:"paperclip-thinking-icon-path",d:"[^"]*"/g;

export function replaceThinkingIcon(js, markD) {
  let matches = 0;
  const text = js.replace(THINKING_RE, () => {
    matches += 1;
    return `className:"paperclip-thinking-icon-path",d:${JSON.stringify(markD)},pathLength:${JSON.stringify(THINKING_PATH_LENGTH)}`;
  });
  return { text, matches };
}

export function renderFaviconSvg(markD) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <style>
    path { stroke: #18181b; }
    @media (prefers-color-scheme: dark) {
      path { stroke: #e4e4e7; }
    }
  </style>
  <path stroke-width="2" d="${markD}"/>
</svg>
`;
}

export function renderThinkingSvg(markD) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="-1.00 -1.00 26.00 26.00"
     style="transform:rotate(0deg);transform-origin:50% 50%;">
  <defs></defs>
  <style>
    @keyframes draw {
  0%          { stroke-dasharray:0.000 85.717; stroke-dashoffset:-85.717; opacity:1; animation-timing-function:cubic-bezier(0.455, 0.03, 0.515, 0.955); }
  39.0625%      { stroke-dasharray:85.717 85.717; stroke-dashoffset:0.000; opacity:1; animation-timing-function:cubic-bezier(0.55, 0.055, 0.675, 0.19); }
  78.1250%      { stroke-dasharray:0.000 85.717; stroke-dashoffset:0.000; opacity:1; }
  78.2250%  { opacity:0; }
  100%        { stroke-dasharray:0.000 85.717; stroke-dashoffset:0.000; opacity:0; }
}
    .p { animation: draw 1s linear infinite; }
  </style>
  <path class="p" d="${markD}" pathLength="${THINKING_PATH_LENGTH}" fill="none" stroke="#ffffff"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

export function renderManifest(upstreamJson, brand) {
  const manifest = JSON.parse(upstreamJson);
  manifest.name = brand.name;
  manifest.short_name = brand.shortName;
  manifest.description = brand.description;
  manifest.theme_color = brand.themeColor;
  manifest.background_color = brand.themeColor;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
```

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @kyoube/rebrand test` → green. If the lockup test fails on the `between` capture, print the match: the attributes between `viewBox` and `children:[` in the fixture are `,fill:"currentColor",role:e?void 0:"img","aria-hidden":e?!0:void 0,"aria-label":e?void 0:t,focusable:"false",` — none contain `[` or `]`, which is what `[^[\]]{0,600}?` relies on.

- [ ] **Step 5: Commit**

```bash
git add docker/rebrand
git commit -m "feat(rebrand): lockup, loading icon, favicon and manifest rendering"
```

---

### Task 4: Asset re-hashing

**Files:**
- Create: `docker/rebrand/lib/assets.mjs`
- Test: `docker/rebrand/tests/assets.spec.mjs`

**Interfaces:**
- Produces:
  - `hashContent(buffer | string, salt: string): string` — first 8 hex chars of SHA-256 over content + salt
  - `planRenames(entries: Array<{ name: string, hash: string }>): Map<string, string>` — `name-<h>.ext` → `name-<h>-<hash>.ext`; a `.map` follows its `.js`
  - `rewriteReferences(text: string, renames: Map<string,string>): { text, count }`

- [ ] **Step 1: Write the failing tests** — `docker/rebrand/tests/assets.spec.mjs`

```js
import { describe, expect, it } from "vitest";
import { hashContent, planRenames, rewriteReferences } from "../lib/assets.mjs";

describe("hashContent", () => {
  it("is 8 hex chars, stable, and salted", () => {
    expect(hashContent("abc", "kit1")).toMatch(/^[0-9a-f]{8}$/);
    expect(hashContent("abc", "kit1")).toBe(hashContent("abc", "kit1"));
    expect(hashContent("abc", "kit1")).not.toBe(hashContent("abc", "kit2"));
    expect(hashContent(Buffer.from("abc"), "kit1")).toBe(hashContent("abc", "kit1"));
  });
});

describe("planRenames", () => {
  it("suffixes every asset and keeps a .map on its .js", () => {
    const renames = planRenames([
      { name: "index-BHbrFFmp.js", hash: "aaaaaaaa" },
      { name: "index-BHbrFFmp.js.map", hash: "ffffffff" },
      { name: "index-BU41-p9M.css", hash: "bbbbbbbb" },
      { name: "CompanyExport-Z_xz3qVA.js", hash: "cccccccc" },
    ]);
    expect(renames.get("index-BHbrFFmp.js")).toBe("index-BHbrFFmp-aaaaaaaa.js");
    expect(renames.get("index-BHbrFFmp.js.map")).toBe("index-BHbrFFmp-aaaaaaaa.js.map");
    expect(renames.get("index-BU41-p9M.css")).toBe("index-BU41-p9M-bbbbbbbb.css");
    expect(renames.get("CompanyExport-Z_xz3qVA.js")).toBe("CompanyExport-Z_xz3qVA-cccccccc.js");
  });

  it("gives an orphan .map its own suffix", () => {
    const renames = planRenames([{ name: "lonely-AAAAAAAA.js.map", hash: "12345678" }]);
    expect(renames.get("lonely-AAAAAAAA.js.map")).toBe("lonely-AAAAAAAA-12345678.js.map");
  });

  it("never renames a file twice or a file without an extension", () => {
    const renames = planRenames([{ name: "README", hash: "12345678" }]);
    expect(renames.get("README")).toBe("README-12345678");
  });
});

describe("rewriteReferences", () => {
  const renames = new Map([
    ["index-BHbrFFmp.js", "index-BHbrFFmp-aaaaaaaa.js"],
    ["index-BHbrFFmp.js.map", "index-BHbrFFmp-aaaaaaaa.js.map"],
    ["CompanyExport-Z_xz3qVA.js", "CompanyExport-Z_xz3qVA-cccccccc.js"],
  ]);

  it("rewrites html, dynamic imports and source-map comments", () => {
    const html = '<script type="module" crossorigin src="/assets/index-BHbrFFmp.js"></script>';
    expect(rewriteReferences(html, renames).text).toBe('<script type="module" crossorigin src="/assets/index-BHbrFFmp-aaaaaaaa.js"></script>');
    const js = 'import("./CompanyExport-Z_xz3qVA.js");\n//# sourceMappingURL=index-BHbrFFmp.js.map';
    const out = rewriteReferences(js, renames);
    expect(out.text).toBe('import("./CompanyExport-Z_xz3qVA-cccccccc.js");\n//# sourceMappingURL=index-BHbrFFmp-aaaaaaaa.js.map');
    expect(out.count).toBe(2);
  });

  it("does not touch a longer name that merely contains an old name", () => {
    expect(rewriteReferences("xindex-BHbrFFmp.js", renames).text).toBe("xindex-BHbrFFmp.js");
    expect(rewriteReferences("index-BHbrFFmp.jsx", renames).text).toBe("index-BHbrFFmp.jsx");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @kyoube/rebrand test` → "Cannot find module '../lib/assets.mjs'".

- [ ] **Step 3: Write `docker/rebrand/lib/assets.mjs`**

```js
/**
 * `/assets` is served `maxAge: 1y, immutable`, so a rebranded chunk must not
 * keep the file name a browser cached from an unbranded install. Every asset
 * gets `-<8 hex>` before its extension; the hex is the content hash of the
 * *rebranded* file plus the brand kit's hash, computed before references are
 * rewritten, so one pass yields every name and the result is reproducible.
 */
import { createHash } from "node:crypto";

export function hashContent(content, salt) {
  return createHash("sha256").update(content).update(salt).digest("hex").slice(0, 8);
}

function withSuffix(name, hash) {
  const dot = name.indexOf(".");
  return dot === -1 ? `${name}-${hash}` : `${name.slice(0, dot)}-${hash}${name.slice(dot)}`;
}

export function planRenames(entries) {
  const renames = new Map();
  const maps = [];
  for (const entry of entries) {
    if (entry.name.endsWith(".map")) maps.push(entry);
    else renames.set(entry.name, withSuffix(entry.name, entry.hash));
  }
  for (const entry of maps) {
    const owner = renames.get(entry.name.slice(0, -".map".length));
    renames.set(entry.name, owner ? `${owner}.map` : withSuffix(entry.name, entry.hash));
  }
  return renames;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function rewriteReferences(text, renames) {
  if (renames.size === 0) return { text, count: 0 };
  const names = [...renames.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const re = new RegExp(`(?<![A-Za-z0-9_-])(?:${names.join("|")})(?![A-Za-z0-9_-])`, "g");
  let count = 0;
  const out = text.replace(re, (name) => { count += 1; return renames.get(name); });
  return { text: out, count };
}
```

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @kyoube/rebrand test` → green.

- [ ] **Step 5: Commit**

```bash
git add docker/rebrand
git commit -m "feat(rebrand): re-hash immutable asset names and rewrite their references"
```

---

### Task 5: File walking, orchestration, verify and report

**Files:**
- Create: `docker/rebrand/lib/files.mjs`, `docker/rebrand/rebrand.mjs`
- Test: `docker/rebrand/tests/rebrand.spec.mjs` (synthetic image tree)

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces:
  - `collectFiles(root): Promise<string[]>` — absolute paths of text files in the spec's file set (§B.1)
  - `isBinary(buffer): boolean`
  - `runRebrand({ root, brandDir, verify, report, log }): Promise<{ counts, renamed, residual, anchors }>` — throws `RebrandError` on a verify failure
  - CLI: `node rebrand.mjs --root <dir> --brand <dir> [--verify] [--report]`, exit 1 on any throw

- [ ] **Step 1: Write the failing test** — `docker/rebrand/tests/rebrand.spec.mjs`

```js
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectFiles, isBinary } from "../lib/files.mjs";
import { RebrandError, runRebrand } from "../rebrand.mjs";

const BRAND_JSON = {
  name: "KyoubeAI", shortName: "KyoubeAI", description: "AI OS", themeColor: "#18181b",
  urls: { home: "https://example.test/home", docs: "https://example.test/docs", feedback: "https://example.test/feedback", tos: "https://example.test/tos", repo: "https://example.test/repo" },
  phrases: { "[paperclip]": "[kyoubeai]" },
};
const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4v16M18 4l-11 8 11 8"/></svg>';
const LOCKUP = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 124 28" fill="currentColor"><path d="M6 4v16M18 4l-11 8 11 8" fill="none" stroke="currentColor" stroke-width="2"/><text x="30" y="21" font-family="Inter" font-weight="600" font-size="19">KyoubeAI</text></svg>';
const LOCKUP_JS = 'function DXn({decorative:e=!1,title:t="Paperclip",className:n,...r}){return(0,s.jsxs)("svg",{...r,className:n,viewBox:"22.5 22.5 121 27",fill:"currentColor",role:e?void 0:"img","aria-hidden":e?!0:void 0,"aria-label":e?void 0:t,focusable:"false",children:[(0,s.jsx)("path",{d:"M131.15 48.4902Z"})]})}';
const THINKING_JS = '(0,s.jsx)("path",{className:"paperclip-thinking-icon-path",d:"M16 6 l-8.414 8.586",fill:"none",stroke:"currentColor"})';
const INDEX_HTML = `<!DOCTYPE html><html><head><meta name="apple-mobile-web-app-title" content="Paperclip" /><title>Paperclip</title>
<!-- PAPERCLIP_RUNTIME_BRANDING_START -->
<!-- PAPERCLIP_RUNTIME_BRANDING_END -->
<script type="module" crossorigin src="/assets/index-BHbrFFmp.js"></script>
<link rel="modulepreload" crossorigin href="/assets/mention-chips-CbXq5njg.js">
<link rel="stylesheet" crossorigin href="/assets/index-BU41-p9M.css"></head><body><div id="root"></div></body></html>`;

async function makeTree(overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "kyoube-rebrand-root-"));
  const brandDir = await mkdtemp(path.join(tmpdir(), "kyoube-rebrand-brand-"));
  await writeFile(path.join(brandDir, "brand.json"), JSON.stringify(BRAND_JSON));
  await writeFile(path.join(brandDir, "mark.svg"), MARK);
  await writeFile(path.join(brandDir, "lockup.svg"), LOCKUP);
  await mkdir(path.join(brandDir, "icons"), { recursive: true });
  for (const name of ["favicon.ico", "favicon-16x16.png", "favicon-32x32.png", "apple-touch-icon.png", "android-chrome-192x192.png", "android-chrome-512x512.png"]) {
    await writeFile(path.join(brandDir, "icons", name), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  }
  const files = {
    "ui/dist/index.html": INDEX_HTML,
    "ui/dist/site.webmanifest": JSON.stringify({ name: "Paperclip", short_name: "Paperclip", description: "x", theme_color: "#000", background_color: "#000", icons: [] }),
    "ui/dist/favicon.svg": "<svg>old</svg>",
    "ui/dist/favicon.ico": "old",
    "ui/dist/favicon-16x16.png": "old",
    "ui/dist/favicon-32x32.png": "old",
    "ui/dist/apple-touch-icon.png": "old",
    "ui/dist/android-chrome-192x192.png": "old",
    "ui/dist/android-chrome-512x512.png": "old",
    "ui/dist/paperclip-thinking.svg": "<svg>old thinking</svg>",
    "ui/dist/assets/index-BHbrFFmp.js": `${LOCKUP_JS};${THINKING_JS};var a="Welcome to Paperclip",b=e?.metadata?.managedByPaperclip,c="X-Paperclip-Run-Id",d=import("./CompanyExport-Z_xz3qVA.js"),f="/paperclip-thinking.svg",g="https://paperclip.ing/feedback",h=n.startsWith("[paperclip]");\n//# sourceMappingURL=index-BHbrFFmp.js.map`,
    "ui/dist/assets/index-BHbrFFmp.js.map": '{"version":3,"file":"index-BHbrFFmp.js","sources":["Paperclip.tsx"]}',
    "ui/dist/assets/CompanyExport-Z_xz3qVA.js": 'export const x="Exported from [Paperclip](https://paperclip.ing)"',
    "ui/dist/assets/mention-chips-CbXq5njg.js": 'e.set("X-Paperclip-Route",1)',
    "ui/dist/assets/index-BU41-p9M.css": ".paperclip-markdown{color:red}",
    "server/dist/services/heartbeat.js": 'const s="Paperclip task context:";export function buildPaperclipWakePayload(){}',
    "server/dist/vendor/paperclip-runner/bin/paperclip-runnerd": String.fromCharCode(0) + "ELF Paperclip binary",
    "packages/shared/dist/labels.js": 'export const L={type:"paperclip_runner",label:"Paperclip Runner"}',
    "packages/shared/src/labels.ts": 'export const L="Paperclip source, not shipped"',
    "packages/skills-catalog/skills/x/SKILL.md": "# Paperclip catalog skill",
    "skills/paperclip/SKILL.md": "---\nname: paperclip\n---\n# Paperclip Skill\nTriggered by Paperclip.",
    "skills-releases/paperclip/1.0.0/SKILL.md": "Paperclip release",
    "cli/dist/index.js": 'console.log("Paperclip CLI")',
    "doc/plans/x.md": "Paperclip plan",
    "README.md": "# Paperclip",
    "node_modules/@paperclipai/shared/dist/x.js": '"Paperclip inside node_modules"',
    ...overrides,
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return { root, brandDir };
}

const read = (root, rel) => readFile(path.join(root, rel), "utf8");

describe("collectFiles / isBinary", () => {
  it("walks the spec's file set and nothing else", async () => {
    const { root } = await makeTree();
    const rels = (await collectFiles(root)).map((f) => path.relative(root, f).replace(/\\/g, "/")).sort();
    expect(rels).toContain("ui/dist/index.html");
    expect(rels).toContain("ui/dist/assets/index-BHbrFFmp.js");
    expect(rels).toContain("ui/dist/assets/index-BHbrFFmp.js.map");
    expect(rels).toContain("server/dist/services/heartbeat.js");
    expect(rels).toContain("packages/shared/dist/labels.js");
    expect(rels).toContain("packages/skills-catalog/skills/x/SKILL.md");
    expect(rels).toContain("skills/paperclip/SKILL.md");
    expect(rels).toContain("skills-releases/paperclip/1.0.0/SKILL.md");
    expect(rels).toContain("cli/dist/index.js");
    expect(rels).toContain("doc/plans/x.md");
    expect(rels).toContain("README.md");
    expect(rels).not.toContain("packages/shared/src/labels.ts");
    expect(rels).not.toContain("server/dist/vendor/paperclip-runner/bin/paperclip-runnerd");
    expect(rels).not.toContain("node_modules/@paperclipai/shared/dist/x.js");
    expect(rels).not.toContain("ui/dist/favicon.ico");
  });

  it("sniffs a NUL byte as binary", () => {
    expect(isBinary(Buffer.from("plain text"))).toBe(false);
    expect(isBinary(Buffer.from(String.fromCharCode(0) + "ELF"))).toBe(true);
  });
});

describe("runRebrand", () => {
  it("rebrands text, artwork, the bundle SVGs and the asset names, and verifies clean", async () => {
    const { root, brandDir } = await makeTree();
    const result = await runRebrand({ root, brandDir, verify: true, report: false, log: () => {} });

    // Text rules across the file set.
    const assets = await readdir(path.join(root, "ui/dist/assets"));
    const main = assets.find((n) => /^index-BHbrFFmp-[0-9a-f]{8}\.js$/.test(n));
    expect(main).toBeDefined();
    const js = await read(root, `ui/dist/assets/${main}`);
    expect(js).toContain('"Welcome to KyoubeAI"');
    expect(js).toContain("managedByPaperclip");
    expect(js).toContain('"X-Paperclip-Run-Id"');
    expect(js).toContain('"https://example.test/feedback"');
    expect(js).toContain('"[kyoubeai]"');
    expect(js).toContain('"/kyoubeai-thinking.svg"');
    expect(js).toContain('viewBox:"0 0 124 28"');
    expect(js).toContain('children:"KyoubeAI"');
    expect(js).toContain('pathLength:"85.717"');
    expect(await read(root, "server/dist/services/heartbeat.js")).toBe('const s="KyoubeAI task context:";export function buildPaperclipWakePayload(){}');
    expect(await read(root, "packages/shared/dist/labels.js")).toContain('label:"KyoubeAI Runner"');
    expect(await read(root, "packages/shared/dist/labels.js")).toContain('type:"paperclip_runner"');
    expect(await read(root, "skills/paperclip/SKILL.md")).toBe("---\nname: paperclip\n---\n# KyoubeAI Skill\nTriggered by KyoubeAI.");
    expect(await read(root, "packages/shared/src/labels.ts")).toContain("Paperclip source");
    expect(await read(root, "node_modules/@paperclipai/shared/dist/x.js")).toContain("Paperclip inside");
    expect(await read(root, "server/dist/vendor/paperclip-runner/bin/paperclip-runnerd")).toContain("Paperclip binary");

    // Artwork.
    expect(await read(root, "ui/dist/favicon.svg")).toContain('d="M6 4v16M18 4l-11 8 11 8"');
    expect(await read(root, "ui/dist/kyoubeai-thinking.svg")).toContain("@keyframes draw");
    await expect(readFile(path.join(root, "ui/dist/paperclip-thinking.svg"))).rejects.toThrow();
    expect((await readFile(path.join(root, "ui/dist/favicon.ico")))[0]).toBe(0x89);
    expect(JSON.parse(await read(root, "ui/dist/site.webmanifest"))).toMatchObject({ name: "KyoubeAI", short_name: "KyoubeAI" });

    // index.html: title, app title, references.
    const html = await read(root, "ui/dist/index.html");
    expect(html).toContain("<title>KyoubeAI</title>");
    expect(html).toContain('content="KyoubeAI"');
    expect(html).toContain(`src="/assets/${main}"`);
    expect(html).not.toContain("index-BHbrFFmp.js\"");
    // Chunks and maps follow.
    const mapName = `${main}.map`;
    expect(assets).toContain(mapName);
    expect(js).toContain(`//# sourceMappingURL=${mapName}`);
    const exportChunk = assets.find((n) => /^CompanyExport-Z_xz3qVA-[0-9a-f]{8}\.js$/.test(n));
    expect(js).toContain(`import("./${exportChunk}")`);
    expect(assets.some((n) => /^index-BU41-p9M-[0-9a-f]{8}\.css$/.test(n))).toBe(true);
    expect(assets).not.toContain("index-BHbrFFmp.js");

    expect(result.anchors).toEqual({ lockup: 1, thinking: 1 });
    expect(result.residual).toEqual([]);
    expect(result.counts.name).toBeGreaterThan(5);
  });

  it("is deterministic: the same inputs give the same asset names", async () => {
    const a = await makeTree();
    const b = await makeTree();
    await runRebrand({ root: a.root, brandDir: a.brandDir, verify: true, report: false, log: () => {} });
    await runRebrand({ root: b.root, brandDir: b.brandDir, verify: true, report: false, log: () => {} });
    expect((await readdir(path.join(a.root, "ui/dist/assets"))).sort()).toEqual((await readdir(path.join(b.root, "ui/dist/assets"))).sort());
  });

  it("fails verification when the lockup anchor is missing", async () => {
    const { root, brandDir } = await makeTree({ "ui/dist/assets/index-BHbrFFmp.js": `${THINKING_JS};var a="Paperclip";\n//# sourceMappingURL=index-BHbrFFmp.js.map` });
    await expect(runRebrand({ root, brandDir, verify: true, report: false, log: () => {} })).rejects.toThrow(RebrandError);
    await expect(runRebrand({ root, brandDir, verify: true, report: false, log: () => {} })).rejects.toThrow(/lockup anchor matched 0 times/);
  });

  it("fails verification when the loading-icon anchor appears twice", async () => {
    const { root, brandDir } = await makeTree({ "ui/dist/assets/index-BHbrFFmp.js": `${LOCKUP_JS};${THINKING_JS};${THINKING_JS};\n//# sourceMappingURL=index-BHbrFFmp.js.map` });
    await expect(runRebrand({ root, brandDir, verify: true, report: false, log: () => {} })).rejects.toThrow(/loading-icon anchor matched 2 times/);
  });

  it("fails verification when a reference points at a missing asset", async () => {
    const { root, brandDir } = await makeTree({ "ui/dist/index.html": INDEX_HTML.replace("index-BU41-p9M.css", "gone-XXXXXXXX.css") });
    await expect(runRebrand({ root, brandDir, verify: true, report: false, log: () => {} })).rejects.toThrow(/gone-XXXXXXXX\.css/);
  });

  it("fails verification when index.html lost its marker block or title", async () => {
    const { root, brandDir } = await makeTree({ "ui/dist/index.html": INDEX_HTML.replace("<title>Paperclip</title>", "") });
    await expect(runRebrand({ root, brandDir, verify: true, report: false, log: () => {} })).rejects.toThrow(/<title>KyoubeAI<\/title>/);
  });

  it("without --verify still rewrites and returns the residual list instead of throwing", async () => {
    const { root, brandDir } = await makeTree({ "ui/dist/assets/index-BHbrFFmp.js": `${THINKING_JS};\n//# sourceMappingURL=index-BHbrFFmp.js.map` });
    const result = await runRebrand({ root, brandDir, verify: false, report: false, log: () => {} });
    expect(result.anchors.lockup).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @kyoube/rebrand test` → module-not-found for `../lib/files.mjs` and `../rebrand.mjs`.

- [ ] **Step 3: Write `docker/rebrand/lib/files.mjs`**

```js
/**
 * The file set the transform touches (spec §B.1): served UI, server and package
 * dist output, the skills agents read, the CLI, shipped docs. Text files only;
 * `node_modules` and anything under a `bin` directory are never entered.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

const TEXT = [".js", ".mjs", ".cjs", ".css", ".html", ".webmanifest", ".json", ".svg", ".map", ".txt", ".md", ".yaml", ".yml"];
const SKIP_DIRS = new Set(["node_modules", "bin", ".git"]);

/** [relative root, extension allowlist, filter on the path relative to that root] */
const ROOTS = [
  ["ui/dist", TEXT, () => true],
  ["server/dist", [".js", ".mjs", ".cjs", ".json", ".md"], () => true],
  ["packages", [".js", ".mjs", ".cjs", ".json", ".md", ".yaml", ".yml"], (rel) => /(^|\/)dist\//.test(rel) || /^(skills-catalog|teams-catalog)\//.test(rel)],
  ["skills", [".md", ".json", ".yaml", ".yml"], () => true],
  ["skills-releases", [".md", ".json", ".yaml", ".yml"], () => true],
  [".agents", [".md", ".json", ".yaml", ".yml"], () => true],
  ["cli/dist", [".js", ".mjs", ".cjs"], () => true],
  ["doc", [".md"], () => true],
  ["docs", [".md"], () => true],
];

async function walk(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(abs, out);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
}

export async function collectFiles(root) {
  const files = [];
  for (const [rel, extensions, filter] of ROOTS) {
    const base = path.join(root, rel);
    const found = [];
    await walk(base, found);
    for (const abs of found) {
      const relToRoot = path.relative(base, abs).replace(/\\/g, "/");
      if (extensions.includes(path.extname(abs)) && filter(relToRoot)) files.push(abs);
    }
  }
  // Top-level markdown (README.md, SECURITY.md, …).
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(path.join(root, entry.name));
  }
  return files;
}

export function isBinary(buffer) {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i += 1) if (buffer[i] === 0) return true;
  return false;
}
```

- [ ] **Step 4: Write `docker/rebrand/rebrand.mjs`**

```js
#!/usr/bin/env node
/**
 * KyoubeAI build-time brand transform. Runs inside docker/Dockerfile on the
 * pristine upstream layer (never on its own output), so a core bump is
 * re-branded by construction and drift fails the build:
 *
 *   node rebrand.mjs --root /app --brand /opt/kyoube/brand --verify --report
 *
 * Steps: text rules over the spec's file set → static artwork → the two SVGs
 * inside the main bundle → re-hash /assets and rewrite references → verify.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashContent, planRenames, rewriteReferences } from "./lib/assets.mjs";
import { collectFiles, isBinary } from "./lib/files.mjs";
import { markPathFrom, parseSvgElements, renderFaviconSvg, renderManifest, renderThinkingSvg, replaceLockup, replaceThinkingIcon } from "./lib/svg.mjs";
import { buildTextRules, findResidual, rewriteText } from "./lib/text-rules.mjs";

export class RebrandError extends Error {}

const ICON_FILES = ["favicon.ico", "favicon-16x16.png", "favicon-32x32.png", "apple-touch-icon.png", "android-chrome-192x192.png", "android-chrome-512x512.png"];
const WORKTREE_ICON_FILES = ["worktree-favicon.ico", "worktree-favicon-16x16.png", "worktree-favicon-32x32.png"];
const OLD_THINKING = "paperclip-thinking.svg";

async function loadKit(brandDir) {
  const brand = JSON.parse(await readFile(path.join(brandDir, "brand.json"), "utf8"));
  const markSvg = await readFile(path.join(brandDir, "mark.svg"), "utf8");
  const lockupSvg = await readFile(path.join(brandDir, "lockup.svg"), "utf8");
  const icons = {};
  for (const name of ICON_FILES) icons[name] = await readFile(path.join(brandDir, "icons", name));
  const hash = createHash("sha256").update(JSON.stringify(brand)).update(markSvg).update(lockupSvg);
  for (const name of ICON_FILES) hash.update(icons[name]);
  const thinkingName = `${brand.name.toLowerCase()}-thinking.svg`;
  return { brand, markD: markPathFrom(markSvg), lockup: parseSvgElements(lockupSvg), icons, thinkingName, hash: hash.digest("hex") };
}

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

export async function runRebrand({ root, brandDir, verify = true, report = false, log = console.log }) {
  const kit = await loadKit(brandDir);
  const uiDist = path.join(root, "ui", "dist");
  const assetsDir = path.join(uiDist, "assets");
  const rules = buildTextRules(kit.brand);
  // The thinking icon is referenced from the bundle by URL; renaming the file
  // means rewriting that one reference too.
  rules.unshift({ kind: "phrase", from: new RegExp(`/${OLD_THINKING.replace(".", "\\.")}`, "g"), to: `/${kit.thinkingName}` });

  const counts = {};
  const anchors = { lockup: 0, thinking: 0 };
  const residual = [];
  const skippedBinary = [];
  let filesTouched = 0;

  // 1. Text rules (+ the bundle SVG surgery on every asset JS; anchors are counted across all files).
  for (const file of await collectFiles(root)) {
    const raw = await readFile(file);
    if (isBinary(raw)) { skippedBinary.push(path.relative(root, file)); continue; }
    let text = raw.toString("utf8");
    const before = text;
    if (file.startsWith(assetsDir) && file.endsWith(".js")) {
      const lockup = replaceLockup(text, kit.lockup);
      anchors.lockup += lockup.matches;
      const thinking = replaceThinkingIcon(lockup.text, kit.markD);
      anchors.thinking += thinking.matches;
      text = thinking.text;
    }
    const rewritten = rewriteText(text, rules);
    text = rewritten.text;
    for (const [kind, n] of Object.entries(rewritten.counts)) counts[kind] = (counts[kind] ?? 0) + n;
    if (text !== before) { await writeFile(file, text); filesTouched += 1; }
    for (const context of findResidual(text, 3)) residual.push(`${path.relative(root, file)}: ${context}`);
  }

  // 2. Static artwork.
  for (const name of ICON_FILES) await writeFile(path.join(uiDist, name), kit.icons[name]);
  for (const name of WORKTREE_ICON_FILES) {
    if (await exists(path.join(uiDist, name))) await writeFile(path.join(uiDist, name), kit.icons[name.replace("worktree-", "")]);
  }
  await writeFile(path.join(uiDist, "favicon.svg"), renderFaviconSvg(kit.markD));
  if (await exists(path.join(uiDist, "worktree-favicon.svg"))) await writeFile(path.join(uiDist, "worktree-favicon.svg"), renderFaviconSvg(kit.markD));
  await writeFile(path.join(uiDist, kit.thinkingName), renderThinkingSvg(kit.markD));
  await rm(path.join(uiDist, OLD_THINKING), { force: true });
  const manifestPath = path.join(uiDist, "site.webmanifest");
  if (await exists(manifestPath)) await writeFile(manifestPath, renderManifest(await readFile(manifestPath, "utf8"), kit.brand));

  // 3. Re-hash asset names, then rewrite every reference under ui/dist.
  const assetNames = (await readdir(assetsDir)).sort();
  const entries = [];
  for (const name of assetNames) entries.push({ name, hash: hashContent(await readFile(path.join(assetsDir, name)), kit.hash) });
  const renames = planRenames(entries);
  for (const [from, to] of renames) await rename(path.join(assetsDir, from), path.join(assetsDir, to));
  let references = 0;
  for (const file of await collectFiles(root)) {
    if (!file.startsWith(uiDist)) continue;
    const raw = await readFile(file);
    if (isBinary(raw)) continue;
    const { text, count } = rewriteReferences(raw.toString("utf8"), renames);
    if (count > 0) { await writeFile(file, text); references += count; }
  }

  // 4. Verify.
  const problems = [];
  if (anchors.lockup !== 1) problems.push(`lockup anchor matched ${anchors.lockup} times (expected 1) — upstream moved or changed PaperclipLockup`);
  if (anchors.thinking !== 1) problems.push(`loading-icon anchor matched ${anchors.thinking} times (expected 1) — upstream changed AnimatedPaperclipIcon`);
  if (residual.length > 0) problems.push(`the name rule still matches after rewriting:\n  ${residual.slice(0, 20).join("\n  ")}`);
  const indexHtml = await readFile(path.join(uiDist, "index.html"), "utf8");
  if (!indexHtml.includes(`<title>${kit.brand.name}</title>`)) problems.push(`index.html does not carry <title>${kit.brand.name}</title>`);
  if (!indexHtml.includes("PAPERCLIP_RUNTIME_BRANDING_START")) problems.push("index.html lost the upstream runtime-branding marker block");
  const renamedSet = new Set(renames.values());
  const refRe = /(?:\/assets\/|\.\/)([A-Za-z0-9_-]+\.(?:js|css|map))/g;
  for (const file of await collectFiles(root)) {
    if (!file.startsWith(uiDist)) continue;
    const text = (await readFile(file)).toString("utf8");
    for (const match of text.matchAll(refRe)) {
      if (!renamedSet.has(match[1]) && !(await exists(path.join(assetsDir, match[1])))) problems.push(`${path.relative(root, file)} references missing asset ${match[1]}`);
    }
  }
  if (verify && problems.length > 0) throw new RebrandError(`rebrand verification failed:\n- ${problems.join("\n- ")}`);

  const result = { counts, renamed: renames.size, references, filesTouched, residual, anchors, skippedBinary, problems };
  if (report) {
    log(`rebrand: ${filesTouched} files rewritten (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}), ${renames.size} assets renamed, ${references} references rewritten`);
    log(`rebrand: anchors lockup=${anchors.lockup} thinking=${anchors.thinking}; residual ${residual.length}; binaries skipped ${skippedBinary.length}`);
    for (const problem of problems) log(`rebrand: WARNING ${problem}`);
  }
  return result;
}

function parseArgs(argv) {
  const opts = { verify: false, report: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") opts.root = argv[++i];
    else if (arg === "--brand") opts.brandDir = argv[++i];
    else if (arg === "--verify") opts.verify = true;
    else if (arg === "--report") opts.report = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!opts.root || !opts.brandDir) throw new Error("usage: rebrand.mjs --root <dir> --brand <dir> [--verify] [--report]");
  return opts;
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    await runRebrand(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
```

- [ ] **Step 5: Run to verify pass** — `pnpm --filter @kyoube/rebrand test` → all green (the synthetic-tree suite plus the earlier three). Also `pnpm test` from the root still passes for the other packages.

- [ ] **Step 6: Dry run against the real image layer** — extract upstream's `/app` into the scratchpad and run the transform on it once, before touching the Dockerfile:

```bash
CID=$(docker create ghcr.io/paperclipai/paperclip:2026.831.1)
mkdir -p "$SCRATCH/upstream-app" && docker cp "$CID:/app/ui" "$SCRATCH/upstream-app/ui" && docker cp "$CID:/app/server/dist" "$SCRATCH/upstream-app/server-dist" && docker rm "$CID"
mkdir -p "$SCRATCH/upstream-app/server" && mv "$SCRATCH/upstream-app/server-dist" "$SCRATCH/upstream-app/server/dist"
node docker/rebrand/rebrand.mjs --root "$SCRATCH/upstream-app" --brand docker/brand --verify --report
```
Expected: exit 0; the report shows `anchors lockup=1 thinking=1`, `residual 0`, roughly 900+ files rewritten and 221 assets renamed. Then `grep -c "Paperclip" $SCRATCH/upstream-app/ui/dist/assets/index-*.js` must print numbers only for identifier forms: check with `grep -oE ".{20}Paperclip.{20}" … | sort -u` that every remaining context is `managedByPaperclip`, `minimumPaperclipVersion`, `X-Paperclip-…` or a camelCase identifier. Record the residual lowercase report in the task's notes for Task 16.

- [ ] **Step 7: Commit**

```bash
git add docker/rebrand
git commit -m "feat(rebrand): orchestrate the transform with build-time verification"
```

---

### Task 6: Dockerfile stage, live brand check and smoke assertions

**Files:**
- Modify: `docker/Dockerfile` (rebrand stage before the Kyoube bootstrap COPY block)
- Modify: `scripts/lib/headless-chrome.mjs` (`dumpDom` accepts a URL and `network: true`)
- Create: `scripts/brand-live-check.mjs`
- Modify: `scripts/smoke.sh` (brand assertions right after "wait for health"), `.github/workflows/ci.yml` (nothing new: smoke already runs there)

**Interfaces:**
- Consumes: `docker/rebrand/rebrand.mjs` CLI, `docker/brand/*`.
- Produces: an image whose served UI is branded; `node scripts/brand-live-check.mjs <baseUrl>` exit 0/1/SKIPPED.

- [ ] **Step 1: Add the rebrand stage to `docker/Dockerfile`** — insert immediately before the comment `# Kyoube bootstrap CLI and plugin bundles.` (after the Hermes layer, so kit edits never invalidate the expensive tool layers):

```dockerfile
# ---------------------------------------------------------------------------
# KyoubeAI branding. The upstream layer above says "Paperclip" in its UI
# bundle, server messages, agent skills and artwork; docker/rebrand/rebrand.mjs
# rewrites those surfaces in place (spec: docs/superpowers/specs/2026-09-13-
# white-label-design.md §B) and --verify fails this build if anything upstream
# changed shape: a moved lockup, a new display string the rule cannot classify,
# a dangling asset reference. It runs as `node` because /app is node-owned and
# nothing here should change ownership. --report leaves the counts in the log.
# ---------------------------------------------------------------------------
COPY docker/brand /opt/kyoube/brand
COPY docker/rebrand/rebrand.mjs /opt/kyoube/rebrand/rebrand.mjs
COPY docker/rebrand/lib /opt/kyoube/rebrand/lib
RUN gosu node node /opt/kyoube/rebrand/rebrand.mjs --root /app --brand /opt/kyoube/brand --verify --report \
 && grep -q '<title>KyoubeAI</title>' /app/ui/dist/index.html \
 && test -f /app/ui/dist/kyoubeai-thinking.svg \
 && ! test -e /app/ui/dist/paperclip-thinking.svg \
 && ! ls /app/ui/dist/assets | grep -qE '^index-[A-Za-z0-9_-]{8}\.js$'
```

Note `.dockerignore` excludes `*.md`, `docs`, `scripts` and `**/dist`; none of the copied paths hit those rules (`docker/rebrand/tests` is simply not copied).

- [ ] **Step 2: Build once and read the report**

Run: `docker build -f docker/Dockerfile -t kyoubeai:rebrand-check . 2>&1 | tee "$SCRATCH/build.log"; grep -E "^rebrand:|WARNING" "$SCRATCH/build.log"`
Expected: the build passes; the two `rebrand:` lines show `lockup=1 thinking=1`, `residual 0`. (Warm cache: only the layers from the rebrand stage down rebuild, a few minutes.)

- [ ] **Step 3: Teach `dumpDom` about URLs and network** — in `scripts/lib/headless-chrome.mjs` replace the `dumpDom` signature and the two lines that build the target/resolver flags:

```js
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
```
(The rest of the function is unchanged. Update the doc comment: "`target` is a file path or an `http(s)://` URL; `network: true` drops the resolver rule".) Run `node scripts/browser-check.mjs`, `node scripts/terminal-fit-check.mjs`, `node scripts/app-frame-check.mjs` afterwards — all still pass (they call with a file path and the default).

- [ ] **Step 4: Write `scripts/brand-live-check.mjs`**

```js
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
 * Exit 0 on pass or when no Chrome is installed (prints SKIPPED), 1 on failure.
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
    return 0;
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
```

- [ ] **Step 5: Smoke assertions** — in `scripts/smoke.sh`, right after the `curl … deploymentMode == "authenticated"` line of "==> wait for health", add:

```bash
echo "==> the served UI is branded"
# The rebrand ran at image build (docker/rebrand); this proves the server serves
# its output: title, PWA manifest, the renamed loading icon, and no stale name.
curl -fsS "$BASE_URL/" >"$TMP/index.html"
grep -q '<title>KyoubeAI</title>' "$TMP/index.html" || { echo "index.html title is not KyoubeAI:" >&2; grep -o '<title>[^<]*</title>' "$TMP/index.html" >&2; exit 1; }
curl -fsS "$BASE_URL/site.webmanifest" | jq -e '.name == "KyoubeAI" and .short_name == "KyoubeAI"' >/dev/null \
  || { echo "site.webmanifest is not branded" >&2; exit 1; }
[[ "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/kyoubeai-thinking.svg")" == "200" ]] || { echo "/kyoubeai-thinking.svg is not served" >&2; exit 1; }
[[ "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/paperclip-thinking.svg")" == "404" ]] || { echo "/paperclip-thinking.svg is still served" >&2; exit 1; }
MAIN_JS="$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' "$TMP/index.html" | head -1)"
[[ "$MAIN_JS" =~ -[0-9a-f]{8}\.js$ ]] || { echo "the main bundle was not re-hashed: $MAIN_JS" >&2; exit 1; }
curl -fsS "$BASE_URL$MAIN_JS" >"$TMP/main.js"
grep -q 'Welcome to KyoubeAI' "$TMP/main.js" || { echo "the main bundle does not say 'Welcome to KyoubeAI'" >&2; exit 1; }
! grep -qE '(^|[^A-Za-z0-9_$-])Paperclip([^A-Za-z0-9_$]|$)' "$TMP/main.js" \
  || { echo "the main bundle still contains a display-text Paperclip:" >&2; grep -oE '.{30}([^A-Za-z0-9_$-])Paperclip([^A-Za-z0-9_$]).{30}' "$TMP/main.js" | head -5 >&2; exit 1; }
node "$ROOT/scripts/brand-live-check.mjs" "$BASE_URL"
echo "    title, manifest, loading icon, bundle text and the sign-in page are branded"
```

- [ ] **Step 6: Run the smoke** — `KEEP=1 bash scripts/smoke.sh` (detached with `nohup … &` and the log watched, as `docs/operations.md` describes; ~7 min warm). Expected: the new phase passes; the rest is unchanged. If `brand-live-check` fails on the heading only, open `http://localhost:3199/auth` in a browser and confirm the route; adjust the regex, never the check's intent.

- [ ] **Step 7: Commit**

```bash
git add docker/Dockerfile scripts/lib/headless-chrome.mjs scripts/brand-live-check.mjs scripts/smoke.sh
git commit -m "feat(docker): brand the upstream layer at build time and prove it in the smoke"
```

---

## Phase B — Home relocation and database rename

### Task 7: Config paths, Terminal hints and the doctor's legacy checks

**Files:**
- Modify: `docker/bootstrap/src/config.ts:15,36`, `docker/bootstrap/src/cli.ts:46`, `docker/bootstrap/src/commands/write-config.ts:4`, `docker/bootstrap/src/commands/doctor.ts`
- Modify: `plugins/kyoube-terminal/src/kyoube-config.ts:3`, `plugins/kyoube-apps/src/kyoube-config.ts:3`, `plugins/kyoube-terminal/src/ui/TerminalPage.tsx:25,27`
- Test: `docker/bootstrap/tests/config.spec.ts`, `docker/bootstrap/tests/setup.spec.ts`, `docker/bootstrap/tests/doctor.spec.ts`, `plugins/kyoube-terminal/tests/{spawn-env,kyoube-config,plugin}.spec.ts`, `plugins/kyoube-apps/tests/unit/plugin.spec.ts`

**Interfaces:**
- Produces: `DEFAULT_CONFIG_PATH = "/kyoubeai/kyoube/config.json"` (bootstrap) and `DEFAULT_KYOUBE_CONFIG_PATH` (both plugins, same value); `renderConfigFromEnv` defaults `home` to `/kyoubeai`; doctor exports `LEGACY_ENV_KEYS: Record<string,string>`, `legacyEnvCheck(env): Check`, `legacyHomeLinkCheck(home, exists?): Promise<Check>`; the marker file name constant `MIGRATION_MARKER = ".migrated-from-paperclip-home"`.
- Note: the config file's `paperclipApiUrl` field name is the version-1 file format shared with both plugin workers; it is **not** renamed.

- [ ] **Step 1: Update the bootstrap tests first**

`docker/bootstrap/tests/config.spec.ts`: in "builds a config from the required and defaulted variables" change `home: "/paperclip"` → `home: "/kyoubeai"` and `hermesHome: "/paperclip/.hermes"` → `hermesHome: "/kyoubeai/.hermes"`.

`docker/bootstrap/tests/setup.spec.ts`: lines 11–12 → `home: "/kyoubeai"`, `hermesHome: "/kyoubeai/.hermes"`; line 108 → `expect(h.written[0]?.filePath).toBe("/kyoubeai/kyoube/board-key.json");`.

Append to `docker/bootstrap/tests/doctor.spec.ts`:

```ts
import { LEGACY_ENV_KEYS, legacyEnvCheck, legacyHomeLinkCheck } from "../src/commands/doctor.js";

describe("legacyEnvCheck", () => {
  it("reports none when compose passed no legacy keys", () => {
    expect(legacyEnvCheck({})).toEqual({ name: "legacy env", ok: true, detail: "none" });
    expect(legacyEnvCheck({ KYOUBE_LEGACY_ENV_KEYS: "  " }).detail).toBe("none");
  });

  it("names each legacy key and its replacement", () => {
    const check = legacyEnvCheck({ KYOUBE_LEGACY_ENV_KEYS: "PAPERCLIP_PUBLIC_URL PAPERCLIP_VERSION" });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("PAPERCLIP_PUBLIC_URL -> KYOUBE_PUBLIC_URL");
    expect(check.detail).toContain("PAPERCLIP_VERSION -> KYOUBE_CORE_VERSION");
    expect(check.detail).toContain("migrate-from-0.1.sh");
  });

  it("maps the three keys the compose file still accepts", () => {
    expect(LEGACY_ENV_KEYS).toEqual({
      PAPERCLIP_PUBLIC_URL: "KYOUBE_PUBLIC_URL",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "KYOUBE_DEPLOYMENT_EXPOSURE",
      PAPERCLIP_VERSION: "KYOUBE_CORE_VERSION",
    });
  });
});

describe("legacyHomeLinkCheck", () => {
  it("is quiet without the migration marker", async () => {
    expect(await legacyHomeLinkCheck("/kyoubeai", async () => false)).toEqual({ name: "legacy home link", ok: true, detail: "none" });
  });

  it("explains the compatibility link while the marker exists", async () => {
    const seen: string[] = [];
    const check = await legacyHomeLinkCheck("/kyoubeai", async (file) => { seen.push(file); return true; });
    expect(seen).toEqual(["/kyoubeai/.migrated-from-paperclip-home"]);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("/paperclip -> /kyoubeai");
    expect(check.detail).toContain("--check");
  });
});
```

Run: `pnpm --filter @kyoube/bootstrap test` — Expected: config/setup specs fail on `/kyoubeai`, doctor spec fails on the missing exports.

- [ ] **Step 2: Bootstrap source**

`docker/bootstrap/src/config.ts`: `export const DEFAULT_CONFIG_PATH = "/kyoubeai/kyoube/config.json";` and `const home = nonEmpty(env.PAPERCLIP_HOME) ?? "/kyoubeai";`.

`docker/bootstrap/src/cli.ts` USAGE line: `write-config          (internal) Render /kyoubeai/kyoube/config.json from the environment`.

`docker/bootstrap/src/commands/write-config.ts:4`: `/** Renders /kyoubeai/kyoube/config.json from the container environment. Runs as the \`node\` user from the entrypoint. */`

`docker/bootstrap/src/commands/doctor.ts` — add after `exposureWarning`:

```ts
/** Marker `scripts/migrate-from-0.1.sh` leaves in the home volume; while it exists the entrypoint keeps `/paperclip` resolvable. */
export const MIGRATION_MARKER = ".migrated-from-paperclip-home";

/** The `.env` keys this release still accepts through compose fallbacks, and what replaces them. */
export const LEGACY_ENV_KEYS: Record<string, string> = {
  PAPERCLIP_PUBLIC_URL: "KYOUBE_PUBLIC_URL",
  PAPERCLIP_DEPLOYMENT_EXPOSURE: "KYOUBE_DEPLOYMENT_EXPOSURE",
  PAPERCLIP_VERSION: "KYOUBE_CORE_VERSION",
};

/**
 * Compose cannot tell the container which `.env` key supplied a value, so it
 * passes the names of the legacy keys that were set (`KYOUBE_LEGACY_ENV_KEYS`,
 * built with `${VAR:+VAR }` substitutions in docker-compose.yml). Informational:
 * the values still work this release.
 */
export function legacyEnvCheck(env: NodeJS.ProcessEnv): Check {
  const keys = (env.KYOUBE_LEGACY_ENV_KEYS ?? "").split(/\s+/).filter(Boolean);
  if (keys.length === 0) return { name: "legacy env", ok: true, detail: "none" };
  const renames = keys.map((key) => `${key} -> ${LEGACY_ENV_KEYS[key] ?? "?"}`).join(", ");
  return { name: "legacy env", ok: true, detail: `${renames} (still honoured; bash scripts/migrate-from-0.1.sh renames them in .env; the old names go away next release)` };
}

export async function legacyHomeLinkCheck(home: string, exists: (file: string) => Promise<boolean> = fileExists): Promise<Check> {
  const marker = path.posix.join(home, MIGRATION_MARKER);
  if (!(await exists(marker))) return { name: "legacy home link", ok: true, detail: "none" };
  return {
    name: "legacy home link",
    ok: true,
    detail: `/paperclip -> ${home} compatibility link active (${marker} exists); run 'bash scripts/migrate-from-0.1.sh --check' and delete the marker when it reports 0 legacy paths`,
  };
}
```

In `runDoctor`: rename the health check's name from `"paperclip"` to `"core"` (both `checks.push` calls); after the `exposure` push add `checks.push(legacyEnvCheck(env));`; after the credential hints loop add `checks.push(await legacyHomeLinkCheck(config.home));`. Change `exposureWarning`'s message to `` `KYOUBE_DEPLOYMENT_EXPOSURE=public but KYOUBE_PUBLIC_URL is ${publicUrl}; put TLS in front and use an https URL` `` and its doc comment to name the `KYOUBE_*` keys (the function still reads `env.PAPERCLIP_DEPLOYMENT_EXPOSURE`, which is what compose sets inside the container). Update `docker/bootstrap/tests/doctor.spec.ts`'s existing test name "names the offending PAPERCLIP_PUBLIC_URL value" to "names the offending public URL value" (its assertion is unchanged). Replace `"— run kyoube setup"` and other messages only if they name Paperclip (none do).

- [ ] **Step 3: Plugins**

Both `plugins/*/src/kyoube-config.ts`: `export const DEFAULT_KYOUBE_CONFIG_PATH = "/kyoubeai/kyoube/config.json";`

`plugins/kyoube-terminal/src/ui/TerminalPage.tsx` HELP rows:
```ts
  ["claude login", "Claude Code OAuth login; credentials are stored under /kyoubeai/.claude"],
  ["pi", "pi coding agent; run `pi` and use /login or set provider keys in ~/.pi"],
  ["hermes setup", "Hermes Agent wizard (provider, model); data under /kyoubeai/.hermes"],
```

Test fixtures: in `plugins/kyoube-terminal/tests/spawn-env.spec.ts`, `plugins/kyoube-terminal/tests/kyoube-config.spec.ts`, `plugins/kyoube-terminal/tests/plugin.spec.ts`, `plugins/kyoube-apps/tests/unit/plugin.spec.ts` replace every `/paperclip` with `/kyoubeai` (they are fixture values; `sed -i 's#/paperclip#/kyoubeai#g' <files>` is exact — the only `/paperclip` strings in those files are paths). `plugins/kyoube-terminal/src/spawn-env.ts:15` comment "under the persisted Paperclip home" → "under the persisted KyoubeAI home".

- [ ] **Step 4: Run everything**

Run: `pnpm typecheck && pnpm test`
Expected: green across bootstrap (the new doctor tests included), both plugins, rebrand.

- [ ] **Step 5: Commit**

```bash
git add docker/bootstrap plugins
git commit -m "feat: move the container home to /kyoubeai and teach doctor about legacy installs"
```

---

### Task 8: Image, entrypoint, compose, Postgres init and env files

**Files:**
- Modify: `docker/Dockerfile`, `docker/entrypoint.sh`, `docker/kyoube`, `docker-compose.yml`, `docker/postgres-init/01-kyoube.sh`, `.env.example`, `scripts/smoke.env`, `scripts/smoke.sh`

**Interfaces:**
- Produces: container env `HOME=PAPERCLIP_HOME=/kyoubeai`, `PAPERCLIP_CONFIG=/kyoubeai/instances/default/config.json`, `HERMES_HOME=/kyoubeai/.hermes`; compose service env `KYOUBE_LEGACY_ENV_KEYS`; Postgres role/db `kyoubeai`; volume `kyoubeai-home`; Dockerfile `ARG KYOUBE_CORE_VERSION`.

- [ ] **Step 1: `docker/Dockerfile`**

Line 2: `ARG KYOUBE_CORE_VERSION=2026.831.1`. The stage-2 `FROM` line: `FROM ghcr.io/paperclipai/paperclip:${KYOUBE_CORE_VERSION}`. Replace the comment `# Stage 2: the runtime image = upstream Paperclip + pi + Hermes + Kyoube.` with `# Stage 2: the runtime image = the upstream core image + pi + Hermes + KyoubeAI.`

Immediately after `USER root` insert:

```dockerfile
# KyoubeAI's home. The base image sets HOME=PAPERCLIP_HOME=/paperclip and gives
# the node user that passwd entry. Everything upstream derives from
# PAPERCLIP_HOME (its packages/shared home-paths module) and its own entrypoint
# chowns `${PAPERCLIP_HOME:-/paperclip}`, so moving the three variables moves
# the whole tree without patching a file. /paperclip is removed outright: on an
# install migrated from 0.1.x, docker/entrypoint.sh recreates it as a symlink
# for as long as the migration marker exists (spec §5); a fresh install never
# has it.
ENV HOME=/kyoubeai \
    PAPERCLIP_HOME=/kyoubeai \
    PAPERCLIP_CONFIG=/kyoubeai/instances/default/config.json
RUN mkdir -p /kyoubeai && chown node:node /kyoubeai && usermod -d /kyoubeai node && rmdir /paperclip
```

Then: the comment block starting `# The base image sets HOME=/paperclip, which is also the runtime volume mount` → `# HOME is /kyoubeai (set above), which is also the runtime volume mount`; every `test -z "$(ls -A /paperclip)"` → `test -z "$(ls -A /kyoubeai)"` (three occurrences); the final ENV `HERMES_HOME=/paperclip/.hermes` → `HERMES_HOME=/kyoubeai/.hermes`; the comment `Both are conventions rather than one product's switch: upstream Paperclip's own telemetry client` → `…: the upstream core's own telemetry client`.

- [ ] **Step 2: `docker/entrypoint.sh`** (whole file)

```sh
#!/bin/sh
# KyoubeAI container entrypoint. Prepares Kyoube state, starts the plugin
# bootstrap watcher, then hands over to the core image's own entrypoint unchanged.
set -e

BOOTSTRAP=/opt/kyoube/bootstrap/dist/kyoube.mjs
home_dir="${PAPERCLIP_HOME:-/kyoubeai}"
MARKER="$home_dir/.migrated-from-paperclip-home"

mkdir -p "$home_dir/kyoube" "$home_dir/.hermes"
if [ "$(id -u)" -eq 0 ]; then
  chown node:node "$home_dir" "$home_dir/kyoube" "$home_dir/.hermes" 2>/dev/null || true
  # An install migrated from 0.1.x (home at /paperclip) can still hold absolute
  # /paperclip/... paths in the core database, adapter configs and harness
  # state. scripts/migrate-from-0.1.sh leaves a marker; while it exists the old
  # path stays resolvable. Deleting the marker removes the link at the next
  # start (`kyoube doctor` says when that is safe).
  if [ -f "$MARKER" ]; then
    [ -e /paperclip ] || ln -s "$home_dir" /paperclip
  elif [ -L /paperclip ]; then
    rm -f /paperclip
  fi
  run_as_node() { gosu node "$@"; }
else
  run_as_node() { "$@"; }
fi

run_as_node node "$BOOTSTRAP" write-config

if [ "${KYOUBE_BOOTSTRAP_DISABLED:-0}" != "1" ]; then
  # Double-fork through a subshell so the watcher is re-parented to PID 1 (tini)
  # and reaped there. Backgrounding it directly would make it a child of this
  # shell, whose PID the `exec` below hands to the core server — leaving a
  # long-lived node process the server never waits on.
  ( run_as_node node "$BOOTSTRAP" ensure-plugins --watch & )
fi

exec docker-entrypoint.sh "$@"
```

`docker/kyoube` comment lines 2–3: `# \`kyoube\` wrapper: always runs the bootstrap program as the \`node\` user so files` / `# it writes under /kyoubeai stay readable by the core server and the watcher.`

- [ ] **Step 3: `docker-compose.yml`** (whole file)

```yaml
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: kyoubeai
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: kyoubeai
      KYOUBE_DB_PASSWORD: ${KYOUBE_DB_PASSWORD:?set KYOUBE_DB_PASSWORD in .env}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/postgres-init:/docker-entrypoint-initdb.d:ro
    restart: unless-stopped
    healthcheck:
      # -h 127.0.0.1 is load-bearing: the entrypoint runs an init pass on a
      # unix socket with TCP not yet listening, so a socket-based pg_isready
      # reports healthy while `app` still cannot connect on 5432. pg_isready
      # does not authenticate, so this also passes on a volume that still holds
      # the 0.1.x `paperclip` role/database until scripts/migrate-from-0.1.sh runs.
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U kyoubeai -d kyoubeai"]
      interval: 2s
      timeout: 5s
      retries: 30

  app:
    build:
      context: .
      dockerfile: docker/Dockerfile
      args:
        # The pinned upstream core image version. PAPERCLIP_VERSION is the 0.1.x
        # name of this key and still works this release.
        KYOUBE_CORE_VERSION: ${KYOUBE_CORE_VERSION:-${PAPERCLIP_VERSION:-2026.831.1}}
        KYOUBE_VERSION: ${KYOUBE_VERSION:-dev}
    image: ${KYOUBE_IMAGE:-kyoubeai}:${KYOUBE_VERSION:-dev}
    # tini is PID 1 inside the image; pids_limit is the backstop against process leaks.
    pids_limit: 2048
    ports:
      - "${KYOUBE_PORT:-3100}:3100"
    environment:
      DATABASE_URL: postgres://kyoubeai:${POSTGRES_PASSWORD}@db:5432/kyoubeai
      KYOUBE_DATABASE_URL: postgres://kyoube:${KYOUBE_DB_PASSWORD}@db:5432/kyoube
      PORT: "3100"
      SERVE_UI: "true"
      # The core server reads its settings under its own PAPERCLIP_* names; the
      # operator sets KYOUBE_* in .env and this block maps them. The 0.1.x names
      # are accepted as fallbacks for this release only.
      PAPERCLIP_DEPLOYMENT_MODE: authenticated
      PAPERCLIP_DEPLOYMENT_EXPOSURE: ${KYOUBE_DEPLOYMENT_EXPOSURE:-${PAPERCLIP_DEPLOYMENT_EXPOSURE:-private}}
      PAPERCLIP_PUBLIC_URL: ${KYOUBE_PUBLIC_URL:-${PAPERCLIP_PUBLIC_URL:-http://localhost:3100}}
      # Which legacy keys are set, so `kyoube doctor` can say so (the container
      # cannot otherwise tell which key supplied a value).
      KYOUBE_LEGACY_ENV_KEYS: "${PAPERCLIP_PUBLIC_URL:+PAPERCLIP_PUBLIC_URL }${PAPERCLIP_DEPLOYMENT_EXPOSURE:+PAPERCLIP_DEPLOYMENT_EXPOSURE }${PAPERCLIP_VERSION:+PAPERCLIP_VERSION}"
      # The core rewrites a loopback-hostname KYOUBE_PUBLIC_URL's port to match
      # its internal listen port (PORT, above), so when KYOUBE_PORT differs from
      # PORT the derived Better Auth trusted-origin list still points at PORT and
      # rejects browser/API requests whose Origin is the published KYOUBE_PORT.
      # This passthrough lets a deployment add the externally-visible origin(s)
      # back in verbatim; empty (default) changes nothing for the common case
      # where KYOUBE_PORT equals PORT (3100).
      BETTER_AUTH_TRUSTED_ORIGINS: ${BETTER_AUTH_TRUSTED_ORIGINS:-}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?set BETTER_AUTH_SECRET in .env}
      KYOUBE_BOARD_API_KEY: ${KYOUBE_BOARD_API_KEY:-}
      # Set to 1 in .env to stop the entrypoint from starting the
      # `kyoube ensure-plugins --watch` background watcher (see .env.example).
      KYOUBE_BOOTSTRAP_DISABLED: ${KYOUBE_BOOTSTRAP_DISABLED:-}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
    volumes:
      - kyoubeai-home:/kyoubeai
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      # curl is installed in the image (see docker/Dockerfile). start_period
      # covers first-boot migrations, which are much slower than a warm start.
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:3100/api/health >/dev/null || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 180s

volumes:
  pgdata:
  kyoubeai-home:
```

Verify the interpolation: `docker compose config | grep -E "PAPERCLIP_PUBLIC_URL|KYOUBE_LEGACY|KYOUBE_CORE_VERSION"` with (a) no env → defaults and an empty `KYOUBE_LEGACY_ENV_KEYS`, (b) `PAPERCLIP_PUBLIC_URL=http://x:1 docker compose config` → the URL and `KYOUBE_LEGACY_ENV_KEYS: PAPERCLIP_PUBLIC_URL`, (c) `KYOUBE_PUBLIC_URL=http://y:2 PAPERCLIP_PUBLIC_URL=http://x:1 …` → `http://y:2` wins.

- [ ] **Step 4: `docker/postgres-init/01-kyoube.sh`** — pass the database name in instead of naming it:

```bash
#!/bin/bash
# Runs once, on first initialisation of the Postgres data volume.
# Creates the KyoubeAI organisation database and its login role.
set -euo pipefail
: "${KYOUBE_DB_PASSWORD:?KYOUBE_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 -v pw="$KYOUBE_DB_PASSWORD" -v core="$POSTGRES_DB" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
  -- CREATEROLE is needed because the apps plugin creates one NOLOGIN role per company.
  CREATE ROLE kyoube LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT;
  CREATE DATABASE kyoube OWNER kyoube;
  REVOKE CONNECT ON DATABASE :"core" FROM PUBLIC;
  REVOKE CONNECT ON DATABASE kyoube FROM PUBLIC;
EOSQL
```

- [ ] **Step 5: `.env.example` and `scripts/smoke.env`**

`.env.example` — replace the Reachability and Versions blocks:

```
# ---- Reachability ----
# The URL people type into the browser. Must match exactly (scheme, host, port).
KYOUBE_PUBLIC_URL=http://localhost:3100
KYOUBE_PORT=3100
# private = LAN/VPN/Tailscale (browser first-admin claim enabled); public = internet-facing (put TLS in front)
KYOUBE_DEPLOYMENT_EXPOSURE=private
# If KYOUBE_PUBLIC_URL's host is localhost/127.0.0.1 and KYOUBE_PORT is changed
# from 3100 (e.g. to run a second instance side by side), also set this to the
# same http://localhost:<KYOUBE_PORT> — the core otherwise derives the trusted
# origin from its internal port (3100) and rejects sign-up/claim with 403.
BETTER_AUTH_TRUSTED_ORIGINS=

# ---- Versions ----
# The pinned upstream core image (bumped with scripts/bump-core.sh).
KYOUBE_CORE_VERSION=2026.831.1
KYOUBE_VERSION=dev
```
Keep every other line. Add at the end of the file:
```
# ---- 0.1.x installs ----
# PAPERCLIP_PUBLIC_URL, PAPERCLIP_DEPLOYMENT_EXPOSURE and PAPERCLIP_VERSION are
# still honoured this release; `bash scripts/migrate-from-0.1.sh` renames them.
```

`scripts/smoke.env`: `KYOUBE_PUBLIC_URL=http://localhost:3199`, `KYOUBE_DEPLOYMENT_EXPOSURE=private`, `KYOUBE_CORE_VERSION=2026.831.1` (replace the three legacy keys; the comment's `PAPERCLIP_PUBLIC_URL` → `KYOUBE_PUBLIC_URL`, "Paperclip rewrites" → "The core rewrites").

- [ ] **Step 6: `scripts/smoke.sh` follows the new names**

Exact edits (line numbers from the current file):
- 59: comment `/paperclip/kyoube/config.json` → `/kyoubeai/kyoube/config.json`
- 122, 125, 522: `/paperclip/kyoube/board-key.json` → `/kyoubeai/kyoube/board-key.json`
- 219: `\"cwd\":\"/paperclip/workspaces/smoke\"` → `\"cwd\":\"/kyoubeai/workspaces/smoke\"`
- 408–410, 450, 553, 567: comment "`paperclip` is the compose superuser" → "`kyoubeai` is the compose superuser"; every `psql -U paperclip` → `psql -U kyoubeai`
- 462, 470: `paperclip.dump` → `kyoubeai.dump`, `paperclip-home.tgz` → `kyoubeai-home.tgz` (twice on 470)
- 472: `destroys pgdata and paperclip-home` → `destroys pgdata and kyoubeai-home`
- 517: comment "restored paperclip database" → "restored core database"
- 57: comment "poll until Paperclip reports it ready" → "poll until the core reports it ready"; 155 "as Paperclip stores them" → "as the core stores them"; 379–381 "through Paperclip's tool gateway" → "through the core's tool gateway"

Add after the brand block from Task 6:

```bash
echo "==> home and database names"
APP_HOME="$(compose exec -T app sh -c 'echo "$HOME:$PAPERCLIP_HOME:$HERMES_HOME"; getent passwd node | cut -d: -f6; test -e /paperclip && echo LEGACY_PATH_PRESENT || echo no-legacy-path' | tr -d '\r')"
[[ "$APP_HOME" == $'/kyoubeai:/kyoubeai:/kyoubeai/.hermes\n/kyoubeai\nno-legacy-path' ]] \
  || { echo "unexpected home layout in app:" >&2; echo "$APP_HOME" >&2; exit 1; }
DBS="$(compose exec -T db psql -U kyoubeai -d postgres -Atc 'select datname from pg_database order by 1' | tr -d '\r')"
grep -qx kyoubeai <<<"$DBS" || { echo "no kyoubeai database: $DBS" >&2; exit 1; }
! grep -qx paperclip <<<"$DBS" || { echo "a paperclip database still exists: $DBS" >&2; exit 1; }
docker volume ls --format '{{.Name}}' | grep -qx "${PROJECT}_kyoubeai-home" || { echo "volume ${PROJECT}_kyoubeai-home missing" >&2; exit 1; }
echo "    HOME=/kyoubeai, database kyoubeai, volume ${PROJECT}_kyoubeai-home"
```

- [ ] **Step 7: Build and smoke** — `KEEP=0 bash scripts/smoke.sh` (detached, log watched). Expected: passes through the disaster-recovery round trip; the backup phase now lists `kyoubeai.dump` and `kyoubeai-home.tgz` **only after Task 9** — so run Tasks 8 and 9 back to back and smoke once after Task 9 if you prefer; either way the smoke must be green before Task 10's commit.

- [ ] **Step 8: Commit**

```bash
git add docker/Dockerfile docker/entrypoint.sh docker/kyoube docker-compose.yml docker/postgres-init/01-kyoube.sh .env.example scripts/smoke.env scripts/smoke.sh
git commit -m "feat(docker): home at /kyoubeai, kyoubeai role/database/volume, KYOUBE_* operator keys"
```

---

### Task 9: Backup and restore follow the new names (and still read 0.1.x backups)

**Files:**
- Modify: `scripts/backup.sh`, `scripts/restore.sh`

**Interfaces:**
- Produces: backups hold `kyoubeai.dump`, `kyoube.dump`, `roles.sql`, `kyoubeai-home.tgz`, `SHA256SUMS`; `restore.sh <dir>` accepts either naming and, for a 0.1.x backup, writes the migration marker into the restored home.

- [ ] **Step 1: `scripts/backup.sh`**

Header comment lines 4–7: `kyoubeai.dump      pg_dump -Fc of the core database`, `kyoubeai-home.tgz  the /kyoubeai home volume (board key, harness creds)`. Line 22: `it only ever sees /kyoubeai`. Then:

```bash
echo "backup: dumping the core (kyoubeai) database"
docker compose exec -T db pg_dump -U kyoubeai -Fc kyoubeai > "$OUT/kyoubeai.dump"

echo "backup: dumping the kyoube database"
docker compose exec -T db pg_dump -U kyoubeai -Fc kyoube > "$OUT/kyoube.dump"
```
`pg_dumpall -U kyoubeai …`; the awk filter and comments: "the `paperclip` superuser" → "the `kyoubeai` superuser". The archive step:
```bash
echo "backup: archiving the kyoubeai-home volume"
docker run --rm --volumes-from "$APP_CID" "$TAR_IMAGE" \
  sh -c 'exec tar czf - -C /kyoubeai .' > "$OUT/kyoubeai-home.tgz"
```
and both file lists (the non-empty gate and `sha256sum`) become `kyoubeai.dump kyoube.dump roles.sql kyoubeai-home.tgz`. The comment "a bare `-C /paperclip` argument" → `-C /kyoubeai`.

- [ ] **Step 2: `scripts/restore.sh`**

Replace the file-presence loop with name resolution:

```bash
# Backups from 0.1.x carry the core dump and home archive under their old names;
# both restore into the 0.2.x layout, and a legacy backup also gets the
# migration marker so the entrypoint keeps /paperclip resolvable for the
# absolute paths that database still holds (see docs/upgrading.md).
CORE_DUMP=kyoubeai.dump; [[ -f "$SRC/$CORE_DUMP" ]] || CORE_DUMP=paperclip.dump
HOME_TGZ=kyoubeai-home.tgz; [[ -f "$SRC/$HOME_TGZ" ]] || HOME_TGZ=paperclip-home.tgz
LEGACY_BACKUP=0
[[ "$CORE_DUMP" == paperclip.dump || "$HOME_TGZ" == paperclip-home.tgz ]] && LEGACY_BACKUP=1
for file in "$CORE_DUMP" kyoube.dump roles.sql "$HOME_TGZ" SHA256SUMS; do
  if [[ ! -f "$SRC/$file" ]]; then
    echo "restore: $SRC/$file is missing — not a backup directory from scripts/backup.sh" >&2
    exit 1
  fi
done
```
`psql_admin` and every `psql -U paperclip` / `pg_restore -U paperclip` → `kyoubeai`. `restore_db` takes the dump file explicitly:
```bash
restore_db() { # database dump-file [extra pg_restore flags...]
  local db="$1" dump="$2"; shift 2
  echo "restore: rebuilding the $db database from $dump"
  psql_admin "DROP DATABASE IF EXISTS ${db}_restore_tmp WITH (FORCE)"
  psql_admin "CREATE DATABASE ${db}_restore_tmp"
  docker compose exec -T db pg_restore -U kyoubeai -d "${db}_restore_tmp" --exit-on-error "$@" < "$SRC/$dump"
  psql_admin "DROP DATABASE IF EXISTS ${db} WITH (FORCE)"
  psql_admin "ALTER DATABASE ${db}_restore_tmp RENAME TO ${db}"
}
```
Calls: `restore_db kyoubeai "$CORE_DUMP" --no-owner` and `restore_db kyoube kyoube.dump`. Step 5: `REVOKE CONNECT ON DATABASE kyoubeai FROM PUBLIC`. Step 6:
```bash
echo "restore: replacing the kyoubeai-home volume"
docker run --rm -i --volumes-from "$APP_CID" "$TAR_IMAGE" \
  sh -c 'rm -rf /kyoubeai/..?* /kyoubeai/.[!.]* /kyoubeai/* 2>/dev/null; exec tar xzf - -C /kyoubeai' \
  < "$SRC/$HOME_TGZ"
if [[ "$LEGACY_BACKUP" == "1" ]]; then
  echo "restore: 0.1.x backup — leaving the migration marker so /paperclip stays resolvable"
  docker run --rm --volumes-from "$APP_CID" "$TAR_IMAGE" \
    sh -c 'touch /kyoubeai/.migrated-from-paperclip-home && chown "$(stat -c %u:%g /kyoubeai)" /kyoubeai/.migrated-from-paperclip-home'
fi
```
Comments naming "Paperclip's own database"/"the `paperclip` superuser" → "the core database"/"the `kyoubeai` superuser"; the header's `/paperclip` → `/kyoubeai`.

- [ ] **Step 3: Smoke** — `KEEP=0 bash scripts/smoke.sh`. Expected: green, including the disaster-recovery round trip with the new file names (Task 8 Step 6 already updated the smoke's expectations).

- [ ] **Step 4: Commit**

```bash
git add scripts/backup.sh scripts/restore.sh
git commit -m "feat(ops): back up and restore the kyoubeai database and home; accept 0.1.x backups"
```

---

### Task 10: Pins, the bump script, Renovate, workflows and derived smoke versions

**Files:**
- Rename: `scripts/bump-paperclip.sh` → `scripts/bump-core.sh`
- Modify: `scripts/check-pins.sh`, `renovate.json`, `.github/workflows/upstream-beta.yml`, `scripts/smoke.sh`

**Interfaces:**
- Produces: `bash scripts/bump-core.sh <version>` rewrites `ARG KYOUBE_CORE_VERSION` (Dockerfile), `KYOUBE_CORE_VERSION=` (`.env.example`, `scripts/smoke.env`), the compose innermost default `PAPERCLIP_VERSION:-<v>` (kept as the legacy fallback name on purpose — see the compose comment), and every plugin's SDK pin; `check-pins.sh` compares the same five places.

- [ ] **Step 1: `scripts/check-pins.sh`**

```bash
dockerfile="$(sed -n 's/^ARG KYOUBE_CORE_VERSION=\(.*\)$/\1/p' "$ROOT/docker/Dockerfile" | head -1)"
[[ -n "$dockerfile" ]] || { echo "PIN ERROR: no ARG KYOUBE_CORE_VERSION= line in docker/Dockerfile" >&2; exit 1; }
envfile="$(sed -n 's/^KYOUBE_CORE_VERSION=\(.*\)$/\1/p' "$ROOT/.env.example")"
smoke="$(sed -n 's/^KYOUBE_CORE_VERSION=\(.*\)$/\1/p' "$ROOT/scripts/smoke.env")"
# The compose default is nested: KYOUBE_CORE_VERSION falls back to the 0.1.x
# key PAPERCLIP_VERSION, which falls back to the pin. Read the innermost value.
compose="$(sed -n 's/.*PAPERCLIP_VERSION:-\([0-9.]*\)}}.*/\1/p' "$ROOT/docker-compose.yml" | head -1)"
```
Header comment: `# Fails when the core image pin and the plugin SDK pins disagree.`

- [ ] **Step 2: `git mv scripts/bump-paperclip.sh scripts/bump-core.sh`** and edit:

```bash
# Bumps every core pin (image + plugin SDK) to one version and reinstalls.
# Usage: scripts/bump-core.sh 2026.914.1
…
NEW="${1:?usage: bump-core.sh <version>}"
…
sed -i.bak "s/^ARG KYOUBE_CORE_VERSION=.*/ARG KYOUBE_CORE_VERSION=${NEW}/" "$ROOT/docker/Dockerfile"
sed -i.bak "s/^KYOUBE_CORE_VERSION=.*/KYOUBE_CORE_VERSION=${NEW}/" "$ROOT/.env.example" "$ROOT/scripts/smoke.env"
sed -i.bak "s/PAPERCLIP_VERSION:-[0-9.]*}}/PAPERCLIP_VERSION:-${NEW}}}/" "$ROOT/docker-compose.yml"
…
echo "Bumped the core pins to ${NEW}. Next: pnpm test && bash scripts/smoke.sh, then commit 'chore: bump core to ${NEW}'."
```

- [ ] **Step 3: `renovate.json`** — descriptions and the regex manager:

```json
    {
      "description": "Core host image and plugin SDK move together",
      "groupName": "core",
      "matchPackageNames": ["@paperclipai/plugin-sdk", "ghcr.io/paperclipai/paperclip"],
      "schedule": ["before 6am on monday"]
    }
```
```json
      "description": "Core image pins: ARG in the Dockerfile, KYOUBE_CORE_VERSION in the env files, the compose fallback",
      "fileMatch": ["^docker/Dockerfile$", "^\\.env\\.example$", "^scripts/smoke\\.env$", "^docker-compose\\.yml$"],
      "matchStrings": ["(?:KYOUBE_CORE_VERSION|PAPERCLIP_VERSION)[=:-]+(?<currentValue>\\d{4}\\.\\d{3,4}\\.\\d+)"],
```

- [ ] **Step 4: `.github/workflows/upstream-beta.yml`** — the sed step:

```yaml
      - name: Smoke against the core image's beta channel
        run: |
          grep -q '^KYOUBE_CORE_VERSION=' scripts/smoke.env
          sed -i 's/^KYOUBE_CORE_VERSION=.*/KYOUBE_CORE_VERSION=beta/' scripts/smoke.env
          grep -q '^KYOUBE_CORE_VERSION=beta$' scripts/smoke.env
          bash scripts/smoke.sh
```
Issue title `"The core image's :beta channel breaks the KyoubeAI smoke test"`, body: `` `The weekly build against ghcr.io/paperclipai/paperclip:beta failed. See … Check the plugin SDK changelog before bumping KYOUBE_CORE_VERSION.` ``.

- [ ] **Step 5: `scripts/smoke.sh` derives the apps version** — after the `SHIPPED=` block (line 188–193) add:

```bash
APPS_SHIPPED="$(jq -r .version "$ROOT/plugins/kyoube-apps/package.json")"
[[ "$APPS_SHIPPED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "unexpected kyoube.apps version '$APPS_SHIPPED' in package.json" >&2; exit 1; }
```
but the first use is at line 82 (`wait_for_plugin kyoube.apps 0.4.1`), so put the two lines right before `echo "==> install plugins via kyoube ensure-plugins"` instead, and replace the four `0.4.1` literals (lines 82, 83, 524, 580–581) with `$APPS_SHIPPED` / `${APPS_SHIPPED}`.

- [ ] **Step 6: Check** — `bash scripts/check-pins.sh` prints `pins consistent: 2026.831.1`; `bash scripts/bump-core.sh 2026.831.1` is a no-op that leaves `git status` clean apart from nothing (run it, confirm `git diff --stat` is empty, since the version is unchanged); `grep -rn "PAPERCLIP_VERSION" --exclude-dir=node_modules --exclude-dir=docs .` lists only the compose fallback, the Renovate regex, check-pins, bump-core and `.env.example`'s trailer comment.

- [ ] **Step 7: Commit**

```bash
git add scripts/check-pins.sh scripts/bump-core.sh renovate.json .github/workflows/upstream-beta.yml scripts/smoke.sh
git commit -m "chore: rename the core version pin to KYOUBE_CORE_VERSION"
```

---

## Phase C — Our own repository

### Task 11: The `kyoube` CLI names the product, not the engine

**Files:**
- Rename: `docker/bootstrap/src/paperclip-api.ts` → `docker/bootstrap/src/core-api.ts`; `docker/bootstrap/tests/paperclip-api.spec.ts` → `docker/bootstrap/tests/core-api.spec.ts`
- Modify: `docker/bootstrap/src/{skills,plugins}.ts`, `docker/bootstrap/src/commands/{doctor,setup,ensure-plugins}.ts`, `docker/bootstrap/tests/{setup,ensure-plugins,doctor}.spec.ts`, `docker/bootstrap/package.json`

**Interfaces:**
- Produces: `CoreClient` (was `PaperclipClient`), `CoreClientOptions`, `CoreApiError` (`.name === "CoreApiError"`), `createCoreClient(opts)`. Every other export of the module keeps its name. Config field `paperclipApiUrl` stays (file format).

- [ ] **Step 1: Rename the module and its identifiers**

```bash
git mv docker/bootstrap/src/paperclip-api.ts docker/bootstrap/src/core-api.ts
git mv docker/bootstrap/tests/paperclip-api.spec.ts docker/bootstrap/tests/core-api.spec.ts
cd docker/bootstrap
sed -i \
  -e 's#\./paperclip-api\.js#./core-api.js#g; s#\.\./paperclip-api\.js#../core-api.js#g; s#\.\./src/paperclip-api\.js#../src/core-api.js#g' \
  -e 's/\bPaperclipClientOptions\b/CoreClientOptions/g; s/\bPaperclipClient\b/CoreClient/g; s/\bPaperclipApiError\b/CoreApiError/g; s/\bcreatePaperclipClient\b/createCoreClient/g' \
  src/*.ts src/commands/*.ts tests/*.ts
```
(GNU sed on Git Bash; `\b` is supported.) Then in `src/core-api.ts` by hand: `this.name = "CoreApiError";`; the two messages → `` `KyoubeAI API request failed: ${response.status} ${init.method ?? "GET"} ${path}` `` and `` `KyoubeAI at ${apiBase} did not become healthy within ${timeoutMs}ms (${reason})` ``; the doc comment on `commit` → "Build commit SHA of the running core server". In `src/commands/setup.ts:33` the comment "Paperclip's CLI auth challenge" → "the core's CLI auth challenge". `package.json` description → "The `kyoube` CLI: writes runtime config, installs the Kyoube plugins into the core host, and runs diagnostics". In `tests/ensure-plugins.spec.ts:29` "in paperclip 2026.831.1" → "in core 2026.831.1"; leave the `fake-paperclip` hostnames (test fixtures).

- [ ] **Step 2: Grep for leftovers**

Run: `grep -rn "Paperclip\|paperclip" docker/bootstrap/src docker/bootstrap/tests | grep -v "PAPERCLIP_\|paperclipApiUrl\|fake-paperclip\|migrated-from-paperclip\|/paperclip ->\|legacy"`
Expected: no output. (`PAPERCLIP_*` env names, the config field, and the legacy-migration strings are the documented exceptions.)

- [ ] **Step 3: Tests and build** — `pnpm --filter @kyoube/bootstrap typecheck && pnpm --filter @kyoube/bootstrap test && pnpm --filter @kyoube/bootstrap build` → green; `node docker/bootstrap/dist/kyoube.mjs --help` prints the usage with `/kyoubeai/kyoube/config.json`.

- [ ] **Step 4: Commit**

```bash
git add -A docker/bootstrap
git commit -m "refactor(bootstrap): core-api client and product-named messages"
```

---

### Task 12: Plugin text, skills and version bumps

**Files:**
- Modify: `plugins/kyoube-apps/src/skills/kyoube-data.md:10`, `plugins/kyoube-apps/src/skills/kyoube-apps.md:3`, `plugins/kyoube-apps/src/apps/page-route.ts:5`, `plugins/kyoube-terminal/src/ui/xterm-styles.ts:9`, `plugins/kyoube-terminal/src/manifest.ts:7`
- Modify: `plugins/kyoube-terminal/package.json:3`, `plugins/kyoube-terminal/src/manifest.ts:4`, `plugins/kyoube-apps/package.json:3`, `plugins/kyoube-apps/src/manifest.ts:11`
- Test: existing suites; smoke derives versions (Task 10)

- [ ] **Step 1: Skills text (what agents read)**

`kyoube-data.md:10`: "here can reach another company's data or Paperclip's own tables." → "here can reach another company's data or the platform's own tables."
`kyoube-apps.md:3`: "…single-file HTML applications that run inside the Paperclip UI and use…" → "…single-file HTML applications that run inside the KyoubeAI UI and use…".
Then `grep -n "Paperclip" plugins/*/src/skills/*.md` → nothing (the `PAPERCLIP_*` env var names in the endpoint tables stay: they are what the run actually carries).

- [ ] **Step 2: Comments that describe our own UI**

`page-route.ts:5`: "upstream Paperclip owns" → "the upstream core owns". `xterm-styles.ts:9`: "under the Paperclip UI's border-box preflight" → "under the host UI's border-box preflight". `kyoube-terminal/src/manifest.ts:7`: "Paperclip 2026.831.1 compares" → "Core 2026.831.1 compares". Type names `PaperclipPlugin`, `PaperclipPluginManifestV1` are SDK imports and stay.

- [ ] **Step 3: Versions**

`kyoube.terminal`: `plugins/kyoube-terminal/package.json` `"version": "0.2.3"`, `src/manifest.ts` `PLUGIN_VERSION = "0.2.3"`. `kyoube.apps`: `plugins/kyoube-apps/package.json` `"version": "0.4.2"`, `src/manifest.ts` `PLUGIN_VERSION = "0.4.2"`. Any unit test pinning a version literal (`grep -rn '"0.2.2"\|"0.4.1"' plugins/*/tests`) is updated to the new literal.

- [ ] **Step 4: Verify** — `pnpm typecheck && pnpm test && pnpm build`; `bash scripts/check-pins.sh` still consistent.

- [ ] **Step 5: Commit**

```bash
git add plugins
git commit -m "feat(plugins): product-named skills and hints; terminal 0.2.3, apps 0.4.2"
```

---

### Task 13: Documentation, license, changelog

**Files:**
- Modify: `README.md`, `docs/architecture.md`, `docs/operations.md`, `docs/governance.md`, `docs/upgrading.md`, `docs/apps.md`, `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE`, `CHANGELOG.md`, `package.json`, `docs/superpowers/plans/README.md`
- Create: `docs/branding.md`

**Rules for every doc edit** (the spec §6): KyoubeAI is the product. Where the upstream engine must be named for an operator or contributor — the `FROM` line, upgrading the core, the license, the SDK contract — write "the core (Paperclip)" the first time in a document and "the core" after that. Paths: `/paperclip` → `/kyoubeai`; `paperclip-home` → `kyoubeai-home`; the `paperclip` database/role → `kyoubeai`; `PAPERCLIP_PUBLIC_URL`/`PAPERCLIP_DEPLOYMENT_EXPOSURE`/`PAPERCLIP_VERSION` → the `KYOUBE_*` keys (agent-facing `PAPERCLIP_API_URL` etc. stay); `bump-paperclip.sh` → `bump-core.sh`; backup files → `kyoubeai.dump`, `kyoubeai-home.tgz`. Links into `github.com/paperclipai/paperclip` stay where they point at a specific upstream document (governance doc, PR #12502, security policy): those are references, not product surface.

- [ ] **Step 1: `README.md`**

Line 3: `**A multi-user AI operating system for organisations.**` (drop "built on …"; the credit moves to the end). Line 7: "without a single patch to the underlying Paperclip host" → "without patching the core it runs on". Line 21: "run sandboxed inside the Paperclip UI" → "inside the KyoubeAI UI". Line 23: "upgrading Paperclip and Kyoube" → "upgrading the core and KyoubeAI". Line 52: "Paperclip rewrites a loopback `PAPERCLIP_PUBLIC_URL`" → "the core rewrites a loopback `KYOUBE_PUBLIC_URL`". Line 63: `paperclip-home` → `kyoubeai-home`. Line 67: `HOME=/paperclip` → `HOME=/kyoubeai`. Line 73: "separate from Paperclip's own database" → "separate from the core's own database"; "but Paperclip 2026.831.1 only hands" → "but core 2026.831.1 only hands". Line 77: "summarised in Paperclip's activity log" → "in the activity log". Line 81: "Paperclip's tool policies" → "the core's tool policies" (twice). Line 85: "inside the Paperclip UI" → "inside the KyoubeAI UI". Line 91: "upstream Paperclip + pinned" → "the upstream core + pinned". Line 93: "Paperclip plugins" → "Core plugins". Line 95: "databases `paperclip` and `kyoube`" → "databases `kyoubeai` and `kyoube`". Line 98: `scripts/bump-paperclip.sh` → `scripts/bump-core.sh`, "Paperclip image" → "core image". Line 102: "Upgrading KyoubeAI and Paperclip" → "Upgrading KyoubeAI and the core". Line 111: "the `/paperclip` home volume" → "the `/kyoubeai` home volume". Line 116: "**Paperclip:** run `scripts/bump-paperclip.sh <version>`" → "**The core:** run `scripts/bump-core.sh <version>`"; "copy the new `PAPERCLIP_VERSION`" → "copy the new `KYOUBE_CORE_VERSION`". Line 119: "before a Paperclip bump" → "before a core bump". Line 122: "Known upstream issue in Paperclip 2026.831.1 (fixed upstream in [#12502](…))" → "Known upstream issue in core 2026.831.1 (fixed upstream in [#12502](…))". Line 127: "next stable Paperclip release" → "next stable core release". Lines 131–132: "The image is built `FROM` a pinned upstream release of the core (Paperclip, `KYOUBE_CORE_VERSION`); nothing in this repository is core source, and the only change applied to the core at build time is the branding transform in `docker/rebrand/` (see `docs/branding.md`)." Line 134: "no imports from Paperclip's own server or UI source" → "no imports from the core's own server or UI source". Line 137: `bump-paperclip.sh` → `bump-core.sh`. Line 141: "upstream Paperclip's own opt-out telemetry" → "the core's own opt-out telemetry". Line 145: "against Paperclip's own `:beta`" → "against the core image's `:beta`". Line 174: "The underlying Paperclip UI slot" → "The underlying core UI slot". Line 176: "to make Paperclip's bundled-plugin allowlist" → "to make the core's bundled-plugin allowlist". Line 181 (License section) becomes:

```markdown
MIT. See `LICENSE`.

## Built on

KyoubeAI is built on the [Paperclip](https://github.com/paperclipai/paperclip) engine (MIT, © Paperclip AI), consumed as a published image and rebranded at build time; see `docs/branding.md` for what that transform does and does not change.
```

Then `grep -n "Paperclip\|paperclip" README.md` must list only: the `## Built on` block, the `#12502` link, and the `ghcr.io/paperclipai/paperclip` image name if it appears.

- [ ] **Step 2: `docs/*.md`, `SECURITY.md`, `CONTRIBUTING.md`**

Apply the rules to every line the survey listed (the executor re-runs `grep -n "Paperclip\|paperclip" docs/architecture.md docs/operations.md docs/governance.md docs/upgrading.md docs/apps.md SECURITY.md CONTRIBUTING.md`). Specific rewrites that are not mechanical:

- `docs/architecture.md:3–6`: "KyoubeAI is a Docker overlay on top of the upstream core (Paperclip, https://github.com/paperclipai/paperclip) image…"; `:41` "Paperclip server + UI (upstream, unmodified)" → "core server + UI (upstream; rebranded at build time, otherwise unmodified)"; `:50,55` database `kyoubeai`, "owned by the `kyoubeai` superuser"; `:52` `volume kyoubeai-home:/kyoubeai`; `:59` "browser: KyoubeAI UI (core pages + Terminal, Data, Apps)"; `:147` `HOME=/kyoubeai`; `:153` "separate from the core's own `kyoubeai` database"; `:212` `bump-core.sh`. Add a short section "## Branding" that points at `docs/branding.md` and states the one-sentence mechanism.
- `docs/operations.md:42–48`: `pgdata` holds "the `kyoubeai` database (the core's), the `kyoube` database"; `kyoubeai-home` mounted at `/kyoubeai`; the `kyoubeai` superuser; `:62,70`, `:83–86` backup file names, `:92,166,169,172,177,189` names; `:264` `psql -U kyoubeai`; `:304–329` `/kyoubeai/...` paths; `:362–367` `kyoubeai-home`, `/kyoubeai/workspaces`; "Paperclip's activity log/health" → "the core's".
- `docs/governance.md`: "Paperclip's tool profiles and policies" → "the core's tool profiles and policies" (first mention: "the core's (Paperclip's)"), keep both upstream doc links; `$PAPERCLIP_URL` in the CLI examples is the operator's shell variable for the base URL — rename it `$KYOUBE_URL` in the examples.
- `docs/upgrading.md`: section "## Upgrading Paperclip" → "## Upgrading the core"; `bump-paperclip.sh` → `bump-core.sh`; `PAPERCLIP_VERSION` → `KYOUBE_CORE_VERSION`; "Paperclip's release notes" → "the core's (Paperclip's) release notes"; `:39` `kyoubeai-home`; `:106` "the core's own migrations … against the `kyoubeai` database"; `:120–134` "the core's migrations", "the restored `kyoubeai` database". The new "Upgrading from 0.1.x" section is written in Task 15.
- `docs/apps.md:134,142`: "core 2026.831.1", "no core API".
- `SECURITY.md`: `:13` "A vulnerability in **the core itself** (Paperclip — the upstream host this project runs rebranded but otherwise unmodified, `FROM` …)"; `:19–41` the same substitutions as the README's Security section; `:38` `REVOKE CONNECT ON DATABASE kyoubeai`; `:219` table row label "**Core** (server, CLI)", keep the verified telemetry facts and the `telemetry.paperclip.ing` endpoint verbatim (they describe the upstream code); `:245–248` "**The core itself.** … report to [the upstream project's Security Policy](…)"; `:259` `kyoubeai-home`.
- `CONTRIBUTING.md`: `:3–4` "two core plugins"; `:45` "touches the core pin"; the section "## Never patch Paperclip" → "## Never patch the core" with one added sentence: "The single exception is `docker/rebrand/`, a build-time transform of the core's *user-facing text and artwork* that is re-applied on every build; it changes no behaviour, and `docs/branding.md` lists what it leaves alone."; `:113–114` "the core's own source".

Verification for this step: `grep -rn "Paperclip" README.md docs/*.md SECURITY.md CONTRIBUTING.md | grep -v "(Paperclip" | grep -v "paperclipai/paperclip" | grep -v "Paperclip AI"` prints nothing (parenthetical first mentions, upstream URLs and the copyright holder are the allowed forms).

- [ ] **Step 3: `docs/branding.md`** (new)

```markdown
# Branding

KyoubeAI runs on an upstream engine (Paperclip) whose own UI, server messages, agent skills and
artwork say "Paperclip". Nothing upstream makes that configurable, so KyoubeAI applies a **build-time
transform**: `docker/rebrand/rebrand.mjs` runs inside `docker/Dockerfile` right after the core layer
and rewrites the served surfaces in place. It runs on every build, on the pristine core layer, so a
core bump is re-branded by construction, and it exits non-zero — failing the build — when an upstream
change slips past its rules. The design and its rationale: `docs/superpowers/specs/2026-09-13-white-label-design.md`.

## What the transform does

1. **Text.** In the compiled UI (`ui/dist`), the server (`server/dist`), the shared packages' `dist`
   output, the built-in skills, the CLI and the shipped docs, it applies three rules in order:
   exact phrase overrides (`docker/brand/brand.json` → `phrases`), a map of upstream URLs to ours
   (`urls`), and the generic name rule — `Paperclip`, case-sensitive, not preceded by
   `[A-Za-z0-9_$-]` and not followed by `[A-Za-z0-9_$]`, becomes the brand name. Capitalised
   `Paperclip` is display text; lowercase and camelCase forms are identifiers the core compares
   against, and they are left alone.
2. **Artwork.** Favicons and PWA icons come from `docker/brand/icons/`; `favicon.svg` and the
   loading animation (`/kyoubeai-thinking.svg`) are rendered from `docker/brand/mark.svg`; the
   sign-in lockup inside the JS bundle is replaced with `docker/brand/lockup.svg`; `site.webmanifest`
   is regenerated from `brand.json`.
3. **Asset names.** Everything under `/assets` is served immutable for a year, so each file is
   renamed `name-<upstream hash>-<8 hex>.ext` and every reference is rewritten. A browser that
   cached an unbranded bundle fetches the branded one.
4. **Verification.** After rewriting, the name rule must match nothing, the two SVG anchors must
   have matched exactly once, `index.html` must carry the brand title, and every asset reference
   must resolve. Otherwise `docker build` fails and the log says what moved.

The build log carries two `rebrand:` lines with the counts. `docker/rebrand/tests` pins every rule
on fixtures; `scripts/brand-live-check.mjs` loads the sign-in page of a running stack in headless
Chrome and checks what a person sees; `scripts/smoke.sh` checks the served title, manifest, icon
and bundle.

## What it leaves alone, on purpose

| Kept | Why |
|---|---|
| `PAPERCLIP_*` environment variables inside the container (`PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_HOME`, …) | The core's adapters, CLI, MCP server and skills read them. Operators never set them: `docker-compose.yml` maps the `KYOUBE_*` keys in `.env` onto them. |
| Skill keys and slugs (`paperclipai/paperclip/paperclip`, `paperclip-board`), enum values (`paperclip_runner`, `paperclip_managed`), CSS classes, localStorage keys, package names, the `X-Paperclip-Run-Id` header | Lookup keys, not display text. Their labels are rebranded; the keys show only in URLs, API JSON and the Skills library's key column. |
| The paperclip glyph used as an *attachment* icon | A generic icon in ~20 places; the brand instances (favicon, lockup, loading animation) are replaced. |
| `FROM ghcr.io/paperclipai/paperclip:<version>`, `renovate.json`, `scripts/bump-core.sh` | Build inputs. |
| `telemetry.paperclip.ing` endpoints | Off by default (`DO_NOT_TRACK=1`); pointing them at a host we do not run would only turn silence into errors. |
| The copyright notice in `LICENSE` and the "Built on" line in the README | The MIT license requires the notice. |
| Rows already stored in a database before the rebrand (old comments, run transcripts, agents' saved instructions, built-in agents created earlier) | Data, not code. New rows are branded. |
| `docs/superpowers/**` | Engineering history. |

## Changing the brand

Edit `docker/brand/brand.json` (name, description, URLs, phrase overrides), replace `mark.svg`
(one stroked path in a 24×24 box — the loading animation draws it) and `lockup.svg`, run
`node scripts/render-brand-icons.mjs`, then `docker compose up -d --build`. The tests and the
build verification read the kit, so nothing else changes.

## After a core bump

Read the two `rebrand:` lines in the build log. `residual 0` and `lockup=1 thinking=1` mean the
rules held. A failed build names the file and context of whatever slipped: a new display string the
rule cannot classify goes into `phrases`; a moved lockup or loading icon means updating the anchor
in `docker/rebrand/lib/svg.mjs` (and its fixture in `docker/rebrand/tests/svg.spec.mjs`).
```

- [ ] **Step 4: `LICENSE`, `CHANGELOG.md`, `package.json`, plans index**

`LICENSE` addendum (replace the last paragraph):
```
KyoubeAI builds on Paperclip (https://github.com/paperclipai/paperclip),
Copyright (c) 2025 Paperclip AI, distributed under the MIT License. The
Paperclip image and packages are consumed as published artifacts; at image
build time KyoubeAI applies a branding transform to the image's user-facing
text and artwork (docker/rebrand/) and does not otherwise modify them.
```

`CHANGELOG.md` — insert directly under `## Unreleased`, before `### Added`:
```markdown
### Breaking

- **Rebranded.** Every surface says KyoubeAI: the web UI (title, sign-in lockup, favicon, PWA
  manifest, every display string), API messages, the prompts and built-in skills agents read, the
  `kyoube` CLI and the docs. The core image is transformed at build time by `docker/rebrand/`
  (re-applied on every build, verified, fails the build on drift); `docs/branding.md` lists what is
  deliberately left alone (`PAPERCLIP_*` variables agents read, skill keys, enum values, the header).
- **Home moved to `/kyoubeai`** (`HOME`, `PAPERCLIP_HOME`, `HERMES_HOME=/kyoubeai/.hermes`); the compose
  volume is `kyoubeai-home`. Credentials and workspaces of a 0.1.x install live on the old volume until
  `bash scripts/migrate-from-0.1.sh` copies them.
- **Postgres role and database renamed** `paperclip` → `kyoubeai` (`POSTGRES_USER`, `POSTGRES_DB`,
  `DATABASE_URL`). The migration script renames them in place through a temporary superuser.
- **`.env` keys**: `KYOUBE_PUBLIC_URL`, `KYOUBE_DEPLOYMENT_EXPOSURE`, `KYOUBE_CORE_VERSION` replace
  `PAPERCLIP_PUBLIC_URL`, `PAPERCLIP_DEPLOYMENT_EXPOSURE`, `PAPERCLIP_VERSION`. The old names still
  work in this release (compose falls back to them; `kyoube doctor` says which are in use) and are
  removed in the next.
- **Backups** now contain `kyoubeai.dump` and `kyoubeai-home.tgz`; `scripts/restore.sh` also reads
  0.1.x backups. `scripts/bump-paperclip.sh` is `scripts/bump-core.sh`.
- Upgrading from 0.1.x: `docs/upgrading.md` → "Upgrading from 0.1.x". `kyoube.terminal` is 0.2.3,
  `kyoube.apps` 0.4.2.
```

`package.json` description: `"Multi-user AI operating system for organisations"`.

`docs/superpowers/plans/README.md`: add a row `| 5 | [White-label](2026-09-13-white-label.md) | Build-time brand transform, home/database rename, KYOUBE_* keys, 0.1.x migration, 0.2.0 | 0–4 |` and a sentence: "Plan 5 implements `../specs/2026-09-13-white-label-design.md`." The conventions line's "no patches to Paperclip" gains "(the build-time branding transform excepted)".

- [ ] **Step 5: Verify and commit**

Run the grep from Step 2 for the docs, and `grep -rn "bump-paperclip\|paperclip-home\|/paperclip/" README.md docs/*.md SECURITY.md CONTRIBUTING.md .env.example` → only the migration/compatibility-link explanations in `docs/upgrading.md`, `docs/branding.md` and `docs/operations.md` may mention the old paths.

```bash
git add README.md docs SECURITY.md CONTRIBUTING.md LICENSE CHANGELOG.md package.json
git commit -m "docs: KyoubeAI is the product; branding, attribution and the 0.2.0 changelog"
```

---

## Phase D — Migration for 0.1.x installs

### Task 14: `scripts/migrate-from-0.1.sh`

**Files:**
- Create: `scripts/migrate-from-0.1.sh`

**Interfaces:**
- Produces: `bash scripts/migrate-from-0.1.sh [--no-backup]` (migrate, idempotent) and `bash scripts/migrate-from-0.1.sh --check` (prints `N stored path(s) still start with /paperclip/ …`, changes nothing). Honours `COMPOSE_PROJECT_NAME` and `COMPOSE_ENV_FILES` (first file is the `.env` it rewrites). Log lines the smoke greps for: `renaming role paperclip -> kyoubeai`, `renaming database paperclip -> kyoubeai`, `copying <old> -> <new>`, `PAPERCLIP_PUBLIC_URL -> KYOUBE_PUBLIC_URL`, `N stored path(s) still start with /paperclip/`.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# One-off migration of a KyoubeAI 0.1.x deployment to 0.2.x:
#   - .env keys PAPERCLIP_PUBLIC_URL / PAPERCLIP_DEPLOYMENT_EXPOSURE / PAPERCLIP_VERSION -> KYOUBE_*
#   - Postgres role + database `paperclip` -> `kyoubeai`, renamed in place (the
#     bootstrap superuser cannot rename itself, so a temporary superuser does it)
#   - home volume <project>_paperclip-home -> <project>_kyoubeai-home (copied,
#     plus the marker that keeps /paperclip resolvable inside the container)
#   - the 0.2.x image built or pulled, the stack started, `kyoube doctor` run
#
#   bash scripts/migrate-from-0.1.sh [--no-backup]
#   bash scripts/migrate-from-0.1.sh --check      # count stored /paperclip/ paths; changes nothing
#
# Idempotent: every step checks its precondition and skips when already done, so
# an interrupted run is simply re-run. Plain `docker compose` throughout, so
# COMPOSE_PROJECT_NAME / COMPOSE_ENV_FILES select the stack (docs/operations.md).
# Take a backup with the 0.1.x checkout's scripts/backup.sh BEFORE `git pull`;
# this script also snapshots the whole cluster and the old volume, as a last resort.
set -euo pipefail
# Git Bash would rewrite `volume:/path` mount arguments into Windows paths.
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MODE=migrate
NO_BACKUP=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE=check ;;
    --no-backup) NO_BACKUP=1 ;;
    *) echo "usage: migrate-from-0.1.sh [--no-backup] [--check]" >&2; exit 2 ;;
  esac
done
TAR_IMAGE="${KYOUBE_BACKUP_IMAGE:-alpine:3.20}"
ENV_FILE="${COMPOSE_ENV_FILES%%,*}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
MARKER=".migrated-from-paperclip-home"

log() { echo "migrate: $*"; }

# The db container's unix socket trusts any local role, so each step connects as
# whichever role it needs. Output is trimmed; errors are fatal to the caller.
psql_q() { # user db sql -> stdout
  docker compose exec -T db psql -U "$1" -d "$2" -v ON_ERROR_STOP=1 -Atqc "$3" </dev/null | tr -d '\r'
}
role_exists() { [[ "$(psql_q "$1" postgres "select count(*) from pg_roles where rolname = '$2'" 2>/dev/null)" == "1" ]]; }
db_exists() { [[ "$(psql_q "$1" postgres "select count(*) from pg_database where datname = '$2'" 2>/dev/null)" == "1" ]]; }
# The superuser we can talk as right now: the new name after the rename, the old one before.
admin_role() {
  if role_exists kyoubeai kyoubeai; then echo kyoubeai
  elif role_exists paperclip paperclip; then echo paperclip
  else return 1
  fi
}

# Rows whose absolute path still starts with /paperclip/: every `cwd` column in
# the core database (execution/project workspaces, operations, runtime services)
# plus agents' adapter configs. Generic over the schema so a core bump that adds
# a table needs no change here.
count_legacy_paths() {
  local admin db
  admin="$(admin_role)" || { echo "migrate: neither a kyoubeai nor a paperclip role — is the db service up?" >&2; return 1; }
  db=kyoubeai; db_exists "$admin" kyoubeai || db=paperclip
  docker compose exec -T db psql -U "$admin" -d "$db" -v ON_ERROR_STOP=1 -Atq -f - <<'SQL' 2>&1 | sed -n 's/.*legacy_paths=//p' | tr -d '\r'
DO $$
DECLARE r record; n bigint; total bigint := 0;
BEGIN
  FOR r IN SELECT table_name, column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'cwd' LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I LIKE %L', r.table_name, r.column_name, '/paperclip/%') INTO n;
    total := total + n;
  END LOOP;
  IF to_regclass('public.agents') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM agents WHERE adapter_config::text LIKE ''%/paperclip/%''' INTO n;
    total := total + n;
  END IF;
  RAISE NOTICE 'legacy_paths=%', total;
END $$;
SQL
}

command -v jq >/dev/null || { echo "migrate: jq is required" >&2; exit 1; }
docker compose up -d db >/dev/null

if [[ "$MODE" == "check" ]]; then
  n="$(count_legacy_paths)"
  log "$n stored path(s) still start with /paperclip/ (cwd columns and agents.adapter_config)"
  if [[ "$n" == "0" ]]; then
    log "safe to delete the marker: docker compose exec app rm -f /kyoubeai/$MARKER — the /paperclip link goes away at the next start"
  fi
  exit 0
fi

[[ -f "$ENV_FILE" ]] || { echo "migrate: $ENV_FILE not found" >&2; exit 1; }
PROJECT="$(docker compose config --format json | jq -r .name)"
OLD_VOL="${PROJECT}_paperclip-home"
NEW_VOL="${PROJECT}_kyoubeai-home"
ADMIN="$(admin_role)" || { echo "migrate: no superuser role found in the cluster" >&2; exit 1; }
log "project '$PROJECT', env file $ENV_FILE, cluster superuser '$ADMIN'"

# 1. Last-resort snapshot: the whole cluster as SQL and the old home volume.
if [[ "$NO_BACKUP" == "0" ]]; then
  SNAP="${BACKUP_DIR:-$ROOT/backups}/pre-0.2-migration-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$SNAP"
  log "snapshotting the cluster and the home volume to $SNAP"
  docker compose exec -T db pg_dumpall -U "$ADMIN" > "$SNAP/cluster.sql"
  if docker volume inspect "$OLD_VOL" >/dev/null 2>&1; then
    docker run --rm -v "$OLD_VOL:/from:ro" "$TAR_IMAGE" sh -c 'exec tar czf - -C /from .' > "$SNAP/paperclip-home.tgz"
  fi
fi

# 2. .env keys. Compose keeps accepting the old names this release, but the file
#    is the operator's, so rename them once and keep a copy.
changed=0
for pair in PAPERCLIP_PUBLIC_URL:KYOUBE_PUBLIC_URL PAPERCLIP_DEPLOYMENT_EXPOSURE:KYOUBE_DEPLOYMENT_EXPOSURE PAPERCLIP_VERSION:KYOUBE_CORE_VERSION; do
  old="${pair%%:*}"; new="${pair#*:}"
  if grep -q "^${old}=" "$ENV_FILE" && ! grep -q "^${new}=" "$ENV_FILE"; then
    [[ $changed -eq 1 ]] || cp "$ENV_FILE" "$ENV_FILE.bak"
    sed -i.tmp "s/^${old}=/${new}=/" "$ENV_FILE" && rm -f "$ENV_FILE.tmp"
    changed=1
    log "$ENV_FILE: $old -> $new"
  fi
done
if [[ $changed -eq 1 ]]; then log "previous env file kept as $ENV_FILE.bak"; else log "env keys already current"; fi

# 3. Stop the app: the database rename needs no open connections, the volume copy a quiet home.
docker compose stop app 2>/dev/null || true

# 4. Role, then database. `ALTER ROLE … RENAME` clears an MD5 password (the name
#    salts it) and keeps a SCRAM one; re-apply from the db container's own
#    POSTGRES_PASSWORD either way, so the value never passes through this script.
if role_exists paperclip paperclip && ! role_exists paperclip kyoubeai; then
  log "renaming role paperclip -> kyoubeai"
  psql_q paperclip postgres "CREATE ROLE kyoube_migrator LOGIN SUPERUSER" >/dev/null
  psql_q kyoube_migrator postgres "ALTER ROLE paperclip RENAME TO kyoubeai" >/dev/null
  docker compose exec -T db sh -c \
    ': "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set in the db container}"; exec psql -U kyoube_migrator -d postgres -q -v ON_ERROR_STOP=1 -v pw="$POSTGRES_PASSWORD" -f -' <<'SQL'
ALTER ROLE kyoubeai PASSWORD :'pw';
SQL
  psql_q kyoubeai postgres "DROP ROLE kyoube_migrator" >/dev/null
fi
ADMIN="$(admin_role)"
if db_exists "$ADMIN" paperclip && ! db_exists "$ADMIN" kyoubeai; then
  log "renaming database paperclip -> kyoubeai"
  psql_q "$ADMIN" postgres "ALTER DATABASE paperclip RENAME TO kyoubeai" >/dev/null
fi

# 5. The 0.2.x image, then the new volume — created by compose itself so it
#    carries compose's labels — then the copy, with the marker the entrypoint
#    and `kyoube doctor` look for.
if grep -q '^KYOUBE_IMAGE=' "$ENV_FILE"; then docker compose pull app; else docker compose build app; fi
docker compose up --no-start app >/dev/null
if docker volume inspect "$OLD_VOL" >/dev/null 2>&1; then
  NEW_COUNT="$(docker run --rm -v "$NEW_VOL:/to" "$TAR_IMAGE" sh -c 'ls -A /to | wc -l' | tr -d '\r ')"
  if [[ "$NEW_COUNT" == "0" ]]; then
    log "copying $OLD_VOL -> $NEW_VOL"
    docker run --rm -v "$OLD_VOL:/from:ro" -v "$NEW_VOL:/to" "$TAR_IMAGE" \
      sh -c "cp -a /from/. /to/ && touch /to/$MARKER && chown \"\$(stat -c %u:%g /to)\" /to/$MARKER"
  else
    log "$NEW_VOL already has content — not copying"
  fi
  # The core's instance config is ours to move; it is normally absent because
  # compose configures the core through the environment.
  docker run --rm -v "$NEW_VOL:/to" "$TAR_IMAGE" \
    sh -c 'f=/to/instances/default/config.json; if [ -f "$f" ]; then sed -i "s#/paperclip/#/kyoubeai/#g" "$f"; fi'
else
  log "no $OLD_VOL volume — nothing to copy"
fi

# 6. Start, wait, report.
docker compose up -d
APP_CID="$(docker compose ps -aq app | tr -d '\r' | head -1)"
log "waiting for the app to become healthy"
for i in $(seq 1 180); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$APP_CID" | tr -d '\r')" == "healthy" ]] && break
  sleep 2
  if [[ $i -eq 180 ]]; then echo "migrate: the app did not become healthy — docker compose logs app" >&2; exit 1; fi
done
docker compose exec -T app kyoube doctor || true
n="$(count_legacy_paths)"
log "done. $n stored path(s) still start with /paperclip/; the /paperclip compatibility link stays until you delete /kyoubeai/$MARKER (re-run with --check to see when that is safe)"
log "when satisfied, remove the old volume: docker volume rm $OLD_VOL"
```

- [ ] **Step 2: Shell-check by hand** — `bash -n scripts/migrate-from-0.1.sh` (syntax); `bash scripts/migrate-from-0.1.sh --bogus` exits 2 with the usage line; against the local smoke stack (`KEEP=1` from an earlier run) `COMPOSE_PROJECT_NAME=kyoube-smoke COMPOSE_ENV_FILES=scripts/smoke.env bash scripts/migrate-from-0.1.sh --check` prints `0 stored path(s) …`.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-from-0.1.sh
git commit -m "feat(ops): one-off migration from the 0.1.x layout"
```

---

### Task 15: Smoke rehearsal of the migration, and the upgrade guide

**Files:**
- Modify: `scripts/smoke.sh` (new final phase before `==> smoke passed`, plus cleanup), `docs/upgrading.md`

- [ ] **Step 1: Smoke phase** — insert before `echo "==> smoke passed"`:

```bash
echo "==> migration rehearsal: turn the stack into the 0.1.x layout, then migrate it"
# A 0.1.x install has the role/database `paperclip`, its home on
# <project>_paperclip-home and PAPERCLIP_* keys in .env. A real 0.1.x image is a
# cold build away, so the rehearsal makes that layout out of the running stack —
# the inverse of the migration, through the same temporary-superuser trick — and
# runs scripts/migrate-from-0.1.sh against it. That proves the rename, the
# volume copy, the marker, the entrypoint's compatibility link, the .env rewrite
# and --check, against a database with a real company, agents and plugins.
LEGACY_ENV="$TMP/legacy.env"
sed -e 's/^KYOUBE_PUBLIC_URL=/PAPERCLIP_PUBLIC_URL=/' -e 's/^KYOUBE_DEPLOYMENT_EXPOSURE=/PAPERCLIP_DEPLOYMENT_EXPOSURE=/' -e 's/^KYOUBE_CORE_VERSION=/PAPERCLIP_VERSION=/' "$ENV_FILE" > "$LEGACY_ENV"
grep -q '^PAPERCLIP_PUBLIC_URL=' "$LEGACY_ENV" || { echo "could not derive a legacy env file" >&2; exit 1; }
compose stop app
# One agent gets a 0.1.x-style absolute workspace path for --check to find.
compose exec -T db psql -U kyoubeai -d kyoubeai -v ON_ERROR_STOP=1 -Atqc \
  "update agents set adapter_config = adapter_config || '{\"cwd\":\"/paperclip/workspaces/legacy\"}'::jsonb where name = 'smoke-claude_local'" >/dev/null
compose exec -T db psql -U kyoubeai -d postgres -v ON_ERROR_STOP=1 -Atqc "CREATE ROLE kyoube_rehearsal LOGIN SUPERUSER" >/dev/null
compose exec -T db psql -U kyoube_rehearsal -d postgres -v ON_ERROR_STOP=1 -Atqc "ALTER ROLE kyoubeai RENAME TO paperclip; ALTER DATABASE kyoubeai RENAME TO paperclip" >/dev/null
compose exec -T db psql -U paperclip -d postgres -v ON_ERROR_STOP=1 -Atqc "DROP ROLE kyoube_rehearsal" >/dev/null
docker volume create "${PROJECT}_paperclip-home" >/dev/null
MSYS_NO_PATHCONV=1 docker run --rm -v "${PROJECT}_kyoubeai-home:/from" -v "${PROJECT}_paperclip-home:/to" alpine:3.20 \
  sh -c 'cp -a /from/. /to/ && rm -rf /from/..?* /from/.[!.]* /from/* 2>/dev/null; ls -A /from | wc -l' | tr -d '\r' | grep -qx 0 \
  || { echo "could not move the home volume into the 0.1.x layout" >&2; exit 1; }
COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_ENV_FILES="$LEGACY_ENV" bash "$ROOT/scripts/migrate-from-0.1.sh" --no-backup | tee "$TMP/migrate.log"
for LINE in 'PAPERCLIP_PUBLIC_URL -> KYOUBE_PUBLIC_URL' 'PAPERCLIP_VERSION -> KYOUBE_CORE_VERSION' 'renaming role paperclip -> kyoubeai' 'renaming database paperclip -> kyoubeai' "copying ${PROJECT}_paperclip-home -> ${PROJECT}_kyoubeai-home" '1 stored path(s) still start with /paperclip/'; do
  grep -qF "$LINE" "$TMP/migrate.log" || { echo "migration log lacks: $LINE" >&2; exit 1; }
done
grep -q '^KYOUBE_PUBLIC_URL=' "$LEGACY_ENV" && ! grep -q '^PAPERCLIP_PUBLIC_URL=' "$LEGACY_ENV" || { echo ".env keys were not renamed" >&2; exit 1; }
DBS="$(compose exec -T db psql -U kyoubeai -d postgres -Atc 'select datname from pg_database order by 1' | tr -d '\r')"
grep -qx kyoubeai <<<"$DBS" && ! grep -qx paperclip <<<"$DBS" || { echo "databases after migration: $DBS" >&2; exit 1; }
compose exec -T db psql -U kyoubeai -d postgres -Atc "select count(*) from pg_roles where rolname in ('paperclip','kyoube_migrator')" | tr -d '\r' | grep -qx 0 \
  || { echo "legacy or temporary roles survived the migration" >&2; exit 1; }
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins")"
[[ "$STATUS" == "200" ]] || { echo "the board token stopped working after the migration: $STATUS" >&2; exit 1; }
compose exec -T app sh -c 'test -f /kyoubeai/kyoube/board-key.json && test -f /kyoubeai/.migrated-from-paperclip-home && test -L /paperclip && test -f /paperclip/kyoube/board-key.json' \
  || { echo "home volume, marker or compatibility link missing after the migration" >&2; exit 1; }
compose exec -T app kyoube doctor | tee "$TMP/doctor-migrated.log"
grep -Eq '^ok +legacy home link .*compatibility link active' "$TMP/doctor-migrated.log" || { echo "doctor did not report the compatibility link" >&2; exit 1; }
grep -Eq '^ok +legacy env +none' "$TMP/doctor-migrated.log" || { echo "doctor still sees legacy env keys" >&2; exit 1; }
COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_ENV_FILES="$LEGACY_ENV" bash "$ROOT/scripts/migrate-from-0.1.sh" --check | grep -q '1 stored path' || { echo "--check did not count the legacy agent path" >&2; exit 1; }
compose exec -T db psql -U kyoubeai -d kyoubeai -v ON_ERROR_STOP=1 -Atqc \
  "update agents set adapter_config = adapter_config || '{\"cwd\":\"/kyoubeai/workspaces/smoke\"}'::jsonb where name = 'smoke-claude_local'" >/dev/null
COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_ENV_FILES="$LEGACY_ENV" bash "$ROOT/scripts/migrate-from-0.1.sh" --check | grep -q '0 stored path' || { echo "--check still counts a legacy path" >&2; exit 1; }
compose exec -T app rm -f /kyoubeai/.migrated-from-paperclip-home
compose restart app
for i in $(seq 1 180); do
  if curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
  if [[ $i -eq 180 ]]; then echo "the app did not come back after removing the marker" >&2; exit 1; fi
done
compose exec -T app sh -c 'test ! -e /paperclip' || { echo "/paperclip still exists after the marker was removed" >&2; exit 1; }
echo "    0.1.x layout migrated: role/database renamed, home copied with the marker, link present, then gone with the marker"
```

And in `cleanup()` add, before `rm -rf "$TMP"`: `if [[ "$KEEP" != "1" ]]; then docker volume rm -f "${PROJECT}_paperclip-home" >/dev/null 2>&1 || true; fi` (the rehearsal creates that volume outside compose, so `down -v` does not remove it).

- [ ] **Step 2: Run the smoke** — `KEEP=0 bash scripts/smoke.sh` (detached, watched). Expected: green end to end, including the new phase. If `docker compose up --no-start app` inside the migration complains that the app container's configuration changed, that is expected and harmless (it recreates the container); if it refuses, add `--force-recreate` there.

- [ ] **Step 3: `docs/upgrading.md`** — add after "## Upgrading KyoubeAI":

```markdown
## Upgrading from 0.1.x

0.2.0 renamed what the container and the database are called (see the CHANGELOG's *Breaking* list):
the home volume is `kyoubeai-home` mounted at `/kyoubeai`, the core role and database are `kyoubeai`,
and `.env` uses `KYOUBE_PUBLIC_URL`, `KYOUBE_DEPLOYMENT_EXPOSURE` and `KYOUBE_CORE_VERSION`. One script
moves an existing install across, and it is safe to re-run:

```bash
bash scripts/backup.sh                 # with the 0.1.x checkout, before pulling
git pull
bash scripts/migrate-from-0.1.sh       # stops app, renames the role/database, copies the home volume, starts 0.2.x
docker compose exec app kyoube doctor
```

What it does, in order: snapshots the cluster and the old volume under `backups/pre-0.2-migration-…`
(skip with `--no-backup`); renames the three keys in `.env` (a `.env.bak` is kept); stops `app`;
renames the Postgres role and database in place through a temporary superuser; builds or pulls the
0.2.x image; lets compose create `kyoubeai-home` and copies `paperclip-home` into it; starts the
stack and runs `kyoube doctor`.

**The compatibility link.** A 0.1.x database can hold absolute `/paperclip/…` paths — agents'
workspace directories, execution workspaces — and so can harness state on the volume. The script
leaves a marker (`/kyoubeai/.migrated-from-paperclip-home`); while it exists the entrypoint keeps
`/paperclip` as a symlink to `/kyoubeai`, so those paths keep working. `bash scripts/migrate-from-0.1.sh --check`
counts what still points at the old path; when it says `0`, delete the marker
(`docker compose exec app rm -f /kyoubeai/.migrated-from-paperclip-home`) and the link is gone at the
next start. `kyoube doctor` reports the link under `legacy home link` until then.

**The old volume** (`<project>_paperclip-home`) is left in place; remove it with `docker volume rm`
once you are satisfied. A 0.1.x backup still restores with `scripts/restore.sh`: it recognises the old
file names, restores into the new layout and leaves the marker for you.

**Rolling back to 0.1.x** is a restore of the pre-upgrade backup on the 0.1.x checkout, as in
[Rolling back](#rolling-back); the renamed cluster is not usable by a 0.1.x image.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke.sh docs/upgrading.md
git commit -m "test(smoke): rehearse the 0.1.x migration; document upgrading from 0.1.x"
```

---

## Phase E — Acceptance

### Task 16: Full verification and the residual record

**Files:**
- Modify: `docs/branding.md` (append "Residual identifiers on core 2026.831.1"), `docs/superpowers/plans/2026-09-13-white-label.md` (post-execution notes blockquote at the top)

- [ ] **Step 1: Unit, typecheck, build, browser checks**

Run: `pnpm typecheck && pnpm test && pnpm build && node scripts/browser-check.mjs && node scripts/terminal-fit-check.mjs && node scripts/app-frame-check.mjs && bash scripts/check-pins.sh`
Expected: all green; record the unit totals per package in the notes.

- [ ] **Step 2: Full smoke, kept up** — `KEEP=1 bash scripts/smoke.sh` detached; wait for `==> smoke passed`. Then `node scripts/brand-live-check.mjs http://localhost:3199` again by hand and open `http://localhost:3199/auth` in Chrome: the lockup shows the "K" mark and the wordmark, the tab reads KyoubeAI, the favicon is the "K".

- [ ] **Step 3: Live pages beyond sign-in** — with the smoke stack still up, sign in as `smoke@kyoube.local` / `smoke-password-123` in a browser (or drive Chrome over CDP as in the 2026-09-13 app-frame check) and read the dashboard, a company's Agents page, one agent's Configuration and Skills tabs, Settings → Plugins, the Terminal page and the Apps page. Search each page's visible text for "Paperclip". Expected: none, except the Skills library's *key* column (`paperclipai/paperclip/paperclip`, `paperclip-board`) — a documented residual. Anything else is a bug: find the string in the built image (`docker run --rm --entrypoint sh kyoubeai:smoke -c 'grep -rl "<the text>" /app/ui/dist /app/server/dist'`) and decide whether it is a display string the rule missed (add a phrase override in `brand.json`, add the case to `text-rules.spec.mjs`) or a stored row.

- [ ] **Step 4: Agent-facing text** — from the Terminal page (or `docker compose -p kyoube-smoke exec app sh`): `grep -rn "KyoubeAI" /app/skills/paperclip/SKILL.md | head -3` shows the rebranded skill; `grep -c "Paperclip" /app/skills/paperclip/SKILL.md` prints `0`; `grep -o "KyoubeAI task context" /app/server/dist/services/heartbeat.js | head -1` prints the prompt fragment. A real heartbeat run that shows "KyoubeAI task context:" in its transcript needs a provider key and is the user's manual acceptance item (record it in the notes).

- [ ] **Step 5: Real 0.1.x → 0.2.0 rehearsal** — the local image `kyoubeai:v012` (built from v0.1.2) plus the v0.1.5 checkout's compose file stand in for a 0.1.x deployment:

```bash
git worktree add "$SCRATCH/kyoube-0.1" 30e6e42
cp .env "$SCRATCH/kyoube-0.1/.env"     # then edit: PAPERCLIP_PUBLIC_URL=http://localhost:3198, KYOUBE_PORT=3198, BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:3198, KYOUBE_IMAGE=kyoubeai, KYOUBE_VERSION=v012
(cd "$SCRATCH/kyoube-0.1" && docker compose -p kyoube-mig up -d)      # no build: the prebuilt image
# sign up + claim + create a company the way scripts/smoke.sh does, against :3198
COMPOSE_PROJECT_NAME=kyoube-mig COMPOSE_ENV_FILES="$SCRATCH/kyoube-0.1/.env" bash scripts/migrate-from-0.1.sh
```
Expected: the script renames, copies, builds `kyoubeai:v012`?? — no: `KYOUBE_IMAGE=kyoubeai KYOUBE_VERSION=v012` in that `.env` makes `docker compose build app` rebuild the tag `kyoubeai:v012` from the **new** Dockerfile (the image name is only a tag). That is what we want for the rehearsal (the 0.2.0 build replaces the 0.1.2 tag locally; re-tag the old image first if you want to keep it: `docker tag kyoubeai:v012 kyoubeai:v012-pre-rebrand`). Afterwards: sign in at `http://localhost:3198/auth` with the account created before the migration, see the company, run `docker compose -p kyoube-mig exec app kyoube doctor` (plugins upgraded to 0.2.3/0.4.2 by the watcher, `legacy home link` active), `--check` reports the agent path count if an agent was created with a `/paperclip/...` cwd. Tear down: `docker compose -p kyoube-mig down -v && docker volume rm kyoube-mig_paperclip-home && git worktree remove "$SCRATCH/kyoube-0.1"`.

- [ ] **Step 6: Residual record** — from the Task 6 build log (`rebrand:` lines) and `docker run --rm --entrypoint sh kyoubeai:smoke -c 'grep -ohE ".{0,25}[^A-Za-z]paperclip[^A-Za-z].{0,25}" /app/ui/dist/assets/index-*.js | sort | uniq -c | sort -rn | head -30'`, append to `docs/branding.md`:

```markdown
## Residual identifiers on core 2026.831.1

Verified after the build on 2026-09-13 (the build log's `rebrand:` lines and a grep of the served bundle).
Everything below is an identifier, kept by design — see the table above.

- camelCase identifiers: `managedByPaperclip`, `minimumPaperclipVersion`, `paperclipSelfOnly`
- headers: `X-Paperclip-Run-Id`, `X-Paperclip-Route`, `x-paperclip-advanced`
- keys and enum values: `paperclipai/paperclip/…` skill keys, `paperclip_runner`, `paperclip_managed`, `paperclip_plugin`
- storage and CSS: `paperclip:*` / `paperclip.*` localStorage keys, `.paperclip-*` classes, `--paperclip-*` CSS variables
- hosts left alone: `telemetry.paperclip.ing`, `pages.paperclip.ing`, `paperclip.invalid`
```
(Replace the list with what the grep actually shows.)

- [ ] **Step 7: Post-execution notes** — add the `> **Post-execution notes (date).**` blockquote under the plan header, in the style of the earlier plans: unit counts, smoke duration, the real-rehearsal outcome, any ruling that deviated from a snippet above, and the manual acceptance items owed (a real heartbeat transcript; the user's own deployment migration). Update the project memory file with the same facts.

- [ ] **Step 8: Tear down** — `docker compose -p kyoube-smoke --env-file scripts/smoke.env -f docker-compose.yml down -v --remove-orphans && docker volume rm -f kyoube-smoke_paperclip-home`.

- [ ] **Step 9: Commit**

```bash
git add docs/branding.md docs/superpowers/plans/2026-09-13-white-label.md
git commit -m "docs: white-label acceptance notes and residual identifier record"
```

The release itself (`0.2.0` tag, `package.json` version, GHCR publish) is the user's call, as before.
