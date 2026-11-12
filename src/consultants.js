import express from 'express';
import rateLimit from 'express-rate-limit';
import { q, tx, HttpError } from './db.js';
import multer from 'multer';

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
  available_from, status, visibility, contact_email, contact_phone, (resume_text IS NOT NULL) AS has_resume, EXISTS (SELECT 1 FROM consultant_resumes r WHERE r.consultant_id = consultants.id) AS has_file, created_at, updated_at`;
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

// ---------- JD match: rank available profiles by how many JD skills they cover ----------
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
consultants.post('/match', searchLimiter, async (req, res) => {
  const others = await canSeeOthers(req);
  const p = [tid(req)];
  const add = (v) => { p.push(v); return `$${p.length}`; };
  const base = others ? `(c.tenant_id = $1 OR c.visibility = 'public')` : 'c.tenant_id = $1';
  const b = req.body || {};

  let sk = csv(b.skills, 30, 40);
  const jd = String(b.jd || '').slice(0, 20000).toLowerCase();
  if (!sk.length && jd) {
    // No AI: pick JD words that already exist as skills on visible, available profiles.
    const { rows } = await q(`SELECT DISTINCT s FROM consultants c, unnest(c.skills) s WHERE ${base} AND c.status = 'available' AND length(s) > 1 LIMIT 5000`, p);
    sk = rows.map((r) => r.s).filter((s) => new RegExp(`(^|[^a-z0-9+#.])${reEsc(s)}($|[^a-z0-9+#.])`).test(jd)).slice(0, 30);
  }
  if (!sk.length) bad('No known skills found. Paste a JD with skills, or type skills manually.');

  const sn = add(sk);
  let where = `${base} AND c.status = 'available' AND c.skills && ${sn}::text[]`;
  const wa = csv(b.work_auth, 9, 10).map(authOf).filter(Boolean);
  if (wa.length) where += ` AND c.work_auth = ANY(${add(wa)}::text[])`;
  const en = csv(b.engagement, 3, 6).map((x) => x.toUpperCase()).filter((x) => ENGAGE.includes(x));
  if (en.length) where += ` AND c.engagement && ${add(en)}::text[]`;
  const st = txt(b.state, 60);
  if (st) where += ` AND (lower(c.state) = ${add(st.toLowerCase())} OR c.remote_ok OR c.relocate)`;
  const mr = num(b.max_rate, 0, 1000, 'max_rate');
  if (mr !== null) where += ` AND c.rate_usd_hr <= ${add(mr)}`;

  const { rows } = await q(
    `SELECT ${PUBLIC_COLS},
       (SELECT count(*) FROM unnest(c.skills) s WHERE s = ANY(${sn}::text[]))::int AS matched,
       (SELECT array_agg(s) FROM unnest(c.skills) s WHERE s = ANY(${sn}::text[])) AS matched_skills
     FROM consultants c WHERE ${where} ORDER BY matched DESC, c.updated_at DESC LIMIT 25`, p);
  res.json({ skills_used: sk, rows: rows.map(view) });
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

// ---------- resume file (PDF/DOCX, stored in Postgres table consultant_resumes) ----------
const RESUME_MAX = 5 * 1024 * 1024;
const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const resumeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: RESUME_MAX, files: 1 } }).single('file');
const resumeLimiter = limiter(30, 60 * 60 * 1000, 'Too many resume uploads. Try again in an hour.');
const takeResume = (req, res, next) => resumeUpload(req, res, (err) => {
  if (!err) return next();
  next(err.code === 'LIMIT_FILE_SIZE' ? new HttpError(413, 'Resume must be 5 MB or smaller.') : new HttpError(400, 'Upload failed. Send exactly one file in the "file" field.'));
});
// Trust the bytes, not the extension or the client's mime type.
const sniff = (b) => {
  if (b.length > 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'docx';
  return null;
};
async function extractText(kind, buf) {
  if (kind === 'pdf') { const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js'); return (await pdfParse(buf)).text; }
  const { default: mammoth } = await import('mammoth');
  return (await mammoth.extractRawText({ buffer: buf })).value;
}
const safeName = (n, kind) => {
  const base = String(n || 'resume').replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'resume';
  return base.toLowerCase().endsWith('.' + kind) ? base : `${base}.${kind}`;
};

consultants.post('/:id/resume', resumeLimiter, takeResume, async (req, res) => {
  const id = uuid(req.params.id);
  if (!req.file) bad('Attach a PDF or DOCX in the "file" field.');
  const buf = req.file.buffer;
  const kind = sniff(buf) || bad('Only PDF or DOCX files are accepted.');
  const { rows: [own] } = await q('SELECT 1 AS ok FROM consultants WHERE id = $1 AND tenant_id = $2', [id, tid(req)]);
  if (!own) throw new HttpError(404, 'Profile not found.');
  let text;
  try { text = String((await extractText(kind, buf)) || '').replace(/\u0000/g, '').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 100000); }
  catch { bad('Could not read this file. Is it a valid, unprotected PDF or DOCX?'); }
  await tx(async (c) => {
    await c.query(
      `INSERT INTO consultant_resumes (consultant_id, filename, mime, size_bytes, data) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (consultant_id) DO UPDATE SET filename = EXCLUDED.filename, mime = EXCLUDED.mime, size_bytes = EXCLUDED.size_bytes, data = EXCLUDED.data, uploaded_at = now()`,
      [id, safeName(req.file.originalname, kind), MIME[kind], buf.length, buf]);
    // Scanned PDFs give no text: keep whatever text the profile already had instead of wiping it.
    if (text) await c.query('UPDATE consultants SET resume_text = $3 WHERE id = $1 AND tenant_id = $2', [id, tid(req), text]);
  });
  res.status(201).json({ ok: true, text_extracted: !!text, size_bytes: buf.length });
});

consultants.get('/:id/resume', viewLimiter, async (req, res) => {
  const { rows: [r] } = await q(
    'SELECT r.filename, r.mime, r.data FROM consultant_resumes r JOIN consultants c ON c.id = r.consultant_id WHERE r.consultant_id = $1 AND c.tenant_id = $2',
    [uuid(req.params.id), tid(req)]);
  if (!r) throw new HttpError(404, 'No resume on file.');
  res.set({ 'Content-Type': r.mime, 'Content-Disposition': `attachment; filename="${r.filename}"`, 'Content-Length': r.data.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).end(r.data);
});

consultants.get('/:id/resume/preview', viewLimiter, async (req, res) => {
  const { rows: [r] } = await q(
    'SELECT r.mime, r.data FROM consultant_resumes r JOIN consultants c ON c.id = r.consultant_id WHERE r.consultant_id = $1 AND c.tenant_id = $2',
    [uuid(req.params.id), tid(req)]);
  if (!r) throw new HttpError(404, 'No resume on file.');
  res.set('Cache-Control', 'private, no-store');
  if (r.mime === MIME.pdf) return res.json({ kind: 'pdf' });
  const { default: mammoth } = await import('mammoth');
  const { value } = await mammoth.convertToHtml({ buffer: r.data });
  res.json({ kind: 'docx', html: value });
});

consultants.delete('/:id/resume', async (req, res) => {
  const id = uuid(req.params.id);
  const done = await tx(async (c) => {
    const { rowCount } = await c.query('DELETE FROM consultant_resumes WHERE consultant_id = $1 AND consultant_id IN (SELECT id FROM consultants WHERE tenant_id = $2)', [id, tid(req)]);
    if (rowCount) await c.query('UPDATE consultants SET resume_text = NULL WHERE id = $1 AND tenant_id = $2', [id, tid(req)]);
    return rowCount;
  });
  if (!done) throw new HttpError(404, 'No resume on file.');
  res.json({ ok: true });
});

consultants.use((err, _req, res, next) => (err instanceof HttpError ? res.status(err.status).json({ error: err.message }) : next(err)));
