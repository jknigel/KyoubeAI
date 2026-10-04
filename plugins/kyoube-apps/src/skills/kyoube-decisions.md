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

For answers kept in a Data table and refreshed automatically, use an AI column (kyoube-data skill, "AI columns").

## The guardrail on risky actions

A company can turn on a guardrail that checks your riskiest Kyoube calls before they run: dropping,
renaming or removing from a table, bulk updates and deletes (a `where` filter, or more than 20 ids),
and publishing, rolling back or archiving an app. While it is on, those calls need `issueId`, the id
of the task you are working on, which your run has as `$PAPERCLIP_TASK_ID`:

```sh
curl -sS -H "$A" -H 'Content-Type: application/json' -X POST "$K/tables/scratch_import/drop" \
  -d '{"companyId":"'"$PAPERCLIP_COMPANY_ID"'","issueId":"'"$PAPERCLIP_TASK_ID"'"}'
```

The tools take the same `issueId` parameter. What can come back:

- Success: the check found the call part of your task and not dangerous. It ran.
- `guardrail_context_required` (428): pass `issueId`, and make sure it is your own task.
- `not_found`: the table, field or app does not exist. No card is raised.
- `held` (409) with a `confirmationId`: a person has to allow this call. A card is on your task.
  Stop working on this step and wait; you are woken when they answer. Then send exactly the same
  call again with `"confirmationId"` added. An allowed call runs once.
- `rejected_by_person` (403): the person declined. Never try the same thing another way (a
  different filter, smaller batches, another route). Ask them what they want instead.
- `conflict` (409) on a retry: that confirmation was used or is more than 24 hours old. Send the
  call without `confirmationId` to have it checked again.

Only a person can release a held call. You cannot answer the card, and once a call of yours has
been held, the same call is never re-checked by the model while the hold is still unused: it goes
straight to a new card. A bulk update or delete made from inside a running app is refused with
`guardrail_context_required` while the guardrail is on; use the REST routes or tools with `issueId`.
