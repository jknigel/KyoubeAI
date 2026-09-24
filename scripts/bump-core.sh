#!/usr/bin/env bash
# Bumps every core pin (image + plugin SDK) to one version and reinstalls.
# Usage: scripts/bump-core.sh 2026.914.1
set -euo pipefail
NEW="${1:?usage: bump-core.sh <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Every file `sed -i.bak` is pointed at below, so the cleanup at the end removes
# the backups this run made and nothing else. The repo-wide `find -name '*.bak'`
# it replaces would also delete a developer's own unrelated backup file, which
# is not this script's business.
edited=("$ROOT/docker/Dockerfile" "$ROOT/.env.example" "$ROOT/scripts/smoke.env" "$ROOT/docker-compose.yml" "$ROOT/docker/core-patches/patches.mjs")
sed -i.bak "s/^ARG KYOUBE_CORE_VERSION=.*/ARG KYOUBE_CORE_VERSION=${NEW}/" "$ROOT/docker/Dockerfile"
sed -i.bak "s/^KYOUBE_CORE_VERSION=.*/KYOUBE_CORE_VERSION=${NEW}/" "$ROOT/.env.example" "$ROOT/scripts/smoke.env"
sed -i.bak "s/PAPERCLIP_VERSION:-[0-9.]*}}/PAPERCLIP_VERSION:-${NEW}}}/" "$ROOT/docker-compose.yml"
sed -i.bak "s/^export const CORE_VERSION = \".*\";$/export const CORE_VERSION = \"${NEW}\";/" "$ROOT/docker/core-patches/patches.mjs"
for pkg in "$ROOT"/plugins/*/package.json; do
  if jq -e '.dependencies["@paperclipai/plugin-sdk"]' "$pkg" >/dev/null; then
    jq --arg v "$NEW" '.dependencies["@paperclipai/plugin-sdk"] = $v' "$pkg" > "$pkg.tmp" && mv "$pkg.tmp" "$pkg"
    # Some jq builds (e.g. native Windows binaries) write CRLF when stdout is
    # redirected to a file; normalize back to LF per .gitattributes (eol=lf).
    sed -i.bak 's/\r$//' "$pkg"
    edited+=("$pkg")
  fi
done
for file in "${edited[@]}"; do rm -f "$file.bak"; done
(cd "$ROOT" && pnpm install && bash scripts/check-pins.sh)
echo "Bumped the core pins to ${NEW}. Next: pnpm test && bash scripts/smoke.sh, then commit 'chore: bump core to ${NEW}'."
