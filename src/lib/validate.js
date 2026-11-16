import dns from 'node:dns/promises';

const SYNTAX = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'throwawaymail.com', 'dispostable.com', 'maildrop.cc', 'fakeinbox.com', 'mintemail.com', 'mohmal.com']);
const ROLE = new Set(['admin', 'info', 'support', 'sales', 'contact', 'hello', 'help', 'office', 'billing', 'abuse', 'postmaster', 'webmaster', 'noreply', 'no-reply', 'mailer-daemon', 'root', 'security']);
const TYPOS = { 'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com', 'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'hotmial.com': 'hotmail.com', 'hotmail.con': 'hotmail.com', 'outlok.com': 'outlook.com', 'outlook.con': 'outlook.com' };

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);

// Domain-level DNS result cache (24h). Sirf pakke results cache hote hain, timeout nahi.
const MX_TTL_MS = 24 * 60 * 60 * 1000;
const mxCache = new Map();
const NO_ADDR = (e) => e.code === 'ENOTFOUND' || e.code === 'ENODATA';

async function domainStatus(domain, resolveMx) {
  const hit = mxCache.get(domain);
  if (hit && hit.exp > Date.now()) return hit.v;
  let v;
  try {
    const recs = await withTimeout(resolveMx(domain), 4000);
    v = recs.some((r) => r.exchange && r.exchange !== '.') ? 'ok' : 'nomx'; // null-MX ('.') = mail nahi leta
  } catch (e) {
    if (e.code === 'ENOTFOUND') v = 'nxdomain';
    else if (e.code === 'ENODATA') {
      // MX nahi: RFC 5321 ke hisaab se A record pe fallback
      try { v = (await withTimeout(dns.resolve4(domain), 4000)).length ? 'ok' : 'nomx'; }
      catch (e2) { v = NO_ADDR(e2) ? 'nomx' : 'tempfail'; }
    } else v = 'tempfail';
  }
  if (v !== 'tempfail') {
    if (mxCache.size > 50000) mxCache.clear();
    mxCache.set(domain, { v, exp: Date.now() + MX_TTL_MS });
  }
  return v;
}

// Backward compatible: purane callers ko { ok, email, reason, verification } milta rahega.
export async function checkEmail(raw, { mx = false, resolveMx = dns.resolveMx } = {}) {
  const email = String(raw || '').trim().toLowerCase();
  if (email.length > 254 || !SYNTAX.test(email)) return { ok: false, email, reason: 'invalid syntax', verification: 'invalid' };
  const [local, domain] = email.split('@');
  if (DISPOSABLE.has(domain)) return { ok: false, email, reason: 'disposable address', verification: 'disposable' };

  let tempfail = false;
  if (mx) {
    const s = await domainStatus(domain, resolveMx);
    if (s === 'nxdomain') return { ok: false, email, reason: 'domain does not exist', verification: 'invalid' };
    if (s === 'nomx') return { ok: false, email, reason: 'domain has no mail server', verification: 'invalid' };
    if (s === 'tempfail') tempfail = true; // reject nahi karte
  }

  const out = { ok: true, email, verification: 'valid' };
  if (TYPOS[domain]) { out.verification = 'risky'; out.reason = 'possible typo'; out.suggestion = `${local}@${TYPOS[domain]}`; }
  else if (ROLE.has(local)) { out.verification = 'risky'; out.reason = 'role address'; }
  if (tempfail) out.tempfail = true;
  return out;
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  }));
  return out;
}
