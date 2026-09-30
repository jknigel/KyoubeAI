#!/usr/bin/env bash
# Updates KyoubeAI in this checkout: backs up, moves to the newest release (or
# --version), keeps your settings, restarts and checks. --rollback undoes the
# last update; --edge follows the current branch and rebuilds from source.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./update.sh [options]

  (no option)         Update to the newest release, after a backup
  --version <x.y.z>   Update to this release (never older than the current one)
  --rollback          Go back to the release and data from before the last update
  --edge              Follow the current branch: git pull and rebuild from source
  --yes               Answer yes to every question
EOF
}

STATE=.kyoube/update-state
ENV_BEFORE=.kyoube/env.before-update

main() {
  KYOUBE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$KYOUBE_DIR"
  # shellcheck source=scripts/lib/host.sh
  . "$KYOUBE_DIR/scripts/lib/host.sh"
  local want="" mode=release rollback=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) want="${2:?--version needs a value}"; shift ;;
      --edge) mode=edge ;;
      --rollback) rollback=1 ;;
      --yes|-y) YES=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1 (see ./update.sh --help)" ;;
    esac
    shift
  done
  if [ -n "$want" ]; then
    is_release_version "${want#v}" || die "not a release version: $want (use e.g. --version 1.1.0)"
    want="${want#v}"
    version_ge "$want" "$KYOUBE_MIN_RELEASE" || die "update.sh moves to $KYOUBE_MIN_RELEASE or later (use e.g. --version $KYOUBE_MIN_RELEASE)"
  fi
  if [ "$rollback" = 1 ] && { [ "$mode" = edge ] || [ -n "$want" ]; }; then
    die "--rollback returns to the state before the last update and takes no --edge or --version"
  fi
  if [ "$mode" = edge ] && [ -n "$want" ]; then
    die "--edge follows the current branch and --version picks a release; use one of them"
  fi
  [ -t 0 ] || YES=1
  [ -f .env ] || die "no .env here; install first with ./install.sh"
  docker_preflight
  pin_project_name
  if [ "$rollback" = 1 ]; then do_rollback; return; fi
  git diff --quiet HEAD -- || die "tracked files have local changes; stash them (git stash) and run again"
  if [ "$mode" = edge ]; then update_edge; else update_release "$want"; fi
}

pin_project_name() {
  local project
  if [ -z "$(env_get .env COMPOSE_PROJECT_NAME)" ]; then
    project="$(resolve_project_name "$KYOUBE_DIR")"
    env_set .env COMPOSE_PROJECT_NAME "$project"
    say "    pinned COMPOSE_PROJECT_NAME=$project in .env (the name this install already uses)"
  fi
}

# harness_types_in_use: one "adapter_type count" line per kind of agent that is not terminated; nothing when the database cannot be read.
harness_types_in_use() {
  docker compose exec -T db psql -U kyoubeai -d kyoubeai -Atc \
    "select adapter_type || ' ' || count(*) from agents where status <> 'terminated' group by adapter_type order by 1" </dev/null 2>/dev/null | tr -d '\r' || true
}

# run_backup: sets BACKUP to the directory scripts/backup.sh wrote.
run_backup() {
  local log
  log="$(mktemp)"
  say "==> backing up (scripts/backup.sh)"
  if ! bash scripts/backup.sh | tee "$log"; then
    rm -f "$log"
    die "the backup failed; nothing was changed. Fix what the lines above report (the stack must be running: docker compose up -d), then run ./update.sh again"
  fi
  BACKUP="$(sed -n 's/^backup written to //p' "$log" | tail -1)"
  rm -f "$log"
  [ -n "$BACKUP" ] || die "the backup did not say where it wrote; nothing was changed. Run bash scripts/backup.sh and check its output, then run ./update.sh again"
}

save_state() { # MODE FROM_LABEL
  mkdir -p .kyoube
  cp .env "$ENV_BEFORE"
  : > "$STATE"
  env_set "$STATE" mode "$1"
  env_set "$STATE" from "$2"
  env_set "$STATE" ref "$(git rev-parse HEAD)"
  env_set "$STATE" branch "$(git symbolic-ref --quiet --short HEAD || true)"
  env_set "$STATE" image "$(env_get .env KYOUBE_IMAGE)"
  env_set "$STATE" version "$(env_get .env KYOUBE_VERSION)"
  env_set "$STATE" backup "$BACKUP"
}

merge_settings() { # LABEL
  local added unused example_core
  added="$(env_merge .env.example .env "$1")"
  # shellcheck disable=SC2086  # word splitting turns the newline-separated keys into one line
  [ -z "$added" ] || say "    added to .env: $(printf '%s ' $added)"
  example_core="$(env_get .env.example KYOUBE_CORE_VERSION)"
  if [ -n "$example_core" ] && [ "$(env_get .env KYOUBE_CORE_VERSION)" != "$example_core" ]; then
    env_set .env KYOUBE_CORE_VERSION "$example_core"
    say "    KYOUBE_CORE_VERSION=$example_core (the core this code is built for)"
  fi
  unused="$(env_unused .env.example .env | grep -vx COMPOSE_PROJECT_NAME || true)"
  # shellcheck disable=SC2086
  [ -z "$unused" ] || say "    not used by this version (left in .env): $(printf '%s ' $unused)"
}

restart_and_check() { # TARGET_LABEL
  local log bad
  say "==> restarting on $1"
  if ! docker compose up -d --no-build --wait --wait-timeout 300; then
    docker compose logs --tail 50 app >&2 || true
    die "KyoubeAI did not come back healthy on $1. To return to the version and data from before this update: ./update.sh --rollback"
  fi
  offer_harnesses
  log="$(mktemp)"
  dc_exec app kyoube doctor | tee "$log" || true
  bad="$(grep '^FAIL' "$log" | grep -v '^FAIL harnesses in use' || true)"
  rm -f "$log"
  [ -z "$bad" ] || warn "kyoube doctor reports a problem after the update. If it does not clear up, ./update.sh --rollback returns to the version and data from before it."
}

# offer_harnesses: for each harness the agents here use (USED) that the updated image lacks, offer to install it.
offer_harnesses() {
  local types missing name
  types="$(printf '%s\n' "${USED:-}" | awk 'NF { print $1 }')"
  [ -n "$types" ] || return 0
  # shellcheck disable=SC2086  # $types is one adapter type per line; splitting makes them arguments
  missing="$(dc_exec app kyoube harness missing $types </dev/null | tr -d '\r')" \
    || { warn "could not check which harnesses the agents here need; run kyoube doctor in the Terminal to see them"; return 0; }
  # shellcheck disable=SC2086
  for name in $missing; do
    if confirm "Agents here use $name, which is not installed. Install it now?"; then
      dc_exec app kyoube harness install "$name" || warn "installing $name failed; later, from the Terminal: kyoube harness install $name"
    else
      say "    later, from the Terminal: kyoube harness install $name"
    fi
  done
}

update_release() {
  local want="$1" current target from image_repo new_ref
  # A commit can carry several tags (v1.2.0 and v1.2.0-rc1); only a release tag counts.
  current="$(git tag --points-at HEAD 2>/dev/null | latest_release || true)"
  git fetch --tags --quiet origin || die "could not fetch releases from origin; check the network and run ./update.sh again"
  if [ -n "$want" ]; then
    target="v$want"
    git rev-parse -q --verify "refs/tags/$target" >/dev/null || die "release $target does not exist (releases: https://github.com/jknigel/KyoubeAI/releases)"
  else
    target="$(git tag -l 'v*' | latest_release || true)"
    [ -n "$target" ] || die "no release ($KYOUBE_MIN_RELEASE or later) found; to follow the current code instead: ./update.sh --edge"
  fi
  # HEAD may carry more than one release tag; the one asked for is enough.
  if git tag --points-at HEAD 2>/dev/null | grep -Fx "$target" >/dev/null; then current="$target"; fi
  if [ "$current" = "$target" ]; then say "already on $target"; return; fi
  if [ -n "$current" ] && ! version_ge "${target#v}" "${current#v}"; then
    die "$target is older than $current; databases only migrate forward. To go back after an update: ./update.sh --rollback"
  fi
  from="${current:-$(git rev-parse --short HEAD)}"
  image_repo="$(env_get .env KYOUBE_IMAGE)"
  case "$image_repo" in ""|kyoubeai)
    image_repo="$KYOUBE_IMAGE_DEFAULT"
    say "    this install built its own image; from now on it uses the published one (./update.sh --edge keeps building from source)" ;;
  esac
  new_ref="$image_repo:${target#v}"
  say "Update KyoubeAI $from -> $target"
  say "Release notes: https://github.com/jknigel/KyoubeAI/blob/$target/CHANGELOG.md"
  confirm "A backup is taken first. Continue?" || { say "Nothing was changed."; exit 1; }
  if ! docker image inspect "$new_ref" >/dev/null 2>&1; then
    say "==> downloading $new_ref before changing anything"
    docker pull "$new_ref" || die "could not download $new_ref; nothing was changed. If the error said 'denied', see docs/operations.md, 'The published image on GHCR'; otherwise check the network, then run ./update.sh again"
  fi
  USED="$(harness_types_in_use)"
  [ -z "$USED" ] || say "    agents use: $(printf '%s' "$USED" | tr '\n' ',' | sed 's/,$//; s/,/, /g')"
  run_backup
  save_state release "$from"
  git -c advice.detachedHead=false checkout --quiet "$target" \
    || die "could not switch this checkout to $target; nothing else was changed. Fix what git reported and run ./update.sh again"
  merge_settings "${target#v}"
  env_set .env KYOUBE_IMAGE "$image_repo"
  env_set .env KYOUBE_VERSION "${target#v}"
  restart_and_check "$target"
  say "updated to $target. The pre-update backup is $BACKUP; ./update.sh --rollback returns to $from."
}

update_edge() {
  local branch upstream behind from
  branch="$(git symbolic-ref --quiet --short HEAD)" || die "--edge follows a branch, but this checkout is on a release tag; git checkout main first"
  upstream="$(git rev-parse --abbrev-ref '@{u}' 2>/dev/null)" || die "branch $branch has no upstream to pull from; git branch --set-upstream-to origin/$branch"
  git fetch --quiet || die "could not fetch from origin; check the network and run ./update.sh --edge again"
  behind="$(git rev-list --count "HEAD..@{u}")" || die "could not compare $branch with $upstream; run git status"
  if [ "$behind" = 0 ]; then say "already up to date with $upstream"; return; fi
  from="$branch@$(git rev-parse --short HEAD)"
  say "Update KyoubeAI $from -> $upstream ($behind new commits), then rebuild from source"
  confirm "A backup is taken first. Continue?" || { say "Nothing was changed."; exit 1; }
  USED="$(harness_types_in_use)"
  run_backup
  save_state edge "$from"
  git pull --ff-only --quiet \
    || die "git pull --ff-only failed (commits here that $upstream lacks?); the code was not changed. Fix that (git status), then run ./update.sh --edge again"
  merge_settings "edge-$(git rev-parse --short HEAD)"
  say "==> building (10-25 minutes when the core changed)"
  docker compose build app || die "the build failed; the stack still runs the previous image. To go back to the previous code: ./update.sh --rollback"
  restart_and_check "$branch@$(git rev-parse --short HEAD)"
  say "updated. The pre-update backup is $BACKUP; ./update.sh --rollback returns to $from."
}

do_rollback() {
  local mode ref branch backup from again
  [ -f "$STATE" ] || die "there is no update to roll back. To restore any backup: bash scripts/restore.sh backups/<timestamp>"
  mode="$(env_get "$STATE" mode)"; ref="$(env_get "$STATE" ref)"; branch="$(env_get "$STATE" branch)"
  backup="$(env_get "$STATE" backup)"; from="$(env_get "$STATE" from)"
  [ -n "$ref" ] && [ -n "$backup" ] && [ -f "$ENV_BEFORE" ] \
    || die "$STATE is incomplete. To restore a backup by hand: bash scripts/restore.sh backups/<timestamp>"
  [ -d "$backup" ] || die "the backup taken before the update ($backup) is gone; restore another with bash scripts/restore.sh <backup dir>"
  from="${from:-$ref}"
  git diff --quiet HEAD -- || die "tracked files have local changes; stash them (git stash) and run again"
  say "Roll back to $from and restore $backup."
  say "Everything written since that backup (tasks, data, files) is replaced."
  confirm "Roll back?" || { say "Nothing was changed."; exit 1; }
  # A step that fails leaves $STATE in place, so the same command continues.
  again="Fix what is reported above, then run ./update.sh --rollback again."
  docker compose stop app || die "could not stop the app. $again"
  if [ "$mode" = edge ] && [ -n "$branch" ]; then
    git checkout --quiet "$branch" || die "could not switch back to branch $branch. $again"
    git reset --quiet --keep "$ref" || die "could not move $branch back to ${ref}. $again"
  else
    git -c advice.detachedHead=false checkout --quiet "$ref" || die "could not switch this checkout back to ${ref}. $again"
  fi
  cp "$ENV_BEFORE" .env || die "could not restore .env from $ENV_BEFORE. $again"
  if [ "$mode" = edge ]; then docker compose build app || die "the build of the previous code failed. $again"; fi
  # Recreate the app container on the old image without starting it, so the
  # new version never boots onto the restored data; restore.sh starts it.
  docker compose up -d --no-build --no-start app || die "could not recreate the app on the previous image. $again"
  bash scripts/restore.sh "$backup" || die "the restore failed, so the data may be half restored. $again"
  docker compose up -d --no-build --wait --wait-timeout 300 \
    || die "KyoubeAI did not come back healthy after the rollback; see docker compose logs app. $again"
  dc_exec app kyoube doctor || true
  rm -f "$STATE" "$ENV_BEFORE"
  say "rolled back to $from"
}

main "$@"
