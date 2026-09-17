# KyoubeAI — Architecture & Delivery Plan

**Status:** draft for review · **Date:** 2026-09-05 · **Scope:** whole project (architectural design; each phase gets its own implementation plan)

KyoubeAI is an open-source, multi-user "AI operating system for organisations": Paperclip at the core, a dedicated PostgreSQL server, three agent harnesses (Claude Code, pi, Hermes Agent) pre-installed, and three Kyoube-specific capabilities — an admin web terminal, an agent-writable organisation database, and an "Apps" module for AI-built, database-backed applications (CRMs, ERPs, …). Everything runs in Docker and nothing Kyoube adds is lost when Paperclip is upgraded.

---

## 0. Verdict

The idea is sound and, more importantly, **buildable without forking Paperclip**. Every custom feature maps onto an extension surface Paperclip already ships and documents as stable-for-plugins:

| Requirement | How it is met | Upstream fact it relies on |
|---|---|---|
| Paperclip at the core, multi-user, local Postgres, all in Docker | Our image is `FROM ghcr.io/paperclipai/paperclip:<pinned>`; compose adds Postgres 17; `PAPERCLIP_DEPLOYMENT_MODE=authenticated` | Upstream publishes versioned images and already ships exactly this compose shape (`docker/docker-compose.yml`) |
| Claude Code, pi, Hermes as harnesses | Upstream has first-party adapters `claude_local`, `pi_local`, `hermes_local`; we only add the two missing CLIs to the image | `packages/adapters/{claude-local,pi-local,hermes}` |
| Admin-only web terminal | A Paperclip **plugin** (`@kyoube/plugin-terminal`): xterm.js page + node-pty in the plugin worker, gated to company owners/admins | Plugin UI pages, worker actions, SSE streams, `access.members.read` |
| Agents create tables/records with the right permissions | A second plugin (`@kyoube/plugin-apps`) owns a **separate** `kyoube` Postgres database; exposes schema/row operations as agent tools (MCP), REST routes and a managed skill; per-agent grant levels | Plugin agent tools are served to local adapters through Paperclip's runtime-tools MCP gateway; scoped plugin API routes support `board-or-agent` auth; plugins can ship managed skills |
| Apps module (runnable, DB-backed artifacts) | Same plugin: versioned single-file HTML apps stored in Postgres, rendered in a sandboxed iframe, talking to the data layer through a `postMessage` SDK | Plugin `page` slots, `usePluginData` / `usePluginAction` bridge |
| Custom features survive upstream updates | Zero patches to Paperclip. Our code lives in plugins (stable `@paperclipai/plugin-sdk`, `apiVersion: 1`) and a thin Docker overlay | Plugin spec §29 versioning rules; SDK published on npm as CalVer (`2026.831.1`) |

The main things that are *not* free, and shape the design:

1. **Runtime DDL is not allowed through the plugin database API** (`ctx.db` only permits DDL in install-time migration files; runtime calls are SELECT/INSERT/UPDATE/DELETE inside a plugin namespace). So the organisation database is a **separate Postgres database** that our worker connects to directly, with our own guard rails (identifier validation, type whitelist, per-company schemas and roles, statement timeouts).
2. **Plugin workers do not inherit the server environment** (only `PATH`, `NODE_PATH`, `NODE_ENV`, `TZ`, `PAPERCLIP_PLUGIN_ID`). Connection strings and `HOME` for spawned shells are supplied via a config file written by our entrypoint, not via env.
3. **Installing a plugin requires an instance admin**, and the built-in "bundled plugin auto-install" is a hard-coded allowlist. So first boot needs one explicit `kyoube setup` step (or a board API key in `.env`); after that, upgrades are automatic.
4. **Plugin UI is same-origin, trusted code** (not sandboxed). That is fine for our own plugins but means AI-generated **apps must never run as plugin UI** — they run in opaque-origin iframes with no direct API access.
5. The plugin system is labelled alpha and upstream moves fast (tens of merges a day). We pin the image and SDK to the same CalVer and run a weekly CI build against `:beta` to catch breakage before it reaches us.

Licensing is clean: Paperclip is MIT; KyoubeAI will be MIT and retain the upstream notice.

---

## 1. Goals and non-goals

**Goals**

- One-command bring-up: `docker compose up -d`, sign up as the first admin, run `kyoube setup`, authenticate harnesses from the browser.
- Multi-user from day one (Paperclip `authenticated` mode, Better Auth, company memberships and roles).
- Agents (with permission) can design and populate an organisation database and build/publish apps on top of it, entirely from inside Paperclip tasks.
- Humans use those apps inside the Paperclip UI, with the same identity and roles.
- Upgrading Paperclip is a one-line version bump; upgrading Kyoube is a `docker compose pull`.
- Repository is safe to open-source: no data, no secrets, no bind-mounted state in the tree.

**Non-goals (v1)**

- Multi-file / multi-page app bundles, server-side app code, app marketplaces.
- Sandboxed (remote) agent execution — agents run inside the app container as today's upstream local adapters do.
- Row-level security inside a company (permissions are per company, per table, per actor level).
- Replacing Paperclip's own artifact/attachment features.
- TLS termination (documented as an optional Caddy profile, not required).

---

## 2. Assumptions and decisions taken

These were made without live input; each has a default and is easy to change.

| # | Decision | Default taken | Alternative |
|---|---|---|---|
| D1 | "Entire container" | A **compose stack of two services** (`app`, `db`) — all in Docker, Postgres dedicated | Single image with embedded Postgres (upstream quickstart style); less operable, not recommended |
| D2 | Plugin packaging | **Two plugins**: `@kyoube/plugin-terminal` (privileged, small) and `@kyoube/plugin-apps` (data + apps together, because apps need in-process access to the data layer and plugins cannot RPC each other) | Three plugins (data, apps split) — impossible without an out-of-band channel |
| D3 | Terminal transport | **Host bridge** (keystrokes via plugin actions, output via `terminal.wait` long-poll actions) — zero extra infrastructure, works through any proxy. *Revised 2026-09-10:* the plugin SSE stream bridge this row originally named is declared upstream but never wired in 2026.831.1 (see §7) | Dedicated WebSocket on a second port behind a reverse proxy (lower latency); kept as an upgrade path |
| D4 | App format v1 | **Single-file HTML** (HTML+CSS+JS in one document, no external network), like a Claude artifact | Multi-file bundles with an asset store (v2) |
| D5 | Organisation database | **Separate Postgres database `kyoube`** in the same Postgres server, one schema and one NOLOGIN role per company | Use plugin namespace (blocked: no runtime DDL) |
| D6 | First-boot plugin install | **`kyoube setup`** run once by the first admin (CLI auth challenge approved in the browser); board API key stored on the data volume for future automatic upgrades. `KYOUBE_BOARD_API_KEY` in `.env` supported for unattended setups | Upstream PR to make the bundled-plugin allowlist operator-configurable (would make this zero-touch; worth proposing later) |
| D7 | Licence | MIT | — |
| D8 | Upstream pin at start | `ghcr.io/paperclipai/paperclip:2026.831.1` + `@paperclipai/plugin-sdk@2026.831.1` (latest stable on 2026-09-05; verify the image tag exists at Phase 0) | `:latest` (not reproducible) |

---

## 3. What Paperclip already provides (research findings)

Facts verified against the upstream repo at commit `184b014` (2026-09-04):

- **Deployment:** `Dockerfile` (Node 24, Debian trixie-slim) pre-installs `claude`, `codex`, `opencode`, `gemini`, `kimi`; `HOME=/paperclip` is the persisted volume; `tini` is PID 1; `scripts/docker-entrypoint.sh` remaps UID/GID and drops to user `node` via `gosu`. Compose reference (`docker/docker-compose.yml`) runs Postgres 17 + server with `PAPERCLIP_DEPLOYMENT_MODE=authenticated`, `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`, `BETTER_AUTH_SECRET`. Images ship on four channels; stable images carry `:YYYY.MDD.P` tags and every image has `:sha-<short>`.
- **Multi-user:** `authenticated` mode (private/public exposure), Better Auth, first sign-up claims `instance_admin`, company membership roles `owner | admin | operator | member | viewer`, per-principal permission grants, invites, CLI board login via approval challenge, board API keys.
- **Adapters:** `claude_local` (session resume, skills injection), `pi_local` (binary `pi`, npm `@earendil-works/pi-coding-agent`), `hermes_local` (runs `hermes chat -q … -Q`; Hermes installs via `https://hermes-agent.nousresearch.com/install.sh`, supports `--non-interactive`, `--dir`, `HERMES_HOME`; Python ≥3.10, managed `uv`).
- **Plugin system (implemented):** npm package with `manifest`, out-of-process Node `worker` (JSON-RPC over stdio), optional React `ui` bundle (ESM; `react`, `react-dom`, `@paperclipai/plugin-sdk/ui` are host-provided externals). UI slots include `page` (company route `/:companyPrefix/<routePath>`), `sidebar`, `routeSidebar`, `settingsPage`, `companySettingsPage`, `dashboardWidget`, `detailTab`, launchers (modal overlays). Worker SDK: `ctx.data` / `ctx.actions` (bridge, with host-resolved actor context `{type:user|agent, userId, agentId, runId, companyId}`), `ctx.streams` (SSE to UI), `ctx.tools` (agent tools), `apiRoutes` (JSON routes under `/api/plugins/:pluginId/api/*`, `auth: "board-or-agent"`, sanitised headers), `ctx.access.members` (`access.members.read`), `ctx.activity`, `ctx.state`, `ctx.db` (namespace; migrations-only DDL), managed agents/projects/routines/**skills**, events, jobs, webhooks. Local-path installs are hot-reloaded from `dist/`. Install endpoint `POST /api/plugins/install` is instance-admin only.
- **Agent tools → agents:** plugin tools are namespaced `<pluginId>:<tool>` and surfaced through the tool gateway (`providerType: "paperclip_plugin"`); local adapter runs receive an MCP endpoint (`/mcp/runtime-tools`) with a short-lived token. Tool profiles/policies (allow, block, `require_approval`, rate limits, trust rules) and an append-only call audit exist.
- **Existing terminal-ish surfaces:** xterm.js is used only for *sandbox environment* login flows (Codex device login, Claude setup-token). There is no local-runtime web shell — our terminal fills a real gap and does not collide.
- **Artifacts upstream:** issue attachments + "work products" (files, workspace file refs). Not runnable, not DB-backed — no overlap with Apps.

---

## 4. Architecture overview

```
┌──────────────────────────── docker compose ────────────────────────────┐
│                                                                        │
│  ┌──────────────── app (kyoubeai image) ───────────────┐   ┌────────┐  │
│  │ FROM ghcr.io/paperclipai/paperclip:<pin>            │   │  db    │  │
│  │                                                     │   │ PG 17  │  │
│  │  Paperclip server + UI  ── DATABASE_URL ───────────────▶│paperclip│ │
│  │   ├─ adapters: claude_local / pi_local / hermes_local│  │        │  │
│  │   ├─ plugin runtime                                 │   │ kyoube │◀┐│
│  │   │   ├─ worker: @kyoube/plugin-terminal (node-pty) │   └────────┘ ││
│  │   │   └─ worker: @kyoube/plugin-apps  ──────────────────────────────┘│
│  │   └─ MCP runtime-tools gateway ◀── agent runs        │              │
│  │                                                     │              │
│  │  CLIs on PATH: claude, pi, hermes (+codex, opencode…)│              │
│  │  kyoube-bootstrap (background): ensure plugins       │              │
│  │  volume /paperclip: PG creds, ~/.claude ~/.pi ~/.hermes, plugin data│
│  └─────────────────────────────────────────────────────┘              │
└────────────────────────────────────────────────────────────────────────┘
        ▲ :3100                       browser: Paperclip UI + Kyoube pages
```

Three trust zones:

1. **Paperclip core** — untouched upstream code and its `paperclip` database.
2. **Kyoube plugins** — trusted code we ship, running as separate worker processes; the only place with credentials to the `kyoube` database.
3. **Apps** — untrusted, AI-generated HTML running in opaque-origin iframes; can only talk to the plugin UI via `postMessage`, which forwards to the worker with the viewer's identity.

---

## 5. Repository layout

```
KyoubeAI/
├─ README.md · LICENSE (MIT, + upstream notice) · CONTRIBUTING.md · SECURITY.md
├─ .env.example · .gitignore · .dockerignore · .editorconfig
├─ docker-compose.yml               # app + db; named volumes only
├─ docker-compose.override.example.yml  # optional: bind-mount data dir, Caddy TLS profile
├─ docker/
│  ├─ Dockerfile                    # multi-stage: build plugins → FROM upstream image + CLIs + plugins + bootstrap
│  ├─ entrypoint.sh                 # writes /paperclip/kyoube/config.json, starts bootstrap, execs upstream entrypoint
│  ├─ postgres-init/01-kyoube.sql   # creates role + database `kyoube`
│  └─ bootstrap/                    # `kyoube` CLI (setup, ensure-plugins, doctor) — small Node script
├─ plugins/
│  ├─ kyoube-terminal/              # @kyoube/plugin-terminal
│  └─ kyoube-apps/                  # @kyoube/plugin-apps (data + apps)
├─ packages/
│  └─ kyoube-app-sdk/               # window.kyoube runtime injected into apps + .d.ts + docs for agents
├─ skills/                          # SKILL.md files shipped as plugin-managed skills (data, apps)
├─ docs/                            # architecture, ops (backup/upgrade), app authoring guide
├─ scripts/                         # dev helpers (build, smoke test)
├─ package.json · pnpm-workspace.yaml · tsconfig.base.json
└─ .github/workflows/               # build image, test plugins, weekly build against :beta
```

Nothing in the tree is runtime state. `.gitignore` excludes `.env`, `data/`, `dist/`, `node_modules/`.

---

## 6. Deployment

### 6.1 Image (`docker/Dockerfile`)

```
ARG PAPERCLIP_VERSION=2026.831.1

FROM node:24-trixie-slim AS plugin-build
  # pnpm install + build plugins/* and packages/* → dist/ + pruned prod node_modules

FROM ghcr.io/paperclipai/paperclip:${PAPERCLIP_VERSION}
  USER root
  # pi
  RUN npm install -g @earendil-works/pi-coding-agent@0.85.0
  # Hermes: python3 + venv + installer (non-interactive) into a NON-volume path
  RUN apt-get install -y python3 python3-venv git && \
      HERMES_INSTALL_DIR=/opt/hermes/hermes-agent HERMES_HOME=/opt/hermes/home \
      bash -c "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --non-interactive --dir /opt/hermes/hermes-agent" \
      # then symlink the launcher the installer creates onto PATH as `hermes` (exact path confirmed in Phase 0)
  # Kyoube
  COPY --from=plugin-build /src/plugins/kyoube-terminal /opt/kyoube/plugins/terminal
  COPY --from=plugin-build /src/plugins/kyoube-apps     /opt/kyoube/plugins/apps
  COPY docker/bootstrap /opt/kyoube/bootstrap   && ln -s … /usr/local/bin/kyoube
  COPY docker/entrypoint.sh /usr/local/bin/kyoube-entrypoint.sh
  ENV HERMES_HOME=/paperclip/.hermes  KYOUBE_PLUGIN_ROOT=/opt/kyoube/plugins
  ENTRYPOINT ["/usr/bin/tini","--","kyoube-entrypoint.sh"]
  CMD ["node","--import","./server/node_modules/tsx/dist/loader.mjs","server/dist/index.js"]   # upstream CMD, unchanged
```

Notes:

- Anything a harness writes at runtime (OAuth tokens, config) must land under `/paperclip` (the volume): `~/.claude`, `~/.pi`, `~/.hermes`. Hermes *code* is installed under `/opt/hermes` because `/paperclip` is shadowed by the volume at runtime; the entrypoint seeds `/paperclip/.hermes` (including the managed `uv` binary Hermes expects under `$HERMES_HOME/bin`) on first boot. This split must be verified in Phase 0 — it is the one Hermes-specific risk.
- `node-pty` for the terminal: prefer `@lydell/node-pty` (prebuilt binaries for linux x64/arm64) to avoid a compiler in the runtime image.
- Upstream's tools layer installs CLIs at `@latest` at *their* build time; we accept their pinned image and only add what is missing.

### 6.2 Compose (`docker-compose.yml`)

```yaml
services:
  db:
    image: postgres:17-alpine
    environment: { POSTGRES_USER: paperclip, POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}, POSTGRES_DB: paperclip }
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/postgres-init:/docker-entrypoint-initdb.d:ro   # creates `kyoube` role + database
    healthcheck: pg_isready
  app:
    build: { context: ., dockerfile: docker/Dockerfile, args: { PAPERCLIP_VERSION: ${PAPERCLIP_VERSION} } }
    image: ghcr.io/<org>/kyoubeai:${KYOUBE_VERSION:-dev}
    pids_limit: 2048
    ports: ["${KYOUBE_PORT:-3100}:3100"]
    environment:
      DATABASE_URL: postgres://paperclip:${POSTGRES_PASSWORD}@db:5432/paperclip
      KYOUBE_DATABASE_URL: postgres://kyoube:${KYOUBE_DB_PASSWORD}@db:5432/kyoube
      PAPERCLIP_DEPLOYMENT_MODE: authenticated
      PAPERCLIP_DEPLOYMENT_EXPOSURE: ${PAPERCLIP_DEPLOYMENT_EXPOSURE:-private}
      PAPERCLIP_PUBLIC_URL: ${PAPERCLIP_PUBLIC_URL:-http://localhost:3100}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?set in .env}
      KYOUBE_BOARD_API_KEY: ${KYOUBE_BOARD_API_KEY:-}      # optional, unattended setup
      ANTHROPIC_API_KEY / OPENAI_API_KEY / …: optional        # alternative to browser login
    volumes: [ paperclip-home:/paperclip ]
    depends_on: { db: { condition: service_healthy } }
volumes: { pgdata: {}, paperclip-home: {} }
```

`.env.example` documents every variable; `BETTER_AUTH_SECRET` and the two DB passwords are generated by the user (`openssl rand -hex 32`). An optional `caddy` profile in the override example terminates TLS for `authenticated/public` deployments.

### 6.3 Runtime config file

Because plugin workers get no env, `kyoube-entrypoint.sh` renders `/paperclip/kyoube/config.json` (mode 600, owner `node`) from env at every boot:

```json
{ "dataDatabaseUrl": "postgres://kyoube:…@db:5432/kyoube",
  "home": "/paperclip", "hermesHome": "/paperclip/.hermes",
  "pluginRoot": "/opt/kyoube/plugins", "version": "<image version>" }
```

Both plugin workers read this file at startup (path fixed; overridable with `KYOUBE_CONFIG_PATH` for local development).

### 6.4 Bootstrap and plugin installation

`kyoube-bootstrap` (started by the entrypoint as user `node`, supervised by tini) loops:

1. Wait for `GET /api/health` to be `ok`.
2. Resolve a board API key: `KYOUBE_BOARD_API_KEY` env, else `/paperclip/kyoube/board-key.json`. If none, log a clear one-line instruction (`docker compose exec app kyoube setup`) and re-check every 60 s.
3. With a key: `GET /api/plugins`; for each Kyoube plugin that is missing (or soft-uninstalled), `POST /api/plugins/install { packageName: "/opt/kyoube/plugins/<name>", isLocalPath: true }`; for one whose stored `version` differs from `dist/manifest.js`, `POST /api/plugins/:pluginId/upgrade` (upstream re-reads the stored path). Upstream refuses an upgrade whose manifest adds capabilities; for Kyoube's own bundles the bootstrap then soft-uninstalls (`DELETE /api/plugins/:pluginId`, no purge, plugin state kept) and re-installs, which reactivates the same row with the new manifest. Log the result and exit (or keep sleeping if `KYOUBE_BOOTSTRAP_WATCH=1`).

`kyoube setup` (interactive, run once): uses Paperclip's CLI auth challenge (`POST /api/cli-auth/challenges` → approval URL in the browser → board API key), stores the key at `/paperclip/kyoube/board-key.json`, then runs step 3 immediately. It also prints where to authenticate each harness (the Terminal page).

`kyoube doctor`: verifies both databases, plugin status, and each harness (`claude --version`, `pi --version`, `hermes doctor`, plus whether credentials exist under `/paperclip`).

### 6.5 Upgrading

- **Paperclip:** bump `PAPERCLIP_VERSION` (one ARG) and the matching `@paperclipai/plugin-sdk` version in the plugins; rebuild; run the smoke test. Renovate config keeps the two in lock-step.
- **Kyoube:** `docker compose pull && docker compose up -d`; bootstrap upgrades plugins whose version changed (hot, no server restart needed; see 6.4 for the capability-escalation fallback).
- **Data:** the `kyoube` database is ours; its metadata schema is migrated by the apps worker at startup (forward-only, checksummed migration table `kyoube_meta.migrations`). Paperclip migrates its own DB on boot as today.

---

## 7. Plugin: `@kyoube/plugin-terminal`

**Purpose:** a browser shell inside the app container for instance/company admins — primarily to run `claude login`, `pi` provider setup, `hermes setup`/`hermes model`, and general administration (`paperclipai …`, `kyoube doctor`, `psql`).

**Manifest (essentials)**

```ts
id: "kyoube.terminal", apiVersion: 1, categories: ["workspace","ui"],
capabilities: ["ui.page.register","ui.sidebar.register","access.members.read",
               "activity.log.write","plugin.state.read","plugin.state.write","instance.settings.register"],
ui: { slots: [
  { type: "page", id: "terminal", routePath: "terminal", exportName: "TerminalPage", displayName: "Terminal" },
  { type: "sidebar", id: "nav", exportName: "SidebarEntry", displayName: "Terminal" } ] },
instanceConfigSchema: { idleTimeoutMinutes (30), maxSessionsPerUser (3), allowedRoles (["owner","admin"]), shell ("/bin/bash") }
```

**Worker**

- Actions (all require `actor.type === "user"`; role resolved via `ctx.access.members.list({companyId})` → `membershipRole ∈ allowedRoles`; cached 30 s; every denial audited):
  `terminal.open({cols,rows}) → {sessionId}` · `terminal.wait({sessionId, afterSeq, timeoutMs}) → {session, events, truncated}` · `terminal.attach({sessionId, afterSeq})` (the same answer, never parked) · `terminal.input({sessionId, data})` · `terminal.resize` · `terminal.close` · `terminal.list` · `terminal.kill`.
- A session is a `node-pty` process spawned with an explicit environment: `HOME=/paperclip`, `USER=node`, `PATH` (inherited), `TERM=xterm-256color`, `LANG=C.UTF-8`, `HERMES_HOME`, `PAPERCLIP_HOME`; cwd `/paperclip`. Sessions are bound to the opening `userId`; input from any other user is rejected.
- Output is buffered per session as sequence-numbered events (coalesced to ≤ 60 frames/s, ≤ 64 KiB each, bounded scrollback) and *pulled* by the page: `terminal.wait` answers as soon as an event past `afterSeq` exists or the shell has exited, and otherwise parks for up to `timeoutMs` (default 10 s, capped at 20 s so it always answers inside upstream's 30 s action timeout). Waiting is not activity for the idle timeout. *Revised 2026-09-10:* the original design pushed output through `ctx.streams.emit` / `usePluginStream`; that SSE bridge is declared upstream but not wired in 2026.831.1 — the host never constructs its stream bus, so `GET /api/plugins/:id/bridge/stream/:channel` answers 501, and it also drops a worker's stream notifications that arrive outside a host-issued invocation — so the plugin does not use it.
- Lifecycle: idle timeout → close; worker shutdown → SIGHUP all sessions; `terminal.list` lets an admin see and kill sessions. Session open/close/deny events go to the activity log (no keystrokes or output are ever logged).

**UI**

- `TerminalPage` mounts xterm.js (bundled with the plugin, CSS inlined) with the fit addon; wires `usePluginAction` for input/resize and runs one sequential `terminal.wait` loop per session for output (one poll in flight at a time, from the last seq seen; transient failures back off and retry, `not_found`/`forbidden` stop); batches keystrokes (≤ 16 ms) and pastes into single actions; shows the loop's state (connecting / live / retrying / failed).
- `SidebarEntry` renders only for users whose role is allowed (a `terminal.can_open` data key tells the UI; the worker is the real gate).
- Quick help panel: the three harness login commands and what each writes to disk.

**Transport trade-off:** every keystroke is an HTTP action, and output arrives through one long-poll at a time (an idle terminal costs one request per 10 s; a busy one answers as fast as the round trip). Locally this is ~10–30 ms round trip — acceptable for shells and TUIs. If it proves insufficient, the documented upgrade is a WebSocket served by the worker on an internal port and exposed through a reverse-proxy path; the UI protocol stays identical.

---

## 8. Plugin: `@kyoube/plugin-apps` (data + apps)

One worker, two modules, one permission model.

### 8.1 Data layer

**Storage.** Database `kyoube` (role `kyoube`, login, `NOSUPERUSER NOCREATEDB`, owner of the database). Inside:

- `kyoube_meta` schema (ours): `companies`, `tables`, `fields`, `agent_grants`, `apps`, `app_versions`, `audit`, `migrations`.
- One schema per Paperclip company: `c_<companyId hex>`; one NOLOGIN role per company `kyoube_c_<hex>` that owns that schema and nothing else; `kyoube` is a member of every company role. Every data operation runs in a transaction that starts with `SET LOCAL ROLE kyoube_c_<hex>; SET LOCAL search_path = c_<hex>; SET LOCAL statement_timeout = …`. Cross-company *data* access is therefore impossible at the Postgres level, not just at ours: a company's tables live in its own schema, owned by its own role, and no other company role holds any privilege on them. Object *names* are a weaker boundary, because `pg_catalog` is world-readable and is implicitly first on every `search_path`: `sql_select` therefore also rejects any statement that references anything but the company's own registered tables, by bare name (ruling P2-R28), and restricts every call to an allowlist of pure builtin functions with no `reg*` casts (ruling P4-R11), so catalog *functions* (`pg_get_userbyid`, `to_regclass`, `pg_relation_size`, …) are rejected outright and can no longer reveal another company's object or role names.

**Tables and fields.** User tables are real Postgres tables plus a metadata row (display name, description, field kinds). Rules enforced in code before any DDL:

- Identifiers: `^[a-z][a-z0-9_]{0,62}$`, not starting with `kyoube_` or `pg_`, not a reserved word.
- Field kinds → column types (whitelist): `text`, `long_text`, `integer`, `decimal(numeric)`, `boolean`, `date`, `datetime(timestamptz)`, `json(jsonb)`, `select(text + options in metadata + CHECK)`, `multi_select(text[])`, `relation(uuid FK → another table in the same company)`, `attachment(reference to a Paperclip asset id)`, `email`, `url`.
- System columns on every table: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `created_at`, `updated_at` (trigger), `created_by_kind` (`agent|user|app`), `created_by_id`.
- Destructive operations (`drop_table`, `remove_field`, type narrowing) are soft by default: tables are renamed to `_trash_<name>_<ts>` and purged after 30 days; a company setting can make them hard.

**Operations** (one internal service; three façades in §8.3):

| Group | Operations |
|---|---|
| schema | `list_tables`, `describe_table`, `create_table`, `rename_table`, `drop_table`, `add_field`, `update_field`, `remove_field`, `create_index` |
| records | `insert` (1–500 rows), `update` (by id or filter), `delete` (by id or filter, capped), `get`, `query` (structured filter DSL: `where` with typed operators, `order_by`, `limit ≤ 1000`, `offset`, optional `include` of relations), `count` |
| read-only SQL | `sql_select` — a single SELECT (validated with a SQL parser; rejects anything else, and any table reference beyond the company's own registered tables) run under `READ ONLY` with a 5 s timeout, for analytics/reporting apps |

### 8.2 Permissions

Two independent gates; both must pass.

1. **Kyoube grant level** (authoritative, enforced in the worker):
   - Agents: `kyoube_meta.agent_grants(company_id, agent_id, level)` with `level ∈ none | read | write | schema`; company default level (default `none`). Managed by company owners/admins in the plugin's **company settings page** ("Agents → Data access"), and by the `apps` tool `data_request_access` which opens a normal Paperclip approval instead of granting.
   - Humans: derived from company role — `viewer → read`, `member/operator → write`, `admin/owner → schema`. An admin can lower a member's level per company.
   - Apps: an app declares the tables it uses and whether it needs write access; at runtime an app gets `viewer's level ∩ app declaration`.
2. **Paperclip tool governance** (recommended, upstream-native): tool profiles bound per agent/project/company select which `kyoube.apps:*` tools an agent even sees (by `tool_name` pattern), and policies add `require_approval` for `data_drop_table`, `data_remove_field`, `apps_publish`, rate limits, and full call audit. The README ships a recommended profile/policy set. (Verification item: confirm plugin tools are visible to agents by default when no profile is bound — spec §11.3 says yes — so Kyoube's own gate must be the safe default.)

Every mutating operation writes to `kyoube_meta.audit` (actor kind/id, run id, operation, table, row ids, before/after summary) and a compact entry to Paperclip's activity log via `ctx.activity`.

### 8.3 Agent access — three façades over one service

1. **Agent tools** (`ctx.tools`, capability `agent.tools.register`): `data_list_tables`, `data_describe_table`, `data_create_table`, … `apps_create`, `apps_update_source`, `apps_publish`, … Exposed to Claude/pi/Hermes runs as MCP tools `kyoube.apps:<name>` via Paperclip's runtime-tools gateway. Tool results are concise JSON/markdown so they read well in transcripts.
2. **Scoped API routes** (`apiRoutes`, `auth: "board-or-agent"`, companyResolution from the path): `/api/plugins/kyoube.apps/api/companies/:companyId/tables…`, `/records…`, `/apps…`. Agents call them with the run's `PAPERCLIP_API_KEY` (already in every run's env) — this works for any harness even if MCP wiring is off, and for scripts and CI.
3. **Managed skills** (`skills.managed`): `kyoube-data` and `kyoube-apps` SKILL.md files declared in the manifest, reconciled per company, so agents get accurate guidance (tool names, field kinds, filter DSL, app SDK, publishing flow) without prompt engineering per agent. The plugin also declares an optional managed agent template "Apps Builder" operators can hire.

### 8.4 Apps

**Model.** `apps(id, company_id, slug, name, description, icon, status draft|published|archived, current_version_id)`; `app_versions(id, app_id, version, manifest jsonb, source text, created_by_*, notes)`. Source is one HTML document ≤ 2 MB. Manifest:

```json
{ "name": "Sales CRM", "slug": "sales-crm", "icon": "📇",
  "tables": [ { "name": "contacts", "access": "readwrite" }, { "name": "deals", "access": "readwrite" } ],
  "surfaces": ["page"] }
```

**Authoring.** Agents create/update/publish through tools or API. Humans get a simple source viewer/editor and a "Preview draft" button. Publishing bumps the version; rollback re-points `current_version_id`.

**Runtime.** Plugin UI routes `/:company/apps` (gallery: published apps the viewer may open) and `/:company/apps/:slug` (runner). The runner:

- Renders `<iframe sandbox="allow-scripts allow-forms allow-modals" srcdoc="…">` — no `allow-same-origin`, so the app has an opaque origin: no cookies, no Paperclip API, no plugin bridge. A CSP `<meta>` is injected: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'`.
- Injects the **Kyoube app SDK** (`packages/kyoube-app-sdk`, ~3 KB) into `<head>` so the app sees `window.kyoube`:
  `kyoube.ready()`, `kyoube.context` (company, viewer `{name, role}`, app, theme), `kyoube.data.{query,get,insert,update,delete,count,describe}`, `kyoube.data.subscribe(table, cb)` (polling v1), `kyoube.ui.{toast,confirm,openApp}`.
- `postMessage` protocol, request/response with ids; the runner checks `event.source === iframe.contentWindow`, validates shapes, applies the app's declared table access, then calls worker actions (`apps.data.*`) which enforce §8.2 with the viewer's identity. Errors come back typed (`permission_denied`, `validation`, `not_found`).
- Apps can be opened as a `dashboardWidget` later (manifest `surfaces`), not in v1.

**Why single-file HTML:** it is what coding agents produce most reliably, it needs no build step or asset store, and it sandboxes trivially. Multi-file bundles are a v2 extension of `app_versions` (content-addressed files), not a redesign.

---

## 9. Isolation from upstream (requirement 4)

- **No fork, no patches.** The image is `FROM` the upstream image; the tree contains no Paperclip source. If a future need cannot be met by a plugin, the rule is: propose it upstream (they explicitly invite plugin-system contributions) or add a *separate* sidecar service — never patch.
- **Stable contracts only.** Plugins use `@paperclipai/plugin-sdk` and `@paperclipai/plugin-sdk/ui`; no imports from `ui/src` or `server/src`; no undocumented HTTP routes. Plugin UI links use `useHostNavigation`.
- **Version lock-step.** `PAPERCLIP_VERSION` (image) and the SDK dependency are the same CalVer and bumped together; `minimumHostVersion` is omitted from both manifests for now: Paperclip 2026.831.1 compares it against an `instanceInfo.hostVersion` the server never sets (it defaults to 0.0.0), so any minimum would reject the install; revisit when upstream wires its version through.
- **Own database.** Kyoube state never lives in Paperclip tables; the only coupling is the company id.
- **Empty home in the image.** `/paperclip` is upstream's `HOME` *and* the runtime volume mount, so no build step may write under it (installers run with `HOME` under `/tmp`; browsers and drivers live under `/opt` and are pointed to by runtime `ENV`); the Dockerfile asserts `/paperclip` is empty. Otherwise root-owned residue would be seeded into every fresh volume.
- **Early warning.** Weekly CI job builds the image against `ghcr.io/paperclipai/paperclip:beta` and runs the smoke suite; failures open an issue before a stable bump is attempted.
- **Escape hatch.** Because plugins are hot-installable local packages, a Kyoube fix can ship independently of Paperclip and vice versa.

---

## 10. Security model (summary)

- Authenticated mode is mandatory; compose refuses to start without `BETTER_AUTH_SECRET`. Public exposure requires `PAPERCLIP_PUBLIC_URL` and TLS in front (documented Caddy profile).
- Terminal = full instance access. Gate: company owner/admin (configurable), server-side on every action; sessions bound to the opener; audited; idle timeouts; disable-able from plugin settings.
- Data DB: separate role per company enforced by Postgres; identifier/type whitelists; statement timeouts; read-only SQL only via parser-validated SELECT; row caps; soft deletes.
- Apps: opaque-origin iframe + CSP; identity and permissions injected by the host, never by the app; no network from apps; source size caps; publish can require approval via Paperclip policy.
- Secrets: harness credentials live only on the `/paperclip` volume; the board API key used by bootstrap is stored 600 on that volume and can be revoked from Paperclip's UI.
- Repository: `.env` and data are git-ignored; `SECURITY.md` explains the trust zones.

---

## 11. Testing strategy

- **Unit (per plugin):** Vitest with `@paperclipai/plugin-sdk/testing` harness — actions, tools, permission gates, SQL/identifier validators, filter DSL compiler, postMessage protocol.
- **Integration:** Vitest against a real Postgres (Testcontainers or compose `db`): schema ops, company isolation (assert a `SET ROLE` company cannot see another), migrations.
- **Smoke (CI, Docker):** build image → `docker compose up` → sign up first admin via API → `kyoube setup` with a generated key → assert both plugins `ready` → create an agent per harness (`claude_local`, `pi_local`, `hermes_local`) and confirm adapter environment checks pass → open terminal session, echo → create table + rows + app via API → open app page.
- **Weekly:** same smoke against upstream `:beta`.
- **Manual acceptance per phase:** listed in each phase's implementation plan.

---

## 12. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Plugin API changes (alpha) | plugins fail to load after a Paperclip bump | pin lock-step; weekly `:beta` CI; `minimumHostVersion`; keep plugin surface small and documented |
| Hermes install layout vs. volume (`/opt/hermes` code, `/paperclip/.hermes` data, managed `uv`) | `hermes_local` runs fail | Phase 0 spike proves `hermes doctor` and a heartbeat inside the container; fallback: manual clone + `uv` venv per Hermes contributor docs |
| `node-pty` native build in worker | terminal fails to start | `@lydell/node-pty` prebuilds; build-time check `node -e "require('@lydell/node-pty')"` in the Dockerfile |
| Terminal latency via bridge | poor UX for heavy TUIs | keystroke batching; measured in Phase 1; WebSocket upgrade path documented |
| Plugin tools visible to all agents by default | agents see tools they cannot use | Kyoube grant default `none`; tool responses explain how to request access; recommended profiles in README |
| First-boot manual step | onboarding friction | one command, clear logs, env-key alternative; upstream proposal to allow operator-defined bundled plugins |
| Company deleted in Paperclip | orphan schema | `company.updated` events + periodic reconciliation; admin "purge company data" action |
| Large/abusive queries or apps | DB load | statement timeouts, row caps, per-company connection limits, app size caps |

---

## 13. Phased delivery

Each phase ends with a demo and its own implementation plan (written with the `writing-plans` skill when the phase starts).

**Phase 0 — Foundation (image, compose, bootstrap, README v0).**
Dockerfile `FROM` upstream + pi + Hermes; compose with two databases; entrypoint + config file; `kyoube` CLI skeleton (`setup`, `ensure-plugins`, `doctor`); hello-world plugin installed via bootstrap to prove the flow; smoke workflow in CI; README with quickstart. *Exit:* fresh clone → `docker compose up` → sign up → `kyoube setup` → hello plugin `ready`; `claude`, `pi`, `hermes` all runnable inside the container; an agent of each adapter completes a heartbeat with API keys from `.env` (a manual acceptance step — it needs real provider keys, which CI does not have).

**Phase 1 — Terminal plugin.** Worker sessions, page, gating, audit, settings. *Exit:* admin authenticates all three harnesses from the browser; credentials survive `docker compose down && up`; a non-admin cannot open the page or call the actions.

**Phase 2 — Data layer.** Database roles/schemas, metadata, schema and record operations, grants, tools + API routes + skill, table browser UI (list, grid, create table/field forms), company settings page for agent grants. *Exit:* an agent asked "set up a contacts and deals database" creates it via tools; a human edits rows in the UI; isolation and permission tests pass.

**Phase 3 — Apps.** Storage, tools/API, gallery + runner, app SDK, authoring guide skill, source viewer/editor, publish/rollback. *Exit:* an agent builds and publishes a CRM app over the Phase 2 tables; users use it; an unauthorised app write is denied.

**Phase 4 — Hardening and 1.0.** Upgrade automation and docs, backups (`pg_dump` both DBs), recommended tool profiles/policies, security review of the three trust zones, telemetry-free defaults, contributor docs, release workflow (`ghcr.io/<org>/kyoubeai`), tag `1.0.0`.

Rough sizing (one experienced engineer with agent assistance): Phase 0 ≈ 1 week, Phase 1 ≈ 1 week, Phase 2 ≈ 2–3 weeks, Phase 3 ≈ 2–3 weeks, Phase 4 ≈ 1 week.

---

## 14. Open questions (answer or accept the defaults)

1. **Compose vs. single image** (D1) — default compose with two services.
2. **Terminal audience** — company owners/admins (default) or instance admins only? (Instance-admin status is not exposed to plugin workers today; company owner/admin is the enforceable gate.)
3. **Apps v1 = single-file HTML** (D4) — acceptable, or do you want multi-file bundles from the start?
4. **Naming** — package scope `@kyoube/*`, plugin ids `kyoube.terminal` / `kyoube.apps`, image `ghcr.io/<org>/kyoubeai`. Which GitHub org?
5. **Which harness features matter most at Phase 0** — e.g. should pi be pinned to the version the upstream adapter tests against (`0.74.0`) or latest (`0.85.0`)? Default: latest, adapter smoke-tested.
6. **Public exposure** — should the default compose target `private` (LAN/VPN) and document `public` + TLS, as proposed?
7. **Upstream engagement** — propose the operator-configurable bundled-plugin allowlist to Paperclip so bootstrap becomes zero-touch? (Recommended, after Phase 0.)
