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
// Signed link that expires: id.exp.mac (used for email verification)
export const signTimed = (kind, id, ttlSec) => {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return id + "." + exp + "." + mac(kind + ":" + id + ":" + exp);
};
export function verifyTimed(kind, token) {
  const [id, exp, sig] = String(token || "").split(".");
  if (!id || !sig || !/^\d{1,12}$/.test(exp || "")) return null;
  if (+exp < Date.now() / 1000) return null;
  return same(mac(kind + ":" + id + ":" + exp), sig) ? id : null;
}
export const signLink = (messageId, url) => mac(`l:${messageId}:${url}`);
export const verifyLink = (messageId, url, sig) => same(mac(`l:${messageId}:${url}`), String(sig || ''));

// Reply-To address: r-<32 hex message id><12 hex mac>@REPLY_DOMAIN
// Hex and lower-case only: mail systems may lower-case the local part and "+tags" are not supported everywhere.
const replyMac = (hex) => crypto.createHmac('sha256', config.signSecret).update('reply:' + hex).digest('hex').slice(0, 12);
export function replyAddress(messageId, domain = config.replyDomain) {
  const hex = String(messageId).replace(/-/g, '').toLowerCase();
  if (!domain || !/^[0-9a-f]{32}$/.test(hex)) return null;
  return `r-${hex}${replyMac(hex)}@${domain}`;
}
// local part in, message uuid out (or null when the shape or the mac is wrong)
export function verifyReplyLocal(local) {
  const m = /^r-([0-9a-f]{32})([0-9a-f]{12})$/.exec(String(local || '').toLowerCase());
  if (!m || !same(replyMac(m[1]), m[2])) return null;
  const h = m[1];
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-');
}
