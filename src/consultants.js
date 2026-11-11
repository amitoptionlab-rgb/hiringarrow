import express from 'express';
import rateLimit from 'express-rate-limit';
import { q, HttpError } from './db.js';

// Consultant profiles: add/edit your own, search public ones across tenants.
// Mounted by api.js AFTER its auth middleware, so req.user = { uid, tid, role } is always set.
export const consultants = express.Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTH = ['USC', 'GC', 'GC-EAD', 'H1B', 'H4-EAD', 'OPT', 'CPT', 'TN', 'Other'];
const ENGAGE = ['C2C', 'W2', '1099'];
const STATUS = ['available', 'placed', 'inactive'];
const VIS = ['public', 'private'];
const MAX_PER_TENANT = 5000;

const tid = (req) => req.user.tid;
const bad = (m) => { throw new HttpError(400, m); };
const uuid = (v) => (UUID.test(v || '') ? v : bad('Invalid id.'));
const txt = (v, max) => String(v ?? '').trim().slice(0, max) || null;
const csv = (v, max, len) => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(/[,;|]/)).map((x) => String(x).trim().toLowerCase().slice(0, len)).filter(Boolean))].slice(0, max);
const num = (v, lo, hi, label) => { if (v === '' || v == null) return null; const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) bad(`${label} must be a number between ${lo} and ${hi}.`); return n; };
const bool = (v) => v === true || v === 'true';
const authOf = (v) => AUTH.find((a) => a.toLowerCase() === String(v).trim().toLowerCase());
const okDate = (v) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return false; const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; };
const maskName = (n) => { const p = String(n).trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0].toUpperCase()}.` : p[0]; };
const redact = (s) => (s == null ? null : String(s).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email hidden]').replace(/\+?\d[\d\s().-]{8,}\d/g, '[phone hidden]'));
const limiter = (limit, windowMs, message) => rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.user.tid, message: { error: message } });
const searchLimiter = limiter(120, 10 * 60 * 1000, 'Too many searches. Try again in a few minutes.');
const viewLimiter = limiter(300, 60 * 60 * 1000, 'Too many profile views. Try again later.');
// Other tenants' profiles are only visible to approved (active) accounts: stops throw-away signups from scraping.
const canSeeOthers = async (req) => (await q('SELECT status FROM tenants WHERE id = $1', [tid(req)])).rows[0]?.status === 'active';

function clean(b, create) {
  const o = {}, has = (k) => b[k] !== undefined;
  if (create || has('full_name')) o.full_name = txt(b.full_name, 120) || bad('Name is required.');
  if (create || has('title')) o.title = txt(b.title, 150) || bad('Job title is required.');
  if (has('skills')) o.skills = csv(b.skills, 30, 40);
  if (has('experience_yrs')) o.experience_yrs = num(b.experience_yrs, 0, 60, 'Experience');
  if (has('work_auth')) { const v = txt(b.work_auth, 20); o.work_auth = v ? (authOf(v) || bad(`Work authorization must be one of: ${AUTH.join(', ')}.`)) : null; }
  if (has('engagement')) { o.engagement = csv(b.engagement, 3, 6).map((x) => x.toUpperCase()); if (o.engagement.some((x) => !ENGAGE.includes(x))) bad('Engagement must be C2C, W2 or 1099.'); }
  if (has('rate_usd_hr')) o.rate_usd_hr = num(b.rate_usd_hr, 0, 1000, 'Rate');
  if (has('city')) o.city = txt(b.city, 60);
  if (has('state')) o.state = txt(b.state, 60);
  if (has('country')) o.country = (txt(b.country, 2) || 'US').toUpperCase();
  if (has('relocate')) o.relocate = bool(b.relocate);
  if (has('remote_ok')) o.remote_ok = bool(b.remote_ok);
  if (has('available_from')) { const v = txt(b.available_from, 10); if (v && !okDate(v)) bad('Available-from must be a real date, YYYY-MM-DD.'); o.available_from = v; }
  if (has('status')) o.status = STATUS.includes(b.status) ? b.status : bad('Invalid status.');
  if (has('visibility')) o.visibility = VIS.includes(b.visibility) ? b.visibility : bad('Invalid visibility.');
  if (has('contact_email')) { const v = txt(b.contact_email, 200); if (v && !/^\S+@\S+\.\S+$/.test(v)) bad('Contact email looks invalid.'); o.contact_email = v; }
  if (has('contact_phone')) o.contact_phone = txt(b.contact_phone, 30);
  if (has('resume_text')) o.resume_text = txt(b.resume_text, 100000);
  return o;
}

const MINE_COLS = `id, full_name, title, skills, experience_yrs, work_auth, engagement, rate_usd_hr, city, state, country, relocate, remote_ok,
  available_from, status, visibility, contact_email, contact_phone, (resume_text IS NOT NULL) AS has_resume, created_at, updated_at`;
const PUBLIC_COLS = `c.id, c.full_name, c.title, c.skills, c.experience_yrs, c.work_auth, c.engagement, c.rate_usd_hr, c.city, c.state, c.country,
  c.relocate, c.remote_ok, c.available_from, c.status, c.updated_at, (c.tenant_id = $1) AS mine`;
const view = (r) => (r.mine ? r : { ...r, full_name: maskName(r.full_name) });

// ---------- search (own profiles + other tenants' public, available ones) ----------
consultants.get('/search', searchLimiter, async (req, res) => {
  const others = await canSeeOthers(req);
  const p = [tid(req)];
  const add = (v) => { p.push(v); return `$${p.length}`; };
  let where = others ? `(c.tenant_id = $1 OR (c.visibility = 'public' AND c.status = 'available'))` : 'c.tenant_id = $1';
  let score = '0';
  const qs = String(req.query.q || '').trim().slice(0, 200);
  if (qs) { const n = add(qs); where += ` AND c.search_doc @@ websearch_to_tsquery('simple', ${n})`; score = `ts_rank(c.search_doc, websearch_to_tsquery('simple', ${n}))`; }
  const sk = csv(req.query.skills, 10, 40);
  if (sk.length) where += ` AND c.skills @> ${add(sk)}::text[]`;
  const wa = csv(req.query.work_auth, 9, 10).map(authOf).filter(Boolean);
  if (wa.length) where += ` AND c.work_auth = ANY(${add(wa)}::text[])`;
  const en = csv(req.query.engagement, 3, 6).map((x) => x.toUpperCase()).filter((x) => ENGAGE.includes(x));
  if (en.length) where += ` AND c.engagement && ${add(en)}::text[]`;
  const st = txt(req.query.state, 60);
  if (st) where += ` AND lower(c.state) = ${add(st.toLowerCase())}`;
  const mr = num(req.query.max_rate, 0, 1000, 'max_rate');
  if (mr !== null) where += ` AND c.rate_usd_hr <= ${add(mr)}`;
  if (req.query.relocate === 'true') where += ' AND c.relocate';
  if (req.query.remote === 'true') where += ' AND c.remote_ok';
  const ab = txt(req.query.available_before, 10);
  if (ab && okDate(ab)) where += ` AND (c.available_from IS NULL OR c.available_from <= ${add(ab)}::date)`;

  const page = Math.max(1, Math.floor(+req.query.page || 1)), size = 25;
  const { rows } = await q(`SELECT ${PUBLIC_COLS}, ${score} AS score FROM consultants c WHERE ${where} ORDER BY score DESC, c.updated_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, p);
  const { rows: [{ total }] } = await q(`SELECT count(*)::int AS total FROM consultants c WHERE ${where}`, p);
  res.json({ rows: rows.map(({ score: _s, ...r }) => view(r)), total, page, size, searched_others: others });
});

// ---------- my profiles ----------
consultants.get('/mine', async (req, res) => {
  const page = Math.max(1, Math.floor(+req.query.page || 1)), size = 50;
  const { rows } = await q(`SELECT ${MINE_COLS} FROM consultants WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, [tid(req)]);
  const { rows: [{ total }] } = await q('SELECT count(*)::int AS total FROM consultants WHERE tenant_id = $1', [tid(req)]);
  res.json({ rows, total, page, size });
});

consultants.post('/', async (req, res) => {
  const o = clean(req.body || {}, true);
  const { rows: [n] } = await q('SELECT count(*)::int AS n FROM consultants WHERE tenant_id = $1', [tid(req)]);
  if (n.n >= MAX_PER_TENANT) throw new HttpError(403, `Profile limit reached (${MAX_PER_TENANT}).`);
  const cols = Object.keys(o);
  const { rows: [r] } = await q(
    `INSERT INTO consultants (tenant_id, created_by, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
    [tid(req), req.user.uid, ...cols.map((c) => o[c])]);
  res.status(201).json({ id: r.id });
});

consultants.get('/:id', viewLimiter, async (req, res) => {
  const { rows: [c] } = await q('SELECT c.*, (c.tenant_id = $2) AS mine FROM consultants c WHERE c.id = $1', [uuid(req.params.id), tid(req)]);
  if (!c) throw new HttpError(404, 'Profile not found.');
  if (!c.mine && !(c.visibility === 'public' && c.status === 'available' && await canSeeOthers(req))) throw new HttpError(404, 'Profile not found.');
  const { search_doc: _s, tenant_id: _t, created_by: _c, ...r } = c;
  if (c.mine) return res.json(r);
  const { contact_email: _e, contact_phone: _p, resume_key: _k, ...pub } = r;
  res.json({ ...pub, full_name: maskName(r.full_name), resume_text: redact(r.resume_text) });
});

consultants.put('/:id', async (req, res) => {
  const id = uuid(req.params.id), o = clean(req.body || {}, false), cols = Object.keys(o);
  if (!cols.length) bad('Nothing to update.');
  const { rowCount } = await q(`UPDATE consultants SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} WHERE id = $1 AND tenant_id = $2`, [id, tid(req), ...cols.map((c) => o[c])]);
  if (!rowCount) throw new HttpError(404, 'Profile not found.');
  res.json({ ok: true });
});

consultants.delete('/:id', async (req, res) => {
  const { rowCount } = await q('DELETE FROM consultants WHERE id = $1 AND tenant_id = $2', [uuid(req.params.id), tid(req)]);
  if (!rowCount) throw new HttpError(404, 'Profile not found.');
  res.json({ ok: true });
});

consultants.use((err, _req, res, next) => (err instanceof HttpError ? res.status(err.status).json({ error: err.message }) : next(err)));
