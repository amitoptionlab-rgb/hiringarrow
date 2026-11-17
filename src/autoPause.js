// src/autoPause.js — auto-pause worker (plain ESM JS, matches your project).
// Use in src/worker.js:  import { startAutoPause } from './autoPause.js';  startAutoPause();
import { pool } from './db.js';
import fs from 'node:fs';

const MIN_SAMPLE = 100;                                   // don't judge tiny samples
const LIMITS = { bounce: 5, complaint: 0.3, unsub: 5 };   // auto-pause %
const WARN   = { bounce: 3, complaint: 0.1, unsub: 2 };   // warning %
const EVERY_MS = 10 * 60 * 1000;

async function alert(msg) {
  console.warn('[auto-pause]', msg);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: msg }),
    });
  } catch (e) { console.error('[auto-pause] alert failed', e.message); }
}

export async function checkTenants() {
  const { rows } = await pool.query(
    `SELECT tenant_id, name, sent_7d, bounce_pct, complaint_pct, unsub_pct
       FROM tenant_health
      WHERE status = 'active' AND sent_7d >= $1`,
    [MIN_SAMPLE]
  );

  for (const r of rows) {
    const b = Number(r.bounce_pct ?? 0);
    const c = Number(r.complaint_pct ?? 0);
    const u = Number(r.unsub_pct ?? 0);

    const reasons = [];
    if (b >= LIMITS.bounce) reasons.push(`bounce ${b}%`);
    if (c >= LIMITS.complaint) reasons.push(`complaint ${c}%`);
    if (u >= LIMITS.unsub) reasons.push(`unsubscribe ${u}%`);

    if (reasons.length) {
      const res = await pool.query(
        `UPDATE tenants SET status = 'suspended' WHERE id = $1 AND status = 'active'`,
        [r.tenant_id]
      );
      if (res.rowCount) {
        await pool.query(
          `INSERT INTO audit_log (actor_type, actor_label, tenant_id, action, target_type, target_id, details)
           VALUES ('system', 'auto-pause', $1, 'tenant.auto_suspend', 'tenant', $1::text, $2)`,
          [r.tenant_id, JSON.stringify({ reasons, sent_7d: r.sent_7d })]
        );
        await alert(`SUSPENDED ${r.name} (${r.tenant_id}): ${reasons.join(', ')}`);
      }
    } else if (b >= WARN.bounce || c >= WARN.complaint || u >= WARN.unsub) {
      await alert(`WARNING ${r.name}: bounce ${b}%, complaint ${c}%, unsub ${u}%`);
    }
  }
}

async function ensureView() {
  const sql = fs.readFileSync(new URL('../db/016_tenant_health.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  console.log('[auto-pause] tenant_health view ready');
}

export function startAutoPause() {
  ensureView().catch((e) => console.error('[auto-pause] view setup failed', e.message));
  const run = () => checkTenants().catch((e) => console.error('[auto-pause] error', e.message));
  run();
  return setInterval(run, EVERY_MS);
}
