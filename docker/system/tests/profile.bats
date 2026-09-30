#!/usr/bin/env bats

setup() {
  PROFILE="$BATS_TEST_DIRNAME/../kyoube-profile.sh"
  export HOME="$BATS_TEST_TMPDIR"
}

@test "puts /kyoubeai/.local/bin first, once, however often it is sourced" {
  run env -i HOME="$HOME" PATH=/usr/bin:/bin bash -c '. "$1"; . "$1"; printf %s "$PATH"' _ "$PROFILE"
  [ "$output" = "/kyoubeai/.local/bin:/usr/bin:/bin" ]
}

@test "sources ~/.bashrc in an interactive login shell when the user has no profile of their own" {
  echo 'export FROM_BASHRC=yes' > "$HOME/.bashrc"
  run env -i HOME="$HOME" PATH=/usr/bin:/bin bash --norc --noprofile -i -c '. "$1"; printf "[%s]" "${FROM_BASHRC-no}"' _ "$PROFILE"
  [[ "$output" == *"[yes]"* ]]
}

@test "leaves ~/.bashrc to the user's own ~/.profile" {
  echo 'export FROM_BASHRC=yes' > "$HOME/.bashrc"
  echo '# mine' > "$HOME/.profile"
  run env -i HOME="$HOME" PATH=/usr/bin:/bin bash --norc --noprofile -i -c '. "$1"; printf "[%s]" "${FROM_BASHRC-no}"' _ "$PROFILE"
  [[ "$output" == *"[no]"* ]]
}

@test "does not source ~/.bashrc in a non-interactive shell" {
  echo 'export FROM_BASHRC=yes' > "$HOME/.bashrc"
  run env -i HOME="$HOME" PATH=/usr/bin:/bin bash -c '. "$1"; printf "[%s]" "${FROM_BASHRC-no}"' _ "$PROFILE"
  [ "$output" = "[no]" ]
}

@test "is valid POSIX sh" {
  run sh -n "$PROFILE"
  [ "$status" -eq 0 ]
}
