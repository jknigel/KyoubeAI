#!/bin/sh
# KyoubeAI container entrypoint. Prepares Kyoube state, starts the plugin
# bootstrap watcher, then hands over to the core image's own entrypoint unchanged.
set -e

BOOTSTRAP=/opt/kyoube/bootstrap/dist/kyoube.mjs
home_dir="${PAPERCLIP_HOME:-/kyoubeai}"
MARKER="$home_dir/.migrated-from-paperclip-home"

mkdir -p "$home_dir/kyoube" "$home_dir/.hermes"
if [ "$(id -u)" -eq 0 ]; then
  chown node:node "$home_dir" "$home_dir/kyoube" "$home_dir/.hermes" 2>/dev/null || true
  # An install migrated from 0.1.x (home at /paperclip) can still hold absolute
  # /paperclip/... paths in the core database, adapter configs and harness
  # state. scripts/migrate-from-0.1.sh leaves a marker; while it exists the old
  # path stays resolvable. Deleting the marker removes the link at the next
  # start (`kyoube doctor` says when that is safe).
  if [ -f "$MARKER" ]; then
    [ -e /paperclip ] || ln -s "$home_dir" /paperclip
  elif [ -L /paperclip ]; then
    rm -f /paperclip
  fi
  run_as_node() { gosu node "$@"; }
else
  run_as_node() { "$@"; }
fi

run_as_node node "$BOOTSTRAP" write-config

if [ "${KYOUBE_BOOTSTRAP_DISABLED:-0}" != "1" ]; then
  # Double-fork through a subshell so the watcher is re-parented to PID 1 (tini)
  # and reaped there. Backgrounding it directly would make it a child of this
  # shell, whose PID the `exec` below hands to the core server — leaving a
  # long-lived node process the server never waits on.
  ( run_as_node node "$BOOTSTRAP" ensure-plugins --watch & )
fi

exec docker-entrypoint.sh "$@"
