# Security Policy

## Reporting a vulnerability

Report a security vulnerability in **KyoubeAI** (this repository — the bootstrap CLI, the `kyoube.terminal`
and `kyoube.apps` plugins, and the Docker overlay) through GitHub's private Security Advisory feature:

**<https://github.com/jknigel/KyoubeAI/security/advisories/new>**

Do not open a public issue for a security vulnerability. We aim to acknowledge a report and set a
disclosure timeline within **7 days**.

A vulnerability in **the core itself** (Paperclip — the upstream host this project runs rebranded but
otherwise unmodified, `FROM` a published image) is out of scope here; report it upstream instead (see
[Out of scope](#out-of-scope) below).

## Scope

KyoubeAI is a Docker overlay on the upstream core:
a Postgres 17 cluster, the four Kyoube plugins (`kyoube.terminal`, `kyoube.apps`, `kyoube.files`, `kyoube.studio`), and the `kyoube`
bootstrap CLI that renders config, installs the plugins, and runs diagnostics. Nothing here patches
the core — every Kyoube feature is a plugin — so this document describes the security properties of
the overlay, not of the core's own auth, sessions, board API, or MCP tool gateway.

## Trust zones

KyoubeAI's design rests on three zones of trust, each with a different guarantee:

1. **The core.** Upstream, pinned by exact version (`KYOUBE_CORE_VERSION`, bumped in lock-step
   with `@paperclipai/plugin-sdk`), and never patched. It provides authentication, sessions, company
   membership and roles, the activity log, the board API, and the plugin host. Its own security model
   (auth, deployment modes, the MCP tool gateway) is documented upstream — see
   [Out of scope](#out-of-scope).
2. **Kyoube plugins — trusted code.** `kyoube.terminal`, `kyoube.apps` and `kyoube.files` are first-party
   code, reviewed and shipped with the image, running as core plugin workers. The apps plugin holds its
   **own** database credential — the `kyoube` Postgres login role (`LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT`,
   created once by `docker/postgres-init/01-kyoube.sh`) — which owns the separate `kyoube` database and
   has **no** privilege on the `kyoubeai` database at all (`REVOKE CONNECT ON DATABASE kyoubeai FROM
   PUBLIC`, and `kyoube` is never granted it). A compromise of a Kyoube plugin cannot reach the core's
   own data through that credential; it is still, however, trusted code running inside the same
   container as the core, with everything that implies (see [Terminal](#terminal) below). The files
   plugin holds no credential at all: it reads and writes project folders on the home volume as the
   container's `node` user, within the bounds described under [Files](#files).
3. **Apps — untrusted, sandboxed code.** An app is one HTML document, typically written by an agent,
   that a person with schema access chooses to publish. It runs in a browser iframe with an opaque
   origin and a restrictive Content-Security-Policy, and every data call it makes is re-authorised
   under the identity of the person *viewing* the app, never the app's own. See [Apps](#apps) below for
   exactly what that sandbox does and does not cover.

## Terminal

Company **owners and admins** (the roles are configurable under **Settings → Plugins → Kyoube
Terminal**) get a browser terminal into the `app` container as the `node` user — this is **full
instance access**: the Postgres superuser password, every agent harness's stored credentials, the
board API key, and the ability to run anything the container's user can run. It is not a sandboxed or
scoped surface, and it is not intended to be one; treat it exactly like shell access to the whole
deployment, and keep `allowedRoles` tight.

Every session open and close, and every access denial, is recorded in the company's activity
log — **keystrokes and terminal output are never logged**, only that a session existed and who opened
it. Every terminal action (`open`, `attach`, `wait`, `input`, `resize`, `close`, `list`, `kill`) re-derives the
caller's identity from the actor the core supplies and re-checks their company role against
`allowedRoles` on every call, bound to that session's own company.

**Where that role check comes from.** `terminal.open` reads the caller's role from the core's
members API **every time**, bypassing (and refreshing) the 30-second membership cache described
under [Data](#data): opening a terminal is full instance access, so it is never granted on a cached
answer. `attach`, `wait`, `input`, `resize`, `close`, `list` and `kill` take the cached answer, because each
one acts on a session this user already opened. Plainly: a demoted or removed admin cannot open a
new terminal from the moment the change lands, and can keep typing into a session they already have
open for **at most 30 seconds** after it — less, if any `terminal.open` in that company refreshes the
cache sooner. The session's shell is not killed by the role change itself; it keeps running until
someone kills it (`terminal.kill`, available to any allowed role in the company) or the idle sweep
closes it, 30 minutes idle by default.

**`terminal.can_open` is advisory, not an authorization check.** The terminal plugin registers a UI
data read, `terminal.can_open`, that takes a `companyId` and a `userId` and answers whether that user's
company role is in the terminal's `allowedRoles`. The core's plugin data-provider API carries no
actor context, so the worker cannot verify that the caller is the user it is being asked about: anyone
who can perform the read can ask about any user id. The host confines that to company membership — a
data read is scoped to a company the caller belongs to — so the exposure is that one member of a
company can learn whether another member of the same company holds a role allowed to open a terminal.
No credential, no session content and no capability is disclosed. The answer is used for one thing:
whether the Terminal entry appears in that user's sidebar. It grants nothing. Every terminal action
re-derives the caller's identity from the host-supplied actor and re-checks the role against
`allowedRoles` through the members API — `terminal.open` against a fresh read of it on every call,
`attach`/`wait`/`input`/`resize`/`close`/`list`/`kill` against the 30-second cached one (see above), each
additionally bound to the session's own company — so a forged `userId` in the data read cannot open,
reach or reveal a terminal session.

Terminal output is pulled, never pushed: the page polls `terminal.wait`, which is bound to the
session's owner and company exactly like `attach` (a session in another company answers `not_found`,
another user's `forbidden`), so there is no per-session secret to guard and no channel that could be
listed or guessed. The SSE stream channel the original design relied on is gone: upstream core
2026.831.1 (through 2026.916.1) never wires its plugin stream bridge (the route answers 501), which is why the terminal
does not use it.

## Data

Every company gets its own Postgres schema (`c_<company uuid, hex>`) and its own `NOLOGIN` role
(`kyoube_c_<hex>`) that owns that schema and nothing else. Every data operation — through the
`kyoube.apps:data_*` tools, the REST routes, or an app's runtime calls — runs inside a transaction that
sets a statement timeout, sets `search_path` to that schema alone, and `SET LOCAL ROLE`s into the
company's own role before touching anything, so cross-company data access is impossible at the
Postgres level, not just at the plugin's: no other company role holds any privilege on a schema that
isn't its own.

- **Access levels** are `none < read < write < schema`, held per person (via their company role) or per
  agent (an explicit grant, defaulting to `none`), set under **Company Settings → Data access**.
- **UI data reads are advisory, not an authorization check** — the same shape of residual as
  `terminal.can_open` above. The plugin's UI-facing reads (`data.tables`, `data.table`, `data.rows`,
  `data.count`, `data.access`, behind `DataPage.tsx`, `SidebarEntry.tsx`, and the apps gallery's
  `AppsPage.tsx`/`AppsSidebarEntry.tsx`) build their actor from `params.userId`, which is
  client-supplied, not host-authenticated: the core's plugin data-provider bridge passes it straight
  through instead of deriving it from the signed-in session the way an action call does. This is safe
  only because a read needs no more than `read`-level access, which every company member already
  holds, and because the core's own company-membership check gates the read before it ever reaches
  the plugin worker — that gate is the real authorization, not the identity the read reports. Every
  mutation and schema change instead takes its actor from the host-authenticated action context,
  exactly as every Terminal action does.
- **Read-only SQL (`data_sql_select`, `POST /sql`).** A statement must be exactly one `SELECT` (CTEs
  and `UNION [ALL]` included) with no locking clause, at most 20,000 characters, with at most 50 bound
  parameters, returning at most 1,000 rows within a 5-second statement timeout. It may name only that
  company's own active tables, written as bare names — a schema-qualified name of any kind, a Postgres
  catalog relation, `information_schema`, `kyoube_meta`, and another company's schema are all rejected
  before the query runs. It may call only an allowlist of pure builtin functions (common aggregate,
  string, math, date/time, JSON, array and window functions, documented in the Kyoube Data skill);
  every other function is rejected, and no `pg_*` function is on the list at all. Casts to Postgres'
  OID alias types (`regclass`, `regproc`, `regtype`, …) are rejected, since they resolve catalog
  identifiers. The statement runs as the company's own NOLOGIN role in a read-only transaction, so even
  a validator gap could not reach another company's data or the core's own database. Introspection
  goes through `data_list_tables` / `data_describe_table`. One residual: `OPERATOR(schema.op)` parses
  as an operator rather than a function call, so the schema-prefix rule does not reach it — an operator
  resolves only to an operator, both operands are still checked, and nothing in this plugin creates a
  user-defined operator, so the reachable set is Postgres' own built-in operators (documented in
  `src/data/sql-functions.ts`). The allowlist is itself the security boundary for what SQL may reach;
  requesting an addition to it is a code change and review, not a runtime setting.
- **Row and statement caps.** A call may target at most 500 row ids and bind at most 5,000 parameter
  values (one per column per row, plus two); both are enforced on every statement the records service
  assembles (`insert`, `update`, `delete`, `query`, `count`).
- **Audit.** Every schema and row mutation, every agent-grant and data-settings change, and every app
  lifecycle change (create, publish, rollback, archive) writes one row to `kyoube_meta.audit` **inside
  the same transaction as the change itself** — a change is never committed unrecorded, and an audit
  row is never left behind for a change that rolled back. Audit rows record the actor, the operation,
  and identifying metadata (table/field/app names, affected ids or counts) — **never row contents**.
  Postgres error `detail` (which can carry the offending value) is scrubbed before a mapped error
  reaches any caller-visible surface or the activity log; the raw driver error is kept only in the
  operator log, for diagnosis.
- **Soft deletes.** Dropped tables and removed fields are recoverable for 30 days unless the company
  has enabled hard deletes.
- **Company-role cache.** KyoubeAI caches each company's membership list from the core for 30 seconds
  (the terminal keeps its own cache of the same shape — see [Terminal](#terminal) for which of its
  actions bypass it).
  Schema changes (creating, altering, renaming or dropping tables and fields, and creating indexes),
  data-access administration (agent grants and company data settings), and publishing, rolling back or
  archiving an app all re-read the caller's role from the core first, so removing or demoting a member
  takes those away immediately. Reads and row writes take the cached answer: for up to 30 seconds after
  a member is removed or demoted, an in-flight session of theirs may still read, insert, update or
  delete rows at their previous level. Nothing they do in that window is unaudited — every mutation is
  recorded in `kyoube_meta.audit` with their identity — and the window closes on its own. Revoking a
  company's data access entirely (rather than one member's) takes effect at once.

## Apps

An app is one HTML document written by an agent and reviewed by whoever publishes it. It runs in an
iframe with `sandbox="allow-scripts allow-forms allow-modals"` (no `allow-same-origin`, so an opaque
origin: no cookies, no storage, no host DOM) under an injected `Content-Security-Policy` of
`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;
font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`. Data reaches it only through
a `postMessage` bridge that re-authorises every call under **the viewer's own identity** and against
the published manifest's declared tables, so an app can never do more than the person using it could do
on the Data page.

Each mount also has a **call budget** (60 requests per rolling 10 seconds, of which at most 5 may be
toasts; every non-handshake request counts, including one the host refuses as invalid — a message
that is not a well-formed request, or carries the wrong nonce, is dropped without being charged).
Four residuals are known and accepted, documented in full in `docs/apps.md`:

- **DNS prefetch and preconnect are not governed by CSP.** `<link rel="dns-prefetch">` /
  `<link rel="preconnect">` ask the browser to resolve a hostname and open a socket, not to fetch a
  resource, and no CSP directive covers them. This is a one-way, low-bandwidth channel — nothing is
  fetched, no response is readable, and `connect-src 'none'` still blocks every actual request — so it
  can leak a fact (via a hostname), not a table. Forbidden by the authoring rules; every version's
  source is stored and reviewable.
- **An app can navigate its own frame, and briefly keeps the same `WindowProxy`.** Neither a sandbox
  token nor a CSP directive stops a frame assigning `location`. Two independent mechanisms close this:
  the runner counts loads and kills the app on the second, and every message must carry the per-mount
  handshake nonce the runner inlined ahead of the SDK — 16 random bytes written into the document
  immediately ahead of the injected `window.kyoube` SDK, before any app-authored byte is parsed — which
  the SDK removes from both `window` and the DOM as it installs, so app code never reads it back and a
  document that merely arrives by navigation cannot know it. Nor can app code read it off the SDK's own
  traffic: the SDK binds `window.parent` at install, before any app byte is parsed, so assigning over
  that property afterwards intercepts nothing (ruling P4-R37). What an app in the frame holds
  regardless is the context it asked for through its own `kyoube.ready()`, and the choice of URL it
  navigates itself to — a cooperating app needs no nonce for either. Three attempts without the nonce
  stop the app. The viewer's context is released
  only in answer to a message carrying that nonce, never on a frame load, so a document arriving by
  navigation alone is told nothing about the company, the viewer or the app. The residual is that the
  *navigation itself* still happens, so a URL an app navigates to is a URL the browser requests; it
  carries no host credentials (opaque origin, no cookies, no storage) and gets nothing back that the
  app can read.
- **`sql_select` allows a schema-qualified `OPERATOR(schema.op)`** — see the Data section above.
- **`viewer.name` is always empty in v1** — the host gives an app the viewer's id, not their display
  name (see `docs/apps.md`), so an app cannot greet a viewer by name.

## Files

The **Files** tab on a project page lets company members browse and change the project's working
folder — the configured workspace, or the managed folder the core creates for the project under
`/kyoubeai/instances/default/projects/<companyId>/<projectId>/` — which is the folder the project's
agents run in. It is deliberately a narrow surface: one folder per project, chosen by the core (the
plugin asks the host for the project's effective local folder through `ctx.projects.getPrimaryWorkspace`
and never derives or accepts a path from the browser), for people who can already open that project.

**Who may use it.** Every action — reads included — is a host-authenticated `performAction` call, so
the caller's identity is the actor the core supplies, never a client-supplied id, and it must be a
signed-in user (agents are refused; they have the folder already). The user's company role is checked
against the plugin's `readRoles` (default: every role) or `writeRoles` (default: every role but
`viewer`) under **Settings → Plugins → Kyoube Files**. Reads take the same 30-second membership cache as
the Data page; every mutation reads the members API afresh, so a demoted or removed member can browse
for at most 30 more seconds and can change nothing from the moment the change lands. Project
visibility in core 2026.831.1 through 2026.916.1 is company-wide (`project:read` is granted to every active member in its
simple permissions mode), so the company role is the right unit here; if a future core adds
per-project membership the plugin will need to consult it, and this section will say so. The project
must be in the host's company scope: `getPrimaryWorkspace` answers `null` otherwise, and a
`params.companyId` that contradicts the host's scope is rejected as spoofing, exactly as in the other
two plugins.

**What it can reach.** Two invariants, both enforced in `WorkspaceFiles`
(`plugins/kyoube-files/src/fs-service.ts`) and covered by its tests:

1. *Nothing outside the project folder is ever touched.* A path is normalised before the disk is
   consulted (absolute paths, `..` segments, NUL bytes and backslashes are refused outright), and the
   *resolved* location of every parent directory is then checked against the folder's own resolved
   location — so a symbolic link that an agent, or a cloned repository, left inside the folder cannot
   lead a listing, a read or a write out of it.
2. *Symbolic links are never followed.* They are listed as links, may be renamed or deleted (which
   acts on the link, never its target), and are refused for read and write. Following one would let a
   link to, say, `/kyoubeai/.claude/.credentials.json` be read by anyone who can browse the project.

Within those bounds the plugin does what a file manager does: `.env` files, keys an agent wrote into
the folder, and `.git` internals are all visible and editable to anyone the role settings admit, the
same as they are to every agent that runs there. Keep secrets an agent needs in the core's Secrets, not
in the project folder, and keep `readRoles` no wider than the people who should see the project's work.

**Limits.** The editor opens files up to `maxEditableKb` (1 MiB by default; larger files are download-
only, never truncated — a truncated file that was then saved would be a destroyed file), a single upload
is capped at `maxUploadMb` (5 MiB by default, clamped to 7 because the core's 10 MB JSON body limit is
the ceiling for a base64 payload), and a download at `maxDownloadMb` (25 MiB). A save carries the
modification time the file had when it was opened and is refused (`conflict`) if the file changed
since, so a person and an agent editing the same file cannot silently overwrite each other; the person
chooses to reload or overwrite.

**HTML preview.** An HTML file opens rendered, in an `<iframe sandbox="allow-scripts allow-forms
allow-modals">` (no `allow-same-origin`: an opaque origin with no cookies, no storage and no host DOM)
under the same policy the [Apps](#apps) runner injects — `default-src 'none'`, `connect-src 'none'`,
`form-action 'none'`, `base-uri 'none'`, inline script and style only, `data:`/`blob:` images — so a
page an agent wrote can run its own script but cannot reach the network, navigate the host, or read
anything the viewer can. Because the frame cannot fetch, the plugin inlines the stylesheets, scripts
and images the page references by *relative* path from the same project folder (through the same
authorised `files.read` action, so nothing the viewer could not open is inlined; at most 40 files, and
absolute URLs are left unresolved and therefore blocked). The preview shows nothing that the source
view would not, to the same person.

**The task panel.** The folder icon in the top bar is a `globalToolbarButton` slot, whose host
context carries only the company. The component reads the task reference from the URL and asks the
worker (`files.locate`) which project it belongs to — through `ctx.issues.get`, which answers `null`
for a task outside the company — and shows the icon only when the caller's role may browse. The
docked panel then goes through exactly the same actions and checks as the project tab.

**What is logged.** Every mutation writes one line to the company's activity log — the operation, the
path, the workspace and the user — and never file content. Reads are not logged.

## Studio

The Studio design is two parts. `docker/theme` adds a stylesheet, fonts and a short inline boot
script to the served UI at build time; the script only sets two attributes on `<html>` (a platform
hint for the ⌘K label and the layout flag) and makes no network requests. The `kyoube.studio` plugin
draws Home, the sidebar's Build group and Team roster, the agent profiles and the Workspace page.

**What it reads.** Through the host-scoped `getData` bridge only: the company's agents (name, title,
icon, status, last run, error reason), its tasks (identifier, title, status, assignee, timestamps),
its pending approvals (type and the title or name in the payload), its projects (a count), its
members' roles, an agent's harness and skill names (from its adapter configuration; no other
configuration value leaves the worker), and the agent's own comments on the task it is working on. That is the same company-wide information the core's own dashboard, inbox and task
list show every member; hidden tasks are skipped. It has no API routes, no agent tools, no jobs, no
outbound network, no database and no secrets, and the plugin itself writes nothing: its only
capabilities are `agents.read`, `issues.read`, `issue.comments.read`, `approvals.read`,
`projects.read`, `access.members.read` and the UI slot registrations.

**The profile's actions.** The agent profile's **On duty** switch and **Assign task** form call the
core's documented board API from the browser as the signed-in person (`POST /api/agents/{id}/pause`
and `/resume`, `POST /api/companies/{companyId}/issues`), exactly as the core's own buttons do: the
core checks that person's access and applies its own side effects (pausing cancels the agent's active
run; the new task wakes the agent). The plugin grants no one a power they did not already have.

**Which company.** The host puts the caller's authorized company into every bridge call and refuses a
call without one unless the caller is an instance admin, so a person only ever sees their own
company's figures. The Workspace page's owner/admin check (which cards to show) uses the user id the
page sends and is cosmetic only: the Terminal and Plugins pages it links to enforce their own access.

**In the browser.** The only thing Studio stores is a per-company flag in `localStorage` recording
that the getting-started strip was dismissed. Agent characters are SVG generated from a fixed set of
shapes; an agent's name only picks among them and is never put into the markup.

## Telemetry

Two switches are set in two places, because one place is not enough. `docker/Dockerfile`'s runtime
stage sets `DO_NOT_TRACK=1` and `DISABLE_TELEMETRY=1` in the **container** environment, which covers
the core server, the `kyoube` CLI, and anything the entrypoint starts. A **Terminal** session
does not inherit that environment: `plugins/kyoube-terminal/src/spawn-env.ts` hands node-pty a
closed, explicitly built environment (that is what keeps database credentials and provider keys out
of a shell), so it sets the same two switches on every shell it spawns — which is where `claude`,
`pi` and `hermes` are actually authenticated and run. Both names are conventions rather than one
product's switch. **This is not a claim that the image is telemetry-free**: it bundles third-party
software this project does not build, and what follows says exactly which parts were verified and
which were not.

| Component | Where it comes from | What is known |
|---|---|---|
| **Core** (server, CLI) | the base image | First-party telemetry, **opt-out and on by default**. Verified in upstream's source: `resolveTelemetryConfig` (`packages/shared/src/telemetry/config.ts`) returns `enabled: false` when `PAPERCLIP_TELEMETRY_DISABLED=1`, when `DO_NOT_TRACK=1`, on a CI runner, or when the config file says `telemetry.enabled: false`; with it disabled the client is never constructed. Otherwise it POSTs batches of named events to `https://telemetry.paperclip.ing/ingest` (with an AWS API Gateway fallback), carrying a random per-install `installId`, the version, and event dimensions; upstream's own contract forbids PII, prompts, file paths and secrets. **`DO_NOT_TRACK=1` is what this image sets, so it is off.** |
| **Claude Code** | `docker/Dockerfile` (`@anthropic-ai/claude-code`, pinned; it replaces the base image's `@latest` copy) | Reads `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, then `DISABLE_TELEMETRY`, then `DO_NOT_TRACK`, and treats either of the last two as "no telemetry" — verified by inspecting an installed CLI binary (2.1.266), **not** the build inside this image. It also supports an opt-in OpenTelemetry exporter (`CLAUDE_CODE_ENABLE_TELEMETRY`), which this image does not set. What it sends *by default*, signed in, was not verified here. |
| **pi** (`@earendil-works/pi-coding-agent`) | installed by `docker/Dockerfile` | **Not verified.** The package is not vendored in this repository, so nothing here can say what it sends. `DO_NOT_TRACK` is set for it regardless; whether it honours it is unknown. |
| **Hermes Agent** | cloned at build from a pinned commit | **Not verified**, for the same reason: the source is fetched during the build and is not in this repository. |
| **Playwright / Chromium** | installed for Hermes' Computer Use path | **Not verified.** A driven browser fetches whatever page the agent sends it to — that is the feature, not telemetry — and whether Chromium's own background services are disabled depends on the flags Hermes launches it with. |
| **node-pty** | terminal plugin dependency | Spawns local processes; it has no network path of its own. |

Two more things an operator should know. The base image also installs other vendor CLIs that Kyoube
neither uses nor configures (Codex, OpenCode, Gemini CLI, Kimi Code); their behaviour is upstream's,
and is not verified here either. And telemetry is not the same thing as an agent's own traffic: a
harness you authenticate talks to its model provider by design, and no environment variable changes
that.

The one option deliberately left off is `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, which also
disables update checks. To opt in, add it to the `app` service's `environment:` in
`docker-compose.yml`: the terminal plugin passes that one variable through from the container
environment into every Terminal shell as well (it is the only passthrough in the shell environment's
allowlist), so setting it once covers both the server and the shells.

The core facts above were read from an upstream checkout of `master` dated 2026-09-04; the
image pins a published release (`KYOUBE_CORE_VERSION`). They are the same code family, not a
byte-for-byte comparison against the image, so treat the `DO_NOT_TRACK` behaviour as verified for
that source and re-check it after a large upstream bump.

## Out of scope

- **The core itself.** Authentication, sessions, the board API, deployment modes, and the MCP tool
  gateway are upstream's responsibility — report a vulnerability there through
  [the upstream project's Security Policy](https://github.com/paperclipai/paperclip/security/advisories/new),
  and see its [`SECURITY.md`](https://github.com/paperclipai/paperclip/blob/main/SECURITY.md).
- **The host OS, Docker Engine, and the network the deployment runs on.** KyoubeAI assumes a
  reasonably maintained host; see [`docs/operations.md`](docs/operations.md) for resource limits and
  [`docs/upgrading.md`](docs/upgrading.md) for keeping the image current.
- **A deployment exposed to the public internet without TLS.** `kyoube doctor` warns
  (check `exposure`) when `KYOUBE_DEPLOYMENT_EXPOSURE=public` and `KYOUBE_PUBLIC_URL` is not an
  `https://` address; putting TLS in front of a public deployment is the operator's responsibility.

## Secrets and rotation

Secrets live in `.env` (`BETTER_AUTH_SECRET`, `POSTGRES_PASSWORD`, `KYOUBE_DB_PASSWORD`, provider API
keys) and on the `kyoubeai-home` volume (the board API key at `kyoube/board-key.json`, and every agent
harness's own login under `.claude`, `.pi`, `.hermes`). **A backup contains all of it** —
`scripts/backup.sh` dumps both databases and archives the whole home volume — so store and transmit a
backup directory with the same care as `.env` itself.

See [`docs/operations.md`](docs/operations.md#rotating-the-board-api-key) for rotating the board API
key, [`docs/operations.md#resetting-harness-credentials`](docs/operations.md#resetting-harness-credentials)
for resetting an agent harness's login, and
[`docs/operations.md#restore`](docs/operations.md#restore) for how `KYOUBE_DB_PASSWORD` is re-applied to
the `kyoube` role from the deployment's own secret (never from the backup) when restoring onto a fresh
cluster.
