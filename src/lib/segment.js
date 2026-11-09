import { HttpError } from '../db.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const days = (v) => { const n = Math.floor(+v); if (!(n >= 0 && n <= 3650)) throw new HttpError(400, 'Segment: enter a number of days.'); return n; };
const text = (v) => { const s = String(v ?? '').trim().slice(0, 100); if (!s) throw new HttpError(400, 'Segment: a condition has no value.'); return s; };
const camp = (v) => { if (!UUID.test(v || '')) throw new HttpError(400, 'Segment: pick a campaign.'); return v; };
const kv = (v) => { const s = text(v); const i = s.indexOf('='); if (i < 1) throw new HttpError(400, 'Segment: use field=value, e.g. city=Delhi.'); return [s.slice(0, i).trim().toLowerCase(), s.slice(i + 1).trim()]; };

const sent = (n) => `EXISTS (SELECT 1 FROM messages m WHERE m.campaign_id = $${n}::uuid AND m.contact_id = c.id AND m.tenant_id = c.tenant_id)`;
const ev = (n, type) => `EXISTS (SELECT 1 FROM messages m JOIN events e ON e.message_id = m.id WHERE m.campaign_id = $${n}::uuid AND m.contact_id = c.id AND e.type = '${type}')`;

// Each rule appends its parameters and returns a SQL fragment. Only whitelisted rules, always parameterised.
export const RULES = {
  engaged_within: (v, p) => { p.push(days(v)); return `c.last_engaged_at >= now() - ($${p.length}::int * interval '1 day')`; },
  inactive_for: (v, p) => { p.push(days(v)); return `(c.last_engaged_at IS NULL OR c.last_engaged_at < now() - ($${p.length}::int * interval '1 day'))`; },
  added_within: (v, p) => { p.push(days(v)); return `c.created_at >= now() - ($${p.length}::int * interval '1 day')`; },
  tag_has: (v, p) => { p.push(text(v).toLowerCase()); return `c.tags @> ARRAY[$${p.length}::text]`; },
  tag_not: (v, p) => { p.push(text(v).toLowerCase()); return `NOT (c.tags @> ARRAY[$${p.length}::text])`; },
  domain_is: (v, p) => { p.push(text(v).toLowerCase().replace(/^@/, '')); return `split_part(c.email::text, '@', 2) = $${p.length}`; },
  custom_equals: (v, p) => { const [k, val] = kv(v); p.push(k, val); return `lower(c.custom_fields->>$${p.length - 1}) = lower($${p.length})`; },
  custom_contains: (v, p) => { const [k, val] = kv(v); p.push(k, val.replace(/[%_\\]/g, '\\$&')); return `c.custom_fields->>$${p.length - 1} ILIKE '%' || $${p.length} || '%'`; },
  opened_campaign: (v, p) => { p.push(camp(v)); return ev(p.length, 'open'); },
  clicked_campaign: (v, p) => { p.push(camp(v)); return ev(p.length, 'click'); },
  not_opened_campaign: (v, p) => { p.push(camp(v)); return `${sent(p.length)} AND NOT ${ev(p.length, 'open')}`; },
};

export function segmentSql(seg, params) {
  if (!seg || !Array.isArray(seg.rules) || !seg.rules.length) return 'TRUE';
  if (seg.rules.length > 10) throw new HttpError(400, 'Segment: at most 10 conditions.');
  const parts = seg.rules.map((r) => {
    const fn = RULES[r?.field];
    if (!fn) throw new HttpError(400, 'Segment: unknown condition.');
    return `(${fn(r.value, params)})`;
  });
  return parts.join(seg.match === 'any' ? ' OR ' : ' AND ');
}
