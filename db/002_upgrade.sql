-- Idempotent upgrades (run on every migrate)
ALTER TABLE messages  ADD COLUMN IF NOT EXISTS variant   CHAR(1) NOT NULL DEFAULT 'A';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS subject_b TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ab_split  INT NOT NULL DEFAULT 50;
CREATE INDEX IF NOT EXISTS idx_campaigns_due ON campaigns (scheduled_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_contacts_engaged ON contacts (tenant_id, last_engaged_at);
