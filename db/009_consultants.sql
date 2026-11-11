-- 009: consultants + resume search (Phase 1). Idempotent: migrate.js re-runs every file.
CREATE TABLE IF NOT EXISTS consultants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,   -- owner (bench company)
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  full_name      TEXT NOT NULL,
  title          TEXT NOT NULL,
  skills         TEXT[] NOT NULL DEFAULT '{}',
  experience_yrs NUMERIC(3,1),
  work_auth      TEXT CHECK (work_auth IN ('USC','GC','GC-EAD','H1B','H4-EAD','OPT','CPT','TN','Other')),
  engagement     TEXT[] NOT NULL DEFAULT '{}',          -- C2C, W2, 1099
  rate_usd_hr    NUMERIC(6,2),
  city           TEXT,
  state          TEXT,
  country        TEXT NOT NULL DEFAULT 'US',
  relocate       BOOLEAN NOT NULL DEFAULT false,
  remote_ok      BOOLEAN NOT NULL DEFAULT false,
  available_from DATE,
  status         TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','placed','inactive')),
  visibility     TEXT NOT NULL DEFAULT 'public'    CHECK (visibility IN ('public','private')),
  contact_email  CITEXT,                                -- never returned to other tenants
  contact_phone  TEXT,                                  -- never returned to other tenants
  resume_key     TEXT,                                  -- object-storage key, not a local path
  resume_text    TEXT,                                  -- extracted text, used for search
  search_doc     TSVECTOR,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION consultants_search_update() RETURNS trigger AS $$
BEGIN
  NEW.search_doc :=
    setweight(to_tsvector('simple', coalesce(NEW.title,'')), 'A') ||
    setweight(to_tsvector('simple', array_to_string(NEW.skills, ' ')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.resume_text,'')), 'C');
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_consultants_search ON consultants;
CREATE TRIGGER trg_consultants_search BEFORE INSERT OR UPDATE ON consultants
  FOR EACH ROW EXECUTE FUNCTION consultants_search_update();

CREATE INDEX IF NOT EXISTS idx_consultants_search ON consultants USING GIN (search_doc);
CREATE INDEX IF NOT EXISTS idx_consultants_skills ON consultants USING GIN (skills);
CREATE INDEX IF NOT EXISTS idx_consultants_tenant ON consultants (tenant_id);
CREATE INDEX IF NOT EXISTS idx_consultants_browse ON consultants (visibility, status, work_auth);
