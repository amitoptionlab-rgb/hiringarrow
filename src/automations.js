import express from 'express';
import { q, HttpError } from './db.js';
import { normalizeTrigger, normalizeSteps, validateForActivation, enrollExisting } from './lib/automation.js';

export const automations = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tid = (req) => req.user.tid;

async function fields(req) {
  const b = req.body;
  const name = String(b.name || '').trim().slice(0, 120);
  if (!name) throw new HttpError(400, 'Name the journey.');
  const trigger_cfg = normalizeTrigger(b.trigger);
  if (trigger_cfg.type === 'list_joined') {
    const { rows } = await q('SELECT 1 FROM lists WHERE id = $1 AND tenant_id = $2', [trigger_cfg.list_id, tid(req)]);
    if (!rows.length) throw new HttpError(404, 'That list does not exist.');
  }
  const from_email = String(b.from_email || '').trim().toLowerCase().slice(0, 200);
  if (from_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from_email)) throw new HttpError(400, 'Enter a valid From email.');
  return { name, trigger_cfg, from_name: String(b.from_name || '').trim().slice(0, 100) || null, from_email: from_email || null, steps: normalizeSteps(b.steps || []) };
}
async function get(req) {
  if (!UUID.test(req.params.id)) throw new HttpError(404, 'Journey not found.');
  const { rows: [a] } = await q('SELECT * FROM automations WHERE id = $1 AND tenant_id = $2', [req.params.id, tid(req)]);
  if (!a) throw new HttpError(404, 'Journey not found.');
  return a;
}

automations.get('/', async (req, res) => {
  const { rows } = await q(
    `SELECT a.id, a.name, a.status, a.trigger_cfg, a.created_at, jsonb_array_length(a.steps)::int AS step_count,
            count(r.id)::int AS entered, count(r.id) FILTER (WHERE r.status = 'active')::int AS active, count(r.id) FILTER (WHERE r.status = 'completed')::int AS completed
     FROM automations a LEFT JOIN automation_runs r ON r.automation_id = a.id WHERE a.tenant_id = $1 GROUP BY a.id ORDER BY a.created_at DESC`, [tid(req)]);
  res.json(rows);
});

automations.get('/:id', async (req, res) => {
  const a = await get(req);
  const [runs, at, mail] = await Promise.all([
    q(`SELECT count(*)::int AS entered, count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'completed')::int AS completed, count(*) FILTER (WHERE status = 'exited')::int AS exited FROM automation_runs WHERE automation_id = $1`, [a.id]),
    q(`SELECT step_idx, count(*)::int AS n FROM automation_runs WHERE automation_id = $1 AND status = 'active' GROUP BY 1`, [a.id]),
    q(`SELECT ca.automation_step AS step,
              count(m.id) FILTER (WHERE m.status IN ('sent','delivered','bounced','complained'))::int AS sent,
              count(m.id) FILTER (WHERE m.status = 'bounced')::int AS bounced,
              (SELECT count(DISTINCT e.message_id) FROM events e JOIN messages mm ON mm.id = e.message_id WHERE mm.campaign_id = ca.id AND e.type = 'open')::int AS opens,
              (SELECT count(DISTINCT e.message_id) FROM events e JOIN messages mm ON mm.id = e.message_id WHERE mm.campaign_id = ca.id AND e.type = 'click')::int AS clicks
       FROM campaigns ca LEFT JOIN messages m ON m.campaign_id = ca.id WHERE ca.automation_id = $1 GROUP BY ca.id`, [a.id]),
  ]);
  res.json({ ...a, report: { ...runs.rows[0], waiting: Object.fromEntries(at.rows.map((r) => [r.step_idx, r.n])), emails: Object.fromEntries(mail.rows.map((r) => [r.step, r])) } });
});

automations.post('/', async (req, res) => {
  const f = await fields(req);
  const { rows: [a] } = await q(`INSERT INTO automations (tenant_id, name, trigger_cfg, from_name, from_email, steps) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [tid(req), f.name, f.trigger_cfg, f.from_name, f.from_email, JSON.stringify(f.steps)]);
  res.status(201).json(a);
});
automations.put('/:id', async (req, res) => {
  const a = await get(req);
  if (a.status === 'active') throw new HttpError(409, 'Pause the journey before editing it.');
  const f = await fields(req);
  await q(`UPDATE automations SET name=$2, trigger_cfg=$3, from_name=$4, from_email=$5, steps=$6 WHERE id=$1`, [a.id, f.name, f.trigger_cfg, f.from_name, f.from_email, JSON.stringify(f.steps)]);
  res.json({ ok: true });
});
automations.delete('/:id', async (req, res) => {
  const a = await get(req);
  await q('DELETE FROM campaigns WHERE automation_id = $1', [a.id]);
  await q('DELETE FROM automations WHERE id = $1', [a.id]);
  res.json({ ok: true });
});

automations.post('/:id/check', async (req, res) => res.json(await validateForActivation(await get(req))));
automations.post('/:id/activate', async (req, res) => {
  const a = await get(req);
  const { rows: [t] } = await q('SELECT status FROM tenants WHERE id = $1', [tid(req)]);
  if (['suspended', 'paused'].includes(t.status)) throw new HttpError(403, 'Sending is disabled on your account. Contact support.');
  const v = await validateForActivation(a);
  if (v.errors.length) return res.status(422).json({ error: 'Fix these issues before turning the journey on.', ...v });
  await q(`UPDATE automations SET status = 'active', activated_at = COALESCE(activated_at, now()) WHERE id = $1`, [a.id]);
  const enrolled = req.body?.enroll_existing ? await enrollExisting({ ...a, status: 'active' }) : 0;
  res.json({ ok: true, enrolled, warnings: v.warnings });
});
automations.post('/:id/pause', async (req, res) => {
  const a = await get(req);
  await q(`UPDATE automations SET status = 'paused' WHERE id = $1 AND status = 'active'`, [a.id]);
  res.json({ ok: true });
});
