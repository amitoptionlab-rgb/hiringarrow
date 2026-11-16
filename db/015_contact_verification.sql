-- Contact-level email verification (004 signup verification se alag). Idempotent.
-- contacts.verification schema.sql me pehle se hai (nullable); NULL ko code 'unknown/valid' maanta hai (audience.js).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS verification text;
ALTER TABLE contacts ALTER COLUMN verification SET DEFAULT 'unknown';
  -- unknown | valid | risky | invalid | disposable
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS verification_reason     text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS verification_suggestion text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS verification_checked_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS soft_bounce_count       int NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS contacts_verification_idx ON contacts (tenant_id, verification);
