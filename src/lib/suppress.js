import { q } from '../db.js';

// One place that records "never email this address again".
export async function suppress(tenantId, email, reason, contactStatus) {
  await q(`INSERT INTO suppressions (tenant_id, email, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [tenantId, email, reason]);
  if (reason === 'hard_bounce' || reason === 'complaint') {
    // Platform-wide: this address is bad for every sender. Must never block the record above.
    try {
      await q(`INSERT INTO global_suppressions (email, reason, source_tenant_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [email, reason, tenantId]);
    } catch (e) { console.error('[suppress] global_suppressions insert failed:', e.message); }
  }
  if (contactStatus) await q(`UPDATE contacts SET status = $3 WHERE tenant_id = $1 AND email = $2`, [tenantId, email, contactStatus]);
}
