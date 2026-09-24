# Upgrading

Two things move independently: **KyoubeAI** (this repository — the bootstrap CLI, the plugins, the
overlay image) and **the core** (Paperclip — the upstream host image the overlay is built `FROM`).
Nothing here patches the core, so a core upgrade is a version bump and a rebuild.

**Take a backup first, every time.** `bash scripts/backup.sh` costs a minute and is the only way
back from a migration you do not like — see [Rolling back](#rolling-back) and
[docs/operations.md](operations.md).

## Upgrading KyoubeAI

The README's [Update](../README.md#update) section walks through these steps one at a time.

From source:

```bash
bash scripts/backup.sh
git pull
grep '^KYOUBE_CORE_VERSION=' .env.example .env
git diff ORIG_HEAD -- .env.example     # settings the update added
docker compose up -d --build
docker compose exec app kyoube doctor
```

**Update the core pin in `.env` before you build.** `.env` is yours, so `git pull` never changes it,
but it pins the core with `KYOUBE_CORE_VERSION`. When a release moves to a new core, the `grep` above
shows two different values: copy the `.env.example` one into `.env` (if your `.env` still uses the
0.1.x name `PAPERCLIP_VERSION`, change that line the same way). Otherwise the build uses the old core
and stops at the core-patches step with `this build uses core <old>, but this KyoubeAI release is made
for core <new>`.

From a published image (`KYOUBE_IMAGE=ghcr.io/jknigel/kyoubeai` in `.env`), check out the tag of the
release you are moving to, so `docker-compose.yml`, the scripts and `.env.example` match the image,
then set `KYOUBE_VERSION` in `.env` to the same version:

```bash
bash scripts/backup.sh
git fetch --tags
git checkout v1.0.1                          # the release you are moving to
git diff v1.0.0 v1.0.1 -- .env.example       # settings the release added or changed
# in .env: KYOUBE_VERSION=1.0.1, plus any new settings
docker compose pull                          # must succeed on its own
docker compose up -d
docker compose exec app kyoube doctor
```

Which tags exist, and what is in them: a release tag (`1.0.0`, plus `latest` for the newest
non-prerelease one) is built for **linux/amd64 and linux/arm64**, and is the only kind of tag a
deployment should run. The `sha-<commit>` tags a push to `main` publishes are **amd64-only** — they
exist to test one commit, are not built for arm64 at all, and are not release artefacts.

**Plugins re-install themselves.** The entrypoint starts `kyoube ensure-plugins --watch`, which
compares the plugin versions on disk in the new image against the versions the core has installed
and upgrades any that differ. You do not run `kyoube setup` again — the board key on the
`kyoubeai-home` volume is still valid. Watch it happen with `docker compose logs -f app`.

Two upgrade paths exist, and which one is taken is decided upstream. A plain version bump goes
through `POST /api/plugins/:id/upgrade`. A manifest that declares a **new capability** cannot be
upgraded without board approval, so `ensure-plugins` soft-uninstalls the plugin (no `purge`, so
plugin data survives) and installs the same path again; the log line says so explicitly. Either way
the end state is the plugin `ready` at the new version.

`kyoube doctor` is the check that matters. Its `plugins` line lists every `kyoube.*` plugin as
`key@version=status`; every one of them should read `=ready`, at the versions the new image ships.
A plugin stuck in another status has its own log under **Settings → Plugins → *plugin* → Logs**.

If a plugin is deliberately disabled by an operator, `ensure-plugins` leaves it alone and says so —
that is not a failure, but `doctor` will not call it `ready` either.

## Moving an install from core 2026.831.1

Builds of KyoubeAI made before 1.0.0 ran on core 2026.831.1; 1.0.0 runs on core 2026.916.1, a large
upstream release. Read this before you rebuild an install made from one of those builds.

- **Set `KYOUBE_CORE_VERSION=2026.916.1` in `.env`.** An install from an earlier build still pins
  2026.831.1 there, and the build then fails at the core-patches step
  ([Upgrading KyoubeAI](#upgrading-kyoubeai)).
- **Back up first.** The core adds 49 database migrations (`0231` to `0279`). They run on the first
  start and cannot be undone: `bash scripts/backup.sh`.
- **Behind a reverse proxy or tunnel, set `TRUST_PROXY`.** The core now believes `X-Forwarded-Host`
  only from a proxy it trusts. If sign-in or saving fails with an origin error behind Caddy, Traefik,
  nginx or a Cloudflare tunnel, set `TRUST_PROXY` in `.env`: `uniquelocal` trusts a proxy container
  on the same Docker network, and also a proxy on the host that reaches the container over a Docker
  bridge. Leave it empty when people reach the app directly.
- **The streamlined shell is the default.** The core's new sidebar replaces the old one, and Studio
  is built for it. Settings → Experimental → **Streamlined UI** switches back, but the Studio sidebar
  then shows the legacy Agents and Organization sections.
- **Some pages moved.** The org chart is a view on All agents; Timeline, Costs and an agent's runs are
  under Audit (`/activity/timeline`, `/activity/costs`, `/activity/runs`). Old URLs redirect, and the
  Workspace page links the new places.
- **Onboarding changed.** The first-run wizard's **Connect a model** step offers a Claude or OpenAI
  subscription or an API key. A subscription cannot be signed in from the wizard on a KyoubeAI server;
  use **Skip for now and connect the harness later from the Terminal page**, then run `claude login`
  on the Terminal page.
- **Announcements stay off.** The core now shows Paperclip's hosted announcement cards by default;
  KyoubeAI's `docker-compose.yml` turns them off (`PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false"`).
- **Agent credentials are no longer echoed.** Agent API responses redact plaintext `env` values.
  Nothing in KyoubeAI reads them; a script of your own might.
- **The native runner gate is open.** `enableNativeRunner` now defaults to on for self-hosted
  instances. Nothing switches automatically, and existing agents keep their adapters.
- **Harnesses.** The image carries Claude Code 2.1.281, pi 0.87.1 and Hermes 0.21.4 (release
  v2026.9.21). Their logins on the `kyoubeai-home` volume carry over.

## Upgrading from 0.1.x

0.2.0 renamed what the container and the database are called: the home volume is `kyoubeai-home` mounted at `/kyoubeai`, the core role and database are `kyoubeai`,
and `.env` uses `KYOUBE_PUBLIC_URL`, `KYOUBE_DEPLOYMENT_EXPOSURE` and `KYOUBE_CORE_VERSION`. One script
moves an existing install across, and it is safe to re-run:

```bash
bash scripts/backup.sh                 # with the 0.1.x checkout, before pulling
git pull
bash scripts/migrate-from-0.1.sh       # stops app, renames the role/database, copies the home volume, starts 0.2.x
docker compose exec app kyoube doctor
```

What it does, in order: stops `app`; snapshots the cluster and the old volume under
`backups/pre-0.2-migration-…` (skip with `--no-backup`); renames the three keys in `.env` (a
`.env.bak` is kept); renames the Postgres role and database in place through a temporary superuser;
builds or pulls the 0.2.x image; lets compose create `kyoubeai-home` and copies `paperclip-home`
into it; starts the stack and runs `kyoube doctor`.

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

**If you ran `docker compose up -d --build` before the migration** — the natural thing to do after a
`git pull` — the 0.2.x app starts, creates and fills `<project>_kyoubeai-home`, and then crash-loops
on `role "kyoubeai" does not exist`, because the cluster is still the 0.1.x one. The migration
refuses to overwrite that half-populated volume, and a bare `docker volume rm` fails with *volume is
in use* while the stopped container still references it. Remove the container first, then the volume,
then migrate:

```bash
docker compose rm -sf app
docker volume rm <project>_kyoubeai-home
bash scripts/migrate-from-0.1.sh
```

**Rolling back to 0.1.x** is a restore of the pre-upgrade backup on the 0.1.x checkout, as in
[Rolling back](#rolling-back); the renamed cluster is not usable by a 0.1.x image.

## Upgrading the core

### Read these first

1. **The core's (Paperclip's) release notes** for every version between yours and the target. Breaking changes to
   the plugin host, the board API, or the database schema land there.
2. **`doc/plugins/PLUGIN_AUTHORING_GUIDE.md`** in the core repository, diffed against the
   version you are on. The plugins in `plugins/` are written against that contract — manifest
   fields, capability names, the action/data bridge, the tool gateway, the UI slot host. A change
   there is the most likely reason a bump needs code and not just a pin.
3. The `@paperclipai/plugin-sdk` changelog for the same range: the SDK version and the image version
   are pinned together on purpose.

### Do the bump

```bash
bash scripts/bump-core.sh 2026.914.1
```

That rewrites every pin in one go — `ARG KYOUBE_CORE_VERSION` in `docker/Dockerfile`,
`KYOUBE_CORE_VERSION` in `.env.example` and `scripts/smoke.env`, the default in `docker-compose.yml`,
and the `@paperclipai/plugin-sdk` dependency of every plugin — then reinstalls and runs
`scripts/check-pins.sh`, which fails if any of them disagree.

Then, in order:

```bash
pnpm test           # unit suites for the bootstrap CLI and both plugins
pnpm build          # every package builds against the new SDK
bash scripts/smoke.sh   # the full docker end-to-end, 12-25 minutes
```

How long the smoke takes is dominated by the image build: about 12 minutes when the build cache is
warm, roughly twice that when a new `KYOUBE_CORE_VERSION` invalidates it.

The smoke is the real gate: it builds the image, claims a fresh instance, installs both plugins,
rehearses a version bump and a capability escalation, exercises the terminal, data and apps paths,
and finishes with a full backup/restore round trip. If it passes, commit:

```bash
git commit -am "chore: bump core to 2026.914.1"
```

Finally, roll it out: copy the new `KYOUBE_CORE_VERSION` into your deployment's own `.env` (it is not
tracked, so `bump-core.sh` cannot touch it) and `docker compose up -d --build`.

### What can break

- **The image build stops at the `core-patches` step** with a line like
  `core patch "<id>" matched 0 time(s) … expected 1`. Each entry in `docker/core-patches/patches.mjs`
  is a fix to an upstream bug that shipped here first; the new core either carries the upstream fix
  (delete the entry — that is the intended outcome) or changed the code's shape (check the upstream
  file the entry names; redo the pattern only if the bug is still there). Never loosen a pattern to
  make the build pass.
- **The image build stops at the `theme` step** with a line naming a text rule, an anchor, a sidebar
  section or a token (for example `text rule "home-sidebar-label" matched 0 time(s)` or
  `sidebar section "organization" changed: added [/reports]`). The core moved something the Studio
  design relies on; nothing was written. `docs/theme.md` ("After a core bump") says what to change for
  each message. Never relax a rule's `expect` to make the build pass. When it passes, look at the
  `studio-screenshots` the smoke leaves (CI artifact, or `STUDIO_SHOTS_DIR` locally).
- **A capability was renamed or removed upstream.** The plugin install fails outright. Fix the
  manifest in `plugins/*/src/manifest.ts`.
- **The plugin host changed a bridge or route shape.** Usually surfaces as a plugin that installs
  but never reaches `ready`; the plugin's own log names the throw.
- **The core's own migrations run on first start** against the `kyoubeai` database, before the app
  serves anything. Give it time — the compose healthcheck allows a 180-second start period for
  exactly this — and read `docker compose logs -f app` rather than restarting into a half-migrated
  database.

## Rolling back

Reverting the code is easy; reverting a database is not.

```bash
git revert <the bump commit>       # or: git checkout <previous tag>
docker compose up -d --build
```

On a published image, check out the previous release tag instead, set `KYOUBE_VERSION` in `.env`
back to that release, and run `docker compose pull && docker compose up -d` rather than building.

**Databases migrate forward only.** Neither the core's migrations nor Kyoube's have a `down` step.
An older image against a database a newer image has already migrated is unsupported: it may start
and then fail in obscure ways, or refuse to start at all. If a core migration has to be undone,
the supported route is to restore the backup you took before the upgrade:

```bash
bash scripts/restore.sh backups/<the one from before the bump>
```

Restore replaces both databases and the home volume wholesale, so everything written since that
backup is lost — which is the argument for taking one immediately before every bump, not nightly
only.

Restoring onto the older image also puts the plugin rows back in step with it, without you doing
anything: the restored `kyoubeai` database still lists the newer image's plugin versions, and
`ensure-plugins` compares each installed version against the one on disk for **difference, not
newness**, so it re-installs them at the older image's versions on the next start. That is what you
want here — but it is also why running an older image against a database you have *not* restored is
not a rollback: the plugins would be downgraded while the schema stayed migrated forward.

### The 0.1.x migration's own snapshot

`scripts/migrate-from-0.1.sh` writes `backups/pre-0.2-migration-<timestamp>/` containing
`cluster.sql` (a `pg_dumpall --no-role-passwords` of the whole cluster) and `paperclip-home.tgz`.
That is **not** a `scripts/backup.sh` archive and `scripts/restore.sh` cannot read it: at that point
in the migration the `kyoubeai` role and database do not exist yet — the cluster is still
`paperclip` — so `backup.sh`, which dumps the `kyoubeai` database as the `kyoubeai` role, cannot run.
It is a last resort behind the backup you took with the 0.1.x checkout; restore it by hand, onto an
**empty** cluster:

```bash
SNAP=backups/pre-0.2-migration-<timestamp>
docker compose down                    # stop everything
docker volume rm <project>_pgdata      # the cluster must be empty; postgres-init re-bootstraps it
docker compose up -d --wait db
docker compose exec -T db psql -U kyoubeai -d postgres -f - < "$SNAP/cluster.sql"
```

`psql` is deliberately run without `ON_ERROR_STOP`: `pg_dumpall` output recreates roles and databases
the freshly bootstrapped cluster already has, and those "already exists" errors are expected.

`cluster.sql` carries no passwords (that is what `--no-role-passwords` buys: no role password hashes
sitting in `./backups`), so re-set the two the deployment uses. Read them inside the container from
its own environment, exactly as `scripts/restore.sh` does, so they never reach your shell history:

```bash
docker compose exec -T db sh -c 'psql -U kyoubeai -d postgres -q -v ON_ERROR_STOP=1 -f -' <<'SQL'
\set pw `echo "$POSTGRES_PASSWORD"`
ALTER ROLE paperclip PASSWORD :'pw';
SQL
docker compose exec -T db sh -c 'psql -U kyoubeai -d postgres -q -v ON_ERROR_STOP=1 -f -' <<'SQL'
\set pw `echo "$KYOUBE_DB_PASSWORD"`
ALTER ROLE kyoube PASSWORD :'pw';
SQL
```

(The first role is `paperclip` if you are restoring to the pre-migration state, `kyoubeai` if the
rename had already happened; adjust the `-U` user the same way.) Then put the home volume back and
start the app:

```bash
docker run --rm -i -v <project>_paperclip-home:/to alpine:3.20 \
  sh -c 'rm -rf /to/..?* /to/.[!.]* /to/* 2>/dev/null; exec tar xzf - -C /to' \
  < "$SNAP/paperclip-home.tgz"
docker compose up -d
```

The Kyoube plugin's own `kyoube_meta` migrations are **checksummed** as well as forward-only. Each
file's SHA-256 is recorded in `kyoube_meta.migrations` when it is applied, and the worker refuses to
start if an already-applied file has changed:
`migration 0001_meta.sql was modified after being applied`. So:

- Never edit a migration that has shipped. Add a new numbered file instead.
- If you hit that error after switching branches or rolling back, the database is ahead of the code.
  Go back to the newer code, or restore a backup taken before the migration ran. Editing the
  checksum row to make the error go away leaves the schema and the code disagreeing silently.
