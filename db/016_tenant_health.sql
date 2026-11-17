-- Tenant-wise 7-day health, built on your real schema (messages + events).
-- Idempotent: safe to run more than once.
-- sent    = messages that actually left (sent_at set, not failed)
-- bounce  = events type 'bounce', soft/transient bounces excluded
CREATE OR REPLACE VIEW tenant_health AS
WITH sent AS (
  SELECT tenant_id, COUNT(*) AS n
    FROM messages
   WHERE sent_at > now() - interval '7 days'
     AND status IN ('sent','delivered','bounced','complained')
   GROUP BY tenant_id
), ev AS (
  SELECT tenant_id,
         COUNT(*) FILTER (WHERE type = 'bounce'
              AND COALESCE(meta->>'bounceType', meta->>'bounce_type', meta->>'type', '') NOT ILIKE 'transient') AS bounces,
         COUNT(*) FILTER (WHERE type = 'complaint')   AS complaints,
         COUNT(*) FILTER (WHERE type = 'unsubscribe') AS unsubs
    FROM events
   WHERE created_at > now() - interval '7 days'
   GROUP BY tenant_id
)
SELECT
  t.id AS tenant_id,
  t.name,
  t.status,
  t.daily_send_cap,
  COALESCE(s.n, 0)          AS sent_7d,
  COALESCE(e.bounces, 0)    AS bounces_7d,
  COALESCE(e.complaints, 0) AS complaints_7d,
  COALESCE(e.unsubs, 0)     AS unsubs_7d,
  ROUND(100.0 * COALESCE(e.bounces, 0)    / NULLIF(s.n, 0), 2) AS bounce_pct,
  ROUND(100.0 * COALESCE(e.complaints, 0) / NULLIF(s.n, 0), 3) AS complaint_pct,
  ROUND(100.0 * COALESCE(e.unsubs, 0)     / NULLIF(s.n, 0), 2) AS unsub_pct
FROM tenants t
LEFT JOIN sent s ON s.tenant_id = t.id
LEFT JOIN ev   e ON e.tenant_id = t.id;
