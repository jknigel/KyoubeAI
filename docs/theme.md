# The Studio theme

KyoubeAI's own look ("Studio") comes from two parts, and neither edits the core:

- **`docker/theme/`** — a build-time step, like the rebrand. It adds a stylesheet of brand tokens and
  a sidebar/dashboard skin, inlines a small boot script, and makes a few display-text changes. It
  runs in `docker/Dockerfile` on the pristine core layer, after `docker/core-patches` and before
  `docker/rebrand`.
- **`plugins/kyoube-studio/`** (`kyoube.studio`) — an ordinary plugin on the public SDK. It draws
  the Home page, the sidebar's Build group and Team roster, the Workspace link and page, and the
  agent characters.

## What people see

- **Brand.** The website's palette: zinc neutrals, a deep teal accent (`#0f766e`, `#2dd4bf` in
  dark), five section tints, Inter for text and Instrument Serif for greetings and page names. The
  app opens **dark**; a choice made with the theme toggle is remembered and wins.
- **Sidebar.** A search field (⌘K / Ctrl K) and one solid **New task** button; then Home, Inbox,
  Tasks and Projects; a **Build** group (Data, Apps, Routines); a **Team** roster with each agent's
  character, a live status dot and what they are doing; and **Workspace** at the bottom. The collapsed
  rail keeps the same order, icons and faces only.
- **Moved to the Workspace page.** Org chart, all agents, members and invites, Activity, Timeline,
  Costs, Approvals, Skills, Artifacts, Projects, Connections, Settings, and (for owners and admins)
  Plugins and Terminal. Every one is still reachable from ⌘K and its own URL.
- **Home** (the dashboard). A greeting that says how many things need you; a three-step getting-started
  strip until each step is done (or dismissed); **Needs you** (approvals, reviews, blocked tasks, agents
  in error, each with one verb); **Your team right now**; and **Latest updates**. The core's metrics
  and charts follow below; its live-runs panel, which the team panel replaces, is hidden.
- **Renames.** Dashboard is called **Home** (the mobile bar already said so). The core's Apps area,
  which connects outside tools, is called **Connections**, and its own "Connections" sub-page is
  **Connected apps**. KyoubeAI's Apps (AI-built apps over company data) keep their name. A plugin
  page is titled by its page ("Data", "Workspace") instead of "Plugins › <plugin>", and KyoubeAI's own
  pages drop the host's Back link.
- **Agent profile** (`/<company>/team/<agent>`, the Concept C page). A header with the agent's
  character and live status, its name in the display face, its title, whom it reports to and the
  harness it runs on; an **On duty** switch, **Chat** (opens the task you would talk to it in) and
  **Assign task**. Tabs: **Overview** (what it is working on now with its own latest notes, recent work,
  tasks done this week, open tasks, spend this month, its skills, who it works with) and **Tasks** are
  Studio's; **Instructions**, **Skills**, **Runs** and **Settings** open the core's own agent tabs.
  Every link to an agent's default view opens the profile: the roster, Home, the org chart, the agents
  list and the task assignee links alike (the plugin redirects the core's `/agents/<agent>` and
  `/agents/<agent>/dashboard`). The core's agent page keeps its other tabs, with the agent's character
  and display-face name in its header and its first tab renamed **Overview**, which leads back to the
  profile. `/agents/<agent>/dashboard?classic=1` still shows the core's own view with its run charts.
- **Characters.** Each agent gets a face drawn from the icon picked in its settings (tint, hairstyle,
  accessory) and its name (skin tone, hair colour), so two agents with the same icon still differ. An
  agent with no icon gets a face from its name; `bot`, `cpu` and `circuit-board` are robots. The
  generator is `plugins/kyoube-studio/src/characters.ts`. **Limit:** the core has no picture field for
  agents, so other core surfaces (task assignee chips, the org chart, the agents list) keep its line
  icons and initials. Adding agent pictures upstream is the fix.

## How it survives core updates

| Layer | Relies on | Guarded by |
|---|---|---|
| Tokens (`theme.css`, top) | the CSS custom properties the core's light/dark switch reads (`--background`, `--sidebar`, `--radius`, …) | `theme.mjs` fails the build if the core stops declaring any of them |
| Skin (`theme.css`, rest) | route links (`href`), ARIA labels, `lucide-<name>` icon classes, and our own `data-kyoube-*` markers | every hook is an anchor in `anchors.mjs`; every rule that hides or moves core UI is gated (below) |
| Text rules (`rules.mjs`) | string literals in the compiled bundle, never minifier names | each rule must match exactly its declared count or the build fails |
| Studio plugin | the published plugin SDK (slots, `order`, `useHostNavigation`, `useHostLocation`, `ctx.agents/issues/approvals`) | the SDK pin, the plugin's tests, the smoke, and the weekly upstream-beta run |
| Agent profile actions | the core's documented board API (`POST /api/agents/{id}/pause`, `/resume`, `POST /api/companies/{id}/issues`), called as the signed-in person | the core's own permission checks; the live check follows an agent through the profile and the core tabs |

**Fail safe.** Every skin rule that hides or moves core UI applies only while the Studio layout is on:
the Studio roster (`[data-kyoube-studio="team"]`) is on the page, or `boot.js` has flagged the page
(`<html data-kyoube-shell="studio">`) while the plugin's UI loads. The flag clears itself after six
seconds if the roster never appears. So a missing or broken plugin, or a hook that stopped matching,
shows the stock sidebar rather than a broken one. A unit test fails if a hiding rule is added without
the gate.

**Checks, in the order they run on a core bump:**

1. `pnpm test` runs `docker/theme/tests` against excerpts of the real compiled core
   (`tests/fixtures/core-*.mjs`), including a failure test for every kind of upstream change.
2. The image build runs `theme.mjs`, which checks every rule, anchor, sidebar section and token
   against the new core **before writing anything** and fails naming what moved.
3. `scripts/smoke.sh` checks the served theme with curl, then `scripts/studio-live-check.mjs` signs
   in with headless Chrome and checks the design as rendered: dark by default, the Studio sidebar,
   Home above the charts, the Workspace page, an agent opened through the core's own URL landing on
   the profile (and the core agent tabs showing its character), and the stock sidebar returning when
   `kyoube.studio` is disabled. It saves screenshots to `STUDIO_SHOTS_DIR`, which CI uploads as the
   `studio-screenshots` artifact.
4. The weekly `upstream-beta` workflow does all of this against the core's `:beta` image.

## After a core bump

Read the `theme:` lines in the build log:

```
theme: 20 text rules applied in 3 file(s): home-sidebar-label 1/1, …
theme: anchors 17/17; sidebar sections top=6, work=9, organization=6
theme: 52 core tokens overridden, all still declared by the core
theme: linked /assets/kyoube-theme.css after the core stylesheet; 5 font files in /fonts/kyoube
```

A `(new: …)` after a section that the skin keeps (top, work) is information: the new link stays
visible. When the build stops, the message says what to change:

| Message | What to do |
|---|---|
| `text rule "<id>" matched N time(s) … expected M` | Find the string in the new bundle and update the pattern in `docker/theme/rules.mjs`. Never relax `expect`. |
| `anchor "<id>" matched 0 time(s)` | The hook the skin uses moved. Update the selector in `theme.css` and the anchor in `anchors.mjs`. |
| `sidebar section "organization" changed: added [/x]` | The skin hides that section, so give the new link a card in `plugins/kyoube-studio/src/ui/links.ts`, then update `SECTIONS` in `anchors.mjs`. |
| `the core no longer declares --x` | Find the token that replaced it in the core's `index.css` and update `theme.css`. |

Then refresh the test fixture from the new core image and look at the Studio screenshots from the
smoke:

```bash
id=$(docker create ghcr.io/paperclipai/paperclip:<version>)
docker cp "$id":/app/ui/dist /tmp/core-dist && docker rm "$id"
node docker/theme/tests/fixtures/extract.mjs /tmp/core-dist docker/theme/tests/fixtures/core-<version>.mjs
```

and point `theme.spec.mjs` at the new fixture.

## Changing the design

- **Colours, fonts, radius:** the tokens at the top of `docker/theme/theme.css`. Set every colour in
  both `:root` and `.dark` (a test checks this).
- **Sidebar order:** `SIDEBAR_ORDER` in `plugins/kyoube-studio/src/manifest.ts` and the `order` of the
  Data, Apps and Terminal slots in their own manifests (a test keeps them in step).
- **Home, the agent profile and the Workspace page:** `plugins/kyoube-studio/src/ui/` (the profile's
  data is shaped in `src/profile.ts`; the redirect and the core-header character are in
  `src/ui/agent-route.ts`).
- **Characters:** `ICON_TRAITS` in `plugins/kyoube-studio/src/characters.ts`.

## The rule it follows

`docker/theme` is the second standing exception to "Never patch the core" (CONTRIBUTING.md), next to
the rebrand, and for the same reason: it changes presentation only, it is re-applied on every build to
the pristine core, and it fails loudly when upstream moves. It may set tokens, add CSS, change display
text and the default theme. Anything that needs data or behaviour belongs in the Studio plugin, on the
public SDK.
