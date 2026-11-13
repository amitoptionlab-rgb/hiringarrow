import crypto from 'node:crypto';
import { q } from '../db.js';

// Append-only audit trail (table audit_log, see db/013_audit_log.sql).
// audit() never throws: a logging failure must not break the request.
// Never put passwords, tokens or message bodies in "details".

const COOKIE = 'did';
const DID = /^[a-f0-9]{32}$/;
const YEAR_MS = 365 * 24 * 3600 * 1000;

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// Random per-browser id (cookie "did"). issue=true sets the cookie if missing (only possible before the response is sent).
export function deviceId(req, issue = false) {
  const c = readCookie(req, COOKIE);
  if (c && DID.test(c)) return c;
  const res = req.res;
  if (!issue || !res || res.headersSent) return null;
  const id = crypto.randomBytes(16).toString('hex');
  res.cookie(COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: !!req.secure, maxAge: YEAR_MS, path: '/' });
  return id;
}

const clientIp = (req) => String(req.ip || '').replace(/^::ffff:/, '') || null;

// o: { tenantId, userId, success, targetType, targetId, details, actorType, actorLabel, issueDevice }
export async function audit(req, action, o = {}) {
  try {
    await q(
      'INSERT INTO audit_log (actor_type, actor_label, tenant_id, user_id, action, success, ip, user_agent, device_id, target_type, target_id, details) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [
        o.actorType || (req.user ? 'user' : 'anonymous'),
        o.actorLabel || null,
        o.tenantId || req.user?.tid || null,
        o.userId || req.user?.uid || null,
        action,
        o.success !== false,
        clientIp(req),
        String(req.headers['user-agent'] || '').slice(0, 300) || null,
        deviceId(req, !!o.issueDevice),
        o.targetType || null,
        o.targetId ? String(o.targetId).slice(0, 100) : null,
        JSON.stringify(o.details || {}),
      ]);
  } catch (e) { console.error('[audit] failed:', action, e.message); }
}

const SKIP = /^\/api\/ai(\/|$)/;

// Tenant API: logs every successful state-changing request (POST/PUT/PATCH/DELETE) after the response is sent.
// Mount it right after the JWT check. Only the route + ids + status are stored, never the body.
export const auditMutations = () => (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  res.on('finish', () => {
    if (!req.route || res.statusCode >= 400) return;
    const route = req.baseUrl + String(req.route.path);
    if (SKIP.test(route)) return;
    audit(req, req.method + ' ' + route, { targetId: req.params?.id, details: { status: res.statusCode } });
  });
  next();
};

// Operator endpoints (x-admin-key). Logs every request, GET included (who looked at what), with the self-declared x-admin-name.
export const auditAdmin = () => (req, res, next) => {
  const label = String(req.headers['x-admin-name'] || '').replace(/[^\w .@-]/g, '').slice(0, 60) || 'admin-key';
  res.on('finish', () => {
    if (!req.route) return;
    const b = req.body || {};
    audit(req, req.method + ' ' + req.baseUrl + String(req.route.path), {
      actorType: 'admin',
      actorLabel: label,
      tenantId: req.params?.id,
      success: res.statusCode < 400,
      targetType: req.params?.id ? 'tenant' : null,
      targetId: req.params?.id,
      details: { status: res.statusCode, plan_code: b.plan_code, daily_send_cap: b.daily_send_cap },
    });
  });
  next();
};
