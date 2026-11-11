import { q } from '../db.js';
import { config } from '../config.js';

// Daily ceiling while a new domain builds reputation (day 0, 1, 2 ...)
const WARMUP = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 20000, 50000];
export function warmupCap(verifiedAt) {
  if (!config.requireDomainVerified) return Infinity; // dev mode
  if (!verifiedAt) return WARMUP[0];
  const day = Math.floor((Date.now() - new Date(verifiedAt).getTime()) / 864e5);
  return day >= WARMUP.length ? Infinity : WARMUP[day];
}

export async function allowance(tenantId, domain) {
  const { rows: [t] } = await q(
    `SELECT t.daily_send_cap, p.monthly_emails FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`, [tenantId]);
  const { rows: [u] } = await q(
    `SELECT COALESCE((SELECT emails_sent FROM usage_counters WHERE tenant_id = $1 AND period = date_trunc('month', now())::date), 0)::int AS month_sent,
            (SELECT count(*) FROM messages WHERE tenant_id = $1 AND status = 'queued')::int AS queued,
            (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE tenant_id = $1)::int AS credits,
            (SELECT count(*) FROM messages WHERE tenant_id = $1 AND sent_at >= date_trunc('day', now()))::int AS today`, [tenantId]);
  const dayLimit = Math.min(t.daily_send_cap, warmupCap(domain?.verified_at));
  // Plan quota first; purchased credits cover everything beyond it. Credits never raise the daily cap or warm-up limit.
  const used = u.month_sent + u.queued;
  const queuedOver = Math.max(0, used - t.monthly_emails) - Math.max(0, u.month_sent - t.monthly_emails); // queued, not yet charged to credits
  const monthLeft = Math.max(0, t.monthly_emails - used) + Math.max(0, u.credits - queuedOver);
  const dayLeft = dayLimit - u.today - u.queued;
  return {
    allowed: Math.max(0, Math.min(monthLeft, dayLeft)),
    month: { used: u.month_sent + u.queued, limit: t.monthly_emails },
    day: { used: u.today + u.queued, limit: Number.isFinite(dayLimit) ? dayLimit : null },
  };
}
