import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { q } from './db.js';
import { keyAuth } from './v1.js';
import { toHtml, mk, DEFAULT_STYLE } from '../public/editor.js';

// MCP server (Streamable HTTP, JSON responses). Lets Claude or any MCP client run your email marketing.
// Connect with:  URL  https://YOUR_HOST/mcp   header  Authorization: Bearer dk_live_...
// Each tool calls the same REST API the dashboard uses, so every limit, check and permission still applies.
export const mcp = express.Router();
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

async function internal(req, method, path, body) {
  const { rows: [u] } = await q(`SELECT id FROM users WHERE tenant_id = $1 ORDER BY (role = 'owner') DESC, created_at LIMIT 1`, [req.key.tenant_id]);
  const token = jwt.sign({ uid: u.id, tid: req.key.tenant_id, role: 'owner' }, config.jwtSecret, { expiresIn: '2m' });
  const r = await fetch(`http://127.0.0.1:${config.port}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error([j.error, ...(j.errors || [])].filter(Boolean).join(' | ') || `Request failed (${r.status})`);
  return j;
}
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const SEGMENT = { type: 'object', description: 'Optional audience filter. {match:"all"|"any", rules:[{field,value}]}. Fields: engaged_within(days), inactive_for(days), added_within(days), tag_has, tag_not, domain_is, custom_equals("field=value"), custom_contains, opened_campaign(id), clicked_campaign(id), not_opened_campaign(id).' };

const TOOLS = [
  { name: 'account_overview', description: 'Account status, plan, sending limits, last-30-day totals and setup checklist.', schema: obj({}), run: async (req) => {
    const [me, s] = await Promise.all([internal(req, 'GET', '/me'), internal(req, 'GET', '/stats')]);
    const { series, circuit, ...rest } = s; return { account: { name: me.name, status: me.status, plan: me.plan_name }, ...rest, thresholds: circuit };
  } },
  { name: 'deliverability_health', description: 'Spam-complaint and bounce rates against safe limits, plus whether each sending domain has SPF, DKIM and DMARC. Use this before recommending a big send.', schema: obj({}), run: async (req) => {
    const [s, d] = await Promise.all([internal(req, 'GET', '/stats'), internal(req, 'GET', '/domains')]);
    const cr = s.sent ? s.complained / s.sent : 0, br = s.sent ? s.bounced / s.sent : 0;
    return { complaint_rate: cr, complaint_limit: s.circuit.complaintRate, bounce_rate: br, bounce_limit: s.circuit.bounceRate,
      healthy: cr < s.circuit.complaintRate / 2 && br < s.circuit.bounceRate / 2, domains: d.map((x) => ({ domain: x.domain, spf: x.spf_ok, dkim: x.dkim_ok, dmarc: x.dmarc_ok, verified: !!x.verified_at })) };
  } },
  { name: 'list_campaigns', description: 'Recent campaigns with status and basic results.', schema: obj({}), run: async (req) => (await internal(req, 'GET', '/campaigns')).slice(0, 25).map(({ id, name, subject, status, sent, opens, clicks, bounced, scheduled_at }) => ({ id, name, subject, status, sent, opens, clicks, bounced, scheduled_at })) },
  { name: 'campaign_report', description: 'Full results of one campaign: totals, A/B versions, top links, results per mailbox provider.', schema: obj({ campaign_id: { type: 'string' } }, ['campaign_id']), run: (req, a) => internal(req, 'GET', `/campaigns/${encodeURIComponent(a.campaign_id)}/report`) },
  { name: 'list_lists', description: 'Contact lists with subscriber counts.', schema: obj({}), run: async (req) => (await internal(req, 'GET', '/lists')).map(({ id, name, subscribers }) => ({ id, name, subscribers })) },
  { name: 'preview_audience', description: 'How many people match a list and optional filter, with a few sample addresses. Always do this before creating or sending a campaign.', schema: obj({ list_id: { type: 'string' }, segment: SEGMENT }), run: (req, a) => internal(req, 'POST', '/audience/preview', { list_id: a.list_id || null, segment: a.segment || null }) },
  { name: 'create_campaign_draft', description: 'Create a DRAFT email campaign (nothing is sent). Provide the copy; a clean responsive design is generated. Returns the campaign id and a dashboard link where the user can edit it.', write: true,
    schema: obj({ name: { type: 'string' }, subject: { type: 'string' }, subject_b: { type: 'string', description: 'Optional second subject line for an A/B test' }, preheader: { type: 'string' }, from_name: { type: 'string' }, from_email: { type: 'string' },
      headline: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' }, description: 'Body paragraphs. Use {{first_name | there}} for the greeting.' }, button_label: { type: 'string' }, button_url: { type: 'string' },
      list_id: { type: 'string' }, segment: SEGMENT, send_time_opt: { type: 'boolean', description: 'Send each person at the hour they usually open email' } }, ['name', 'subject', 'from_name', 'from_email', 'paragraphs']),
    run: async (req, a) => {
      const blocks = [mk('heading', { text: a.headline || a.subject }), mk('text', { text: (a.paragraphs || []).slice(0, 8).join('\n\n') }), ...(a.button_label && /^https?:\/\//.test(a.button_url || '') ? [mk('button', { label: a.button_label, href: a.button_url })] : [])];
      const r = await internal(req, 'POST', '/campaigns', { name: a.name, subject: a.subject, subject_b: a.subject_b, preheader: a.preheader, from_name: a.from_name, from_email: a.from_email, list_id: a.list_id, segment: a.segment, send_time_opt: a.send_time_opt, html: toHtml({ blocks, style: { ...DEFAULT_STYLE } }) });
      return { campaign_id: r.id, edit_url: `${config.baseUrl}/#/campaigns/${r.id}`, next_step: 'Run check_campaign, show the user the subject, audience size and any issues, and wait for their explicit approval before send_campaign.' };
    } },
  { name: 'check_campaign', description: 'Run the pre-send checks (spam score, footer, links, domain, quotas) on a campaign.', schema: obj({ campaign_id: { type: 'string' } }, ['campaign_id']), run: (req, a) => internal(req, 'POST', `/campaigns/${encodeURIComponent(a.campaign_id)}/preflight`) },
  { name: 'schedule_campaign', description: 'Schedule a draft campaign for a future time (ISO 8601, at least a minute ahead). Ask the user to approve the time first.', write: true, schema: obj({ campaign_id: { type: 'string' }, at: { type: 'string' } }, ['campaign_id', 'at']), run: (req, a) => internal(req, 'POST', `/campaigns/${encodeURIComponent(a.campaign_id)}/schedule`, { at: a.at }) },
  { name: 'send_campaign', description: 'SEND a campaign to real people now. Irreversible. Only call after the user has explicitly approved this exact campaign, subject and audience size in this conversation, then pass confirm=true.', write: true, schema: obj({ campaign_id: { type: 'string' }, confirm: { type: 'boolean' } }, ['campaign_id', 'confirm']),
    run: async (req, a) => { if (a.confirm !== true) throw new Error('Not sent: confirm must be true, and only after the user explicitly approved the send.'); return internal(req, 'POST', `/campaigns/${encodeURIComponent(a.campaign_id)}/send`); } },
  { name: 'tag_audience', description: 'Add a tag to everyone who matches a list and filter. Tags can start automated journeys.', write: true, schema: obj({ tag: { type: 'string' }, list_id: { type: 'string' }, segment: SEGMENT }, ['tag']), run: (req, a) => internal(req, 'POST', '/audience/tag', { tag: a.tag, list_id: a.list_id || null, segment: a.segment || null }) },
  { name: 'list_journeys', description: 'Automated journeys (welcome series etc.) with how many people entered and finished.', schema: obj({}), run: async (req) => (await internal(req, 'GET', '/automations')).map(({ id, name, status, trigger_cfg, step_count, entered, active, completed }) => ({ id, name, status, trigger: trigger_cfg, step_count, entered, active, completed })) },
  { name: 'journey_report', description: 'Per-step results of one journey: people waiting at each step, and sends, opens and clicks for each email.', schema: obj({ journey_id: { type: 'string' } }, ['journey_id']), run: async (req, a) => { const j = await internal(req, 'GET', `/automations/${encodeURIComponent(a.journey_id)}`); return { name: j.name, status: j.status, trigger: j.trigger_cfg, steps: j.steps.map(({ html, ...s }) => s), report: j.report }; } },
];

const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(req, m) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return fail(m?.id ?? null, -32600, 'Invalid request');
  if (m.id === undefined) return null;                                   // notification
  switch (m.method) {
    case 'initialize': return rpc(m.id, { protocolVersion: VERSIONS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'dakghar', version: '1.0.0' },
      instructions: 'Email marketing platform. Look before you act: use account_overview, deliverability_health and preview_audience first. Create drafts freely, but never call send_campaign until the user has approved the exact campaign.' });
    case 'ping': return rpc(m.id, {});
    case 'tools/list': return rpc(m.id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description + (t.write ? ' (needs a read-write API key)' : ''), inputSchema: t.schema, annotations: { readOnlyHint: !t.write, destructiveHint: t.name === 'send_campaign' } })) });
    case 'tools/call': {
      const t = TOOLS.find((x) => x.name === m.params?.name);
      if (!t) return fail(m.id, -32602, `Unknown tool: ${m.params?.name}`);
      const text = (v, isError) => rpc(m.id, { content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }], ...(isError && { isError: true }) });
      if (t.write && req.key.scope !== 'write') return text('This API key is read-only. Create a read-write key in Settings to use this tool.', true);
      try { return text(await t.run(req, m.params.arguments || {})); } catch (e) { return text(e.message, true); }
    }
    default: return fail(m.id, -32601, `Method not found: ${m.method}`);
  }
}
mcp.post('/', keyAuth, async (req, res) => {
  const batch = Array.isArray(req.body);
  const out = (await Promise.all((batch ? req.body : [req.body]).map((m) => handle(req, m)))).filter(Boolean);
  if (!out.length) return res.status(202).end();
  res.json(batch ? out : out[0]);
});
mcp.get('/', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'This MCP server answers POST requests (Streamable HTTP).' }));
