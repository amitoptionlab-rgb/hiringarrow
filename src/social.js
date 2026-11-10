// Social login: Google and LinkedIn (OpenID Connect, authorization-code flow).
// Routes: GET /auth/providers, GET /auth/:provider, GET /auth/:provider/callback
import express from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { tx } from './db.js';

export const social = express.Router();
social.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }));

const PROVIDERS = {
  google: {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    info: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    extra: { prompt: 'select_account' },
  },
  linkedin: {
    auth: 'https://www.linkedin.com/oauth/v2/authorization',
    token: 'https://www.linkedin.com/oauth/v2/accessToken',
    info: 'https://api.linkedin.com/v2/userinfo',
    scope: 'openid profile email',
    extra: {},
  },
};
const creds = (name) => { const c = config.oauth?.[name]; return PROVIDERS[name] && c && c.id && c.secret ? c : null; };
const redirectUri = (name) => `${config.baseUrl}/auth/${name}/callback`;

// state is a random value kept in a short-lived HttpOnly cookie and echoed back by the provider (blocks login CSRF)
const cookieName = (name) => `oa_${name}`;
const readCookie = (req, key) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === key) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; } }
  }
  return '';
};
const setCookie = (res, key, val, maxAge) => res.append('Set-Cookie',
  `${key}=${val}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.baseUrl.startsWith('https://') ? '; Secure' : ''}`);
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const sign = (u) => jwt.sign({ uid: u.id, tid: u.tenant_id, role: u.role }, config.jwtSecret, { expiresIn: '7d' });
// Social-only accounts get a random password nobody knows, so password login cannot succeed for them.
const unusableHash = () => bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

async function findOrCreate(provider, sub, email, displayName) {
  return tx(async (c) => {
    const { rows: [known] } = await c.query(
      `SELECT u.id, u.tenant_id, u.role FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = $1 AND i.provider_user_id = $2`, [provider, sub]);
    if (known) return { user: known, created: false };

    const link = (userId) => c.query(
      `INSERT INTO user_identities (provider, provider_user_id, user_id, email) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [provider, sub, userId, email]);

    const { rows: [byEmail] } = await c.query('SELECT id, tenant_id, role, email_verified_at FROM users WHERE email = $1', [email]);
    if (byEmail) {
      if (!byEmail.email_verified_at) {
        // With REQUIRE_EMAIL_VERIFY on, an unverified account has never been usable: anyone could have registered this address.
        // Take it over (and lock out whatever password was set). With it off, NULL says nothing, so refuse instead of guessing.
        if (!config.requireEmailVerify) return { error: 'account_exists' };
        await c.query('UPDATE users SET email_verified_at = now(), password_hash = $2 WHERE id = $1', [byEmail.id, await unusableHash()]);
      }
      await link(byEmail.id);
      return { user: byEmail, created: false };
    }

    const { rows: [plan] } = await c.query(`SELECT id FROM plans WHERE code = 'free'`);
    const status = config.autoApprove ? 'active' : 'review';
    const cap = config.autoApprove ? 5000 : 200;
    const company = String(displayName || email.split('@')[0]).trim().slice(0, 100) || 'My company';
    const { rows: [t] } = await c.query(
      `INSERT INTO tenants (name, plan_id, status, daily_send_cap) VALUES ($1, $2, $3, $4) RETURNING id`, [company, plan.id, status, cap]);
    const { rows: [u] } = await c.query(
      `INSERT INTO users (tenant_id, email, password_hash, role, email_verified_at) VALUES ($1, $2, $3, 'owner', now()) RETURNING id, tenant_id, role`,
      [t.id, email, await unusableHash()]);
    await link(u.id);
    return { user: u, created: true };
  });
}

social.get('/providers', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(Object.fromEntries(Object.keys(PROVIDERS).map((n) => [n, !!creds(n)])));
});

social.get('/:provider', (req, res) => {
  const name = req.params.provider, p = PROVIDERS[name], c = creds(name);
  if (!c) return res.redirect('/?auth_error=not_configured');
  const state = crypto.randomBytes(24).toString('hex');
  setCookie(res, cookieName(name), state, 600);
  const url = new URL(p.auth);
  url.search = new URLSearchParams({ response_type: 'code', client_id: c.id, redirect_uri: redirectUri(name), scope: p.scope, state, ...p.extra }).toString();
  res.set('Cache-Control', 'no-store').redirect(url.toString());
});

social.get('/:provider/callback', async (req, res) => {
  const name = req.params.provider, p = PROVIDERS[name], c = creds(name);
  res.set('Cache-Control', 'no-store');
  const fail = (code) => { setCookie(res, cookieName(name), '', 0); return res.redirect('/?auth_error=' + code); };
  if (!c) return fail('not_configured');
  try {
    if (req.query.error) return fail('cancelled');
    const state = String(req.query.state || ''), code = String(req.query.code || ''), saved = readCookie(req, cookieName(name));
    if (!code || !state || !saved || !same(state, saved)) return fail('failed');

    const tr = await fetch(p.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(name), client_id: c.id, client_secret: c.secret }),
      signal: AbortSignal.timeout(10000),
    });
    const tj = await tr.json().catch(() => ({}));
    if (!tr.ok || !tj.access_token) { console.error(`[social] ${name} token exchange failed: ${tr.status} ${tj.error || ''}`); return fail('failed'); }

    const ir = await fetch(p.info, { headers: { Authorization: 'Bearer ' + tj.access_token }, signal: AbortSignal.timeout(10000) });
    const prof = await ir.json().catch(() => ({}));
    if (!ir.ok || !prof.sub) { console.error(`[social] ${name} userinfo failed: ${ir.status}`); return fail('failed'); }

    const email = String(prof.email || '').trim().toLowerCase();
    if (!email || !(prof.email_verified === true || prof.email_verified === 'true')) return fail('email_unverified');

    const r = await findOrCreate(name, String(prof.sub), email, prof.name);
    if (r.error) return fail(r.error);
    setCookie(res, cookieName(name), '', 0);
    res.redirect('/#social=' + sign(r.user) + (r.created ? '&new=1' : ''));
  } catch (e) {
    console.error(`[social] ${name} error: ${e.message}`);
    fail('failed');
  }
});
