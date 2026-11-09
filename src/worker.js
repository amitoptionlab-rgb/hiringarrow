import { Worker } from 'bullmq';
import { config } from './config.js';
import { q } from './db.js';
import { connection } from './queue.js';
import { renderMessage } from './lib/render.js';
import { sendMail } from './lib/mailer.js';
import { signId } from './lib/tokens.js';
import { suppress } from './lib/suppress.js';
import { startCampaign } from './lib/campaign-send.js';
import { bulkHeaders } from './lib/headers.js';
import { automationTick } from './lib/automation.js';

const circuitCache = new Map(); // campaignId -> { at, tripped }

// Auto-pause a campaign when complaints or bounces cross the safe line.
async function circuitTripped(campaignId) {
  const hit = circuitCache.get(campaignId);
  if (hit && Date.now() - hit.at < 5000) return hit.tripped;
  const { rows: [r] } = await q(
    `SELECT count(*) FILTER (WHERE status IN ('sent','delivered','bounced','complained'))::int AS sent,
            count(*) FILTER (WHERE status = 'bounced')::int AS bounced,
            count(*) FILTER (WHERE status = 'complained')::int AS complained
     FROM messages WHERE campaign_id = $1`, [campaignId]);
  const c = config.circuit;
  let reason = null;
  if (r.sent >= c.minSample) {
    if (r.complained / r.sent > c.complaintRate) reason = `complaint rate ${(100 * r.complained / r.sent).toFixed(2)}%`;
    else if (r.bounced / r.sent > c.bounceRate) reason = `bounce rate ${(100 * r.bounced / r.sent).toFixed(1)}%`;
  }
  if (reason) {
    await q(`UPDATE campaigns SET status = 'paused' WHERE id = $1 AND status = 'sending' AND kind = 'broadcast'`, [campaignId]);
    await q(`UPDATE automations SET status = 'paused' WHERE id = (SELECT automation_id FROM campaigns WHERE id = $1 AND kind = 'automation')`, [campaignId]);
    console.warn(`[circuit] campaign ${campaignId} paused: ${reason}`);
  }
  circuitCache.set(campaignId, { at: Date.now(), tripped: !!reason });
  return !!reason;
}

// Called only AFTER the provider accepted the mail. This must never throw:
// if it threw, BullMQ would retry the job and the recipient would get the mail twice.
async function recordSent(m, { providerMsgId, via }) {
  let saved = false, counted = false;
  for (let i = 1; i <= 3 && !saved; i++) {
    try {
      // guard: a bounce/complaint webhook may already have changed this message; never overwrite it
      const r = await q(`UPDATE messages SET status = 'sent', provider_msg_id = $2, provider = $3, sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1 AND status = 'queued'`, [m.id, providerMsgId, via]);
      counted = r.rowCount === 1;
      saved = true;
    } catch (e) {
      console.error(`[send] ${m.id} mail SENT (provider id ${providerMsgId}, via ${via}) but DB update failed (try ${i}/3): ${e.message}`);
      if (i < 3) await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
  if (!saved) return;
  if (!counted) { console.warn('[send] ' + m.id + ' was no longer queued when the send was recorded (already bounced/complained?). Usage not counted.'); return; }
  try {
    await q(`INSERT INTO usage_counters (tenant_id, period, emails_sent) VALUES ($1, date_trunc('month', now())::date, 1)
             ON CONFLICT (tenant_id, period) DO UPDATE SET emails_sent = usage_counters.emails_sent + 1`, [m.tenant_id]);
  } catch (e) {
    console.error(`[send] ${m.id} usage counter update failed (message itself is marked sent): ${e.message}`);
  }
}

async function handleJob(job) {
  const { rows: [m] } = await q(
    `SELECT m.id, m.tenant_id, m.campaign_id, m.contact_id, m.status, m.variant,
            c.email, c.first_name, c.last_name, c.custom_fields, c.status AS contact_status,
            ca.subject, ca.subject_b, ca.preheader, ca.html, ca.from_name, ca.from_email, ca.status AS campaign_status, ca.kind,
            t.postal_address, t.status AS tenant_status
     FROM messages m
     JOIN contacts c ON c.id = m.contact_id
     JOIN campaigns ca ON ca.id = m.campaign_id
     JOIN tenants t ON t.id = m.tenant_id
     WHERE m.id = $1`, [job.data.messageId]);
  if (!m || m.status !== 'queued') return;

  if (m.campaign_status !== 'sending' && m.kind !== 'automation') return;   // paused: stays queued until resume
  if (m.tenant_status !== 'active') {   // review / suspended / anything else: no sending to contacts
    await q(`UPDATE campaigns SET status = 'paused' WHERE id = $1 AND kind = 'broadcast'`, [m.campaign_id]);
    return;
  }
  if (await circuitTripped(m.campaign_id)) return;

  const { rows: sup } = await q(`SELECT 1 FROM suppressions WHERE tenant_id = $1 AND email = $2`, [m.tenant_id, m.email]);
  if (sup.length || m.contact_status !== 'subscribed') {
    await q(`UPDATE messages SET status = 'failed', last_error = 'suppressed' WHERE id = $1`, [m.id]);
    return finishIfDone(m.campaign_id);
  }

  const unsubUrl = `${config.baseUrl}/u/${signId('u', m.contact_id)}`;
  const { html, text } = renderMessage({
    html: m.html, preheader: m.preheader, contact: m, messageId: m.id, unsubUrl, address: m.postal_address || '',
  });

  let sent = null;
  try {
    sent = await sendMail({
      from: `"${m.from_name.replace(/"/g, '')}" <${m.from_email}>`,
      to: m.email,
      subject: m.variant === 'B' && m.subject_b ? m.subject_b : m.subject,
      html, text,
      headers: bulkHeaders({ messageId: m.id, campaignId: m.campaign_id, tenantId: m.tenant_id, unsubUrl }),
    });
  } catch (err) {
    const why = String(err.response || err.message);
    const rcptPermanent = [550, 551, 553].includes(err.responseCode)
      && /\b5\.1\.[1-36]\b|user unknown|no such user|mailbox (unavailable|not found|does not exist)|unknown recipient|invalid recipient|recipient (address )?rejected/i.test(why)
      && !/not verified|sender|spam|block|blacklist|reputation|policy|\b5\.7\./i.test(why);
    if (rcptPermanent) {
      // permanent rejection of this recipient
      await q(`UPDATE messages SET status = 'bounced', last_error = $2, attempts = attempts + 1 WHERE id = $1`, [m.id, String(err.message).slice(0, 300)]);
      await q(`INSERT INTO events (tenant_id, message_id, type, meta) VALUES ($1, $2, 'bounce', $3)`, [m.tenant_id, m.id, { type: 'Permanent', via: 'smtp' }]);
      await suppress(m.tenant_id, m.email, 'hard_bounce', 'bounced');
    } else {
      await q(`UPDATE messages SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [m.id, String(err.message).slice(0, 300)]);
      throw err; // BullMQ retries with exponential backoff
    }
  }
  if (sent) await recordSent(m, sent);
  await finishIfDone(m.campaign_id);
}

const finishIfDone = (campaignId) => q(
  `UPDATE campaigns SET status = 'done' WHERE id = $1 AND status = 'sending' AND kind = 'broadcast'
   AND NOT EXISTS (SELECT 1 FROM messages WHERE campaign_id = $1 AND status = 'queued')`, [campaignId]);

const worker = new Worker('send', handleJob, {
  connection,
  concurrency: 5,
  limiter: { max: config.sendRatePerSec, duration: 1000 },
});
worker.on('failed', async (job, err) => {
  console.error(`[send] ${job?.data?.messageId} failed (attempt ${job?.attemptsMade}): ${err.message}`);
  if (job && job.attemptsMade >= (job.opts.attempts || 1)) {
    // only a still-queued message may become failed; never overwrite sent/bounced
    await q(`UPDATE messages SET status = 'failed', last_error = $2 WHERE id = $1 AND status = 'queued'`, [job.data.messageId, String(err.message).slice(0, 300)]);
    const { rows: [m] } = await q(`SELECT campaign_id FROM messages WHERE id = $1`, [job.data.messageId]);
    if (m) await finishIfDone(m.campaign_id);
  }
});
console.log(`Worker running (mail driver: ${config.mailDriver}, ${config.sendRatePerSec} msg/sec)`);
const stop = async () => { await worker.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

// Scheduled campaigns: claim due ones atomically, then send exactly like the Send button does.
async function schedulerTick() {
  try {
    const { rows } = await q(
      `UPDATE campaigns SET status = 'draft' WHERE id IN (
         SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= now() ORDER BY scheduled_at FOR UPDATE SKIP LOCKED LIMIT 5)
       RETURNING *`);
    for (const c of rows) {
      try {
        const r = await startCampaign(c.tenant_id, c);
        console.log(`[scheduler] ${c.id}`, r.preflight ? 'blocked by preflight' : `queued ${r.queued}`);
      } catch (e) {
        console.error(`[scheduler] ${c.id} failed: ${e.message}`);
        await q(`UPDATE campaigns SET status = 'preflight_failed' WHERE id = $1 AND status = 'draft'`, [c.id]);
      }
    }
  } catch (e) { console.error('[scheduler]', e.message); }
}
setInterval(schedulerTick, 15_000);
schedulerTick();

// Journeys: move people along their steps.
let ticking = false;
setInterval(async () => { if (ticking) return; ticking = true; try { await automationTick(); } catch (e) { console.error('[journey]', e.message); } finally { ticking = false; } }, 5000);