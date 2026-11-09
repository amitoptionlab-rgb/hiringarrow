import express from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { q } from './db.js';
import { config } from './config.js';
import { checkEmail } from './lib/validate.js';
import { enroll, enrollSafe } from './lib/automation.js';

// Public API for developers. Auth: Authorization: Bearer dk_live_...
export const v1 = express.Router();
const err = (res, s, m) => res.status(s).json({ error: m });

export async function keyAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const key = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!/^dk_live_[A-Za-z0-9_-]{20,}$/.test(key)) return err(res, 401, 'Missing or invalid API key.');
  const { rows: [k] } = await q('SELECT id, tenant_id, scope, last_used_at FROM api_keys WHERE key_hash = $1', [crypto.createHash('sha256').update(key).digest('hex')]);
  if (!k) return err(res, 401, 'Missing or invalid API key.');
  if (!k.last_used_at || Date.now() - new Date(k.last_used_at) > 60_000) q('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [k.id]).catch(() => {});
  req.key = k; next();
}
const limiter = rateLimit({ windowMs: 60_000, limit: 120, keyGenerator: (req) => req.key.id, standardHeaders: true, legacyHeaders: false, validate: false,
  handler: (req, res) => err(res, 429, 'Too many requests. Slow down.') });
export const needWrite = (req, res, next) => (req.key.scope === 'write' ? next() : err(res, 403, 'This API key is read-only.'));
v1.use(keyAuth, limiter);

const tag = (v) => { const t = String(v ?? '').trim().toLowerCase().slice(0, 30); return /^[a-z0-9][a-z0-9 _.-]*$/.test(t) ? t : null; };

v1.post('/contacts', needWrite, async (req, res) => {
  const T = req.key.tenant_id, b = req.body || {};
  const consent = String(b.consent_source || '').trim().slice(0, 100);
  if (!consent) return err(res, 400, 'consent_source is required, e.g. "website signup form". You are confirming this person agreed to receive your email.');
  const chk = await checkEmail(b.email, { mx: config.verifyMx });
  if (!chk.ok) return err(res, 400, `Invalid email: ${chk.reason}.`);
  const { rows: [sup] } = await q('SELECT reason FROM suppressions WHERE tenant_id = $1 AND email = $2', [T, chk.email]);
  if (sup) return err(res, 409, 'This address previously unsubscribed, bounced or complained, so it cannot be added again.');
  const { rows: [{ n }] } = await q('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [T]);
  const { rows: [plan] } = await q('SELECT p.max_contacts FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1', [T]);
  const { rows: [exists] } = await q('SELECT 1 AS x FROM contacts WHERE tenant_id = $1 AND email = $2', [T, chk.email]);
  if (!exists && n >= plan.max_contacts) return err(res, 402, 'Contact limit of your plan reached.');
  let listId = null;
  if (b.list_id) { const { rows } = await q('SELECT id FROM lists WHERE id::text = $1 AND tenant_id = $2', [String(b.list_id), T]); if (!rows.length) return err(res, 404, 'List not found.'); listId = rows[0].id; }
  const tags = [...new Set((Array.isArray(b.tags) ? b.tags : []).map(tag).filter(Boolean))].slice(0, 10);
  const custom = b.custom && typeof b.custom === 'object' && !Array.isArray(b.custom) ? Object.fromEntries(Object.entries(b.custom).slice(0, 30).map(([k, v]) => [String(k).slice(0, 40).toLowerCase(), String(v).slice(0, 200)])) : {};
  const { rows: [c] } = await q(
    `INSERT INTO contacts (tenant_id, email, first_name, last_name, custom_fields, tags, verification, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'subscribed')
     ON CONFLICT (tenant_id, email) DO UPDATE SET first_name = COALESCE(EXCLUDED.first_name, contacts.first_name), last_name = COALESCE(EXCLUDED.last_name, contacts.last_name),
       custom_fields = contacts.custom_fields || EXCLUDED.custom_fields, tags = ARRAY(SELECT DISTINCT unnest(contacts.tags || EXCLUDED.tags)),
       status = CASE WHEN contacts.status = 'pending' THEN 'subscribed' ELSE contacts.status END
     RETURNING id, status, (xmax = 0) AS created`,
    [T, chk.email, String(b.first_name || '').trim().slice(0, 80) || null, String(b.last_name || '').trim().slice(0, 80) || null, custom, tags, chk.verification]);
  await q(`INSERT INTO consent_log (tenant_id, contact_id, action, source, ip, user_agent) VALUES ($1,$2,'opt_in',$3,$4,'api')`, [T, c.id, `api:${consent}`, req.ip]);
  if (c.created) { enrollSafe(T, [c.id], 'subscribed'); for (const t of tags) enrollSafe(T, [c.id], 'tag_added', { tag: t }); }
  if (listId) { const j = await q('INSERT INTO list_members (list_id, contact_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1', [listId, c.id]); if (j.rowCount) enrollSafe(T, [c.id], 'list_joined', { list_id: listId }); }
  res.status(c.created ? 201 : 200).json({ id: c.id, email: chk.email, status: c.status, created: c.created });
});

v1.get('/contacts/:email', async (req, res) => {
  const { rows: [c] } = await q(`SELECT id, email, first_name, last_name, status, tags, custom_fields, created_at, last_engaged_at FROM contacts WHERE tenant_id = $1 AND email = $2`, [req.key.tenant_id, String(req.params.email).toLowerCase()]);
  c ? res.json(c) : err(res, 404, 'Contact not found.');
});
v1.post('/contacts/:email/tags', needWrite, async (req, res) => {
  const t = tag(req.body?.tag); if (!t) return err(res, 400, 'Invalid tag.');
  const { rows } = await q(`UPDATE contacts SET tags = ARRAY(SELECT DISTINCT unnest(tags || ARRAY[$3::text])) WHERE tenant_id = $1 AND email = $2 RETURNING id`, [req.key.tenant_id, String(req.params.email).toLowerCase(), t]);
  if (!rows.length) return err(res, 404, 'Contact not found.');
  enrollSafe(req.key.tenant_id, [rows[0].id], 'tag_added', { tag: t });
  res.json({ ok: true });
});
// Custom events start journeys, e.g. POST {"email":"a@b.com","name":"order_placed"}
v1.post('/events', needWrite, async (req, res) => {
  const name = String(req.body?.name || '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{1,40}$/.test(name)) return err(res, 400, 'Event names use letters, numbers, _ . - only (max 40).');
  const { rows: [c] } = await q(`SELECT id FROM contacts WHERE tenant_id = $1 AND email = $2 AND status = 'subscribed'`, [req.key.tenant_id, String(req.body?.email || '').toLowerCase()]);
  if (!c) return err(res, 404, 'No subscribed contact with that email.');
  res.json({ enrolled: await enroll(req.key.tenant_id, [c.id], 'event', { name }) });
});
v1.get('/campaigns', async (req, res) => {
  const { rows } = await q(`SELECT id, name, subject, status, scheduled_at, created_at FROM campaigns WHERE tenant_id = $1 AND kind = 'broadcast' ORDER BY created_at DESC LIMIT 100`, [req.key.tenant_id]);
  res.json(rows);
});
