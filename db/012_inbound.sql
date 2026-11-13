-- Inbound replies to campaign/journey mails. Runs on every migrate, so it must be idempotent.
CREATE TABLE IF NOT EXISTS inbound_messages (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id        UUID REFERENCES messages(id)  ON DELETE SET NULL,
  contact_id        UUID REFERENCES contacts(id)  ON DELETE SET NULL,
  campaign_id       UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  from_email        TEXT NOT NULL,
  from_name         TEXT,
  subject           TEXT,
  body_text         TEXT,
  classification    TEXT NOT NULL DEFAULT 'reply',      -- reply | ooo | unsubscribe
  attachments       JSONB NOT NULL DEFAULT '[]',        -- [{name,size}] metadata only, files are not stored
  provider_event_id TEXT,                               -- dedupe key: provider retries must not create duplicates
  forwarded_at      TIMESTAMPTZ,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at           TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_inbound_provider_event ON inbound_messages (provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbound_tenant ON inbound_messages (tenant_id, received_at DESC);
