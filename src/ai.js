import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { q, HttpError } from './db.js';
import { RULES, segmentSql } from './lib/segment.js';
import { subjectChecks } from './lib/preflight.js';
import { subjectsLocal, draftLocal, segmentLocal } from './lib/ai-local.js';
import { toHtml, mk, DEFAULT_STYLE } from '../public/editor.js';

// Writing help. Free by default: a built-in helper that needs no account and sends nothing anywhere.
// Optional: set AI_BASE_URL to any OpenAI-compatible chat endpoint (for example a local Ollama, which is free)
// and the same features use that model. If the model is unreachable we fall back to the built-in helper.
export const aiRouter = express.Router();
aiRouter.use(rateLimit({ windowMs: 3600e3, limit: 60, keyGenerator: (req) => req.user.tid, standardHeaders: true, legacyHeaders: false, validate: false,
  handler: (req, res) => res.status(429).json({ error: 'Writing help limit reached for this hour. Try again later.' }) }));

export async function askLlm(system, user) {
  const { baseUrl, model, key } = config.ai;
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST', signal: AbortSignal.timeout(45_000),
    headers: { 'content-type': 'application/json', ...(key && { authorization: `Bearer ${key}` }) },
    body: JSON.stringify({ model, temperature: 0.7, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  if (!r.ok) throw new Error(`model answered ${r.status}`);
  const text = (await r.json()).choices?.[0]?.message?.content || '';
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('no JSON in model reply');
  return JSON.parse(m[0]);
}
const viaModel = async (system, user) => { if (!config.ai.baseUrl) return null; try { return await askLlm(system, user); } catch (e) { console.warn('[ai] model unavailable, using built-in helper:', e.message); return null; } };
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const RULES_TEXT = 'Allowed fields: engaged_within (days), inactive_for (days), added_within (days), tag_has, tag_not, domain_is, custom_equals ("field=value"), custom_contains, opened_campaign, clicked_campaign, not_opened_campaign (campaign id).';
const STYLE_RULES = 'Write honestly for the actual content. No ALL CAPS, at most one exclamation mark, no words like free, winner, urgent, act now, guaranteed, no fake Re:/Fwd:. Never invent facts, prices, discounts or links.';

aiRouter.get('/mode', (req, res) => res.json({ mode: config.ai.baseUrl ? 'model' : 'builtin' }));

aiRouter.post('/assist', async (req, res) => {
  const b = req.body, task = b.task, T = req.user.tid;

  if (task === 'subjects') {
    const brief = clip(b.brief, 1500); if (!brief) throw new HttpError(400, 'Describe what the email is about.');
    const out = await viaModel(`TASK:subjects You write email subject lines for small businesses in India. ${STYLE_RULES} Each line is at most 60 characters. Match the language of the brief (Hinglish is fine). Reply with JSON only: {"subjects":["","","","",""]}`, `Tone: ${clip(b.tone, 40) || 'friendly'}\nEmail is about: ${brief}`);
    let list = (Array.isArray(out?.subjects) ? out.subjects : []).map((s) => clip(s, 150)).filter(Boolean).slice(0, 5);
    if (!list.length) list = subjectsLocal(brief, clip(b.tone, 40) || 'friendly');
    return res.json({ subjects: list.map((text) => { const c = subjectChecks(text); return { text, ok: !c.errors.length && c.score < 3, note: c.errors[0] || c.warnings[0] || '' }; }) });
  }

  if (task === 'draft') {
    const brief = clip(b.brief, 2000); if (!brief) throw new HttpError(400, 'Describe the email you want.');
    const link = /^https?:\/\/\S+$/i.test(clip(b.button_url, 500)) ? clip(b.button_url, 500) : '';
    let out = await viaModel(`TASK:draft You write short marketing emails for small businesses in India. ${STYLE_RULES} Use {{first_name | there}} once in the greeting. Under 120 words. Reply with JSON only: {"subject":"","preheader":"","headline":"","paragraphs":["",""],"button_label":""}`, `Tone: ${clip(b.tone, 40) || 'friendly'}\nBrief: ${brief}`);
    const paragraphs = (Array.isArray(out?.paragraphs) ? out.paragraphs : []).map((p) => clip(p, 700)).filter(Boolean).slice(0, 5);
    if (!clip(out?.subject, 150) || !paragraphs.length) out = draftLocal({ brief, tone: clip(b.tone, 40) || 'friendly', buttonUrl: link });
    const paras = Array.isArray(out.paragraphs) ? out.paragraphs.map((p) => clip(p, 700)).filter(Boolean).slice(0, 5) : [];
    const blocks = [mk('heading', { text: clip(out.headline, 120) || clip(out.subject, 120) }), mk('text', { text: paras.join('\n\n') }),
      ...(link && clip(out.button_label, 40) ? [mk('button', { label: clip(out.button_label, 40) || 'Read more', href: link })] : [])];
    return res.json({ subject: clip(out.subject, 150), preheader: clip(out.preheader, 200), html: toHtml({ blocks, style: { ...DEFAULT_STYLE } }) });
  }

  if (task === 'segment') {
    const text = clip(b.text, 500); if (!text) throw new HttpError(400, 'Describe who should get this email.');
    const [{ rows: camps }, { rows: tg }, { rows: fl }] = await Promise.all([
      q(`SELECT id, name FROM campaigns WHERE tenant_id = $1 AND kind = 'broadcast' ORDER BY created_at DESC LIMIT 30`, [T]),
      q(`SELECT DISTINCT t AS v FROM contacts c, unnest(c.tags) t WHERE c.tenant_id = $1 LIMIT 60`, [T]),
      q(`SELECT DISTINCT k AS v FROM contacts c, jsonb_object_keys(c.custom_fields) k WHERE c.tenant_id = $1 LIMIT 30`, [T]),
    ]);
    const valid = (o) => {
      const rules = (Array.isArray(o?.rules) ? o.rules : []).slice(0, 10).map((r) => ({ field: String(r.field), value: String(r.value ?? '') }));
      if (!rules.length || rules.some((r) => !RULES[r.field]) || rules.filter((r) => r.field.endsWith('_campaign')).some((r) => !camps.find((c) => c.id === r.value))) return null;
      const seg = { match: o.match === 'any' ? 'any' : 'all', rules };
      try { segmentSql(seg, []); } catch { return null; }
      return seg;
    };
    const out = await viaModel(`TASK:segment You turn a plain-language audience description into filter conditions. ${RULES_TEXT} Existing tags: ${JSON.stringify(tg.map((x) => x.v))}. Existing custom fields: ${JSON.stringify(fl.map((x) => x.v))}. Campaigns: ${JSON.stringify(camps)}. Reply with JSON only: {"match":"all"|"any","rules":[{"field":"","value":""}],"explanation":"one short sentence"}`, text);
    const seg = valid(out);
    if (seg) return res.json({ segment: seg, explanation: clip(out.explanation, 300) });
    return res.json(segmentLocal(text, { tags: tg.map((x) => x.v), fields: fl.map((x) => x.v), camps }));
  }
  throw new HttpError(400, 'Unknown task.');
});
