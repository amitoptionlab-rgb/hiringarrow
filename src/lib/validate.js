import dns from 'node:dns/promises';

const SYNTAX = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'throwawaymail.com', 'dispostable.com', 'maildrop.cc', 'fakeinbox.com', 'mintemail.com', 'mohmal.com']);
const ROLE = new Set(['admin', 'info', 'support', 'sales', 'contact', 'hello', 'help', 'office', 'billing', 'abuse', 'postmaster', 'webmaster', 'noreply', 'no-reply', 'mailer-daemon', 'root', 'security']);

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);

export async function checkEmail(raw, { mx = false } = {}) {
  const email = String(raw || '').trim().toLowerCase();
  if (email.length > 254 || !SYNTAX.test(email)) return { ok: false, email, reason: 'invalid syntax' };
  const [local, domain] = email.split('@');
  if (DISPOSABLE.has(domain)) return { ok: false, email, reason: 'disposable address', verification: 'disposable' };
  if (mx) {
    try {
      const recs = await withTimeout(dns.resolveMx(domain), 4000);
      if (!recs.length) return { ok: false, email, reason: 'domain has no mail server', verification: 'invalid' };
    } catch (e) {
      if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') return { ok: false, email, reason: 'domain does not exist', verification: 'invalid' };
      // timeouts / transient DNS errors: do not reject
    }
  }
  return { ok: true, email, verification: ROLE.has(local) ? 'risky' : 'valid' };
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  }));
  return out;
}
