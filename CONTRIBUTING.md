# Contributing to KyoubeAI

KyoubeAI is a Docker overlay on top of the upstream core (Paperclip, https://github.com/paperclipai/paperclip):
two core plugins (`kyoube.terminal`, `kyoube.apps`), an app SDK, and a small bootstrap CLI. This
document is local setup, conventions, and the review checklist. For how the pieces fit together, read
[`docs/architecture.md`](docs/architecture.md) first.

## Local setup

Requirements: Node 24 (see `.nvmrc`), pnpm (pinned via `packageManager` in `package.json` — plain `pnpm`
switches itself to the pinned version, so `corepack enable` is optional; it is known to fail on some
Windows setups). For the full Docker smoke test: Docker Engine with Compose v2, `curl`, `jq`.

```bash
git clone https://github.com/jknigel/KyoubeAI.git && cd KyoubeAI
pnpm install
```

Unit tests (bootstrap CLI, both plugins, the app SDK — no database needed):

```bash
pnpm test
pnpm typecheck
pnpm build
```

The apps plugin also has an integration suite that runs its schema/records/company-isolation/migration
tests against a real Postgres. Start a throwaway one and export the URL it prints:

```bash
bash scripts/dev-db.sh
# prints: export KYOUBE_TEST_DATABASE_URL=postgres://postgres:dev@localhost:5433/postgres
export KYOUBE_TEST_DATABASE_URL=postgres://postgres:dev@localhost:5433/postgres
pnpm --filter @kyoube/plugin-apps test:integration
```

The full end-to-end check builds the image, brings up the compose stack, claims a fresh instance,
installs both plugins, and exercises the terminal/data/apps paths plus a backup/restore round trip. It is
what CI's `docker-smoke` job runs, and takes roughly 12–25 minutes locally depending on build cache:

```bash
pnpm smoke   # == bash scripts/smoke.sh
```

Before opening a PR that touches the core pin, also run `bash scripts/check-pins.sh` — it is the
first step of CI and fails fast if `KYOUBE_CORE_VERSION` and the plugin SDK pins disagree.

## Branch and commit conventions

- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`, optionally scoped —
  `feat(apps): …`, `fix(terminal): …`). `CHANGELOG.md` is written in these terms.
- **LF line endings** everywhere (`.gitattributes` sets `eol=lf`; `.editorconfig` matches). Watch for this
  especially on Windows — some tools (e.g. certain `jq` builds) write CRLF when redirected to a file.
- **One task per PR.** Keep a PR reviewable: one logical change, its tests, and any doc updates it makes
  necessary. If you're working from a plan under `docs/superpowers/plans/`, one plan task is one PR.

## Where things live

The workspace has five `package.json`s: the private root, and four publishable/deployable members.

| Path | Package | What it is |
|---|---|---|
| *(root)* | `kyoubeai` | Workspace root: `docker-compose.yml`, `docker/`, `docs/`, `scripts/`, `.github/`. |
| `docker/bootstrap/` | `@kyoube/bootstrap` | The `kyoube` CLI (`setup`, `ensure-plugins`, `doctor`). |
| `plugins/kyoube-terminal/` | `@kyoube/plugin-terminal` | The browser terminal plugin. |
| `plugins/kyoube-apps/` | `@kyoube/plugin-apps` | The organisation database and Apps plugin (one worker, two modules). |
| `packages/kyoube-app-sdk/` | `@kyoube/app-sdk` | `window.kyoube`, injected into every app's iframe. |

Within `plugins/kyoube-apps/src/`: `data/` is the schema/records/permissions/SQL-validation service,
`apps/` is the Apps module (manifest, store, service, tools, API routes) built on top of it, `db/` is the
company-scope and migration machinery, `ui/` is the plugin's React pages, and `skills/` holds the two
managed-skill Markdown files (`kyoube-data.md`, `kyoube-apps.md`) shipped in the plugin manifest.

## Never patch the core

Nothing in this repository is core source, and the image is built `FROM` the pinned upstream release,
rebranded but otherwise unmodified. If something you need isn't possible through `@paperclipai/plugin-sdk` (a capability that
doesn't exist, a route the plugin host doesn't expose), the answer is never to vendor or patch upstream
code — propose it upstream (open an issue or PR on
[`paperclipai/paperclip`](https://github.com/paperclipai/paperclip)) or find a way to build it as a
plugin. `docs/architecture.md`'s "Isolation from upstream" material and `docs/upgrading.md` explain why
this matters: it is what makes a core version bump a one-line change instead of a rebase. The single
exception is `docker/rebrand/`, a build-time transform of the core's *user-facing text and artwork* that
is re-applied on every build; it changes no behaviour, and `docs/branding.md` lists what it leaves
alone.

## How to add a tool

Both the `data_*` tools (`plugins/kyoube-apps/src/tools.ts`) and the `apps_*` tools
(`plugins/kyoube-apps/src/apps/tools.ts`) share one runtime (`src/tool-runtime.ts`), so adding either
follows the same shape:

1. **Add the definition.** Append a `ToolDefinition` to `TOOL_DEFINITIONS` (data) or
   `APP_TOOL_DEFINITIONS` (apps): a `name`, `displayName`, `description`, a Zod `schema` for its
   parameters, and a `run(service, companyId, actor, params)` that calls the corresponding method on
   `DataService`/`AppService`. Both `toolDeclarations()`/`appToolDeclarations()` and the plugin manifest
   (`src/manifest.ts`) derive from these arrays automatically — there is no separate manifest list to
   keep in sync by hand.
2. **Add a unit test.** `tests/unit/tools.spec.ts` and `tests/unit/apps-tools.spec.ts` each assert the
   *exact, ordered* list of declared tool names and that the manifest's `tools` array matches it — so a
   new tool that isn't added to that expected-names list fails the test immediately, which is what keeps
   the manifest and the code from drifting apart. Add a case exercising the new tool's happy path and its
   validation/permission failures, following the existing tests in that file as a template.
3. **Update the skill.** Add the tool to the relevant managed skill (`src/skills/kyoube-data.md` or
   `src/skills/kyoube-apps.md`) so an agent is told it exists, what it does, and any access level it
   requires — the skill text is what an agent actually reads; the tool description alone is not enough
   guidance for a workflow.
4. **Verify.** `pnpm --filter @kyoube/plugin-apps test` and `pnpm --filter @kyoube/plugin-apps build` (the
   skill Markdown is bundled into the built manifest, so a build after a skill edit is part of verifying
   it, not optional).

## Review checklist

- Tests, typecheck, and (for a change under `plugins/kyoube-apps/`) the integration suite pass.
- Conventional Commit message; LF line endings; docs updated where the change makes them stale.
- No new code imports from the core's own source or calls an undocumented route (see "Never patch
  the core" above).
- For anything touching the terminal gate, a data/company boundary, or the apps sandbox, run
  [`.github/ISSUE_TEMPLATE/security-review.md`](.github/ISSUE_TEMPLATE/security-review.md)'s checklist
  against your change before requesting review.

## Licensing and contributor agreement

KyoubeAI is licensed under the GNU Affero General Public License, version 3 (`LICENSE`). So that the
project can offer the same code under other terms as well (commercial licences fund its development),
every contribution needs the Contributor License Agreement in [`CLA.md`](CLA.md). It licenses your
contribution to the project under the AGPL and under any other terms the maintainer chooses, and it
leaves every right you have to your own work untouched. Agree to it once, in the description of your
first pull request, with the sentence it names. Do not add licence headers to individual files; the
repository-level `LICENSE` and `NOTICE.md` cover them.
