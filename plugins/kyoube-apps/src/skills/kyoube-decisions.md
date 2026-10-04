---
name: kyoube-decisions
description: Ask the company's typed-decision model (Jev or another /v1/systemone model) closed questions — classify, score or check text, JSON or Data rows — through the Kyoube REST API or the kyoube.apps decisions_* tools. Use for many quick judgments with fixed answers; never instead of a person's approval.
---

# Kyoube Decisions

A typed decision asks a fast judge model closed questions about one piece of state and gets back a
fixed kind of answer: an option key (choice), a level (score) or true/false (check), each with a
`confidence` and a `status`. The model never writes text. The company chooses the provider and pays
for it, so it may be switched off; check before you rely on it.

## When to use it, and when not

Use it to classify, score or check many items (tickets, rows, messages), and to screen a risky step
before you take it. Do not use it to write anything, and do not use it for maths, dates, counts,
totals or comparisons: compute those in code and ask the model only the judgment you cannot compute.

A decision is never instead of a person's approval. If the working rules say a person decides, ask
that person. A `review` answer means: bring it to the person who started the task, with the answer
as a suggestion. Never act on a `review` answer on your own.

## Calling it

Same base URL and headers as the kyoube-data skill. Check once that decisions are available:

```sh
K="$PAPERCLIP_API_URL/api/plugins/kyoube.apps/api"
A="Authorization: Bearer $PAPERCLIP_API_KEY"
curl -fsS -H "$A" "$K/decisions/status?companyId=$PAPERCLIP_COMPANY_ID"
```

`available: false` means the company has not switched decisions on for agents or has no provider;
carry on without them and say so. Then ask, with free-form state:

```sh
curl -fsS -H "$A" -H 'Content-Type: application/json' -X POST "$K/decisions/decide" -d '{
  "companyId": "'"$PAPERCLIP_COMPANY_ID"'",
  "state": {"subject": "Charged twice", "body": "My card was charged twice for one order."},
  "questions": {
    "queue":   {"type": "choice", "instructions": "Which team owns this ticket?",
                "options": {"billing": "Payments, invoices, refunds", "technical": "Bugs and outages"}},
    "urgency": {"type": "score", "instructions": "How soon does this need a reply?",
                "levels": ["This week", "Today", "Within the hour"]},
    "refund":  {"type": "check", "statement": "The customer asks for their money back."}
  }
}'
```

or on Data rows, which are read under your own access (at most 50 ids per call; `fields` narrows
what is sent):

```sh
curl -fsS -H "$A" -H 'Content-Type: application/json' -X POST "$K/decisions/decide" \
  -d '{"companyId":"'"$PAPERCLIP_COMPANY_ID"'","rows":{"table":"tickets","ids":["<id>","<id>"],"fields":["subject","body"]},"questions":{...}}'
```

The tools are the same: `decisions_status` and `decisions_decide` (`state` or `rows`, `questions`).

## Writing good questions

- One idea per question. Put many questions on one state in one call rather than one call each.
- Every choice gets an `unsure` option automatically. An `unsure` answer is always `review`.
- Give options a short description when the key alone is ambiguous.
- Score levels go from low to high.
- A question can carry `"review": 0.95` to demand more confidence before an answer is `auto`. The
  default is 0.9.
- One decision per action. Do not chain several decisions with AND: their errors add up.

## Errors

`disabled` (switched off or no provider), `budget_exceeded` (today's cap is used up; stop and tell
the person), `too_large` (send less state), `provider_unavailable` or `timeout` (try once more later),
`provider_rejected` (the company's key or model is wrong; tell the person).
