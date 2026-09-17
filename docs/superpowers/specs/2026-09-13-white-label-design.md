# KyoubeAI — White-label design

**Status:** draft for review · **Date:** 2026-09-13 · **Scope:** architectural (a permanent branding layer on the image, a home-directory and database rename, and the migration for 0.1.x installs)

KyoubeAI ships on top of the upstream Paperclip image without forking it. Today the product still says "Paperclip" everywhere upstream says it: the browser tab, the sign-in page, hundreds of UI strings, the agents' own prompts and skills, API error messages, the PWA manifest, the favicon, the container's home directory and the Postgres database name. This design removes every trace a user, an agent or an operator can see, and does it in a way that is **re-applied automatically on every image build**, so a core (upstream) bump keeps KyoubeAI branded without anyone touching the rename again.

---

## 0. Verdict

Upstream has no product-name hook. Its `PAPERCLIP_RUNTIME_BRANDING` markers in `index.html` only carry worktree-preview meta tags (`server/src/ui-branding.ts`). The name is hard-coded in display strings, prompt text, a path-drawn SVG lockup and static icon files. So the rename cannot be configured; it has to be **applied as a transform**.

The survey of the 2026.831.1 image gives the transform a clean contract:

| Surface | What carries the name | Shape |
|---|---|---|
| Compiled UI (`/app/ui/dist/assets/*.js`) | ~560 display strings, one lockup SVG (paths), one animated icon path, links to paperclip.ing | Capitalised `Paperclip` is display text; lowercase `paperclip` is identifiers (localStorage keys, CSS classes, enum values, package names) |
| `index.html`, `site.webmanifest`, favicons, `paperclip-thinking.svg` | title, PWA name, icons | Static files |
| Server (`/app/server/dist/**/*.js`, `/app/packages/*/dist`) | error messages, agent prompt fragments ("Paperclip task context:"), built-in agent instructions, adapter labels | Same capitalisation split |
| Built-in skills (`/app/skills`, `/app/skills-releases`, `/app/packages/skills-catalog`) | markdown agents read every heartbeat | Text; skill **keys** stay lowercase slugs |
| Container | `HOME=/paperclip`, `PAPERCLIP_HOME`, `PAPERCLIP_CONFIG`, node user's passwd home | Env + one directory |
| Compose | Postgres role/database `paperclip`, volume `paperclip-home`, `PAPERCLIP_*` `.env` keys | Ours to change |
| Our repo | README, docs, CLI output, plugin UI text, skills, scripts | Ours to change |

Two facts make the transform safe to automate: DB migrations seed no "Paperclip" rows (nothing SQL needs touching), and every display string lives inside a JS string literal, where replacing text of a different length can never break syntax. The `/assets` directory is served with a one-year immutable cache, so rebranded bundles must also get **new file names**.

The alternative approaches were rejected: forking upstream and building from source with a brand constant reverses the no-fork decision and turns every upstream release into a merge; a runtime DOM-rewriting plugin cannot reach the server, the prompts, the title or the agents' wording.

---

## 1. Goals, non-goals and deliberate exceptions

**Goals**

1. No user-, agent- or operator-visible "Paperclip" in a running KyoubeAI: web UI, title, favicon/PWA, logo, API messages, agent prompts and skills, `kyoube` CLI output, docs, `.env` keys, container home path, database and volume names.
2. The rename survives core upgrades by construction: it runs inside `docker/Dockerfile` on every build, with generic rules, and **fails the build** when an upstream change slips past them.
3. The brand is data, not code: name, URLs and artwork live in one directory (`docker/brand/`) so a later logo or name change is a file swap and a rebuild.
4. Existing 0.1.x installs migrate with one documented script and keep their data (secrets master key, harness logins, workspaces, both databases).

**Non-goals**

- Renaming identifiers that are part of upstream's contract with agents and tooling (see exceptions).
- Rewriting rows already stored in a pre-rebrand database (old comments, run logs, agents' saved instructions). Documented as a known residual.
- Rewriting the engineering history under `docs/superpowers/` (user decision 2026-09-13: leave as history).

**Deliberate exceptions (documented in `docs/branding.md`)**

| Kept as-is | Why |
|---|---|
| `PAPERCLIP_*` environment variable names inside the container (`PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_HOME`, …) | Upstream's adapters, CLI, MCP server and skills read them; renaming would break every agent run. The operator never sets them: compose maps `KYOUBE_*` keys onto them. |
| Skill keys and slugs (`paperclipai/paperclip/paperclip`, `paperclip-board`), enum values (`paperclip_runner`, `paperclip_managed`), CSS classes, localStorage keys, package names, the `X-Paperclip-Run-Id` header | Lookup keys, not display text. Their labels are rebranded; the keys are visible only in URLs, API JSON and the skill library's key column. |
| The lucide paperclip glyph | A generic "attachment" icon used in 22 places; the brand instances (favicon, lockup, loading animation) are replaced. |
| `FROM ghcr.io/paperclipai/paperclip:<version>` in `docker/Dockerfile`, `renovate.json`, `scripts/bump-core.sh` | Build inputs, not product surface. |
| The LICENSE attribution | MIT requires retaining upstream's copyright notice. One README credit line accompanies it (user decision). |
| `telemetry.paperclip.ing` endpoints | Disabled by default (`DO_NOT_TRACK=1`); rewriting them to a host we do not run would only turn silence into errors if telemetry were ever enabled. |

---

## 2. Architecture

```
docker/brand/              the brand kit (data)          ─┐
  brand.json                name, description, URLs        │  COPY into the image
  mark.svg lockup.svg       artwork (placeholder)          │
  icons/*.png *.ico         pre-rendered from mark.svg    ─┘
                                        │
docker/Dockerfile   FROM upstream:<v> ──┼──> RUN gosu node node /opt/kyoube/rebrand/rebrand.mjs --verify
                                        │      1. rewrite text in the served/prompt surfaces
docker/rebrand/rebrand.mjs (transform) ─┘      2. swap static artwork, regenerate the manifest
                                               3. replace the lockup and loading-icon SVG in the bundle
                                               4. re-hash /assets file names, fix every reference
                                               5. verify: zero residual matches, every anchor hit once
                                               → non-zero exit fails `docker build`
ENV HOME=/kyoubeai PAPERCLIP_HOME=/kyoubeai …   the home relocation (Dockerfile + entrypoint)
docker-compose.yml   kyoubeai role/db, kyoubeai-home volume, KYOUBE_* keys → PAPERCLIP_* env
scripts/migrate-from-0.1.sh   one-off: rename DB objects, copy the home volume, rewrite .env keys
```

Everything above the line "the home relocation" runs on the pristine upstream layer at every build, so the input is always unbranded and the output always branded; there is no incremental state to drift.

---

## 3. Component A — the brand kit (`docker/brand/`)

`brand.json` (the only file a future rename edits):

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

- `phrases` are exact-string overrides applied **before** the generic rule, for the few lowercase display contexts the survey found (an input placeholder; the adapter log prefix that the UI transcript parser and the adapters both use, so both sides change together). The list is expected to stay short; anything added here is a conscious choice.
- `mark.svg`: the icon, **one stroked path** (placeholder: a geometric "K" polyline), no fill, `stroke="currentColor"`. One path is a requirement, not taste: the loading animation draws the brand path with `stroke-dasharray`, and the favicon and the animated icon must be the same geometry.
- `lockup.svg`: the mark plus the wordmark. The wordmark is an SVG `<text>` element in Inter 600 (the UI already loads InterVariable), so no glyph outlines are needed for the placeholder; a real logo can later replace it with paths.
- `icons/`: `favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png` (180), `android-chrome-192x192.png`, `android-chrome-512x512.png`, rendered from `mark.svg` by `scripts/render-brand-icons.mjs` (dev-time, `@resvg/resvg-js` devDependency; the ICO is a PNG-in-ICO container written by the same script). Committed, so the image build needs no rasteriser.
- `thinking.svg`: the standalone animated icon (`<img src>` in Board Chat), generated from `mark.svg` by the same script with the upstream keyframes and `pathLength="85.717"` (see B.3).

---

## 4. Component B — the build-time transform (`docker/rebrand/rebrand.mjs`)

Plain Node ESM, no dependencies (the image has Node 24). Runs as the `node` user (the files are node-owned; no chown afterwards). CLI: `rebrand.mjs --root /app --brand /opt/kyoube/brand [--verify] [--report]`. Exit 0 only when every step and every check passed.

### B.1 File set

Text files only, by extension, under these roots (never `node_modules`, never `*/bin/*`):

| Root | Extensions | Why |
|---|---|---|
| `ui/dist/**` | `.js .css .html .webmanifest .json .svg .map .txt .md` | Everything the browser loads |
| `server/dist/**` | `.js .mjs .cjs .json .md` | Messages, prompts, OpenAPI title, startup banner (`vendor/paperclip-runner/bin/*` is a native binary and is skipped) |
| `packages/**/dist/**` | `.js .mjs .cjs .json` | Shared labels, adapter prompt text and log prefixes |
| `skills/**`, `skills-releases/**`, `packages/skills-catalog/**`, `.agents/**` | `.md .json .yaml .yml` | Text agents read |
| `cli/dist/**` | `.js .mjs .cjs` | CLI text (the `paperclipai` bin name is an identifier and stays) |
| `*.md`, `doc/**`, `docs/**` | `.md` | Shipped docs |

Binary detection is by extension plus a NUL-byte sniff; a sniffed binary under a text extension is skipped and reported.

### B.2 Text rules (applied in this order to every file)

1. **Phrase overrides** from `brand.json.phrases`, exact match.
2. **URL map**: `https://docs.paperclip.ing/…` → `urls.docs`; `https://paperclip.ing/feedback` → `urls.feedback`; `https://paperclip.ing/tos` → `urls.tos`; `https://paperclip.ing/ee` and bare `https://paperclip.ing` (when followed by a quote, backtick, `)` or whitespace) → `urls.home`; `https://github.com/paperclipai/paperclip…` → `urls.repo` (deep links collapse to the repo root; they only appear in skill-source metadata and the Node-version guide). `paperclip.invalid` (a dummy base for URL parsing), `pages.paperclip.ing` and `telemetry.paperclip.ing` are left alone.
3. **The generic name rule**, case-sensitive: replace `Paperclip` with `brand.name` when it is not preceded by `[A-Za-z0-9_$-]` and not followed by `[A-Za-z0-9_$]`. This is what makes the pass survive upstream changes without maintenance:
   - matches: `"Paperclip"`, `Paperclip's`, `Paperclip-managed`, `Welcome to Paperclip`, `**Paperclip**`, `[Paperclip](…)`, `"Paperclip task context:"`
   - does not match: `managedByPaperclip`, `minimumPaperclipVersion`, `PaperclipLockup`, `readPaperclipSkillSyncPreference` (letter before or after), `X-Paperclip-Run-Id` (hyphen before), `PAPERCLIP_API_URL` and `$PAPERCLIP_RUN_ID` (case), `paperclipai/paperclip/paperclip`, `paperclip_managed`, `paperclip:inbox:filters` (lowercase).
   The rule is symmetric across the server and the UI, so a message the server produces and a regex the UI matches it with change together (e.g. the `^Paperclip exhausted the bounded successful-run handoff…` guard).
4. Nothing else is touched. Lowercase `paperclip` outside the phrase and URL maps is an identifier by definition; the report lists its remaining contexts for review after a bump.

### B.3 Artwork

- Overwrite `ui/dist/{favicon.ico,favicon.svg,favicon-16x16.png,favicon-32x32.png,apple-touch-icon.png,android-chrome-192x192.png,android-chrome-512x512.png,worktree-favicon*.{ico,svg,png}}` from the kit; `favicon.svg` keeps upstream's light/dark `prefers-color-scheme` stroke style around our path.
- Rename `paperclip-thinking.svg` → `kyoubeai-thinking.svg` (kit `thinking.svg`) and map the reference `/paperclip-thinking.svg` → `/kyoubeai-thinking.svg` (a phrase override the script adds itself).
- Regenerate `site.webmanifest` from `brand.json` (`name`, `short_name`, `description`, colours; icon entries unchanged).
- `index.html`: the `<title>` and `apple-mobile-web-app-title` fall to the generic rule; the `theme-color` meta stays upstream's (our `themeColor` matches it today).
- **Lockup**: anchor on `viewBox:"22.5 22.5 121 27"` inside the main bundle. The match is the minified `("svg",{...r,className:n,viewBox:"22.5 22.5 121 27",fill:"currentColor",role:…,"aria-hidden":…,"aria-label":…,focusable:"false",children:[ …10 × ("path",{d:"…"}) ]})`. The script replaces the `viewBox` value and the whole `children:[…]` array, emitting the kit's mark path and a `("text",{…children:"KyoubeAI"})` element through the same JSX helper identifier it captured from the match (e.g. `s.jsx`). Exactly one match is required.
- **Loading icon**: anchor on `className:"paperclip-thinking-icon-path",d:"…"`; replace the `d` value with the mark path and add `pathLength:"85.717"`. Upstream's CSS keyframes draw `stroke-dasharray` up to 85.717 (the paperclip's length); `pathLength` normalises any path to that number, so the animation is untouched. Exactly one match is required.
- The lucide paperclip glyph elsewhere and the server's worktree favicon data URL (worktree previews only) are left alone.

### B.4 Asset re-hashing

`/assets` is served `maxAge: 1y, immutable`. A browser that loaded an unbranded `index-BHbrFFmp.js` from a 0.1.x install would keep it for a year if the branded file kept the name. So every file in `ui/dist/assets/` is renamed `name-<upstreamHash>.ext` → `name-<upstreamHash>-<8 hex>.ext`, where the hex is SHA-256 of the file's **rebranded content before reference rewriting** plus the brand-kit hash (deterministic, no cascade). Then every text file in `ui/dist` (html, js, css, map) has each old basename replaced by its new one; `.map` files follow their `.js`. A file whose content did not change is renamed too, so the set is uniform and the mapping is one pass. The rewrite is the same on every build of the same inputs, so image layers stay reproducible.

### B.5 Verification (`--verify`, always on in the Dockerfile)

Fails the build (non-zero exit, message naming the file and context) when:

1. the generic rule still matches anywhere in the file set after rewriting (i.e. re-running the pass would change something);
2. the lockup or loading-icon anchor matched zero or more than one time;
3. `index.html` no longer contains `<title>KyoubeAI</title>`, or the manifest name differs from `brand.name`;
4. any `/assets/` reference in `index.html` or a chunk points at a file that does not exist after renaming;
5. any file it rewrote is not valid UTF-8 round-trip (guards against a binary sneaking in under a text extension).

`--report` prints per-rule counts and the remaining lowercase `paperclip` contexts (top 40 by frequency). The Dockerfile keeps the report in the build log.

**What happens on a core bump.** New display strings are covered by the generic rule. A new camelCase identifier is excluded by the rule's boundaries. A new mixed-case identifier that starts a token (a hypothetical `Paperclip_thing`) would be replaced and, being an identifier, would most likely break at runtime — this is why the smoke test and the browser check run after every build (see §8). A moved lockup or icon breaks the anchor and the build says so. That is the intended failure mode: loud, at build time, never a silently unbranded release.

---

## 5. Component C — home relocation and database rename

**Home directory.** In `docker/Dockerfile`, after the upstream `FROM`:

```dockerfile
ENV HOME=/kyoubeai PAPERCLIP_HOME=/kyoubeai \
    PAPERCLIP_CONFIG=/kyoubeai/instances/default/config.json \
    HERMES_HOME=/kyoubeai/.hermes
RUN mkdir -p /kyoubeai && chown node:node /kyoubeai && usermod -d /kyoubeai node && rmdir /paperclip
```

Upstream resolves everything from `PAPERCLIP_HOME` (`packages/shared/src/home-paths.ts`) and its `docker-entrypoint.sh` chowns `${PAPERCLIP_HOME:-/paperclip}`, so no upstream file is patched. Every `test -z "$(ls -A /paperclip)"` assertion in our Dockerfile becomes `/kyoubeai`. `docker/entrypoint.sh` defaults `home_dir` to `/kyoubeai`; the bootstrap `config.ts`, both plugins' `DEFAULT_KYOUBE_CONFIG_PATH` and the Terminal page's hints move to `/kyoubeai/…`. `docker-compose.yml` mounts `kyoubeai-home:/kyoubeai`.

**Compatibility link for migrated installs only.** Upstream persists absolute paths in `cwd` columns (`execution_workspaces`, `project_workspaces`, `workspace_operations`, `workspace_runtime_services`), in agents' adapter configs, and harness state (`~/.claude.json`, Hermes config) may hold them too. Rewriting those blindly is unsafe, so `docker/entrypoint.sh` (running as root before dropping privileges) creates `ln -sfn /kyoubeai /paperclip` **only when** `/kyoubeai/.migrated-from-paperclip-home` exists — the marker the migration script writes. Fresh installs never have the link. `kyoube doctor` reports how many stored paths still start with `/paperclip/` (the four `cwd` columns plus `agents.adapter_config->>'cwd'`); when that is zero the operator may delete the marker and the link disappears at the next start.

**Database.** Compose: `POSTGRES_USER: kyoubeai`, `POSTGRES_DB: kyoubeai`, `DATABASE_URL: postgres://kyoubeai:…@db:5432/kyoubeai`, healthcheck `-U kyoubeai -d kyoubeai`. `docker/postgres-init/01-kyoube.sh` revokes on `$POSTGRES_DB` instead of the literal. The `kyoube` organisation database, its roles and the `KYOUBE_*` variables are unchanged. `scripts/backup.sh` writes `kyoubeai.dump` and `kyoubeai-home.tgz`; `scripts/restore.sh` accepts both the new names and the 0.1.x names (`paperclip.dump`, `paperclip-home.tgz`), restoring into the new database.

---

## 6. Component D — our own repository

| Area | Change |
|---|---|
| `.env.example`, `docker-compose.yml` | Operator keys become `KYOUBE_PUBLIC_URL`, `KYOUBE_DEPLOYMENT_EXPOSURE`, `KYOUBE_CORE_VERSION` (was `PAPERCLIP_VERSION`). Compose maps them onto the upstream env names with nested defaults, e.g. `PAPERCLIP_PUBLIC_URL: ${KYOUBE_PUBLIC_URL:-${PAPERCLIP_PUBLIC_URL:-http://localhost:3100}}` (verified to work on Compose v5.3.1), so a 0.1.x `.env` keeps working for one release. The container cannot see which `.env` key supplied a value, so compose also passes `KYOUBE_LEGACY_ENV_KEYS: "${PAPERCLIP_PUBLIC_URL:+PAPERCLIP_PUBLIC_URL }${PAPERCLIP_DEPLOYMENT_EXPOSURE:+PAPERCLIP_DEPLOYMENT_EXPOSURE }${PAPERCLIP_VERSION:+PAPERCLIP_VERSION}"` and the doctor's `legacy-env` check names the keys still in use. `BETTER_AUTH_*` and `POSTGRES_PASSWORD` stay (not Paperclip names). |
| `docker/Dockerfile` | `ARG KYOUBE_CORE_VERSION` (was `PAPERCLIP_VERSION`); the rebrand stage; the home relocation; comments. |
| `scripts/bump-paperclip.sh` → `scripts/bump-core.sh`, `scripts/check-pins.sh`, `scripts/smoke.sh`, `scripts/smoke.env`, `renovate.json`, `.github/workflows/*.yml` | Follow the renamed ARG/key; Renovate's regex manager matches `KYOUBE_CORE_VERSION`; descriptions say "core image". The upstream image name itself stays. |
| `docker/bootstrap` (the `kyoube` CLI) | Every printed string ("Paperclip is healthy", "…installed by Paperclip") says KyoubeAI or "the core". `paperclip-api.ts` → `core-api.ts` (`CoreClient`, `CoreApiError`); tests follow. New `doctor` checks: `legacy-env`, `legacy-db` (role/database `paperclip` still present), `legacy-paths` (count above). |
| Plugins | Terminal page hints (`/kyoubeai/.claude`, `/kyoubeai/.hermes`), sidebar/aria text, the two managed skills (`kyoube-data.md`, `kyoube-apps.md`: "the KyoubeAI API"; env var names unchanged), comments. Versions: `kyoube.terminal` 0.2.3, `kyoube.apps` 0.4.2 (smoke expectations follow). |
| Docs | `README.md`, `docs/{architecture,operations,governance,upgrading,apps}.md`, `SECURITY.md`, `CONTRIBUTING.md`: KyoubeAI is the product; where the upstream engine must be named for an operator (upgrading the core, the `FROM` line, the license) it is "the core (Paperclip)". New `docs/branding.md`: how the transform works, the exceptions table, how to swap the artwork, how to read the build report after a bump. README gains one credit line under a "Built on" heading. `docs/superpowers/**` untouched. |
| `LICENSE` | The addendum's "are not modified by this project" becomes a true statement: the image is consumed as published and, at build time, a branding transform rewrites its user-facing text and artwork (`docker/rebrand/`); no other modification. Copyright notice retained. |
| `CHANGELOG.md` | Unreleased → **Breaking**: home path, database/role/volume names, `.env` keys, backup file names; the migration script; the rebrand. Past entries stay as written. |
| `package.json` | description: "Multi-user AI operating system for organisations". |

---

## 7. Migration for 0.1.x installs — `scripts/migrate-from-0.1.sh`

Run once, from the repo root, after `git pull`, before the first `docker compose up` of this release. Idempotent: every step checks its own precondition and skips when already done. Requires the `db` service up (it starts it) and stops `app` for the duration.

1. `bash scripts/backup.sh` unless `--no-backup`.
2. `docker compose stop app`.
3. **`.env` keys**: `PAPERCLIP_PUBLIC_URL` → `KYOUBE_PUBLIC_URL`, `PAPERCLIP_DEPLOYMENT_EXPOSURE` → `KYOUBE_DEPLOYMENT_EXPOSURE`, `PAPERCLIP_VERSION` → `KYOUBE_CORE_VERSION` (in place, keeping values and comments; a `.env.bak` is written).
4. **Database rename** through `docker compose exec -T db psql`:
   - as `paperclip` on `postgres`: `CREATE ROLE kyoubeai LOGIN SUPERUSER PASSWORD :'pw'` if absent (same `POSTGRES_PASSWORD`);
   - as `kyoubeai` on `postgres`: `ALTER DATABASE paperclip RENAME TO kyoubeai` if `paperclip` exists (no connections: `app` is stopped);
   - in `kyoubeai`, `kyoube` and `postgres`: `REASSIGN OWNED BY paperclip TO kyoubeai; DROP OWNED BY paperclip;`
   - `DROP ROLE paperclip`.
   A role cannot rename itself, which is why the new superuser is created first and does the work.
5. **Home volume**: resolve the project name (`docker compose config --format json | jq -r .name`); if `<project>_kyoubeai-home` is empty and `<project>_paperclip-home` is not, copy with a throw-away Alpine container (`cp -a /from/. /to/`), preserving ownership and modes, then `touch /to/.migrated-from-paperclip-home`. If `/kyoubeai/instances/default/config.json` exists, `/paperclip/` inside it is rewritten to `/kyoubeai/` (it is ours to move; it is normally absent because compose configures the core through env).
6. `docker compose up -d --build`, wait for health, `docker compose exec app kyoube doctor`. The doctor's `legacy-paths` line tells the operator whether the compatibility link is still load-bearing.
7. Prints what to delete once satisfied: `docker volume rm <project>_paperclip-home`.

Rollback: `bash scripts/restore.sh <backup dir>` on the previous release's checkout (restore.sh in this release also understands the old file names, so a 0.1.x backup restores into a 0.2.x stack).

---

## 8. Testing and verification

| Level | What | Where |
|---|---|---|
| Unit (vitest, TDD) | The text rules on fixture strings (every "matches / does not match" line in B.2 is a test); the URL map; the manifest generator; the asset rename mapping and reference rewrite on a synthetic `dist/`; the lockup and icon anchor replacement on a captured minified snippet; verify-mode failures (residual match, zero/multiple anchors, dangling reference) | `docker/rebrand/tests/*.spec.ts` (new workspace package `@kyoube/rebrand`, so `pnpm test` runs it) |
| Unit | bootstrap `config.ts` defaults, doctor checks, `.env` key migration function, restore name fallback | `docker/bootstrap/tests` |
| Unit | plugin config path defaults, Terminal hints text | plugin test suites |
| Build | `rebrand.mjs --verify` inside `docker build`; the Dockerfile also greps the rebranded `index.html` for the title and asserts `kyoubeai-thinking.svg` exists | `docker/Dockerfile` |
| Browser | `scripts/browser-check.mjs` gains: `document.title` is `KyoubeAI`, the sign-in page's text contains no `Paperclip`, the lockup renders (`svg[aria-label="KyoubeAI"]`), the favicon link resolves 200 | CI |
| Smoke | `scripts/smoke.sh` asserts: `/` title, `/site.webmanifest` name, `/kyoubeai-thinking.svg` 200, `/paperclip-thinking.svg` 404, `HOME=/kyoubeai` inside `app`, Postgres database list contains `kyoubeai` and not `paperclip`, `curl /api/health` ok, and a **migration rehearsal**: bring up a 0.1.x stack (built from the `v0.1.5` commit `30e6e42` into a `kyoubeai:pre-rebrand` image; the local `kyoubeai:v012` image serves for development), create a company, run `migrate-from-0.1.sh`, assert the company, the board key and both databases survive and the doctor reports `legacy-paths 0` | `scripts/smoke.sh` (new phase) |
| Live | A CDP-driven check on the smoke stack: sign in, dashboard, an agent page, the Terminal page: no visible "Paperclip" in `document.body.innerText`; a prompt bundle from a heartbeat run contains "KyoubeAI task context:" | scratchpad script, recorded in the plan's acceptance notes |

---

## 9. Residual traces and how to change the brand later

**Residual after this design** (all listed in `docs/branding.md`): the exceptions in §1; text already stored in a pre-rebrand database (old comments, run transcripts, agents' saved instructions and built-in agents created before the upgrade); the compatibility symlink on migrated installs until the operator removes the marker; the key column of the Skills library; `paperclip_runner` as an adapter *type id* in API JSON (its label reads "KyoubeAI Runner").

**Changing the name or logo later:** edit `docker/brand/brand.json`, replace `mark.svg`/`lockup.svg`, run `node scripts/render-brand-icons.mjs`, rebuild. The unit tests and the build verification are brand-agnostic (they read the kit).

---

## 10. Release and work breakdown

This is a breaking release: **0.2.0**. The user commits and tags releases.

Implementation phases for the plan (each a checkpointed section of one implementation plan, TDD throughout):

1. **Brand kit + transform**: `docker/brand/`, `scripts/render-brand-icons.mjs`, `docker/rebrand/` with tests, Dockerfile stage, browser-check assertions. Verify on a local build.
2. **Home relocation + database rename**: Dockerfile ENV/user, entrypoint (link-on-marker), bootstrap config, plugin config paths and hints, compose, init script, backup/restore, doctor checks.
3. **Repo rebrand**: docs, README credit, LICENSE addendum, CLI strings and module rename, plugin text and skills, scripts/Renovate/workflows, `.env` keys with nested fallbacks, CHANGELOG.
4. **Migration script + smoke rehearsal**: `scripts/migrate-from-0.1.sh`, the smoke phase against a 0.1.5 stack, `docs/upgrading.md` section "Upgrading from 0.1.x".
5. **Acceptance**: full smoke, browser check, live CDP check, build report review; record residual lowercase contexts in `docs/branding.md`.

---

## Corrections (2026-09-14)

Found by the whole-branch review after the implementation was accepted. The body above is left as
written (it is the record of what was designed); these are the places it is wrong or superseded.

- **§0's two claims about what runs.** Both were wrong.
  - *"the workspace packages are served from `packages/*/dist`"*: they are not. The image's CMD is
    `node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js`, and every
    `@paperclipai/*` package's `exports` map points at `./src/*.ts` — `packages/shared`,
    `packages/adapters/hermes` and others resolve through tsx to TypeScript **source**, and
    `packages/adapter-utils`, `packages/db` and `packages/adapters/claude-local` ship no `dist` at
    all. `packages/*/dist` is dead code in the image; `packages/**/src` is the live code. Hermes
    agents were consequently told they work "in a Paperclip-managed company"
    (`adapters/hermes/src/server/execute.ts`), adapter config labels and Skills-tab origin labels
    said Paperclip, and the `[paperclip]` log-prefix emitters in `packages/adapter-utils/src` were
    never rewritten while the rebranded UI bundle had started expecting `[kyoubeai]` — a behaviour
    regression, not just a cosmetic one.
  - *"no migration seeds the name"*: `packages/db/src/migrations/0105_instance_scoped_environments.sql`
    inserts `'Default execution environment for Paperclip runs on this machine.'` as the default
    execution environment's description on every fresh database. It is **not** rewritten: see the
    `.sql` note below.
- **§B.1's file set is superseded** by `docker/rebrand/lib/files.mjs`. The `packages` root now admits
  everything under `packages/**` (still skipping `node_modules`/`bin`/`.git`) rather than only
  `dist`, and code files there (`.ts .tsx .js .mjs .cjs`) go through `rewriteCode`, which applies the
  phrase and URL rules unconditionally but holds the generic name rule back where a match is both
  outside any string/comment on its line *and* identifier-shaped (`import { Paperclip }`,
  `<Paperclip …>`, `icon: Paperclip`). Those are reported as *code-shaped* rather than rewritten; on
  core 2026.831.1 there are none — every bare-code occurrence of the name in `packages` is a
  `PaperclipXxx` camelCase identifier the name rule already excludes.
  `.sql` is deliberately **not** in the set: `packages/db/src/client.ts` resolves which migrations are
  already applied by hashing the migration files and matching those hashes against
  `drizzle.__drizzle_migrations` (`loadAppliedMigrations`), so editing a shipped migration would make
  an upgraded install treat it as pending and replay it. The three migrations that mention the name
  (two in SQL comments, `0105` in the seeded description) are recorded as known residuals, printed by
  every build.
- **§B.5 item 1 ("after rewriting, the name rule matches nothing") is only meaningful with the
  sweep.** As implemented, `findResidual` re-ran the same regex over the same text the same rules had
  just cleaned, so it could only ever find a string the rules refused — never the gap that actually
  mattered, a tree the file set never entered. Every gap found in acceptance and review lived outside
  the file set. `rebrand.mjs` now also walks **all** of `--root` (skipping `node_modules`, `.git`,
  `*.map`, `*.d.ts`, tests), counts name matches per tree, prints the table under `--report`, and
  fails `--verify` for any tree not in `SWEEP_ALLOWLIST` — the source-not-executed trees
  (`ui/src`, `ui/storybook`, `server/src`, `cli`, upstream's own dev material, `LICENSE`), determined
  empirically against the image and documented one by one in `files.mjs`.
- **§7 step 1 is not `scripts/backup.sh`.** `scripts/migrate-from-0.1.sh` takes a
  `pg_dumpall --no-role-passwords` of the whole cluster plus a tar of the old home volume, because
  `backup.sh` dumps the `kyoubeai` database as the `kyoubeai` role and at that point neither exists —
  the cluster is still `paperclip`. The consequence is that `scripts/restore.sh` cannot read that
  snapshot back; `docs/upgrading.md` ("Rolling back") documents restoring `cluster.sql` by hand.
  `--no-role-passwords` keeps role password hashes out of a file that lands in `./backups`.
