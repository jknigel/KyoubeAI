CREATE SCHEMA IF NOT EXISTS kyoube_meta;

CREATE TABLE IF NOT EXISTS kyoube_meta.migrations (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kyoube_meta.companies (
  company_id text PRIMARY KEY,
  schema_name text NOT NULL UNIQUE,
  role_name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kyoube_meta.company_settings (
  company_id text PRIMARY KEY REFERENCES kyoube_meta.companies(company_id) ON DELETE CASCADE,
  default_agent_level text NOT NULL DEFAULT 'none',
  hard_delete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kyoube_meta.agent_grants (
  company_id text NOT NULL REFERENCES kyoube_meta.companies(company_id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  level text NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, agent_id)
);

CREATE TABLE IF NOT EXISTS kyoube_meta.tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL REFERENCES kyoube_meta.companies(company_id) ON DELETE CASCADE,
  name text NOT NULL,
  display_name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  trash_name text,
  trashed_at timestamptz,
  created_by_kind text,
  created_by_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Only *live* table names are unique per company: a trashed table keeps its row
-- (status 'trashed') for the 30-day restore window, and the name it vacated must
-- be immediately reusable. A plain UNIQUE (company_id, name) would block that.
CREATE UNIQUE INDEX IF NOT EXISTS tables_company_name_active_idx
  ON kyoube_meta.tables (company_id, name) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS kyoube_meta.fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES kyoube_meta.tables(id) ON DELETE CASCADE,
  name text NOT NULL,
  display_name text NOT NULL,
  description text,
  kind text NOT NULL,
  required boolean NOT NULL DEFAULT false,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (table_id, name)
);

CREATE TABLE IF NOT EXISTS kyoube_meta.audit (
  id bigserial PRIMARY KEY,
  company_id text NOT NULL,
  actor_kind text NOT NULL,
  actor_id text,
  run_id text,
  operation text NOT NULL,
  table_name text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_company_created_idx ON kyoube_meta.audit (company_id, created_at DESC);
