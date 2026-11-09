-- Mass Mail SaaS: Phase 1 schema (PostgreSQL 15+)
-- Multi-tenant: every business table carries tenant_id. Enable RLS in production.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ============ TENANTS, USERS, BILLING ============
CREATE TABLE plans (
  id              SERIAL PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,           -- free, starter, growth, pro
  name            TEXT NOT NULL,
  price_inr       INT NOT NULL DEFAULT 0,         -- per month
  monthly_emails  INT NOT NULL,                   -- send quota
  max_contacts    INT NOT NULL,
  max_domains     INT NOT NULL DEFAULT 1,
  razorpay_plan_id TEXT,
  features        JSONB NOT NULL DEFAULT '{}'     -- {"ab_test":true,"automation":false,...}
);

CREATE TABLE tenants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  plan_id         INT REFERENCES plans(id),
  status          TEXT NOT NULL DEFAULT 'review'  -- review | active | paused | suspended
                  CHECK (status IN ('review','active','paused','suspended')),
  trust_score     INT NOT NULL DEFAULT 50,        -- abuse control, drives send limits
  postal_address  TEXT,                           -- required in footer (CAN-SPAM)
  daily_send_cap  INT NOT NULL DEFAULT 200,       -- new accounts start low
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           CITEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member'  -- owner | admin | member
                  CHECK (role IN ('owner','admin','member')),
  totp_secret     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id         INT NOT NULL REFERENCES plans(id),
  provider        TEXT NOT NULL DEFAULT 'razorpay',
  provider_sub_id TEXT,
  status          TEXT NOT NULL,                  -- active | past_due | cancelled
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ
);

CREATE TABLE usage_counters (
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period          DATE NOT NULL,                  -- first day of billing month
  emails_sent     INT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period)
);

-- ============ SENDING DOMAINS ============
CREATE TABLE sending_domains (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain          TEXT NOT NULL,
  spf_ok          BOOLEAN NOT NULL DEFAULT false,
  dkim_ok         BOOLEAN NOT NULL DEFAULT false,
  dmarc_ok        BOOLEAN NOT NULL DEFAULT false,
  dkim_selector   TEXT,
  tracking_domain TEXT,
  warmup_day      INT NOT NULL DEFAULT 0,
  verified_at     TIMESTAMPTZ,
  UNIQUE (tenant_id, domain)
);

-- ============ CONTACTS ============
CREATE TABLE lists (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  double_opt_in   BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           CITEXT NOT NULL,
  first_name      TEXT,
  last_name       TEXT,
  custom_fields   JSONB NOT NULL DEFAULT '{}',
  tags            TEXT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending' -- pending | subscribed | unsubscribed | bounced | complained
                  CHECK (status IN ('pending','subscribed','unsubscribed','bounced','complained')),
  verification    TEXT,                           -- valid | risky | invalid | disposable
  engagement_score INT NOT NULL DEFAULT 0,
  last_engaged_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE INDEX idx_contacts_tags ON contacts USING GIN (tags);
CREATE INDEX idx_contacts_status ON contacts (tenant_id, status);

CREATE TABLE list_members (
  list_id         UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, contact_id)
);

-- Consent proof (DPDP / GDPR)
CREATE TABLE consent_log (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  action          TEXT NOT NULL,                  -- opt_in | confirm | unsubscribe
  source          TEXT,                           -- form url / import / api
  ip              INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Never email these again (per tenant)
CREATE TABLE suppressions (
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           CITEXT NOT NULL,
  reason          TEXT NOT NULL,                  -- hard_bounce | complaint | unsubscribe | manual
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, email)
);

-- ============ CAMPAIGNS ============
CREATE TABLE templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  mjml            TEXT,
  html            TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  subject         TEXT NOT NULL,
  preheader       TEXT,
  from_name       TEXT NOT NULL,
  from_email      TEXT NOT NULL,
  domain_id       UUID REFERENCES sending_domains(id),
  template_id     UUID REFERENCES templates(id),
  html            TEXT NOT NULL,
  list_id         UUID REFERENCES lists(id),
  segment         JSONB,                          -- filter tree
  status          TEXT NOT NULL DEFAULT 'draft'   -- draft | preflight_failed | scheduled | sending | paused | done
                  CHECK (status IN ('draft','preflight_failed','scheduled','sending','paused','done')),
  scheduled_at    TIMESTAMPTZ,
  spam_score      NUMERIC(4,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messages (                            -- one row per recipient per campaign
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  campaign_id     UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'queued'  -- queued | sent | delivered | bounced | complained | failed
                  CHECK (status IN ('queued','sent','delivered','bounced','complained','failed')),
  provider_msg_id TEXT,
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id)                -- idempotency: no double sends
);
CREATE INDEX idx_messages_provider ON messages (provider_msg_id);

-- ============ EVENTS (move to ClickHouse at scale) ============
CREATE TABLE events (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  message_id      UUID REFERENCES messages(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,                  -- delivered | open | click | bounce | complaint | unsubscribe
  url             TEXT,
  meta            JSONB,                          -- bounce type, user agent, proxy flag (Apple MPP)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_msg ON events (message_id, type);

-- ============ SEED PLANS ============
INSERT INTO plans (code, name, price_inr, monthly_emails, max_contacts, max_domains, features) VALUES
  ('free',    'Free',    0,     1000,   500,    1, '{"ab_test":false,"automation":false}'),
  ('starter', 'Starter', 499,   10000,  5000,   1, '{"ab_test":true,"automation":false}'),
  ('growth',  'Growth',  1499,  50000,  25000,  3, '{"ab_test":true,"automation":true}'),
  ('pro',     'Pro',     3999,  250000, 100000, 10,'{"ab_test":true,"automation":true,"ai_agent":true}');

CREATE INDEX IF NOT EXISTS idx_messages_campaign_status ON messages (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_tenant_sent ON messages (tenant_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_events_tenant_time ON events (tenant_id, created_at);
