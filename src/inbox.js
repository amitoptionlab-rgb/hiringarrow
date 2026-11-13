import express from 'express';
import { q } from './db.js';

// Mounted in api.js AFTER the auth middleware, so req.user is always set here.
export const inbox = express.Router();
const tid = (req) => req.user.tid;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

inbox.get('/', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const { rows } = await q(
    `SELECT i.id, i.from_email, i.from_name, i.subject, i.body_text, i.classification, i.attachments,
            i.received_at, i.read_at, i.campaign_id, ca.name AS campaign_name
     FROM inbound_messages i LEFT JOIN campaigns ca ON ca.id = i.campaign_id
     WHERE i.tenant_id = $1 AND ($2::boolean = false OR i.read_at IS NULL)
     ORDER BY i.received_at DESC LIMIT $3`, [tid(req), req.query.unread === '1', limit]);
  res.json(rows);
}));

inbox.get('/unread-count', wrap(async (req, res) => {
  const { rows: [r] } = await q(`SELECT count(*)::int AS n FROM inbound_messages WHERE tenant_id = $1 AND read_at IS NULL AND classification = 'reply'`, [tid(req)]);
  res.json({ unread: r.n });
}));

inbox.post('/read-all', wrap(async (req, res) => {
  await q(`UPDATE inbound_messages SET read_at = now() WHERE tenant_id = $1 AND read_at IS NULL`, [tid(req)]);
  res.json({ ok: true });
}));

inbox.post('/:id/read', wrap(async (req, res) => {
  if (!/^\d{1,15}$/.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  await q(`UPDATE inbound_messages SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND tenant_id = $2`, [req.params.id, tid(req)]);
  res.json({ ok: true });
}));
