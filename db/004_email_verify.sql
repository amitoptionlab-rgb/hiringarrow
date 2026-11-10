-- Email verification for new signups. Runs on every migrate, so it must be idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email_verified_at') THEN
    ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;
    UPDATE users SET email_verified_at = now();   -- everyone who signed up before this feature keeps access
  END IF;
END $$;
