#!/usr/bin/env bats

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../apt-record"
  FAKE="$BATS_TEST_TMPDIR/bin"; mkdir -p "$FAKE"
  export KYOUBE_APT_BASELINE="$BATS_TEST_TMPDIR/baseline.txt"
  export KYOUBE_STATE_DIR="$BATS_TEST_TMPDIR/state"
  printf 'ca-certificates\ncurl\ngit\n' > "$KYOUBE_APT_BASELINE"
  cat > "$FAKE/apt-mark" <<'EOF'
#!/bin/sh
[ "${FAKE_APT_MARK_FAIL:-0}" = 1 ] && exit 1
if [ -n "$FAKE_MANUAL" ]; then
  printf '%s\n' $FAKE_MANUAL
fi
EOF
  cat > "$FAKE/dpkg-query" <<'EOF'
#!/bin/sh
for p in $FAKE_INSTALLED; do [ "$p" = "$3" ] && { printf 'install ok installed'; exit 0; }; done
exit 1
EOF
  chmod +x "$FAKE"/*
  export PATH="$FAKE:$PATH"
}

@test "keeps the packages chosen on top of the image, sorted" {
  FAKE_MANUAL="tree git ffmpeg curl" run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$KYOUBE_STATE_DIR/apt-packages.txt")" = "$(printf 'ffmpeg\ntree')" ]
}

@test "writes an empty list when only image packages are marked manual" {
  FAKE_MANUAL="curl git" run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ -f "$KYOUBE_STATE_DIR/apt-packages.txt" ]
  [ ! -s "$KYOUBE_STATE_DIR/apt-packages.txt" ]
}

@test "leaves the existing list alone when apt-mark fails" {
  mkdir -p "$KYOUBE_STATE_DIR"; echo ffmpeg > "$KYOUBE_STATE_DIR/apt-packages.txt"
  FAKE_APT_MARK_FAIL=1 run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$KYOUBE_STATE_DIR/apt-packages.txt")" = "ffmpeg" ]
}

@test "does nothing without a baseline" {
  rm "$KYOUBE_APT_BASELINE"
  FAKE_MANUAL="tree" run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ ! -e "$KYOUBE_STATE_DIR/apt-packages.txt" ]
}

@test "a pending entry that is not installed is kept in the list alongside manual packages" {
  mkdir -p "$KYOUBE_STATE_DIR"
  echo "jq" > "$KYOUBE_STATE_DIR/apt-pending.txt"
  FAKE_MANUAL="tree git ffmpeg curl" FAKE_INSTALLED="" run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$KYOUBE_STATE_DIR/apt-packages.txt")" = "$(printf 'ffmpeg\njq\ntree')" ]
}

@test "a pending entry that is installed now is not added from the pending file" {
  mkdir -p "$KYOUBE_STATE_DIR"
  echo "jq" > "$KYOUBE_STATE_DIR/apt-pending.txt"
  FAKE_MANUAL="tree git ffmpeg curl" FAKE_INSTALLED="jq" run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$KYOUBE_STATE_DIR/apt-packages.txt")" = "$(printf 'ffmpeg\ntree')" ]
}

@test "apt-mark exiting 0 with no output leaves the existing list untouched" {
  mkdir -p "$KYOUBE_STATE_DIR"
  echo "existing-pkg" > "$KYOUBE_STATE_DIR/apt-packages.txt"
  FAKE_MANUAL="" run "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$KYOUBE_STATE_DIR/apt-packages.txt")" = "existing-pkg" ]
}
