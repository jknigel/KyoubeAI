-- Typed decisions (docs/decisions.md): per-use switches and a daily cap beside the company's
-- Data-access settings, a per-day request counter, and a log of every answered question.
-- The log never holds the state, row values or question text.
ALTER TABLE kyoube_meta.company_settings
  ADD COLUMN IF NOT EXISTS decisions_agents boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS decisions_columns boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS decisions_apps boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS decisions_guardrail boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS decisions_daily_cap integer NOT NULL DEFAULT 10000 CHECK (decisions_daily_cap >= 0);

CREATE TABLE IF NOT EXISTS kyoube_meta.decision_usage (
  company_id text NOT NULL REFERENCES kyoube_meta.companies(company_id) ON DELETE CASCADE,
  day date NOT NULL,
  requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  PRIMARY KEY (company_id, day)
);

CREATE TABLE IF NOT EXISTS kyoube_meta.decisions (
  decision_id uuid NOT NULL,
  question_key text NOT NULL,
  company_id text NOT NULL REFERENCES kyoube_meta.companies(company_id) ON DELETE CASCADE,
  surface text NOT NULL CHECK (surface IN ('agents', 'columns', 'apps', 'guardrail')),
  actor_kind text NOT NULL,
  actor_id text,
  run_id text,
  via text,
  question_fingerprint text NOT NULL,
  question_type text NOT NULL CHECK (question_type IN ('choice', 'score', 'check')),
  answer text NOT NULL,
  confidence double precision NOT NULL,
  review_threshold double precision NOT NULL,
  status text NOT NULL CHECK (status IN ('auto', 'review')),
  outcome text CHECK (outcome IN ('human_confirmed', 'human_changed')),
  outcome_via text CHECK (outcome_via IN ('data_page', 'app')),
  outcome_by text,
  outcome_at timestamptz,
  model text NOT NULL,
  latency_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (decision_id, question_key)
);
CREATE INDEX IF NOT EXISTS decisions_company_created ON kyoube_meta.decisions (company_id, created_at);
CREATE INDEX IF NOT EXISTS decisions_company_fingerprint ON kyoube_meta.decisions (company_id, question_fingerprint);
