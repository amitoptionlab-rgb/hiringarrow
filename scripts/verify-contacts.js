// Usage: node --env-file-if-exists=.env scripts/verify-contacts.js [--tenant <id>] [--limit 5000]
import { verifyContacts } from '../src/lib/verify-contacts.js';
import { pool } from '../src/db.js';

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : undefined; };
try {
  const r = await verifyContacts({ tenantId: arg('--tenant'), limit: Number(arg('--limit') || 5000) });
  console.log(r);
} finally { await pool.end(); }
