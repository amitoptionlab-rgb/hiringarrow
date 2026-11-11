-- Purchased send credits. Append-only: balance = SUM(amount). Never UPDATE or DELETE rows.
--   purchase (+N)  added by the payment webhook, key 'rzp:<payment id>' so a repeated webhook cannot add twice
--   consume  (-1)  one per message sent beyond the plan's monthly quota, key 'msg:<message id>'
--   adjust / refund  manual corrections by an admin
-- No FK to tenants on purpose: financial rows must outlive a tenant delete, and it avoids breaking any delete flow.
-- Idempotent: migrate runs on every deploy.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('purchase', 'consume', 'adjust', 'refund')),
  amount          INTEGER NOT NULL CHECK (amount <> 0),
  message_id      UUID,
  payment_ref     TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_tenant ON credit_ledger (tenant_id);
