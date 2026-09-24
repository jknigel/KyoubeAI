# Changelog

All notable changes to KyoubeAI are recorded here, in terms of what changed for someone running or
building on it. The format is loosely [Keep a Changelog](https://keepachangelog.com/); versioning is
[SemVer](https://semver.org/).

## 1.0.0 - 2026-09-25

The first release: KyoubeAI as a self-hosted, multi-user AI operating system for an organisation, built
entirely as an overlay and four plugins on top of the upstream core (Paperclip 2026.916.1), and branded
as KyoubeAI on every surface.

### Docker packaging

- One `docker compose up -d` brings up the whole stack: the `app` image (this repository's overlay, built
  `FROM` a pinned core release) and a dedicated `db` service (Postgres 17) holding two databases, the
  core's own `kyoubeai` database and Kyoube's separate `kyoube` database.
- Three agent harnesses pre-installed at pinned versions and ready to authenticate from the browser:
  Claude Code (`CLAUDE_CODE_VERSION`, 2.1.281), pi (0.87.1) and Hermes Agent (0.21.4, release
  v2026.9.21). The build fails unless each CLI's `--version` prints exactly the pinned version.
- A `kyoube` CLI bundled in the image (`setup`, `ensure-plugins`, `doctor`) handles first-boot plugin
  installation, automatic upgrades on every start, and one-command health diagnostics.
- The container's home is `/kyoubeai` (compose volume `kyoubeai-home`, `HERMES_HOME=/kyoubeai/.hermes`);
  the Postgres role and database are `kyoubeai`. Operators configure the stack with `KYOUBE_*` keys in
  `.env` (`KYOUBE_PUBLIC_URL`, `KYOUBE_DEPLOYMENT_EXPOSURE`, `KYOUBE_CORE_VERSION`, `KYOUBE_PORT`, …),
  which `docker-compose.yml` maps onto the core's own settings. `TRUST_PROXY` is passed through for
  deployments behind a reverse proxy or tunnel.
- Telemetry is off by default in the container and in every Terminal shell (`DO_NOT_TRACK=1`,
  `DISABLE_TELEMETRY=1`), and the core's hosted announcement cards are turned off
  (`PAPERCLIP_ANNOUNCEMENTS_ENABLED=false`). `SECURITY.md` records what was and was not verified for
  each bundled component.

### Branding

- Every surface says KyoubeAI: the web UI (title, sign-in lockup, favicon, PWA manifest, every display
  string), API messages, the system prompts agents are given and the adapter configuration labels,
  harness docs and Skills-tab origin labels an operator reads, the built-in skills, the `kyoube` CLI and
  the docs. The core image is transformed at build time by `docker/rebrand/` (re-applied on every build,
  verified, fails the build on drift), and the build also sweeps the whole image: every tree outside a
  documented allowlist of never-executed upstream source must contain no display-text "Paperclip" or
  the build fails, so a future core bump that moves a user-facing string into a new place cannot ship
  unbranded. `docs/branding.md` lists what is deliberately left alone (`PAPERCLIP_*` variables agents
  read, skill keys, enum values, the header) and the known residuals (the hash-pinned `packages/db`
  migrations, one of which seeds the default execution environment's description).
- The brand is data: `docker/brand/` holds the name, URLs, mark and lockup; a rename or a new logo is a
  file swap and a rebuild.

### Studio

- **KyoubeAI's own design.** The app uses the KyoubeAI website's palette and type (zinc neutrals, a deep
  teal accent, Instrument Serif for greetings) and opens **dark** by default; a choice made with the
  theme toggle still wins.
  - **Sidebar.** Built for the core's streamlined shell: a search field and one solid **New task**
    button; Home, Inbox, Tasks, Projects; a **Build** group (Data, Apps, Routines); a **Team** roster
    where each agent has a face, a live status dot and a line saying what it is doing; and
    **Workspace** at the bottom. KyoubeAI's Data, Apps and Terminal links look and behave like the
    core's rows (icons, spacing, active state).
  - **Workspace page** (`/<company>/workspace`): All agents with the org chart, members and invites,
    Audit, Timeline (`/activity/timeline`), Costs (`/activity/costs`), Approvals, Skills, Artifacts,
    Projects, Connectors, Settings, and for owners and admins Plugins and Terminal. Every one of them is
    still reachable from ⌘K.
  - **Home.** The dashboard opens with a greeting that counts what needs you, a getting-started strip
    for new workspaces, **Needs you** (approvals, reviews, blocked tasks, agents in error),
    **Your team right now** and **Latest updates**, above the core's metrics and charts.
  - **Agent profile** (`/<company>/team/<agent>`). A page for each agent: its character and live
    status, title, manager and harness; an **On duty** switch, **Chat** and **Assign task**;
    **Overview** (working now with its own latest notes, recent work, tasks done this week, open tasks,
    spend this month, skills, who it works with) and **Tasks**, plus the core's Instructions, Skills,
    Runs and Settings tabs. Every link to an agent opens the profile, including `/agents/<agent>` and
    `/agents/<agent>/overview`; **Runs** opens the agent's runs under Audit, **Settings** opens
    Harness / Runtime, and `?classic=1` keeps the core's own overview. Pausing and assigning go through
    the core's documented board API as the signed-in person, so the core's permissions and side effects
    apply.
  - **Characters.** Every agent gets a face from its icon and name; `bot`, `cpu` and `circuit-board`
    are robots, and the character is painted over the core header's avatar. Task assignee chips, the
    org chart and the agents list keep the core's icons until the core supports agent pictures.
  - **Renames.** Dashboard is **Home**. The core calls its outside-tools area Connectors, so "Apps"
    means only KyoubeAI's Apps. KyoubeAI's plugin pages are titled by their page and drop the host's
    Back link.
  - Built as a fourth plugin, `kyoube.studio` (0.2.0, `plugins/kyoube-studio`), and a build-time step,
    `docker/theme`, which runs before the rebrand, checks every rule, hook and token against the core
    before writing, and fails the build naming what moved. Every skin rule that hides or moves core UI
    is gated on the Studio plugin, so without it the stock layout shows. `scripts/smoke.sh` signs in
    with headless Chrome (`scripts/studio-live-check.mjs`) to check the design and that fallback, and
    CI keeps its screenshots. `docker/theme` is documented as the second standing exception to "Never
    patch the core". Details: `docs/theme.md`.

### Terminal

- A browser terminal (`kyoube.terminal` plugin, 0.2.4) inside the container for company owners and
  admins: authenticate the agent harnesses, run `kyoube doctor`, and administer the box, without
  shelling into the host.
- Sessions are bound to the user who opened them, survive page reloads (attach/resume), close themselves
  after an idle timeout, and are audited on open/close/denial. Keystrokes and output are never logged.
- Output is pulled with back-to-back `terminal.wait` long-polls (a worker action that answers as soon
  as output past the caller's sequence number exists, when the shell exits, or after a bounded
  timeout), because the core (2026.831.1 through 2026.916.1) never wires its plugin SSE stream bridge.
  The terminal box fits exactly: `scripts/terminal-fit-check.mjs` runs in CI and fails if fitting ever
  changes the box.

### Data

- Every company gets its own isolated Postgres schema and role in the `kyoube` database, created on
  first use and provably unreachable from any other company's role.
- People design and populate it from a **Data** page in the UI; agents use the same operations through
  REST routes under `/api/plugins/kyoube.apps/api/` or the 17 `kyoube.apps:data_*` tools, guided by a
  managed **Kyoube Data** skill. The skill leads with the REST routes, because the core (2026.831.1
  through 2026.916.1) hands a run the tool gateway only when the agent already has an installed MCP
  connection.
- The **Kyoube Data** and **Kyoube Apps** skills reach every company's skill library by themselves:
  `kyoube ensure-plugins` installs them into every company at each container start, the first visit
  to a company's pages does the same, and a company created later gets them on creation. Enabling a
  skill on an agent stays a per-agent choice on the agent's Skills tab.
- Per-person access (from company role) and per-agent access (explicit grants, defaulting to none) at
  four levels (none, read, write, schema), enforced identically for the UI, the tools, and the REST
  routes.
- Read-only SQL (`data_sql_select`) for reporting: single `SELECT` statements only, restricted to a
  company's own tables and an allowlist of safe built-in functions, run with a statement timeout and a
  row cap.
- Dropped tables and fields are recoverable for 30 days (configurable to hard delete), and every
  mutation, schema change, and grant change is recorded in a per-company audit trail.

### Apps

- AI-built, database-backed single-file HTML applications (CRMs, trackers, small internal tools) that
  run sandboxed inside the KyoubeAI UI at `/<company>/app-artifact/<slug>` and talk to a company's Data
  tables through an injected `window.kyoube` SDK; the frame fills the window exactly
  (`scripts/app-frame-check.mjs` runs in CI).
- Agents build, update, and publish apps through the REST routes or the 7 `kyoube.apps:apps_*` tools,
  guided by a managed **Kyoube Apps** skill; people browse a gallery, review an app's source and version
  history, publish, and roll back. `kyoube.apps` is 0.4.3.
- Apps run in an iframe with an opaque origin and a restrictive Content-Security-Policy (no network
  access, no cookies, no host DOM), and every data call an app makes is re-authorised under the
  identity of the person viewing it, so an app can never exceed what that person could already do.

### Files

- A **Files** tab on every project page and a **Files** link under each project in the sidebar
  (`kyoube.files` plugin, 0.3.0). It shows the project's working folder (the configured workspace, or
  the managed folder the core creates for the project and starts its agents in) and lets company
  members browse it, open and edit text files, preview Markdown and images, create files and folders,
  upload, download, rename and delete. The listing and any open file refresh themselves every few
  seconds so an agent's changes appear as they land; a save is refused if an agent changed the file
  since it was opened, with a choice to reload or overwrite.
- HTML files open rendered as the page they are, in a sandboxed frame with no network access and the
  page's own relative stylesheets, scripts and images inlined from the folder; SVG files open as
  drawings. A **View/Edit source** toggle shows the markup.
- A folder icon at the right end of the top bar on every task that belongs to a project docks the
  project folder in a panel on the right of the screen, beside the chat (no backdrop), with the same
  browser and editor; it follows the viewer from task to task until closed.
- Who may browse and who may change files are per-instance settings (**Settings → Plugins → Kyoube
  Files**; by default every role browses and every role but `viewer` edits). No path can leave the
  project folder, symbolic links are never followed, and every change is written to the activity log
  with its path, never its content. `SECURITY.md` has a **Files** section describing the bounds.

### Onboarding and core patches

- The first-run wizard can finish before a harness is signed in. Its **Connect a model** step cannot
  sign a Claude or OpenAI subscription in on a KyoubeAI server (the core allows that only to the local
  operator of a `local_trusted` instance), so under any Connect error it offers **Skip for now and
  connect the harness later from the Terminal page**: the agent is hired without the sign-in and the
  environment test, and the harness is connected afterwards from the Terminal page or with a provider
  key in `.env`. `scripts/onboarding-live-check.mjs` walks the wizard to that skip on every smoke run.
- `docker/core-patches` holds fixes for upstream bugs until their upstream fixes ship, each applied at
  image build time and checked against the pinned core: the onboarding skip above
  (`onboarding-skip-harness-*`), and task chat with a pi agent showing only the agent's own messages
  (`pi-transcript-non-assistant-messages`; upstream's pi transcript parser turns the user turn and
  every tool result into agent text). If a patch stops matching because a build uses a different core
  than the release pins, the error names both versions and the `.env` line to change.

### Operations

- `scripts/backup.sh` / `scripts/restore.sh` back up and restore both databases, the Kyoube cluster
  roles, and the persistent home volume (agent credentials, workspaces) as one unit, rehearsed
  end-to-end in CI.
- Images published to GHCR (`ghcr.io/jknigel/kyoubeai`): release tags (`1.0.0`, plus `latest`) for
  `linux/amd64` and `linux/arm64`, and an amd64-only `sha-<commit>` test image on every push to `main`.
  `docker-compose.yml` runs equally well from a prebuilt image or built from source.
- `scripts/check-pins.sh` and `scripts/bump-core.sh` keep the core image version and the plugin SDK
  version locked together across every file that pins them, enforced in CI.
- A weekly workflow builds and smoke-tests against the core's `:beta` channel and opens an issue on
  failure, so a breaking upstream change is caught before it reaches a stable version bump.
- A written security model (`SECURITY.md`) covering the three trust zones, a governance guide
  (`docs/governance.md`) with copy-paste recommended tool profiles and policies, and a security review
  checklist template for future releases.

### Licence

- Source-available under the Business Source License 1.1 (`BUSL-1.1`). Production use is free for up
  to five users, provided KyoubeAI is not offered to others as a hosted, managed or embedded service;
  evaluation, development and testing are free without limit; any other production use needs a
  commercial licence. Each version becomes available under the Apache License, Version 2.0 four years
  after it is published. `LICENSE` has the terms, `NOTICE.md` the copyright line and the core's MIT
  notice, and contributions need the agreement in `CLA.md` (see `CONTRIBUTING.md`).
