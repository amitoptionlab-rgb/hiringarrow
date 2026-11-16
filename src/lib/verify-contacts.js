import { q } from '../db.js';
import { checkEmail, mapLimit } from './validate.js';
import { mailboxCheck, mailboxEnabled } from './mailbox-check.js';

// Contacts ko verify karke contacts.verification me likhta hai.
// bounced/complained contacts ko chhoona nahi (webhook unka status sambhalta hai).
export async function verifyContacts({ tenantId = null, limit = 5000, staleDays = 90, concurrency = mailboxEnabled ? 5 : 20 } = {}) {
  const params = [staleDays];
  let where = `status NOT IN ('bounced','complained')
               AND (verification = 'unknown' OR verification_checked_at IS NULL
                    OR verification_checked_at < now() - ($1::int * interval '1 day'))`;
  if (tenantId) { params.push(tenantId); where += ` AND tenant_id = $${params.length}`; }
  params.push(limit);
  const { rows } = await q(`SELECT id, email FROM contacts WHERE ${where} ORDER BY verification_checked_at NULLS FIRST LIMIT $${params.length}`, params);

  const results = await mapLimit(rows, concurrency, async (r) => {
    const c = await checkEmail(r.email, { mx: true });
    if (mailboxEnabled && c.ok && c.verification === 'valid' && !c.tempfail) {
      try { const m = await mailboxCheck(r.email); return { id: String(r.id), verification: m.verification, reason: m.reason, suggestion: null }; }
      catch { return { id: String(r.id), verification: 'unknown', reason: 'mailbox check failed', suggestion: null }; }
    }
    return {
      id: String(r.id),
      verification: c.tempfail ? 'unknown' : (c.verification || (c.ok ? 'valid' : 'invalid')),
      reason: c.reason || null,
      suggestion: c.suggestion || null,
    };
  });

  for (let i = 0; i < results.length; i += 500) {
    const p = results.slice(i, i + 500);
    await q(
      `UPDATE contacts c SET verification = v.verification, verification_reason = v.reason,
              verification_suggestion = v.suggestion, verification_checked_at = now()
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS v(id, verification, reason, suggestion)
        WHERE c.id = v.id::uuid AND c.status NOT IN ('bounced','complained')`,
      [p.map((x) => x.id), p.map((x) => x.verification), p.map((x) => x.reason), p.map((x) => x.suggestion)]);
  }

  const summary = {};
  for (const r of results) summary[r.verification] = (summary[r.verification] || 0) + 1;
  return { checked: results.length, summary };
}
