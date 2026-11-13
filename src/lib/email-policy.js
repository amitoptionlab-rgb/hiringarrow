import dns from 'node:dns/promises';

const FREE = new Set([
  'gmail.com','googlemail.com','yahoo.com','yahoo.in','yahoo.co.in','ymail.com','outlook.com','hotmail.com',
  'live.com','msn.com','icloud.com','me.com','proton.me','protonmail.com','rediffmail.com','aol.com',
  'zoho.com','gmx.com','mail.com','yandex.com','tutanota.com'
]);

export function domainOf(email) {
  const m = String(email || '').trim().toLowerCase().match(/^[^\s@]+@([a-z0-9-]+(\.[a-z0-9-]+)+)$/);
  return m ? m[1] : null;
}

export function checkEmail(email) {
  const d = domainOf(email);
  if (!d) return { ok: false, reason: 'Valid email daalo.' };
  if (FREE.has(d)) return { ok: false, reason: 'Free email (Gmail/Yahoo etc.) allowed nahi. Company email use karo.' };
  return { ok: true, domain: d };
}

export async function hasMx(domain) {
  try { const r = await dns.resolveMx(domain); return Array.isArray(r) && r.length > 0; }
  catch { return false; }
}

export function isFreeEmail(email) { const d = domainOf(email); return !!d && FREE.has(d); }
