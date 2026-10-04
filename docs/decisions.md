# Typed decisions

Typed decisions let an agent ask a fast judge model closed questions and get back answers it can
branch on. This page covers how an instance admin sets a provider up, how a company admin switches
uses on, what leaves the server, and how agents call it. The code is in
`plugins/kyoube-apps/src/decisions/`.

## What typed decisions are

A typed decision sends one piece of state (some text, a JSON object, or a Data row) and a set of named
questions to a judge model such as Jev (TypeSafe AI), which serves the shared `/v1/systemone` request
format. Each question has a fixed kind of answer: a choice (one option key), a score (one level, low to
high) or a check (true or false). The model never writes text. It answers in well under a second and
costs a few cents per million input tokens, so it suits many quick judgments: sorting tickets, scoring
leads, screening a risky step before it is taken.

Nothing in KyoubeAI could make a judgment before this. Agents could only classify by spending a full
language-model run on it, and a Kyoube App had no intelligent bridge method. A typed decision returns a
closed value, so code can branch on it and a person can review the rule behind it. Every answer carries
a `confidence` and a `status` (`auto` or `review`). Treat the confidence as a ranking score, not a
calibrated probability: in the nibzard benchmark on Banking77, answers kept above the threshold covered
51.2% of the inputs at a 3.68% error rate, which is good for triage and not a promise about any single
answer. Anything below the threshold, and every `unsure` answer, comes back as `review`, meaning a
person should look at it.

## Setting up a provider

An instance admin does this once per company.

1. Create a company secret that holds the provider's API key (Company, then Secrets).
2. Open Settings, then Plugins, then Kyoube Data & Apps. Pick the company.
3. Choose the provider, pick the secret as the API key, and set a pinned model.

| Provider | Base URL | Example model |
|---|---|---|
| `typesafe` | `https://api.typesafe.ai` | `jev-1.13.0` |
| `openrouter` | `https://openrouter.ai/api` | `typesafe/jev-1.13` |
| `vercel` | `https://ai-gateway.vercel.sh/typesafe` | `typesafe-ai/jev` |
| `custom` | your own, set in the base URL field | whatever the server serves |

The worker calls `<base URL>/v1/systemone`. A custom base URL must start with `https://` and must not
carry credentials, a query or a fragment. Model names ending in `latest` are refused, because the
answers behind them change without notice; pin a version. The core refuses private and reserved
addresses for every plugin request, so a self-hosted server has to be reachable at a public HTTPS
address.

Until a provider is set, typed decisions stay off for that company.

## Switching uses on

A company admin opens Company Settings, then Data access, then Typed decisions. There are four
switches, one per use: Agents, AI columns, Kyoube Apps, and the guardrail on risky agent actions. All
are off by default. The page also shows the provider, the model, whether the key resolves, and how many
requests have been used today. All four uses work in this release.

Turning AI columns off pauses filling and keeps every value already written. Cells waiting for review
stay where they are, and filling carries on when the switch goes back on.

The daily cap limits provider requests per company per UTC day, and all four uses share it. The
default is 10,000, and one row counts as one request. A request that fails at the provider does not
use up budget.

AI columns keep out of the last tenth of the cap: the fill stops once the day's usage reaches 90% of
it, rounded down (a cap of 10,000 gives the fill 9,000; under a cap of 10 the fill gets nothing). A
large backfill therefore always leaves room for agents, apps and the guardrail, which can use the cap
in full. When the cap is reached, agents and apps get `budget_exceeded` (429) until midnight UTC, the
fill carries on the next day, and the guardrail cannot run its check, so every covered agent action
waits on a card for a person.

The worker keeps a resolved key in memory for up to 60 seconds per company, because the core limits
secret lookups to 30 a minute. It is dropped when the plugin config is saved, so a new key takes effect
at once. The key is never logged or stored anywhere else.

## The guardrail

With **Guardrail on risky agent actions** switched on, Kyoube checks these calls when an agent makes
them, over REST or tools: dropping or renaming a table, removing a field, updating or deleting rows
with a `where` filter or more than 20 ids (the bulk rule), and publishing, rolling back or archiving an
app. People are never checked.

The check only ever adds friction. It runs after the agent's own access level has allowed the call,
and a pass lets the call go ahead exactly as it would have without the guardrail. A call whose table,
field or app does not exist answers `not_found` and raises no card. The model is asked two fixed
questions about the action and the agent's task: whether the action is something the task asks for or
clearly needs, and how risky it is (`routine`, `notable`, `dangerous`). The action goes ahead only when
both answers clear the review threshold, the action matches the task and it is not dangerous.

Anything else, including a check that cannot run because the provider is down, the budget is used up
or no provider is set (it fails closed), raises a confirmation card on the agent's task. The card is
people-only: `resolverPolicy: "human_only"`, and Kyoube also refuses an answer that came from an agent.
"Allow once" lets the agent send exactly the same call again with the `confirmationId`, once, within 24
hours. "Don't allow" ends it, and the agent is told `rejected_by_person`. The agent has to name its task
(`issueId`, which its run has as `$PAPERCLIP_TASK_ID`); a call without one, or naming a task that is
not assigned to it, is refused with `guardrail_context_required`.

The `held` answer (409) carries the confirmation id in `details` and in its message. A plain identical
retry that matches a live hold is treated as the same retry.

A hold binds to what the person was shown on the card:

- The exact call, including the table's own identity. A table dropped and made again under the same
  name is a different table, so an allowance for the old one does not match it (`invalid`). For app
  actions it is the app's and version's identity, so an allowance for one app does not carry to another.
- The number of rows the card showed. If an allowed call would now touch more rows (a `where` filter
  that matches more than it did, or a table that has grown), it does not run: a new card asks the person
  again with the new count, without asking the model, and the agent gets `held` with the new card's
  id. The old `confirmationId` leads to the new card. A call that now touches the same or fewer rows
  runs.

Only a person can release a held action. Once an agent's action has been held, the same agent's
identical action is never re-checked by the model while an unconsumed hold exists within the holds'
retention: it goes straight to a new card. Closing a card, or waiting out a rejection, does not let the
agent ask the model again.

An agent's bulk update or delete through a running app (`apps.data`) cannot carry an `issueId`, so it
is refused with `guardrail_context_required` while the guardrail is on. Agents use the REST routes or
tools with `issueId` instead.

| Agent sees | HTTP | Meaning |
|---|---|---|
| `guardrail_context_required` | 428 | Pass `issueId`, the agent's own task (also: the call carries no agent id) |
| `held` + `confirmationId` | 409 | Waiting for a person on the card |
| `rejected_by_person` | 403 | A person declined |
| `forbidden` | 403 | The card was answered by an agent, not a person, so the action stays held |
| `invalid` | 400 | The `confirmationId` is from a different call, agent or task, or for a table since dropped and made again |
| `conflict` | 409 | The confirmation was already used, or expired |

The guardrail's check gives the provider 12 seconds rather than the usual 20, so the check, the row
count and the action itself fit in the core's 30 second limit for plugin requests.

## What leaves the server

Nothing is sent while a use is switched off. Per use:

- Agents: whatever state the agent sends, or the fields of the Data rows it names. Rows are read under
  the agent's own access, so an agent cannot send a row it could not read. At most 50 row ids go in one
  call, and `fields` narrows what is sent.
- AI columns: for every row, the values of the column's source fields, as one JSON object, each time a
  source changes or someone presses Refill. Nothing else from the row, and nothing while AI columns are
  switched off.
- Apps: for each call, the fields the decision set declares, from one row (read under the viewer's own
  access) or from the values the person typed, plus the set's questions. Nothing else from the app
  reaches the provider.
- The guardrail: the operation (for example `drop_table`), the table, field and app names it touches,
  the number of affected rows, and the agent's task title and description (up to 8,000 characters). It
  never sends row values, filters, patches or ids.

Each request goes to the provider you configured, over HTTPS, through the core's own HTTP client. A
request is at most 96 KB.

## In Kyoube Apps

Apps declare decision sets in their manifest and call `kyoube.decide` and `kyoube.decideOutcome`; the
details are in [Typed decisions](apps.md#typed-decisions). Every call passes four gates, in this order:

1. The app is published to the viewer.
2. The version the viewer is running declares the set.
3. The viewer can read the set's table. The host then builds the state from the set's own fields, a
   row read under the viewer's access or values checked per field kind; the app cannot send anything
   else.
4. The company has switched Kyoube Apps on, a provider is configured, and the daily budget has room.

Each frame may also make at most 10 decisions per 10 seconds.

Publish rules: a version that adds or changes decision sets needs a person to publish it, after the
Apps page has shown what the sets send, and the request carries `decisionsConfirmed`. Rollback follows
the same rule; removing sets needs no person. Sets that judge a person's employment, credit, housing,
health, education or legal status are marked `advisory`, so every answer goes to review. The publish is
recorded in the activity feed with the set names, never with the questions or any row values.

## Provider data terms (as of 2026-10-04)

Check these yourself before relying on them; terms change.

- TypeSafe hosts in the US only. Its stated position is that "Jev is not trained on customer requests
  or responses". It states no retention period, and zero data retention is offered to enterprise
  customers only.
- OpenRouter caps the context at 32k tokens for this model.
- Routed through OpenRouter or Vercel AI Gateway, the router's terms apply to your data as well as
  TypeSafe's. Read the router's terms.

## For agents

Two REST routes, under `/api/plugins/kyoube.apps/api`:

- `GET /decisions/status` tells an agent whether decisions are available (`available`, `enabled`,
  `configured`) and how much budget is left.
- `POST /decisions/decide` takes `companyId`, either `state` (text or a JSON object) or `rows`
  (`table`, `ids`, optional `fields`), and `questions`. It returns `decisionId`, `model` and an answer
  per question.

The same two operations are the tools `decisions_status` and `decisions_decide`. The managed skill
`kyoube-decisions` (`plugins/kyoube-apps/src/skills/kyoube-decisions.md`) teaches agents when to use
them: closed judgments over many items, never maths or dates, and never in place of a person's
approval. Every choice question gets an `unsure` option added, and `unsure` always comes back as
`review`.

## AI columns

An AI column is an ordinary Data field with a `decision` block in its options: one question and the
fields of the same row it reads (`sourceFields`, 1 to 20; relations and other AI columns are not
allowed, and a column cannot read itself). The question sets the kind of field: a choice or a score
makes a `select` whose options come from the question (a choice's `unsure` is never an option), and a
check makes a `boolean`. An AI column cannot be required, because a cell waiting for review is empty.
Creating one needs schema access and the AI columns switch; removing one needs only schema access.
Removing a source field is refused while an AI column reads it.

**How filling works.** The `fill-ai-columns` job runs every 5 minutes. Creating a column, changing its
question and pressing Refill each start a fill in the background at once; new and edited rows wait for
the next scheduled run. A run handles at most 2,000 rows per company. It stops at its share of the
daily cap (90%, see [Switching uses on](#switching-uses-on)), at a provider error, or after 4 minutes,
and carries on in the next run. A row whose source values have not changed is never asked
again. Cells that failed are retried after new and changed rows, with whatever is left of the 2,000.
The scan lags the database clock by 2 minutes, so a row committed late is still picked up.

**Cells.** Each cell has a status:

- `auto`: the model was confident, so the value is written.
- `review`: below the threshold, `unsure`, or any answer in an `advisory` column. The value stays
  empty and the model's suggestion and confidence are kept.
- `manual`: a person (or an agent) set the value. The model never overwrites it.
- `error`: the provider failed for that row. The cell stays empty and is retried.

**On the Data page.** An AI column shows an AI marker in its header and, under it, "Sends *fields* to
*provider*", the number of cells "N to review" and a Refill button (schema access). A cell waiting for
review reads "Suggested: *value* (72%)" with Accept and Change. The row forms (add and edit) leave AI
columns out; an AI cell changes through Accept and Change only.

**Edits.** Writing a different value into an AI cell makes it `manual`. Writing the value it already
has changes nothing. A person's Accept or Change on a suggested cell is logged as confirmed or changed,
which is the human outcome kept in the decision log. Writing null hands the cell back to the model,
which asks again on the next run. Refill discards every cell that is not manual and asks again.
Changing a choice or score column's question empties every value the new options no longer include,
`manual` ones too, and those rows are asked again.

**Advisory columns.** Set `"advisory": true` on a column that judges anything about a person
(employment, credit, housing, health, education, legal status). Every answer then waits for a person,
however confident.

**Review route and tool.** `GET /tables/:table/review?field=&limit=&offset=` (tool `data_list_review`,
read access) lists the cells waiting for review: `rowId`, `field`, `suggestion`, `confidence`,
`decisionId` and `updatedAt`. `POST /tables/:table/fields/:field/refill` asks again.

## What is logged

- The decision log keeps, per answer, the company, surface, actor, model, question key and type, a
  fingerprint of the question, the answer, the confidence and the status. It keeps no state, no row
  values and no question text. Entries and daily usage are purged after 90 days.
- Each call writes one activity line, for example `Kyoube decisions: an agent asked 3 question(s): 2
  auto, 1 review (jev-1.13.0)`. It carries the counts and the model, never the content.
- Saving the decision settings writes an audit row (`set_decision_settings`) and an activity line
  (`settings updated`).

The API key, the state, row values and provider response bodies are never logged.

## Errors

| Code | HTTP | When |
|---|---|---|
| `invalid` | 400 | The request fails the schema |
| `disabled` | 403 | The use is switched off, or the company has no usable provider config |
| `budget_exceeded` | 429 | The daily cap is reached |
| `too_large` | 413 | Over 96 KB, or the provider says the context is too long |
| `provider_rejected` | 502 | 401, 403 or another 4xx from the provider, including a bad key |
| `provider_unavailable` | 503 | 429, 529 or 5xx from the provider after retries |
| `timeout` | 504 | The provider did not answer in time |

A provider request has a 20 second deadline and is retried up to twice on 429, 529, 5xx and network
errors. A whole call has 25 seconds, below the core's 30 second limit for plugin requests.
