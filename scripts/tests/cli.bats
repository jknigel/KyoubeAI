#!/usr/bin/env bats

setup() {
  INSTALL="$BATS_TEST_DIRNAME/../../install.sh"
  # A docker that records being called and then fails, so a test sees whether install.sh got that far.
  STUB_BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB_BIN"
  printf '#!/bin/sh\necho "$*" >> "%s/docker-calls"\nexit 1\n' "$BATS_TEST_TMPDIR" > "$STUB_BIN/docker"
  chmod +x "$STUB_BIN/docker"
}

# expect_refusal MESSAGE ARGS...: install.sh ARGS fails with MESSAGE and never calls docker.
expect_refusal() {
  local message="$1"
  shift
  run env PATH="$STUB_BIN:$PATH" "$INSTALL" "$@"
  [ "$status" -ne 0 ] || { echo "expected a failure from: $*"; return 1; }
  case "$output" in *"$message"*) ;; *) echo "expected '$message' in: $output"; return 1 ;; esac
  [ ! -e "$BATS_TEST_TMPDIR/docker-calls" ] || { echo "docker was called for: $*"; return 1; }
}

@test "install.sh --help prints usage without touching Docker" {
  run env PATH=/usr/bin:/bin "$BATS_TEST_DIRNAME/../../install.sh" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: ./install.sh"* ]]
}

@test "install.sh rejects an unknown option" {
  run "$BATS_TEST_DIRNAME/../../install.sh" --frobnicate
  [ "$status" -ne 0 ]
  [[ "$output" == *"unknown option: --frobnicate"* ]]
}

@test "install.sh is bash 3.2-clean" {
  run bash -n "$BATS_TEST_DIRNAME/../../install.sh"
  [ "$status" -eq 0 ]
}

@test "install.sh refuses a bad --port before touching Docker" {
  expect_refusal "not a port: abc" --port abc
  expect_refusal "not a port: 0" --port 0
  expect_refusal "not a port: 65536" --port 65536
  expect_refusal "not a port: 3100x" --port 3100x
  expect_refusal "not a port: 99999999999999999999" --port 99999999999999999999
}

@test "install.sh refuses a bad --name before touching Docker" {
  expect_refusal "not a valid project name: Foo" --name Foo
  expect_refusal "not a valid project name: -x" --name -x
  expect_refusal "not a valid project name: _x" --name _x
  expect_refusal "not a valid project name: a/b" --name a/b
  expect_refusal "not a valid project name: my app" --name "my app"
}

@test "install.sh refuses a bad --version before touching Docker" {
  expect_refusal "not a release version: abc" --version abc
  expect_refusal "not a release version: 1.2" --version 1.2
  expect_refusal "not a release version: 1.2.0.1" --version 1.2.0.1
  expect_refusal "not a release version: 1.2.x" --version 1.2.x
  expect_refusal "not a release version: vv1.2.0" --version vv1.2.0
}

@test "install.sh accepts a release version with or without a leading v, then checks Docker" {
  run env PATH="$STUB_BIN:$PATH" "$INSTALL" --version 1.1.0 --port 3199 --name second-1_x
  [ "$status" -ne 0 ]
  [[ "$output" == *"Docker is installed but not reachable"* ]]
  [ -e "$BATS_TEST_TMPDIR/docker-calls" ]
  run env PATH="$STUB_BIN:$PATH" "$INSTALL" --version v1.1.0
  [ "$status" -ne 0 ]
  [[ "$output" == *"Docker is installed but not reachable"* ]]
}
