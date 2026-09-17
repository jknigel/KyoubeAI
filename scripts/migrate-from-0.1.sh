#!/usr/bin/env bash
# One-off migration of a KyoubeAI 0.1.x deployment to 0.2.x:
#   - .env keys PAPERCLIP_PUBLIC_URL / PAPERCLIP_DEPLOYMENT_EXPOSURE / PAPERCLIP_VERSION -> KYOUBE_*
#   - Postgres role + database `paperclip` -> `kyoubeai`, renamed in place (the
#     bootstrap superuser cannot rename itself, so a temporary superuser does it)
#   - home volume <project>_paperclip-home -> <project>_kyoubeai-home (copied,
#     plus the marker that keeps /paperclip resolvable inside the container)
#   - the 0.2.x image built or pulled, the stack started, `kyoube doctor` run
#
#   bash scripts/migrate-from-0.1.sh [--no-backup]
#   bash scripts/migrate-from-0.1.sh --check      # count stored /paperclip/ paths; changes nothing
#
# Idempotent: every step checks its precondition and skips when already done, so
# an interrupted run is simply re-run. Plain `docker compose` throughout, so
# COMPOSE_PROJECT_NAME / COMPOSE_ENV_FILES select the stack (docs/operations.md).
# Take a backup with the 0.1.x checkout's scripts/backup.sh BEFORE `git pull`;
# this script also snapshots the whole cluster and the old volume, as a last
# resort. That snapshot is a `pg_dumpall --no-role-passwords` plus a tar, not a
# scripts/backup.sh archive, because backup.sh dumps the `kyoubeai` database as
# the `kyoubeai` role and neither exists yet — so scripts/restore.sh cannot read
# it either; docs/upgrading.md "Rolling back" has the by-hand recipe.
set -euo pipefail
# Git Bash would rewrite `volume:/path` mount arguments into Windows paths, so
# every `docker run` below is prefixed with MSYS_NO_PATHCONV=1. It is deliberately
# NOT exported: the same switch also stops Git Bash converting an inherited
# COMPOSE_ENV_FILES, and compose would then look for C:\c\Users\... and fail on
# every call (scripts/smoke.sh passes a POSIX path there).

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MODE=migrate
NO_BACKUP=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE=check ;;
    --no-backup) NO_BACKUP=1 ;;
    *) echo "usage: migrate-from-0.1.sh [--no-backup] [--check]" >&2; exit 2 ;;
  esac
done
TAR_IMAGE="${KYOUBE_BACKUP_IMAGE:-alpine:3.20}"
# Unset under the default invocation, so default it before trimming (set -u).
ENV_FILE="${COMPOSE_ENV_FILES:-}"
ENV_FILE="${ENV_FILE%%,*}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
MARKER=".migrated-from-paperclip-home"

log() { echo "migrate: $*"; }

# The db container's unix socket trusts any local role, so each step connects as
# whichever role it needs. Output is trimmed; errors are fatal to the caller.
psql_q() { # user db sql -> stdout
  docker compose exec -T db psql -U "$1" -d "$2" -v ON_ERROR_STOP=1 -Atqc "$3" </dev/null | tr -d '\r'
}
role_exists() { [[ "$(psql_q "$1" postgres "select count(*) from pg_roles where rolname = '$2'" 2>/dev/null)" == "1" ]]; }
db_exists() { [[ "$(psql_q "$1" postgres "select count(*) from pg_database where datname = '$2'" 2>/dev/null)" == "1" ]]; }
# The superuser we can talk as right now: the new name after the rename, the old one before.
admin_role() {
  if role_exists kyoubeai kyoubeai; then echo kyoubeai
  elif role_exists paperclip paperclip; then echo paperclip
  else return 1
  fi
}

# Rows whose absolute path still starts with /paperclip/: every `cwd` column in
# the core database (execution/project workspaces, operations, runtime services)
# plus agents' adapter configs. Generic over the schema so a core bump that adds
# a table needs no change here.
count_legacy_paths() {
  local admin db out
  admin="$(admin_role)" || { echo "migrate: neither a kyoubeai nor a paperclip role — is the db service up?" >&2; return 1; }
  db=kyoubeai; db_exists "$admin" kyoubeai || db=paperclip
  # The count leaves as a NOTICE, i.e. on stderr, so the streams are merged; keep
  # the whole output rather than piping it straight into sed, because on failure
  # psql's error message is the only diagnostic there is and sed would eat it.
  if ! out="$(docker compose exec -T db psql -U "$admin" -d "$db" -v ON_ERROR_STOP=1 -Atq -f - <<'SQL' 2>&1
DO $$
DECLARE r record; n bigint; total bigint := 0;
BEGIN
  FOR r IN SELECT table_name, column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'cwd' LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I LIKE %L', r.table_name, r.column_name, '/paperclip/%') INTO n;
    total := total + n;
  END LOOP;
  IF to_regclass('public.agents') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM agents WHERE adapter_config::text LIKE ''%/paperclip/%''' INTO n;
    total := total + n;
  END IF;
  RAISE NOTICE 'legacy_paths=%', total;
END $$;
SQL
)"; then
    echo "migrate: counting legacy paths failed:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  printf '%s\n' "$out" | sed -n 's/.*legacy_paths=//p' | tr -d '\r'
}

command -v jq >/dev/null || { echo "migrate: jq is required" >&2; exit 1; }

if [[ "$MODE" == "check" ]]; then
  # --check changes nothing, so --no-recreate: a db container still running the
  # 0.1.x service definition stays exactly as it is (recreating it would drop the
  # running app's connections). --wait so the first psql meets a ready server.
  docker compose up -d --no-recreate --wait db >/dev/null
  n="$(count_legacy_paths)"
  log "$n stored path(s) still start with /paperclip/ (cwd columns and agents.adapter_config)"
  if [[ "$n" == "0" ]]; then
    log "safe to delete the marker: docker compose exec app rm -f /kyoubeai/$MARKER — the /paperclip link goes away at the next start"
  fi
  exit 0
fi

[[ -f "$ENV_FILE" ]] || { echo "migrate: $ENV_FILE not found" >&2; exit 1; }

# 1. Stop the app first: the database rename needs no open connections, the volume
#    copy a quiet home, and bringing the db up on this checkout's service
#    definition may recreate the container — which must not happen under a live
#    app. --wait so every psql below meets a ready server (the healthcheck passes
#    on a 0.1.x volume: pg_isready does not authenticate).
docker compose stop app 2>/dev/null || true
docker compose up -d --wait db >/dev/null
PROJECT="$(docker compose config --format json | jq -r .name)"
OLD_VOL="${PROJECT}_paperclip-home"
NEW_VOL="${PROJECT}_kyoubeai-home"
ADMIN="$(admin_role)" || { echo "migrate: no superuser role found in the cluster" >&2; exit 1; }
log "project '$PROJECT', env file $ENV_FILE, cluster superuser '$ADMIN'"

# 2. Last-resort snapshot: the whole cluster as SQL and the old home volume.
#    Deliberately NOT scripts/backup.sh: that dumps the `kyoubeai` database as
#    the `kyoubeai` role, and at this point neither exists — the cluster is
#    still `paperclip`. So this is a whole-cluster pg_dumpall plus a tar of the
#    old volume, which scripts/restore.sh cannot read back; docs/upgrading.md
#    ("Rolling back") documents restoring it by hand. --no-role-passwords keeps
#    the roles' password hashes out of a file that lands in ./backups: the
#    passwords are in .env and are re-applied by hand on a restore.
if [[ "$NO_BACKUP" == "0" ]]; then
  SNAP="${BACKUP_DIR:-$ROOT/backups}/pre-0.2-migration-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$SNAP"
  log "snapshotting the cluster and the home volume to $SNAP"
  docker compose exec -T db pg_dumpall --no-role-passwords -U "$ADMIN" > "$SNAP/cluster.sql"
  if docker volume inspect "$OLD_VOL" >/dev/null 2>&1; then
    MSYS_NO_PATHCONV=1 docker run --rm -v "$OLD_VOL:/from:ro" "$TAR_IMAGE" sh -c 'exec tar czf - -C /from .' > "$SNAP/paperclip-home.tgz"
  fi
fi

# 3. .env keys. Compose keeps accepting the old names this release, but the file
#    is the operator's, so rename them once and keep a copy.
changed=0
for pair in PAPERCLIP_PUBLIC_URL:KYOUBE_PUBLIC_URL PAPERCLIP_DEPLOYMENT_EXPOSURE:KYOUBE_DEPLOYMENT_EXPOSURE PAPERCLIP_VERSION:KYOUBE_CORE_VERSION; do
  old="${pair%%:*}"; new="${pair#*:}"
  if grep -q "^${old}=" "$ENV_FILE" && ! grep -q "^${new}=" "$ENV_FILE"; then
    [[ $changed -eq 1 ]] || cp "$ENV_FILE" "$ENV_FILE.bak"
    sed -i.tmp "s/^${old}=/${new}=/" "$ENV_FILE" && rm -f "$ENV_FILE.tmp"
    changed=1
    log "$ENV_FILE: $old -> $new"
  fi
done
if [[ $changed -eq 1 ]]; then log "previous env file kept as $ENV_FILE.bak"; else log "env keys already current"; fi

# 4. Role, then database. `ALTER ROLE … RENAME` clears an MD5 password (the name
#    salts it) and keeps a SCRAM one; re-apply from the db container's own
#    POSTGRES_PASSWORD either way, so the value never passes through this script.
#    The temporary superuser is the resume marker: it exists only between the
#    rename and the password re-apply, so an interrupt anywhere in here is undone
#    by re-running — the first block is skipped once `paperclip` is gone, the
#    second runs as long as the migrator is still around.
if role_exists paperclip paperclip && ! role_exists paperclip kyoubeai; then
  log "renaming role paperclip -> kyoubeai"
  role_exists paperclip kyoube_migrator || psql_q paperclip postgres "CREATE ROLE kyoube_migrator LOGIN SUPERUSER" >/dev/null
  psql_q kyoube_migrator postgres "ALTER ROLE paperclip RENAME TO kyoubeai" >/dev/null
fi
if role_exists kyoubeai kyoubeai && role_exists kyoubeai kyoube_migrator; then
  log "re-applying the kyoubeai password and dropping the temporary superuser"
  docker compose exec -T db sh -c \
    ': "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set in the db container}"; exec psql -U kyoube_migrator -d postgres -q -v ON_ERROR_STOP=1 -v pw="$POSTGRES_PASSWORD" -f -' <<'SQL'
ALTER ROLE kyoubeai PASSWORD :'pw';
SQL
  psql_q kyoubeai postgres "DROP ROLE kyoube_migrator" >/dev/null
fi
ADMIN="$(admin_role)"
if db_exists "$ADMIN" paperclip && ! db_exists "$ADMIN" kyoubeai; then
  log "renaming database paperclip -> kyoubeai"
  psql_q "$ADMIN" postgres "ALTER DATABASE paperclip RENAME TO kyoubeai" >/dev/null
fi

# 5. The 0.2.x image, then the new volume — created by compose itself so it
#    carries compose's labels — then the copy, with the marker the entrypoint
#    and `kyoube doctor` look for.
if grep -q '^KYOUBE_IMAGE=' "$ENV_FILE"; then docker compose pull app; else docker compose build app; fi
docker compose up --no-start app >/dev/null
if docker volume inspect "$OLD_VOL" >/dev/null 2>&1; then
  NEW_COUNT="$(MSYS_NO_PATHCONV=1 docker run --rm -v "$NEW_VOL:/to" "$TAR_IMAGE" sh -c 'ls -A /to | wc -l' | tr -d '\r ')"
  # The marker is written last, so content without it is an interrupted copy.
  NEW_MARKED="$(MSYS_NO_PATHCONV=1 docker run --rm -v "$NEW_VOL:/to" "$TAR_IMAGE" sh -c "test -f /to/$MARKER && echo yes || echo no" | tr -d '\r ')"
  if [[ "$NEW_COUNT" == "0" ]]; then
    log "copying $OLD_VOL -> $NEW_VOL"
    MSYS_NO_PATHCONV=1 docker run --rm -v "$OLD_VOL:/from:ro" -v "$NEW_VOL:/to" "$TAR_IMAGE" \
      sh -c "cp -a /from/. /to/ && touch /to/$MARKER && chown \"\$(stat -c %u:%g /to)\" /to/$MARKER"
  elif [[ "$NEW_MARKED" == "yes" ]]; then
    log "$NEW_VOL already migrated — not copying"
  else
    # Two ways to get here, and the second is the common one: `git pull &&
    # docker compose up -d --build` before running this script starts the 0.2.x
    # app, which creates and populates <project>_kyoubeai-home while crash-
    # looping on `role "kyoubeai" does not exist`. A bare `docker volume rm`
    # then fails with "volume is in use" because that container still exists,
    # so the remedy has to remove the container first.
    echo "migrate: $NEW_VOL has content but no $MARKER — either an earlier copy was interrupted, or the 0.2.x stack was started before this migration (\`docker compose up\` after \`git pull\` creates and fills this volume)." >&2
    echo "migrate: inspect it if you are unsure, then discard it and re-run:" >&2
    echo "migrate:   docker compose rm -sf app && docker volume rm $NEW_VOL" >&2
    exit 1
  fi
  # The core's instance config is ours to move; it is normally absent because
  # compose configures the core through the environment.
  MSYS_NO_PATHCONV=1 docker run --rm -v "$NEW_VOL:/to" "$TAR_IMAGE" \
    sh -c 'f=/to/instances/default/config.json; if [ -f "$f" ]; then sed -i "s#/paperclip/#/kyoubeai/#g" "$f"; fi'
else
  log "no $OLD_VOL volume — nothing to copy"
fi

# 6. Start, wait, report.
docker compose up -d
APP_CID="$(docker compose ps -aq app | tr -d '\r' | head -1)"
log "waiting for the app to become healthy"
for i in $(seq 1 180); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$APP_CID" | tr -d '\r')" == "healthy" ]] && break
  sleep 2
  if [[ $i -eq 180 ]]; then echo "migrate: the app did not become healthy — docker compose logs app" >&2; exit 1; fi
done
docker compose exec -T app kyoube doctor || true
n="$(count_legacy_paths)"
log "done. $n stored path(s) still start with /paperclip/; the /paperclip compatibility link stays until you delete /kyoubeai/$MARKER (re-run with --check to see when that is safe)"
log "when satisfied, remove the old volume: docker volume rm $OLD_VOL"
