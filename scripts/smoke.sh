#!/usr/bin/env bash
# End-to-end smoke test: builds the image, starts the stack on port 3199,
# creates the first admin, installs the Kyoube plugins through `kyoube`, and
# creates one agent per harness. Requires docker compose v2, curl, jq.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="${SMOKE_PROJECT:-kyoube-smoke}"
ENV_FILE="$ROOT/scripts/smoke.env"
BASE_URL="http://localhost:3199"
KEEP="${KEEP:-0}"
TMP="$(mktemp -d)"
COOKIES="$TMP/cookies.txt"

compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$ROOT/docker-compose.yml" "$@"; }

cleanup() {
  local code=$?
  if [[ $code -ne 0 ]]; then
    echo "--- smoke failed (exit $code); last app logs ---" >&2
    compose logs --tail 200 app >&2 || true
  fi
  if [[ "$KEEP" != "1" ]]; then compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
  # The migration rehearsal creates the 0.1.x home volume outside compose, so
  # `down -v` (which only knows the volumes the compose file declares) leaves it.
  if [[ "$KEEP" != "1" ]]; then docker volume rm -f "${PROJECT}_paperclip-home" >/dev/null 2>&1 || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

post_json() { # url body -> prints body, stores status in HTTP_STATUS
  local url="$1" body="$2"
  HTTP_STATUS="$(curl -sS -o "$TMP/resp.json" -w '%{http_code}' -c "$COOKIES" -b "$COOKIES" \
    -H 'Content-Type: application/json' -H "Origin: $BASE_URL" -X POST "$url" --data "$body")"
  cat "$TMP/resp.json"
}

echo "==> build + up"
compose up -d --build

echo "==> wait for health"
for i in $(seq 1 180); do
  if curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
  if [[ $i -eq 180 ]]; then echo "health never came up" >&2; exit 1; fi
done
curl -fsS "$BASE_URL/api/health" | jq -e '.deploymentMode == "authenticated"' >/dev/null

echo "==> the served UI is branded"
# The rebrand ran at image build (docker/rebrand); this proves the server serves
# its output: title, PWA manifest, the renamed loading icon, and no stale name.
curl -fsS "$BASE_URL/" >"$TMP/index.html"
grep -q '<title>KyoubeAI</title>' "$TMP/index.html" || { echo "index.html title is not KyoubeAI:" >&2; grep -o '<title>[^<]*</title>' "$TMP/index.html" >&2; exit 1; }
curl -fsS "$BASE_URL/site.webmanifest" | jq -e '.name == "KyoubeAI" and .short_name == "KyoubeAI"' >/dev/null \
  || { echo "site.webmanifest is not branded" >&2; exit 1; }
# The content type, not just the status: the SPA catch-all below answers 200 for
# any path, so a bare status check would pass with the icon deleted.
NEW_ICON="$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "$BASE_URL/kyoubeai-thinking.svg")"
[[ "$NEW_ICON" == "200 image/svg+xml"* ]] || { echo "/kyoubeai-thinking.svg is not served as an SVG ($NEW_ICON)" >&2; exit 1; }
# The old name cannot 404: upstream's SPA catch-all answers every unmatched path
# with index.html (200, text/html), so "gone" means "no longer an SVG".
OLD_ICON_TYPE="$(curl -sS -o /dev/null -w '%{content_type}' "$BASE_URL/paperclip-thinking.svg")"
[[ "$OLD_ICON_TYPE" != image/svg+xml* ]] || { echo "/paperclip-thinking.svg is still served ($OLD_ICON_TYPE)" >&2; exit 1; }
MAIN_JS="$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' "$TMP/index.html" | head -1)"
[[ "$MAIN_JS" =~ -[0-9a-f]{8}\.js$ ]] || { echo "the main bundle was not re-hashed: $MAIN_JS" >&2; exit 1; }
curl -fsS "$BASE_URL$MAIN_JS" >"$TMP/main.js"
grep -q 'Welcome to KyoubeAI' "$TMP/main.js" || { echo "the main bundle does not say 'Welcome to KyoubeAI'" >&2; exit 1; }
! grep -qE '(^|[^A-Za-z0-9_$-])Paperclip([^A-Za-z0-9_$]|$)' "$TMP/main.js" \
  || { echo "the main bundle still contains a display-text Paperclip:" >&2; grep -oE '.{30}([^A-Za-z0-9_$-])Paperclip([^A-Za-z0-9_$]).{30}' "$TMP/main.js" | head -5 >&2; exit 1; }
# Exit 2 means "no Chrome": a real skip, not a pass. It fails the smoke unless
# the operator opts out, so the one check that sees the rendered DOM cannot go
# quiet on a CI runner whose Chrome disappeared.
BRAND_LIVE_RC=0
node "$ROOT/scripts/brand-live-check.mjs" "$BASE_URL" || BRAND_LIVE_RC=$?
if [[ "$BRAND_LIVE_RC" == "2" ]]; then
  [[ "${KYOUBE_ALLOW_NO_CHROME:-0}" == "1" ]]     || { echo "brand-live-check skipped for want of Chrome; install Chrome, set CHROME_PATH, or re-run with KYOUBE_ALLOW_NO_CHROME=1" >&2; exit 1; }
  echo "    brand-live-check SKIPPED (KYOUBE_ALLOW_NO_CHROME=1)"
elif [[ "$BRAND_LIVE_RC" != "0" ]]; then
  exit "$BRAND_LIVE_RC"
fi
echo "    title, manifest, loading icon, bundle text and the sign-in page are branded"

echo "==> the served UI carries the Studio theme"
# docker/theme ran at image build before the rebrand: the stylesheet is linked
# after the core's under a re-hashed name, the boot flag is inlined, the fonts
# are served, and the display-text renames are in the bundle.
THEME_CSS="$(grep -oE '/assets/kyoube-theme-[0-9a-f]{8}\.css' "$TMP/index.html" | head -1)"
[[ -n "$THEME_CSS" ]] || { echo "index.html does not link a re-hashed kyoube-theme stylesheet" >&2; exit 1; }
CORE_CSS_AT="$(grep -bo '/assets/index-[A-Za-z0-9_-]*\.css' "$TMP/index.html" | head -1 | cut -d: -f1)"
THEME_CSS_AT="$(grep -bo "$THEME_CSS" "$TMP/index.html" | head -1 | cut -d: -f1)"
(( THEME_CSS_AT > CORE_CSS_AT )) || { echo "the theme stylesheet is not linked after the core's" >&2; exit 1; }
[[ "$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "$BASE_URL$THEME_CSS")" == "200 text/css"* ]] || { echo "$THEME_CSS is not served as CSS" >&2; exit 1; }
grep -q 'data-kyoube-shell' "$TMP/index.html" || { echo "index.html lacks the Studio boot flag" >&2; exit 1; }
grep -q 'const fallback = "dark";' "$TMP/index.html" || { echo "index.html does not default to the dark theme" >&2; exit 1; }
[[ "$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "$BASE_URL/fonts/kyoube/InstrumentSerif-Regular-latin.woff2")" == "200 font/woff2"* ]] || { echo "the Instrument Serif font is not served" >&2; exit 1; }
grep -q 'to:"/dashboard",label:"Home"' "$TMP/main.js" || { echo "the sidebar does not call the dashboard Home" >&2; exit 1; }
grep -q 'label:"Connected apps"' "$TMP/main.js" || { echo "the core's Apps area was not renamed Connections" >&2; exit 1; }
echo "    $THEME_CSS is linked after the core stylesheet; fonts, dark default and renames are in place"

echo "==> home and database names"
APP_HOME="$(compose exec -T app sh -c 'echo "$HOME:$PAPERCLIP_HOME:$HERMES_HOME"; getent passwd node | cut -d: -f6; test -e /paperclip && echo LEGACY_PATH_PRESENT || echo no-legacy-path' | tr -d '\r')"
[[ "$APP_HOME" == $'/kyoubeai:/kyoubeai:/kyoubeai/.hermes\n/kyoubeai\nno-legacy-path' ]] \
  || { echo "unexpected home layout in app:" >&2; echo "$APP_HOME" >&2; exit 1; }
DBS="$(compose exec -T db psql -U kyoubeai -d postgres -Atc 'select datname from pg_database order by 1' | tr -d '\r')"
grep -qx kyoubeai <<<"$DBS" || { echo "no kyoubeai database: $DBS" >&2; exit 1; }
! grep -qx paperclip <<<"$DBS" || { echo "a paperclip database still exists: $DBS" >&2; exit 1; }
docker volume ls --format '{{.Name}}' | grep -qx "${PROJECT}_kyoubeai-home" || { echo "volume ${PROJECT}_kyoubeai-home missing" >&2; exit 1; }
echo "    HOME=/kyoubeai, database kyoubeai, volume ${PROJECT}_kyoubeai-home"

echo "==> sign up first admin and claim the instance"
post_json "$BASE_URL/api/auth/sign-up/email" '{"name":"Smoke Admin","email":"smoke@kyoube.local","password":"smoke-password-123"}' >/dev/null
[[ "$HTTP_STATUS" =~ ^2 ]] || { echo "sign-up failed: $HTTP_STATUS $(cat "$TMP/resp.json")" >&2; exit 1; }
post_json "$BASE_URL/api/bootstrap/claim" '{}' | jq -e '.claimed == true' >/dev/null
curl -fsS "$BASE_URL/api/health" | jq -e '.bootstrapStatus == "ready"' >/dev/null

echo "==> create a board API key"
TOKEN="$(post_json "$BASE_URL/api/board-api-keys" '{"name":"kyoube-smoke"}' | jq -r '.token')"
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || { echo "no board token" >&2; exit 1; }

echo "==> the plugin catalogue is branded"
# Settings → Plugins lists the example plugins from their package.json /
# manifest.ts descriptions, which live under packages/plugins (source, not
# dist) — the one surface the acceptance pass found unbranded.
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins/examples" >"$TMP/plugin-examples.json"
! grep -qE '(^|[^A-Za-z0-9_$-])Paperclip([^A-Za-z0-9_$]|$)' "$TMP/plugin-examples.json" \
  || { echo "GET /api/plugins/examples still carries display-text Paperclip:" >&2; grep -oE '.{0,40}Paperclip.{0,40}' "$TMP/plugin-examples.json" | head -5 >&2 || true; exit 1; }
echo "    /api/plugins/examples carries no display-text Paperclip"

wait_for_plugin() { # plugin-key version — poll until the core reports it ready
  # Worker (re)activation is asynchronous. kyoube.apps in particular only flips
  # to `ready` once its worker has read /kyoubeai/kyoube/config.json, opened a
  # pool against the `kyoube` database and applied the kyoube_meta migrations,
  # so sampling /api/plugins once right after the install would be a race.
  local key="$1" want="$2" i
  for i in $(seq 1 60); do
    curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins" >"$TMP/plugins.json" 2>/dev/null || true
    if jq -e --arg k "$key" --arg v "$want" \
      'map(select(.pluginKey == $k)) | length == 1 and .[0].version == $v and .[0].status == "ready"' \
      "$TMP/plugins.json" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "$key never reached $want/ready: $(jq -c --arg k "$key" 'map(select(.pluginKey == $k)) | .[0] | {version, status}' "$TMP/plugins.json")" >&2
  return 1
}

wait_for_plugin_api() { # poll until both plugin workers answer a route of their own
  # /api/plugins reports each plugin record's *stored* status. After a restore
  # (or any start against an existing database) that record already says
  # `ready` while the plugin loader is still starting the worker processes, so
  # wait_for_plugin returns at once and the next plugin route can still meet a
  # 503 for a few hundred milliseconds. CI run 35113684280 lost that race:
  # status `ready` at +0 ms, GET /tables/smoke_contacts 503 at +60 ms, the
  # kyoube.apps worker up at +430 ms. Readiness here therefore means the worker
  # answered: a cheap apps route and the terminal's own data read, both 200.
  local i apps="" term=""
  for i in $(seq 1 60); do
    apps="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
      "$API/access/me?companyId=$COMPANY_ID" 2>/dev/null || true)"
    term="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -X POST "$BASE_URL/api/plugins/kyoube.terminal/data/terminal.can_open" \
      --data "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"companyId\":\"$COMPANY_ID\",\"userId\":\"$ADMIN_USER_ID\"}}" 2>/dev/null || true)"
    [[ "$apps" == "200" && "$term" == "200" ]] && return 0
    sleep 1
  done
  echo "the plugin workers never answered after the warm start: kyoube.apps=$apps kyoube.terminal=$term" >&2
  return 1
}

APPS_SHIPPED="$(jq -r .version "$ROOT/plugins/kyoube-apps/package.json")"
[[ "$APPS_SHIPPED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "unexpected kyoube.apps version '$APPS_SHIPPED' in package.json" >&2; exit 1; }
FILES_SHIPPED="$(jq -r .version "$ROOT/plugins/kyoube-files/package.json")"
[[ "$FILES_SHIPPED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "unexpected kyoube.files version '$FILES_SHIPPED' in package.json" >&2; exit 1; }
STUDIO_SHIPPED="$(jq -r .version "$ROOT/plugins/kyoube-studio/package.json")"
[[ "$STUDIO_SHIPPED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "unexpected kyoube.studio version '$STUDIO_SHIPPED' in package.json" >&2; exit 1; }

echo "==> install plugins via kyoube ensure-plugins"
# Four plugins ship in the image (/opt/kyoube/plugins/{terminal,apps,files,studio}),
# so the first pass installs all four — `installed 4`, nothing upgraded or
# skipped.
compose exec -T app kyoube ensure-plugins --api-key "$TOKEN" | tee "$TMP/ensure-first.log"
grep -q 'installed 4, upgraded 0, skipped 0' "$TMP/ensure-first.log" \
  || { echo "expected all four bundled plugins to install on the first pass:" >&2; cat "$TMP/ensure-first.log" >&2; exit 1; }
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins" \
  | jq -e 'map(select(.pluginKey == "kyoube.terminal")) | length == 1 and .[0].status == "ready"' >/dev/null
wait_for_plugin kyoube.apps $APPS_SHIPPED
wait_for_plugin kyoube.files $FILES_SHIPPED
wait_for_plugin kyoube.studio $STUDIO_SHIPPED
echo "    kyoube.terminal, kyoube.apps ${APPS_SHIPPED}, kyoube.files ${FILES_SHIPPED} and kyoube.studio ${STUDIO_SHIPPED} are installed and ready"

echo "==> kyoube setup (real browser-approval onboarding)"
# Run setup detached inside the container; it prints an approval URL and then
# polls until a signed-in instance admin approves the challenge.
compose exec -T app sh -c \
  'rm -f /tmp/setup.log /tmp/setup.exit; { kyoube setup > /tmp/setup.log 2>&1; echo $? > /tmp/setup.exit; } & echo started' >/dev/null
APPROVAL=""
for i in $(seq 1 90); do
  APPROVAL="$(compose exec -T app sh -c 'cat /tmp/setup.log 2>/dev/null' \
    | grep -oE '/cli-auth/[0-9a-f-]{36}\?token=pcp_cli_auth_[0-9a-f]+' | head -1 || true)"
  [[ -n "$APPROVAL" ]] && break
  sleep 1
done
[[ -n "$APPROVAL" ]] || { echo "kyoube setup never printed an approval URL:" >&2; compose exec -T app sh -c 'cat /tmp/setup.log' >&2; exit 1; }
CHALLENGE_ID="${APPROVAL#/cli-auth/}"; CHALLENGE_ID="${CHALLENGE_ID%%\?*}"
CHALLENGE_TOKEN="${APPROVAL#*token=}"
echo "    approving challenge $CHALLENGE_ID as the instance admin"
post_json "$BASE_URL/api/cli-auth/challenges/$CHALLENGE_ID/approve" "{\"token\":\"$CHALLENGE_TOKEN\"}" \
  | jq -e '.approved == true' >/dev/null
SETUP_EXIT=""
for i in $(seq 1 120); do
  SETUP_EXIT="$(compose exec -T app sh -c 'cat /tmp/setup.exit 2>/dev/null' | tr -dc '0-9' || true)"
  [[ -n "$SETUP_EXIT" ]] && break
  sleep 1
done
compose exec -T app sh -c 'sed "s/^/    setup| /" /tmp/setup.log'
[[ "$SETUP_EXIT" == "0" ]] || { echo "kyoube setup exited '${SETUP_EXIT:-<timeout>}'" >&2; exit 1; }
# setup ends by running ensure-plugins with the key it just stored; the bundled
# plugins are already installed at the on-disk version, so it skips all four.
compose exec -T app sh -c 'cat /tmp/setup.log' >"$TMP/setup.log"
grep -q 'installed 0, upgraded 0, skipped 4' "$TMP/setup.log" \
  || { echo "expected setup's ensure-plugins to skip the four bundled plugins:" >&2; cat "$TMP/setup.log" >&2; exit 1; }
# No company exists at this point, so setup has nothing to verify and says so
# rather than waiting for skills that cannot appear yet.
grep -q 'no company exists yet' "$TMP/setup.log" \
  || { echo "expected setup to report that no company exists yet:" >&2; cat "$TMP/setup.log" >&2; exit 1; }

echo "==> the stored board key is usable without --api-key"
KEY_STAT="$(compose exec -T app sh -c 'stat -c "%a %U" /kyoubeai/kyoube/board-key.json')"
KEY_STAT="$(echo "$KEY_STAT" | tr -d '\r')"
[[ "$KEY_STAT" == "600 node" ]] || { echo "board-key.json is '$KEY_STAT', expected '600 node'" >&2; exit 1; }
echo "    /kyoubeai/kyoube/board-key.json $KEY_STAT"
compose exec -T app kyoube ensure-plugins >"$TMP/ensure-stored.log" 2>&1 \
  || { echo "ensure-plugins with the stored key failed:" >&2; cat "$TMP/ensure-stored.log" >&2; exit 1; }
grep -q 'kyoube.terminal skip' "$TMP/ensure-stored.log" \
  || { echo "expected kyoube.terminal to be skipped:" >&2; cat "$TMP/ensure-stored.log" >&2; exit 1; }
grep -q 'kyoube.apps skip' "$TMP/ensure-stored.log" \
  || { echo "expected kyoube.apps to be skipped:" >&2; cat "$TMP/ensure-stored.log" >&2; exit 1; }
grep -q 'kyoube.files skip' "$TMP/ensure-stored.log" \
  || { echo "expected kyoube.files to be skipped:" >&2; cat "$TMP/ensure-stored.log" >&2; exit 1; }
grep -q 'kyoube.studio skip' "$TMP/ensure-stored.log" \
  || { echo "expected kyoube.studio to be skipped:" >&2; cat "$TMP/ensure-stored.log" >&2; exit 1; }
# All bundled plugins are already at the on-disk version by now, so the whole
# run is a no-op: four skips, nothing installed or upgraded.
grep -q 'installed 0, upgraded 0, skipped 4' "$TMP/ensure-stored.log" \
  || { echo "expected 'installed 0, upgraded 0, skipped 4' in the summary:" >&2; cat "$TMP/ensure-stored.log" >&2; exit 1; }
sed 's/^/    /' "$TMP/ensure-stored.log"

echo "==> the entrypoint plugin watcher finishes and exits"
# Until a board key exists the watcher retries on a 60s cycle; once it succeeds
# runEnsurePlugins returns 0 and the process exits. Waiting for that here both
# asserts the entrypoint path works end to end and removes a 60s window in
# which the watcher could race the version-bump rehearsals below.
# `--w[a]tch` keeps the probe from matching its own command line.
WATCHER="busy"
for i in $(seq 1 90); do
  WATCHER="$(compose exec -T app sh -c \
    'for p in /proc/[0-9]*; do tr "\0" " " < "$p/cmdline" 2>/dev/null | grep -q "ensure-plugins --w[a]tch" && echo busy; done' \
    | tr -d '\r\n ' || true)"
  [[ -z "$WATCHER" ]] && break
  sleep 1
done
[[ -z "$WATCHER" ]] || { echo "ensure-plugins --watch is still running 90s after the board key was stored" >&2; exit 1; }
echo "    watcher is done"

# Assert the terminal plugin's version/status/capabilities as the core stores them.
# Usage: assert_plugin <version> [required-capability]
assert_plugin() {
  local want_version="$1" want_capability="${2:-}" i
  # Worker (re)activation after install/upgrade is asynchronous, so poll briefly
  # for the row to settle on `ready` rather than sampling once.
  for i in $(seq 1 30); do
    curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins" >"$TMP/plugins.json"
    if jq -e --arg v "$want_version" \
      'map(select(.pluginKey == "kyoube.terminal")) | length == 1 and .[0].version == $v and .[0].status == "ready"' \
      "$TMP/plugins.json" >/dev/null; then break; fi
    sleep 1
  done
  jq -e --arg v "$want_version" \
    'map(select(.pluginKey == "kyoube.terminal")) | length == 1 and .[0].version == $v and .[0].status == "ready"' \
    "$TMP/plugins.json" >/dev/null \
    || { echo "expected kyoube.terminal $want_version/ready, got: $(jq -c 'map(select(.pluginKey=="kyoube.terminal"))|.[0]|{version,status}' "$TMP/plugins.json")" >&2; exit 1; }
  if [[ -n "$want_capability" ]]; then
    jq -e --arg c "$want_capability" \
      'map(select(.pluginKey == "kyoube.terminal")) | .[0].manifestJson.capabilities | index($c) != null' \
      "$TMP/plugins.json" >/dev/null \
      || { echo "stored manifest is missing capability $want_capability: $(jq -c 'map(select(.pluginKey=="kyoube.terminal"))|.[0].manifestJson.capabilities' "$TMP/plugins.json")" >&2; exit 1; }
  fi
}

# The manifest is node-owned inside the container; edit it as node so the
# plugin loader re-reads the bumped bundle from the same packagePath.
edit_manifest() { compose exec -T -u node app sh -c "$1"; }
MANIFEST=/opt/kyoube/plugins/terminal/dist/manifest.js
# The rehearsals bump the shipped kyoube.terminal version twice. Derive all three
# from the plugin's package.json (what the image was just built from) so a real
# bump of the plugin never has to touch this script. The escaped forms are for
# sed/grep patterns, where a bare dot would match any character.
SHIPPED="$(jq -r .version "$ROOT/plugins/kyoube-terminal/package.json")"
[[ "$SHIPPED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "unexpected kyoube.terminal version '$SHIPPED' in package.json" >&2; exit 1; }
BUMP1="${SHIPPED%.*}.$(( ${SHIPPED##*.} + 1 ))"
BUMP2="${SHIPPED%.*}.$(( ${SHIPPED##*.} + 2 ))"
escape_dots() { printf '%s' "$1" | sed 's/\./\\./g'; }
SHIPPED_RE="$(escape_dots "$SHIPPED")"; BUMP1_RE="$(escape_dots "$BUMP1")"; BUMP2_RE="$(escape_dots "$BUMP2")"

echo "==> rehearse a plugin version bump (upgrade route)"
edit_manifest "sed -i 's/${SHIPPED_RE}/${BUMP1}/' $MANIFEST && grep -q '${BUMP1_RE}' $MANIFEST"
compose exec -T app kyoube ensure-plugins --api-key "$TOKEN"
assert_plugin "$BUMP1"
echo "    kyoube.terminal upgraded in place to $BUMP1"

# The escalated capability must be one the shipped manifest does NOT declare:
# upstream compares the new manifest's capabilities against the installed one
# and only diverts to the approval path for genuinely added entries, so
# re-adding any of the five kyoube.terminal already declares would quietly take
# the plain upgrade route and stop exercising the uninstall+reinstall fallback.
echo "==> rehearse a capability escalation (uninstall + reinstall fallback)"
edit_manifest "sed -i 's/${BUMP1_RE}/${BUMP2}/; s/\"ui\.page\.register\",/\"plugin.state.read\", \"ui.page.register\",/' $MANIFEST && grep -q 'plugin.state.read' $MANIFEST"
compose exec -T app kyoube ensure-plugins --api-key "$TOKEN"
assert_plugin "$BUMP2" plugin.state.read
echo "    kyoube.terminal reinstalled at $BUMP2 with the new capability"

echo "==> create a company and one agent per harness"
COMPANY_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/companies" --data '{"name":"Smoke Co"}' | jq -r '.id')"
[[ -n "$COMPANY_ID" && "$COMPANY_ID" != "null" ]] || { echo "company create failed" >&2; exit 1; }
for ADAPTER in claude_local pi_local hermes_local; do
  STATUS="$(curl -sS -o "$TMP/agent.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -X POST "$BASE_URL/api/companies/$COMPANY_ID/agents" \
    --data "{\"name\":\"smoke-$ADAPTER\",\"adapterType\":\"$ADAPTER\",\"adapterConfig\":{\"cwd\":\"/kyoubeai/workspaces/smoke\"}}")"
  [[ "$STATUS" =~ ^2 ]] || { echo "agent create for $ADAPTER failed: $STATUS $(cat "$TMP/agent.json")" >&2; exit 1; }
  echo "    created agent for $ADAPTER"
done

echo "==> the Studio design renders, signed in, and falls back without its plugin"
# docker/theme proved its hooks exist in the bundle at build time; this asks a
# real browser whether the design lands on this core: dark by default, the
# Studio sidebar and Home in place, the Workspace page, and the stock sidebar
# back when kyoube.studio is disabled. Screenshots go to STUDIO_SHOTS_DIR (CI
# uploads them) for a person to look at after a core bump.
COMPANY_PREFIX="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID" | jq -r '.issuePrefix')"
STUDIO_LIVE_RC=0
node "$ROOT/scripts/studio-live-check.mjs" "$BASE_URL" smoke@kyoube.local smoke-password-123 "$COMPANY_PREFIX" "$TOKEN" || STUDIO_LIVE_RC=$?
if [[ "$STUDIO_LIVE_RC" == "2" ]]; then
  [[ "${KYOUBE_ALLOW_NO_CHROME:-0}" == "1" ]] || { echo "studio-live-check skipped for want of Chrome; install Chrome, set CHROME_PATH, or re-run with KYOUBE_ALLOW_NO_CHROME=1" >&2; exit 1; }
  echo "    studio-live-check SKIPPED (KYOUBE_ALLOW_NO_CHROME=1)"
elif [[ "$STUDIO_LIVE_RC" != "0" ]]; then
  exit "$STUDIO_LIVE_RC"
fi

echo "==> the worker installs the Kyoube skills into the new company by itself (company.created)"
# The company was created after `kyoube setup`, so nothing but the worker's
# event subscription can have put the skills there. The import is asynchronous.
for i in $(seq 1 60); do
  curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID/skills" >"$TMP/skills.json" 2>/dev/null || true
  if jq -e 'map(.slug) | (index("kyoube-data") != null) and (index("kyoube-apps") != null)' "$TMP/skills.json" >/dev/null 2>&1; then break; fi
  sleep 1
  [[ $i -eq 60 ]] && { echo "the Kyoube skills never appeared in the company's skill library: $(cat "$TMP/skills.json")" >&2; exit 1; }
done
echo "    kyoube-data and kyoube-apps are in the company's skill library"

echo "==> terminal: the UI bundle is served and the sidebar gate answers"
# Upstream serves plugin UI bundles from `GET /_plugins/:pluginId/ui/*` — mounted
# at the app root (server/src/app.ts), NOT under /api, whose catch-all would 404
# it. `index.js` is the entry named by `entrypoints.ui`; the frontend slot host
# imports exactly this URL, so a 200 with the page export in it is the closest
# check to "the browser can mount the page" that needs no browser.
#
# :pluginId must be the row UUID here, which is also what the frontend uses
# (`PluginUiContribution.pluginId`). Unlike the bridge routes, this route is not
# key-tolerant: it calls registry.getById() first and only swallows the failure
# when the thrown error exposes Postgres code 22P02 at the top level, which the
# Drizzle wrapper does not — so passing "kyoube.terminal" here 500s.
PLUGIN_UUID="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins" \
  | jq -r 'map(select(.pluginKey == "kyoube.terminal")) | .[0].id')"
[[ -n "$PLUGIN_UUID" && "$PLUGIN_UUID" != "null" ]] || { echo "could not resolve the kyoube.terminal plugin id" >&2; exit 1; }
UI_STATUS="$(curl -sS -o "$TMP/ui-bundle.js" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/_plugins/$PLUGIN_UUID/ui/index.js")"
[[ "$UI_STATUS" == "200" ]] \
  || { echo "GET /_plugins/$PLUGIN_UUID/ui/index.js returned $UI_STATUS: $(head -c 300 "$TMP/ui-bundle.js")" >&2; exit 1; }
grep -q 'TerminalPage' "$TMP/ui-bundle.js" \
  || { echo "the served UI bundle does not contain TerminalPage" >&2; exit 1; }
echo "    ui bundle 200, $(wc -c <"$TMP/ui-bundle.js" | tr -d ' ') bytes, contains TerminalPage"

ADMIN_USER_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/cli-auth/me" | jq -r '.userId')"
[[ -n "$ADMIN_USER_ID" && "$ADMIN_USER_ID" != "null" ]] || { echo "could not resolve the board key's user id" >&2; exit 1; }
# terminal.can_open backs the sidebar entry: the entry renders only when the
# signed-in user's company role is in allowedRoles.
curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/plugins/kyoube.terminal/data/terminal.can_open" \
  --data "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"companyId\":\"$COMPANY_ID\",\"userId\":\"$ADMIN_USER_ID\"}}" \
  >"$TMP/can-open.json"
jq -e '.data.allowed == true' "$TMP/can-open.json" >/dev/null \
  || { echo "terminal.can_open did not allow the admin: $(cat "$TMP/can-open.json")" >&2; exit 1; }
echo "    terminal.can_open allowed=true role=$(jq -r '.data.role' "$TMP/can-open.json") for the admin"

echo "==> terminal: open, run a command, read its output back, close"
bridge() { # action-key body-json
  curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -X POST "$BASE_URL/api/plugins/kyoube.terminal/actions/$1" --data "$2"
}
# What is typed must differ from what a *running* shell prints, because the tty
# line discipline echoes the typed bytes back to the master read side whether or
# not the child ever reads them — the plugin records that echo as an `output`
# event too. So type the arithmetic unevaluated (`\$((6*7))` keeps bash on this
# side from expanding it) and assert on the evaluated result: only a live shell
# turns "<mark>-$((6*7))" into "<mark>-42".
MARK="kyoube-smoke-$RANDOM"
EXPECTED="$MARK-42"
SESSION_ID="$(bridge terminal.open "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"cols\":100,\"rows\":30}}" | jq -r '.data.sessionId')"
[[ -n "$SESSION_ID" && "$SESSION_ID" != "null" ]] || { echo "terminal.open failed" >&2; exit 1; }
bridge terminal.input "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"sessionId\":\"$SESSION_ID\",\"data\":\"echo $MARK-\$((6*7))\\n\"}}" >/dev/null
# bash has to start, read the line, evaluate it and write the result back
# through the pty; how long that takes depends on the host's load. Read it
# back the way the page does: `terminal.wait` long-polls answer as soon as
# there is output past `afterSeq` (else park up to `timeoutMs`), so chain
# them from the last seq seen and accumulate the text until the mark shows
# up or ~20s pass. Upstream's SSE stream bridge is not wired (it answers
# 501), which is exactly why the page pulls instead.
MARK_SEEN=""
AFTER_SEQ=0
: >"$TMP/wait-output.txt"
WAIT_STARTED=$(date +%s)
# Bounded by wall time, not by a count: a login shell's profile output, prompt and tty echo
# each answer a wait of their own, so a fixed number of polls could run out in well under 20s.
while (( $(date +%s) - WAIT_STARTED < 20 )); do
  bridge terminal.wait "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"sessionId\":\"$SESSION_ID\",\"afterSeq\":$AFTER_SEQ,\"timeoutMs\":2000}}" >"$TMP/wait.json"
  jq -r '[.data.events[] | select(.type == "output") | .data] | join("")' "$TMP/wait.json" | tr -d '\n' >>"$TMP/wait-output.txt"
  AFTER_SEQ="$(jq --argjson after "$AFTER_SEQ" '[.data.events[].seq] | max // $after' "$TMP/wait.json")"
  if grep -q -- "$EXPECTED" "$TMP/wait-output.txt"; then MARK_SEEN=1; break; fi
done
[[ -n "$MARK_SEEN" ]] || {
  echo "the shell never printed '$EXPECTED' within ~20s (typed: echo $MARK-\$((6*7))); output seen so far:" >&2
  cat "$TMP/wait-output.txt" >&2
  echo "last wait payload:" >&2
  cat "$TMP/wait.json" >&2
  exit 1
}
# An idle session's wait must answer empty when its timeout elapses, not hang.
IDLE_STARTED=$(date +%s)
bridge terminal.wait "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"sessionId\":\"$SESSION_ID\",\"afterSeq\":$AFTER_SEQ,\"timeoutMs\":1000}}" >"$TMP/wait-idle.json"
jq -e '.data.events == [] and .data.session.alive == true' "$TMP/wait-idle.json" >/dev/null \
  || { echo "an idle terminal.wait did not answer empty: $(cat "$TMP/wait-idle.json")" >&2; exit 1; }
(( $(date +%s) - IDLE_STARTED <= 10 )) || { echo "an idle terminal.wait took longer than its timeout" >&2; exit 1; }
bridge terminal.close "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"sessionId\":\"$SESSION_ID\"}}" >/dev/null
echo "    terminal round-trip ok (shell evaluated the command, not just echoed it)"

echo "==> the activity log records the session but never its content"
# `ctx.activity.log({ message })` lands in activity_log.action with
# actorType=plugin (server/src/services/plugin-host-services.ts), and
# GET /api/companies/:companyId/activity returns those rows to a board key.
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID/activity?limit=200" \
  >"$TMP/activity.json"
jq -e 'map(select((.action // "") | startswith("Terminal session opened"))) | length >= 1' "$TMP/activity.json" >/dev/null \
  || { echo "no 'Terminal session opened' entry in the activity log: $(jq -c 'map(.action)' "$TMP/activity.json")" >&2; exit 1; }
jq -e 'map(select((.action // "") | startswith("Terminal session closed"))) | length >= 1' "$TMP/activity.json" >/dev/null \
  || { echo "no 'Terminal session closed' entry in the activity log: $(jq -c 'map(.action)' "$TMP/activity.json")" >&2; exit 1; }
jq -e --arg mark "$MARK" 'tostring | contains($mark) | not' "$TMP/activity.json" >/dev/null \
  || { echo "the activity log leaked terminal content ('$MARK')" >&2; exit 1; }
echo "    open/close audited, keystrokes and output are not"

echo "==> data: plugin ready, create a table, insert, query, sql"
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins" \
  | jq -e 'map(select(.pluginKey == "kyoube.apps")) | length == 1 and .[0].status == "ready"' >/dev/null
# Upstream dispatches these from `router.use("/plugins/:pluginId/api", …)` in
# server/src/routes/plugins.ts: JSON only, `resolvePlugin` accepts the plugin
# key as well as the row UUID (unlike /_plugins/:pluginId/ui/*), and the company
# is resolved from `?companyId=` for GET and `body.companyId` for POST — exactly
# what this plugin's manifest declares. COMPANY_ID is a UUID, so the query
# string needs no escaping.
API="$BASE_URL/api/plugins/kyoube.apps/api"
api_post() { curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$API$1" --data "$2"; }
api_get() { curl -fsS -H "Authorization: Bearer $TOKEN" "$API$1?companyId=$COMPANY_ID"; }
# The board key authenticates as the instance admin, who owns Smoke Co, and
# owner/admin maps to the `schema` level (data/permissions.ts roleToLevel).
api_get "/access/me" | jq -e '.level == "schema"' >/dev/null
api_post "/tables" "{\"companyId\":\"$COMPANY_ID\",\"name\":\"smoke_contacts\",\"fields\":[{\"name\":\"name\",\"kind\":\"text\",\"required\":true},{\"name\":\"stage\",\"kind\":\"select\",\"options\":{\"choices\":[\"lead\",\"customer\"]}}]}" \
  | jq -e '.name == "smoke_contacts"' >/dev/null
api_get "/tables/smoke_contacts" >"$TMP/table.json"
jq -e '.name == "smoke_contacts"
  and ([.fields[] | select(.name == "name" and .kind == "text" and .required == true)] | length == 1)
  and ([.fields[] | select(.name == "stage" and .kind == "select" and (.options.choices == ["lead", "customer"]))] | length == 1)' \
  "$TMP/table.json" >/dev/null \
  || { echo "GET /tables/smoke_contacts did not describe both fields: $(cat "$TMP/table.json")" >&2; exit 1; }
api_post "/tables/smoke_contacts/rows" "{\"companyId\":\"$COMPANY_ID\",\"rows\":[{\"name\":\"Ada\",\"stage\":\"lead\"},{\"name\":\"Grace\",\"stage\":\"customer\"}]}" \
  >"$TMP/inserted.json"
jq -e 'length == 2' "$TMP/inserted.json" >/dev/null
api_post "/tables/smoke_contacts/rows/query" "{\"companyId\":\"$COMPANY_ID\",\"where\":{\"field\":\"stage\",\"op\":\"eq\",\"value\":\"customer\"}}" \
  | jq -e '.rows | length == 1 and .[0].name == "Grace"' >/dev/null
api_post "/sql" "{\"companyId\":\"$COMPANY_ID\",\"sql\":\"select count(*)::int as n from smoke_contacts\"}" | jq -e '.rows[0].n == 2' >/dev/null
# A non-SELECT never reaches Postgres: the read-only validator raises
# DataError("invalid"), which api-routes.ts maps to HTTP 400.
STATUS="$(curl -sS -o "$TMP/sql-write.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$API/sql" --data "{\"companyId\":\"$COMPANY_ID\",\"sql\":\"delete from smoke_contacts\"}")"
[[ "$STATUS" == "400" ]] || { echo "expected 400 for a non-SELECT, got $STATUS $(cat "$TMP/sql-write.json")" >&2; exit 1; }
api_get "/tables" | jq -e 'map(.name) | index("smoke_contacts") != null' >/dev/null
# Round out the write path (and the audit trail) with an update and a delete.
ADA_ID="$(jq -r '.[] | select(.name == "Ada") | .id' "$TMP/inserted.json")"
[[ -n "$ADA_ID" && "$ADA_ID" != "null" ]] || { echo "the insert response carried no row id: $(cat "$TMP/inserted.json")" >&2; exit 1; }
api_post "/tables/smoke_contacts/rows/update" "{\"companyId\":\"$COMPANY_ID\",\"ids\":[\"$ADA_ID\"],\"patch\":{\"stage\":\"customer\"}}" \
  | jq -e '.affected == 1 and .rows[0].stage == "customer"' >/dev/null
api_post "/tables/smoke_contacts/rows/delete" "{\"companyId\":\"$COMPANY_ID\",\"ids\":[\"$ADA_ID\"]}" | jq -e '.affected == 1' >/dev/null
api_post "/tables/smoke_contacts/rows/count" "{\"companyId\":\"$COMPANY_ID\"}" | jq -e '.count == 1' >/dev/null
echo "    data round-trip ok"

# The 17 data_* and 7 apps_* tools (both registered under the "kyoube.apps:"
# prefix, since Phase 3 added the Apps tools to the same plugin) are what an
# agent actually calls, through the core's tool gateway. Executing one from
# here is not possible without a live agent run: POST
# /api/plugins/tools/execute validates runContext against the agents,
# heartbeat_runs and projects tables (validateToolRunContextScope in
# server/src/routes/plugins.ts) and heartbeat runs are only ever created by the
# heartbeat service, never over HTTP. Discovery is board-callable, so assert
# that the host registered the whole tool surface (Step 3 of the task brief
# covers real agent execution manually).
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins/tools" >"$TMP/tools.json"
jq -e '[.[] | select(.name | startswith("kyoube.apps:"))] | length == 24' "$TMP/tools.json" >/dev/null \
  || { echo "expected 24 kyoube.apps tools (17 data_* + 7 apps_*), got: $(jq -c '[.[] | select(.name | startswith("kyoube.apps:")) | .name]' "$TMP/tools.json")" >&2; exit 1; }
jq -e 'map(.name) | index("kyoube.apps:data_sql_select") != null and index("kyoube.apps:data_insert") != null and index("kyoube.apps:apps_create") != null and index("kyoube.apps:apps_publish") != null' "$TMP/tools.json" >/dev/null
echo "    24 kyoube.apps:data_*/apps_* tools registered with the host tool dispatcher"

echo "==> the activity log summarises the data mutations but never the rows"
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID/activity?limit=200" \
  >"$TMP/data-activity.json"
jq -e 'map(select((.action // "") == "Kyoube data: inserted 2 row(s) into smoke_contacts")) | length >= 1' \
  "$TMP/data-activity.json" >/dev/null \
  || { echo "no 'Kyoube data: inserted 2 row(s) into smoke_contacts' entry: $(jq -c 'map(.action)' "$TMP/data-activity.json")" >&2; exit 1; }
# Delimited, not a bare substring: a leaked cell value appears as its own token
# ("name":"Ada"), while "Ada" inside a longer word — upstream writes adapter
# names and agent names into its own activity details — is not a leak. jq 1.8's
# Oniguruma build does not honour \b here, hence the explicit classes.
jq -e 'tostring | test("[^A-Za-z]Ada[^A-Za-z]|[^A-Za-z]Grace[^A-Za-z]") | not' "$TMP/data-activity.json" >/dev/null \
  || { echo "the activity log leaked row contents (Ada/Grace)" >&2; exit 1; }
# Every mutation is also written to kyoube_meta.audit in the `kyoube` database
# (create_table, insert, update, delete = 4 so far). `kyoubeai` is the compose
# superuser (docker-compose.yml POSTGRES_USER); the unix socket is trusted.
AUDIT_ROWS="$(compose exec -T db psql -U kyoubeai -d kyoube -Atc 'select count(*) from kyoube_meta.audit' | tr -dc '0-9')"
[[ -n "$AUDIT_ROWS" && "$AUDIT_ROWS" -ge 4 ]] \
  || { echo "expected >= 4 rows in kyoube_meta.audit, got '${AUDIT_ROWS:-<none>}'" >&2; exit 1; }
echo "    activity summarised without row contents, kyoube_meta.audit has $AUDIT_ROWS rows"

echo "==> apps: create, publish, runtime, data proxy"
APP_SOURCE='<!doctype html><html><body><h1>smoke-app</h1><script>kyoube.ready().then(c=>console.log(c.app.slug))</script></body></html>'
api_post "/apps" "$(jq -cn --arg c "$COMPANY_ID" --arg s "$APP_SOURCE" '{companyId:$c, manifest:{name:"Smoke App", slug:"smoke-app", tables:[{name:"smoke_contacts", access:"readwrite"}]}, source:$s}')" \
  | jq -e '.app.status == "draft"' >/dev/null
api_post "/apps/smoke-app/publish" "{\"companyId\":\"$COMPANY_ID\"}" | jq -e '.status == "published" and .currentVersion == 1' >/dev/null
api_get "/apps/smoke-app" | jq -e '.app.slug == "smoke-app" and .version.version == 1' >/dev/null
# `apps.*` are UI actions, not board-API routes, so they go through the action
# bridge (like `bridge` above for kyoube.terminal) rather than api_post/api_get.
apps_bridge() { curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/plugins/kyoube.apps/actions/$1" --data "$2"; }
apps_bridge apps.runtime "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"slug\":\"smoke-app\"}}" | jq -e '.data.source | contains("smoke-app")' >/dev/null
# smoke_contacts holds exactly one row here (Grace): the data block above
# inserted Ada and Grace, then deleted Ada to exercise the delete path, and
# nothing has inserted into it since.
apps_bridge apps.data "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"slug\":\"smoke-app\",\"method\":\"query\",\"params\":{\"table\":\"smoke_contacts\"}}}" \
  | jq -e '.data.rows | length == 1 and .[0].name == "Grace"' >/dev/null
# An undeclared table is rejected inside the worker (DataError("forbidden", ...)).
# The host's action bridge cannot distinguish that from any other worker throw,
# so it passes it through as a generic HTTP 502 `{ code: "WORKER_ERROR", message }`
# whose message carries the worker's own "<code>: <text>" — assert both the
# transport status and that the message really is the forbidden-table
# rejection, not some other failure wearing the same status code.
STATUS="$(curl -sS -o "$TMP/apps-undeclared.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/plugins/kyoube.apps/actions/apps.data" --data "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"slug\":\"smoke-app\",\"method\":\"query\",\"params\":{\"table\":\"undeclared\"}}}")"
[[ "$STATUS" == "502" ]] || { echo "expected a bridge error for an undeclared table, got $STATUS: $(cat "$TMP/apps-undeclared.json")" >&2; exit 1; }
jq -e '.code == "WORKER_ERROR" and (.message | contains("forbidden"))' "$TMP/apps-undeclared.json" >/dev/null \
  || { echo "expected a WORKER_ERROR with a 'forbidden' message, got: $(cat "$TMP/apps-undeclared.json")" >&2; exit 1; }
echo "    apps round-trip ok"

echo "==> files: a project's folder is browsable and editable from the action bridge"
# kyoube.files adds a Files tab to the project page. It has no board-API routes
# of its own — everything is a UI action, host-authenticated like `apps.*`
# above — so this drives the same bridge the tab does. The project has no
# configured workspace, so the folder it exposes is the managed one the core
# would start an agent in: <instance>/projects/<companyId>/<projectId>/_default.
FILES_PROJECT_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/companies/$COMPANY_ID/projects" --data '{"name":"Smoke Files"}' | jq -r '.id')"
[[ -n "$FILES_PROJECT_ID" && "$FILES_PROJECT_ID" != "null" ]] || { echo "could not create the files smoke project" >&2; exit 1; }
files_bridge() { curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE_URL/api/plugins/kyoube.files/actions/$1" --data "$2"; }
files_bridge files.workspaces "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\"}}" >"$TMP/files-ws.json"
jq -e '.data.canRead == true and .data.canWrite == true and (.data.workspaces | length == 1) and .data.workspaces[0].source == "managed"' "$TMP/files-ws.json" >/dev/null \
  || { echo "files.workspaces did not report a writable managed folder: $(cat "$TMP/files-ws.json")" >&2; exit 1; }
FILES_ROOT="$(jq -r '.data.workspaces[0].path' "$TMP/files-ws.json")"
[[ "$FILES_ROOT" == "/kyoubeai/instances/default/projects/$COMPANY_ID/$FILES_PROJECT_ID/_default" ]] \
  || { echo "unexpected managed project folder '$FILES_ROOT'" >&2; exit 1; }
# The folder does not exist until an agent runs (or someone writes into it).
files_bridge files.list "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\",\"path\":\"\"}}" \
  | jq -e '.data.exists == false and .data.entries == []' >/dev/null
files_bridge files.create "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\",\"dir\":\"\",\"name\":\"docs\",\"kind\":\"dir\"}}" | jq -e '.data.kind == "dir"' >/dev/null
files_bridge files.create "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\",\"dir\":\"docs\",\"name\":\"plan.md\",\"kind\":\"file\"}}" | jq -e '.data.kind == "file"' >/dev/null
files_bridge files.write "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\",\"path\":\"docs/plan.md\",\"content\":\"# smoke plan\\n\",\"mustExist\":true}}" | jq -e '.data.size == 13' >/dev/null
# What the bridge wrote is what an agent in that folder would read.
compose exec -T app sh -c "cat '$FILES_ROOT/docs/plan.md'" | grep -qx '# smoke plan' \
  || { echo "the file written through kyoube.files is not on disk at $FILES_ROOT/docs/plan.md" >&2; exit 1; }
# And what an agent writes is what the bridge reads back.
compose exec -T app sh -c "printf 'from-the-shell' > '$FILES_ROOT/docs/agent.txt'"
files_bridge files.read "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\",\"path\":\"docs/agent.txt\"}}" \
  | jq -e '.data.encoding == "utf8" and .data.content == "from-the-shell"' >/dev/null
files_bridge files.list "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\",\"path\":\"docs\"}}" \
  | jq -e '[.data.entries[].name] == ["agent.txt", "plan.md"]' >/dev/null
# A path that tries to leave the folder is refused inside the worker (invalid),
# which the bridge surfaces as a 502 WORKER_ERROR like the apps case above.
STATUS="$(curl -sS -o "$TMP/files-escape.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/plugins/kyoube.files/actions/files.read" --data "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\",\"path\":\"../../../../kyoube/board-key.json\"}}")"
[[ "$STATUS" == "502" ]] || { echo "expected a bridge error for a path outside the folder, got $STATUS: $(cat "$TMP/files-escape.json")" >&2; exit 1; }
jq -e '.code == "WORKER_ERROR" and (.message | contains("invalid"))' "$TMP/files-escape.json" >/dev/null \
  || { echo "expected a WORKER_ERROR with an 'invalid' message, got: $(cat "$TMP/files-escape.json")" >&2; exit 1; }
files_bridge files.delete "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"projectId\":\"$FILES_PROJECT_ID\",\"path\":\"docs\",\"recursive\":true}}" | jq -e '.data.ok == true' >/dev/null
# The activity log names each change and its path (the message lands in
# `.action`, as for the terminal and data entries above), never file content.
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/companies/$COMPANY_ID/activity?limit=200" >"$TMP/files-activity.json"
for want in 'Kyoube files: created folder docs in' 'Kyoube files: created file docs/plan.md in' 'Kyoube files: saved docs/plan.md in' 'Kyoube files: deleted folder docs in'; do
  jq -e --arg w "$want" 'map(select((.action // "") | startswith($w))) | length >= 1' "$TMP/files-activity.json" >/dev/null \
    || { echo "no '$want' entry in the activity log: $(jq -c 'map(.action)' "$TMP/files-activity.json")" >&2; exit 1; }
done
jq -e 'tostring | contains("smoke plan") | not' "$TMP/files-activity.json" >/dev/null \
  || { echo "the activity log leaked file content ('smoke plan')" >&2; exit 1; }
echo "    files round-trip ok at $FILES_ROOT"

echo "==> disaster recovery: back up, destroy the stack, restore it, and prove the restore"
# Ruling P4-R5: the round trip is never rehearsed against the default compose
# project — that is the operator's own stack and data. scripts/backup.sh and
# scripts/restore.sh take their target from COMPOSE_PROJECT_NAME and
# COMPOSE_ENV_FILES (they run plain `docker compose`), so the smoke points them
# at its own throwaway project and env file, exactly as docs/operations.md
# documents for any non-default deployment.
AUDIT_BEFORE="$(compose exec -T db psql -U kyoubeai -d kyoube -Atc 'select count(*) from kyoube_meta.audit' | tr -dc '0-9')"
[[ -n "$AUDIT_BEFORE" && "$AUDIT_BEFORE" -ge 4 ]] \
  || { echo "could not read kyoube_meta.audit before the backup: '${AUDIT_BEFORE:-<none>}'" >&2; exit 1; }
# The company schema is c_<hex> owned by kyoube_c_<hex>, hex being the company
# uuid without dashes (plugins/kyoube-apps/src/db/company-scope.ts).
COMPANY_HEX="$(echo "$COMPANY_ID" | tr -d '-' | tr 'A-Z' 'a-z')"

COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_ENV_FILES="$ENV_FILE" BACKUP_DIR="$TMP/backups" \
  bash "$ROOT/scripts/backup.sh" | tee "$TMP/backup.log"
BACKUP_PATH="$(sed -n 's/^backup written to //p' "$TMP/backup.log" | tail -1)"
[[ -n "$BACKUP_PATH" && -d "$BACKUP_PATH" ]] \
  || { echo "backup.sh did not print a backup directory:" >&2; cat "$TMP/backup.log" >&2; exit 1; }
for FILE in kyoubeai.dump kyoube.dump roles.sql kyoubeai-home.tgz SHA256SUMS; do
  [[ -s "$BACKUP_PATH/$FILE" ]] || { echo "backup is missing or empty: $BACKUP_PATH/$FILE" >&2; ls -l "$BACKUP_PATH" >&2; exit 1; }
done
# Company roles are cluster-level state: they are in neither per-database dump,
# and without them a fresh-cluster restore cannot give the c_<hex> schema back
# to its owner (ruling P4-R6).
grep -q "kyoube_c_$COMPANY_HEX" "$BACKUP_PATH/roles.sql" \
  || { echo "roles.sql does not carry the smoke company's role kyoube_c_$COMPANY_HEX:" >&2; cat "$BACKUP_PATH/roles.sql" >&2; exit 1; }
echo "    backup at $BACKUP_PATH ($(wc -c <"$BACKUP_PATH/kyoubeai-home.tgz" | tr -d ' ') bytes of home volume, roles.sql carries kyoube_c_$COMPANY_HEX)"

echo "==> simulating total loss: down -v destroys pgdata and kyoubeai-home"
compose down -v --remove-orphans
compose up -d
DB_CID="$(compose ps -aq db | tr -d '\r' | head -1)"
[[ -n "$DB_CID" ]] || { echo "no db container after the fresh up" >&2; exit 1; }
DB_HEALTH=""
for i in $(seq 1 120); do
  DB_HEALTH="$(docker inspect -f '{{.State.Health.Status}}' "$DB_CID" | tr -d '\r')"
  [[ "$DB_HEALTH" == "healthy" ]] && break
  sleep 1
done
[[ "$DB_HEALTH" == "healthy" ]] || { echo "the rebuilt db never became healthy (state '$DB_HEALTH')" >&2; exit 1; }
for i in $(seq 1 300); do
  if curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
  if [[ $i -eq 300 ]]; then echo "the rebuilt app never came up after the simulated disaster" >&2; exit 1; fi
done
# Prove the loss was real: the board key row lived in the kyoubeai database,
# which the fresh init just recreated empty, so the token must no longer work.
STATUS="$(curl -sS -o "$TMP/post-disaster-plugins.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins")"
[[ ! "$STATUS" =~ ^2 ]] \
  || { echo "the board token still worked after down -v, so the disaster was not real: $STATUS $(cat "$TMP/post-disaster-plugins.json")" >&2; exit 1; }
echo "    stack rebuilt from empty volumes; the pre-disaster board token now gets $STATUS"

# `down -v` also removed the app *container*, so the rebuilt one carries the
# pristine image manifest (the shipped kyoube.terminal version). The backup was
# taken against a container whose on-disk manifest the version-bump rehearsals
# above had edited to the second bump with plugin.state.read. A backup restores
# state, not the image, so put the container back into the state the backup was
# taken from -- otherwise the entrypoint's ensure-plugins watcher would
# legitimately "upgrade" the restored row down to the version it finds on disk
# (planPluginInstalls compares versions for difference, not for newer).
edit_manifest "sed -i 's/${SHIPPED_RE}/${BUMP2}/; s/\"ui\.page\.register\",/\"plugin.state.read\", \"ui.page.register\",/' $MANIFEST && grep -q '${BUMP2_RE}' $MANIFEST && grep -q 'plugin.state.read' $MANIFEST"

echo "==> restore"
COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_ENV_FILES="$ENV_FILE" \
  bash "$ROOT/scripts/restore.sh" "$BACKUP_PATH"

RESTORED=""
for i in $(seq 1 300); do
  if curl -fsS "$BASE_URL/api/health" 2>/dev/null | jq -e '.bootstrapStatus == "ready"' >/dev/null 2>&1; then RESTORED=1; break; fi
  sleep 1
done
[[ -n "$RESTORED" ]] \
  || { echo "the restored app never reported bootstrapStatus ready: $(curl -sS "$BASE_URL/api/health" || true)" >&2; exit 1; }
# The original board token is back: it lives in the restored core database,
# and the board key file `kyoube setup` wrote is back on the restored volume.
STATUS="$(curl -sS -o "$TMP/post-restore-plugins.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins")"
[[ "$STATUS" == "200" ]] \
  || { echo "the pre-disaster board token did not work after the restore: $STATUS $(cat "$TMP/post-restore-plugins.json")" >&2; exit 1; }
KEY_STAT="$(compose exec -T app sh -c 'stat -c "%a %U" /kyoubeai/kyoube/board-key.json' | tr -d '\r')"
[[ "$KEY_STAT" == "600 node" ]] || { echo "restored board-key.json is '$KEY_STAT', expected '600 node'" >&2; exit 1; }
wait_for_plugin kyoube.apps $APPS_SHIPPED
wait_for_plugin kyoube.terminal "$BUMP2"
wait_for_plugin_api
echo "    app is ready again, the pre-disaster token authenticates, both plugin workers answer"

# Data: the table definition, and the one row that survived the delete above.
api_get "/tables/smoke_contacts" >"$TMP/table-restored.json"
jq -e '.name == "smoke_contacts"
  and ([.fields[] | select(.name == "name" and .kind == "text" and .required == true)] | length == 1)
  and ([.fields[] | select(.name == "stage" and .kind == "select" and (.options.choices == ["lead", "customer"]))] | length == 1)' \
  "$TMP/table-restored.json" >/dev/null \
  || { echo "the restored smoke_contacts does not describe both fields: $(cat "$TMP/table-restored.json")" >&2; exit 1; }
api_post "/tables/smoke_contacts/rows/count" "{\"companyId\":\"$COMPANY_ID\"}" >"$TMP/count-restored.json"
jq -e '.count == 1' "$TMP/count-restored.json" >/dev/null \
  || { echo "expected the pre-backup row count of 1 after the restore, got: $(cat "$TMP/count-restored.json")" >&2; exit 1; }
api_post "/tables/smoke_contacts/rows/query" "{\"companyId\":\"$COMPANY_ID\",\"where\":{\"field\":\"stage\",\"op\":\"eq\",\"value\":\"customer\"}}" \
  | jq -e '.rows | length == 1 and .[0].name == "Grace"' >/dev/null
# Apps: the published app and its version 1 came back with the database.
api_get "/apps/smoke-app" >"$TMP/app-restored.json"
jq -e '.app.slug == "smoke-app" and .app.status == "published" and .app.currentVersion == 1 and .version.version == 1' \
  "$TMP/app-restored.json" >/dev/null \
  || { echo "smoke-app did not come back published at version 1: $(jq -c '{app, version: .version.version}' "$TMP/app-restored.json")" >&2; exit 1; }
# Terminal: the plugin's data route still answers for the same admin/company.
curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/plugins/kyoube.terminal/data/terminal.can_open" \
  --data "{\"companyId\":\"$COMPANY_ID\",\"params\":{\"companyId\":\"$COMPANY_ID\",\"userId\":\"$ADMIN_USER_ID\"}}" \
  >"$TMP/can-open-restored.json"
jq -e '.data.allowed == true' "$TMP/can-open-restored.json" >/dev/null \
  || { echo "terminal.can_open did not allow the admin after the restore: $(cat "$TMP/can-open-restored.json")" >&2; exit 1; }
# The audit trail is in the kyoube database and must come back row for row.
AUDIT_RESTORED="$(compose exec -T db psql -U kyoubeai -d kyoube -Atc 'select count(*) from kyoube_meta.audit' | tr -dc '0-9')"
[[ "$AUDIT_RESTORED" == "$AUDIT_BEFORE" ]] \
  || { echo "kyoube_meta.audit has $AUDIT_RESTORED rows after the restore, expected $AUDIT_BEFORE" >&2; exit 1; }

# The ownership proof. Creating a table runs DDL under `SET LOCAL ROLE
# kyoube_c_<hex>` in the c_<hex> schema, which only succeeds if roles.sql
# recreated the role with a SET-able membership AND the kyoube dump restored
# *with* owners handed the schema back to it. A --no-owner restore leaves the
# schema owned by the kyoubeai superuser and this 200 becomes a 500.
STATUS="$(curl -sS -o "$TMP/table-after-restore.json" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$API/tables" --data "{\"companyId\":\"$COMPANY_ID\",\"name\":\"smoke_after_restore\",\"fields\":[{\"name\":\"note\",\"kind\":\"text\"}]}")"
[[ "$STATUS" == "200" ]] \
  || { echo "creating a table after the restore returned $STATUS — the c_$COMPANY_HEX schema did not come back owned by kyoube_c_$COMPANY_HEX: $(cat "$TMP/table-after-restore.json")" >&2; exit 1; }
jq -e '.name == "smoke_after_restore"' "$TMP/table-after-restore.json" >/dev/null
SCHEMA_OWNER="$(compose exec -T db psql -U kyoubeai -d kyoube -Atc \
  "select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'c_$COMPANY_HEX'" | tr -d '\r\n ')"
[[ "$SCHEMA_OWNER" == "kyoube_c_$COMPANY_HEX" ]] \
  || { echo "schema c_$COMPANY_HEX is owned by '$SCHEMA_OWNER', expected kyoube_c_$COMPANY_HEX" >&2; exit 1; }
echo "    data, apps, terminal and audit restored; c_$COMPANY_HEX is owned by $SCHEMA_OWNER and still accepts DDL"
echo "backup/restore round-trip ok"

echo "==> kyoube doctor"
# No KYOUBE_BOARD_API_KEY override: `kyoube setup` stored a real key above, so
# doctor's board-key and plugins checks must pass from the stored file alone.
compose exec -T app kyoube doctor | tee "$TMP/doctor.log"
# doctor's `plugins` line lists every kyoube.* plugin as key@version=status, so
# it must now name both bundles.
grep -q "kyoube.apps@${APPS_SHIPPED}=ready" "$TMP/doctor.log" \
  || { echo "kyoube doctor did not report kyoube.apps@${APPS_SHIPPED}=ready:" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
grep -q "kyoube.terminal@${BUMP2}=ready" "$TMP/doctor.log" \
  || { echo "kyoube doctor did not report kyoube.terminal@${BUMP2}=ready:" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
grep -q "kyoube.files@${FILES_SHIPPED}=ready" "$TMP/doctor.log" \
  || { echo "kyoube doctor did not report kyoube.files@${FILES_SHIPPED}=ready:" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
grep -Eq '^ok +skills .*1/1 companies' "$TMP/doctor.log" \
  || { echo "kyoube doctor did not report the Kyoube skills present in the restored company:" >&2; cat "$TMP/doctor.log" >&2; exit 1; }
# The restored stack started with a company already in place, which is the
# upgrade case: the entrypoint's ensure-plugins pass must have asked the worker
# to install the skills there (the worker cannot do it from its own start-up).
for i in $(seq 1 60); do
  compose logs --no-color app 2>/dev/null | grep -q 'Kyoube skills ensured in 1/1 companies' && break
  sleep 2
  [[ $i -eq 60 ]] && { echo "the entrypoint's ensure-plugins never reported the Kyoube skills ensured after the restore:" >&2; compose logs --no-color app 2>/dev/null | grep 'kyoube:' >&2; exit 1; }
done
echo "    ensure-plugins installed the Kyoube skills into the pre-existing company at container start"

echo "==> migration rehearsal: turn the stack into the 0.1.x layout, then migrate it"
# A 0.1.x install has the role/database `paperclip`, its home on
# <project>_paperclip-home and PAPERCLIP_* keys in .env. A real 0.1.x image is a
# cold build away, so the rehearsal makes that layout out of the running stack —
# the inverse of the migration, through the same temporary-superuser trick — and
# runs scripts/migrate-from-0.1.sh against it. That proves the rename, the
# volume copy, the marker, the entrypoint's compatibility link, the .env rewrite
# and --check, against a database with a real company, agents and plugins.
LEGACY_ENV="$TMP/legacy.env"
sed -e 's/^KYOUBE_PUBLIC_URL=/PAPERCLIP_PUBLIC_URL=/' -e 's/^KYOUBE_DEPLOYMENT_EXPOSURE=/PAPERCLIP_DEPLOYMENT_EXPOSURE=/' -e 's/^KYOUBE_CORE_VERSION=/PAPERCLIP_VERSION=/' "$ENV_FILE" > "$LEGACY_ENV"
grep -q '^PAPERCLIP_PUBLIC_URL=' "$LEGACY_ENV" || { echo "could not derive a legacy env file" >&2; exit 1; }
compose stop app
# One agent gets a 0.1.x-style absolute workspace path for --check to find.
compose exec -T db psql -U kyoubeai -d kyoubeai -v ON_ERROR_STOP=1 -Atqc \
  "update agents set adapter_config = adapter_config || '{\"cwd\":\"/paperclip/workspaces/legacy\"}'::jsonb where name = 'smoke-claude_local'" >/dev/null
compose exec -T db psql -U kyoubeai -d postgres -v ON_ERROR_STOP=1 -Atqc "CREATE ROLE kyoube_rehearsal LOGIN SUPERUSER" >/dev/null
compose exec -T db psql -U kyoube_rehearsal -d postgres -v ON_ERROR_STOP=1 -Atqc "ALTER ROLE kyoubeai RENAME TO paperclip; ALTER DATABASE kyoubeai RENAME TO paperclip" >/dev/null
compose exec -T db psql -U paperclip -d postgres -v ON_ERROR_STOP=1 -Atqc "DROP ROLE kyoube_rehearsal" >/dev/null
docker volume create "${PROJECT}_paperclip-home" >/dev/null
MSYS_NO_PATHCONV=1 docker run --rm -v "${PROJECT}_kyoubeai-home:/from" -v "${PROJECT}_paperclip-home:/to" alpine:3.20 \
  sh -c 'cp -a /from/. /to/ && rm -rf /from/..?* /from/.[!.]* /from/* 2>/dev/null; ls -A /from | wc -l' | tr -d '\r' | grep -qx 0 \
  || { echo "could not move the home volume into the 0.1.x layout" >&2; exit 1; }
COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_ENV_FILES="$LEGACY_ENV" bash "$ROOT/scripts/migrate-from-0.1.sh" --no-backup | tee "$TMP/migrate.log"
for LINE in 'PAPERCLIP_PUBLIC_URL -> KYOUBE_PUBLIC_URL' 'PAPERCLIP_VERSION -> KYOUBE_CORE_VERSION' 'renaming role paperclip -> kyoubeai' 'renaming database paperclip -> kyoubeai' "copying ${PROJECT}_paperclip-home -> ${PROJECT}_kyoubeai-home" '1 stored path(s) still start with /paperclip/'; do
  grep -qF "$LINE" "$TMP/migrate.log" || { echo "migration log lacks: $LINE" >&2; exit 1; }
done
grep -q '^KYOUBE_PUBLIC_URL=' "$LEGACY_ENV" && ! grep -q '^PAPERCLIP_PUBLIC_URL=' "$LEGACY_ENV" || { echo ".env keys were not renamed" >&2; exit 1; }
DBS="$(compose exec -T db psql -U kyoubeai -d postgres -Atc 'select datname from pg_database order by 1' | tr -d '\r')"
grep -qx kyoubeai <<<"$DBS" && ! grep -qx paperclip <<<"$DBS" || { echo "databases after migration: $DBS" >&2; exit 1; }
compose exec -T db psql -U kyoubeai -d postgres -Atc "select count(*) from pg_roles where rolname in ('paperclip','kyoube_migrator')" | tr -d '\r' | grep -qx 0 \
  || { echo "legacy or temporary roles survived the migration" >&2; exit 1; }
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins")"
[[ "$STATUS" == "200" ]] || { echo "the board token stopped working after the migration: $STATUS" >&2; exit 1; }
compose exec -T app sh -c 'test -f /kyoubeai/kyoube/board-key.json && test -f /kyoubeai/.migrated-from-paperclip-home && test -L /paperclip && test -f /paperclip/kyoube/board-key.json' \
  || { echo "home volume, marker or compatibility link missing after the migration" >&2; exit 1; }
compose exec -T app kyoube doctor | tee "$TMP/doctor-migrated.log"
grep -Eq '^ok +legacy home link .*compatibility link active' "$TMP/doctor-migrated.log" || { echo "doctor did not report the compatibility link" >&2; exit 1; }
grep -Eq '^ok +legacy env +none' "$TMP/doctor-migrated.log" || { echo "doctor still sees legacy env keys" >&2; exit 1; }
# `--check` is tee'd rather than piped straight into `grep -q`: grep would exit on
# the first match and the script's next log line would die of SIGPIPE, which
# `set -o pipefail` turns into a spurious failure. It also puts the count in the log.
COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_ENV_FILES="$LEGACY_ENV" bash "$ROOT/scripts/migrate-from-0.1.sh" --check | tee "$TMP/check-legacy.log"
grep -q '1 stored path' "$TMP/check-legacy.log" || { echo "--check did not count the legacy agent path" >&2; exit 1; }
compose exec -T db psql -U kyoubeai -d kyoubeai -v ON_ERROR_STOP=1 -Atqc \
  "update agents set adapter_config = adapter_config || '{\"cwd\":\"/kyoubeai/workspaces/smoke\"}'::jsonb where name = 'smoke-claude_local'" >/dev/null
COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_ENV_FILES="$LEGACY_ENV" bash "$ROOT/scripts/migrate-from-0.1.sh" --check | tee "$TMP/check-clear.log"
grep -q '0 stored path' "$TMP/check-clear.log" || { echo "--check still counts a legacy path" >&2; exit 1; }
# Git Bash rewrites a bare POSIX path argument into a Windows one, so the marker
# path goes through `sh -c` (where it is part of a single non-path argument).
compose exec -T app sh -c 'rm -f /kyoubeai/.migrated-from-paperclip-home'
compose restart app
for i in $(seq 1 180); do
  if curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
  if [[ $i -eq 180 ]]; then echo "the app did not come back after removing the marker" >&2; exit 1; fi
done
compose exec -T app sh -c 'test ! -e /paperclip' || { echo "/paperclip still exists after the marker was removed" >&2; exit 1; }
echo "    0.1.x layout migrated: role/database renamed, home copied with the marker, link present, then gone with the marker"

echo "==> restore a 0.1.x-named backup"
# scripts/restore.sh has a second entry path: a backup directory written by a
# 0.1.x checkout, whose core dump and home archive carry the old names. Nothing
# else exercises it. A real 0.1.x backup is a cold build away, so this renames
# the 0.2.x backup taken in the disaster-recovery stage and re-checksums it.
#
# What that proves and what it does not: the *name* path — that restore.sh finds
# paperclip.dump / paperclip-home.tgz, restores both, and writes the migration
# marker so the entrypoint recreates /paperclip. The dump's own objects still
# belong to `kyoubeai` (pg_restore --no-owner ignores that anyway), so this is
# not a paperclip-owned cluster dump.
LEGACY_BACKUP="$TMP/legacy-backup"
rm -rf "$LEGACY_BACKUP"
cp -a "$BACKUP_PATH" "$LEGACY_BACKUP"
mv "$LEGACY_BACKUP/kyoubeai.dump" "$LEGACY_BACKUP/paperclip.dump"
mv "$LEGACY_BACKUP/kyoubeai-home.tgz" "$LEGACY_BACKUP/paperclip-home.tgz"
(cd "$LEGACY_BACKUP" && sha256sum paperclip.dump kyoube.dump roles.sql paperclip-home.tgz > SHA256SUMS)
COMPOSE_PROJECT_NAME="$PROJECT" COMPOSE_ENV_FILES="$ENV_FILE" \
  bash "$ROOT/scripts/restore.sh" "$LEGACY_BACKUP" | tee "$TMP/restore-legacy.log"
grep -q '0.1.x backup — leaving the migration marker' "$TMP/restore-legacy.log" \
  || { echo "restore.sh did not take its legacy-backup path" >&2; exit 1; }
for i in $(seq 1 300); do
  if curl -fsS "$BASE_URL/api/health" 2>/dev/null | jq -e '.bootstrapStatus == "ready"' >/dev/null 2>&1; then break; fi
  sleep 1
  if [[ $i -eq 300 ]]; then echo "the app never came back after the legacy-named restore" >&2; exit 1; fi
done
compose exec -T app sh -c 'test -f /kyoubeai/.migrated-from-paperclip-home && test -L /paperclip && test -f /paperclip/kyoube/board-key.json' \
  || { echo "the legacy-named restore left no marker or no /paperclip link" >&2; exit 1; }
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/plugins")"
[[ "$STATUS" == "200" ]] || { echo "the board token did not work after the legacy-named restore: $STATUS" >&2; exit 1; }
wait_for_plugin_api
compose exec -T app kyoube doctor | tee "$TMP/doctor-legacy-restore.log"
grep -Eq '^ok +legacy home link .*compatibility link active' "$TMP/doctor-legacy-restore.log" \
  || { echo "doctor did not report the compatibility link after the legacy-named restore" >&2; exit 1; }
# Back to the clean 0.2.x state the stage above left behind.
compose exec -T app sh -c 'rm -f /kyoubeai/.migrated-from-paperclip-home'
compose restart app
for i in $(seq 1 180); do
  if curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
  if [[ $i -eq 180 ]]; then echo "the app did not come back after clearing the marker again" >&2; exit 1; fi
done
compose exec -T app sh -c 'test ! -e /paperclip' || { echo "/paperclip survived the marker removal" >&2; exit 1; }
echo "    restore.sh read a 0.1.x-named backup, wrote the marker, and the link came and went with it"

echo "==> smoke passed"
