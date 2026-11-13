import express from 'express';
import { q } from './db.js';

// Read-only insight endpoints, mounted inside the admin router (x-admin-key already checked there).
export const insights = express.Router();

const BOUNCE_PCT = 5, COMPLAINT_PCT = 0.1, MIN_SENT = 50, LOW_TRUST = 40;

insights.get('/alerts', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const shared = await q(
      `SELECT host(a.ip) AS ip, count(DISTINCT a.tenant_id)::int AS tenants, count(*)::int AS events, max(a.at) AS last_seen,
              array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL) AS names
         FROM audit_log a LEFT JOIN tenants t ON t.id = a.tenant_id
        WHERE a.ip IS NOT NULL AND a.tenant_id IS NOT NULL AND a.actor_type <> 'admin'
          AND a.at > now() - make_interval(days => 30)
        GROUP BY a.ip HAVING count(DISTINCT a.tenant_id) >= 2
        ORDER BY tenants DESC, events DESC LIMIT 50`);
    const rates = await q(
      `SELECT t.id, t.name, t.status, count(*)::int AS sent,
              count(*) FILTER (WHERE m.status = 'bounced')::int AS bounced,
              count(*) FILTER (WHERE m.status = 'complained')::int AS complained
         FROM messages m JOIN tenants t ON t.id = m.tenant_id
        WHERE m.sent_at > now() - make_interval(days => $1::int)
          AND m.status IN ('sent','delivered','bounced','complained')
        GROUP BY t.id, t.name, t.status
       HAVING count(*) >= $2::int AND (
                count(*) FILTER (WHERE m.status = 'bounced') * 100.0 / count(*) >= $3::numeric
             OR count(*) FILTER (WHERE m.status = 'complained') * 100.0 / count(*) >= $4::numeric)
        ORDER BY count(*) FILTER (WHERE m.status = 'bounced') DESC LIMIT 50`,
      [days, MIN_SENT, BOUNCE_PCT, COMPLAINT_PCT]);
    const trust = await q(
      `SELECT id, name, status, trust_score FROM tenants
        WHERE trust_score < $1::int AND status <> 'suspended' ORDER BY trust_score ASC LIMIT 50`, [LOW_TRUST]);
    const pct = (n, d) => (d ? Math.round((n * 10000) / d) / 100 : 0);
    const rateRows = rates.rows.map((r) => ({ ...r, bounce_pct: pct(r.bounced, r.sent), complaint_pct: pct(r.complained, r.sent) }));
    res.json({
      thresholds: { bounce_pct: BOUNCE_PCT, complaint_pct: COMPLAINT_PCT, min_sent: MIN_SENT, low_trust: LOW_TRUST, days },
      shared_ips: shared.rows, rates: rateRows, low_trust: trust.rows,
      total: shared.rows.length + rateRows.length + trust.rows.length,
    });
  } catch (e) { console.error('[admin] alerts failed:', e.message); res.status(500).json({ error: 'Alerts query failed.' }); }
});

insights.get('/series', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const { rows } = await q(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day,
              (SELECT count(*) FROM tenants t WHERE t.created_at >= d AND t.created_at < d + interval '1 day')::int AS signups,
              (SELECT count(*) FROM messages m WHERE m.sent_at >= d AND m.sent_at < d + interval '1 day')::int AS sent,
              (SELECT count(*) FROM messages m WHERE m.status = 'bounced' AND m.sent_at >= d AND m.sent_at < d + interval '1 day')::int AS bounced
         FROM generate_series(date_trunc('day', now()) - make_interval(days => $1::int - 1), date_trunc('day', now()), interval '1 day') d
        ORDER BY d`, [days]);
    res.json(rows);
  } catch (e) { console.error('[admin] series failed:', e.message); res.status(500).json({ error: 'Series query failed.' }); }
});
