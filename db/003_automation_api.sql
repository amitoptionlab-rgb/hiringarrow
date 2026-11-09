ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS kind            TEXT NOT NULL DEFAULT 'broadcast';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS automation_id   UUID;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS automation_step TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS send_time_opt   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE messages  ADD COLUMN IF NOT EXISTS provider        TEXT;
CREATE INDEX IF NOT EXISTS idx_campaigns_auto ON campaigns (automation_id, automation_step) WHERE kind = 'automation';

CREATE TABLE IF NOT EXISTS automations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),
  trigger_cfg  JSONB NOT NULL DEFAULT '{"type":"subscribed"}',
  from_name    TEXT,
  from_email   TEXT,
  steps        JSONB NOT NULL DEFAULT '[]',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS automation_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  tenant_id     UUID NOT NULL,
  contact_id    UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  step_idx      INT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','exited')),
  exit_reason   TEXT,
  next_run_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  UNIQUE (automation_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_runs_due ON automation_runs (next_run_at) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  key_hash     TEXT UNIQUE NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'write' CHECK (scope IN ('read','write')),
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
UPDATE plans SET features = features || '{"ai_agent": true}'::jsonb WHERE code IN ('growth', 'pro');
