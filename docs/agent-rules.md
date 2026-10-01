# Agent working rules

KyoubeAI keeps agents working the way a small team expects:

1. **An agent finishes its own task.** It does the work end to end and does not pass it, or parts
   of it, to another agent, or ask another agent to review or approve it. The exceptions: the person
   who started the task asks for that, or the agent's own **Handoffs** section names that agent.
2. **Approvals go to the person who started the task.** An agent asks that person, never another
   agent.
3. **Work moves up to a manager agent only with that person's decision.** An agent that cannot do a
   task hands it back to the person with a decision card: `"Escalate to <manager>"` or `"Keep it with
   <agent>"`.
4. **An agent with reports may orchestrate.** It does small tasks itself and splits big ones across
   its own team only.
5. **No extra tasks.** An agent does not create review, QA, follow-up or "let X know" tasks unless
   rule 1 or rule 4 allows it.

The core (Paperclip) teaches the opposite by default: its bundled skill tells agents never to ask a
human what an agent could do, and its default instructions say "ask QA, ask your boss". These rules
override that without changing any core file.

## How it works

| Part | What it does | Enforced by |
|---|---|---|
| Rules block | A marked block at the top of every agent's `AGENTS.md` with the five rules above, plus a `## Handoffs` section. The core puts `AGENTS.md` into the agent's system prompt. | The instructions themselves |
| People-only cards | The company setting that caps confirmation, question, checkbox, verdict and suggested-task cards at `human_only`. No agent can answer one, not even the one that asked. | The core |
| Protected managers | Every agent with a direct report is protected: another agent can assign it work only with a grant. Each manager holds one grant, for itself and everyone below it. The core's default "assign to anyone" grant is taken from every agent. | The core |
| Escalation | A decision card only a person can decide; on "Escalate" the core moves the task to the manager. | The core |

`kyoube agent-rules --watch` starts with the container. It runs as `node`, makes one pass a minute,
and writes only what differs:
- It writes the rules blocks and the company setting itself, through the core's REST API with the
  board key.
- It asks the `kyoube.agent-rules` plugin to set the managers' protection and grants. The core lets
  only a plugin set an agent's scoped grant.
- It records each pass in `/kyoubeai/.kyoube/agent-rules.json`, which `kyoube doctor` reads.

## Standing handoffs

To let an agent hand a kind of work to another agent without being asked each time, write it in that
agent's `## Handoffs` section, on its Instructions tab:

    ## Handoffs

    QA Agent tests every code change before it is marked done.

KyoubeAI never edits that section. Everything between `<!-- kyoube:working-rules v1 … -->` and
`<!-- /kyoube:working-rules -->` is replaced on the next pass, so put your own instructions outside it.

A handoff up to a manager always goes through the person, even when a Handoffs line names the
manager: the manager is protected.

## What the rules cannot stop

- An agent can still @-mention its manager in a comment. That wakes the manager, which can then take
  the task. The rules forbid it, and the task's history shows it.
- A manager can still assign work to an agent with no reports in another team.
- Agents can still create board approvals (`request_board_approval`). They go to every board member,
  because the core's approvals have no addressee. The rules limit them to spending and hiring.

## Check it

    docker compose exec app kyoube doctor

- `agent rules` is ok when the last pass was under 5 minutes ago, recorded no failure, and the
  self-test did not fail. The self-test asks the core's own assignment check whether a report can
  assign to its manager (it must not) and whether the manager can assign to the report (it must).
- `agent rules skipped` lists agents left alone on purpose:
  - one whose instructions are not a core-managed bundle
  - one still on the legacy prompt template
  - an `AGENTS.md` whose markers were damaged by hand
  - a manager whose authorization policy KyoubeAI does not change
  - an agent waiting for approval
  - an instructions bundle with no `AGENTS.md`

Run a pass by hand and see every message with `docker compose exec app kyoube agent-rules --once`.

Right after a container start, `agent rules` can show `no pass yet`, or a last pass more than
5 minutes old, until the loop's first pass. That pass comes within about a minute, because the loop
waits up to 30 s for the plugin worker. `./install.sh` and `./update.sh` run a pass themselves just
before their own `kyoube doctor`, so they normally never show this.

## Turn it off

1. Set `KYOUBE_AGENT_RULES=off` in `.env` and `docker compose up -d`.
2. `docker compose exec app kyoube agent-rules off`. This:
   - removes the blocks
   - puts the company setting back as it was
   - lifts the protection and grants KyoubeAI set
   - gives the default grant back to the agents it was taken from

It leaves the Handoffs sections, and does not put back the two "ask QA / ask your boss" sentences it
removed from the core's default text.

## After a core update

Nothing here patches the core, so a core update cannot quietly undo it. Everything lives in the
database, and the loop re-applies it every minute. A core that changes one of the calls this relies
on shows up twice:
- as a failed `agent rules` section in the smoke test, which CI runs against the pinned core and
  weekly against the core's next beta
- as a failed `agent rules` line in `kyoube doctor` on a running instance, naming the call the core
  no longer accepts

The calls this relies on:
- the company's `interactionResolverGovernance`
- an agent's authorization policy and grants, through the plugin SDK
- the instructions bundle routes
- decisions with an `assign_issue` effect
- the plugin routes answering 503 while the plugin worker starts, which the loop waits on
  before each pass
