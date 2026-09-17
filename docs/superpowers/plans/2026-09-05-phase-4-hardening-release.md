# Phase 4 — Hardening and 1.0 Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** KyoubeAI is safe and pleasant to operate from a public repository: prebuilt images on GHCR, one-command upgrades of both Paperclip and Kyoube, early warning when upstream changes break the plugins, documented backups/restores, a written security model with recommended governance policies, and a tagged `1.0.0`.

**Architecture:** Everything here is configuration, scripts, and documentation layered on Phases 0–3; no new runtime components. The two version pins (`PAPERCLIP_VERSION`, `@paperclipai/plugin-sdk`) are moved behind one bump script and one Renovate rule so they can never drift apart.

**Tech Stack:** GitHub Actions, Docker Buildx (multi-arch), GHCR, Renovate, bash, `pg_dump`/`pg_restore`.

**Spec:** `docs/superpowers/specs/2026-09-05-kyoubeai-architecture-design.md` §6.5, §9, §10, §12, §13 Phase 4.

> **Post-execution notes (2026-09-10).** Phase 4 is implemented; where the code differs from the snippets below, the code and the rulings P4-R1..R42 recorded during execution are authoritative. Substantive deviations: no git remote or GitHub organisation existed during execution, so every step that pushes, publishes, runs a workflow, pulls from GHCR, creates a release, enables Renovate, or opens an upstream issue is a manual acceptance item for the user; workflows were verified statically (YAML parse and per-action input read-throughs) and the compose/env changes locally (P4-R3); `<org>` is `ajknigel360` (P4-R2); Task 5A-0 ran first and closed the Phase 3 residual (a non-ASCII whitespace byte before an app's doctype could void the CSP — the doctype match now accepts only HTML ASCII whitespace, verified in a real Blink parser) and ported the plain-object error helper to the terminal plugin (P4-R9); `bump-paperclip.sh` strips carriage returns after its `jq` rewrite because the native Windows `jq` writes CRLF, using the portable `sed -i.bak` form (Task 1); `.env.example` ships the prebuilt image lines commented so a fresh copy still builds locally, and `release.yml`'s `latest` tag never moves on a prerelease tag (P4-R10); the weekly beta workflow mirrors CI's disk-space step, runs with a 60-minute budget because a timeout-cancelled job skips `if: failure()`, and guards its pin rewrite; the Renovate `paperclip` group rule comes last so it stays authoritative over the npm minor/patch group (P4-R25); backups also dump the `kyoube` and `kyoube_c_%` roles and restores re-apply them, re-set the `kyoube` password from the container environment, restore the `kyoube` database with ownership preserved, re-apply the database-level `REVOKE CONNECT`s, and refuse to proceed when `roles.sql` is empty or did not apply; the scripts honour `COMPOSE_PROJECT_NAME`/`COMPOSE_ENV_FILES`, and the smoke rehearses a fresh-cluster disaster recovery end to end (P4-R5, P4-R6, P4-R26); the plan's Task 5 ran as five dispatches — 5A-0, 5A-terminal, 5A-data, 5A-apps, and 5B (P4-R7): the terminal UI's replay ordering moved into a pure `session-stream.ts` (held-event bound with a truncation marker, generation-ordered live events, the pump mount hold released by pump identity, a PTY probe in `onHealth`) (P4-R24, P4-R27); the data layer gained a read-only SQL function allowlist with `reg*` casts rejected (P4-R11), audit rows written inside the mutation's transaction via `RESET ROLE` — and app lifecycle audits inside the store's transaction (P4-R12, P4-R28), fresh role lookups for schema-level operations (P4-R13), id and bind-parameter caps (P4-R14), Postgres `detail` scrubbed from messages (P4-R15), drop/rename checks inside the transaction with 42710/42704 mapped (P4-R16), authorisation before provisioning (P4-R17), and via-app audit attribution (P4-R21); the Apps module gained a per-mount handshake nonce that the host answers only in response to a nonce-valid hello, with the SDK retrying its hello and scrubbing the nonce script (P4-R18, P4-R29), an iframe keyed on `slug@version` (P4-R19), per-frame call budgets charged on every well-formed request (P4-R20), a headless-Chrome srcdoc check in CI (P4-R22), and a migration-upgrade integration test (P4-R23); the governance guide uses `toolName` for profile entries because upstream's own documentation example names a field its schema rejects, and SECURITY.md states the advisory UI-read residual alongside the terminal's (P4-R31); the apps skill and docs state the nonce residual honestly (P4-R30); `CONTRIBUTING.md` documents plain `pnpm` and README screenshots are a placeholder plus a manual item (P4-R8); the changelog date is the release commit's date (P4-R32); the `v1.0.0` tag is created locally after full verification and pushed by the user (P4-R4). **From the final review (run on Opus because the Fable quota was exhausted, P4-R33):** `release.yml` gained CI's free-disk step, a 180-minute budget, a per-ref concurrency group, and builds both architectures only on `v*` tags (P4-R34); the docs state that the GHCR package must be made public after the first release run and that `docker compose pull` should precede `up` so a denied pull is not masked by the local build block (P4-R35); `terminal.open` re-checks the caller's role fresh while the other terminal actions keep the 30 s cache, and SECURITY.md says so (P4-R36); the SDK captures `window.parent` at install so app code cannot recover the handshake nonce by intercepting the SDK's own posts, and the docs no longer claim the frame's first load is always the app (P4-R37); a unit test pins the iframe's exact `sandbox` attribute and the CSP in its srcdoc, with the esbuild define stubbed in Vitest (P4-R38, amending P3-R6); the image sets `DO_NOT_TRACK=1` and `DISABLE_TELEMETRY=1` and SECURITY.md carries a Telemetry section that says per component what is known and what is not — the spec's "telemetry-free defaults" exit item that the plan had dropped (P4-R39); locking clauses are rejected at any depth in read-only SQL, the doctor list names the `exposure` check, the pin scripts guard an empty Dockerfile pin and scope their cleanup, and `withCompany` discards a connection whose rollback failed (P4-R40). The fix wave's scoped re-review verified every item but found the telemetry claim still false for Terminal shells (the terminal spawns shells with a closed environment allowlist), so one follow-up — the terminal plugin injects the two switches into every shell and passes the `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` opt-in through, with the texts adjusted to say exactly that — closed it under the breaker (P4-R42); subagent commits keep the attribution of the model that produced them (P4-R41). Parked as post-1.0 issues with rulings: the fresh-lookup race that can stretch the 30 s role residual once, the superlinear parse cost of very long union chains in read-only SQL (a worker DoS surface), the `sha-` tag architecture race between a main push and a tag run of the same commit, and a unit test for the rollback-failure release path. Deferred minors (the reconnect truncation notice, `OPERATOR(schema.op)`, a runner DOM harness, the telemetry env-var work beyond the two switches) are post-1.0 issues, listed in the Phase 4 ledger's final triage.

## Global Constraints

- The GitHub organisation/repo is `<org>/KyoubeAI` — replace `<org>` everywhere on first use (Task 2 records it in `.env.example` as `KYOUBE_IMAGE`).
- Images: `ghcr.io/<org>/kyoubeai:<semver>` and `:latest` on tags `v*`; `:sha-<short>` on every `main` push. Platforms `linux/amd64,linux/arm64`.
- The only sources of truth for upstream pins: `docker/Dockerfile` (`ARG PAPERCLIP_VERSION`), `.env.example`, `scripts/smoke.env`, `docker-compose.yml` default, and `plugins/*/package.json` (`@paperclipai/plugin-sdk`). `scripts/bump-paperclip.sh` edits all of them; CI fails if they disagree.
- Backups always include **both** databases (`paperclip`, `kyoube`) and the `paperclip-home` volume.
- Conventional Commits; the changelog is generated from them.

---

## File structure

```
.github/workflows/upstream-beta.yml     # weekly build+smoke against ghcr.io/paperclipai/paperclip:beta
.github/workflows/release.yml           # tag → multi-arch image on GHCR
.github/ISSUE_TEMPLATE/security-review.md
renovate.json
scripts/bump-paperclip.sh · scripts/check-pins.sh · scripts/backup.sh · scripts/restore.sh
docs/operations.md · docs/upgrading.md · docs/governance.md · docs/architecture.md
SECURITY.md · CONTRIBUTING.md · CHANGELOG.md
docker-compose.yml · .env.example · README.md · docker/bootstrap/src/commands/doctor.ts (modified)
```

---

### Task 1: Pin consistency check and bump script

**Files:**
- Create: `scripts/check-pins.sh`, `scripts/bump-paperclip.sh`
- Modify: `.github/workflows/ci.yml` (run the check first)

- [ ] **Step 1: Write the check**

`scripts/check-pins.sh`:
```bash
#!/usr/bin/env bash
# Fails when the Paperclip image pin and the plugin SDK pins disagree.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
dockerfile="$(sed -n 's/^ARG PAPERCLIP_VERSION=\(.*\)$/\1/p' "$ROOT/docker/Dockerfile" | head -1)"
envfile="$(sed -n 's/^PAPERCLIP_VERSION=\(.*\)$/\1/p' "$ROOT/.env.example")"
smoke="$(sed -n 's/^PAPERCLIP_VERSION=\(.*\)$/\1/p' "$ROOT/scripts/smoke.env")"
compose="$(sed -n 's/.*PAPERCLIP_VERSION:-\([^}]*\)}.*/\1/p' "$ROOT/docker-compose.yml" | head -1)"
status=0
for pkg in "$ROOT"/plugins/*/package.json; do
  sdk="$(jq -r '.dependencies["@paperclipai/plugin-sdk"] // empty' "$pkg")"
  if [[ -n "$sdk" && "$sdk" != "$dockerfile" ]]; then echo "PIN MISMATCH: $pkg has @paperclipai/plugin-sdk $sdk, Dockerfile has $dockerfile" >&2; status=1; fi
done
for pair in "env:$envfile" "smoke:$smoke" "compose:$compose"; do
  value="${pair#*:}"
  if [[ "$value" != "$dockerfile" ]]; then echo "PIN MISMATCH: ${pair%%:*} has $value, Dockerfile has $dockerfile" >&2; status=1; fi
done
[[ $status -eq 0 ]] && echo "pins consistent: $dockerfile"
exit $status
```

`scripts/bump-paperclip.sh`:
```bash
#!/usr/bin/env bash
# Bumps every Paperclip pin (image + plugin SDK) to one version and reinstalls.
# Usage: scripts/bump-paperclip.sh 2026.914.1
set -euo pipefail
NEW="${1:?usage: bump-paperclip.sh <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
sed -i.bak "s/^ARG PAPERCLIP_VERSION=.*/ARG PAPERCLIP_VERSION=${NEW}/" "$ROOT/docker/Dockerfile"
sed -i.bak "s/^PAPERCLIP_VERSION=.*/PAPERCLIP_VERSION=${NEW}/" "$ROOT/.env.example" "$ROOT/scripts/smoke.env"
sed -i.bak "s/PAPERCLIP_VERSION:-[^}]*}/PAPERCLIP_VERSION:-${NEW}}/" "$ROOT/docker-compose.yml"
for pkg in "$ROOT"/plugins/*/package.json; do
  if jq -e '.dependencies["@paperclipai/plugin-sdk"]' "$pkg" >/dev/null; then
    jq --arg v "$NEW" '.dependencies["@paperclipai/plugin-sdk"] = $v' "$pkg" > "$pkg.tmp" && mv "$pkg.tmp" "$pkg"
  fi
done
find "$ROOT" -name '*.bak' -not -path '*/node_modules/*' -delete
(cd "$ROOT" && pnpm install && bash scripts/check-pins.sh)
echo "Bumped Paperclip pins to ${NEW}. Next: pnpm test && bash scripts/smoke.sh, then commit 'chore: bump paperclip to ${NEW}'."
```

- [ ] **Step 2: Wire into CI and verify**

In `.github/workflows/ci.yml` job `unit`, add `- run: bash scripts/check-pins.sh` right after checkout. Run `bash scripts/check-pins.sh` locally → `pins consistent: 2026.831.1`. Try `bash scripts/bump-paperclip.sh 2026.831.1` (a no-op bump) → succeeds; `git status` shows no changes except possibly `pnpm-lock.yaml` formatting.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-pins.sh scripts/bump-paperclip.sh .github/workflows/ci.yml
git commit -m "chore: pin consistency check and paperclip bump script"
```

---

### Task 2: Release images on GHCR and prebuilt-image compose

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `docker-compose.yml`, `.env.example`, `README.md`

- [ ] **Step 1: Release workflow**

`.github/workflows/release.yml`:
```yaml
name: release

on:
  push:
    branches: [main]
    tags: ["v*"]

permissions:
  contents: read
  packages: write

jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository_owner }}/kyoubeai
          tags: |
            type=sha,prefix=sha-
            type=semver,pattern={{version}}
            type=raw,value=latest,enable=${{ startsWith(github.ref, 'refs/tags/v') }}
      - name: Resolve version arg
        id: version
        run: echo "value=${GITHUB_REF_NAME#v}" >> "$GITHUB_OUTPUT"
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: docker/Dockerfile
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          build-args: |
            KYOUBE_VERSION=${{ steps.version.outputs.value }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Compose supports prebuilt images**

In `docker-compose.yml` change the `app` service image line to `image: ${KYOUBE_IMAGE:-kyoubeai}:${KYOUBE_VERSION:-dev}` (keep the `build:` block: `docker compose up -d --build` builds locally; `docker compose pull && docker compose up -d` uses the registry image when `KYOUBE_IMAGE` points at GHCR). Add to `.env.example`:
```
# Prebuilt image (leave blank to build locally with `docker compose up --build`)
KYOUBE_IMAGE=ghcr.io/<org>/kyoubeai
KYOUBE_VERSION=1.0.0
```
and in `README.md` Quickstart offer both paths: prebuilt (`docker compose pull && docker compose up -d`) and from source (`docker compose up -d --build`).

- [ ] **Step 3: Verify and commit**

Push to a branch and run the workflow via a test tag `v0.0.1-rc.1` on a fork or the repo; confirm `docker pull ghcr.io/<org>/kyoubeai:0.0.1-rc.1` works and `docker run --rm ghcr.io/<org>/kyoubeai:0.0.1-rc.1 kyoube --help` prints usage. Delete the rc tag afterwards.

```bash
git add .github/workflows/release.yml docker-compose.yml .env.example README.md
git commit -m "ci: publish multi-arch images to GHCR; compose supports prebuilt images"
```

---

### Task 3: Weekly build against upstream `:beta` and Renovate

**Files:**
- Create: `.github/workflows/upstream-beta.yml`, `renovate.json`

- [ ] **Step 1: Weekly canary workflow**

`.github/workflows/upstream-beta.yml`:
```yaml
name: upstream-beta

on:
  schedule:
    - cron: "0 6 * * 1"   # Mondays 06:00 UTC
  workflow_dispatch:

permissions:
  contents: read
  issues: write

jobs:
  smoke-beta:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - name: Smoke against Paperclip beta
        run: |
          sed -i 's/^PAPERCLIP_VERSION=.*/PAPERCLIP_VERSION=beta/' scripts/smoke.env
          bash scripts/smoke.sh
      - name: Open an issue on failure
        if: failure()
        uses: actions/github-script@v7
        with:
          script: |
            const title = "Upstream Paperclip :beta breaks the KyoubeAI smoke test";
            const { data: open } = await github.rest.issues.listForRepo({ owner: context.repo.owner, repo: context.repo.repo, state: "open", labels: "upstream" });
            if (open.some((issue) => issue.title === title)) return;
            await github.rest.issues.create({ owner: context.repo.owner, repo: context.repo.repo, title, labels: ["upstream"],
              body: `The weekly build against ghcr.io/paperclipai/paperclip:beta failed. See ${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}. Check the plugin SDK changelog before bumping PAPERCLIP_VERSION.` });
```
Note: the `:beta` image reports its own version in `/api/health`; the smoke test does not pin the SDK to it, which is exactly the signal we want (does our SDK-pinned plugin still load on the next host?).

- [ ] **Step 2: Renovate configuration**

`renovate.json`:
```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "labels": ["dependencies"],
  "packageRules": [
    {
      "description": "Paperclip host image and plugin SDK move together",
      "groupName": "paperclip",
      "matchPackageNames": ["@paperclipai/plugin-sdk", "ghcr.io/paperclipai/paperclip"],
      "schedule": ["before 6am on monday"]
    },
    { "matchManagers": ["npm"], "matchUpdateTypes": ["minor", "patch"], "groupName": "npm minor/patch" }
  ],
  "customManagers": [
    {
      "customType": "regex",
      "description": "PAPERCLIP_VERSION pins in Dockerfile, env example, smoke env, compose",
      "fileMatch": ["^docker/Dockerfile$", "^\\.env\\.example$", "^scripts/smoke\\.env$", "^docker-compose\\.yml$"],
      "matchStrings": ["PAPERCLIP_VERSION[=:-]+(?<currentValue>\\d{4}\\.\\d{3,4}\\.\\d+)"],
      "depNameTemplate": "ghcr.io/paperclipai/paperclip",
      "datasourceTemplate": "docker"
    }
  ],
  "postUpgradeTasks": {
    "commands": ["bash scripts/check-pins.sh"],
    "fileFilters": ["**/*"],
    "executionMode": "branch"
  }
}
```
(Renovate's `postUpgradeTasks` requires a self-hosted Renovate or the Mend app with the feature enabled; if unavailable, CI's `check-pins.sh` still blocks a drifted PR.)

- [ ] **Step 3: Trigger once and commit**

Run the workflow with `workflow_dispatch` after merging; confirm it completes (green or an `upstream` issue).

```bash
git add .github/workflows/upstream-beta.yml renovate.json
git commit -m "ci: weekly smoke against upstream beta and grouped renovate updates"
```

---

### Task 4: Backups, restore, and operations guide

**Files:**
- Create: `scripts/backup.sh`, `scripts/restore.sh`, `docs/operations.md`, `docs/upgrading.md`

- [ ] **Step 1: Backup and restore scripts**

`scripts/backup.sh`:
```bash
#!/usr/bin/env bash
# Dumps both databases and the paperclip-home volume into ./backups/<timestamp>/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR:-$ROOT/backups}/$STAMP"
mkdir -p "$OUT"
cd "$ROOT"
docker compose exec -T db pg_dump -U paperclip -Fc paperclip > "$OUT/paperclip.dump"
docker compose exec -T db pg_dump -U paperclip -Fc kyoube > "$OUT/kyoube.dump"
docker run --rm --volumes-from "$(docker compose ps -q app)" -v "$OUT:/backup" alpine:3.20 tar czf /backup/paperclip-home.tgz -C /paperclip .
sha256sum "$OUT"/* > "$OUT/SHA256SUMS"
echo "backup written to $OUT"
```

`scripts/restore.sh`:
```bash
#!/usr/bin/env bash
# Restores a backup directory produced by scripts/backup.sh. STOPS the app while restoring.
set -euo pipefail
SRC="${1:?usage: restore.sh <backup-dir>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
(cd "$SRC" && sha256sum -c SHA256SUMS)
docker compose stop app
for db in paperclip kyoube; do
  docker compose exec -T db psql -U paperclip -d postgres -c "DROP DATABASE IF EXISTS ${db}_restore_tmp" >/dev/null
  docker compose exec -T db psql -U paperclip -d postgres -c "CREATE DATABASE ${db}_restore_tmp" >/dev/null
  docker compose exec -T db pg_restore -U paperclip -d "${db}_restore_tmp" --no-owner < "$SRC/$db.dump"
  docker compose exec -T db psql -U paperclip -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}'" >/dev/null
  docker compose exec -T db psql -U paperclip -d postgres -c "DROP DATABASE IF EXISTS ${db}" >/dev/null
  docker compose exec -T db psql -U paperclip -d postgres -c "ALTER DATABASE ${db}_restore_tmp RENAME TO ${db}" >/dev/null
done
docker compose exec -T db psql -U paperclip -d postgres -c "ALTER DATABASE kyoube OWNER TO kyoube" >/dev/null
docker run --rm --volumes-from "$(docker compose ps -q app)" -v "$(cd "$SRC" && pwd):/backup:ro" alpine:3.20 sh -c 'rm -rf /paperclip/* /paperclip/.[!.]* 2>/dev/null; tar xzf /backup/paperclip-home.tgz -C /paperclip'
docker compose start app
echo "restored from $SRC"
```

- [ ] **Step 2: Test the round trip**

Run: `bash scripts/backup.sh` on a running stack with a table and an app; `docker compose exec db psql -U paperclip -d kyoube -c "DELETE FROM kyoube_meta.apps"`; `bash scripts/restore.sh backups/<stamp>`; verify the app is back in the gallery and the terminal credentials still work.

- [ ] **Step 3: Operations and upgrading docs**

`docs/operations.md` sections (write each in full prose with the exact commands): *Volumes and what lives where* (`pgdata`, `paperclip-home` incl. `~/.claude`, `~/.pi`, `~/.hermes`, `kyoube/board-key.json`), *Backups* (`scripts/backup.sh`, cron example, off-site copy), *Restore*, *Logs* (`docker compose logs app`, plugin logs under Settings → Plugins), *Health* (`kyoube doctor`, `/api/health`), *Rotating the board key* (revoke under Paperclip Settings → API keys, delete `board-key.json`, re-run `kyoube setup`), *Resetting harness credentials*, *Resource limits* (`pids_limit`, memory).

`docs/upgrading.md`: *Upgrading KyoubeAI* (pull/rebuild; plugins re-install automatically; check `kyoube doctor`), *Upgrading Paperclip* (`scripts/bump-paperclip.sh <version>` → tests → smoke → commit; what to read first: Paperclip release notes and `doc/plugins/PLUGIN_AUTHORING_GUIDE.md` changes), *Rolling back* (revert the pin; databases migrate forward only — restore from backup if a Paperclip migration must be undone).

```bash
git add scripts/backup.sh scripts/restore.sh docs/operations.md docs/upgrading.md
git commit -m "docs: backup/restore scripts and operations guides"
```

---

### Task 5: Security model, governance recommendations, doctor warnings

> **Carried over from Phase 1 (ruling P1-R20), to land in this task's hardening pass:** (a) `resumeSession` in `plugins/kyoube-terminal/src/ui/TerminalPage.tsx` keeps the previous stream pump mounted while awaiting the resume replay, so the old session's live events can enter the new tracker — unmount the pump (or bump the replay generation) before awaiting; (b) a single React commit carrying both `connected` and accumulated events applies live events before the connect-triggered replay starts — buffer from pump mount instead of from `replay()`; (c) the held-event queue during a pending replay is unbounded — cap it; (d) `terminal.can_open` and the apps plugin's UI data reads trust `params.userId` (data providers have no actor context) — document as advisory-only in SECURITY.md; (e) a session pruned between list refreshes yields `not_found` on attach — refresh the list on that error; also the Phase 1 deferred minors ledgered in the plan's post-execution notes (dead-code `params.companyId` fallback tests, `onHealth` never unhealthy, human error text discarded in the UI).

> **Carried over from Phase 2 (ruling P2-R28 and the final-review triage), to land in this task's hardening pass:** catalog functions reachable through `data_sql_select` can still reveal other companies' object/role names — evaluate a function allowlist or catalog `REVOKE`s in the db init script; scrub Postgres `detail` (key values) out of `DataError` messages that reach operator logs (`mapPgError`); wire `RoleResolver.invalidate` to membership changes (a demoted admin keeps `schema` for up to 30 s); cap `target.ids` and the total bind-parameter count in the records service; `assertNotReferenced` runs outside the drop transaction (TOCTOU) and `RENAME CONSTRAINT` can raise unmapped 42710/42704 for ≥63-char names; `authorize` provisions a company before denying an actor at `none`; audit rows are written outside the mutation's transaction (P2-R23).

> **Carried over from Phase 3 (rulings P3-R3, P3-R17, P3-R18, P3-R22, and the final-review triage), to land in this task's hardening pass — the first two items are the first dispatch of Phase 4 (ruling P4-R9):** (1) **open Critical residual (P3-R22):** `plugins/kyoube-apps/src/ui/apps/srcdoc.ts` matches the leading doctype with JavaScript `\s`, which accepts Unicode whitespace the HTML tokenizer treats as content (U+00A0, U+000B, U+2028/U+2029, U+3000, other Unicode spaces, and a BOM after a newline), so such a byte before `<!doctype>` leaves the injected `<head>` in the body where the CSP meta is ignored — narrow the class to HTML ASCII whitespace `[\t\n\f\r ]`, treat anything else as content (head-first), and add tests for each byte plus LF+BOM; (2) the terminal plugin's `plugins/kyoube-terminal/src/ui/error-code.ts` (and any `errorText`-style helper there) reads only `Error` instances, but upstream's `usePluginAction` rejects with a plain `PluginBridgeError { code, message, details }` object, so its action errors display as "[object Object]" with code `error` — port the apps plugin's `bridgeErrorMessage` helper and re-verify Phase 1's "member denied" acceptance. Then: add a per-mount nonce to the app handshake so a foreign document in the frame can never speak the protocol (P3-R18 stops the frame on its second load; the nonce closes the window between navigation start and the `load` event); key the runner's iframe on the source so a legitimate in-place source change is not mistaken for a navigation; consider a per-frame call budget (toast/openApp/data spam); app lifecycle activity entries are labelled `Kyoube data:` with `entityType: "kyoube_table"` (parameterise the shared summariser per service); runtime data mutations are audited as the viewer with no "via app" attribution (thread `{ app, version }` into the audit details); `store.addVersion` writes `name`/`description`/`icon` onto the live app row, so a write-level actor renames a published app in the gallery and in `runtime.context` without the schema-gated publish (copy metadata on `setCurrent`); nested `__proto__` keys inside `params` pass the bridge's one-level record check and are contained only by the worker's field validation (add a depth check in `routeAppRequest`); the pre-setup 503 body names only the data service; `open()`/`get()` cost three app-table round trips (a `getVersion` overload taking a resolved `AppRecord`); `makeCurrent`'s TOCTOU between `describeTable` and `setCurrent` is accepted (fails closed at runtime); refs are assigned during render in the runner and pages (the Phase 1 pattern); no DOM render harness exists for the Apps pages — a headless-browser smoke step (fetch blocked for every srcdoc shape incl. the Unicode-whitespace ones, navigation teardown, error toast text) is the right Phase 4 addition; the smoke never rehearses a migration applied on top of an existing `0001`-only database; `<link rel="dns-prefetch">`/`preconnect` are not CSP-governed and remain a small DNS side channel to document in SECURITY.md; the plan's embedded skill text lists three toast tones (the shipped skill lists four). The v2 SDK surface deferred by P3-R3 (`data.subscribe`, `ui.confirm`, `theme`, "Preview draft") belongs in the README roadmap (Task 6), not in this pass.

**Files:**
- Create: `SECURITY.md`, `docs/governance.md`, `.github/ISSUE_TEMPLATE/security-review.md`
- Modify: `docker/bootstrap/src/commands/doctor.ts`, `docker/bootstrap/tests/doctor.spec.ts` (new)

- [ ] **Step 1: Doctor warns about unsafe public exposure**

Add to `runDoctor` (after the config check) a pure helper and a check:
```ts
export function exposureWarning(env: NodeJS.ProcessEnv, publicUrl: string): string | null {
  if ((env.PAPERCLIP_DEPLOYMENT_EXPOSURE ?? "private") !== "public") return null;
  if (!publicUrl.startsWith("https://")) return `PAPERCLIP_DEPLOYMENT_EXPOSURE=public but PAPERCLIP_PUBLIC_URL is ${publicUrl}; put TLS in front and use an https URL`;
  return null;
}
```
and push `{ name: "exposure", ok: warning === null, detail: warning ?? "private or https" }`. Test in `docker/bootstrap/tests/doctor.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { exposureWarning } from "../src/commands/doctor.js";
describe("exposureWarning", () => {
  it("only warns for public exposure without https", () => {
    expect(exposureWarning({}, "http://localhost:3100")).toBeNull();
    expect(exposureWarning({ PAPERCLIP_DEPLOYMENT_EXPOSURE: "public" }, "https://ai.example.com")).toBeNull();
    expect(exposureWarning({ PAPERCLIP_DEPLOYMENT_EXPOSURE: "public" }, "http://ai.example.com")).toContain("https");
  });
});
```

- [ ] **Step 2: Write SECURITY.md**

`SECURITY.md` must cover: reporting channel (security advisory on GitHub, response target 7 days); the three trust zones (Paperclip core; Kyoube plugins as trusted code with a separate database credential; apps as untrusted sandboxed code); what the Terminal grants (full instance access) and its gate/audit; the data isolation guarantees (per-company Postgres role; read-only SQL; statement timeouts; soft deletes); what is *not* covered (Paperclip itself — link upstream `SECURITY.md`; the host OS); secrets locations and rotation pointers to `docs/operations.md`.

- [ ] **Step 3: Governance recommendations**

`docs/governance.md`: explain the two gates (Kyoube grant levels; Paperclip tool profiles/policies) and give copy-paste `curl` commands (from Paperclip's `doc/MCP-ACCESS-GOVERNANCE.md` shapes) to: create a company profile `kyoube.safe-default` that includes `kyoube.apps:data_*` read tools by `tool_name` pattern; a policy of type `require_approval` for `kyoube.apps:data_drop_table`, `kyoube.apps:data_remove_field`, `kyoube.apps:apps_publish`; and a `rate_limit` policy for `kyoube.apps:data_insert`. Close with the recommended defaults table: agents default `none`; builder agents `schema` in a dedicated project; reviewers `read`.

- [ ] **Step 4: Security review checklist issue template**

`.github/ISSUE_TEMPLATE/security-review.md` with checkboxes: terminal gate + audit verified for each role; SSE channel names are unguessable and never listed; `withCompany` used for every data path (grep for raw `pool.query` outside `kyoube_meta` access); `assertReadOnlySelect` covers CTE/union/into cases; apps iframe has no `allow-same-origin`, CSP present, `event.source` check present; no secrets in logs (`grep -ri "secret\|token" plugins/*/src | grep logger`); dependencies audited (`pnpm audit --prod`); backup/restore rehearsed; `kyoube doctor` clean on a public deployment.

Run the checklist once on the current code and fix anything it finds before committing.

```bash
git add SECURITY.md docs/governance.md .github/ISSUE_TEMPLATE/security-review.md docker/bootstrap
git commit -m "docs: security model, governance recommendations, exposure warning"
```

---

### Task 6: Final documentation, contributing guide, changelog

**Files:**
- Create: `docs/architecture.md`, `CONTRIBUTING.md`, `CHANGELOG.md`
- Modify: `README.md`

- [ ] **Step 1: Architecture doc**

`docs/architecture.md`: the §4 diagram and trust zones from the spec, the request paths (browser → Paperclip → plugin bridge → worker → `kyoube` DB; agent run → MCP runtime-tools → plugin tool → worker), the data model (`kyoube_meta` tables, `c_<hex>` schemas), and the upgrade contract (pins, plugin hot reload, SDK `apiVersion`). Link the spec and the four plans.

- [ ] **Step 2: Contributing guide and changelog**

`CONTRIBUTING.md`: local setup (`corepack enable && pnpm install`, `scripts/dev-db.sh` for integration tests, `pnpm smoke`), branch/commit conventions, where things live, "never patch Paperclip — propose upstream or extend via plugins", how to add a tool (definition + skill + test), review checklist. `CHANGELOG.md` with `## 1.0.0` listing the four phases' features in user terms.

- [ ] **Step 3: README final pass**

Rewrite the README top: one-paragraph pitch, a screenshot placeholder section (`docs/images/` — take real screenshots of Data, Apps, Terminal after Task 7 and commit them), feature list with links to `docs/*.md`, Quickstart (prebuilt and from-source), "How it stays upstream-compatible", Roadmap (multi-file apps, dashboard widgets, realtime table updates, upstream proposal for operator-configurable bundled plugins), License.

```bash
git add docs/architecture.md CONTRIBUTING.md CHANGELOG.md README.md
git commit -m "docs: architecture, contributing guide, changelog, README"
```

---

### Task 7: Release 1.0.0

- [ ] **Step 1: Full verification**

Run: `bash scripts/check-pins.sh && pnpm typecheck && pnpm test && pnpm --filter @kyoube/plugin-apps test:integration && bash scripts/smoke.sh`
Expected: all green.

- [ ] **Step 2: Tag and publish**

```bash
git tag -a v1.0.0 -m "KyoubeAI 1.0.0"
git push origin main --tags
```
Wait for `release.yml`; then on a clean machine: `git clone … && cp .env.example .env` (fill secrets, set `KYOUBE_IMAGE`/`KYOUBE_VERSION=1.0.0`), `docker compose pull && docker compose up -d`, sign up, claim, `kyoube setup`, open Terminal/Data/Apps. Take the README screenshots here.

- [ ] **Step 3: Post-release**

Create a GitHub release from the tag with the `CHANGELOG.md` section; enable Renovate; confirm the weekly `upstream-beta` workflow is scheduled; open the upstream proposal issue on `paperclipai/paperclip` for an operator-configurable bundled-plugin allowlist (link `docs/architecture.md` as motivation).

---

## Phase 4 exit checklist

- [ ] `ghcr.io/<org>/kyoubeai:1.0.0` and `:latest` exist for amd64 and arm64; a fresh clone runs from the prebuilt image.
- [ ] `scripts/bump-paperclip.sh` + `scripts/check-pins.sh` keep pins in lock-step; CI enforces it.
- [ ] Weekly upstream-beta workflow ran at least once.
- [ ] Backup and restore rehearsed successfully.
- [ ] `SECURITY.md`, `docs/governance.md`, `docs/operations.md`, `docs/upgrading.md`, `docs/architecture.md`, `docs/apps.md` published; security review checklist completed with no open items.
