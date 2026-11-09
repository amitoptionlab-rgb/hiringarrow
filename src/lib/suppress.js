import { q } from '../db.js';

// One place that records "never email this address again".
export async function suppress(tenantId, email, reason, contactStatus) {
  await q(`INSERT INTO suppressions (tenant_id, email, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [tenantId, email, reason]);
  if (contactStatus) await q(`UPDATE contacts SET status = $3 WHERE tenant_id = $1 AND email = $2`, [tenantId, email, contactStatus]);
}
