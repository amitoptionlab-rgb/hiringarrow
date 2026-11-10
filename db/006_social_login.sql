-- Social login (Google, LinkedIn). Runs on every migrate, so it must be idempotent.
CREATE TABLE IF NOT EXISTS user_identities (
  provider         TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email            CITEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON user_identities (user_id);
