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
requests have been used today. Only Agents is wired up in this release; the other three switches are
there for the features that follow and do nothing yet.

The daily cap limits provider requests per company per UTC day. The default is 10,000, and one row
counts as one request. A request that fails at the provider does not use up budget.

The worker keeps a resolved key in memory for up to 60 seconds per company, because the core limits
secret lookups to 30 a minute. It is dropped when the plugin config is saved, so a new key takes effect
at once. The key is never logged or stored anywhere else.

## What leaves the server

Nothing is sent while a use is switched off. Per use:

- Agents: whatever state the agent sends, or the fields of the Data rows it names. Rows are read under
  the agent's own access, so an agent cannot send a row it could not read. At most 50 row ids go in one
  call, and `fields` narrows what is sent.
- AI columns, apps and the guardrail: later releases fill these in, and this page will list what each
  sends when they land.

Each request goes to the provider you configured, over HTTPS, through the core's own HTTP client. A
request is at most 96 KB.

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
