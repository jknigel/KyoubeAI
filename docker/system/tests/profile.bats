#!/usr/bin/env bats

setup() {
  PROFILE="$BATS_TEST_DIRNAME/../kyoube-profile.sh"
  export HOME="$BATS_TEST_TMPDIR"
}

# Runs a command the way a fresh login would see it, minus what the machine
# running the tests lends it. Its stdin is /dev/null: a bash -c whose stdin is
# a socket (some CI runners and agent harnesses hand their children one) reads
# ~/.bashrc by itself before it reads anything else, which would fail the
# non-interactive test with the profile not at fault. It gets a session of its
# own, so an interactive bash has no terminal to take over and only prints that
# it has no job control.
clean_env() {
  if command -v setsid >/dev/null 2>&1; then
    setsid -w env -i HOME="$HOME" PATH=/usr/bin:/bin "$@" </dev/null
  else
    env -i HOME="$HOME" PATH=/usr/bin:/bin "$@" </dev/null
  fi
}

# An interactive bash may print job-control diagnostics before the marker the
# test asks for; the marker is the last line. bats shows a failing test's
# stderr, so say what the shell printed.
last_line_is() {
  [ "${lines[${#lines[@]}-1]}" = "$1" ] || {
    printf 'expected the last line to be %s, the shell printed:\n%s\n' "$1" "$output" >&2
    return 1
  }
}

@test "puts /kyoubeai/.local/bin first, once, however often it is sourced" {
  run clean_env bash -c '. "$1"; . "$1"; printf %s "$PATH"' _ "$PROFILE"
  [ "$output" = "/kyoubeai/.local/bin:/usr/bin:/bin" ]
}

@test "sources ~/.bashrc in an interactive login shell when the user has no profile of their own" {
  echo 'export FROM_BASHRC=yes' > "$HOME/.bashrc"
  run clean_env bash --norc --noprofile -i -c '. "$1"; printf "[%s]" "${FROM_BASHRC-no}"' _ "$PROFILE"
  last_line_is "[yes]"
}

@test "leaves ~/.bashrc to the user's own ~/.profile" {
  echo 'export FROM_BASHRC=yes' > "$HOME/.bashrc"
  echo '# mine' > "$HOME/.profile"
  run clean_env bash --norc --noprofile -i -c '. "$1"; printf "[%s]" "${FROM_BASHRC-no}"' _ "$PROFILE"
  last_line_is "[no]"
}

@test "does not source ~/.bashrc in a non-interactive shell" {
  echo 'export FROM_BASHRC=yes' > "$HOME/.bashrc"
  run clean_env bash -c '. "$1"; printf "[%s]" "${FROM_BASHRC-no}"' _ "$PROFILE"
  [ "$output" = "[no]" ] || {
    printf 'expected exactly [no], the shell printed:\n%s\n' "$output" >&2
    return 1
  }
}

@test "is valid POSIX sh" {
  run sh -n "$PROFILE"
  [ "$status" -eq 0 ]
}
