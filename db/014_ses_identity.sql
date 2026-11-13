-- SES identity per sending domain. Idempotent: migrate.js runs every db/NNN_*.sql on every run.
ALTER TABLE sending_domains ADD COLUMN IF NOT EXISTS ses_dkim_tokens TEXT[];
ALTER TABLE sending_domains ADD COLUMN IF NOT EXISTS ses_status TEXT;
