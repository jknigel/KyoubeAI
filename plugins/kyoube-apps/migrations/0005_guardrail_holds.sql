-- The guardrail on risky agent actions (docs/decisions.md): one row per held action, tied to the
-- human-only confirmation card that holds it. A row is used at most once (consumed_at) and only
-- within 24 hours (expires_at). It names the action by a hash of its exact parameters, never by
-- their values.
CREATE TABLE IF NOT EXISTS kyoube_meta.guardrail_holds (
  id uuid PRIMARY KEY,
  company_id text NOT NULL REFERENCES kyoube_meta.companies(company_id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  issue_id text NOT NULL,
  card_id text NOT NULL,
  action_fingerprint text NOT NULL,
  operation text NOT NULL,
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, card_id)
);
CREATE INDEX IF NOT EXISTS guardrail_holds_live ON kyoube_meta.guardrail_holds (company_id, agent_id, issue_id, action_fingerprint) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS guardrail_holds_expires ON kyoube_meta.guardrail_holds (expires_at);
