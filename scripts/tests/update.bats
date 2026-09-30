#!/usr/bin/env bats
# update.sh against a scratch git repo (tags and branches made here) and a docker
# stub that logs every call. backup.sh and restore.sh are stubs too; scripts/lib/host.sh is the real one.

setup() {
  export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
  export MARKS="$BATS_TEST_TMPDIR/marks" STUB_LOG="$BATS_TEST_TMPDIR/docker-calls"
  STUB_BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$MARKS" "$STUB_BIN"
  # Answers the preflight questions, logs everything (and the image .env names at each build), and (when asked) fails
  # the first `compose up` or `compose build`, reports images as missing, or fails `pull`. An image that is there was
  # created at $STUB_IMAGE_CREATED (empty: no time to compare).
  cat > "$STUB_BIN/docker" <<'EOF'
#!/bin/sh
echo "$*" >> "$STUB_LOG"
case "$*" in
  "info --format {{.Architecture}}") echo x86_64 ;;
  "info --format {{.MemTotal}}") echo 8000000000 ;;
  "version --format {{.Server.Version}}") echo 27.0.0 ;;
  "compose up "*) if [ -n "${STUB_FAIL_UP:-}" ] && [ ! -e "$STUB_LOG.up" ]; then touch "$STUB_LOG.up"; exit 1; fi ;;
  "compose build "*)
    echo "$(sed -n 's/^KYOUBE_IMAGE=//p' .env):$(sed -n 's/^KYOUBE_VERSION=//p' .env)" >> "$STUB_LOG.builds"
    if [ -n "${STUB_FAIL_BUILD:-}" ] && [ ! -e "$STUB_LOG.build" ]; then touch "$STUB_LOG.build"; exit 1; fi ;;
  "image inspect "*) [ -z "${STUB_NO_IMAGE:-}" ] || exit 1; echo "${STUB_IMAGE_CREATED:-}" ;;
  "pull "*) [ -z "${STUB_FAIL_PULL:-}" ] || exit 1 ;;
esac
exit 0
EOF
  chmod +x "$STUB_BIN/docker"

  # origin: v1.1.0, an untagged commit, v1.2.0 (main sits on it). backup.sh and restore.sh are stubs that log.
  SEED="$BATS_TEST_TMPDIR/seed"; INST="$BATS_TEST_TMPDIR/inst"
  mkdir -p "$SEED/scripts/lib"
  cp "$BATS_TEST_DIRNAME/../../update.sh" "$SEED/"
  cp "$BATS_TEST_DIRNAME/../lib/host.sh" "$SEED/scripts/lib/"
  cat > "$SEED/scripts/backup.sh" <<'EOF'
#!/bin/sh
echo run >> "$MARKS/backups"
mkdir -p "$MARKS/backup-dir"
echo "backup written to $MARKS/backup-dir"
EOF
  printf '#!/bin/sh\necho "$1" >> "$MARKS/restores"\n' > "$SEED/scripts/restore.sh"
  printf 'KYOUBE_CORE_VERSION=2026.916.1\nKYOUBE_VERSION=dev\n' > "$SEED/.env.example"
  git -C "$SEED" init -q
  git -C "$SEED" symbolic-ref HEAD refs/heads/main
  git -C "$SEED" add -A
  git -C "$SEED" commit -qm one && git -C "$SEED" tag v1.1.0
  git -C "$SEED" commit -q --allow-empty -m mid
  git -C "$SEED" commit -q --allow-empty -m two && git -C "$SEED" tag v1.2.0
  git clone -q "$SEED" "$INST"
  printf 'KYOUBE_VERSION=1.1.0\nKYOUBE_IMAGE=ghcr.io/jknigel/kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
}

run_update() { run env PATH="$STUB_BIN:$PATH" "$INST/update.sh" "$@"; }

# nothing_happened: no backup, no state file, and docker was only asked the preflight questions.
nothing_happened() {
  [ ! -e "$MARKS/backups" ] || { echo "a backup was taken"; return 1; }
  [ ! -e "$INST/.kyoube/env.before-update" ] || { echo "the rollback point was replaced"; return 1; }
  if grep -E '^(pull|compose (up|build|stop|exec))' "$STUB_LOG"; then echo "docker was changed"; return 1; fi
}

backups_taken() { wc -l < "$MARKS/backups" | tr -d ' '; }

# write_unfinished TO REF: the state an update leaves when it stopped before the end.
write_unfinished() {
  mkdir -p "$INST/.kyoube"
  printf 'mode=%s\nfrom=%s\nto=%s\nref=%s\nbackup=%s\ndone=0\n' "${MODE:-release}" "${FROM:-v1.1.0}" "$1" "$2" "$MARKS/backup-dir" > "$INST/.kyoube/update-state"
  cp "$INST/.env" "$INST/.kyoube/env.before-update"
  mkdir -p "$MARKS/backup-dir"
}

@test "an untagged commit that is part of the release's history moves forward" {
  git -C "$INST" checkout -q "$(git -C "$INST" rev-parse v1.2.0~1)"
  run_update --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Update KyoubeAI "*" -> v1.2.0"* ]]
  [ "$(backups_taken)" = 1 ]
  git -C "$INST" tag --points-at HEAD | grep -Fx v1.2.0
  [ "$(grep '^done=' "$INST/.kyoube/update-state")" = "done=1" ]
}

@test "update.sh refuses a release that does not contain this checkout's commit, before any backup" {
  git -C "$INST" commit -q --allow-empty -m ahead-of-the-release
  run_update --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"databases only migrate forward"* ]]
  [[ "$output" == *"./update.sh --edge"* ]]
  [[ "$output" == *"./update.sh --rollback"* ]]
  nothing_happened
  [ -z "$(git -C "$INST" tag --points-at HEAD)" ]
}

@test "update.sh --edge refuses a branch that has diverged from its upstream, before any backup" {
  git -C "$SEED" commit -q --allow-empty -m upstream-only
  git -C "$INST" commit -q --allow-empty -m local-only
  head_before="$(git -C "$INST" rev-parse HEAD)"
  run_update --edge --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"diverged"* ]]
  [[ "$output" == *"nothing was changed"* ]]
  nothing_happened
  [ "$(git -C "$INST" rev-parse HEAD)" = "$head_before" ]
}

@test "update.sh refuses a different update while one is unfinished, and keeps the rollback point" {
  write_unfinished v1.2.0 "$(git -C "$INST" rev-parse v1.1.0)"
  cp "$INST/.kyoube/update-state" "$BATS_TEST_TMPDIR/state-before"
  run_update --version 1.1.0 --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"an update to v1.2.0 did not finish: run ./update.sh to resume it, or ./update.sh --rollback to undo it"* ]]
  run_update --edge --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"an update to v1.2.0 did not finish"* ]]
  [ ! -e "$MARKS/backups" ]
  cmp "$INST/.kyoube/update-state" "$BATS_TEST_TMPDIR/state-before"
  ! grep -E '^(pull|compose (up|build|stop|exec))' "$STUB_LOG"
}

@test "an unfinished edge update is resumed with --edge, and plain update.sh points there" {
  MODE=edge FROM=main@abc write_unfinished main@def "$(git -C "$INST" rev-parse HEAD)"
  run_update --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"an update to main@def did not finish: run ./update.sh --edge to resume it"* ]]
}

@test "update.sh resumes an unfinished release update without a new backup" {
  git -C "$INST" checkout -q v1.1.0
  write_unfinished v1.2.0 "$(git -C "$INST" rev-parse v1.1.0)"
  run_update --version v1.2.0 --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"resuming the unfinished update to v1.2.0"* ]]
  [ ! -e "$MARKS/backups" ]
  git -C "$INST" tag --points-at HEAD | grep -Fx v1.2.0
  grep -Fx "KYOUBE_VERSION=1.2.0" "$INST/.env"
  grep -F "compose up -d --no-build --wait" "$STUB_LOG"
  [ "$(grep '^done=' "$INST/.kyoube/update-state")" = "done=1" ]
  [ "$(grep '^ref=' "$INST/.kyoube/update-state")" = "ref=$(git -C "$INST" rev-parse v1.1.0)" ]
}

@test "a release update that failed to restart is resumed by the next run, not reported as done" {
  git -C "$INST" checkout -q v1.1.0
  STUB_FAIL_UP=1 run_update --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"./update.sh --rollback"* ]]
  [ "$(grep '^done=' "$INST/.kyoube/update-state")" = "done=0" ]
  run_update --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"resuming the unfinished update to v1.2.0"* ]]
  [[ "$output" != *"already on"* ]]
  [ "$(backups_taken)" = 1 ]
  [ "$(grep '^done=' "$INST/.kyoube/update-state")" = "done=1" ]
}

@test "an edge update whose build failed is resumed by the next run and builds again" {
  git -C "$SEED" commit -q --allow-empty -m newer
  printf 'KYOUBE_VERSION=dev\nKYOUBE_IMAGE=kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  STUB_FAIL_BUILD=1 run_update --edge --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"the build failed"* ]]
  run_update --edge --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"resuming the unfinished update"* ]]
  [[ "$output" != *"already up to date"* ]]
  [ "$(backups_taken)" = 1 ]
  [ "$(grep -c '^compose build' "$STUB_LOG")" = 2 ]
  [ "$(git -C "$INST" rev-parse HEAD)" = "$(git -C "$SEED" rev-parse HEAD)" ]
  [ "$(grep '^done=' "$INST/.kyoube/update-state")" = "done=1" ]
}

@test "update.sh --edge fast-forwards to the upstream, backs up once and rebuilds" {
  git -C "$SEED" commit -q --allow-empty -m newer
  printf 'KYOUBE_VERSION=dev\nKYOUBE_IMAGE=kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  run_update --edge --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Update KyoubeAI main@"*" -> origin/main (1 new commits)"* ]]
  [[ "$output" != *"switching this install"* ]]
  [ "$(backups_taken)" = 1 ]
  grep -Fx "compose build app" "$STUB_LOG"
  [ "$(git -C "$INST" rev-parse HEAD)" = "$(git -C "$SEED" rev-parse HEAD)" ]
}

@test "update.sh --edge on a source build that is up to date does nothing" {
  printf 'KYOUBE_VERSION=dev\nKYOUBE_IMAGE=kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  run_update --edge --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"already up to date"* ]]
  nothing_happened
}

@test "update.sh --edge on a published-image install switches .env to the source image before building" {
  git -C "$SEED" commit -q --allow-empty -m newer
  printf 'KYOUBE_VERSION=1.2.0\nKYOUBE_IMAGE=ghcr.io/jknigel/kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  run_update --edge --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"switching this install from the published image to a source build"* ]]
  [ "$(sed -n 's/^KYOUBE_IMAGE=//p' "$INST/.env")" = kyoubeai ]
  [ "$(sed -n 's/^KYOUBE_VERSION=//p' "$INST/.env")" = dev ]
  # the rollback point keeps the published image
  grep -Fx "KYOUBE_IMAGE=ghcr.io/jknigel/kyoubeai" "$INST/.kyoube/env.before-update"
  grep -Fx "KYOUBE_VERSION=1.2.0" "$INST/.kyoube/env.before-update"
}

@test "update.sh --edge on a published-image install with no new commits still rebuilds from source" {
  printf 'KYOUBE_VERSION=1.2.0\nKYOUBE_IMAGE=ghcr.io/jknigel/kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  run_update --edge --yes
  [ "$status" -eq 0 ]
  [[ "$output" != *"already up to date"* ]]
  [[ "$output" == *"switching this install from the published image to a source build"* ]]
  grep -Fx "compose build app" "$STUB_LOG"
  [ "$(sed -n 's/^KYOUBE_IMAGE=//p' "$INST/.env")" = kyoubeai ]
}

@test "rolling back an edge update that switched a published-image install builds nothing and restores the published image" {
  git -C "$SEED" commit -q --allow-empty -m newer
  printf 'KYOUBE_VERSION=1.2.0\nKYOUBE_IMAGE=ghcr.io/jknigel/kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  run_update --edge --yes
  [ "$status" -eq 0 ]
  [ "$(cat "$STUB_LOG.builds")" = "kyoubeai:dev" ]
  run_update --rollback --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"rolled back to main@"* ]]
  # still the one build of the update; the rollback built nothing
  [ "$(cat "$STUB_LOG.builds")" = "kyoubeai:dev" ]
  [ "$(sed -n 's/^KYOUBE_IMAGE=//p' "$INST/.env")" = ghcr.io/jknigel/kyoubeai ]
  [ "$(sed -n 's/^KYOUBE_VERSION=//p' "$INST/.env")" = 1.2.0 ]
  [ ! -e "$INST/.kyoube/update-state" ]
}

@test "rolling back an edge update on a source build rebuilds the previous code" {
  git -C "$SEED" commit -q --allow-empty -m newer
  printf 'KYOUBE_VERSION=dev\nKYOUBE_IMAGE=kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  run_update --edge --yes
  [ "$status" -eq 0 ]
  run_update --rollback --yes
  [ "$status" -eq 0 ]
  [ "$(cat "$STUB_LOG.builds")" = "$(printf 'kyoubeai:dev\nkyoubeai:dev')" ]
}

@test "a rollback downloads the published image it returns to before stopping anything" {
  git -C "$SEED" commit -q --allow-empty -m newer
  printf 'KYOUBE_VERSION=1.2.0\nKYOUBE_IMAGE=ghcr.io/jknigel/kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  run_update --edge --yes
  [ "$status" -eq 0 ]
  STUB_NO_IMAGE=1 run_update --rollback --yes
  [ "$status" -eq 0 ]
  pull_line="$(grep -n '^pull ghcr.io/jknigel/kyoubeai:1.2.0$' "$STUB_LOG" | cut -d: -f1)"
  stop_line="$(grep -n '^compose stop app$' "$STUB_LOG" | tail -1 | cut -d: -f1)"
  [ -n "$pull_line" ] && [ "$pull_line" -lt "$stop_line" ]
}

@test "a rollback whose image cannot be downloaded stops before changing anything and keeps the rollback point" {
  git -C "$SEED" commit -q --allow-empty -m newer
  printf 'KYOUBE_VERSION=1.2.0\nKYOUBE_IMAGE=ghcr.io/jknigel/kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  run_update --edge --yes
  [ "$status" -eq 0 ]
  head_before="$(git -C "$INST" rev-parse HEAD)"
  : > "$STUB_LOG"
  STUB_NO_IMAGE=1 STUB_FAIL_PULL=1 run_update --rollback --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"could not download ghcr.io/jknigel/kyoubeai:1.2.0"* ]]
  [[ "$output" == *"nothing was changed"* ]]
  ! grep -E '^compose (up|build|stop)' "$STUB_LOG"
  [ "$(git -C "$INST" rev-parse HEAD)" = "$head_before" ]
  [ -e "$INST/.kyoube/update-state" ]
}

# An install from 1.0 gets update.sh by checking out the new release, so the checkout is ahead of the stack: what .env
# selects (KYOUBE_VERSION) is what the stack runs. setup() leaves the checkout on v1.2.0 with KYOUBE_VERSION=1.1.0.

# came_from REF: move the checkout to REF, then back to v1.2.0, so HEAD@{1} is REF (a fresh clone has no earlier position).
came_from() {
  git -C "$INST" checkout -q "$1"
  git -C "$INST" checkout -q v1.2.0
}

@test "the first update from 1.0: a checkout already on the release updates a stack that runs an older one, with no checkout" {
  head_before="$(git -C "$INST" rev-parse HEAD)"
  run_update --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Update KyoubeAI v1.1.0 -> v1.2.0"* ]]
  [[ "$output" != *"already on"* ]]
  [ "$(backups_taken)" = 1 ]
  state="$INST/.kyoube/update-state"
  [ "$(grep '^from=' "$state")" = "from=v1.1.0" ]
  [ "$(grep '^to=' "$state")" = "to=v1.2.0" ]
  [ "$(grep '^ref=' "$state")" = "ref=$(git -C "$INST" rev-parse v1.1.0)" ]
  [ "$(grep '^done=' "$state")" = "done=1" ]
  grep -Fx "KYOUBE_VERSION=1.2.0" "$INST/.env"
  grep -Fx "KYOUBE_VERSION=1.1.0" "$INST/.kyoube/env.before-update"
  grep -F "compose up -d --no-build --wait" "$STUB_LOG"
  [ "$(git -C "$INST" rev-parse HEAD)" = "$head_before" ]
  ! git -C "$INST" reflog | grep -q 'checkout:'
}

@test "rolling back the first update from 1.0 returns to the old release's commit and .env" {
  run_update --yes
  [ "$status" -eq 0 ]
  run_update --rollback --yes
  [ "$status" -eq 0 ]
  [ "$(git -C "$INST" rev-parse HEAD)" = "$(git -C "$INST" rev-parse v1.1.0)" ]
  [ "$(sed -n 's/^KYOUBE_VERSION=//p' "$INST/.env")" = 1.1.0 ]
  [ "$(cat "$MARKS/restores")" = "$MARKS/backup-dir" ]
  [ ! -e "$INST/.kyoube/update-state" ]
}

@test "the first update from 1.0 records where the checkout was before when the old release has no tag here" {
  came_from "$(git -C "$INST" rev-parse v1.2.0~1)"
  printf 'KYOUBE_VERSION=1.0.0\nKYOUBE_IMAGE=ghcr.io/jknigel/kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  run_update --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Update KyoubeAI v1.0.0 -> v1.2.0"* ]]
  [ "$(grep '^from=' "$INST/.kyoube/update-state")" = "from=v1.0.0" ]
  [ "$(grep '^ref=' "$INST/.kyoube/update-state")" = "ref=$(git -C "$INST" rev-parse v1.2.0~1)" ]
  [ "$(grep '^done=' "$INST/.kyoube/update-state")" = "done=1" ]
}

@test "the first update from 1.0 is refused before the backup when no rollback point can be recorded" {
  printf 'KYOUBE_VERSION=1.0.0\nKYOUBE_IMAGE=ghcr.io/jknigel/kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  cp "$INST/.env" "$BATS_TEST_TMPDIR/env-before"
  run_update --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"rollback point"* ]]
  [[ "$output" == *"nothing was changed"* ]]
  [[ "$output" == *"git checkout v1.0.0"* ]]
  nothing_happened
  [ ! -e "$INST/.kyoube/update-state" ]
  cmp "$INST/.env" "$BATS_TEST_TMPDIR/env-before"
}

@test "a checkout on an older release than the one the stack runs is refused as a downgrade, before the backup" {
  printf 'KYOUBE_VERSION=1.3.0\nKYOUBE_IMAGE=ghcr.io/jknigel/kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  cp "$INST/.env" "$BATS_TEST_TMPDIR/env-before"
  run_update --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"v1.2.0 is older than v1.3.0"* ]]
  [[ "$output" == *"databases only migrate forward"* ]]
  nothing_happened
  [ ! -e "$INST/.kyoube/update-state" ]
  cmp "$INST/.env" "$BATS_TEST_TMPDIR/env-before"
}

@test "a stack that already runs the release the checkout is on is left alone" {
  printf 'KYOUBE_VERSION=1.2.0\nKYOUBE_IMAGE=ghcr.io/jknigel/kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  run_update --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"already on v1.2.0"* ]]
  nothing_happened
}

@test "a checkout on the release whose stack runs a source build switches it to the published release" {
  came_from v1.1.0
  printf 'KYOUBE_VERSION=dev\nKYOUBE_IMAGE=kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  run_update --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Update KyoubeAI source build -> v1.2.0"* ]]
  [[ "$output" == *"this install built its own image"* ]]
  [ "$(backups_taken)" = 1 ]
  state="$INST/.kyoube/update-state"
  [ "$(grep '^from=' "$state")" = "from=source build" ]
  [ "$(grep '^ref=' "$state")" = "ref=$(git -C "$INST" rev-parse v1.1.0)" ]
  [ "$(grep '^done=' "$state")" = "done=1" ]
  [ "$(sed -n 's/^KYOUBE_IMAGE=//p' "$INST/.env")" = ghcr.io/jknigel/kyoubeai ]
  [ "$(sed -n 's/^KYOUBE_VERSION=//p' "$INST/.env")" = 1.2.0 ]
  grep -Fx "KYOUBE_VERSION=dev" "$INST/.kyoube/env.before-update"
  [ ! -e "$STUB_LOG.builds" ]
}

@test "a stack whose .env has no KYOUBE_VERSION is a source build too" {
  came_from v1.1.0
  printf 'COMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  run_update --yes
  [ "$status" -eq 0 ]
  [ "$(grep '^from=' "$INST/.kyoube/update-state")" = "from=source build" ]
  [ "$(sed -n 's/^KYOUBE_VERSION=//p' "$INST/.env")" = 1.2.0 ]
}

@test "rolling back the switch from a source build restores the source image's .env and builds nothing" {
  came_from v1.1.0
  printf 'KYOUBE_VERSION=dev\nKYOUBE_IMAGE=kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  run_update --yes
  [ "$status" -eq 0 ]
  run_update --rollback --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"rolled back to source build"* ]]
  [ "$(git -C "$INST" rev-parse HEAD)" = "$(git -C "$INST" rev-parse v1.1.0)" ]
  [ "$(sed -n 's/^KYOUBE_IMAGE=//p' "$INST/.env")" = kyoubeai ]
  [ "$(sed -n 's/^KYOUBE_VERSION=//p' "$INST/.env")" = dev ]
  [ ! -e "$STUB_LOG.builds" ]
  ! grep '^pull' "$STUB_LOG"
  [ ! -e "$INST/.kyoube/update-state" ]
}

@test "the switch from a source build is refused before the backup when the checkout has no earlier position" {
  printf 'KYOUBE_VERSION=dev\nKYOUBE_IMAGE=kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  cp "$INST/.env" "$BATS_TEST_TMPDIR/env-before"
  run_update --yes
  [ "$status" -ne 0 ]
  [[ "$output" == *"source build"* ]]
  [[ "$output" == *"rollback point"* ]]
  [[ "$output" == *"git checkout <commit>"* ]]
  nothing_happened
  [ ! -e "$INST/.kyoube/update-state" ]
  cmp "$INST/.env" "$BATS_TEST_TMPDIR/env-before"
}

# local_commit WHEN: a commit on the branch (not on origin), committed at WHEN (ISO 8601).
local_commit() {
  GIT_COMMITTER_DATE="$1" git -C "$INST" commit -q --allow-empty -m local
}

@test "update.sh --edge rebuilds a source image that is older than the checkout, with no new commits" {
  printf 'KYOUBE_VERSION=dev\nKYOUBE_IMAGE=kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  STUB_IMAGE_CREATED=2000-01-01T00:00:00.000000000Z run_update --edge --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"the image is older than this checkout; rebuilding"* ]]
  [[ "$output" != *"already up to date"* ]]
  [[ "$output" != *"switching this install"* ]]
  [ "$(backups_taken)" = 1 ]
  grep -Fx "compose build app" "$STUB_LOG"
  state="$INST/.kyoube/update-state"
  [ "$(grep '^mode=' "$state")" = "mode=edge" ]
  [ "$(grep '^done=' "$state")" = "done=1" ]
  # a fresh clone has no earlier position: the rollback point is the current commit, and the user is told
  [ "$(grep '^ref=' "$state")" = "ref=$(git -C "$INST" rev-parse HEAD)" ]
  [[ "$output" == *"returns the data but not older code"* ]]
}

@test "an edge update of a stale image records the checkout's earlier position, and rolling back rebuilds that code" {
  printf 'KYOUBE_VERSION=dev\nKYOUBE_IMAGE=kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  previous="$(git -C "$INST" rev-parse HEAD)"
  local_commit 2030-01-01T12:00:00+00:00
  STUB_IMAGE_CREATED=2030-01-01T13:30:00+02:00 run_update --edge --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"the image is older than this checkout; rebuilding"* ]]
  [[ "$output" != *"not older code"* ]]
  [[ "$output" == *"Update KyoubeAI main@$(git -C "$INST" rev-parse --short "$previous") -> main@$(git -C "$INST" rev-parse --short HEAD):"* ]]
  [ "$(grep '^ref=' "$INST/.kyoube/update-state")" = "ref=$previous" ]
  [ "$(grep '^from=' "$INST/.kyoube/update-state")" = "from=main@$(git -C "$INST" rev-parse --short "$previous")" ]
  [ "$(grep '^done=' "$INST/.kyoube/update-state")" = "done=1" ]
  run_update --rollback --yes
  [ "$status" -eq 0 ]
  [ "$(git -C "$INST" rev-parse HEAD)" = "$previous" ]
  [[ "$output" == *"rolled back to main@$(git -C "$INST" rev-parse --short "$previous")"* ]]
  [ "$(git -C "$INST" symbolic-ref --short HEAD)" = main ]
  [ "$(cat "$STUB_LOG.builds")" = "$(printf 'kyoubeai:dev\nkyoubeai:dev')" ]
}

@test "update.sh --edge leaves a source image that is newer than the checkout alone" {
  printf 'KYOUBE_VERSION=dev\nKYOUBE_IMAGE=kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  STUB_IMAGE_CREATED=2999-01-01T00:00:00.5Z run_update --edge --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"already up to date"* ]]
  nothing_happened
}

@test "update.sh --edge compares the image's time with the commit's across time zones" {
  printf 'KYOUBE_VERSION=dev\nKYOUBE_IMAGE=kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  local_commit 2030-01-01T12:00:00+00:00
  # 14:30 at +02:00 is 12:30 UTC, half an hour after the commit; 13:30 at +02:00 is 11:30 UTC, half an hour before it
  STUB_IMAGE_CREATED=2030-01-01T14:30:00+02:00 run_update --edge --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"already up to date"* ]]
  nothing_happened
  STUB_IMAGE_CREATED=2030-01-01T13:30:00+02:00 run_update --edge --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"the image is older than this checkout; rebuilding"* ]]
}

@test "update.sh --edge rebuilds when the source image is not on this machine" {
  printf 'KYOUBE_VERSION=dev\nKYOUBE_IMAGE=kyoubeai\nCOMPOSE_PROJECT_NAME=inst\n' > "$INST/.env"
  STUB_NO_IMAGE=1 run_update --edge --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"the image kyoubeai:dev is not on this machine; rebuilding"* ]]
  [ "$(backups_taken)" = 1 ]
  grep -Fx "compose build app" "$STUB_LOG"
}
