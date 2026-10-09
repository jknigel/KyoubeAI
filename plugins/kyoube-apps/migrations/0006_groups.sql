-- User groups (docs/groups.md): people, the agents they may assign, the apps they may open, and an
-- optional data level. An agent or app in no group is open to everyone; owners and admins are never
-- restricted. Ids only: people's names stay in the core.
CREATE TABLE IF NOT EXISTS kyoube_meta.groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL REFERENCES kyoube_meta.companies(company_id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  data_level text CHECK (data_level IN ('read', 'write', 'schema')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS groups_company_name ON kyoube_meta.groups (company_id, lower(name));

CREATE TABLE IF NOT EXISTS kyoube_meta.group_members (
  group_id uuid NOT NULL REFERENCES kyoube_meta.groups(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user ON kyoube_meta.group_members (user_id);

CREATE TABLE IF NOT EXISTS kyoube_meta.group_agents (
  group_id uuid NOT NULL REFERENCES kyoube_meta.groups(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  PRIMARY KEY (group_id, agent_id)
);

CREATE TABLE IF NOT EXISTS kyoube_meta.group_apps (
  group_id uuid NOT NULL REFERENCES kyoube_meta.groups(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES kyoube_meta.apps(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, app_id)
);
CREATE INDEX IF NOT EXISTS group_apps_app ON kyoube_meta.group_apps (app_id);

-- The last agent-rules sync of this company's group agents, as the watcher reported it.
CREATE TABLE IF NOT EXISTS kyoube_meta.group_sync (
  company_id text PRIMARY KEY REFERENCES kyoube_meta.companies(company_id) ON DELETE CASCADE,
  synced_at timestamptz NOT NULL,
  error text
);
