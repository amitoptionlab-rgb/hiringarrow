import crypto from 'node:crypto';
import { config } from '../config.js';
import { q } from '../db.js';
import { verifyReplyLocal } from './tokens.js';
import { sendMail } from './mailer.js';
import { suppress } from './suppress.js';

// Turns one inbound-parse item (Brevo "items[]" shape or Postmark-like shape) into one common shape.
// NOTE: field names come from provider docs, not from a real payload yet. Check with the first real reply.
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
function emailsIn(v) {
  const out = [];
  for (const x of asList(v)) {
    if (x == null) continue;
    if (typeof x === 'string') out.push(...(x.match(EMAIL_RE) || []));
    else if (typeof x === 'object') out.push(...emailsIn([x.Address, x.Email, x.address, x.email]));
  }
  return out.map((s) => s.toLowerCase());
}
function headerMap(h) {
  const m = {};
  if (Array.isArray(h)) {
    for (const x of h) { if (x && x.Name) m[String(x.Name).toLowerCase()] = String(x.Value ?? ''); }
  } else if (h && typeof h === 'object') {
    for (const [k, v] of Object.entries(h)) m[k.toLowerCase()] = Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
  }
  return m;
}
export function normalise(it) {
  const fromObj = it.From && typeof it.From === 'object' ? it.From : null;
  return {
    providerId: String(it.MessageId || asList(it.Uuid)[0] || it.MessageID || it.message_id || '').slice(0, 300),
    fromEmail: emailsIn(it.FromFull || fromObj || it.From || it.from)[0] || '',
    fromName: String(fromObj?.Name || it.FromFull?.Name || it.FromName || '').replace(/[\r\n]+/g, ' ').slice(0, 200),
    subject: String(it.Subject || it.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 300),
    text: String(it.ExtractedMarkdownMessage || it.StrippedTextReply || it.RawTextBody || it.TextBody || it.text || '').slice(0, 20000),
    rcpts: [...emailsIn(it.To), ...emailsIn(it.ToFull), ...emailsIn(it.Cc), ...emailsIn(it.Recipients),
            ...emailsIn(it.OriginalRecipient), ...emailsIn(it.to), ...emailsIn(it.recipient)],
    headers: headerMap(it.Headers || it.headers),
    attachments: asList(it.Attachments).map((a) => ({ name: String(a?.Name || a?.name || '').slice(0, 200), size: Number(a?.ContentLength ?? a?.size ?? 0) || 0 })),
  };
}

function classify(n, contactEmail) {
  const h = n.headers;
  const autoSub = h['auto-submitted'] && h['auto-submitted'].toLowerCase() !== 'no';
  if (autoSub || h['x-autoreply'] || h['x-autorespond'] || /auto_reply|auto-reply|junk/i.test(h['precedence'] || '')) return 'ooo';
  // Auto-unsubscribe only for a bare keyword AND only when it comes from the contact's own address.
  const body = n.text.trim();
  if (body.length <= 60 && /^(unsubscribe|stop|remove me|remove|opt out|opt-out)[\s.!]*$/i.test(body) && n.fromEmail === String(contactEmail).toLowerCase()) return 'unsubscribe';
  return 'reply';
}

async function record(n, messageId) {
  const { rows: [m] } = await q(
    `SELECT m.id, m.tenant_id, m.contact_id, m.campaign_id, c.email AS contact_email, ca.reply_to, t.status AS tenant_status
     FROM messages m JOIN contacts c ON c.id = m.contact_id JOIN campaigns ca ON ca.id = m.campaign_id JOIN tenants t ON t.id = m.tenant_id
     WHERE m.id = $1`, [messageId]);
  if (!m) return;
  const cls = classify(n, m.contact_email);
  const key = crypto.createHash('sha1').update(n.providerId || (n.fromEmail + '|' + n.subject + '|' + n.text.slice(0, 200))).digest('hex') + ':' + m.id;
  const { rows: [row] } = await q(
    `INSERT INTO inbound_messages (tenant_id, message_id, contact_id, campaign_id, from_email, from_name, subject, body_text, classification, attachments, provider_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
    [m.tenant_id, m.id, m.contact_id, m.campaign_id, n.fromEmail || 'unknown', n.fromName || null, n.subject || null, n.text, cls, JSON.stringify(n.attachments), key]);
  if (!row) return;   // provider retry: already stored

  await q(`INSERT INTO events (tenant_id, message_id, type, meta) VALUES ($1, $2, $3, $4)`,
    [m.tenant_id, m.id, cls === 'unsubscribe' ? 'unsubscribe' : 'reply', { via: 'inbound', classification: cls }]);
  if (cls === 'unsubscribe') await suppress(m.tenant_id, m.contact_email, 'unsubscribe', 'unsubscribed');

  // Forward real replies to the tenant's own Reply-To, so tenants who set one keep getting their replies.
  const rt = String(m.reply_to || '').trim();
  const forwardable = cls === 'reply' && m.tenant_status === 'active' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rt)
    && !rt.toLowerCase().endsWith('@' + config.replyDomain);
  if (forwardable) {
    try {
      await sendMail({
        from: config.systemFrom,
        to: rt,
        replyTo: n.fromEmail || undefined,
        subject: ('Reply: ' + (n.subject || '(no subject)')).slice(0, 200),
        text: `Reply from ${n.fromName ? n.fromName + ' ' : ''}<${n.fromEmail}>:\n\n${n.text}`,
      });
      await q(`UPDATE inbound_messages SET forwarded_at = now() WHERE id = $1`, [row.id]);
    } catch (e) { console.error('[inbound] forward failed:', e.message); }
  }
}

export async function handleInbound(item) {
  if (!config.replyDomain || !item || typeof item !== 'object') return;
  const n = normalise(item);
  const suffix = '@' + config.replyDomain;
  const seen = new Set();
  for (const r of n.rcpts) {
    if (!r.endsWith(suffix)) continue;
    const messageId = verifyReplyLocal(r.slice(0, -suffix.length));
    if (!messageId || seen.has(messageId)) continue;
    seen.add(messageId);
    await record(n, messageId);
  }
  if (!seen.size) console.warn('[inbound] no valid reply address in item (payload keys: ' + Object.keys(item).join(',') + ')');
}
