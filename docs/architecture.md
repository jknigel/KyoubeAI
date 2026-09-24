# Architecture

KyoubeAI is a Docker overlay on top of the upstream core (Paperclip, https://github.com/paperclipai/paperclip)
image. This document describes the system as built: the trust zones, how a request actually gets from a
browser or an agent run down to the `kyoube` database, the data model, and the contract that keeps
Kyoube's plugins working across a core upgrade. Where this document and the code disagree, the code
wins.

## Trust zones

KyoubeAI's design rests on three zones of trust, each with a different guarantee (see `SECURITY.md` for
the full security model built on top of them):

1. **The core.** Upstream, pinned by exact version, never patched. It provides authentication,
   sessions, company membership and roles, the activity log, the board API, and the plugin host.
2. **Kyoube plugins — trusted code.** `kyoube.terminal`, `kyoube.apps` and `kyoube.files` are first-party
   code, reviewed and shipped with the image, running as core plugin worker processes. The apps plugin
   holds its own database credential (the `kyoube` Postgres login role) and has no privilege on the
   `kyoubeai` database at all; the files plugin holds no credential and touches only project folders.
3. **Apps — untrusted, sandboxed code.** An app is one HTML document, typically written by an agent,
   that a person with schema access chooses to publish. It runs in a browser iframe with an opaque
   origin and a restrictive Content-Security-Policy, and every data call it makes is re-authorised under
   the identity of the person *viewing* the app, never the app's own.

## System diagram

```
docker compose
├── app   (this repo's image; FROM ghcr.io/paperclipai/paperclip:<KYOUBE_CORE_VERSION>)
│   │
│   ├─ core server + UI  (upstream; rebranded and themed at build time, otherwise unmodified)
│   │    ├─ adapters: claude_local · pi_local · hermes_local
│   │    ├─ plugin runtime
│   │    │     ├─ worker  kyoube.terminal   — node-pty PTY sessions
│   │    │     ├─ worker  kyoube.apps       — DataService + AppService
│   │    │     └─ worker  kyoube.files      — WorkspaceFiles over each project's folder
│   │    └─ plugin API routes  ◀── agent runs (Claude Code, pi, Hermes) over REST
│   │
│   ├─ CLIs on PATH: claude, pi, hermes
│   ├─ kyoube-entrypoint.sh → background: `kyoube ensure-plugins --watch`
│   ├─ DATABASE_URL         ───────────▶ db: `kyoubeai` database
│   ├─ KYOUBE_DATABASE_URL  ───────────▶ db: `kyoube` database
│   └─ volume kyoubeai-home:/kyoubeai (board key, ~/.claude ~/.pi ~/.hermes, project folders)
│
└── db    (postgres:17-alpine)
      ├─ database `kyoubeai`  — owned by the `kyoubeai` superuser (upstream's own data)
      ├─ database `kyoube`     — owned by the `kyoube` role (Kyoube's own data; see below)
      └─ volume pgdata:/var/lib/postgresql/data

        ▲ :3100 (KYOUBE_PORT) — browser: KyoubeAI UI (core pages + Terminal, Data, Apps, project Files tab)
```

Three plugins ship in the image: `@kyoube/plugin-terminal` (`plugins/kyoube-terminal`),
`@kyoube/plugin-apps` (`plugins/kyoube-apps`), which carries both the Data layer and the Apps module in
one worker because apps need in-process access to the data service and plugins cannot call each other,
and `@kyoube/plugin-files` (`plugins/kyoube-files`), the Files tab on project pages. Everything Kyoube adds
is one of these three plugins, the `@kyoube/app-sdk` package the apps plugin injects into apps
(`packages/kyoube-app-sdk`), and the `kyoube` bootstrap CLI (`docker/bootstrap`) that installs them.

## Request paths

### Browser → mutation

A person's action in a Kyoube page (`DataPage`, `AppsPage`, `DataAccessSettingsPage`, the terminal page)
calls a core UI hook (`usePluginAction`), which the host routes to the plugin worker's matching
`ctx.actions.register` handler — for example `data.create_table`, `data.insert`, `apps.publish`,
`terminal.open` (see the `action(...)` calls in `plugins/kyoube-apps/src/plugin.ts` and the
`ctx.actions.register(...)` calls in `plugins/kyoube-terminal/src/plugin.ts`). The host resolves the actor
(`{type: user|agent, userId, agentId, runId, companyId}`) from the signed-in session *before* the call
reaches the plugin; `actorFromAction` narrows it to `{kind: "user"|"agent", id, runId}` and never trusts a
`companyId`/`kind` supplied in the request body over the host's own. The handler then calls
`DataService`/`AppService`, which run every statement through `withCompany`
(`plugins/kyoube-apps/src/db/company-scope.ts`): `SET LOCAL ROLE kyoube_c_<hex>`, `search_path` set to
that company's own schema, and a statement timeout (10 s by default; 5 s for read-only SQL), against the
`kyoube` database.

### Browser → read

The same pages' list and detail views call `usePluginData`, routed to a `ctx.data.register` handler
(`data.tables`, `data.table`, `data.rows`, `data.count`, `data.access`, plus the terminal plugin's
`terminal.can_open`). The core's plugin data-provider bridge does not carry a host-authenticated actor
the way the action bridge does — it passes the client-supplied `params.userId` straight through — so
these reads build an actor from that id. This is safe only because a read never needs more than
`read`-level access (which every company member already holds) and because the core's own
company-membership check gates the read before it ever reaches the plugin worker; every mutation and
schema change instead uses the host-authenticated action actor described above. Full reasoning and the
exact residual this leaves: `SECURITY.md`.

### Agent run → Kyoube

A local adapter run (`claude_local`, `pi_local`, `hermes_local`) reaches Kyoube over REST: every run is
started with `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` (a run-scoped agent token) and `PAPERCLIP_COMPANY_ID`
in its environment, and the managed skills tell the agent to call the plugin's API routes (next section)
with them. That is the primary path because of how the core (2026.831.1 through 2026.916.1) delivers plugin tools: they are
listed by its tool gateway, but a run only receives a gateway MCP server (`/mcp/gateways/<id>`) when the
agent's effective tool profile permits at least one installed `mcp_remote`/`local_stdio` connection —
`buildPaperclipRuntimeMcpServers` in upstream's `heartbeat.ts` returns nothing otherwise, and the
`/mcp/runtime-tools` endpoint serves only the two connection-request tools. On a fresh instance no agent
has such a connection, so the tools never reach the model. Where a gateway does exist, the same 24
operations are available as `kyoube.apps:<tool>`: 17 `data_*` tools (`plugins/kyoube-apps/src/tools.ts`, from
`data_list_tables` through `data_my_access`) and 7 `apps_*` tools (`plugins/kyoube-apps/src/apps/tools.ts`,
`apps_list` through `apps_archive`). Every tool call is dispatched through the shared runtime in
`plugins/kyoube-apps/src/tool-runtime.ts`, which validates the params against the tool's own Zod schema,
builds the actor from the host-authenticated run context alone (`runCtx.agentId`, `runCtx.companyId` —
never from the model's own arguments), and calls the same `DataService`/`AppService` the browser path
uses. A tool failure never echoes a raw driver/JS error back to the agent; only a `DataError`'s own
(already caller-safe) message is returned, and the real error goes to the operator log.

### REST → API route

`POST`/`GET` requests under `/api/plugins/kyoube.apps/api/*` (for example
`POST …/api/apps`, `POST …/api/sql`) are the core's own `apiRoutes` bridge
(`auth: "board-or-agent"`, so either a board API key or an agent run's own `PAPERCLIP_API_KEY` works),
dispatched in-process from `onApiRequest` in `plugins/kyoube-apps/src/plugin.ts` to
`handleApiRequest` (`src/api-routes.ts` — the `access.*`/`tables.*`/`fields.*`/`indexes.*`/`rows.*`/`sql.*`
routes) or `handleAppsApiRequest` (`src/apps/api-routes.ts` — the `apps.*` routes). The apps dispatcher is
tried first and returns `null` for a route it does not own, so a data route falls through to the other
one; every route key is answered by exactly one of the two.

### App runtime → data

A published app opens as a sandboxed `<iframe sandbox="allow-scripts allow-forms allow-modals">` with an
opaque origin (no cookies, no storage, no host DOM). Its only channel to the host is `postMessage`,
guarded by a per-mount handshake nonce (16 random bytes, readable by the SDK exactly once and then
removed from both `window` and the DOM) and a call budget (60 requests per rolling 10 seconds, of which at
most 5 may be toasts). The runner forwards a data call as the `apps.data` action, which calls
`AppService.runtimeData` → the same `DataService`, tagged with **the viewer's own identity**, never the
app's, and narrowed to the app manifest's declared tables intersected with the viewer's own access level
— so an app can never do more than the person using it could already do on the Data page. Full detail,
including the residuals this sandbox knowingly accepts: `apps.md` and `../SECURITY.md`.

### Terminal → PTY

The Terminal page drives the `terminal.open` / `attach` / `input` / `resize` / `close` / `list` / `kill`
actions (`plugins/kyoube-terminal/src/plugin.ts`), each re-deriving the caller's identity from the
host-supplied actor and re-checking their company role against the plugin's configured `allowedRoles` on
every call. Output streams back over the core's plugin SSE bridge on a per-session channel named
`term-<24 random bytes, base64url>` (never listed, returned only to the session's own opener), driving a
`node-pty` (`@lydell/node-pty`) process spawned with `HOME=/kyoubeai`.

### Files tab → project folder

The **Files** tab on a project page (a `detailTab` slot on `project` entities, plus a `projectSidebarItem`
link under each project in the sidebar) and the folder icon at the right end of the top bar on a task page (a
`globalToolbarButton` slot, whose component reads the task reference from the route and resolves its
project through the `files.locate` action and `ctx.issues.get`, then docks the same browser in a
fixed panel on the right) both drive the `files.workspaces` / `list` / `stat` / `read` / `write` /
`create` / `upload` / `rename` / `delete` actions (`plugins/kyoube-files/src/plugin.ts`). Every one — reads
included, unlike the apps plugin's data reads — is a `ctx.actions.register` handler, so the caller is the
host-authenticated actor, never a client-supplied id: it must be a signed-in user whose company role is in
the plugin's `readRoles` (`writeRoles` for a mutation, checked against a fresh read of the members API).
The folder itself comes from `ctx.projects.getPrimaryWorkspace(projectId, companyId)`, which the host
answers with the project's *effective* local folder — the configured primary workspace's path when the
project has one, otherwise the managed folder the core creates for it
(`<instance>/projects/<companyId>/<projectId>/_default`) — the same resolution upstream's run scheduler
uses to choose an agent's working directory, and `null` for a project outside the company scope. Further
configured workspaces of the project are offered as well. `WorkspaceFiles` (`src/fs-service.ts`) then
performs the operation under two invariants: nothing outside the folder's resolved location is ever
touched (paths are normalised before the disk is consulted, and the resolved path is checked against the
resolved root, so a symlink inside the folder cannot lead out of it), and symbolic links are never
followed (listed, deletable, renameable — never read or written through). A save carries the mtime the
file had when it was read and is refused with `conflict` if the file changed since. Every mutation goes
to the company's activity log as one line with the operation and path — never content.

## Data model

### `kyoube_meta` (shared metadata)

The `kyoube` database is separate from the core's own `kyoubeai` database — a runtime plugin cannot run
DDL through the core's plugin database API, so Kyoube connects to its own database directly. Its
`kyoube_meta` schema, created by `plugins/kyoube-apps/migrations/0001_meta.sql` and
`0002_apps.sql`, holds:

| Table | What it is |
|---|---|
| `migrations` | One row per applied migration file, with its SHA-256 checksum (see below). |
| `companies` | One row per provisioned company: its `company_id`, `schema_name` (`c_<hex>`), `role_name` (`kyoube_c_<hex>`). |
| `company_settings` | Per-company `default_agent_level` and `hard_delete` flag. |
| `agent_grants` | Per-agent, per-company access level (`none`/`read`/`write`/`schema`). |
| `tables` / `fields` | Metadata for every user table and column: display name, description, field kind, status (`active`/`trashed`), trash bookkeeping. |
| `apps` / `app_versions` | App records (slug, status, current/latest version) and every saved version's manifest, source, and notes. |
| `audit` | One row per mutation, schema change, grant change, or app lifecycle change. |

(There is no separate `indexes` metadata table — a company's indexes are created directly as ordinary
Postgres indexes via `data_create_index`/`createIndex` and are not tracked in their own `kyoube_meta`
table; only tables and fields get metadata rows.)

### Per-company schemas and roles

Every company gets its own Postgres schema, `c_<hex>` (the company UUID without dashes), and its own
`NOLOGIN` role, `kyoube_c_<hex>`, that owns that schema and nothing else (`ensureCompany` in
`plugins/kyoube-apps/src/db/company-scope.ts` provisions both on first use, under an advisory lock so
concurrent requests can't race). Every data operation — through the tools, the REST routes, or an app's
runtime calls — runs inside a transaction that sets `search_path` to that schema alone, sets a statement
timeout, and `SET LOCAL ROLE`s into the company's own role before touching anything (`withCompany`).
Cross-company data access is therefore impossible at the Postgres level, not just at the plugin's: no
other company role holds any privilege on a schema that isn't its own.

### Soft deletes and the purge job

Dropping a table or removing a field renames/marks it (`status = 'trashed'`) rather than deleting it
outright, unless the company has enabled hard deletes. A scheduled job (`ctx.jobs.register`, key
`purge-trash`, cron `0 3 * * *`) sweeps every company nightly and permanently drops anything trashed more
than 30 days ago; one company's failure is caught and logged without cancelling the sweep for the rest.

### Audit

Every schema change, row mutation, agent-grant change, company-settings change, and app lifecycle change
(`create`, `publish`, `rollback`, `archive`) writes one row to `kyoube_meta.audit` **inside the same
database transaction as the change itself** (`withCompany`'s `audit` option), so a change is never
committed unrecorded and an audit row is never left behind for a change that rolled back. Rows record the
actor, the operation, and identifying metadata — never row contents.

## The upgrade contract

### Pins

`KYOUBE_CORE_VERSION` (the upstream image tag) is the single source of truth, repeated in five files plus
each plugin's own dependency:

- `ARG KYOUBE_CORE_VERSION` in `docker/Dockerfile`
- `KYOUBE_CORE_VERSION=` in `.env.example`
- `KYOUBE_CORE_VERSION=` in `scripts/smoke.env`
- the `KYOUBE_CORE_VERSION:-<value>` default in `docker-compose.yml`
- `CORE_VERSION` in `docker/core-patches/patches.mjs` (the core the patches are written for)
- `dependencies["@paperclipai/plugin-sdk"]` in every `plugins/*/package.json`

`scripts/check-pins.sh` fails (and runs first in CI) if any of these disagree.
`scripts/bump-core.sh <version>` rewrites all six in one pass, reinstalls, and re-runs the check.

### Core patches

The image is the pinned core, unmodified in behaviour — with one bounded exception.
`docker/core-patches/patches.mjs` may carry a fix to an upstream bug that had to ship here first,
applied to the pristine core layer by `docker/core-patches/apply.mjs` in the Dockerfile step right
before the rebrand, while the same fix is on its way upstream (each entry names its issue or PR). A
pattern anchors on the compiled bundle's string literals and code shape (never a minifier's
identifier names) and must match exactly the declared number of times, so a core bump that changes
that code or already carries the fix fails the build with the patch's id — the cue to delete the
entry. The list is meant to be empty; `CONTRIBUTING.md` ("Never patch the core") has the rules, and
`docs/upgrading.md` what to do when the step fails at a bump.

### Plugin hot reload

Kyoube's plugins are installed from a local path, so the core hot-reloads them from `dist/` without a
server restart. The entrypoint starts `kyoube ensure-plugins --watch` in the background
(`docker/bootstrap/src/commands/ensure-plugins.ts`), which compares the plugin versions already installed
in the core against the versions on disk in the running image: a plain version bump goes through
`POST /api/plugins/:id/upgrade`; a manifest that adds a new **capability** cannot be upgraded that way
(upstream requires board approval for a capability escalation), so for Kyoube's own bundled plugins the
bootstrap instead soft-uninstalls (`DELETE`, no `purge`, so plugin-scoped data survives) and re-installs
the same path, which reactivates the same row under the new manifest.

### SDK `apiVersion` and the stable-contract rule

Both manifests (`plugins/kyoube-apps/src/manifest.ts`, `plugins/kyoube-terminal/src/manifest.ts`) declare
`apiVersion: 1` — the plugin manifest schema version the pinned `@paperclipai/plugin-sdk` understands.
Neither plugin imports anything from the core's own `server/`/`ui/` source or calls an undocumented HTTP
route; the only contracts used are `@paperclipai/plugin-sdk` and `@paperclipai/plugin-sdk/ui`. Neither
manifest sets `minimumHostVersion`: the pinned core version compares it against a host version the
server never actually sets, so declaring any minimum would reject the install outright.

### Forward-only, checksummed migrations

`runMetaMigrations` (`plugins/kyoube-apps/src/db/migrate.ts`) applies `migrations/*.sql` in filename order
exactly once, recording each file's SHA-256 in `kyoube_meta.migrations`. If an already-applied file's
contents ever change, the worker refuses to start rather than silently reapplying or skipping it. There is
no `down` migration for either the core or Kyoube — rolling back a schema change means restoring a
backup taken before it ran (`docs/upgrading.md`).

### The upstream canary

A weekly workflow (`.github/workflows/upstream-beta.yml`) points `scripts/smoke.env` at
`ghcr.io/paperclipai/paperclip:beta`, runs the full Docker smoke test against it, and opens (or leaves
open) a single tracking issue on failure — catching a breaking upstream change before it reaches a stable
`KYOUBE_CORE_VERSION` bump.

## Branding

The core image is rebranded at build time: `docker/rebrand/rebrand.mjs` runs inside `docker/Dockerfile`
right after the core layer and rewrites its served UI, server messages, skills and artwork to KyoubeAI in
place, on every build. See [`branding.md`](branding.md) for the mechanism and what it deliberately leaves
alone.

## Theme

The Studio design is applied the same way, one step earlier: `docker/theme/theme.mjs` runs before the
rebrand, links a stylesheet of brand tokens and a skin after the core's, inlines a boot flag, and
renames a few labels. It checks every rule, hook and token against the core before writing anything.
The `kyoube.studio` plugin draws Home, the sidebar's Build group and Team roster, the agent profiles and
the Workspace page through the public SDK, and every skin rule that hides or moves core UI is gated on that plugin
being present, so without it the stock layout shows. See [`theme.md`](theme.md).

## Further reading

- [`apps.md`](apps.md) — app authoring guide: the manifest, `window.kyoube`, the sandbox in full detail.
- [`operations.md`](operations.md) — volumes, backups/restore, logs, health, key rotation, resource limits.
- [`upgrading.md`](upgrading.md) — upgrading KyoubeAI and the core, and rolling back.
- [`governance.md`](governance.md) — Kyoube's grant levels alongside the core's tool profiles/policies.
- [`branding.md`](branding.md) — the build-time branding transform: what it changes and what it leaves alone.
- [`theme.md`](theme.md) — the Studio design: the build-time theme, the Studio plugin, and what to do after a core bump.
- [`../SECURITY.md`](../SECURITY.md) — the full security model built on the trust zones above.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — local setup, conventions, and how to add a tool.
