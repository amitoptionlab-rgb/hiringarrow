// Real mailbox check through a verification API.
// Off unless VERIFY_PROVIDER (zerobounce | kickbox) and VERIFY_API_KEY are set.
const provider = (process.env.VERIFY_PROVIDER || '').toLowerCase();
const key = process.env.VERIFY_API_KEY || '';
export const mailboxEnabled = ['zerobounce', 'kickbox'].includes(provider) && !!key;

const getJson = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('verify api http ' + r.status);   // key is never put in the message
  return r.json();
};

// Returns { verification, reason }. Throws on API or network trouble so the caller can retry later.
export async function mailboxCheck(email) {
  if (provider === 'zerobounce') {
    const j = await getJson('https://api.zerobounce.net/v2/validate?api_key=' + encodeURIComponent(key) + '&email=' + encodeURIComponent(email) + '&ip_address=');
    if (j.error || !j.status) throw new Error('verify api error');
    const sub = j.sub_status ? String(j.sub_status).replace(/_/g, ' ') : null;
    switch (j.status) {
      case 'valid': return { verification: 'valid', reason: null };
      case 'invalid': return { verification: 'invalid', reason: sub || 'mailbox does not exist' };
      case 'catch-all': return { verification: 'risky', reason: 'catch-all domain' };
      case 'do_not_mail': return { verification: 'disposable', reason: sub || 'do not mail' };
      case 'spamtrap': case 'abuse': return { verification: 'invalid', reason: j.status };
      default: return { verification: 'risky', reason: 'could not confirm mailbox' };
    }
  }
  const j = await getJson('https://api.kickbox.com/v2/verify?email=' + encodeURIComponent(email) + '&apikey=' + encodeURIComponent(key));
  if (!j.result) throw new Error('verify api error');
  if (j.disposable) return { verification: 'disposable', reason: 'disposable address' };
  switch (j.result) {
    case 'deliverable': return { verification: 'valid', reason: null };
    case 'undeliverable': return { verification: 'invalid', reason: j.reason ? String(j.reason).replace(/_/g, ' ') : 'mailbox does not exist' };
    default: return { verification: 'risky', reason: j.reason ? String(j.reason).replace(/_/g, ' ') : 'could not confirm mailbox' };
  }
}