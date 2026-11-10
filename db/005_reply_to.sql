-- Optional Reply-To for campaigns and journeys. Runs on every migrate, so it must be idempotent.
ALTER TABLE campaigns   ADD COLUMN IF NOT EXISTS reply_to TEXT;
ALTER TABLE automations ADD COLUMN IF NOT EXISTS reply_to TEXT;
