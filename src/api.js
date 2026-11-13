import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import dns from 'node:dns/promises';
import { parse } from 'csv-parse/sync';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { q, tx, HttpError } from './db.js';
import { enqueueMessages } from './queue.js';
import { checkEmail, mapLimit } from './lib/validate.js';
import { segmentSql } from './lib/segment.js';
import { audience } from './lib/audience.js';
import { startCampaign, runPreflight } from './lib/campaign-send.js';
import { enrollSafe } from './lib/automation.js';
import { automations } from './automations.js';
import { aiRouter } from './ai.js';
import { consultants } from './consultants.js';
import crypto from 'node:crypto';
import { renderMessage } from './lib/render.js';
import { sendMail } from './lib/mailer.js';
import { allowance } from './lib/limits.js';
import { sendVerifyMail } from './lib/verify-mail.js';
import { isFreeEmail } from './lib/email-policy.js';

export const api = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const need = (v, msg) => { if (!v || !String(v).trim()) throw new HttpError(400, msg); return String(v).trim(); };
const uuid = (v, msg = 'Invalid id.') => { if (!UUID.test(v || '')) throw new HttpError(400, msg); return v; };

// ---------- auth ----------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const sign = (u) => jwt.sign({ uid: u.id, tid: u.tenant_id, role: u.role }, config.jwtSecret, { expiresIn: '7d' });

api.post('/auth/signup', authLimiter, async (req, res) => {
  const email = need(req.body.email, 'Enter your email.').toLowerCase();
  const password = need(req.body.password, 'Choose a password.');
  const company = need(req.body.company, 'Enter your company or brand name.');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  const chk = await checkEmail(email, { mx: config.verifyMx });
  if (!chk.ok) throw new HttpError(400, `That email can't be used: ${chk.reason}.`);
  if (config.blockFreeEmail && isFreeEmail(email)) throw new HttpError(400, 'Please use your company email. Gmail, Yahoo and other free email addresses are not allowed.');
  const hash = await bcrypt.hash(password, 11);
  const user = await tx(async (c) => {
    const { rows: [dup] } = await c.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (dup) throw new HttpError(409, 'An account with this email already exists. Log in instead.');
    const dd = await c.query("SELECT 1 FROM users WHERE email_verified_at IS NOT NULL AND lower(split_part(email::text, '@', 2)) = $1 LIMIT 1", [email.split('@')[1]]);
    if (config.oneCompanyPerDomain && dd.rows.length) throw new HttpError(409, 'A company account for this email domain already exists. Ask your account owner to add you.');
    const { rows: [plan] } = await c.query(`SELECT id FROM plans WHERE code = 'free'`);
    // New accounts start in review with a small daily cap. Admin approval raises it.
    const status = config.autoApprove ? 'active' : 'review';
    const cap = config.autoApprove ? 5000 : 200;
    const { rows: [t] } = await c.query(
      `INSERT INTO tenants (name, plan_id, status, daily_send_cap) VALUES ($1, $2, $3, $4) RETURNING id`, [company, plan.id, status, cap]);
    const { rows: [u] } = await c.query(
      `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, 'owner') RETURNING id, tenant_id, role`, [t.id, email, hash]);
    return u;
  });
  if (config.requireEmailVerify) {
    await sendVerifyMail({ id: user.id, email });
    return res.status(201).json({ verify: true, email });
  }
  res.status(201).json({ token: sign(user) });
});

api.post('/auth/login', authLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { rows: [u] } = await q('SELECT id, tenant_id, role, password_hash, email_verified_at FROM users WHERE email = $1', [email]);
  const ok = u ? await bcrypt.compare(String(req.body.password || ''), u.password_hash) : await bcrypt.compare('x', '$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
  if (!u || !ok) throw new HttpError(401, 'Email or password is wrong.');
  if (config.requireEmailVerify && !u.email_verified_at) {
    await sendVerifyMail({ id: u.id, email });
    return res.status(403).json({ error: 'Please confirm your email first. We just sent you a new link.' });
  }
  res.json({ token: sign(u) });
});

api.use((req, res, next) => {
  const h = req.headers.authorization || '';
  try { req.user = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', config.jwtSecret); next(); }
  catch { res.status(401).json({ error: 'Please log in again.' }); }
});

const tid = (req) => req.user.tid;
const testLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.user.tid, message: { error: 'Too many test emails. Try again in an hour.' } });
api.use('/automations', automations);
api.use('/ai', aiRouter);
api.use('/consultants', consultants);

api.get('/me', async (req, res) => {
  const { rows: [r] } = await q(
    `SELECT u.email, u.role, t.id AS tenant_id, t.name, t.status, t.postal_address, t.daily_send_cap,
            p.code AS plan_code, p.name AS plan_name, p.price_inr, p.monthly_emails, p.max_contacts, p.features
     FROM users u JOIN tenants t ON t.id = u.tenant_id JOIN plans p ON p.id = t.plan_id WHERE u.id = $1`, [req.user.uid]);
  res.json({ ...r, ai_mode: config.ai.baseUrl ? 'model' : 'builtin' });
});

api.patch('/tenant', async (req, res) => {
  const name = need(req.body.name, 'Company name is required.');
  const addr = String(req.body.postal_address || '').trim().slice(0, 300);
  await q('UPDATE tenants SET name = $2, postal_address = $3 WHERE id = $1', [tid(req), name, addr || null]);
  res.json({ ok: true });
});

// ---------- lists & contacts ----------
api.get('/lists', async (req, res) => {
  const { rows } = await q(
    `SELECT l.id, l.name, l.double_opt_in, count(c.id) FILTER (WHERE c.status = 'subscribed')::int AS subscribers
     FROM lists l LEFT JOIN list_members lm ON lm.list_id = l.id LEFT JOIN contacts c ON c.id = lm.contact_id
     WHERE l.tenant_id = $1 GROUP BY l.id ORDER BY l.created_at DESC`, [tid(req)]);
  res.json(rows.map((l) => ({ ...l, subscribe_url: `${config.baseUrl}/s/${l.id}` })));
});
api.post('/lists', async (req, res) => {
  const name = need(req.body.name, 'Name the list.');
  const { rows: [l] } = await q('INSERT INTO lists (tenant_id, name) VALUES ($1, $2) RETURNING id, name', [tid(req), name]);
  res.status(201).json(l);
});

api.get('/contacts', async (req, res) => {
  const page = Math.max(1, +req.query.page || 1), size = 50;
  const status = ['pending', 'subscribed', 'unsubscribed', 'bounced', 'complained'].includes(req.query.status) ? req.query.status : null;
  const search = String(req.query.q || '').trim();
  const params = [tid(req), status, search ? `%${search}%` : null];
  const where = `tenant_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR email ILIKE $3 OR first_name ILIKE $3)`;
  const { rows } = await q(
    `SELECT id, email, first_name, last_name, tags, status, verification, last_engaged_at, created_at FROM contacts
     WHERE ${where} ORDER BY created_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, params);
  const { rows: [{ total }] } = await q(`SELECT count(*)::int AS total FROM contacts WHERE ${where}`, params);
  res.json({ rows, total, page, size });
});
api.delete('/contacts/:id', async (req, res) => {
  await q('DELETE FROM contacts WHERE id = $1 AND tenant_id = $2', [uuid(req.params.id), tid(req)]);
  res.json({ ok: true });
});

api.post('/contacts/import', upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Attach a CSV file with an "email" column.');
  if (req.body.consent !== 'true') throw new HttpError(400, 'Confirm that these people gave you permission to email them.');
  let records;
  try {
    records = parse(req.file.buffer, { columns: (h) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, relax_column_count: true, bom: true, trim: true });
  } catch { throw new HttpError(400, 'Could not read that CSV. Check the format.'); }
  if (records.length > 50000) throw new HttpError(400, 'Import up to 50,000 rows at a time.');
  if (records.length && !('email' in records[0])) throw new HttpError(400, 'The CSV needs a column named "email".');
  let listId = null;
  if (req.body.list_id) {
    listId = uuid(req.body.list_id);
    const { rows } = await q('SELECT 1 FROM lists WHERE id = $1 AND tenant_id = $2', [listId, tid(req)]);
    if (!rows.length) throw new HttpError(404, 'List not found.');
  }

  const { rows: sups } = await q('SELECT email FROM suppressions WHERE tenant_id = $1', [tid(req)]);
  const suppressed = new Set(sups.map((s) => s.email));
  const seen = new Set(); const rejected = []; const todo = [];
  let duplicates = 0;
  for (const r of records) {
    const email = String(r.email || '').trim().toLowerCase();
    if (!email) continue;
    if (seen.has(email)) { duplicates++; continue; }
    seen.add(email);
    if (suppressed.has(email)) { rejected.push({ email, reason: 'previously unsubscribed, bounced or complained' }); continue; }
    todo.push({ email, r });
  }
  const checks = await mapLimit(todo, 20, (t) => checkEmail(t.email, { mx: config.verifyMx }));
  const good = [];
  todo.forEach((t, i) => {
    if (!checks[i].ok) return rejected.push({ email: t.email, reason: checks[i].reason });
    const { email: _e, first_name, last_name, firstname, lastname, name, tags: tagCol, ...rest } = t.r;
    const tags = String(tagCol || '').split(/[,;|]/).map((x) => x.trim().toLowerCase().slice(0, 30)).filter(Boolean).slice(0, 10);
    const custom = Object.fromEntries(Object.entries(rest).filter(([k, v]) => k && v !== ''));
    good.push({ email: t.email, first: first_name || firstname || (name ? name.split(' ')[0] : null) || null, last: last_name || lastname || null, custom: JSON.stringify(custom), tags: JSON.stringify(tags), verification: checks[i].verification });
  });

  const { rows: [{ n }] } = await q(`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1`, [tid(req)]);
  const { rows: [plan] } = await q(`SELECT p.max_contacts, p.name FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`, [tid(req)]);
  if (n + good.length > plan.max_contacts) throw new HttpError(402, `Your ${plan.name} plan allows ${plan.max_contacts.toLocaleString()} contacts. Upgrade to import this file.`);

  let added = 0, updated = 0, newRows = [], joined = [];
  if (good.length) {
    await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO contacts (tenant_id, email, first_name, last_name, custom_fields, verification, tags, status)
         SELECT $1, e, f, l, cf::jsonb, v, ARRAY(SELECT jsonb_array_elements_text(tg::jsonb)), 'subscribed'
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS t(e, f, l, cf, v, tg)
         ON CONFLICT (tenant_id, email) DO UPDATE SET
           first_name = COALESCE(EXCLUDED.first_name, contacts.first_name),
           last_name = COALESCE(EXCLUDED.last_name, contacts.last_name),
           custom_fields = contacts.custom_fields || EXCLUDED.custom_fields,
           tags = ARRAY(SELECT DISTINCT unnest(contacts.tags || EXCLUDED.tags)),
           status = CASE WHEN contacts.status = 'pending' THEN 'subscribed' ELSE contacts.status END
         RETURNING id, email, (xmax = 0) AS inserted`,
        [tid(req), good.map((g) => g.email), good.map((g) => g.first), good.map((g) => g.last), good.map((g) => g.custom), good.map((g) => g.verification), good.map((g) => g.tags)]);
      added = rows.filter((r) => r.inserted).length; updated = rows.length - added;
      newRows = rows.filter((r) => r.inserted);
      const ids = rows.map((r) => r.id);
      if (listId) joined = (await c.query(`INSERT INTO list_members (list_id, contact_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING RETURNING contact_id`, [listId, ids])).rows.map((r) => r.contact_id);
      await c.query(`INSERT INTO consent_log (tenant_id, contact_id, action, source, ip, user_agent) SELECT $1, unnest($2::uuid[]), 'opt_in', $3, $4, $5`,
        [tid(req), ids, `import:${req.file.originalname}`.slice(0, 120), req.ip, (req.headers['user-agent'] || '').slice(0, 200)]);
    });
  }
  if (newRows.length) {                                              // start journeys for brand-new people
    enrollSafe(tid(req), newRows.map((r) => r.id), 'subscribed');
    const byTag = new Map(), idOf = new Map(newRows.map((r) => [String(r.email).toLowerCase(), r.id]));
    for (const g of good) for (const t of JSON.parse(g.tags)) if (idOf.has(g.email)) byTag.set(t, [...(byTag.get(t) || []), idOf.get(g.email)]);
    for (const [t, ids] of byTag) enrollSafe(tid(req), ids, 'tag_added', { tag: t });
  }
  if (listId && joined.length) enrollSafe(tid(req), joined, 'list_joined', { list_id: listId });
  res.json({ added, updated, duplicates, rejected: rejected.length, rejected_sample: rejected.slice(0, 20) });
});

// ---------- tags ----------
const cleanTag = (v) => { const t = String(v ?? '').trim().toLowerCase().slice(0, 30); if (!/^[a-z0-9][a-z0-9 _.-]*$/.test(t)) throw new HttpError(400, 'Tags use letters, numbers, spaces, - _ . only.'); return t; };
const segmentFrom = (b) => (b?.rules?.length ? { match: b.match === 'any' ? 'any' : 'all', rules: b.rules.map((r) => ({ field: String(r.field), value: String(r.value ?? '') })) } : null);
api.post('/contacts/:id/tags', async (req, res) => {
  const t = cleanTag(req.body.tag);
  const { rows } = await q(`UPDATE contacts SET tags = ARRAY(SELECT DISTINCT unnest(tags || ARRAY[$3::text])) WHERE id = $1 AND tenant_id = $2 RETURNING id`, [uuid(req.params.id), tid(req), t]);
  if (!rows.length) throw new HttpError(404, 'Contact not found.');
  enrollSafe(tid(req), [rows[0].id], 'tag_added', { tag: t });
  res.json({ ok: true });
});
api.post('/audience/tag', async (req, res) => {
  const t = cleanTag(req.body.tag);
  const ids = (await audience({ tenantId: tid(req), listId: req.body.list_id ? uuid(req.body.list_id) : null, segment: segmentFrom(req.body.segment), limit: 100000 })).map((r) => r.id);
  if (ids.length) await q(`UPDATE contacts SET tags = ARRAY(SELECT DISTINCT unnest(tags || ARRAY[$2::text])) WHERE id = ANY($1::uuid[])`, [ids, t]);
  enrollSafe(tid(req), ids, 'tag_added', { tag: t });
  res.json({ tagged: ids.length });
});

// ---------- API keys ----------
api.get('/keys', async (req, res) => {
  const { rows } = await q('SELECT id, name, prefix, scope, last_used_at, created_at FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC', [tid(req)]);
  res.json(rows);
});
api.post('/keys', async (req, res) => {
  const name = need(req.body.name, 'Name the key, e.g. "Website form".').slice(0, 60);
  const scope = req.body.scope === 'read' ? 'read' : 'write';
  const { rows: [{ n }] } = await q('SELECT count(*)::int AS n FROM api_keys WHERE tenant_id = $1', [tid(req)]);
  if (n >= 10) throw new HttpError(400, 'You can have up to 10 keys. Revoke one first.');
  const key = 'dk_live_' + crypto.randomBytes(24).toString('base64url');
  await q('INSERT INTO api_keys (tenant_id, name, prefix, key_hash, scope) VALUES ($1,$2,$3,$4,$5)', [tid(req), name, key.slice(0, 12), crypto.createHash('sha256').update(key).digest('hex'), scope]);
  res.status(201).json({ key, scope });                         // shown once; only the hash is stored
});
api.delete('/keys/:id', async (req, res) => {
  await q('DELETE FROM api_keys WHERE id = $1 AND tenant_id = $2', [uuid(req.params.id), tid(req)]);
  res.json({ ok: true });
});

// ---------- sending domains ----------
api.get('/domains', async (req, res) => {
  const { rows } = await q('SELECT id, domain, spf_ok, dkim_ok, dmarc_ok, dkim_selector, verified_at FROM sending_domains WHERE tenant_id = $1 ORDER BY domain', [tid(req)]);
  res.json(rows.map((r) => ({ ...r, ownership_record: ownershipRecord(tid(req), r.domain) })));
});
api.post('/domains', async (req, res) => {
  const domain = need(req.body.domain, 'Enter a domain.').toLowerCase().replace(/^.*@/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new HttpError(400, 'That does not look like a domain, e.g. mail.example.com.');
  const { rows: [plan] } = await q(`SELECT p.max_domains FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`, [tid(req)]);
  const { rows: [{ n }] } = await q('SELECT count(*)::int AS n FROM sending_domains WHERE tenant_id = $1', [tid(req)]);
  if (n >= plan.max_domains) throw new HttpError(402, `Your plan allows ${plan.max_domains} sending domain(s). Upgrade to add more.`);
  try {
    const { rows: [d] } = await q('INSERT INTO sending_domains (tenant_id, domain, dkim_selector) VALUES ($1, $2, $3) RETURNING id', [tid(req), domain, String(req.body.dkim_selector || '').trim() || null]);
    res.status(201).json({ ...d, ownership_record: ownershipRecord(tid(req), domain) });
  } catch (e) { if (e.code === '23505') throw new HttpError(409, 'That domain is already added.'); throw e; }
});
api.delete('/domains/:id', async (req, res) => {
  await q('DELETE FROM sending_domains WHERE id = $1 AND tenant_id = $2', [uuid(req.params.id), tid(req)]);
  res.json({ ok: true });
});
const txt = async (name) => { try { return (await dns.resolveTxt(name)).map((a) => a.join('')); } catch { return []; } };
// Proof of ownership: the tenant must publish this TXT record before a domain can become verified.
// Stateless (HMAC of server secret + tenant + domain): no migration needed, and one tenant's token is useless to another tenant.
const OWNERSHIP_LABEL = 'hiringarrow-verify';
const ownershipValue = (tenantId, domain) => OWNERSHIP_LABEL + '=' + crypto.createHmac('sha256', config.signSecret).update('domain-verify:' + tenantId + ':' + domain).digest('hex').slice(0, 32);
const ownershipRecord = (tenantId, domain) => ({ type: 'TXT', host: '_' + OWNERSHIP_LABEL + '.' + domain, value: ownershipValue(tenantId, domain) });
api.post('/domains/:id/check', async (req, res) => {
  const { rows: [d] } = await q('SELECT * FROM sending_domains WHERE id = $1 AND tenant_id = $2', [uuid(req.params.id), tid(req)]);
  if (!d) throw new HttpError(404, 'Domain not found.');
  if (req.body?.dkim_selector) d.dkim_selector = String(req.body.dkim_selector).trim();
  const root = d.domain.split('.').slice(-2).join('.');
  const spf = [...await txt(d.domain), ...(root !== d.domain ? await txt(root) : [])].some((t) => /^v=spf1\b/i.test(t));
  let dkim = false;
  if (d.dkim_selector) {
    const host = `${d.dkim_selector}._domainkey.${d.domain}`;
    dkim = (await txt(host)).some((t) => /v=DKIM1|p=/i.test(t));
    if (!dkim) { try { dkim = (await dns.resolveCname(host)).length > 0; } catch { /* none */ } }
  }
  const dmarc = [...await txt(`_dmarc.${d.domain}`), ...(root !== d.domain ? await txt(`_dmarc.${root}`) : [])].some((t) => /^v=DMARC1/i.test(t));
  const owner = (await txt('_' + OWNERSHIP_LABEL + '.' + d.domain)).some((v) => v.trim() === ownershipValue(d.tenant_id, d.domain));
  const verified = owner && spf && dkim;
  await q('UPDATE sending_domains SET spf_ok = $2, dkim_ok = $3, dmarc_ok = $4, dkim_selector = $5, verified_at = CASE WHEN $6 THEN COALESCE(verified_at, now()) ELSE NULL END WHERE id = $1',
    [d.id, spf, dkim, dmarc, d.dkim_selector, verified]);
  res.json({ spf, dkim, dmarc, owner, verified, needs_selector: !d.dkim_selector, ownership_record: ownershipRecord(d.tenant_id, d.domain) });
});

// ---------- campaigns ----------
const campaignFields = async (req) => {
  const b = req.body;
  const ab = b.subject_b && String(b.subject_b).trim();
  const f = {
    name: need(b.name, 'Name the campaign.'), subject: need(b.subject, 'Add a subject line.'),
    subject_b: ab ? ab.slice(0, 150) : null, ab_split: Math.min(90, Math.max(10, Math.round(+b.ab_split || 50))),
    preheader: String(b.preheader || '').slice(0, 200) || null,
    from_name: need(b.from_name, 'Add a From name.'), from_email: need(b.from_email, 'Add a From address.').toLowerCase(),
    html: need(b.html, 'The email body is empty.'), list_id: b.list_id ? uuid(b.list_id) : null,
    send_time_opt: !!b.send_time_opt,
    segment: b.segment && b.segment.rules?.length ? { match: b.segment.match === 'any' ? 'any' : 'all', rules: b.segment.rules.map((r) => ({ field: String(r.field), value: String(r.value ?? '') })) } : null,
  };
  const rt = String(b.reply_to || '').trim().toLowerCase().slice(0, 200);
  if (rt && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rt)) throw new HttpError(400, 'Enter a valid Reply-To email.');
  f.reply_to = rt || null;
  if (f.segment) segmentSql(f.segment, []);                       // validates every rule
  if (f.list_id) {
    const { rows } = await q('SELECT 1 FROM lists WHERE id = $1 AND tenant_id = $2', [f.list_id, tid(req)]);
    if (!rows.length) throw new HttpError(404, 'List not found.');
  }
  const { rows: [d] } = await q('SELECT id FROM sending_domains WHERE tenant_id = $1 AND domain = $2', [tid(req), f.from_email.split('@')[1] || '']);
  f.domain_id = d?.id || null;
  return f;
};
const getCampaign = async (req) => {
  const { rows: [c] } = await q('SELECT * FROM campaigns WHERE id = $1 AND tenant_id = $2', [uuid(req.params.id), tid(req)]);
  if (!c) throw new HttpError(404, 'Campaign not found.');
  return c;
};
const COLS = '(tenant_id, name, subject, subject_b, ab_split, preheader, from_name, from_email, domain_id, html, list_id, segment, send_time_opt, reply_to)';

api.get('/campaigns', async (req, res) => {
  const { rows } = await q(
    `SELECT ca.id, ca.name, ca.subject, ca.status, ca.created_at, ca.scheduled_at, ca.spam_score, ca.list_id,
            count(m.id)::int AS recipients,
            count(m.id) FILTER (WHERE m.status IN ('sent','delivered','bounced','complained'))::int AS sent,
            count(m.id) FILTER (WHERE m.status = 'queued')::int AS queued,
            count(m.id) FILTER (WHERE m.status = 'bounced')::int AS bounced,
            count(m.id) FILTER (WHERE m.status = 'complained')::int AS complained,
            (SELECT count(DISTINCT e.message_id) FROM events e JOIN messages mm ON mm.id = e.message_id WHERE mm.campaign_id = ca.id AND e.type = 'open')::int AS opens,
            (SELECT count(DISTINCT e.message_id) FROM events e JOIN messages mm ON mm.id = e.message_id WHERE mm.campaign_id = ca.id AND e.type = 'click')::int AS clicks
     FROM campaigns ca LEFT JOIN messages m ON m.campaign_id = ca.id
     WHERE ca.tenant_id = $1 AND ca.kind = 'broadcast' GROUP BY ca.id ORDER BY ca.created_at DESC LIMIT 100`, [tid(req)]);
  res.json(rows);
});
api.get('/campaigns/:id', async (req, res) => res.json(await getCampaign(req)));
api.post('/campaigns', async (req, res) => {
  const f = await campaignFields(req);
  const { rows: [c] } = await q(
    `INSERT INTO campaigns ${COLS} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [tid(req), f.name, f.subject, f.subject_b, f.ab_split, f.preheader, f.from_name, f.from_email, f.domain_id, f.html, f.list_id, f.segment, f.send_time_opt, f.reply_to]);
  res.status(201).json(c);
});
api.put('/campaigns/:id', async (req, res) => {
  const c = await getCampaign(req);
  if (!['draft', 'preflight_failed'].includes(c.status)) throw new HttpError(409, c.status === 'scheduled' ? 'Unschedule this campaign before editing it.' : 'Only drafts can be edited.');
  const f = await campaignFields(req);
  await q(`UPDATE campaigns SET name=$2, subject=$3, subject_b=$4, ab_split=$5, preheader=$6, from_name=$7, from_email=$8, domain_id=$9, html=$10, list_id=$11, segment=$12, send_time_opt=$13, reply_to=$14, status='draft' WHERE id=$1`,
    [c.id, f.name, f.subject, f.subject_b, f.ab_split, f.preheader, f.from_name, f.from_email, f.domain_id, f.html, f.list_id, f.segment, f.send_time_opt, f.reply_to]);
  res.json({ ok: true });
});
api.post('/campaigns/:id/duplicate', async (req, res) => {
  const c = await getCampaign(req);
  const { rows: [n] } = await q(
    `INSERT INTO campaigns ${COLS} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [tid(req), `${c.name} (copy)`.slice(0, 120), c.subject, c.subject_b, c.ab_split, c.preheader, c.from_name, c.from_email, c.domain_id, c.html, c.list_id, c.segment, c.send_time_opt, c.reply_to]);
  res.status(201).json(n);
});
api.delete('/campaigns/:id', async (req, res) => {
  const c = await getCampaign(req);
  if (c.status === 'sending') throw new HttpError(409, 'Pause the campaign before deleting it.');
  await q('DELETE FROM campaigns WHERE id = $1', [c.id]);
  res.json({ ok: true });
});

api.post('/audience/preview', async (req, res) => {
  const listId = req.body.list_id ? uuid(req.body.list_id) : null;
  const seg = req.body.segment?.rules?.length ? { match: req.body.segment.match === 'any' ? 'any' : 'all', rules: req.body.segment.rules.map((r) => ({ field: String(r.field), value: String(r.value ?? '') })) } : null;
  res.json(await audience({ tenantId: tid(req), listId, segment: seg, campaignId: req.body.campaign_id ? uuid(req.body.campaign_id) : null, countOnly: true, sample: 5 }));
});

api.post('/campaigns/:id/preflight', async (req, res) => {
  const { domain, ...r } = await runPreflight(tid(req), await getCampaign(req));
  res.json(r);
});

api.post('/campaigns/:id/test', testLimiter, async (req, res) => {
  const c = await getCampaign(req);
  const { rows: [me] } = await q('SELECT u.email, t.postal_address FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1', [req.user.uid]);
  const fake = '00000000-0000-4000-8000-000000000000';
  const { html, text } = renderMessage({ html: c.html, preheader: c.preheader, contact: { email: me.email, first_name: 'Test', last_name: 'Reader' }, messageId: fake, unsubUrl: `${config.baseUrl}/u/test`, address: me.postal_address || '' });
  const sysAddr = (config.systemFrom.match(/<([^>]+)>/) || [])[1] || config.systemFrom;
  const shownName = String(c.from_name || '').replace(/["<>\r\n]/g, '').trim().slice(0, 60) || 'Test';
  const who = String(me.email).replace(/[&<>"']/g, '');
  const bannerText = 'TEST EMAIL requested by the account owner (' + who + '). This is not a real campaign.\n\n';
  const bannerHtml = '<div style="font:12px Arial,sans-serif;color:#777;border-bottom:1px solid #ddd;padding:8px 0;margin-bottom:12px">TEST EMAIL requested by the account owner (' + who + '). This is not a real campaign.</div>';
  const htmlWithBanner = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (b) => b + bannerHtml) : bannerHtml + html;
  await sendMail({ from: `"${shownName} (test)" <${sysAddr}>`, to: me.email, subject: `[Test] ${c.subject}`, html: htmlWithBanner, text: bannerText + text });
  res.json({ sent_to: me.email });
});

api.post('/campaigns/:id/send', async (req, res) => {
  const c = await getCampaign(req);
  if (!['draft', 'preflight_failed', 'scheduled', 'sending', 'done'].includes(c.status)) throw new HttpError(409, c.status === 'paused' ? 'This campaign is paused. Resume it instead.' : 'This campaign cannot be sent right now.');
  const r = await startCampaign(tid(req), c);
  if (r.preflight) return res.status(422).json({ error: 'Fix these issues before sending.', ...r.preflight });
  res.json(r);
});

api.post('/campaigns/:id/schedule', async (req, res) => {
  const c = await getCampaign(req);
  if (!['draft', 'preflight_failed', 'scheduled'].includes(c.status)) throw new HttpError(409, 'Only drafts can be scheduled.');
  const at = new Date(req.body.at);
  if (isNaN(at) || at.getTime() < Date.now() + 60_000) throw new HttpError(400, 'Pick a time at least a minute from now.');
  if (at.getTime() > Date.now() + 90 * 864e5) throw new HttpError(400, 'Schedule within the next 90 days.');
  const pf = await runPreflight(tid(req), c);
  if (!pf.ok) return res.status(422).json({ error: 'Fix these issues before scheduling.', errors: pf.errors, warnings: pf.warnings, score: pf.score });
  await q(`UPDATE campaigns SET status = 'scheduled', scheduled_at = $2 WHERE id = $1`, [c.id, at]);
  res.json({ scheduled_at: at });
});
api.post('/campaigns/:id/unschedule', async (req, res) => {
  const c = await getCampaign(req);
  await q(`UPDATE campaigns SET status = 'draft', scheduled_at = NULL WHERE id = $1 AND status = 'scheduled'`, [c.id]);
  res.json({ ok: true });
});

api.post('/campaigns/:id/pause', async (req, res) => {
  const c = await getCampaign(req);
  await q(`UPDATE campaigns SET status = 'paused' WHERE id = $1 AND status = 'sending'`, [c.id]);
  res.json({ ok: true });
});
api.post('/campaigns/:id/resume', async (req, res) => {
  const c = await getCampaign(req);
  if (c.status !== 'paused') throw new HttpError(409, 'Only paused campaigns can be resumed.');
  await q(`UPDATE campaigns SET status = 'sending' WHERE id = $1`, [c.id]);
  const { rows } = await q(`SELECT id FROM messages WHERE campaign_id = $1 AND status = 'queued'`, [c.id]);
  if (rows.length) await enqueueMessages(rows.map((r) => r.id));
  res.json({ requeued: rows.length });
});

api.get('/campaigns/:id/report', async (req, res) => {
  const c = await getCampaign(req);
  const id = c.id;
  const [tot, byVar, tl, sentTl, links, doms, proxy] = await Promise.all([
    q(`SELECT count(*)::int AS recipients,
              count(*) FILTER (WHERE status IN ('sent','delivered','bounced','complained'))::int AS sent,
              count(*) FILTER (WHERE status = 'queued')::int AS queued,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE status = 'bounced')::int AS bounced,
              count(*) FILTER (WHERE status = 'complained')::int AS complained,
              (SELECT count(DISTINCT e.message_id) FROM events e JOIN messages mm ON mm.id = e.message_id WHERE mm.campaign_id = $1 AND e.type = 'open')::int AS opens,
              (SELECT count(DISTINCT e.message_id) FROM events e JOIN messages mm ON mm.id = e.message_id WHERE mm.campaign_id = $1 AND e.type = 'click')::int AS clicks,
              (SELECT count(*) FROM events e JOIN messages mm ON mm.id = e.message_id WHERE mm.campaign_id = $1 AND e.type = 'unsubscribe')::int AS unsubs
       FROM messages WHERE campaign_id = $1`, [id]),
    q(`SELECT m.variant,
              count(*) FILTER (WHERE m.status IN ('sent','delivered','bounced','complained'))::int AS sent,
              count(DISTINCT e.message_id) FILTER (WHERE e.type = 'open')::int AS opens,
              count(DISTINCT e.message_id) FILTER (WHERE e.type = 'click')::int AS clicks
       FROM messages m LEFT JOIN events e ON e.message_id = m.id AND e.type IN ('open','click') WHERE m.campaign_id = $1 GROUP BY m.variant ORDER BY m.variant`, [id]),
    q(`SELECT date_trunc('hour', e.created_at) AS h, e.type, count(DISTINCT e.message_id)::int AS n
       FROM events e JOIN messages m ON m.id = e.message_id WHERE m.campaign_id = $1 AND e.type IN ('open','click') GROUP BY 1, 2 ORDER BY 1`, [id]),
    q(`SELECT date_trunc('hour', sent_at) AS h, count(*)::int AS n FROM messages WHERE campaign_id = $1 AND sent_at IS NOT NULL GROUP BY 1 ORDER BY 1`, [id]),
    q(`SELECT e.url, count(DISTINCT e.message_id)::int AS clicks FROM events e JOIN messages m ON m.id = e.message_id
       WHERE m.campaign_id = $1 AND e.type = 'click' GROUP BY e.url ORDER BY clicks DESC LIMIT 10`, [id]),
    q(`WITH s AS (SELECT m.id, m.status, split_part(c.email::text, '@', 2) AS domain FROM messages m JOIN contacts c ON c.id = m.contact_id
                   WHERE m.campaign_id = $1 AND m.status IN ('sent','delivered','bounced','complained'))
       SELECT s.domain, count(DISTINCT s.id)::int AS sent,
              count(DISTINCT s.id) FILTER (WHERE s.status = 'bounced')::int AS bounced,
              count(DISTINCT s.id) FILTER (WHERE s.status = 'complained')::int AS complained,
              count(DISTINCT e.message_id)::int AS opens
       FROM s LEFT JOIN events e ON e.message_id = s.id AND e.type = 'open' GROUP BY s.domain ORDER BY sent DESC LIMIT 8`, [id]),
    q(`SELECT count(DISTINCT e.message_id)::int AS n FROM events e JOIN messages m ON m.id = e.message_id WHERE m.campaign_id = $1 AND e.type = 'open' AND e.meta->>'proxy' = 'true'`, [id]),
  ]);
  const buckets = new Map();
  const put = (h, k, n) => { const key = new Date(h).toISOString(); if (!buckets.has(key)) buckets.set(key, { t: key, sent: 0, opens: 0, clicks: 0 }); buckets.get(key)[k] += n; };
  sentTl.rows.forEach((r) => put(r.h, 'sent', r.n));
  tl.rows.forEach((r) => put(r.h, r.type === 'open' ? 'opens' : 'clicks', r.n));
  const timeline = [...buckets.values()].sort((a, b) => a.t.localeCompare(b.t)).slice(0, 96);
  res.json({
    campaign: { id, name: c.name, subject: c.subject, subject_b: c.subject_b, ab_split: c.ab_split, status: c.status, scheduled_at: c.scheduled_at, created_at: c.created_at, spam_score: c.spam_score },
    totals: tot.rows[0], variants: byVar.rows, timeline, links: links.rows, domains: doms.rows, proxy_opens: proxy.rows[0].n,
  });
});

// ---------- stats ----------
api.get('/stats', async (req, res) => {
  const T = tid(req);
  const { rows: [m] } = await q(
    `SELECT count(*) FILTER (WHERE status IN ('sent','delivered','bounced','complained'))::int AS sent,
            count(*) FILTER (WHERE status = 'bounced')::int AS bounced,
            count(*) FILTER (WHERE status = 'complained')::int AS complained
     FROM messages WHERE tenant_id = $1 AND created_at > now() - interval '30 days'`, [T]);
  const { rows: ev } = await q(
    `SELECT type, count(DISTINCT COALESCE(message_id::text, id::text))::int AS n FROM events WHERE tenant_id = $1 AND created_at > now() - interval '30 days' GROUP BY type`, [T]);
  const e = Object.fromEntries(ev.map((r) => [r.type, r.n]));
  const al = await allowance(T, null);
  const { rows: series } = await q(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day,
            (SELECT count(*) FROM messages WHERE tenant_id = $1 AND sent_at >= d AND sent_at < d + interval '1 day')::int AS sent,
            (SELECT count(DISTINCT message_id) FROM events WHERE tenant_id = $1 AND type = 'open' AND created_at >= d AND created_at < d + interval '1 day')::int AS opens,
            (SELECT count(DISTINCT message_id) FROM events WHERE tenant_id = $1 AND type = 'click' AND created_at >= d AND created_at < d + interval '1 day')::int AS clicks
     FROM generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d`, [T]);
  const { rows: [setup] } = await q(
    `SELECT t.status AS tenant_status, (COALESCE(t.postal_address, '') <> '') AS has_address,
            EXISTS (SELECT 1 FROM sending_domains WHERE tenant_id = t.id) AS has_domain,
            EXISTS (SELECT 1 FROM sending_domains WHERE tenant_id = t.id AND verified_at IS NOT NULL) AS domain_verified,
            EXISTS (SELECT 1 FROM contacts WHERE tenant_id = t.id AND status = 'subscribed') AS has_contacts,
            EXISTS (SELECT 1 FROM campaigns WHERE tenant_id = t.id) AS has_campaign,
            EXISTS (SELECT 1 FROM messages WHERE tenant_id = t.id AND status <> 'queued') AS has_sent
     FROM tenants t WHERE t.id = $1`, [T]);
  const { tenant_status, ...checklist } = setup;
  res.json({ sent: m.sent, delivered: m.sent - m.bounced, bounced: m.bounced, complained: m.complained, opens: e.open || 0, clicks: e.click || 0, unsubscribes: e.unsubscribe || 0,
    month: al.month, day: al.day, tenant_status, circuit: config.circuit, series, checklist });
});

// ---------- billing ----------
api.get('/plans', async (req, res) => {
  const { rows } = await q('SELECT code, name, price_inr, monthly_emails, max_contacts, max_domains, features FROM plans ORDER BY price_inr');
  res.json(rows);
});
api.post('/billing/subscribe', async (req, res) => {
  const { rows: [plan] } = await q('SELECT * FROM plans WHERE code = $1', [String(req.body.plan_code || '')]);
  if (!plan) throw new HttpError(404, 'Plan not found.');
  const rz = config.razorpay;
  if (plan.price_inr === 0) {
    await q('UPDATE tenants SET plan_id = $2 WHERE id = $1', [tid(req), plan.id]);
    return res.json({ switched: true });
  }
  if (!rz.keyId || !plan.razorpay_plan_id) {
    if (config.prod) throw new HttpError(503, 'Payments are not configured yet.');
    await q('UPDATE tenants SET plan_id = $2 WHERE id = $1', [tid(req), plan.id]);   // dev: no payment gateway
    return res.json({ switched: true, dev: true });
  }
  const r = await fetch('https://api.razorpay.com/v1/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${rz.keyId}:${rz.keySecret}`).toString('base64') },
    body: JSON.stringify({ plan_id: plan.razorpay_plan_id, total_count: 120, customer_notify: 1, notes: { tenant_id: tid(req), plan_code: plan.code } }),
  });
  const body = await r.json();
  if (!r.ok) throw new HttpError(502, body.error?.description || 'Payment provider error.');
  res.json({ checkout_url: body.short_url });
});

// ---------- error handler ----------
api.use((err, req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large (10 MB max).' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
});
