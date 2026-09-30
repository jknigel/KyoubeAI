#!/usr/bin/env bats

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../apt-restore"
  FAKE="$BATS_TEST_TMPDIR/bin"; mkdir -p "$FAKE"
  export KYOUBE_STATE_DIR="$BATS_TEST_TMPDIR/state"; mkdir -p "$KYOUBE_STATE_DIR"
  export KYOUBE_APT_CACHE="$BATS_TEST_TMPDIR/cache"
  export CALLS="$BATS_TEST_TMPDIR/calls"; : > "$CALLS"
  export FAKE_INSTALLED_FILE="$BATS_TEST_TMPDIR/installed"
  : > "$FAKE_INSTALLED_FILE"
  cat > "$FAKE/dpkg-query" <<'EOF'
#!/bin/sh
# Check both FAKE_INSTALLED env var and the installed file
for p in $FAKE_INSTALLED; do
  [ "$p" = "$3" ] && { printf 'install ok installed'; exit 0; }
done
if [ -f "$FAKE_INSTALLED_FILE" ]; then
  while IFS= read -r p || [ -n "$p" ]; do
    [ "$p" = "$3" ] && { printf 'install ok installed'; exit 0; }
  done < "$FAKE_INSTALLED_FILE"
fi
exit 1
EOF
  cat > "$FAKE/apt-get" <<'EOF'
#!/bin/sh
echo "apt-get $*" >> "$CALLS"
case "$1" in
  update) exit "${FAKE_UPDATE_EXIT:-0}" ;;
  install)
    # If FAKE_BAD is set and any argument matches a bad package, fail
    for bad in $FAKE_BAD; do
      for arg in "$@"; do
        [ "$arg" = "$bad" ] && exit "${FAKE_INSTALL_EXIT:-100}"
      done
    done
    # Determine the exit code
    rc="${FAKE_INSTALL_EXIT:-0}"
    # Only record successful installations in the file (skip flags)
    if [ "$rc" -eq 0 ]; then
      for arg in "$@"; do
        case "$arg" in
          -y|--no-install-recommends) continue ;;
          -*) continue ;;
          *) printf '%s\n' "$arg" >> "$FAKE_INSTALLED_FILE" ;;
        esac
      done
    fi
    exit "$rc"
    ;;
esac
EOF
  cat > "$FAKE/apt-mark" <<'EOF'
#!/bin/sh
echo "apt-mark $*" >> "$CALLS"
EOF
  chmod +x "$FAKE"/*
  export PATH="$FAKE:$PATH"
}

@test "does nothing without a list, and clears an old status" {
  echo "failed 1" > "$KYOUBE_STATE_DIR/apt-restore.status"
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ ! -e "$KYOUBE_STATE_DIR/apt-restore.status" ]
  [ ! -s "$CALLS" ]
}

@test "reports ok 0 and runs no apt when everything is installed" {
  printf 'tree\nffmpeg\n' > "$KYOUBE_STATE_DIR/apt-packages.txt"
  FAKE_INSTALLED="tree ffmpeg" run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$KYOUBE_STATE_DIR/apt-restore.status")" = "ok 0" ]
  [ ! -s "$CALLS" ]
}

@test "reinstalls only what is missing and marks it manual again" {
  printf 'tree\nffmpeg\njq\n' > "$KYOUBE_STATE_DIR/apt-packages.txt"
  FAKE_INSTALLED="ffmpeg" run "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -qx 'apt-get update -q' "$CALLS"
  grep -qx 'apt-get install -y --no-install-recommends tree jq' "$CALLS"
  grep -qx 'apt-mark manual tree jq' "$CALLS"
  [ "$(cat "$KYOUBE_STATE_DIR/apt-restore.status")" = "ok 2" ]
  [ -d "$KYOUBE_APT_CACHE/archives/partial" ] && [ -d "$KYOUBE_APT_CACHE/lists/partial" ]
}

@test "still installs from the cached index when apt-get update fails (offline start)" {
  echo tree > "$KYOUBE_STATE_DIR/apt-packages.txt"
  FAKE_UPDATE_EXIT=100 run "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -q 'apt-get install' "$CALLS"
  grep -q 'using the cached package index' "$KYOUBE_STATE_DIR/apt-restore.log"
  [ "$(cat "$KYOUBE_STATE_DIR/apt-restore.status")" = "ok 1" ]
}

@test "never fails the start: a package gone from a newer Debian is reported, not fatal" {
  echo gone-in-trixie > "$KYOUBE_STATE_DIR/apt-packages.txt"
  FAKE_INSTALL_EXIT=100 run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$KYOUBE_STATE_DIR/apt-restore.status")" = "failed 100" ]
  grep -q 'reinstalling: gone-in-trixie' "$KYOUBE_STATE_DIR/apt-restore.log"
  [ "$(cat "$KYOUBE_STATE_DIR/apt-pending.txt")" = "gone-in-trixie" ]
}

@test "skips a line that is not a package name instead of passing it to apt" {
  printf 'tree\n$(touch /tmp/pwned)\n# comment\n\n' > "$KYOUBE_STATE_DIR/apt-packages.txt"
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -qx 'apt-get install -y --no-install-recommends tree' "$CALLS"
  grep -q "skipping" "$KYOUBE_STATE_DIR/apt-restore.log"
}

@test "bulk install fails on one bad package: retries individually, pending holds only bad one, status is failed" {
  printf 'tree\njq\nffmpeg\n' > "$KYOUBE_STATE_DIR/apt-packages.txt"
  FAKE_INSTALLED="" FAKE_BAD="jq" run "$SCRIPT"
  [ "$status" -eq 0 ]
  # Bulk install should fail (jq is in FAKE_BAD)
  grep -q 'apt-get install -y --no-install-recommends tree jq ffmpeg' "$CALLS"
  grep -q 'bulk install failed; retrying each package individually' "$KYOUBE_STATE_DIR/apt-restore.log"
  # Individual retries should happen for each package
  grep -q 'apt-get install -y --no-install-recommends tree' "$CALLS"
  grep -q 'apt-get install -y --no-install-recommends jq' "$CALLS"
  grep -q 'apt-get install -y --no-install-recommends ffmpeg' "$CALLS"
  # Only jq should be in apt-pending.txt (it fails, tree and ffmpeg succeed)
  [ "$(cat "$KYOUBE_STATE_DIR/apt-pending.txt")" = "jq" ]
  [ "$(cat "$KYOUBE_STATE_DIR/apt-restore.status")" = "failed 100" ]
}

@test "a later successful restore removes apt-pending.txt and reports ok N" {
  printf 'tree\njq\nffmpeg\n' > "$KYOUBE_STATE_DIR/apt-packages.txt"
  echo "jq" > "$KYOUBE_STATE_DIR/apt-pending.txt"
  # Now all packages are available, apt-pending.txt should be removed
  FAKE_INSTALLED="tree jq ffmpeg" run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$KYOUBE_STATE_DIR/apt-restore.status")" = "ok 0" ]
  [ ! -e "$KYOUBE_STATE_DIR/apt-pending.txt" ]
}
