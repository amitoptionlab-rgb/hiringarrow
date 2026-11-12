-- 010: resume files for consultants, stored in Postgres. Idempotent: migrate.js re-runs every file.
CREATE TABLE IF NOT EXISTS consultant_resumes (
  consultant_id UUID PRIMARY KEY REFERENCES consultants(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  data          BYTEA NOT NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);