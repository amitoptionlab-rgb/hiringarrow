import crypto from 'node:crypto';
import { config } from '../config.js';

const mac = (s) => crypto.createHmac('sha256', config.signSecret).update(s).digest('base64url').slice(0, 24);
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// kind: 'u' unsubscribe, 'c' confirm opt-in
export const signId = (kind, id) => `${id}.${mac(`${kind}:${id}`)}`;
export function verifyId(kind, token) {
  const [id, sig] = String(token || '').split('.');
  if (!id || !sig) return null;
  return same(mac(`${kind}:${id}`), sig) ? id : null;
}
export const signLink = (messageId, url) => mac(`l:${messageId}:${url}`);
export const verifyLink = (messageId, url, sig) => same(mac(`l:${messageId}:${url}`), String(sig || ''));
