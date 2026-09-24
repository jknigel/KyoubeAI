#!/usr/bin/env bash
# KyoubeAI backup. Writes ${BACKUP_DIR:-<repo>/backups}/<UTC stamp>/ holding:
#
#   kyoubeai.dump      pg_dump -Fc of the core database
#   kyoube.dump        pg_dump -Fc of the Kyoube organisation database
#   roles.sql          the cluster-level `kyoube` and `kyoube_c_*` roles
#   kyoubeai-home.tgz  the /kyoubeai home volume (board key, harness creds)
#   SHA256SUMS         checksums of the four files, by relative name
#
# Every docker command here is a plain `docker compose`, so COMPOSE_PROJECT_NAME
# and COMPOSE_ENV_FILES from the environment select which stack is backed up
# (see docs/operations.md). Nothing hard-codes a project name or an env file.
#
# The app keeps running: the dumps are transactionally consistent on their own,
# and the home volume is archived live. Stop the app first if you need the home
# volume to be point-in-time consistent with the databases.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR:-$ROOT/backups}/$STAMP"
# Any image with a POSIX tar and gzip works; it only ever sees /kyoubeai.
TAR_IMAGE="${KYOUBE_BACKUP_IMAGE:-alpine:3.20}"
cd "$ROOT"

# `docker compose ps -q` lists running containers only, so -a is required for a
# service that may be stopped (restore.sh stops `app` before it calls this).
container_id() { # service -> container id
  local id
  id="$(docker compose ps -aq "$1" | tr -d '\r' | head -1)"
  if [[ -z "$id" ]]; then
    echo "backup: no '$1' container in this compose project — is the stack created?" >&2
    return 1
  fi
  printf '%s\n' "$id"
}

if [[ -z "$(docker compose ps -q db | tr -d '\r')" ]]; then
  echo "backup: the 'db' service is not running; start it before backing up" >&2
  exit 1
fi
APP_CID="$(container_id app)"
PROJECT="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$APP_CID" | tr -d '\r')"
docker image inspect "$TAR_IMAGE" >/dev/null 2>&1 || docker pull "$TAR_IMAGE" >&2

mkdir -p "$OUT"
echo "backup: project '$PROJECT' -> $OUT"

echo "backup: dumping the core (kyoubeai) database"
docker compose exec -T db pg_dump -U kyoubeai -Fc kyoubeai > "$OUT/kyoubeai.dump"

echo "backup: dumping the kyoube database"
docker compose exec -T db pg_dump -U kyoubeai -Fc kyoube > "$OUT/kyoube.dump"

# Roles are cluster-level state and live outside both per-database dumps: the
# `kyoube` login role, plus one NOLOGIN `kyoube_c_<hex>` role per company that
# owns that company's `c_<hex>` schema. Restoring onto a fresh cluster without
# them cannot reassign ownership, and every GRANT in kyoube.dump fails.
#
# pg_dumpall --roles-only emits one statement per line, so a line filter is
# enough. It keeps exactly three shapes and drops everything else (the
# `kyoubeai` superuser, the built-in pg_* roles, psql's \restrict wrapper,
# comments, SET lines):
#
#   CREATE ROLE <kyoube|kyoube_c_…>;
#   ALTER ROLE  <kyoube|kyoube_c_…> WITH …;
#   GRANT <kyoube|kyoube_c_…> TO <kyoube|kyoube_c_…> … [GRANTED BY …];
#
# --no-role-passwords keeps the `kyoube` password hash out of the backup;
# restore.sh re-applies the password from the db container's own environment.
echo "backup: dumping the kyoube cluster roles"
{
  echo "-- KyoubeAI cluster roles: the kyoube login role and one kyoube_c_<hex> role per company."
  echo "-- Filtered from pg_dumpall --roles-only --no-role-passwords; no password is stored here."
  echo "-- Applied by scripts/restore.sh with ON_ERROR_STOP=0 before the database dumps."
  docker compose exec -T db pg_dumpall -U kyoubeai --roles-only --no-role-passwords | awk '
    { sub(/\r$/, "") }
    /^(CREATE|ALTER) ROLE "?(kyoube|kyoube_c_[0-9a-f]+)"?[ ;]/ { print; next }
    /^GRANT "?(kyoube|kyoube_c_[0-9a-f]+)"? TO "?(kyoube|kyoube_c_[0-9a-f]+)"?[ ;]/ { print; next }
  '
} > "$OUT/roles.sql"

# The three header lines above mean roles.sql is never zero-length, so the
# non-empty gate further down cannot speak for it. Assert the filter actually
# matched something instead: `kyoube` exists in every working deployment, so its
# absence means pg_dumpall's output changed shape under us — which does happen
# on the floating postgres:17-alpine tag, where the \restrict/\unrestrict
# wrapper this filter already skips arrived in a patch bump — and the company
# roles ruling P4-R6 depends on would be silently missing from the backup.
grep -qE '^CREATE ROLE "?kyoube"?;' "$OUT/roles.sql" || {
  echo "backup: roles.sql carries no kyoube role — the pg_dumpall filter did not match" >&2
  exit 1
}

# Streamed rather than bind-mounted: `docker run -v "$OUT:/backup"` would need
# the host path to be shareable with the daemon and gets mangled by MSYS path
# conversion on Git Bash. stdout works the same everywhere. The tar command goes
# through `sh -c` for the same reason: a bare `-C /kyoubeai` argument is a
# lone POSIX path, which MSYS rewrites to a Windows path before docker sees it.
echo "backup: archiving the kyoubeai-home volume"
docker run --rm --volumes-from "$APP_CID" "$TAR_IMAGE" \
  sh -c 'exec tar czf - -C /kyoubeai .' > "$OUT/kyoubeai-home.tgz"

for file in kyoubeai.dump kyoube.dump roles.sql kyoubeai-home.tgz; do
  if [[ ! -s "$OUT/$file" ]]; then
    echo "backup: $OUT/$file is empty — the backup is not usable" >&2
    exit 1
  fi
done

# Relative names so `sha256sum -c` still works after the directory is copied
# off-site. The four payload files are named explicitly rather than globbed, so
# the manifest can never silently gain or lose an entry. SHA256SUMS itself is
# not one of them: a manifest cannot vouch for its own contents.
(cd "$OUT" && sha256sum kyoubeai.dump kyoube.dump roles.sql kyoubeai-home.tgz > SHA256SUMS)

echo "backup written to $OUT"
