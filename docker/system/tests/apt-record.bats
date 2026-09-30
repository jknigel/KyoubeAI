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
printf '%s\n' $FAKE_MANUAL
EOF
  chmod +x "$FAKE/apt-mark"
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
