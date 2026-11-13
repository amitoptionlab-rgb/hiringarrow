import express from 'express';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { config } from './config.js';
import { q } from './db.js';
import { auditAdmin } from './lib/audit.js';
import { insights } from './admin-insights.js';

// Operator-only endpoints. Send header: x-admin-key: <ADMIN_KEY>
export const admin = express.Router();
admin.use((req, res, next) => {
  const k = String(req.headers['x-admin-key'] || '');
  const ok = config.adminKey && k.length === config.adminKey.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(config.adminKey));
  return ok ? next() : res.status(401).json({ error: 'Not allowed.' });
});

admin.use(auditAdmin());
admin.use(insights);

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
// ---- audit search (Step 2) ----
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const likeEsc = (s) => '%' + String(s).replace(/[\\%_]/g, '\\$&') + '%';
const badReq = (res, m) => res.status(400).json({ error: m });

// GET /admin/audit?tenant=&email=&ip=&action=&from=&to=&limit=&offset=
admin.get('/audit', async (req, res) => {
  const f = req.query, w = [], p = [];
  const add = (sql, v) => { p.push(v); w.push(sql.replace('?', '$' + p.length)); };
  if (f.tenant) { if (!UUID_RE.test(String(f.tenant))) return badReq(res, 'Bad tenant id.'); add('a.tenant_id = ?', String(f.tenant)); }
  if (f.ip) { if (!isIP(String(f.ip))) return badReq(res, 'Bad IP.'); add('a.ip = ?::inet', String(f.ip)); }
  if (f.action) add('a.action ILIKE ?', likeEsc(f.action));
  if (f.email) {
    p.push(likeEsc(f.email));
    const n = '$' + p.length;
    w.push("(a.details->>'email' ILIKE " + n + ' OR a.user_id IN (SELECT id FROM users WHERE email ILIKE ' + n + '))');
  }
  for (const [k, op] of [['from', '>='], ['to', '<=']]) {
    if (!f[k]) continue;
    const d = new Date(String(f[k]));
    if (isNaN(d)) return badReq(res, 'Bad ' + k + ' date.');
    add('a.at ' + op + ' ?', d.toISOString());
  }
  const limit = Math.min(Math.max(+f.limit || 100, 1), 500);
  const offset = Math.max(+f.offset || 0, 0);
  p.push(limit, offset);
  const { rows } = await q(
    'SELECT a.id, a.at, a.actor_type, a.actor_label, a.tenant_id, t.name AS tenant_name, a.user_id, a.action, a.success, ' +
    'host(a.ip) AS ip, a.user_agent, a.device_id, a.target_type, a.target_id, a.details ' +
    'FROM audit_log a LEFT JOIN tenants t ON t.id = a.tenant_id ' +
    (w.length ? 'WHERE ' + w.join(' AND ') + ' ' : '') +
    'ORDER BY a.id DESC LIMIT $' + (p.length - 1) + ' OFFSET $' + p.length, p);
  res.json(rows);
});

// GET /admin/ips/shared?days=30  ->  IPs seen on 2+ different tenants
admin.get('/ips/shared', async (req, res) => {
  const days = Math.min(Math.max(+req.query.days || 30, 1), 365);
  const { rows } = await q(
    'SELECT host(ip) AS ip, count(DISTINCT tenant_id)::int AS tenants, count(*)::int AS events, max(at) AS last_seen ' +
    'FROM audit_log WHERE ip IS NOT NULL AND tenant_id IS NOT NULL AND actor_type <> \'admin\' AND at > now() - make_interval(days => $1) ' +
    'GROUP BY ip HAVING count(DISTINCT tenant_id) >= 2 ORDER BY tenants DESC, events DESC LIMIT 100', [days]);
  res.json(rows);
});

// GET /admin/ips/:ip/accounts  ->  which tenants/users used this IP
admin.get('/ips/:ip/accounts', async (req, res) => {
  if (!isIP(req.params.ip)) return badReq(res, 'Bad IP.');
  const { rows } = await q(
    'SELECT a.tenant_id, t.name, t.status, count(*)::int AS events, count(DISTINCT a.user_id)::int AS users, ' +
    'min(a.at) AS first_seen, max(a.at) AS last_seen ' +
    'FROM audit_log a LEFT JOIN tenants t ON t.id = a.tenant_id ' +
    'WHERE a.ip = $1::inet AND a.tenant_id IS NOT NULL AND a.actor_type <> \'admin\' ' +
    'GROUP BY a.tenant_id, t.name, t.status ORDER BY last_seen DESC LIMIT 200', [req.params.ip]);
  res.json(rows);
});

// ---- dashboard v2 ----
admin.get('/overview', async (req, res) => {
  const { rows: [o] } = await q(
    "SELECT (SELECT count(*) FROM tenants)::int AS tenants, " +
    "(SELECT count(*) FROM tenants WHERE status = 'review')::int AS pending, " +
    "(SELECT count(*) FROM tenants WHERE status = 'suspended')::int AS suspended, " +
    "(SELECT count(*) FROM users)::int AS users, " +
    "(SELECT count(*) FROM users WHERE email_verified_at IS NULL)::int AS unverified, " +
    "(SELECT count(*) FROM messages WHERE sent_at >= date_trunc('day', now()))::int AS sent_today, " +
    "(SELECT count(*) FROM messages WHERE status = 'bounced' AND sent_at > now() - interval '7 days')::int AS bounced_7d, " +
    "(SELECT count(*) FROM messages WHERE status = 'complained' AND sent_at > now() - interval '7 days')::int AS complained_7d");
  res.json(o);
});

// GET /admin/accounts?search=&status=&plan=&limit=&offset=
admin.get('/accounts', async (req, res) => {
  const f = req.query, w = [], p = [];
  if (f.status) { p.push(String(f.status)); w.push('t.status = $' + p.length); }
  if (f.plan) { p.push(String(f.plan)); w.push('pl.code = $' + p.length); }
  if (f.search) {
    p.push(likeEsc(f.search));
    w.push('(t.name ILIKE $' + p.length + ' OR EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.email ILIKE $' + p.length + '))');
  }
  const limit = Math.min(Math.max(+f.limit || 50, 1), 200);
  const offset = Math.max(+f.offset || 0, 0);
  p.push(limit, offset);
  const { rows } = await q(
    'SELECT t.id, t.name, t.status, t.daily_send_cap, t.created_at, pl.code AS plan, ' +
    '(SELECT u.email FROM users u WHERE u.tenant_id = t.id ORDER BY (u.role = \'owner\') DESC, u.created_at LIMIT 1) AS owner_email, ' +
    '(SELECT count(*) FROM users u WHERE u.tenant_id = t.id)::int AS users, ' +
    '(SELECT count(*) FROM messages m WHERE m.tenant_id = t.id AND m.status IN (\'sent\',\'delivered\',\'bounced\',\'complained\'))::int AS sent, ' +
    '(SELECT count(*) FROM messages m WHERE m.tenant_id = t.id AND m.status = \'bounced\')::int AS bounces, ' +
    '(SELECT count(*) FROM messages m WHERE m.tenant_id = t.id AND m.status = \'complained\')::int AS complaints, ' +
    '(SELECT max(a.at) FROM audit_log a WHERE a.tenant_id = t.id AND a.action = \'auth.login\' AND a.success) AS last_login ' +
    'FROM tenants t LEFT JOIN plans pl ON pl.id = t.plan_id ' +
    (w.length ? 'WHERE ' + w.join(' AND ') + ' ' : '') +
    'ORDER BY t.created_at DESC LIMIT $' + (p.length - 1) + ' OFFSET $' + p.length, p);
  res.json(rows);
});

// GET /admin/accounts/:id  -> everything about one tenant
admin.get('/accounts/:id', async (req, res) => {
  const id = req.params.id;
  if (!UUID_RE.test(id)) return badReq(res, 'Bad id.');
  const { rows: [tenant] } = await q(
    'SELECT t.id, t.name, t.status, t.kind, t.trust_score, t.daily_send_cap, t.postal_address, t.created_at, pl.code AS plan, pl.monthly_emails ' +
    'FROM tenants t LEFT JOIN plans pl ON pl.id = t.plan_id WHERE t.id = $1', [id]);
  if (!tenant) return res.status(404).json({ error: 'Not found.' });
  const { rows: users } = await q(
    'SELECT u.id, u.email, u.role, u.created_at, u.email_verified_at, ' +
    '(SELECT max(a.at) FROM audit_log a WHERE a.user_id = u.id AND a.action = \'auth.login\' AND a.success) AS last_login ' +
    'FROM users u WHERE u.tenant_id = $1 ORDER BY u.created_at', [id]);
  const { rows: [usage] } = await q(
    'SELECT (SELECT count(*) FROM contacts WHERE tenant_id = $1)::int AS contacts, ' +
    '(SELECT count(*) FROM campaigns WHERE tenant_id = $1)::int AS campaigns, ' +
    '(SELECT coalesce(sum(emails_sent), 0) FROM usage_counters WHERE tenant_id = $1 AND period = date_trunc(\'month\', now())::date)::int AS sent_month, ' +
    '(SELECT count(*) FROM messages WHERE tenant_id = $1 AND status IN (\'sent\',\'delivered\',\'bounced\',\'complained\'))::int AS sent_total, ' +
    '(SELECT count(*) FROM messages WHERE tenant_id = $1 AND status = \'bounced\')::int AS bounced, ' +
    '(SELECT count(*) FROM messages WHERE tenant_id = $1 AND status = \'complained\')::int AS complained, ' +
    '(SELECT coalesce(sum(amount), 0) FROM credit_ledger WHERE tenant_id = $1)::int AS credits', [id]);
  const { rows: campaigns } = await q(
    'SELECT id, name, status, created_at FROM campaigns WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10', [id]);
  const { rows: ips } = await q(
    'SELECT host(a.ip) AS ip, count(*)::int AS events, max(a.at) AS last_seen, ' +
    '(SELECT count(DISTINCT b.tenant_id)::int FROM audit_log b WHERE b.ip = a.ip AND b.tenant_id IS NOT NULL AND b.actor_type <> \'admin\') AS tenants ' +
    'FROM audit_log a WHERE a.tenant_id = $1 AND a.ip IS NOT NULL GROUP BY a.ip ORDER BY max(a.at) DESC LIMIT 15', [id]);
  const { rows: activity } = await q(
    'SELECT id, at, action, success, host(ip) AS ip, device_id, user_agent FROM audit_log WHERE tenant_id = $1 ORDER BY id DESC LIMIT 25', [id]);
  res.json({ tenant, users, usage, campaigns, ips, activity });
});

admin.post('/tenants/:id/cap', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return badReq(res, 'Bad id.');
  const n = Math.floor(+req.body?.daily_send_cap);
  if (!(n >= 0 && n <= 1000000)) return badReq(res, 'Bad cap (0 - 1000000).');
  const { rows } = await q('UPDATE tenants SET daily_send_cap = $2 WHERE id = $1 RETURNING id', [req.params.id, n]);
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});

admin.post('/users/:id/verify', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return badReq(res, 'Bad id.');
  const { rows } = await q('UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});

// Manual credit adjustment (append-only ledger). amount can be negative.
admin.post('/tenants/:id/credits', async (req, res) => {
  const id = req.params.id;
  if (!UUID_RE.test(id)) return badReq(res, 'Bad id.');
  const n = Math.trunc(+req.body?.amount);
  if (!n || Math.abs(n) > 10000000) return badReq(res, 'Bad amount.');
  const { rows: [t] } = await q('SELECT id FROM tenants WHERE id = $1', [id]);
  if (!t) return res.status(404).json({ error: 'Not found.' });
  await q('INSERT INTO credit_ledger (tenant_id, kind, amount, idempotency_key, note) VALUES ($1, \'adjust\', $2, $3, $4)',
    [id, n, 'adj:' + crypto.randomUUID(), String(req.body?.note || '').slice(0, 300) || null]);
  res.json({ ok: true });
});

// Hard delete. Body must carry the exact tenant name. audit_log and credit_ledger rows are kept on purpose.
admin.post('/tenants/:id/delete', async (req, res) => {
  const id = req.params.id;
  if (!UUID_RE.test(id)) return badReq(res, 'Bad id.');
  const { rows: [t] } = await q('SELECT name FROM tenants WHERE id = $1', [id]);
  if (!t) return res.status(404).json({ error: 'Not found.' });
  if (String(req.body?.confirm || '') !== t.name) return badReq(res, 'Confirmation name does not match.');
  await q('DELETE FROM tenants WHERE id = $1', [id]);
  res.json({ ok: true });
});
// ---- end dashboard v2 ----

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
