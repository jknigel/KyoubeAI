# shellcheck shell=bash
# Helpers shared by install.sh and update.sh (and the checksum helpers by
# scripts/backup.sh and scripts/restore.sh). Sourced, never run. Works with
# the bash 3.2 macOS ships: no associative arrays, no ${x,,}, no mapfile, and
# no `sed -i` (GNU and BSD sed disagree on its flags).

# shellcheck disable=SC2034  # read by install.sh and update.sh, which source this file
KYOUBE_IMAGE_DEFAULT="ghcr.io/jknigel/kyoubeai"
# The first release that ships install.sh and update.sh; older tags are never
# installed or updated to by them.
KYOUBE_MIN_RELEASE="1.1.0"
# Which commit the source image (kyoubeai:dev) was last built from, and its image id; see record_source_build.
KYOUBE_BUILT=".kyoube/built-commit"
YES="${YES:-0}"

say()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# confirm QUESTION: 0 for yes. YES=1 (--yes, or no terminal) answers yes.
confirm() {
  [ "$YES" = 1 ] && return 0
  local answer
  printf '%s [Y/n] ' "$1"
  IFS= read -r answer </dev/tty || return 1
  case "$answer" in ''|y|Y|yes|Yes|YES) return 0 ;; *) return 1 ;; esac
}

# version_ge A B: true when dotted version A >= B (numeric fields; missing ones are 0).
version_ge() {
  local a="$1" b="$2" x y
  while [ -n "$a" ] || [ -n "$b" ]; do
    x="${a%%.*}"; y="${b%%.*}"
    if [ "$a" = "${a#*.}" ]; then a=""; else a="${a#*.}"; fi
    if [ "$b" = "${b#*.}" ]; then b=""; else b="${b#*.}"; fi
    x="${x:-0}"; y="${y:-0}"
    if [ "$((10#$x))" -gt "$((10#$y))" ]; then return 0; fi
    if [ "$((10#$x))" -lt "$((10#$y))" ]; then return 1; fi
  done
  return 0
}

# is_release_version X: three dot-separated numbers, nothing else.
is_release_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }

# latest_release [MIN]: reads tag names on stdin; prints the newest vX.Y.Z >= MIN (never a pre-release), or nothing.
latest_release() {
  local min="${1:-$KYOUBE_MIN_RELEASE}" best="" tag v
  while IFS= read -r tag || [ -n "$tag" ]; do
    tag="${tag%$'\r'}"
    case "$tag" in v[0-9]*) ;; *) continue ;; esac
    v="${tag#v}"
    case "$v" in *[!0-9.]*|*.*.*.*|*..*|.*|*.) continue ;; *.*.*) ;; *) continue ;; esac
    version_ge "$v" "$min" || continue
    if [ -z "$best" ] || ! version_ge "${best#v}" "$v"; then best="$tag"; fi
  done
  if [ -n "$best" ]; then printf '%s\n' "$best"; fi
  return 0
}

# Every helper below reads `KEY=value` and `export KEY=value` alike (compose accepts both in .env).

# env_get FILE KEY: the value of the last uncommented KEY= line (CR stripped); empty when absent.
env_get() {
  [ -f "$1" ] || return 0
  KEY="$2" awk '{ sub(/\r$/, ""); line = $0; sub(/^export[ \t]+/, "", line) } index(line, ENVIRON["KEY"] "=") == 1 { v = substr(line, length(ENVIRON["KEY"]) + 2) } END { printf "%s", v }' "$1"
}

# env_set FILE KEY VALUE: set the first uncommented KEY= line (keeping an `export ` in front of it) and drop later
# ones, or append. Comment lines are left alone. Line endings become LF; the file becomes mode 600 (it holds secrets).
# On failure (for example FILE is missing) it returns 1 and leaves no temp file behind.
env_set() {
  local file="$1" tmp
  tmp="$(mktemp "${file}.XXXXXX")" || return 1
  if KEY="$2" VALUE="$3" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; done = 0 }
    { sub(/\r$/, ""); line = $0; pre = "" }
    match(line, /^export[ \t]+/) { pre = substr(line, 1, RLENGTH); line = substr(line, RLENGTH + 1) }
    index(line, k "=") == 1 { if (!done) { print pre k "=" v; done = 1 } next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" > "$tmp" && mv -f "$tmp" "$file"; then
    return 0
  fi
  rm -f "$tmp"
  return 1
}

# env_keys FILE: every key the file defines, commented ("# KEY=") or not, sorted, one per line.
env_keys() {
  awk '{ sub(/\r$/, "") } match($0, /^[ \t]*#?[ \t]*(export[ \t]+)?[A-Z][A-Z0-9_]*=/) { s = substr($0, 1, RLENGTH - 1); sub(/^[ \t]*#?[ \t]*/, "", s); sub(/^export[ \t]+/, "", s); print s }' "$1" | LC_ALL=C sort -u
}

# env_merge EXAMPLE TARGET LABEL: append to TARGET every key EXAMPLE defines (commented or not)
# that TARGET lacks in any form, with its paragraph's comment lines (once per paragraph), under
# "# Added by update to LABEL". Prints the added keys. Never changes an existing line.
env_merge() {
  local example="$1" target="$2" label="$3" have block
  have="$(env_keys "$target")"
  block="$(HAVE="$have" awk '
    BEGIN { n = split(ENVIRON["HAVE"], list, "\n"); for (i = 1; i <= n; i++) have[list[i]] = 1 }
    { sub(/\r$/, "") }
    /^[ \t]*$/ { para = ""; shown = 0; next }
    match($0, /^[ \t]*#?[ \t]*[A-Z][A-Z0-9_]*=/) {
      k = substr($0, 1, RLENGTH - 1); sub(/^[ \t]*#?[ \t]*/, "", k)
      if (!(k in have) && !(k in done)) {
        if (!shown && para != "") { printf "%s", para; shown = 1 }
        print; done[k] = 1
      }
      next
    }
    /^[ \t]*#/ { para = para $0 "\n"; next }
  ' "$example")"
  [ -n "$block" ] || return 0
  printf '\n# Added by update to %s\n%s\n' "$label" "$block" >> "$target"
  printf '%s\n' "$block" | awk 'match($0, /^[ \t]*#?[ \t]*[A-Z][A-Z0-9_]*=/) { s = substr($0, 1, RLENGTH - 1); sub(/^[ \t]*#?[ \t]*/, "", s); print s }'
}

# env_unused EXAMPLE TARGET: keys TARGET sets (uncommented) that EXAMPLE never mentions.
env_unused() {
  local known
  known="$(env_keys "$1")"
  awk '{ sub(/\r$/, ""); sub(/^export[ \t]+/, "") } match($0, /^[A-Z][A-Z0-9_]*=/) { print substr($0, 1, RLENGTH - 1) }' "$2" | LC_ALL=C sort -u \
    | KNOWN="$known" awk 'BEGIN { n = split(ENVIRON["KNOWN"], l, "\n"); for (i = 1; i <= n; i++) k[l[i]] = 1 } !($0 in k)'
}

# normalize_project_name NAME: what compose makes of a folder name.
normalize_project_name() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-' | sed 's/^[_-]*//'
}

# resolve_project_name DIR: the compose project an install in DIR uses today, as `docker compose config` resolves it
# (its output starts with `name: <project>`): COMPOSE_PROJECT_NAME from the shell or .env, then a top-level `name:` in
# a compose or override file, then the folder name. Without a docker that answers, the same order without `name:`.
resolve_project_name() {
  local dir="$1" name
  name="$(cd "$dir" && docker compose config 2>/dev/null </dev/null | tr -d '\r' | awk 'NR == 1 && sub(/^name:[ \t]*/, "") { print }' || true)"
  [ -n "$name" ] || name="${COMPOSE_PROJECT_NAME:-}"
  [ -n "$name" ] || name="$(env_get "$dir/.env" COMPOSE_PROJECT_NAME)"
  [ -n "$name" ] || name="$(normalize_project_name "$(basename "$dir")")"
  printf '%s\n' "$name"
}

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; printf '\n'; fi
}

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# url_set_port URL PORT: URL with its port replaced or added.
url_set_port() {
  local scheme="${1%%://*}" rest="${1#*://}" hostport path
  hostport="${rest%%/*}"; path="${rest#"$hostport"}"
  printf '%s://%s:%s%s\n' "$scheme" "${hostport%%:*}" "$2" "$path"
}
url_origin() { local rest="${1#*://}"; printf '%s://%s\n' "${1%%://*}" "${rest%%/*}"; }
is_loopback_url() {
  case "$1" in http://localhost|http://localhost[:/]*|http://127.0.0.1|http://127.0.0.1[:/]*) return 0 ;; *) return 1 ;; esac
}

# split_image_ref REF: "repo tag", splitting at the last ':' only when what follows has no '/'.
split_image_ref() {
  local ref="$1" tag="${1##*:}"
  case "$tag" in */*|"$ref") printf '%s latest\n' "$ref" ;; *) printf '%s %s\n' "${ref%:*}" "$tag" ;; esac
}

docker_preflight() {
  command -v git >/dev/null 2>&1 || die "git is not installed"
  command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker Desktop (macOS, Windows) or Docker Engine 24+ (Linux): https://docs.docker.com/engine/install/"
  docker info >/dev/null 2>&1 || die "Docker is installed but not reachable. Start Docker Desktop, or on Linux start the daemon (sudo systemctl start docker) and add your user to the docker group (sudo usermod -aG docker \$USER, then log in again)."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 (the 'docker compose' plugin) is missing: https://docs.docker.com/compose/install/"
  local engine arch mem
  engine="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 0)"
  version_ge "${engine%%[-+]*}" 24.0.0 || die "Docker Engine $engine is too old; KyoubeAI needs 24 or later"
  arch="$(docker info --format '{{.Architecture}}' 2>/dev/null || true)"
  case "$arch" in x86_64|amd64|aarch64|arm64) ;; *) die "KyoubeAI's images are built for amd64 and arm64, not '$arch'" ;; esac
  mem="$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)"
  [ "${mem:-0}" -ge 3900000000 ] 2>/dev/null || warn "Docker has less than 4 GB of memory; KyoubeAI may run slowly or be stopped under load"
}

# record_source_build IMAGE_REF: after a successful `docker compose build`, note in .kyoube/built-commit the commit
# this checkout is on and the id of the image just built, so `update.sh --edge` can tell later whether the image is
# behind the checkout. Best effort: a missing record only means update.sh compares times instead.
record_source_build() {
  local id
  id="$(docker image inspect -f '{{.Id}}' "$1" 2>/dev/null </dev/null || true)"
  { mkdir -p .kyoube && : > "$KYOUBE_BUILT"; } 2>/dev/null || return 0
  env_set "$KYOUBE_BUILT" commit "$(git rev-parse HEAD 2>/dev/null || true)" || true
  env_set "$KYOUBE_BUILT" image "$id" || true
}

# sha256_sums FILE...: `sha256sum FILE...`, or `shasum -a 256` where there is no sha256sum (stock macOS). Both print
# the same "<hash>  <name>" lines, and each tool checks the other's.
sha256_sums() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

# sha256_check DIR: verify DIR/SHA256SUMS (relative names, as scripts/backup.sh writes it) against the files in DIR.
sha256_check() {
  (cd "$1" && if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS; else shasum -a 256 -c SHA256SUMS; fi)
}

# dc_exec ARGS...: `docker compose exec`, with a TTY only when this script has one.
dc_exec() {
  if [ -t 0 ] && [ -t 1 ]; then docker compose exec "$@"; else docker compose exec -T "$@"; fi
}

# health_field NAME: one string field of the running app's /api/health, read from inside the container.
health_field() {
  docker compose exec -T app curl -fsS http://127.0.0.1:3100/api/health 2>/dev/null \
    | sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" | head -1
}
