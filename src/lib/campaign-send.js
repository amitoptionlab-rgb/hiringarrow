import crypto from 'node:crypto';
import { q, HttpError } from '../db.js';
import { enqueueMessages } from '../queue.js';
import { preflight } from './preflight.js';
import { allowance } from './limits.js';
import { audience } from './audience.js';

export async function runPreflight(tenantId, c) {
  const { rows: [tenant] } = await q('SELECT postal_address FROM tenants WHERE id = $1', [tenantId]);
  const { rows: [domain] } = await q('SELECT * FROM sending_domains WHERE tenant_id = $1 AND domain = $2', [tenantId, c.from_email.split('@')[1] || '']);
  const r = preflight({ subject: c.subject, subjectB: c.subject_b, html: c.html, fromEmail: c.from_email, tenant, domain });
  await q('UPDATE campaigns SET spam_score = $2 WHERE id = $1', [c.id, r.score]);
  return { ...r, domain };
}

const variantFor = (contactId, campaign) => {
  if (!campaign.subject_b || !campaign.ab_split) return 'A';
  const n = parseInt(crypto.createHash('md5').update(contactId + campaign.id).digest('hex').slice(0, 8), 16) % 100;
  return n < campaign.ab_split ? 'B' : 'A';
};

// Smart send time: each person gets the email at the hour they have most often opened mail
// (at least 3 real opens, machine/proxy opens ignored). Everyone else goes out right away.
async function bestTimeDelays(tenantId, contactIds) {
  const { rows } = await q(
    `SELECT m.contact_id, extract(hour FROM e.created_at)::int AS h, count(*)::int AS n
     FROM events e JOIN messages m ON m.id = e.message_id
     WHERE m.tenant_id = $1 AND e.type = 'open' AND m.contact_id = ANY($2::uuid[]) AND (e.meta->>'proxy') IS DISTINCT FROM 'true'
     GROUP BY 1, 2`, [tenantId, contactIds]);
  const per = new Map();
  for (const r of rows) { const o = per.get(r.contact_id) || { total: 0, hours: [] }; o.total += r.n; o.hours.push([r.h, r.n]); per.set(r.contact_id, o); }
  const now = new Date(), out = new Map();
  for (const [id, o] of per) {
    if (o.total < 3) continue;
    const h = o.hours.sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    let ms = (h * 60 - (now.getUTCHours() * 60 + now.getUTCMinutes())) * 60_000;
    if (ms < 0) ms += 864e5;
    out.set(id, ms);
  }
  return out;
}
async function delaysFor(messageIds, delayByContact) {
  const { rows } = await q('SELECT id, contact_id FROM messages WHERE id = ANY($1::uuid[])', [messageIds]);
  const byMsg = new Map(rows.map((r) => [r.id, r.contact_id]));
  return messageIds.map((id) => delayByContact.get(byMsg.get(id)) || 0);
}

// Shared by the Send button and the scheduler.
export async function startCampaign(tenantId, c) {
  const { rows: [t] } = await q('SELECT status FROM tenants WHERE id = $1', [tenantId]);
  if (t.status === 'review') throw new HttpError(403, 'Your account is awaiting approval. You can build campaigns and send yourself test emails now; sending to contacts unlocks once we approve your account.');
  if (t.status !== 'active') throw new HttpError(403, 'Sending is disabled on your account. Contact support.');

  const pf = await runPreflight(tenantId, c);
  if (!pf.ok) {
    await q(`UPDATE campaigns SET status = 'preflight_failed' WHERE id = $1`, [c.id]);
    return { preflight: { errors: pf.errors, warnings: pf.warnings, score: pf.score } };
  }
  const al = await allowance(tenantId, pf.domain);
  if (al.allowed <= 0) throw new HttpError(429, al.month.used >= al.month.limit ? "You have used this month's email quota. Upgrade your plan." : "You have reached today's sending limit. It resets at midnight, and new domains ramp up gradually.");

  const rec = await audience({ tenantId, listId: c.list_id, segment: c.segment, campaignId: c.id, limit: al.allowed + 1 });
  if (!rec.length) throw new HttpError(400, c.status === 'sending' || c.status === 'done' ? 'Everyone in this audience has already been sent this campaign.' : 'Nobody matches this audience yet. Import contacts or loosen the conditions.');
  const batch = rec.slice(0, al.allowed);
  const more = rec.length > batch.length;

  const { rows: msgs } = await q(
    `INSERT INTO messages (tenant_id, campaign_id, contact_id, variant)
     SELECT $1, $2, x.id, x.v FROM unnest($3::uuid[], $4::text[]) AS x(id, v) ON CONFLICT DO NOTHING RETURNING id`,
    [tenantId, c.id, batch.map((r) => r.id), batch.map((r) => variantFor(r.id, c))]);
  await q(`UPDATE campaigns SET status = 'sending' WHERE id = $1`, [c.id]);
  const delays = c.send_time_opt ? await bestTimeDelays(tenantId, batch.map((r) => r.id)) : [];
  const ordered = msgs.map((m) => m.id);
  await enqueueMessages(ordered, c.send_time_opt ? await delaysFor(ordered, delays) : []);
  return { queued: msgs.length, more_waiting: more, warnings: pf.warnings,
    note: more ? 'Your daily or monthly limit was reached. Press Send again tomorrow to continue with the rest. Nobody gets the email twice.' : null };
}
