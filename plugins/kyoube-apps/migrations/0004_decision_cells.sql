-- AI columns (docs/decisions.md): the fill state of every AI cell, beside the user's table so the
-- user's schema stays clean, and one keyset watermark per AI column. Both go with their field.
CREATE TABLE IF NOT EXISTS kyoube_meta.decision_columns (
  field_id uuid PRIMARY KEY REFERENCES kyoube_meta.fields(id) ON DELETE CASCADE,
  company_id text NOT NULL REFERENCES kyoube_meta.companies(company_id) ON DELETE CASCADE,
  table_id uuid NOT NULL REFERENCES kyoube_meta.tables(id) ON DELETE CASCADE,
  -- The column's question, sources, threshold and advisory flag; a change resets the watermark.
  fingerprint text NOT NULL,
  scanned_through_at timestamptz,
  scanned_through_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kyoube_meta.decision_cells (
  field_id uuid NOT NULL REFERENCES kyoube_meta.fields(id) ON DELETE CASCADE,
  row_id uuid NOT NULL,
  company_id text NOT NULL REFERENCES kyoube_meta.companies(company_id) ON DELETE CASCADE,
  table_id uuid NOT NULL REFERENCES kyoube_meta.tables(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('auto', 'review', 'manual', 'error')),
  -- The model's last answer as text (option key, level, 'true'/'false'); never a source value.
  suggestion text,
  confidence double precision,
  decision_id uuid,
  source_hash text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (field_id, row_id)
);
CREATE INDEX IF NOT EXISTS decision_cells_field_status ON kyoube_meta.decision_cells (field_id, status, updated_at);
