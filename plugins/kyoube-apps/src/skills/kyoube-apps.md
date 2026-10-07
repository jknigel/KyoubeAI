---
name: kyoube-apps
description: Build, update, and publish KyoubeAI apps — single-file HTML applications that run inside the KyoubeAI UI and use the company's Kyoube Data tables through window.kyoube — through the Kyoube REST API (or the kyoube.apps tools when your harness lists them). Use when a task asks for a CRM, tracker, dashboard, form, or any internal tool over company data.
---

# Kyoube Apps

An app is **one HTML document** (inline CSS and JavaScript, no external URLs — an injected
Content-Security-Policy blocks all network access and remote scripts, though `data:`/`blob:` images
and `data:` fonts still work since they never leave the document) plus a **manifest** that declares
which Data tables it uses. Users open apps at `/<company>/app-artifact/<slug>`. Apps run in a sandboxed
iframe with an opaque origin (no cookies, no storage, no host DOM); the only way to reach data is `window.kyoube`.

Never build an app any other way. A server on its own port, a file in the workspace, or a page hosted
elsewhere is not a Kyoube app: nobody can open it from the Apps page and it has no access to the data.

## How to call the API

Same credentials and base URL as the `kyoube-data` skill: `$PAPERCLIP_API_URL/api/plugins/kyoube.apps/api`,
`Authorization: Bearer $PAPERCLIP_API_KEY`, and the company as `?companyId=$PAPERCLIP_COMPANY_ID` on `GET`
or `"companyId"` in every `POST` body.

| Operation | Method and path | POST body fields (besides `companyId`) |
|---|---|---|
| List apps | `GET /apps` | — |
| Read an app | `GET /apps/{slug}?version=latest` (or `current`, or a number) | — |
| Create (draft v1) | `POST /apps` | `manifest`, `source`, `notes?` |
| Update (new draft) | `POST /apps/{slug}` | `manifest`, `source`, `notes?` |
| Publish | `POST /apps/{slug}/publish` | `version?` (default: latest draft); a version that adds or changes decision sets needs a person to publish it |
| Roll back | `POST /apps/{slug}/rollback` | `version` |
| Archive | `POST /apps/{slug}/archive` | — |

Put the HTML in the JSON as a string — write it to a file and let a tool encode it, for example
`jq -n --arg c "$PAPERCLIP_COMPANY_ID" --rawfile s app.html --argjson m "$(cat manifest.json)" '{companyId:$c, manifest:$m, source:$s}'`
piped to `curl -fsS -H "$A" -H 'Content-Type: application/json' -X POST "$K/apps" -d @-`.

If your harness lists tools named `kyoube.apps:apps_*` (`apps_create`, `apps_update`, `apps_publish`,
`apps_rollback`, …), they are these same operations; use whichever you have.

## Typed decisions in an app

An app can ask the company's typed-decision model closed questions about one of its rows, or about a
form the person is filling in. Declare each set of questions in the manifest under `"decisions"`:
the table (one the manifest declares), the fields the set may send, and the questions (the same
`choice` / `score` / `check` shapes as the kyoube-decisions skill). At most 10 sets.

```json
"decisions": {
  "triage": {
    "table": "tickets", "fields": ["subject", "body"],
    "questions": {
      "queue":   { "type": "choice", "instructions": "Which team owns this ticket?", "options": { "billing": null, "technical": null } },
      "urgency": { "type": "score", "instructions": "How soon does this need a reply?", "levels": ["This week", "Today", "Within the hour"] }
    }
  }
}
```

```js
const ctx = await kyoube.ready();
if (ctx.decisions.available) {                       // false when the company has not switched apps on
  const r = await kyoube.decide("triage", { rowId: ticket.id });            // or { values: { subject, body } }
  if (r.answers.queue.status === "review") showReviewLane(ticket, r);        // never act on review alone
  else await kyoube.data.update("tickets", { ids: [ticket.id] }, { queue: r.answers.queue.value });
}
// In the review lane, once the person picks a value:
await kyoube.decideOutcome(r.decisionId, "queue", chosenQueue);
```

Rules:

- The app never sends text of its own: the host builds the question's state from the set's fields.
  `values` may only name the set's fields, and each must fit its field kind.
- Every choice gets an `unsure` option, and an `unsure` answer is always `review`. Build a review lane
  that shows the suggestion to the person and calls `kyoube.decideOutcome` with what they chose.
- Compute dates, totals, counts and comparisons in code; ask the model only the judgment.
- A set that decides anything about a person's employment, credit, housing, health, education or
  legal status must be `"advisory": true`: every answer is then `review`.
- A version that adds or changes decision sets needs a person to publish it. Save the draft with
  `apps_update` and ask the person who started the task to publish it from the Apps page, where they
  see what the sets send. You can still publish versions whose sets did not change.
- Ship a small fixture table with the app (a few rows covering each answer and `review`) so its
  branches can be checked without a browser, and say in the version notes how to use it.
- Errors arrive as `kyoube.Error` with `code` `disabled`, `budget_exceeded`, `too_large`,
  `provider_rejected`, `provider_unavailable`, `timeout`, `limit` (more than 10 decisions in 10
  seconds), `forbidden` (the viewer cannot read the set's table, or the running version does not
  declare the set) or `not_found` (the row is gone). Show a short message and let the person carry
  on by hand.

## Workflow

1. Design or reuse tables with the `kyoube-data` skill (list tables, create tables).
2. Create the app with a manifest and the full source. This makes **draft version 1**.
3. Test in the browser? You cannot — ask the user to open the app; or reason carefully and keep the UI simple.
4. Publish (needs `schema` access; if you only have `write` access, ask an admin to publish from the app page).
5. Iterate with update (new draft version) → publish. Roll back restores an earlier version.

## Manifest

```json
{ "name": "Sales CRM", "slug": "sales-crm", "icon": "📇", "description": "Contacts and deals",
  "tables": [ { "name": "contacts", "access": "readwrite" }, { "name": "deals", "access": "readwrite" } ] }
```
`access` is `read` (default) or `readwrite`. A call on an undeclared table is rejected. The viewer's own
level still applies: a `viewer` can never write, whatever the app declares.

The gallery shows the **published** version's `name`, `icon` and `description`, so renaming an app in a
draft changes nothing anyone sees until you publish it — say so rather than telling the user the rename
has happened.

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
`viewer.name` is always `""` in v1 (the host gives the worker ids, not display names) — use `viewer.id`,
or nothing; branch on `viewer.level` (`read`, `write`, `schema`) to hide controls the viewer cannot use.

## Rules for the source

- Start with `<!doctype html>`; put CSS in `<style>` and JS in `<script>` — no `src=`, `href=` to the network, no `fetch`.
- No `eval` and no `new Function`: the policy carries no `'unsafe-eval'`, so both throw.
- Use `kyoube.ready()` before the first data call; render loading and error states; keep lists paged (`limit` ≤ 200).
- Use semantic HTML and plain CSS; it must be readable on a 1024px-wide panel, on a 375px-wide phone, and in dark mode (`prefers-color-scheme`). On a phone: forms wrap (`flex-wrap: wrap`), wide tables scroll inside their own box (`overflow-x: auto`) or become one card per row, and every button and input is at least 44px tall.
- **Never navigate the frame.** Assigning `location`, linking to another document, or submitting a form
  stops the app: a second page load is treated as the app navigating away, the `window.kyoube` bridge
  dies, and the frame is replaced with a notice. Use `kyoube.ui.openApp(slug)` to open another app, keep
  links in-page (`href="#…"`), and `preventDefault()` on every form submit.
- **Stay inside the call budget:** 60 requests per rolling 10 seconds per app frame, of which at
  most 5 may be toasts. Every call counts, including ones the host rejects. Over the ceiling a call
  throws `kyoube.Error` with `code: "limit"`; an over-quota toast is dropped; three limited windows
  in a row stop the app. Batch — one `query` with a `limit` beats sixty `get`s, and `insert` takes an
  array — and never poll on a timer faster than a few seconds.
- No `<link rel="dns-prefetch">` and no `<link rel="preconnect">`: they are the one network-shaped
  thing the policy does not govern, so they are forbidden by rule rather than by the browser. They
  fetch nothing for you regardless.
- Never store secrets or tokens in the app; never assume other companies' data exists.
- Keep the whole file under 2 MiB (usually well under 100 KB).
- `window.kyoube` is the only way to reach the host, and it is the only thing that can: the runner
  hands the SDK a per-mount handshake nonce before your code is parsed and refuses messages without
  it, so hand-rolled `postMessage` calls do nothing and three of them stop the app. The SDK deletes
  the global and removes the script that carried it as it installs, and it binds `window.parent`
  before your code is parsed — so the nonce is reachable through neither `window`, the DOM, nor the
  SDK's own outgoing messages. Everything you are meant to have, you get from `kyoube.ready()`,
  which is also how you wait for the context.

## Minimal example

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Contacts</title>
<style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}form{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}input{flex:1 1 140px;min-width:0;min-height:44px}button{min-height:44px}.scroll{overflow-x:auto}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}td,th{border-color:#333}}</style>
</head><body>
<h1>Contacts</h1>
<form id="f"><input name="name" placeholder="Name" required><input name="email" placeholder="Email"><button>Add</button></form>
<div class="scroll"><table><thead><tr><th>Name</th><th>Email</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
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

## Reporting back

Tell the user the app's slug and link (`/<company>/app-artifact/<slug>`), which version is published and
which is the latest draft, and which tables it uses.

To classify, score or check rows with the company's typed-decision model, see the kyoube-decisions
skill (`POST /decisions/decide` with `rows`).

If the company's guardrail is on, `apps_publish`, `apps_rollback` and `apps_archive` (and their REST
routes) need `issueId` set to your task's id, `$PAPERCLIP_TASK_ID`. A `held` answer means stop and
wait for the person; see the kyoube-decisions skill.
