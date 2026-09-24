#!/usr/bin/env bash
# Fails when the core image pin and the plugin SDK pins disagree.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
dockerfile="$(sed -n 's/^ARG KYOUBE_CORE_VERSION=\(.*\)$/\1/p' "$ROOT/docker/Dockerfile" | head -1)"
# Every comparison below is against this value. If the line ever moves or is
# renamed, `sed` prints nothing and each mismatch below blames the file it was
# comparing rather than the missing pin — and two empty sides would compare
# equal. Say what actually happened, once, instead.
[[ -n "$dockerfile" ]] || { echo "PIN ERROR: no ARG KYOUBE_CORE_VERSION= line in docker/Dockerfile" >&2; exit 1; }
envfile="$(sed -n 's/^KYOUBE_CORE_VERSION=\(.*\)$/\1/p' "$ROOT/.env.example")"
smoke="$(sed -n 's/^KYOUBE_CORE_VERSION=\(.*\)$/\1/p' "$ROOT/scripts/smoke.env")"
# The compose default is nested: KYOUBE_CORE_VERSION falls back to the 0.1.x
# key PAPERCLIP_VERSION, which falls back to the pin. Read the innermost value.
compose="$(sed -n 's/.*PAPERCLIP_VERSION:-\([0-9.]*\)}}.*/\1/p' "$ROOT/docker-compose.yml" | head -1)"
# The core the build-time patches are written for (docker/core-patches).
patches="$(sed -n 's/^export const CORE_VERSION = "\(.*\)";$/\1/p' "$ROOT/docker/core-patches/patches.mjs")"
status=0
for pkg in "$ROOT"/plugins/*/package.json; do
  sdk="$(jq -r '.dependencies["@paperclipai/plugin-sdk"] // empty' "$pkg")"
  if [[ -n "$sdk" && "$sdk" != "$dockerfile" ]]; then echo "PIN MISMATCH: $pkg has @paperclipai/plugin-sdk $sdk, Dockerfile has $dockerfile" >&2; status=1; fi
done
for pair in "env:$envfile" "smoke:$smoke" "compose:$compose" "core-patches:$patches"; do
  value="${pair#*:}"
  if [[ "$value" != "$dockerfile" ]]; then echo "PIN MISMATCH: ${pair%%:*} has $value, Dockerfile has $dockerfile" >&2; status=1; fi
done
[[ $status -eq 0 ]] && echo "pins consistent: $dockerfile"
exit $status
