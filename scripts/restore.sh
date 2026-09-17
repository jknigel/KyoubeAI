#!/usr/bin/env bash
# Restores a backup directory produced by scripts/backup.sh.
#
#   bash scripts/restore.sh backups/20260906T101500Z
#
# STOPS the app for the duration and replaces both databases and the /kyoubeai
# home volume wholesale. Every docker command is a plain `docker compose`, so
# COMPOSE_PROJECT_NAME and COMPOSE_ENV_FILES from the environment select which
# stack is overwritten (see docs/operations.md).
#
# The order is load-bearing:
#   1. verify checksums, stop the app
#   2. roles first — ownership cannot be reassigned to roles that do not exist —
#      then re-apply the `kyoube` password from the db container's environment,
#      then assert every role the backup declares is really there
#   3. kyoubeai database, --no-owner (everything in it belongs to the superuser)
#   4. kyoube database *with* owners, so each c_<hex> schema returns to its
#      kyoube_c_<hex> role, then hand the database itself back to `kyoube`
#   5. re-apply the database ACLs docker/postgres-init/01-kyoube.sh sets, which
#      live outside both per-database dumps
#   6. home volume, then start the app
#
# Each database is restored into a temporary database and only swapped in once
# pg_restore has succeeded, so a failed restore leaves that database untouched.
# The swap is per database, not across both: if the kyoube restore fails after
# kyoubeai has been swapped in, re-run this script with the same directory.
set -euo pipefail

SRC="${1:?usage: restore.sh <backup-dir>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$(cd "$SRC" && pwd)"
TAR_IMAGE="${KYOUBE_BACKUP_IMAGE:-alpine:3.20}"
cd "$ROOT"

# Backups from 0.1.x carry the core dump and home archive under their old names;
# both restore into the 0.2.x layout, and a legacy backup also gets the
# migration marker so the entrypoint keeps /paperclip resolvable for the
# absolute paths that database still holds (see docs/upgrading.md).
CORE_DUMP=kyoubeai.dump; [[ -f "$SRC/$CORE_DUMP" ]] || CORE_DUMP=paperclip.dump
HOME_TGZ=kyoubeai-home.tgz; [[ -f "$SRC/$HOME_TGZ" ]] || HOME_TGZ=paperclip-home.tgz
LEGACY_BACKUP=0
[[ "$CORE_DUMP" == paperclip.dump || "$HOME_TGZ" == paperclip-home.tgz ]] && LEGACY_BACKUP=1
for file in "$CORE_DUMP" kyoube.dump roles.sql "$HOME_TGZ" SHA256SUMS; do
  if [[ ! -f "$SRC/$file" ]]; then
    echo "restore: $SRC/$file is missing — not a backup directory from scripts/backup.sh" >&2
    exit 1
  fi
done

# `docker compose ps -q` lists running containers only; `app` is stopped below.
container_id() { # service -> container id
  local id
  id="$(docker compose ps -aq "$1" | tr -d '\r' | head -1)"
  if [[ -z "$id" ]]; then
    echo "restore: no '$1' container in this compose project — bring the stack up first" >&2
    return 1
  fi
  printf '%s\n' "$id"
}

# Admin SQL against the maintenance database, as the compose superuser over the
# container's trusted unix socket. Output is dropped; errors are fatal.
psql_admin() { docker compose exec -T db psql -U kyoubeai -d postgres -v ON_ERROR_STOP=1 -Atqc "$1" >/dev/null </dev/null; }

restore_db() { # database dump-file [extra pg_restore flags...]
  local db="$1" dump="$2"; shift 2
  echo "restore: rebuilding the $db database from $dump"
  # WITH (FORCE) (PostgreSQL 13+) terminates any remaining backend and drops the
  # database in one statement. A separate pg_terminate_backend followed by DROP
  # leaves a window in which something can reconnect between the two and turn
  # the drop into "database is being accessed by other users".
  psql_admin "DROP DATABASE IF EXISTS ${db}_restore_tmp WITH (FORCE)"
  psql_admin "CREATE DATABASE ${db}_restore_tmp"
  docker compose exec -T db pg_restore -U kyoubeai -d "${db}_restore_tmp" --exit-on-error "$@" < "$SRC/$dump"
  psql_admin "DROP DATABASE IF EXISTS ${db} WITH (FORCE)"
  psql_admin "ALTER DATABASE ${db}_restore_tmp RENAME TO ${db}"
}

if [[ -z "$(docker compose ps -q db | tr -d '\r')" ]]; then
  echo "restore: the 'db' service is not running; start it before restoring" >&2
  exit 1
fi
APP_CID="$(container_id app)"
PROJECT="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$APP_CID" | tr -d '\r')"
docker image inspect "$TAR_IMAGE" >/dev/null 2>&1 || docker pull "$TAR_IMAGE" >&2

# 1. Verify, then stop the app so nothing writes while the state is replaced.
echo "restore: verifying $SRC"
(cd "$SRC" && sha256sum -c SHA256SUMS)
echo "restore: overwriting project '$PROJECT' from $SRC"
docker compose stop app

# 2. Roles before databases. A role that already exists (the `kyoube` login role
#    on a same-cluster restore, or on a fresh cluster where postgres-init has
#    just created it) reports "already exists" and is skipped, which is why this
#    one file runs with ON_ERROR_STOP=0.
echo "restore: restoring the kyoube cluster roles"
docker compose exec -T db psql -U kyoubeai -d postgres -v ON_ERROR_STOP=0 -f - < "$SRC/roles.sql"
# roles.sql carries no password (backup.sh dumps with --no-role-passwords), so
# re-apply the one this deployment is configured with. The value is read inside
# the container from the db service's own KYOUBE_DB_PASSWORD and passed as a
# psql variable, exactly as docker/postgres-init/01-kyoube.sh does, so it never
# reaches the host's process list or this script's output.
echo "restore: re-applying the kyoube role password from the db container environment"
docker compose exec -T db sh -c \
  ': "${KYOUBE_DB_PASSWORD:?KYOUBE_DB_PASSWORD is not set in the db container}"; exec psql -U kyoubeai -d postgres -q -v ON_ERROR_STOP=1 -v pw="$KYOUBE_DB_PASSWORD" -f -' <<'SQL'
ALTER ROLE kyoube PASSWORD :'pw';
SQL

# 2b. Prove the roles landed, while both databases are still untouched.
#     roles.sql runs with ON_ERROR_STOP=0, so psql exits 0 even if every one of
#     its statements failed; and a backup whose filter matched nothing is a file
#     with only the three header comments in it. Either way the failure would
#     otherwise surface much later and much more obscurely, as company schemas
#     restored under the kyoubeai superuser.
#
#     Checking only for `kyoube` would not be enough: postgres-init creates that
#     role on any fresh volume, so it is present whether or not roles.sql did
#     anything. Every role the file declares has to exist -- the kyoube_c_<hex>
#     company roles are the ones that carry schema ownership.
EXPECTED_ROLES="$(awk '/^CREATE ROLE "?[a-z0-9_]+"?;$/ { name = $3; gsub(/[";]/, "", name); print name }' "$SRC/roles.sql")"
if [[ -z "$EXPECTED_ROLES" ]]; then
  echo "restore: $SRC/roles.sql declares no roles — it was written before backup.sh gated on the filter, or the filter matched nothing." >&2
  echo "restore: restoring it would hand every company schema to the kyoubeai superuser; take a fresh backup instead." >&2
  exit 1
fi
# Passed as one psql variable rather than generated into the statement: psql
# quotes it as a literal, so nothing from the file is ever parsed as SQL. It is
# set outside the DO block on purpose -- psql does not interpolate variables
# inside a dollar-quoted string.
docker compose exec -T db psql -U kyoubeai -d postgres -q -v ON_ERROR_STOP=1 \
  -v roles="$(printf '%s' "$EXPECTED_ROLES" | tr '\n' ',')" -f - >/dev/null <<'SQL'
SELECT set_config('kyoube.expected_roles', :'roles', false);
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(name, ', ') INTO missing
    FROM unnest(string_to_array(current_setting('kyoube.expected_roles'), ',')) AS t(name)
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t.name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'roles.sql did not apply: missing role(s) %', missing;
  END IF;
END
$$;
SQL
echo "restore: $(printf '%s\n' "$EXPECTED_ROLES" | wc -l | tr -d ' ') cluster role(s) from roles.sql are present"

# 3. The core database: every object in it belongs to the `kyoubeai`
#    superuser, so --no-owner restores it unchanged and needs no roles.
restore_db kyoubeai "$CORE_DUMP" --no-owner

# 4. The Kyoube database *with* its owners: the superuser can hand each
#    c_<hex> schema and its tables back to the kyoube_c_<hex> role recreated in
#    step 2. Without this the plugin's `SET ROLE` DDL fails after a restore.
restore_db kyoube kyoube.dump
psql_admin "ALTER DATABASE kyoube OWNER TO kyoube"

# 5. CREATE DATABASE grants CONNECT to PUBLIC; docker/postgres-init/01-kyoube.sh
#    revokes it and that ACL is not part of either dump. Re-apply it here.
echo "restore: re-applying the database connect ACLs"
psql_admin "REVOKE CONNECT ON DATABASE kyoubeai FROM PUBLIC"
psql_admin "REVOKE CONNECT ON DATABASE kyoube FROM PUBLIC"

# 6. The home volume: board key, harness credentials, workspaces. Streamed on
#    stdin rather than bind-mounted so the host path needs no sharing with the
#    daemon and MSYS path conversion cannot mangle it on Git Bash.
echo "restore: replacing the kyoubeai-home volume"
docker run --rm -i --volumes-from "$APP_CID" "$TAR_IMAGE" \
  sh -c 'rm -rf /kyoubeai/..?* /kyoubeai/.[!.]* /kyoubeai/* 2>/dev/null; exec tar xzf - -C /kyoubeai' \
  < "$SRC/$HOME_TGZ"
if [[ "$LEGACY_BACKUP" == "1" ]]; then
  echo "restore: 0.1.x backup — leaving the migration marker so /paperclip stays resolvable"
  docker run --rm --volumes-from "$APP_CID" "$TAR_IMAGE" \
    sh -c 'touch /kyoubeai/.migrated-from-paperclip-home && chown "$(stat -c %u:%g /kyoubeai)" /kyoubeai/.migrated-from-paperclip-home'
fi

docker compose start app
echo "restored from $SRC"
