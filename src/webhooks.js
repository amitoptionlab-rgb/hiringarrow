import express from 'express';
import crypto from 'node:crypto';
import MessageValidator from 'sns-validator';
import { config } from './config.js';
import { q } from './db.js';
import { suppress } from './lib/suppress.js';

export const webhooks = express.Router();
const validator = new MessageValidator();
const validate = (m) => new Promise((resolve, reject) => validator.validate(m, (e, v) => (e ? reject(e) : resolve(v))));

// Amazon SES -> SNS -> here. Set the SNS topic to deliver to POST /webhooks/ses
webhooks.post('/ses', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  let body;
  try { body = JSON.parse(req.body); } catch { return res.status(400).end(); }
  try { if (config.snsVerify) await validate(body); } catch { return res.status(403).end(); }
  if (config.snsTopicArn && body.TopicArn !== config.snsTopicArn) return res.status(403).end();

  if (body.Type === 'SubscriptionConfirmation') {
    if (/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\//.test(body.SubscribeURL || '')) await fetch(body.SubscribeURL);
    return res.end();
  }
  if (body.Type !== 'Notification') return res.end();

  let n; try { n = JSON.parse(body.Message); } catch { return res.end(); }
  const type = n.notificationType || n.eventType;
  const { rows: [m] } = await q(
    `SELECT m.id, m.tenant_id, c.email FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE m.provider_msg_id = $1`, [n.mail?.messageId]);
  if (!m) return res.end();
  const ev = (t, meta) => q(`INSERT INTO events (tenant_id, message_id, type, meta) VALUES ($1, $2, $3, $4)`, [m.tenant_id, m.id, t, meta]);

  if (type === 'Bounce') {
    const permanent = n.bounce?.bounceType === 'Permanent';
    await ev('bounce', { type: n.bounce?.bounceType, sub: n.bounce?.bounceSubType });
    if (permanent) {
      await q(`UPDATE messages SET status = 'bounced' WHERE id = $1`, [m.id]);
      await suppress(m.tenant_id, m.email, 'hard_bounce', 'bounced');
    }
  } else if (type === 'Complaint') {
    await ev('complaint', { feedback: n.complaint?.complaintFeedbackType });
    await q(`UPDATE messages SET status = 'complained' WHERE id = $1`, [m.id]);
    await suppress(m.tenant_id, m.email, 'complaint', 'complained');
  } else if (type === 'Delivery') {
    await ev('delivered', null);
    await q(`UPDATE messages SET status = 'delivered' WHERE id = $1 AND status = 'sent'`, [m.id]);
  }
  res.end();
});

// Razorpay subscription events. Configure the webhook secret in the Razorpay dashboard.
webhooks.post('/razorpay', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const sig = String(req.headers['x-razorpay-signature'] || '');
  const want = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(req.body).digest('hex');
  if (!config.razorpay.webhookSecret || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return res.status(400).end();
  const ev = JSON.parse(req.body.toString());
  const sub = ev.payload?.subscription?.entity;
  const tenantId = sub?.notes?.tenant_id;
  if (!tenantId) return res.end();
  if (['subscription.activated', 'subscription.charged'].includes(ev.event)) {
    const { rows: [p] } = await q('SELECT id FROM plans WHERE code = $1', [sub.notes.plan_code]);
    if (p) {
      await q('UPDATE tenants SET plan_id = $2 WHERE id = $1', [tenantId, p.id]);
      await q(`INSERT INTO subscriptions (tenant_id, plan_id, provider_sub_id, status, current_period_start, current_period_end)
               VALUES ($1, $2, $3, 'active', to_timestamp($4), to_timestamp($5))`, [tenantId, p.id, sub.id, sub.current_start || 0, sub.current_end || 0]);
    }
  } else if (['subscription.cancelled', 'subscription.halted', 'subscription.completed'].includes(ev.event)) {
    await q(`UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE code = 'free') WHERE id = $1`, [tenantId]);
    await q(`UPDATE subscriptions SET status = 'cancelled' WHERE provider_sub_id = $1`, [sub.id]);
  }
  res.end();
});

// ---------- Brevo (free SMTP relay) bounce / complaint feed ----------
// In Brevo: Transactional > Settings > Webhook > add  https://YOUR_HOST/webhooks/brevo?token=BREVO_WEBHOOK_SECRET
// and tick: delivered, soft bounce, hard bounce, invalid email, blocked, spam (complaint), unsubscribed.
// Events are matched to our message through the X-Mailin-custom header we put on every email.
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function brevoAuthorised(req) {
  const secret = config.brevo.webhookSecret;
  if (!secret) return false;                                                    // not configured: refuse everything
  if (typeof req.query.token === 'string' && same(req.query.token, secret)) return true;
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return same(h.slice(7), secret);
  if (h.startsWith('Basic ')) { const pw = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':'); return same(pw, secret); }
  return false;
}
const PERMANENT = new Set(['hard_bounce', 'hardbounce', 'invalid_email', 'invalid', 'blocked']);
const TRANSIENT = new Set(['soft_bounce', 'softbounce', 'deferred', 'error']);

async function brevoEvent(e) {
  const kind = String(e?.event || '').toLowerCase();
  const id = String(e?.['X-Mailin-custom'] || '').trim();
  const email = String(e?.email || '').trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(id) || !email) return;                           // not one of ours
  const { rows: [m] } = await q(`SELECT m.id, m.tenant_id, m.status, c.email FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE m.id = $1`, [id]);
  if (!m || String(m.email).toLowerCase() !== email) return;                    // unknown message, or the address does not match it
  const ev = (type, meta) => q(`INSERT INTO events (tenant_id, message_id, type, meta) VALUES ($1, $2, $3, $4)`, [m.tenant_id, m.id, type, meta]);

  if (PERMANENT.has(kind)) {
    if (m.status === 'bounced') return;                                         // Brevo retries: handle once
    await ev('bounce', { type: 'Permanent', via: 'brevo', event: kind });
    await q(`UPDATE messages SET status = 'bounced', last_error = $2 WHERE id = $1`, [m.id, `brevo ${kind}: ${String(e.reason || '').slice(0, 200)}`]);
    await suppress(m.tenant_id, m.email, 'hard_bounce', 'bounced');
  } else if (TRANSIENT.has(kind)) {
    await ev('bounce', { type: 'Transient', via: 'brevo', event: kind });
  } else if (kind === 'spam' || kind === 'complaint') {
    if (m.status === 'complained') return;
    await ev('complaint', { via: 'brevo' });
    await q(`UPDATE messages SET status = 'complained' WHERE id = $1`, [m.id]);
    await suppress(m.tenant_id, m.email, 'complaint', 'complained');
  } else if (kind === 'unsubscribe' || kind === 'unsubscribed') {
    await ev('unsubscribe', { via: 'brevo' });
    await suppress(m.tenant_id, m.email, 'unsubscribe', 'unsubscribed');
  } else if (kind === 'delivered') {
    if (m.status !== 'sent') return;
    await ev('delivered', { via: 'brevo' });
    await q(`UPDATE messages SET status = 'delivered' WHERE id = $1 AND status = 'sent'`, [m.id]);
  }
  // opens and clicks are ignored on purpose: we track those ourselves
}
webhooks.post('/brevo', express.json({ limit: '1mb' }), async (req, res) => {
  if (!brevoAuthorised(req)) return res.status(401).end();
  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const e of events.slice(0, 500)) { try { await brevoEvent(e); } catch (err) { console.error('[brevo]', err.message); } }
  res.end();
});
