import crypto from 'node:crypto';
import { q, HttpError } from '../db.js';
import { enqueueMessages } from '../queue.js';
import { allowance } from './limits.js';
import { preflight } from './preflight.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNITS = { minutes: 60e3, hours: 3600e3, days: 864e5 };
const tag = (v) => { const t = String(v ?? '').trim().toLowerCase().slice(0, 30); if (!t) throw new HttpError(400, 'Journey: a tag step or condition has no tag.'); return t; };

export function normalizeTrigger(t = {}) {
  switch (t.type) {
    case 'subscribed': return { type: 'subscribed' };
    case 'list_joined': if (!UUID.test(t.list_id || '')) throw new HttpError(400, 'Journey: choose a list for the trigger.'); return { type: t.type, list_id: t.list_id };
    case 'tag_added': return { type: 'tag_added', tag: tag(t.tag) };
    case 'link_clicked': if (t.campaign_id && !UUID.test(t.campaign_id)) throw new HttpError(400, 'Journey: invalid campaign.'); return { type: 'link_clicked', campaign_id: t.campaign_id || null };
    case 'event': { const n = String(t.name || '').trim().toLowerCase(); if (!/^[a-z0-9_.-]{1,40}$/.test(n)) throw new HttpError(400, 'Journey: event names use letters, numbers, _ . - only.'); return { type: 'event', name: n }; }
    default: throw new HttpError(400, 'Journey: choose what starts it.');
  }
}

export function normalizeSteps(steps) {
  if (!Array.isArray(steps) || steps.length > 20) throw new HttpError(400, 'Journey: up to 20 steps.');
  return steps.map((s) => {
    const id = /^[a-z0-9]{3,16}$/.test(s?.id || '') ? s.id : crypto.randomBytes(4).toString('hex');
    switch (s?.type) {
      case 'email': {
        const subject = String(s.subject || '').trim().slice(0, 150), html = String(s.html || '');
        if (!subject) throw new HttpError(400, 'Journey: every email needs a subject.');
        if (!html.trim() || html.length > 300_000) throw new HttpError(400, 'Journey: an email is empty or too large.');
        return { id, type: 'email', subject, preheader: String(s.preheader || '').trim().slice(0, 200), html };
      }
      case 'wait': {
        const amount = Math.floor(+s.amount), unit = s.unit;
        if (!UNITS[unit] || !(amount >= 1 && amount * UNITS[unit] <= 365 * 864e5)) throw new HttpError(400, 'Journey: wait must be 1 minute to 365 days.');
        return { id, type: 'wait', amount, unit };
      }
      case 'condition': {
        if (!['opened_prev', 'clicked_prev', 'has_tag', 'not_has_tag'].includes(s.check)) throw new HttpError(400, 'Journey: unknown condition.');
        return { id, type: 'condition', check: s.check, ...(s.check.includes('tag') && { tag: tag(s.tag) }), else: s.else === 'skip' ? 'skip' : 'exit' };
      }
      case 'add_tag': case 'remove_tag': return { id, type: s.type, tag: tag(s.tag) };
      default: throw new HttpError(400, 'Journey: unknown step type.');
    }
  });
}

// Everything that must be true before people can enter. Mirrors campaign preflight.
export async function validateForActivation(a) {
  const errors = [], warnings = [];
  const { rows: [tenant] } = await q('SELECT postal_address FROM tenants WHERE id = $1', [a.tenant_id]);
  const { rows: [domain] } = await q('SELECT * FROM sending_domains WHERE tenant_id = $1 AND domain = $2', [a.tenant_id, (a.from_email || '').split('@')[1] || '']);
  if (!a.steps.length) errors.push('Add at least one step.');
  if (!a.steps.some((s) => s.type === 'email')) errors.push('A journey needs at least one email step.');
  if (!a.from_name || !a.from_email) errors.push('Set the From name and From email.');
  a.steps.forEach((s, i) => {
    const prev = a.steps[i - 1];
    if (s.type === 'condition' && prev?.type === 'email') errors.push(`Step ${i + 1}: add a wait step between the email and the condition, otherwise nobody has had time to open it.`);
    if (s.type === 'condition' && s.check.endsWith('_prev') && !a.steps.slice(0, i).some((x) => x.type === 'email')) errors.push(`Step ${i + 1}: this condition needs an email step before it.`);
    if (s.type === 'email') {
      const r = preflight({ subject: s.subject, html: s.html, fromEmail: a.from_email, tenant, domain });
      r.errors.forEach((e) => errors.push(`Email "${s.subject.slice(0, 40)}": ${e}`));
      if (!errors.length) r.warnings.slice(0, 3).forEach((w) => warnings.push(`Email "${s.subject.slice(0, 40)}": ${w}`));
    }
  });
  return { errors: [...new Set(errors)], warnings };
}

// ---------- entering a journey ----------
export async function enroll(tenantId, contactIds, type, match = {}) {
  if (!contactIds?.length) return 0;
  const { rows } = await q(`SELECT id, trigger_cfg FROM automations WHERE tenant_id = $1 AND status = 'active' AND trigger_cfg->>'type' = $2`, [tenantId, type]);
  let n = 0;
  for (const a of rows) {
    const c = a.trigger_cfg;
    if (type === 'list_joined' && c.list_id !== match.list_id) continue;
    if (type === 'tag_added' && c.tag !== match.tag) continue;
    if (type === 'link_clicked' && c.campaign_id && c.campaign_id !== match.campaign_id) continue;
    if (type === 'event' && c.name !== match.name) continue;
    const r = await q(`INSERT INTO automation_runs (automation_id, tenant_id, contact_id)
      SELECT $1, $2, c.id FROM contacts c WHERE c.tenant_id = $2 AND c.id = ANY($3::uuid[]) AND c.status = 'subscribed' ON CONFLICT DO NOTHING`, [a.id, tenantId, contactIds]);
    n += r.rowCount;
  }
  return n;
}
export const enrollSafe = (...args) => enroll(...args).catch((e) => console.error('[enroll]', e.message));

// People who already match when a journey is switched on (opt-in by the owner).
export async function enrollExisting(a) {
  const t = a.trigger_cfg;
  let sql, p = [a.tenant_id];
  if (t.type === 'subscribed') sql = `SELECT id FROM contacts WHERE tenant_id = $1 AND status = 'subscribed'`;
  else if (t.type === 'list_joined') { sql = `SELECT c.id FROM contacts c JOIN list_members lm ON lm.contact_id = c.id WHERE c.tenant_id = $1 AND lm.list_id = $2 AND c.status = 'subscribed'`; p.push(t.list_id); }
  else if (t.type === 'tag_added') { sql = `SELECT id FROM contacts WHERE tenant_id = $1 AND status = 'subscribed' AND tags @> ARRAY[$2::text]`; p.push(t.tag); }
  else return 0;
  const { rows } = await q(sql, p);
  if (!rows.length) return 0;
  const r = await q(`INSERT INTO automation_runs (automation_id, tenant_id, contact_id) SELECT $1, $2, unnest($3::uuid[]) ON CONFLICT DO NOTHING`, [a.id, a.tenant_id, rows.map((x) => x.id)]);
  return r.rowCount;
}

// ---------- running journeys (called by the worker) ----------
const save = (run, idx, at) => q('UPDATE automation_runs SET step_idx = $2, next_run_at = $3 WHERE id = $1', [run.id, idx, at]);
const finish = (run, status, reason = null) => q('UPDATE automation_runs SET status = $2, exit_reason = $3, finished_at = now() WHERE id = $1', [run.id, status, reason]);

async function evalCondition(a, idx, step, c) {
  if (step.check === 'has_tag') return (c.tags || []).includes(step.tag);
  if (step.check === 'not_has_tag') return !(c.tags || []).includes(step.tag);
  const prev = a.steps.slice(0, idx).reverse().find((s) => s.type === 'email');
  if (!prev) return false;
  const { rows } = await q(
    `SELECT 1 FROM messages m JOIN events e ON e.message_id = m.id JOIN campaigns ca ON ca.id = m.campaign_id
     WHERE m.contact_id = $1 AND ca.automation_id = $2 AND ca.automation_step = $3 AND e.type = $4 LIMIT 1`,
    [c.id, a.id, prev.id, step.check === 'opened_prev' ? 'open' : 'click']);
  return rows.length > 0;
}

async function sendStepEmail(a, step, c) {
  const name = `${a.name} \u00b7 ${step.subject}`.slice(0, 120);
  const { rows: [ex] } = await q('SELECT id FROM campaigns WHERE automation_id = $1 AND automation_step = $2', [a.id, step.id]);
  let cid = ex?.id;
  if (cid) await q('UPDATE campaigns SET name=$2, subject=$3, preheader=$4, from_name=$5, from_email=$6, html=$7, reply_to=$8 WHERE id=$1', [cid, name, step.subject, step.preheader || null, a.from_name, a.from_email, step.html, a.reply_to || null]);
  else cid = (await q(`INSERT INTO campaigns (tenant_id, name, subject, preheader, from_name, from_email, html, reply_to, kind, automation_id, automation_step, status)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$10,'automation',$8,$9,'sending') RETURNING id`, [a.tenant_id, name, step.subject, step.preheader || null, a.from_name, a.from_email, step.html, a.id, step.id, a.reply_to || null])).rows[0].id;
  const { rows: [domain] } = await q('SELECT * FROM sending_domains WHERE tenant_id = $1 AND domain = $2', [a.tenant_id, a.from_email.split('@')[1] || '']);
  if ((await allowance(a.tenant_id, domain)).allowed <= 0) return 'retry';        // quota or daily cap reached: try again in an hour
  const { rows: [m] } = await q(`INSERT INTO messages (tenant_id, campaign_id, contact_id, variant) VALUES ($1,$2,$3,'A') ON CONFLICT DO NOTHING RETURNING id`, [a.tenant_id, cid, c.id]);
  // If an earlier attempt inserted the message but enqueue failed (Redis down), pick it up again.
  // enqueueMessages uses jobId = message id, so enqueueing twice never creates a second job.
  let mid = m?.id;
  if (!mid) {
    const { rows: [old] } = await q(`SELECT id FROM messages WHERE campaign_id = $1 AND contact_id = $2 AND status = 'queued'`, [cid, c.id]);
    mid = old?.id;
  }
  if (mid) await enqueueMessages([mid]);
  return 'ok';
}

async function processRun(run, cache) {
  let a = cache.get(run.automation_id);
  if (!a) { a = (await q('SELECT * FROM automations WHERE id = $1', [run.automation_id])).rows[0] || null; cache.set(run.automation_id, a); }
  if (!a) return finish(run, 'exited', 'journey deleted');
  if (a.status !== 'active') return save(run, run.step_idx, new Date(Date.now() + 60_000));   // paused: hold everyone in place
  // Only approved (active) accounts may send to contacts: hold the whole journey until approval.
  let tStatus = cache.get(`tenant:${a.tenant_id}`);
  if (tStatus === undefined) { tStatus = (await q('SELECT status FROM tenants WHERE id = $1', [a.tenant_id])).rows[0]?.status ?? null; cache.set(`tenant:${a.tenant_id}`, tStatus); }
  if (tStatus !== 'active') return save(run, run.step_idx, new Date(Date.now() + 10 * 60_000));
  const { rows: [c] } = await q(`SELECT c.*, EXISTS (SELECT 1 FROM suppressions s WHERE s.tenant_id = c.tenant_id AND s.email = c.email) AS suppressed FROM contacts c WHERE c.id = $1`, [run.contact_id]);
  if (!c || c.status !== 'subscribed' || c.suppressed) return finish(run, 'exited', 'unsubscribed');

  let idx = run.step_idx;
  for (let guard = 0; guard < 30; guard++) {
    const step = a.steps[idx];
    if (!step) return finish(run, 'completed');
    if (step.type === 'wait') return save(run, idx + 1, new Date(Date.now() + step.amount * UNITS[step.unit]));
    if (step.type === 'add_tag') {
      await q(`UPDATE contacts SET tags = ARRAY(SELECT DISTINCT unnest(tags || ARRAY[$2::text])) WHERE id = $1`, [c.id, step.tag]);
      enrollSafe(a.tenant_id, [c.id], 'tag_added', { tag: step.tag }); c.tags = [...(c.tags || []), step.tag]; idx++; continue;
    }
    if (step.type === 'remove_tag') { await q(`UPDATE contacts SET tags = array_remove(tags, $2) WHERE id = $1`, [c.id, step.tag]); c.tags = (c.tags || []).filter((t) => t !== step.tag); idx++; continue; }
    if (step.type === 'condition') {
      if (await evalCondition(a, idx, step, c)) idx++;
      else if (step.else === 'skip') idx += 2;
      else return finish(run, 'exited', 'condition not met');
      continue;
    }
    if (step.type === 'email') {
      if ((await sendStepEmail(a, step, c)) === 'retry') return save(run, idx, new Date(Date.now() + 3600e3));
      idx++; continue;
    }
    return finish(run, 'exited', 'unknown step');
  }
  return save(run, idx, new Date());
}

export async function automationTick() {
  const { rows } = await q(
    `UPDATE automation_runs SET next_run_at = now() + interval '2 minutes' WHERE id IN (
       SELECT id FROM automation_runs WHERE status = 'active' AND next_run_at <= now() ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 50) RETURNING *`);
  const cache = new Map();
  for (const run of rows) { try { await processRun(run, cache); } catch (e) { console.error(`[journey] run ${run.id}: ${e.message}`); } }
  return rows.length;
}