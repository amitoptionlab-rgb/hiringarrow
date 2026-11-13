import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { q } from './db.js';
import { auditAdmin } from './lib/audit.js';

// Operator-only endpoints. Send header: x-admin-key: <ADMIN_KEY>
export const admin = express.Router();
admin.use((req, res, next) => {
  const k = String(req.headers['x-admin-key'] || '');
  const ok = config.adminKey && k.length === config.adminKey.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(config.adminKey));
  return ok ? next() : res.status(401).json({ error: 'Not allowed.' });
});

admin.use(auditAdmin());

admin.get('/tenants', async (req, res) => {
  const { rows } = await q(
    `SELECT t.id, t.name, t.status, t.daily_send_cap, t.created_at, p.code AS plan,
            (SELECT count(*) FROM messages m WHERE m.tenant_id = t.id AND m.status IN ('sent','delivered','bounced','complained'))::int AS sent,
            (SELECT count(*) FROM messages m WHERE m.tenant_id = t.id AND m.status = 'complained')::int AS complaints,
            (SELECT count(*) FROM messages m WHERE m.tenant_id = t.id AND m.status = 'bounced')::int AS bounces,
            (SELECT u.email FROM users u WHERE u.tenant_id = t.id ORDER BY (u.role = 'owner') DESC, u.created_at LIMIT 1) AS owner_email
     FROM tenants t JOIN plans p ON p.id = t.plan_id ORDER BY t.created_at DESC LIMIT 200`);
  res.json(rows);
});
admin.post('/tenants/:id/approve', async (req, res) => {
  await q(`UPDATE tenants SET status = 'active', daily_send_cap = $2 WHERE id = $1`, [req.params.id, Math.max(0, +req.body?.daily_send_cap || 5000)]);
  res.json({ ok: true });
});
admin.post('/tenants/:id/suspend', async (req, res) => {
  await q(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [req.params.id]);
  await q(`UPDATE campaigns SET status = 'paused' WHERE tenant_id = $1 AND status = 'sending'`, [req.params.id]);
  res.json({ ok: true });
});

admin.post('/tenants/:id/unsuspend', async (req, res) => {
  const { rows } = await q(`UPDATE tenants SET status = 'active' WHERE id = $1 AND status = 'suspended' RETURNING id`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'No suspended tenant with this id.' });
  res.json({ ok: true });
});

// Manual billing (no payment gateway needed): move a tenant to a plan after they paid you by UPI, bank transfer, etc.
admin.post('/tenants/:id/plan', async (req, res) => {
  const { rows: [p] } = await q('SELECT id FROM plans WHERE code = $1', [String(req.body?.plan_code || '')]);
  if (!p) return res.status(404).json({ error: 'Unknown plan code (free, starter, growth, pro).' });
  await q('UPDATE tenants SET plan_id = $2 WHERE id = $1', [req.params.id, p.id]);
  res.json({ ok: true });
});
