import { q as defaultQ } from '../db.js';
import { segmentSql } from './segment.js';

// Who can receive a campaign: subscribed, deliverable, not suppressed, in the list/segment,
// and (when campaignId is given) not already sent this campaign. Engaged contacts come first.
export async function audience({ tenantId, listId = null, segment = null, campaignId = null, limit = null, sample = 0, countOnly = false, run = defaultQ }) {
  const q = run;
  const p = [tenantId];
  let where = `c.tenant_id = $1 AND c.status = 'subscribed' AND COALESCE(c.verification, 'valid') NOT IN ('invalid', 'disposable')
    AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.tenant_id = c.tenant_id AND s.email = c.email)
    AND NOT EXISTS (SELECT 1 FROM global_suppressions g WHERE g.email = c.email)`;
  if (listId) { p.push(listId); where += ` AND EXISTS (SELECT 1 FROM list_members lm WHERE lm.list_id = $${p.length} AND lm.contact_id = c.id)`; }
  if (campaignId) { p.push(campaignId); where += ` AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.campaign_id = $${p.length} AND m.contact_id = c.id)`; }
  where += ` AND (${segmentSql(segment, p)})`;
  if (countOnly) {
    const { rows: [r] } = await q(`SELECT count(*)::int AS n FROM contacts c WHERE ${where}`, p);
    const out = { count: r.n };
    if (sample) out.sample = (await q(`SELECT c.email FROM contacts c WHERE ${where} ORDER BY c.last_engaged_at DESC NULLS LAST LIMIT ${+sample}`, p)).rows.map((x) => x.email);
    return out;
  }
  p.push(limit);
  const { rows } = await q(`SELECT c.id FROM contacts c WHERE ${where} ORDER BY c.last_engaged_at DESC NULLS LAST, c.created_at LIMIT $${p.length}`, p);
  return rows;
}
