import { bulkHeaders } from '../src/lib/headers.js';
const h = bulkHeaders({ messageId: 'm-1', campaignId: 'c-1', tenantId: 't-1', unsubUrl: 'https://x.test/u/abc' });
const ok = h['List-Unsubscribe'] === '<https://x.test/u/abc>' && h['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click' && h['X-Mailin-custom'] === 'm-1' && h['Feedback-ID'] === 'c-1:t-1:bulk' && h.Precedence === 'bulk';
console.log(`${ok ? 'PASS' : 'FAIL'}  bulk email headers: one-click unsubscribe, Feedback-ID and the id Brevo echoes back`);
process.exit(ok ? 0 : 1);
