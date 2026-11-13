-- Audit trail (who did what, from where). Runs on every migrate, so it must be idempotent.
-- Append-only: UPDATE is always blocked; DELETE only inside the retention purge (SET LOCAL app.audit_purge = 'on').
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type  TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','admin','system','anonymous')),
  actor_label TEXT,                 -- admin: self-declared x-admin-name (hint, not proof)
  tenant_id   UUID,                 -- no FK on purpose: deleting a tenant must not erase its trail
  user_id     UUID,
  action      TEXT NOT NULL,        -- e.g. auth.login, auth.signup, POST /api/campaigns/:id/send
  success     BOOLEAN NOT NULL DEFAULT true,
  ip          INET,
  user_agent  TEXT,
  device_id   TEXT,                 -- random per-browser cookie id, not a fingerprint
  target_type TEXT,
  target_id   TEXT,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log (tenant_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_ip ON audit_log (ip, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_device ON audit_log (device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);

CREATE OR REPLACE FUNCTION audit_log_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_log is append-only';
  END IF;
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.audit_purge', true), '') <> 'on' THEN
    RAISE EXCEPTION 'audit_log rows can only be deleted by the retention purge';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_guard ON audit_log;
CREATE TRIGGER trg_audit_log_guard BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
