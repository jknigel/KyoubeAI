# Changelog

All notable changes to KyoubeAI are recorded here, in terms of what changed for someone running or
building on it. The format is loosely [Keep a Changelog](https://keepachangelog.com/); versioning is
[SemVer](https://semver.org/).

## Unreleased

### Added

- **Files** — a third plugin, `kyoube.files` (`plugins/kyoube-files`), adds a **Files** tab to every
  project page and a **Files** link under each project in the sidebar. It shows the project's working
  folder — the configured workspace, or the managed folder the core creates for the project and starts
  its agents in — and lets company members browse it, open and edit text files, preview Markdown and
  images, create files and folders, upload, download, rename and delete. The listing and any open file
  refresh themselves every few seconds so an agent's changes appear as they land; a save is refused if
  an agent changed the file since it was opened, with a choice to reload or overwrite. Who may browse
  and who may change files are per-instance settings (**Settings → Plugins → Kyoube Files**; by default
  every role browses and every role but `viewer` edits). No path can leave the project folder, symbolic
  links are never followed, and every change is written to the activity log with its path, never its
  content. `SECURITY.md` has a **Files** section describing the bounds.
- HTML files open rendered as the page they are, in a sandboxed frame with no network access and the
  page's own relative stylesheets, scripts and images inlined from the folder; SVG files open as
  drawings. A **View/Edit source** toggle shows the markup. Every viewer — editor, Markdown preview,
  image, page — fills the screen below the page header.
- A folder icon at the right end of the top bar on every task that belongs to a project docks the
  project folder in a panel on the right of the screen, beside the chat (no backdrop), with the same
  browser and editor; it follows the viewer from task to task until closed.
- The image builds and ships the new plugin alongside the other two; `kyoube ensure-plugins` installs it
  on the next start with no operator action.
- **First-run setup can skip the harness.** The onboarding wizard's "Connect" step probes the chosen
  harness and refused to create the first agent while the probe failed — which, on a fresh install, it
  always does until someone has run `claude login` (or `pi`, `hermes setup`) from the Terminal page the
  wizard itself was covering. A failed probe now reads *"This harness is not connected yet …"* and
  offers **Skip for now and connect the harness later**: the agent is created with the chosen harness
  unauthenticated, setup finishes, and the harness is connected afterwards from the Terminal page (or
  by a provider key in `.env`). Applied at image build time by `docker/core-patches`
  (`onboarding-skip-harness-handler`, `onboarding-skip-harness-button`).

### Fixed

- **Task chat with a pi agent** no longer shows every command's raw output and the core's own
  "Resume Delta" wake prompt as agent messages in the body font. Upstream's pi transcript parser
  (`packages/adapters/pi-local/src/ui/parse-stdout.ts`, core 2026.831.1 and `main` at the time of
  writing) turns every `message_end` event into agent text without checking the message's role; pi
  emits that event for the user turn and for each tool result too, so the prompt and every tool
  output (already shown on its tool card) appeared again as prose. Fixed at image build time by
  `docker/core-patches` (`pi-transcript-non-assistant-messages`), held until the upstream fix ships;
  `CONTRIBUTING.md` records the rules that bound it.

## 1.0.0 - 2026-09-17

The first release: KyoubeAI as a self-hosted, multi-user AI operating system for an organisation, built
entirely as an overlay and a pair of plugins on top of the upstream core (Paperclip), and branded as
KyoubeAI on every surface.

### Docker packaging

- One `docker compose up -d` brings up the whole stack: the `app` image (this repository's overlay, built
  `FROM` a pinned core release) and a dedicated `db` service (Postgres 17) holding two databases — the
  core's own `kyoubeai` database and Kyoube's separate `kyoube` database.
- Three agent harnesses pre-installed at pinned versions and ready to authenticate from the browser:
  Claude Code (`CLAUDE_CODE_VERSION`, 2.1.267), pi (0.85.1) and Hermes Agent (0.21.1, release
  v2026.9.7). The build fails unless each CLI's `--version` prints exactly the pinned version.
- A `kyoube` CLI bundled in the image (`setup`, `ensure-plugins`, `doctor`) handles first-boot plugin
  installation, automatic upgrades on every start, and one-command health diagnostics.
- The container's home is `/kyoubeai` (compose volume `kyoubeai-home`, `HERMES_HOME=/kyoubeai/.hermes`);
  the Postgres role and database are `kyoubeai`. Operators configure the stack with `KYOUBE_*` keys in
  `.env` (`KYOUBE_PUBLIC_URL`, `KYOUBE_DEPLOYMENT_EXPOSURE`, `KYOUBE_CORE_VERSION`, `KYOUBE_PORT`, …),
  which `docker-compose.yml` maps onto the core's own settings.
- Telemetry is off by default in the container and in every Terminal shell (`DO_NOT_TRACK=1`,
  `DISABLE_TELEMETRY=1`); `SECURITY.md` records what was and was not verified for each bundled
  component.

### Branding

- Every surface says KyoubeAI: the web UI (title, sign-in lockup, favicon, PWA manifest, every display
  string), API messages, the system prompts agents are given and the adapter configuration labels,
  harness docs and Skills-tab origin labels an operator reads, the built-in skills, the `kyoube` CLI and
  the docs. The core image is transformed at build time by `docker/rebrand/` (re-applied on every build,
  verified, fails the build on drift), and the build also sweeps the whole image — every tree outside a
  documented allowlist of never-executed upstream source must contain no display-text "Paperclip" or
  the build fails, so a future core bump that moves a user-facing string into a new place cannot ship
  unbranded. `docs/branding.md` lists what is deliberately left alone (`PAPERCLIP_*` variables agents
  read, skill keys, enum values, the header) and the known residuals (the hash-pinned `packages/db`
  migrations, one of which seeds the default execution environment's description).
- The brand is data: `docker/brand/` holds the name, URLs, mark and lockup; a rename or a new logo is a
  file swap and a rebuild.

### Terminal

- A browser terminal (`kyoube.terminal` plugin, 0.2.3) inside the container for company owners and
  admins: authenticate the agent harnesses, run `kyoube doctor`, and administer the box, without
  shelling into the host.
- Sessions are bound to the user who opened them, survive page reloads (attach/resume), close themselves
  after an idle timeout, and are audited on open/close/denial — keystrokes and output are never logged.
- Output is pulled with back-to-back `terminal.wait` long-polls (a worker action that answers as soon
  as output past the caller's sequence number exists, when the shell exits, or after a bounded
  timeout), because core 2026.831.1 never wires its plugin SSE stream bridge. The terminal box fits
  exactly: `scripts/terminal-fit-check.mjs` runs in CI and fails if fitting ever changes the box.

### Data

- Every company gets its own isolated Postgres schema and role in the `kyoube` database, created on
  first use and provably unreachable from any other company's role.
- People design and populate it from a **Data** page in the UI; agents use the same operations through
  REST routes under `/api/plugins/kyoube.apps/api/` or the 17 `kyoube.apps:data_*` tools, guided by a
  managed **Kyoube Data** skill. The skill leads with the REST routes, because core 2026.831.1 hands a
  run the tool gateway only when the agent already has an installed MCP connection.
- The **Kyoube Data** and **Kyoube Apps** skills reach every company's skill library by themselves:
  `kyoube ensure-plugins` installs them into every company at each container start, the first visit
  to a company's pages does the same, and a company created later gets them on creation. Enabling a
  skill on an agent stays a per-agent choice on the agent's Skills tab.
- Per-person access (from company role) and per-agent access (explicit grants, defaulting to none) at
  four levels — none, read, write, schema — enforced identically for the UI, the tools, and the REST
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
  history, publish, and roll back. `kyoube.apps` is 0.4.2.
- Apps run in an iframe with an opaque origin and a restrictive Content-Security-Policy — no network
  access, no cookies, no host DOM — and every data call an app makes is re-authorised under the
  identity of the person viewing it, so an app can never exceed what that person could already do.

### Operations

- `scripts/backup.sh` / `scripts/restore.sh` back up and restore both databases, the Kyoube cluster
  roles, and the persistent home volume (agent credentials, workspaces) as one unit, rehearsed
  end-to-end in CI.
- Multi-arch (`linux/amd64`, `linux/arm64`) images published to GHCR (`ghcr.io/jknigel/kyoubeai`) on
  tag and on every push to `main`; `docker-compose.yml` runs equally well from a prebuilt image or
  built from source.
- `scripts/check-pins.sh` and `scripts/bump-core.sh` keep the core image version and the plugin SDK
  version locked together across every file that pins them, enforced in CI.
- A weekly workflow builds and smoke-tests against the core's `:beta` channel and opens an issue on
  failure, so a breaking upstream change is caught before it reaches a stable version bump.
- A written security model (`SECURITY.md`) covering the three trust zones, a governance guide
  (`docs/governance.md`) with copy-paste recommended tool profiles and policies, and a security review
  checklist template for future releases.

### Licence

- `AGPL-3.0-only`. `LICENSE` carries the GNU Affero General Public License, version 3; the KyoubeAI
  copyright line and the core's MIT notice are in `NOTICE.md`; contributions need the agreement in
  `CLA.md` (see `CONTRIBUTING.md`).
