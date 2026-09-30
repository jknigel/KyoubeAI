#!/usr/bin/env bats

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
