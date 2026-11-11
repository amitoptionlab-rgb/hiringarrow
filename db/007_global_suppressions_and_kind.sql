-- Platform-wide do-not-contact (hard bounce / complaint) and recruiter/vendor kind.
-- Idempotent: migrate runs on every deploy.
CREATE TABLE IF NOT EXISTS global_suppressions (
  email            CITEXT PRIMARY KEY,
  reason           TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'complaint', 'manual')),
  source_tenant_id UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_kind_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_kind_check CHECK (kind IS NULL OR kind IN ('recruiter', 'vendor'));
