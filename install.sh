#!/usr/bin/env bash
# Installs KyoubeAI from this checkout: settings, image, start, claim, plugins.
# Safe to run again at any point: every step checks whether its work is done.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Installs the newest KyoubeAI release from this checkout and walks you through
claiming it. Safe to run again: it continues where it stopped.

  --url <address>     The address people will use (default http://localhost:3100)
  --port <n>          Host port (default 3100)
  --name <project>    Compose project name, for a second instance on one machine (default kyoubeai)
  --version <x.y.z>   Install this release instead of the newest
  --edge              Stay on the current branch and build from source (contributors)
  --image <ref>       Use a local image instead of downloading one (CI)
  --yes               Accept every default and ask nothing
EOF
}

main() {
  KYOUBE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$KYOUBE_DIR"
  # shellcheck source=scripts/lib/host.sh
  . "$KYOUBE_DIR/scripts/lib/host.sh"
  local original=("$@") edge=0 want="" url="" port="" name="" image="" reexeced=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --edge) edge=1 ;;
      --version) want="${2:?--version needs a value}"; shift ;;
      --url) url="${2:?--url needs a value}"; shift ;;
      --port) port="${2:?--port needs a value}"; shift ;;
      --name) name="${2:?--name needs a value}"; shift ;;
      --image) image="${2:?--image needs a value}"; shift ;;
      --yes|-y) YES=1 ;;
      --reexeced) reexeced=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1 (see ./install.sh --help)" ;;
    esac
    shift
  done
  if [ -n "$want" ]; then
    is_release_version "${want#v}" || die "not a release version: $want (use e.g. --version 1.1.0)"
    want="${want#v}"
  fi
  if [ -n "$port" ]; then
    valid_port "$port" || die "not a port: $port (use a number from 1 to 65535)"
    port="$((10#$port))"
  fi
  if [ -n "$name" ]; then
    [ "$(normalize_project_name "$name")" = "$name" ] \
      || die "not a valid project name: $name (use lowercase letters, digits, - and _, starting with a letter or digit)"
  fi
  [ -t 0 ] || YES=1

  say "==> checking Docker"
  docker_preflight

  # 1. The release to install (a checkout switches tags, then this script re-runs from it).
  local release current tag
  if [ "$edge" = 1 ]; then
    release="edge-$(git rev-parse --short HEAD)"
  else
    git diff --quiet HEAD -- || die "tracked files in $KYOUBE_DIR have local changes; stash them (git stash) or use --edge"
    # A commit can carry several tags (v1.2.0 and v1.2.0-rc1); only a release tag counts.
    current="$(git tag --points-at HEAD 2>/dev/null | latest_release || true)"
    if [ -n "$want" ]; then
      version_ge "$want" "$KYOUBE_MIN_RELEASE" || die "install.sh installs $KYOUBE_MIN_RELEASE or later; see README for older releases"
      tag="v$want"
      # HEAD may carry more than one release tag; the one asked for is enough.
      if git tag --points-at HEAD 2>/dev/null | grep -Fx "$tag" >/dev/null; then current="$tag"; fi
    elif [ -n "$current" ] && [ "$(printf '%s\n' "$current" | latest_release)" = "$current" ]; then
      tag="$current"
    else
      git fetch --tags --quiet origin 2>/dev/null || warn "could not fetch releases from origin; using the tags this checkout has"
      tag="$(git tag -l 'v*' | latest_release)"
      [ -n "$tag" ] || die "no KyoubeAI release ($KYOUBE_MIN_RELEASE or later) found. To run the current code instead: ./install.sh --edge"
    fi
    if [ "$current" != "$tag" ]; then
      [ "$reexeced" = 0 ] || die "could not switch this checkout to $tag"
      if ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
        git fetch --tags --quiet origin 2>/dev/null || warn "could not fetch releases from origin; using the tags this checkout has"
        git rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "release $tag does not exist"
      fi
      say "==> switching this checkout to $tag"
      git -c advice.detachedHead=false checkout --quiet "$tag"
      exec "$KYOUBE_DIR/install.sh" --reexeced ${original[@]+"${original[@]}"}
    fi
    release="${tag#v}"
  fi

  # 2. Settings.
  local repo version_tag project added ignored=""
  if [ -n "$image" ]; then
    read -r repo version_tag <<<"$(split_image_ref "$image")"
  elif [ "$edge" = 1 ]; then
    repo=kyoubeai; version_tag=dev
  else
    repo="$KYOUBE_IMAGE_DEFAULT"; version_tag="$release"
  fi
  if [ ! -f .env ]; then
    project="${name:-kyoubeai}"
    if docker volume inspect "${project}_pgdata" >/dev/null 2>&1; then
      die "a KyoubeAI database volume '${project}_pgdata' already exists on this machine, from another install whose secrets a new .env would not match. Run ./update.sh in that install's folder, copy its .env here, or install a separate instance with --name <other> --port <other port>."
    fi
    cp .env.example .env.tmp
    local key
    for key in BETTER_AUTH_SECRET POSTGRES_PASSWORD KYOUBE_DB_PASSWORD; do env_set .env.tmp "$key" "$(gen_secret)"; done
    env_set .env.tmp COMPOSE_PROJECT_NAME "$project"
    choose_address .env.tmp
    mv -f .env.tmp .env
    chmod 600 .env
    say "    wrote .env. Keep a copy somewhere safe: restoring a backup onto a new machine needs its secrets."
  else
    say "    keeping the existing .env"
    [ -z "$port" ] || ignored="${ignored:+$ignored, }--port (KYOUBE_PORT)"
    [ -z "$url" ] || ignored="${ignored:+$ignored, }--url (KYOUBE_PUBLIC_URL)"
    [ -z "$name" ] || ignored="${ignored:+$ignored, }--name (COMPOSE_PROJECT_NAME)"
    [ -z "$ignored" ] || warn "$ignored ignored because the existing .env is kept; edit those keys in .env, or remove .env and run ./install.sh again to start over"
    [ -n "$(env_get .env COMPOSE_PROJECT_NAME)" ] || env_set .env COMPOSE_PROJECT_NAME "$(resolve_project_name "$KYOUBE_DIR")"
    added="$(env_merge .env.example .env "$release")"
    # shellcheck disable=SC2086  # word splitting turns the newline-separated keys into one line
    [ -z "$added" ] || say "    added to .env: $(printf '%s ' $added)"
  fi
  env_set .env KYOUBE_IMAGE "$repo"
  env_set .env KYOUBE_VERSION "$version_tag"
  env_set .env KYOUBE_CORE_VERSION "$(env_get .env.example KYOUBE_CORE_VERSION)"

  # 3. The image.
  local ref="$repo:$version_tag" attempt
  if [ -n "$image" ]; then
    docker image inspect "$image" >/dev/null 2>&1 || die "image $image is not on this machine"
  elif [ "$edge" = 1 ]; then
    say "==> building the image from source (10-25 minutes the first time)"
    docker compose build app
    record_source_build "$ref"
  elif docker image inspect "$ref" >/dev/null 2>&1; then
    say "    $ref is already on this machine"
  else
    for attempt in 1 2 3; do
      say "==> downloading $ref (about 3 GB; attempt $attempt of 3)"
      if docker pull "$ref"; then break; fi
      [ "$attempt" -lt 3 ] || die "could not download $ref. If the error said 'denied', see docs/operations.md, 'The published image on GHCR'; otherwise check the network, then run ./install.sh again"
      sleep 5
    done
  fi

  # 4. Start.
  say "==> starting KyoubeAI (the first start runs database migrations; up to 5 minutes)"
  if ! docker compose up -d --no-build --wait --wait-timeout 300; then
    docker compose logs --tail 50 app >&2 || true
    die "KyoubeAI did not become healthy; the log above usually says why. ./install.sh is safe to run again."
  fi

  # 5. Claim.
  local public status
  public="$(env_get .env KYOUBE_PUBLIC_URL)"
  status="$(health_field bootstrapStatus || true)"
  if [ "$status" = "bootstrap_pending" ]; then
    [ "$(env_get .env KYOUBE_DEPLOYMENT_EXPOSURE)" != "public" ] \
      || die "the instance is not claimed yet and KYOUBE_DEPLOYMENT_EXPOSURE=public blocks the browser claim. Set it to private in .env, run ./install.sh, claim, then switch back."
    say ""
    say "Open $public in your browser, create your account and claim the instance."
    say "The first account becomes the instance admin. Waiting... (Ctrl+C is safe; run ./install.sh again to continue)"
    # Wait for "ready", not for "not pending": a health read that fails once returns nothing.
    until [ "$(health_field bootstrapStatus)" = "ready" ]; do sleep 3; done
    say "    claimed"
  fi

  # 6. Plugins.
  if docker compose exec -T app test -s /kyoubeai/kyoube/board-key.json 2>/dev/null; then
    say "    the Kyoube plugins are already set up"
  else
    say "==> installing the Kyoube plugins: open the link below in the browser where you are signed in, and approve it"
    dc_exec_node app kyoube setup || die "kyoube setup did not finish; run ./install.sh again to retry"
  fi

  # 7. Check and finish.
  dc_exec_node app kyoube doctor || warn "kyoube doctor reported a problem (above); ./install.sh is safe to run again"
  say ""
  say "KyoubeAI is running at $public"
  say "  Folder:  $KYOUBE_DIR"
  say "  Update:  ./update.sh    Back up: bash scripts/backup.sh    Logs: docker compose logs -f app"
  say "Next: open Workspace -> Terminal and install a harness (README, 'Harnesses'), e.g.  kyoube harness install claude"
}

# valid_port N: an integer from 1 to 65535.
valid_port() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "${#1}" -le 5 ] && [ "$((10#$1))" -ge 1 ] && [ "$((10#$1))" -le 65535 ]
}

# choose_address FILE: KYOUBE_PUBLIC_URL, KYOUBE_PORT and, for another loopback port, BETTER_AUTH_TRUSTED_ORIGINS.
# Reads url, port and YES from main's scope.
choose_address() {
  local file="$1" answer p
  if [ -z "$url" ] && [ "$YES" = 0 ]; then
    printf 'Address people will use to open KyoubeAI [http://localhost:3100]: '
    IFS= read -r answer </dev/tty || answer=""
    url="$answer"
  fi
  url="${url:-http://localhost:3100}"
  p="${port:-3100}"
  while port_in_use "$p"; do
    [ "$YES" = 0 ] || die "port $p is already in use on this machine; run again with --port <a free port>"
    printf 'Port %s is already in use. Port to use instead: ' "$p"
    IFS= read -r p </dev/tty || die "no port given"
    valid_port "$p" || die "not a port: $p (use a number from 1 to 65535)"
    p="$((10#$p))"
  done
  env_set "$file" KYOUBE_PORT "$p"
  if is_loopback_url "$url"; then
    url="$(url_set_port "$url" "$p")"
    [ "$p" = 3100 ] || env_set "$file" BETTER_AUTH_TRUSTED_ORIGINS "$(url_origin "$url")"
  else
    say "    other machines will use $url; docs/operations.md, 'Reaching KyoubeAI from other machines', covers TLS and proxies"
  fi
  env_set "$file" KYOUBE_PUBLIC_URL "$url"
}

main "$@"
