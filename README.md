# KyoubeAI

**A multi-user AI operating system for organisations.**
KyoubeAI turns one Docker Compose stack into a shared workspace where a whole company signs in, agents
(Claude Code, pi, or Hermes Agent) design and populate a real Postgres-backed database under the same
permission model people use, and anyone can then open the CRMs, trackers, and dashboards those agents
built as ordinary pages in the browser — all without patching the core it runs on.

## Screenshots

Not captured yet — the Data, Apps and Terminal pages land here as `docs/images/*.png` after the
first run of a prebuilt image.

## Features

- **[Terminal](#terminal)** — a browser shell for company owners/admins to authenticate agent harnesses
  and administer the box. Security model: [`SECURITY.md`](SECURITY.md#terminal).
- **[Data](#data)** — a per-company Postgres database that people and agents design and populate, with
  tools, REST, a UI, and per-agent grants. Recommended access policies:
  [`docs/governance.md`](docs/governance.md).
- **[Apps](#apps)** — AI-built, database-backed single-file apps that run sandboxed inside the KyoubeAI
  UI. Authoring guide: [`docs/apps.md`](docs/apps.md).
- **[Files](#files)** — a **Files** tab on every project page: browse, edit, upload, rename and delete
  the folders and files in the project's working folder — the same folder its agents read and write.
- **[Studio](#studio)** — KyoubeAI's own design: a Home page that opens with what needs you and what
  your team is doing, a calmer sidebar with a live team roster, one Workspace page for everything you
  don't need every day, and a face for every agent. How it survives core updates:
  [`docs/theme.md`](docs/theme.md).
- **Operations** — backups/restore, health checks, resource limits, and upgrading the core and KyoubeAI
  independently: [`docs/operations.md`](docs/operations.md), [`docs/upgrading.md`](docs/upgrading.md).
- **Architecture** — trust zones, request paths, the data model, and the upgrade contract, in full:
  [`docs/architecture.md`](docs/architecture.md).

## Quickstart

Requirements: Docker Engine 24+ with Compose v2, 4 GB RAM.

```bash
git clone https://github.com/jknigel/KyoubeAI.git && cd KyoubeAI
cp .env.example .env
# fill BETTER_AUTH_SECRET, POSTGRES_PASSWORD, KYOUBE_DB_PASSWORD (openssl rand -hex 32)
docker compose up -d --build
```

This builds the image from source. To run a published release instead, set `KYOUBE_IMAGE=ghcr.io/jknigel/kyoubeai` and `KYOUBE_VERSION` (a release tag, e.g. `1.0.0`) in `.env` and pull it rather than building:

```bash
docker compose pull && docker compose up -d
```

Release tags (`1.0.0`, and `latest`) are built for linux/amd64 and linux/arm64; the `sha-<commit>`
tags a push to `main` publishes are amd64-only test images, not release artefacts
([docs/upgrading.md](docs/upgrading.md#upgrading-kyoubeai)). Run the `pull` as its own step and
check that it succeeded: a GHCR package is private until someone makes it public, and after a
denied pull `docker compose up -d` silently builds from source instead — see
[docs/operations.md](docs/operations.md#the-published-image-on-ghcr).

If you publish the UI on a localhost/127.0.0.1 port other than 3100, also set `BETTER_AUTH_TRUSTED_ORIGINS` in `.env` to the exact origin people type into the browser (for example `http://localhost:3199`): the core rewrites a loopback `KYOUBE_PUBLIC_URL` back to its internal port, so it would otherwise reject sign-ins from the published port.

The compose port binding listens on every interface, so reaching the UI from another machine works out of the box — but set `KYOUBE_PUBLIC_URL` to the exact address those people type (for example `http://192.168.1.10:3100` or `https://kyoube.example.com`), or sign-in and the `kyoube setup` approval link will point at the wrong host.

1. Open http://localhost:3100, sign up, and claim the instance (you become the instance admin).
2. Install the Kyoube plugins (one-time):
   ```bash
   docker compose exec app kyoube setup
   ```
   Approve the login link it prints. From then on plugins install and upgrade automatically at start-up.
3. Check everything: `docker compose exec app kyoube doctor`.
4. Authenticate the agent harnesses: either put provider API keys in `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`) or, once the Terminal plugin is installed, run `claude login`, `pi`, and `hermes setup` from the Terminal page. Credentials persist on the `kyoubeai-home` volume. The first-run wizard's **Connect a model** step checks the harness you pick. An API key typed there works at once; a Claude or OpenAI subscription cannot be signed in from the wizard on a KyoubeAI server, so if nothing is signed in yet choose **Skip for now and connect the harness later from the Terminal page** — the agent is created anyway, and it starts working once the harness is logged in from the Terminal page.

## Studio

KyoubeAI opens dark, in the palette and type of the KyoubeAI website. The sidebar keeps what you use
every day: a search field, one **New task** button, Home, Inbox, Tasks and Projects, a **Build** group
(Data, Apps, Routines) and a **Team** roster where every agent has a face, a live status dot and a line
saying what it is doing. Everything else (All agents and the org chart, Audit, Timeline, Costs,
Approvals, Skills, Artifacts, Connectors, Settings, and for owners and admins Plugins and Terminal) is
on the **Workspace** page at the bottom of the sidebar, and still one ⌘K away.

**Home** replaces the stock dashboard's top half: how many things need you, a getting-started strip for
new workspaces, **Needs you** (approvals, reviews, blocked tasks, agents in error), **Your team right
now** and **Latest updates**, with the core's metrics and charts below. An agent's face comes from the
icon picked in its settings and its name.

Each agent has a **profile** (`/<company>/team/<agent>`): its character and status, whom it reports to,
an **On duty** switch, **Chat** and **Assign task**, what it is working on now with its latest notes,
recent work, the week's numbers, its skills and who it works with. Every link to an agent opens the
profile; its Instructions, Skills and Settings tabs open the core's own agent views, and Runs opens
the agent's runs under Audit.

It is two parts, neither of which edits the core: `docker/theme/` (a build-time stylesheet, boot flag
and label renames, checked against every core bump) and the `kyoube.studio` plugin. If the plugin is
missing the app falls back to the stock layout. [`docs/theme.md`](docs/theme.md) has the details.

## Terminal

Company owners and admins see a **Terminal** card on the **Workspace** page. It opens a shell inside the `app` container as the `node` user with `HOME=/kyoubeai` (the persisted volume), so `claude login`, `pi`, and `hermes setup` store credentials that survive restarts. Sessions are audited (open/close/kill, never content), idle sessions close after 30 minutes, and a session survives page reloads — use **attach** under *Sessions in this company*. Adjust roles, timeouts, and the shell under Settings → Plugins → Kyoube Terminal.

Security note: the terminal is equivalent to shell access to the whole instance (database credentials, every agent's tokens). Keep `allowedRoles` tight and use it only over private networks or TLS.

## Data

Every company gets its own isolated PostgreSQL schema in the `kyoube` database (separate from the core's own database). People use it from the **Data** page; agents use the REST routes under `/api/plugins/kyoube.apps/api/` with the `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` and `PAPERCLIP_COMPANY_ID` every run already carries, guided by the managed **Kyoube Data** skill. The same operations exist as `kyoube.apps:data_*` tools, but the core (2026.831.1 through 2026.916.1) only hands those to a run through an MCP gateway, which it creates only for agents that already have an MCP connection — so the skill leads with the API.

**Giving an agent access takes two steps.** The **Kyoube Data** and **Kyoube Apps** skills land in every company's skill library by themselves: `kyoube ensure-plugins` installs them into every company at each container start, the first visit to a company's pages does the same, and a company created later gets them on creation (`kyoube setup` and `kyoube doctor` confirm it). Then, per agent: enable the skills on the agent's **Skills** tab, and grant a level under **Company Settings → Data access**. Enabling a skill only puts its text in front of the agent; nothing runs until a task calls for company data.

Access levels are `none < read < write < schema`. People inherit theirs from their company role; agents get an explicit level or the company default (`none`) under **Company Settings → Data access**. Dropped tables and fields are kept for 30 days unless hard deletes are enabled. Every mutation is audited in `kyoube_meta.audit` and summarised in the activity log.

Read-only SQL (`data_sql_select`, `POST /sql`) may reference only that company's own tables, by bare name: schema-qualified names, Postgres catalogs and `information_schema` are rejected before the query runs, so introspection goes through `data_describe_table`. It may also call only an allowlist of pure builtin functions (aggregates, string/math/date helpers, JSON and array helpers, window functions) — no `pg_*` function, and no cast to a `reg*` OID alias type.

Tip: pair this with the core's tool policies (Tools & Access) to require human approval for `kyoube.apps:data_drop_table` and `kyoube.apps:data_remove_field` — but note that those policies only see calls that go through the core's MCP gateway. An agent calling the REST routes is governed by its Kyoube access level alone, so keep builders at `write` until you trust them with `schema`.

## Apps

Apps are single-file HTML applications that run inside the KyoubeAI UI (`/<company>/app-artifact`; the sidebar entry is still **Apps**) and use the company's Data tables through an injected `window.kyoube` SDK. Agents build and publish them through the same REST routes (or the `kyoube.apps:apps_*` tools where a gateway exists), guided by the **Kyoube Apps** managed skill; people can review source and versions, publish, and roll back from the app page. A Content-Security-Policy — not the sandbox attribute — blocks all network access; apps run at an opaque origin (no cookies, no storage) and can never exceed the permissions of the person using them. See `docs/apps.md`.

## Files

Every project has a working folder: the workspace configured on the project, or — when none is — the
folder the core creates for it the first time an agent works on one of its tasks
(`/kyoubeai/instances/default/projects/<companyId>/<projectId>/_default`). Agents run in that folder; what
they write there is the project's work product. The **Files** tab on a project page (and the **Files**
link under each project in the sidebar) shows that folder to people: open and edit text files, preview
Markdown, images and SVG, create files and folders, upload, download, rename and delete. An HTML file
opens as the page it is — rendered in a sandboxed frame with no network, with the stylesheets, scripts
and images it references from the same folder inlined — and a **View/Edit source** toggle shows the
markup. The listing and any open file refresh themselves every few seconds, so an agent's changes appear
as they land; a save carries the modification time the file had when it was opened and is refused if an
agent changed it since, with a choice to reload or overwrite. Symbolic links are listed but never
followed, and no path can leave the project folder.

The same folder is one click away while working with an agent: on any task that belongs to a project,
a folder icon at the right end of the top bar (the one that reads *Tasks › BAP-12 …*) docks the
project folder in a panel on the right of the screen, with the same browser and editor. The panel has
no backdrop — the chat stays usable beside it — and it follows you from task to task, switching to
each task's project, until you close it.

Who may do what is a per-instance setting (**Settings → Plugins → Kyoube Files**): by default every
company role can browse and download, and everyone but `viewer` can change files. Files larger than
1 MiB open as download-only rather than in the editor, and single uploads are capped at 5 MiB (the core's
JSON body limit keeps the ceiling at 7); larger transfers belong in the Terminal or with an agent. Every
change is written to the company's activity log with its path, never its content.

## Layout

| Path | What it is |
|---|---|
| `docker/Dockerfile` | Overlay image: the upstream core + pinned `claude`, `pi` and `hermes` CLIs + Kyoube |
| `docker/bootstrap/` | The `kyoube` CLI (`setup`, `ensure-plugins`, `doctor`) |
| `plugins/` | Core plugins (`kyoube-terminal`, `kyoube-apps`, `kyoube-files`, `kyoube-studio`) |
| `docker/theme/` | The build-time Studio theme: tokens, a gated skin, label renames (`docs/theme.md`) |
| `packages/kyoube-app-sdk/` | `window.kyoube`, the SDK injected into every app |
| `docker-compose.yml` | `app` + `db` (Postgres 17 with databases `kyoubeai` and `kyoube`) |
| `scripts/smoke.sh` | End-to-end smoke test used by CI |
| `scripts/backup.sh`, `scripts/restore.sh` | Backup and restore of both databases, the Kyoube roles, and the home volume |
| `scripts/check-pins.sh`, `scripts/bump-core.sh` | Keep the core image and plugin-SDK version pins in lock-step |
| `docs/architecture.md` | Trust zones, request paths, the data model, and the upgrade contract |
| `docs/apps.md` | App authoring guide (manifest, `window.kyoube`, security model) |
| `docs/operations.md` | Volumes, backups, restore, logs, health, key rotation, limits |
| `docs/upgrading.md` | Upgrading KyoubeAI and the core, and rolling back |
| `docs/governance.md` | Recommended agent tool profiles and policies |
| `docs/superpowers/` | Design spec and implementation plans |
| `SECURITY.md` | The security model and how to report a vulnerability |
| `CONTRIBUTING.md` | Local setup, conventions, and how to add a tool |

## Operating and updating

Take a backup before any upgrade: `bash scripts/backup.sh` writes both database dumps, the
cluster-level Kyoube roles, and the `/kyoubeai` home volume to `backups/<timestamp>/`;
`bash scripts/restore.sh backups/<timestamp>` puts them all back, onto this cluster or a brand-new
one. See **[docs/operations.md](docs/operations.md)** for what lives where, cron and off-site
copies, logs, health, rotating the board key, and resource limits.

- **The core:** run `scripts/bump-core.sh <version>` (bumps the Dockerfile pin, `.env.example`, `scripts/smoke.env`, and every plugin's `@paperclipai/plugin-sdk` pin together, then reinstalls); copy the new `KYOUBE_CORE_VERSION` into your own `.env`, then `docker compose up -d --build`.
- **KyoubeAI:** from source, `git pull && docker compose up -d --build`. To run a prebuilt image instead, bump `KYOUBE_VERSION` (and set `KYOUBE_IMAGE`) in `.env`, then `docker compose pull && docker compose up -d`. Plugins are re-installed automatically when their version changes.

Full instructions, what to read before a core bump, and how to roll back (databases migrate
forward only — restore from backup) are in **[docs/upgrading.md](docs/upgrading.md)**.

## How it stays upstream-compatible

- The image is built `FROM` a pinned upstream release of the core (Paperclip, `KYOUBE_CORE_VERSION`);
  nothing in this repository is core source. At build time the core gets presentation-only
  transforms that are re-applied to the pristine layer on every build and fail it when upstream moves
  what they rely on: the branding in `docker/rebrand/` (`docs/branding.md`) and the Studio theme in
  `docker/theme/` (`docs/theme.md`), plus any temporary bug fix in `docker/core-patches/` while its
  upstream fix is pending.
- Every Kyoube feature is a plugin (`kyoube.terminal`, `kyoube.apps`, `kyoube.files`) built only against the published
  `@paperclipai/plugin-sdk` — no imports from the core's own server or UI source, no undocumented routes.
- `KYOUBE_CORE_VERSION` and the plugin SDK version are pinned together across the Dockerfile, `.env.example`,
  `scripts/smoke.env`, `docker-compose.yml`, and every plugin's `package.json`. `scripts/check-pins.sh`
  fails CI the moment any of them drift apart; `scripts/bump-core.sh <version>` bumps all of them in
  one pass.
- The image sets `DO_NOT_TRACK=1` and `DISABLE_TELEMETRY=1` in the container, and the terminal
  plugin sets the same two in every shell it spawns (which does not inherit the container's
  environment), turning off the core's own opt-out telemetry (on by default) and Claude
  Code's, in the server and in a Terminal session alike. That is not the same as telemetry-free:
  the image bundles third-party harnesses this project does not build. What was verified, and what
  could not be, is in [`SECURITY.md`](SECURITY.md#telemetry).
- A weekly CI job (`upstream-beta`) builds and smoke-tests this repo against the core image's `:beta`
  channel and opens an issue the moment something upstream would break the plugins — before it ever
  reaches a stable version bump.

See [`docs/architecture.md`](docs/architecture.md) for the full upgrade contract and
[`docs/upgrading.md`](docs/upgrading.md) for the bump procedure itself.

## Development

```bash
pnpm install     # corepack enable first is optional — plain pnpm switches to the pinned version itself
pnpm test        # unit tests for the bootstrap CLI and plugins
pnpm build       # builds dist/ for every package
pnpm smoke       # full docker smoke test (needs docker, curl, jq)
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the integration test setup, commit conventions, and how to
add a tool.

## Roadmap

Deferred from v1, in rough order of how often it comes up:

- **Multi-file apps.** Today an app is exactly one HTML document; multi-file/multi-page bundles are a
  natural extension of the existing version storage.
- **Realtime table updates.** Apps currently re-query for fresh data; a `data.subscribe` call in the app
  SDK (polling under the hood, at first) is designed for but not yet built.
- **`ui.confirm` and `theme`** in the app SDK, and a **"Preview draft"** button so a person can preview an
  unpublished app version without publishing it first.
- **Dashboard-widget apps.** The underlying core UI slot exists; wiring an app manifest's `surfaces`
  to it is not yet done.
- **An upstream proposal** to make the core's bundled-plugin allowlist operator-configurable, so the
  one-time `kyoube setup` step is no longer needed on first boot.

## License

KyoubeAI is free software under the GNU Affero General Public License, version 3 (`AGPL-3.0-only`).
`LICENSE` carries the full text; `NOTICE.md` carries the copyright line and third-party notices.
Running KyoubeAI for your own organisation, at any size, is free. If you modify it and let people
use your modified version over a network, the AGPL requires you to offer them the modified source.
Commercial licences on other terms are available on request.

## Built on

KyoubeAI is built on the [Paperclip](https://github.com/paperclipai/paperclip) engine (MIT, © Paperclip AI; notice in `NOTICE.md`), consumed as a published image and rebranded at build time; see `docs/branding.md` for what that transform does and does not change.
