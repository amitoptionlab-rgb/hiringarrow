import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { q } from './db.js';
import { signId, verifyId, verifyLink, verifyTimed } from './lib/tokens.js';
import { checkEmail } from './lib/validate.js';
import { suppress } from './lib/suppress.js';
import { sendMail } from './lib/mailer.js';
import { enrollSafe } from './lib/automation.js';

export const pub = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.55 system-ui,sans-serif;background:#f4f5f3;color:#1c2630;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;max-width:420px;width:calc(100% - 32px);padding:32px;border-radius:6px;box-shadow:0 1px 0 #d9ddd8}
h1{font-size:1.3rem;margin:0 0 12px}input{width:100%;box-sizing:border-box;padding:10px;margin:6px 0 14px;border:1px solid #b9c0ba;border-radius:4px;font:inherit}
button{background:#0b6e6a;color:#fff;border:0;padding:11px 18px;border-radius:4px;font:inherit;cursor:pointer}.muted{color:#66716b;font-size:.9rem}</style></head><body><main>${body}</main></body></html>`;

// ---------- tracking ----------
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const engage = (contactId, pts) => q('UPDATE contacts SET last_engaged_at = now(), engagement_score = engagement_score + $2 WHERE id = $1', [contactId, pts]);

pub.get('/t/o/:file', async (req, res) => {
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' }).end(GIF);
  const id = req.params.file.replace(/\.gif$/, '');
  if (!UUID.test(id)) return;
  try {
    const { rows: [m] } = await q('SELECT tenant_id, contact_id FROM messages WHERE id = $1', [id]);
    if (!m) return;
    const ua = (req.headers['user-agent'] || '').slice(0, 200);
    await q(`INSERT INTO events (tenant_id, message_id, type, meta) VALUES ($1, $2, 'open', $3)`, [m.tenant_id, id, { ua, proxy: /GoogleImageProxy|YahooMailProxy/i.test(ua) }]);
    await engage(m.contact_id, 1);
  } catch (e) { console.error('open track', e.message); }
});

pub.get('/t/c/:id', async (req, res) => {
  const id = req.params.id;
  let url;
  try { url = Buffer.from(String(req.query.u || ''), 'base64url').toString(); } catch { url = ''; }
  if (!UUID.test(id) || !/^https?:\/\//i.test(url) || !verifyLink(id, url, req.query.s)) return res.status(400).send(page('Invalid link', '<h1>This link is not valid</h1>'));
  res.redirect(302, url);
  try {
    const { rows: [m] } = await q('SELECT tenant_id, contact_id, campaign_id FROM messages WHERE id = $1', [id]);
    if (!m) return;
    await q(`INSERT INTO events (tenant_id, message_id, type, url) VALUES ($1, $2, 'click', $3)`, [m.tenant_id, id, url.slice(0, 1000)]);
    await engage(m.contact_id, 2);
    enrollSafe(m.tenant_id, [m.contact_id], 'link_clicked', { campaign_id: m.campaign_id });
  } catch (e) { console.error('click track', e.message); }
});

// ---------- unsubscribe (page + RFC 8058 one-click POST) ----------
pub.get('/u/:token', async (req, res) => {
  const id = verifyId('u', req.params.token);
  if (!id) return res.status(400).send(page('Unsubscribe', '<h1>This link is not valid</h1>'));
  res.send(page('Unsubscribe', `<h1>Unsubscribe</h1><p>Stop receiving these emails?</p><form method="post"><button>Yes, unsubscribe me</button></form>`));
});
pub.post('/u/:token', async (req, res) => {
  const id = verifyId('u', req.params.token);
  if (!id) return res.status(400).send(page('Unsubscribe', '<h1>This link is not valid</h1>'));
  const { rows: [c] } = await q('SELECT id, tenant_id, email FROM contacts WHERE id = $1', [id]);
  if (c) {
    await suppress(c.tenant_id, c.email, 'unsubscribe', 'unsubscribed');
    await q(`INSERT INTO consent_log (tenant_id, contact_id, action, source, ip) VALUES ($1, $2, 'unsubscribe', 'link', $3)`, [c.tenant_id, c.id, req.ip]);
    await q(`INSERT INTO events (tenant_id, type) VALUES ($1, 'unsubscribe')`, [c.tenant_id]);
  }
  res.send(page('Unsubscribed', `<h1>You are unsubscribed</h1><p class="muted">You will not get more emails from this sender.</p>`));
});

// ---------- account email verification ----------
pub.get('/verify/:token', async (req, res) => {
  const id = verifyTimed('v', req.params.token);
  if (!id || !UUID.test(id)) return res.status(400).send(page('Verify email', '<h1>This link is not valid or has expired</h1><p class="muted">Log in again and we will send you a new one.</p>'));
  await q('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [id]);
  res.send(page('Email verified', '<h1>Email verified</h1><p><a href="/">Log in to your account</a></p>'));
});

// ---------- hosted signup form with double opt-in ----------
const subLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const tooMany = (req, res) => res.status(429).send(page('Too many requests', '<h1>Too many requests</h1><p class="muted">Please try again later.</p>'));
// one victim address gets at most 3 confirmation mails per hour in total, whatever list or tenant is used
const emailLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 3, standardHeaders: false, legacyHeaders: false, validate: false, handler: tooMany,
  keyGenerator: (req) => String(req.body?.email || '').trim().toLowerCase().slice(0, 254) });
const listLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: false, legacyHeaders: false, validate: false, handler: tooMany,
  keyGenerator: (req) => String(req.params.listId) });
pub.get('/s/:listId', async (req, res) => {
  if (!UUID.test(req.params.listId)) return res.status(404).send(page('Not found', '<h1>Not found</h1>'));
  const { rows: [l] } = await q('SELECT l.name, t.name AS tenant FROM lists l JOIN tenants t ON t.id = l.tenant_id WHERE l.id = $1', [req.params.listId]);
  if (!l) return res.status(404).send(page('Not found', '<h1>Not found</h1>'));
  res.send(page('Subscribe', `<h1>${esc(l.name)}</h1><p class="muted">From ${esc(l.tenant)}</p>
    <form method="post"><label>Email<input type="email" name="email" required autocomplete="email"></label>
    <label>First name (optional)<input name="first_name" autocomplete="given-name"></label>
    <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
    <button>Subscribe</button></form>`));
});
pub.post('/s/:listId', subLimiter, emailLimiter, listLimiter, async (req, res) => {
  const done = () => res.send(page('Check your inbox', '<h1>Check your inbox</h1><p>We sent a confirmation link. Click it to finish subscribing.</p>'));
  if (!UUID.test(req.params.listId) || req.body.website) return done();            // honeypot: act as if it worked
  const { rows: [l] } = await q('SELECT l.id, l.name, l.tenant_id, t.name AS tenant, t.status AS tenant_status FROM lists l JOIN tenants t ON t.id = l.tenant_id WHERE l.id = $1', [req.params.listId]);
  if (!l) return res.status(404).send(page('Not found', '<h1>Not found</h1>'));
  if (l.tenant_status !== 'active') return done();                                   // review/suspended tenants: no mail, no contact created
  const chk = await checkEmail(req.body.email, { mx: config.verifyMx });
  if (!chk.ok) return res.status(400).send(page('Check the address', `<h1>That email can't be used</h1><p>${esc(chk.reason)}. Go back and try again.</p>`));
  const { rows: [sup] } = await q('SELECT reason FROM suppressions WHERE tenant_id = $1 AND email = $2', [l.tenant_id, chk.email]);
  if (sup && sup.reason !== 'unsubscribe') return done();                            // bounced/complained: never re-add
  const { rows: [c] } = await q(
    `INSERT INTO contacts (tenant_id, email, first_name, status, verification) VALUES ($1, $2, $3, 'pending', $4)
     ON CONFLICT (tenant_id, email) DO UPDATE SET status = CASE WHEN contacts.status IN ('subscribed') THEN 'subscribed' ELSE 'pending' END
     RETURNING id, status`, [l.tenant_id, chk.email, String(req.body.first_name || '').trim().slice(0, 80) || null, chk.verification]);
  await q('INSERT INTO list_members (list_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [l.id, c.id]);
  await q(`INSERT INTO consent_log (tenant_id, contact_id, action, source, ip, user_agent) VALUES ($1, $2, 'opt_in', $3, $4, $5)`,
    [l.tenant_id, c.id, `form:${l.id}`, req.ip, (req.headers['user-agent'] || '').slice(0, 200)]);
  if (c.status === 'pending') {
    const link = `${config.baseUrl}/confirm/${signId('c', c.id)}`;
    await sendMail({
      from: config.systemFrom, to: chk.email, subject: `Confirm your subscription to ${l.name}`,
      text: `Confirm your subscription to ${l.name} from ${l.tenant}:\n${link}\n\nIf you did not ask for this, ignore this email.`,
      html: `<p>Confirm your subscription to <b>${esc(l.name)}</b> from ${esc(l.tenant)}:</p><p><a href="${link}">Confirm subscription</a></p><p style="color:#777;font-size:12px">If you did not ask for this, ignore this email.</p>`,
    }).catch((e) => console.error('confirm mail', e.message));
  }
  done();
});
pub.get('/confirm/:token', async (req, res) => {
  const id = verifyId('c', req.params.token);
  if (!id) return res.status(400).send(page('Confirm', '<h1>This link is not valid</h1>'));
  const { rows: [c] } = await q(`UPDATE contacts SET status = 'subscribed' WHERE id = $1 AND status IN ('pending', 'unsubscribed') RETURNING id, tenant_id, email`, [id]);
  if (c) {
    await q(`DELETE FROM suppressions WHERE tenant_id = $1 AND email = $2 AND reason = 'unsubscribe'`, [c.tenant_id, c.email]);
    await q(`INSERT INTO consent_log (tenant_id, contact_id, action, source, ip) VALUES ($1, $2, 'confirm', 'double-opt-in', $3)`, [c.tenant_id, c.id, req.ip]);
    enrollSafe(c.tenant_id, [c.id], 'subscribed');
    const { rows: ls } = await q('SELECT list_id FROM list_members WHERE contact_id = $1', [c.id]);
    for (const l of ls) enrollSafe(c.tenant_id, [c.id], 'list_joined', { list_id: l.list_id });
  }
  res.send(page('Subscribed', '<h1>You are subscribed</h1><p class="muted">Thanks for confirming.</p>'));
});
