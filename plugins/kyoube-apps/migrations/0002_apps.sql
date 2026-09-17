CREATE TABLE IF NOT EXISTS kyoube_meta.apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL REFERENCES kyoube_meta.companies(company_id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  icon text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  -- No FK from current_version to app_versions: the two tables already cascade
  -- from apps, and a circular reference would only make that delete order
  -- harder to reason about for a value AppStore.setCurrent already checks.
  current_version integer,
  latest_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Archiving is a terminal soft delete in Phase 3 (no unarchive tool, route, or
-- action -- ruling P3-R10), so only a *live* (non-archived) app's slug must
-- stay unique per company; once an app is archived, its slug is immediately
-- reusable. Mirrors tables_company_name_active_idx in 0001_meta.sql, which
-- frees a trashed table's name the same way.
CREATE UNIQUE INDEX IF NOT EXISTS apps_company_slug_live_idx
  ON kyoube_meta.apps (company_id, slug) WHERE status <> 'archived';

CREATE TABLE IF NOT EXISTS kyoube_meta.app_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES kyoube_meta.apps(id) ON DELETE CASCADE,
  version integer NOT NULL,
  manifest jsonb NOT NULL,
  source text NOT NULL,
  created_by_kind text NOT NULL,
  created_by_id text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, version)
);
