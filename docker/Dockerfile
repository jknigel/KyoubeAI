# syntax=docker/dockerfile:1.7
ARG KYOUBE_CORE_VERSION=2026.916.1

# ---------------------------------------------------------------------------
# Stage 1: build the Kyoube bootstrap CLI and plugins with pnpm.
# ---------------------------------------------------------------------------
FROM node:24-trixie-slim AS kyoube-build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY docker/bootstrap/package.json docker/bootstrap/
COPY plugins/kyoube-terminal/package.json plugins/kyoube-terminal/
COPY plugins/kyoube-apps/package.json plugins/kyoube-apps/
COPY plugins/kyoube-files/package.json plugins/kyoube-files/
COPY plugins/kyoube-studio/package.json plugins/kyoube-studio/
COPY packages/kyoube-app-sdk/package.json packages/kyoube-app-sdk/
RUN pnpm install --frozen-lockfile
COPY docker/bootstrap docker/bootstrap
COPY plugins plugins
# .dockerignore excludes **/dist, so the app SDK bundle the apps plugin inlines
# into its UI is built here from source by `pnpm -r build` (topologically
# ordered by the plugin's workspace:* devDependency on it).
COPY packages packages
RUN pnpm -r build \
 && pnpm --filter @kyoube/bootstrap deploy --prod /out/bootstrap \
 && pnpm --filter @kyoube/plugin-terminal deploy --prod /out/plugins/terminal \
 && pnpm --filter @kyoube/plugin-apps deploy --prod /out/plugins/apps \
 && pnpm --filter @kyoube/plugin-files deploy --prod /out/plugins/files \
 && pnpm --filter @kyoube/plugin-studio deploy --prod /out/plugins/studio \
 && test -f /out/bootstrap/dist/kyoube.mjs \
 && test -f /out/plugins/terminal/dist/manifest.js \
 && test -f /out/plugins/apps/dist/manifest.js \
 && test -f /out/plugins/files/dist/manifest.js \
 && test -f /out/plugins/studio/dist/manifest.js

# ---------------------------------------------------------------------------
# Stage 2: the runtime image = the upstream core image + pi + Hermes + KyoubeAI.
# ---------------------------------------------------------------------------
FROM ghcr.io/paperclipai/paperclip:${KYOUBE_CORE_VERSION}
ARG PI_VERSION=0.87.1
# Claude Code. The base image installs `@anthropic-ai/claude-code@latest` at
# *its* build time, so the copy it carries is whatever was current when upstream
# cut the pinned release (2.1.278 in 2026.916.1). Pinning it here replaces that
# copy in place -- the same root-owned global install under /usr/local -- so the
# version is a deliberate, reproducible choice, asserted below.
ARG CLAUDE_CODE_VERSION=2.1.281
# Hermes publishes release tags (vYYYY.M.D) but no package; the installer clones
# NousResearch/hermes-agent. HERMES_COMMIT is the commit behind the newest
# release tag and pins BOTH the installer script (fetched from that commit's raw
# URL, verified against HERMES_INSTALLER_SHA256) and the checkout the installer
# makes (--commit). --force-commit is required alongside it: the installer
# otherwise refuses a --commit that is an ancestor of the tip it just cloned,
# which is exactly what this pin becomes as soon as upstream `main` advances
# past it, and the build would then fail on the `rev-parse HEAD` assertion
# below rather than honour the pin. HERMES_VERSION is asserted against `hermes
# --version` after the install so upstream drift fails the build loudly instead
# of silently shipping a different agent. To bump: take the commit behind the
# newest release tag (`git ls-remote --tags https://github.com/NousResearch/hermes-agent`),
# re-download scripts/install.sh from its raw URL, sha256 it, and read the new
# version off `hermes --version`.
# HERMES_COMMIT is release v2026.9.21.
ARG HERMES_COMMIT=d337b736aa1e8ebecfab043842d13e4a2d2f48a3
ARG HERMES_INSTALLER_SHA256=00f9080c6452bf87f03ef2fffb4b2c23b9f43f946aaae956e4c547d17e310b22
ARG HERMES_VERSION=0.21.4
USER root

# KyoubeAI's home. The base image sets HOME=PAPERCLIP_HOME=/paperclip and gives
# the node user that passwd entry. Everything upstream derives from
# PAPERCLIP_HOME (its packages/shared home-paths module) and its own entrypoint
# chowns `${PAPERCLIP_HOME:-/paperclip}`, so moving the three variables moves
# the whole tree without patching a file. /paperclip is removed outright: on an
# install migrated from 0.1.x, docker/entrypoint.sh recreates it as a symlink
# for as long as the migration marker exists (spec §5); a fresh install never
# has it.
ENV HOME=/kyoubeai \
    PAPERCLIP_HOME=/kyoubeai \
    PAPERCLIP_CONFIG=/kyoubeai/instances/default/config.json
RUN mkdir -p /kyoubeai && chown node:node /kyoubeai && usermod -d /kyoubeai node && rmdir /paperclip

# HOME is /kyoubeai (set above), which is also the runtime volume mount
# point — anything an installer drops in $HOME during the build is baked into
# the image AND seeded into every fresh volume. Every install below therefore
# runs with HOME and the package caches under /tmp, and the artefacts that must
# survive (Playwright browsers, the Computer Use driver) are redirected into
# /opt with the same env vars Hermes reads at runtime (ENV, further down).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    CUA_DRIVER_RS_HOME=/opt/cua-driver

# pi coding agent (the `pi_local` adapter runs the `pi` binary) and the pinned
# Claude Code (the `claude_local` adapter, and `claude login` from the Terminal).
# Each `--version` is matched as a whole line, so a registry alias or a
# postinstall that quietly left something else on PATH fails the build here.
RUN HOME=/tmp/build-home npm_config_cache=/tmp/npm-cache \
    npm install --global --omit=dev \
      "@earendil-works/pi-coding-agent@${PI_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && HOME=/tmp/build-home pi --version | grep -qxF "${PI_VERSION}" \
 && HOME=/tmp/build-home claude --version | grep -qxF "${CLAUDE_CODE_VERSION} (Claude Code)" \
 && rm -rf /tmp/build-home /tmp/npm-cache /root/.npm /root/.cache \
 && test -z "$(ls -A /kyoubeai)"

# Hermes Agent (the `hermes_local` adapter runs `hermes chat`). Installed as
# root in FHS layout: code in /usr/local/lib/hermes-agent, launcher at
# /usr/local/bin/hermes. Runtime data lives under HERMES_HOME on the volume.
# Passing --dir is load-bearing by its absence: an explicit --dir sets
# INSTALL_DIR_EXPLICIT and disables the installer's root FHS layout, which
# would put the code somewhere else and never link /usr/local/bin/hermes.
#
# The installer clones --depth 1 --branch main, so pinning to a commit that is
# no longer main's tip makes it `git fetch origin <sha>` the whole history
# (+580 MB of .git). The fetch/gc block below re-shallows at the pinned commit
# and repacks, back to the ~70 MB an unpinned shallow install produces; `hermes
# update` and `hermes --version`'s git metadata work the same on a shallow
# checkout, and HEAD is re-asserted afterwards.
#
# /opt/cua-driver is chowned to `node`: Hermes' Computer Use repair path takes a
# lock directory under CUA_DRIVER_RS_HOME and re-downloads the driver there at
# runtime as the `node` user, so a root-owned tree would fail. The Playwright
# browsers stay root-owned and world-readable — nothing writes them after build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv git curl ca-certificates build-essential \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_COMMIT}/scripts/install.sh" \
      -o /tmp/hermes-install.sh \
 && echo "${HERMES_INSTALLER_SHA256}  /tmp/hermes-install.sh" | sha256sum -c - \
 && HOME=/tmp/build-home npm_config_cache=/tmp/npm-cache HERMES_HOME=/tmp/build-home/.hermes \
    bash /tmp/hermes-install.sh --non-interactive --commit "${HERMES_COMMIT}" --force-commit \
 && rm -f /tmp/hermes-install.sh \
 && HOME=/tmp/build-home git -C /usr/local/lib/hermes-agent fetch --depth 1 origin "${HERMES_COMMIT}" \
 && HOME=/tmp/build-home git -C /usr/local/lib/hermes-agent update-ref -d refs/remotes/origin/main \
 && HOME=/tmp/build-home git -C /usr/local/lib/hermes-agent reflog expire --expire=now --all \
 && HOME=/tmp/build-home git -C /usr/local/lib/hermes-agent gc --prune=now --quiet \
 && HOME=/tmp/build-home git -C /usr/local/lib/hermes-agent rev-parse HEAD | grep -q "^${HERMES_COMMIT}$" \
 && mkdir -p /opt/ms-playwright /opt/cua-driver \
 && chmod -R a+rX /usr/local/lib/hermes-agent /opt/ms-playwright /opt/cua-driver \
 && chown -R node:node /opt/cua-driver \
 && test -x /usr/local/bin/hermes \
 && mkdir -p /tmp/hermes-check && chown node:node /tmp/hermes-check \
 && gosu node sh -c 'HOME=/tmp/hermes-check HERMES_HOME=/tmp/hermes-check/.hermes hermes --version' \
      > /tmp/hermes-version.txt \
 && cat /tmp/hermes-version.txt \
 && grep -qF "Hermes Agent v${HERMES_VERSION} (" /tmp/hermes-version.txt \
 && gosu node sh -c 'HOME=/tmp/hermes-check pi --version' \
 && gosu node sh -c 'HOME=/tmp/hermes-check claude --version' \
 && apt-get purge -y --auto-remove build-essential \
 && gosu node sh -c 'HOME=/tmp/hermes-check HERMES_HOME=/tmp/hermes-check/.hermes hermes --version' \
 && gosu node sh -c 'HOME=/tmp/hermes-check pi --version' \
 && gosu node sh -c 'HOME=/tmp/hermes-check claude --version' \
 && rm -rf /tmp/hermes-check /tmp/hermes-version.txt /tmp/build-home /tmp/npm-cache \
      /root/.npm /root/.cache /var/lib/apt/lists/* \
 && test -z "$(ls -A /kyoubeai)"

# ---------------------------------------------------------------------------
# Core patches: fixes to upstream bugs applied to the pristine core layer while
# the same fix is on its way upstream (docker/core-patches/patches.mjs, one
# documented entry per patch, each naming its upstream issue or PR). Every
# pattern must match exactly as declared or this build fails — so a core bump
# that changes the code, or that already carries the fix, stops here with the
# patch's id, which is the cue to delete it. Runs before the rebrand so the
# asset renaming below hashes the patched bundle. See CONTRIBUTING.md,
# "Never patch the core", for the rule this is the narrow exception to.
# ---------------------------------------------------------------------------
COPY docker/core-patches/apply.mjs docker/core-patches/lib.mjs docker/core-patches/patches.mjs /opt/kyoube/core-patches/
RUN gosu node node /opt/kyoube/core-patches/apply.mjs --root /app --report

# ---------------------------------------------------------------------------
# KyoubeAI theme ("Studio"): brand tokens, a skin aimed only at stable hooks
# (route links, ARIA labels, and the data-kyoube-* markers the Studio plugin
# renders), and a few display-text renames (Dashboard -> Home, the core's Apps
# area -> Connections, dark by default). docker/theme/theme.mjs checks every
# rule, hook and token against this core before writing anything and fails
# the build naming what moved, so a core bump either keeps the design or stops
# here. It runs before the rebrand so the rebrand's asset re-hashing covers
# the theme's stylesheet. It is the second standing exception to "Never patch
# the core" (CONTRIBUTING.md): presentation only, re-applied on every build.
# Spec: docs/theme.md.
# ---------------------------------------------------------------------------
COPY docker/theme/theme.mjs docker/theme/rules.mjs docker/theme/anchors.mjs docker/theme/theme.css docker/theme/boot.js /opt/kyoube/theme/
COPY docker/theme/fonts /opt/kyoube/theme/fonts
RUN gosu node node /opt/kyoube/theme/theme.mjs --root /app --theme /opt/kyoube/theme --report \
 && grep -q '/assets/kyoube-theme.css' /app/ui/dist/index.html \
 && grep -q 'data-kyoube-shell' /app/ui/dist/index.html \
 && test -f /app/ui/dist/fonts/kyoube/InstrumentSerif-Regular-latin.woff2

# ---------------------------------------------------------------------------
# KyoubeAI branding. The upstream layer above says "Paperclip" in its UI
# bundle, server messages, agent skills and artwork; docker/rebrand/rebrand.mjs
# rewrites those surfaces in place (spec: docs/superpowers/specs/2026-09-13-
# white-label-design.md §B) and --verify fails this build if anything upstream
# changed shape: a moved lockup, a new display string the rule cannot classify,
# a dangling asset reference. It runs as `node` because /app is node-owned and
# nothing here should change ownership. --report leaves the counts in the log.
# ---------------------------------------------------------------------------
COPY docker/brand /opt/kyoube/brand
COPY docker/rebrand/rebrand.mjs /opt/kyoube/rebrand/rebrand.mjs
COPY docker/rebrand/lib /opt/kyoube/rebrand/lib
RUN gosu node node /opt/kyoube/rebrand/rebrand.mjs --root /app --brand /opt/kyoube/brand --verify --report \
 && grep -q '<title>KyoubeAI</title>' /app/ui/dist/index.html \
 && grep -qE '/assets/kyoube-theme-[0-9a-f]{8}\.css' /app/ui/dist/index.html \
 && test -f /app/ui/dist/kyoubeai-thinking.svg \
 && ! test -e /app/ui/dist/paperclip-thinking.svg \
 && ! ls /app/ui/dist/assets | grep -qE '^index-[A-Za-z0-9_-]{8}\.js$'

# Kyoube bootstrap CLI and plugin bundles. The dependency load checks run as `node` (the runtime
# user), not root: they are there to prove the deployed bundles load for the account that will
# actually run the plugin workers, and root can load files the `node` user cannot read.
#
# node-pty is the terminal plugin's prebuilt native binding. `pg` and `pgsql-ast-parser` are the
# apps plugin's runtime dependencies: its worker bundle keeps them external (docker/../build.mjs
# uses `packages: "external"`), so they must arrive through `pnpm deploy --prod` rather than the
# bundle. `migrations/0001_meta.sql` and `0002_apps.sql` are shipped via `package.json.files` and
# read at worker start by `runMetaMigrations`; without them the plugin installs but never reaches
# `ready`. The `window,"kyoube"` grep proves the apps UI bundle actually inlines the built
# `@kyoube/app-sdk` output (build.mjs's `define: { __KYOUBE_APP_SDK__ }`), not just its own code —
# that string is `Object.defineProperty(window, "kyoube", ...)` from the SDK's own runtime,
# minified.
COPY --from=kyoube-build /out/bootstrap /opt/kyoube/bootstrap
COPY --from=kyoube-build /out/plugins /opt/kyoube/plugins
COPY docker/kyoube /usr/local/bin/kyoube
COPY docker/entrypoint.sh /usr/local/bin/kyoube-entrypoint.sh
RUN chmod +x /usr/local/bin/kyoube /usr/local/bin/kyoube-entrypoint.sh \
 && chown -R node:node /opt/kyoube \
 && test -f /opt/kyoube/plugins/terminal/dist/ui/index.js \
 && gosu node sh -c 'node -e "require(\"/opt/kyoube/plugins/terminal/node_modules/@lydell/node-pty\"); console.log(\"node-pty ok\")"' \
 && test -f /opt/kyoube/plugins/apps/dist/manifest.js \
 && test -f /opt/kyoube/plugins/apps/dist/ui/index.js \
 && grep -q 'window,"kyoube"' /opt/kyoube/plugins/apps/dist/ui/index.js \
 && test -f /opt/kyoube/plugins/apps/migrations/0001_meta.sql \
 && test -f /opt/kyoube/plugins/apps/migrations/0002_apps.sql \
 && gosu node sh -c 'node -e "require(\"/opt/kyoube/plugins/apps/node_modules/pg\"); require(\"/opt/kyoube/plugins/apps/node_modules/pgsql-ast-parser\"); console.log(\"apps deps ok\")"' \
 && test -f /opt/kyoube/plugins/files/dist/manifest.js \
 && test -f /opt/kyoube/plugins/files/dist/ui/index.js \
 && test -f /opt/kyoube/plugins/studio/dist/manifest.js \
 && test -f /opt/kyoube/plugins/studio/dist/ui/index.js \
 && HOME=/tmp/build-home node /opt/kyoube/bootstrap/dist/kyoube.mjs --help >/dev/null \
 && rm -rf /tmp/build-home \
 && test -z "$(ls -A /kyoubeai)"

# Ruling P4-R39: telemetry off by default in the container environment — the
# server, the bootstrap CLI, and anything the entrypoint starts. A Terminal
# shell does not inherit this: the terminal plugin hands node-pty a closed
# environment it builds itself, so it sets the same two switches there (ruling
# P4-R42, plugins/kyoube-terminal/src/spawn-env.ts).
# Both are conventions rather than one product's switch: the upstream core's
# own telemetry client is opt-out and enabled by default, and disables itself on
# DO_NOT_TRACK=1 (packages/shared/src/telemetry/config.ts), and Claude Code
# reads DISABLE_TELEMETRY and DO_NOT_TRACK the same way. What each bundled
# component actually sends — and which of them could not be verified offline —
# is written down in SECURITY.md's Telemetry section; nothing here claims the
# image is telemetry-free. An operator who wants Claude Code's non-essential
# traffic off as well adds CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 to the
# `app` service (it also stops update checks, so it is not set here); the
# terminal plugin passes that one through into Terminal shells too.
ENV DO_NOT_TRACK=1 \
    DISABLE_TELEMETRY=1

ARG KYOUBE_VERSION=dev
ENV KYOUBE_VERSION=${KYOUBE_VERSION} \
    KYOUBE_PLUGIN_ROOT=/opt/kyoube/plugins \
    HERMES_HOME=/kyoubeai/.hermes

ENTRYPOINT ["/usr/bin/tini", "--", "kyoube-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
