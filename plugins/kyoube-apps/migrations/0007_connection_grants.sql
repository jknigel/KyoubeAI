-- Which agents may call which connection (docs/connections.md). No row means no access. A grant names
-- a connection by name; renaming a connection in the plugin settings orphans the grant (the Data
-- access page lists orphans).
CREATE TABLE IF NOT EXISTS kyoube_meta.connection_grants (
  company_id text NOT NULL REFERENCES kyoube_meta.companies(company_id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  connection_name text NOT NULL,
  access text NOT NULL CHECK (access IN ('read', 'read-write')),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, agent_id, connection_name)
);
