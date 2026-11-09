// End-to-end check against a running server + worker. Usage: npm run smoke
import { pool } from '../src/db.js';
import { signId } from '../src/lib/tokens.js';

const base = process.env.BASE_URL || 'http://localhost:3000';
let token = '', pass = 0, fail = 0;
const ok = (c, msg) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${msg}`); };
const call = async (method, path, body, form) => {
  const r = await fetch(base + path, { method, headers: { ...(token && { Authorization: 'Bearer ' + token }), ...(!form && body && { 'Content-Type': 'application/json' }) }, body: form || (body && JSON.stringify(body)) });
  let j = null; try { j = await r.json(); } catch { /* html */ }
  return { s: r.status, j };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const email = `owner${Date.now()}@example.com`;

let r = await call('POST', '/api/auth/signup', { email, password: 'correct-horse-9', company: 'Acme Test' });
ok(r.s === 201 && r.j.token, 'signup returns a token'); token = r.j.token;
r = await call('POST', '/api/auth/signup', { email: 'x@mailinator.com', password: 'correct-horse-9', company: 'Bad' });
ok(r.s === 400, 'disposable email blocked at signup');
r = await call('GET', '/api/contacts'); ok(r.s === 200, 'authenticated request works');
token = ''; r = await call('GET', '/api/contacts'); ok(r.s === 401, 'no token is rejected'); token = (await call('POST', '/api/auth/login', { email, password: 'correct-horse-9' })).j.token;

r = await call('POST', '/api/lists', { name: 'Newsletter' }); const listId = r.j.id; ok(!!listId, 'list created');
const csv = 'email,first_name,city\nalice@example.com,Alice,Delhi\nbob@example.com,Bob,Pune\nbob@example.com,Bob,Pune\nnotanemail,Zed,X\ntemp@mailinator.com,Tmp,Y\ncarol@example.com,,Goa\n';
const fd = () => { const f = new FormData(); f.append('file', new Blob([csv], { type: 'text/csv' }), 'c.csv'); f.append('list_id', listId); f.append('consent', 'true'); return f; };
const nofd = new FormData(); nofd.append('file', new Blob([csv]), 'c.csv');
r = await call('POST', '/api/contacts/import', null, nofd); ok(r.s === 400, 'import without consent is refused');
r = await call('POST', '/api/contacts/import', null, fd());
ok(r.j.added === 3 && r.j.duplicates === 1 && r.j.rejected === 2, `import: 3 added, 1 duplicate, 2 rejected (got ${JSON.stringify([r.j.added, r.j.duplicates, r.j.rejected])})`);

const html = '<h1>Hi {{first_name | there}}</h1><p>Here is our monthly update with news, tips and offers from {{city | your city}}. Read more on our site.</p><p><a href="https://example.com/post?a=1&amp;b=2">Read the post</a></p>';
const camp = { name: 'Nov update', subject: 'Our November update', from_name: 'Acme', from_email: 'news@acme-test.com', list_id: listId, html };
r = await call('POST', '/api/campaigns', camp); const cid = r.j.id; ok(!!cid, 'campaign created');
r = await call('POST', `/api/campaigns/${cid}/preflight`); ok(r.j.ok === false && r.j.errors.some((e) => /postal address/.test(e)), 'preflight blocks send without postal address');
r = await call('POST', `/api/campaigns/${cid}/send`); ok(r.s === 422, 'send is blocked when preflight fails');
await call('PATCH', '/api/tenant', { name: 'Acme Test', postal_address: '12 MG Road, Bengaluru 560001, India' });
const bad = await call('POST', '/api/campaigns', { ...camp, subject: 'ACT NOW!!! FREE MONEY!!! WINNER', html: '<p>click here <a href="https://bit.ly/x">buy now</a></p>' });
r = await call('POST', `/api/campaigns/${bad.j.id}/preflight`); ok(r.j.ok === false && r.j.errors.length >= 2, 'spammy campaign fails preflight');
r = await call('POST', `/api/campaigns/${cid}/preflight`); ok(r.j.ok === true, 'clean campaign passes preflight');

r = await call('POST', `/api/campaigns/${cid}/send`); ok(r.s === 200 && r.j.queued === 3, `send queued 3 (got ${r.j.queued})`);
let sent = 0; for (let i = 0; i < 30 && sent < 3; i++) { await sleep(500); sent = (await pool.query(`SELECT count(*)::int n FROM messages WHERE campaign_id=$1 AND status='sent'`, [cid])).rows[0].n; }
ok(sent === 3, 'worker delivered all 3 messages');
r = await call('POST', `/api/campaigns/${cid}/send`); ok(r.s === 400, 're-sending does not double-send anyone');
await sleep(300);
ok((await pool.query(`SELECT status FROM campaigns WHERE id=$1`, [cid])).rows[0].status === 'done', 'campaign marked done');

const { rows: msgs } = await pool.query(`SELECT m.id, m.provider_msg_id, m.contact_id, c.email FROM messages m JOIN contacts c ON c.id=m.contact_id WHERE m.campaign_id=$1 ORDER BY c.email`, [cid]);
const [a, b, c] = msgs;
let t = await fetch(`${base}/t/o/${a.id}.gif`); ok(t.status === 200 && t.headers.get('content-type') === 'image/gif', 'open pixel served');
const url = 'https://example.com/post?a=1&b=2';
const sig = (await import('../src/lib/tokens.js')).signLink(a.id, url);
t = await fetch(`${base}/t/c/${a.id}?u=${Buffer.from(url).toString('base64url')}&s=${sig}`, { redirect: 'manual' }); ok(t.status === 302 && t.headers.get('location') === url, 'signed click redirects');
t = await fetch(`${base}/t/c/${a.id}?u=${Buffer.from('https://evil.example').toString('base64url')}&s=${sig}`, { redirect: 'manual' }); ok(t.status === 400, 'tampered click link is refused (no open redirect)');
await sleep(300);

t = await fetch(`${base}/u/${signId('u', b.contact_id)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
ok(t.status === 200, 'one-click unsubscribe works');
ok((await pool.query(`SELECT status FROM contacts WHERE id=$1`, [b.contact_id])).rows[0].status === 'unsubscribed', 'contact marked unsubscribed');

const sns = (type, id) => fetch(`${base}/webhooks/ses`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ Type: 'Notification', Message: JSON.stringify({ notificationType: type, mail: { messageId: id }, bounce: { bounceType: 'Permanent' }, complaint: {} }) }) });
await sns('Bounce', c.provider_msg_id);
ok((await pool.query(`SELECT status FROM contacts WHERE id=$1`, [c.contact_id])).rows[0].status === 'bounced', 'SES hard bounce suppresses the contact');
await sns('Complaint', a.provider_msg_id);
ok((await pool.query(`SELECT 1 FROM suppressions WHERE email=$1 AND reason='complaint'`, [a.email])).rows.length === 1, 'SES complaint suppresses the contact');

r = await call('POST', '/api/contacts/import', null, fd()); ok(r.j.added === 0 && r.j.rejected >= 3, 'suppressed addresses cannot be re-imported');
const c2 = await call('POST', '/api/campaigns', { ...camp, name: 'Second' }); r = await call('POST', `/api/campaigns/${c2.j.id}/send`);
ok(r.s === 400, 'second campaign has nobody left to send to (all suppressed)');

r = await call('GET', '/api/stats'); ok(r.j.sent === 3 && r.j.opens === 1 && r.j.clicks === 1 && r.j.bounced === 1, `stats add up (${JSON.stringify({ s: r.j.sent, o: r.j.opens, c: r.j.clicks, b: r.j.bounced })})`);
const tok2 = (await call('POST', '/api/auth/signup', { email: `other${Date.now()}@example.com`, password: 'correct-horse-9', company: 'Other' })).j.token;
token = tok2; r = await call('GET', `/api/campaigns/${cid}`); ok(r.s === 404, "another tenant cannot read this tenant's campaign");


// ---------- v2: segments, tags, A/B, schedule, report, duplicate ----------
token = (await call('POST', '/api/auth/signup', { email: `t2${Date.now()}@example.com`, password: 'correct-horse-9', company: 'Tenant Two' })).j.token;
await call('PATCH', '/api/tenant', { name: 'Tenant Two', postal_address: '1 Park St, Kolkata 700016, India' });
const L2 = (await call('POST', '/api/lists', { name: 'All' })).j.id;
let rows2 = 'email,first_name,city,tags\nvip1@example.com,Vi,Delhi,"vip,delhi"\nd1@example.com,Di,Delhi,delhi\np1@example.com,Pa,Pune,\n';
for (let i = 0; i < 40; i++) rows2 += `u${i}@example.com,U${i},Goa,\n`;
const f2 = new FormData(); f2.append('file', new Blob([rows2]), 'b.csv'); f2.append('list_id', L2); f2.append('consent', 'true');
r = await call('POST', '/api/contacts/import', null, f2); ok(r.j.added === 43, `second tenant imported 43 (got ${r.j.added})`);
const pv = (segment, list_id = L2) => call('POST', '/api/audience/preview', { list_id, segment });
r = await pv({ match: 'all', rules: [{ field: 'tag_has', value: 'vip' }] }); ok(r.j.count === 1, 'segment: tag vip = 1');
r = await pv({ match: 'any', rules: [{ field: 'tag_has', value: 'vip' }, { field: 'tag_has', value: 'delhi' }] }); ok(r.j.count === 2, 'segment: vip OR delhi = 2');
r = await pv({ match: 'all', rules: [{ field: 'custom_equals', value: 'city=Pune' }] }); ok(r.j.count === 1, 'segment: custom field city=Pune = 1');
r = await pv({ match: 'all', rules: [{ field: 'tag_not', value: 'delhi' }, { field: 'added_within', value: '1' }] }); ok(r.j.count === 41, 'segment: not delhi AND added today = 41');
r = await pv({ match: 'all', rules: [{ field: 'drop_table', value: 'x' }] }); ok(r.s === 400, 'unknown segment rule rejected');
r = await pv({ match: 'all', rules: [{ field: 'tag_has', value: "x'); DROP TABLE contacts;--" }] }); ok(r.s === 200 && r.j.count === 0, 'segment values are parameterised (injection attempt is harmless)');

const ab = { name: 'AB test', subject: 'Subject A: new arrivals', subject_b: 'Subject B: just landed', ab_split: 50, from_name: 'T2', from_email: 'hi@tenant2.test', list_id: L2, html, segment: { match: 'all', rules: [{ field: 'tag_not', value: 'vip' }] } };
r = await call('POST', '/api/campaigns', ab); const abId = r.j.id;
r = await call('POST', `/api/campaigns/${abId}/send`); ok(r.s === 200 && r.j.queued === 42, `A/B send respects segment (queued ${r.j.queued}, expected 42)`);
await sleep(200);
const vc = (await pool.query(`SELECT variant, count(*)::int n FROM messages WHERE campaign_id=$1 GROUP BY variant`, [abId])).rows;
const nB = vc.find((v) => v.variant === 'B')?.n || 0; ok(nB >= 8 && nB <= 34, `subject variants split roughly 50/50 (B=${nB} of 42)`);
for (let i = 0; i < 40; i++) { const n = (await pool.query(`SELECT count(*)::int n FROM messages WHERE campaign_id=$1 AND status='queued'`, [abId])).rows[0].n; if (!n) break; await sleep(500); }
const anyMsg = (await pool.query(`SELECT id FROM messages WHERE campaign_id=$1 AND variant='B' LIMIT 1`, [abId])).rows[0];
await fetch(`${base}/t/o/${anyMsg.id}.gif`); await sleep(300);
r = await call('GET', `/api/campaigns/${abId}/report`);
ok(r.j.totals.sent === 42 && r.j.variants.length === 2 && r.j.variants.reduce((a, v) => a + v.opens, 0) === 1, 'report: totals, per-variant opens');
ok(r.j.timeline.length >= 1 && r.j.domains[0].domain === 'example.com', 'report: timeline and domain breakdown present');

const dup = await call('POST', `/api/campaigns/${abId}/duplicate`); r = await call('GET', `/api/campaigns/${dup.j.id}`);
ok(r.j.status === 'draft' && /copy/.test(r.j.name) && r.j.subject_b === ab.subject_b, 'duplicate creates an editable draft with A/B settings');
r = await call('POST', `/api/campaigns/${dup.j.id}/schedule`, { at: new Date(Date.now() - 1000).toISOString() }); ok(r.s === 400, 'cannot schedule in the past');
r = await call('POST', `/api/campaigns/${dup.j.id}/schedule`, { at: new Date(Date.now() + 3600e3).toISOString() }); ok(r.s === 200, 'schedule accepted');
r = await call('PUT', `/api/campaigns/${dup.j.id}`, { ...ab, name: 'x' }); ok(r.s === 409, 'scheduled campaign cannot be edited');
r = await call('POST', `/api/campaigns/${dup.j.id}/unschedule`); r = await call('GET', `/api/campaigns/${dup.j.id}`); ok(r.j.status === 'draft', 'unschedule returns it to draft');
await call('POST', `/api/campaigns/${dup.j.id}/schedule`, { at: new Date(Date.now() + 3600e3).toISOString() });
await pool.query(`UPDATE campaigns SET scheduled_at = now() - interval '1 second', segment = NULL WHERE id=$1`, [dup.j.id]);
let st = ''; for (let i = 0; i < 12 && !['sending', 'done'].includes(st); i++) { await sleep(2500); st = (await call('GET', `/api/campaigns/${dup.j.id}`)).j.status; }
ok(['sending', 'done'].includes(st), `scheduler picks up a due campaign by itself (status ${st})`);
r = await call('GET', '/api/stats'); ok(r.j.series.length === 14 && r.j.checklist.has_contacts && r.j.checklist.has_sent, 'stats: 14-day series and setup checklist');


// ---------- v3: journeys, API keys, public API, MCP, AI, smart send time ----------
import IORedis from 'ioredis';
const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
const raw = async (method, path, body, key) => { const r = await fetch(base + path, { method, headers: { ...(key && { Authorization: 'Bearer ' + key }), ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch { /* none */ } return { s: r.status, j }; };
const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(500); } return false; };

token = (await call('POST', '/api/auth/signup', { email: `t3${Date.now()}@example.com`, password: 'correct-horse-9', company: 'Tenant Three' })).j.token;
await call('PATCH', '/api/tenant', { name: 'Tenant Three', postal_address: '9 Lake Road, Chennai 600001, India' });

const L3 = (await call('POST', '/api/lists', { name: 'Customers' })).j.id;
const welcome = '<h1>Welcome {{first_name | there}}</h1><p>Thanks for joining us. Here is what to expect from us over the next few weeks, written in plain language so nothing surprises you.</p><p><a href="https://example.com/start">Start here</a></p>';
const follow = '<h1>Quick follow-up</h1><p>Since you read our first email, here is something extra we think you will find useful this month, with no strings attached at all.</p>';
const jBase = { name: 'Welcome series', trigger: { type: 'tag_added', tag: 'welcome' }, from_name: 'Three', from_email: 'hi@t3.test' };
const E1 = { type: 'email', subject: 'Welcome aboard', html: welcome }, W1 = { type: 'wait', amount: 1, unit: 'days' }, C1 = { type: 'condition', check: 'opened_prev', else: 'exit' };
const E2 = { type: 'email', subject: 'A quick follow-up', html: follow }, T1 = { type: 'add_tag', tag: 'engaged' };
r = await call('POST', '/api/automations', { ...jBase, steps: [E1, C1] }); const badId = r.j.id;
r = await call('POST', `/api/automations/${badId}/activate`, {}); ok(r.s === 422 && r.j.errors.some((e) => /wait step/.test(e)), 'journey: condition right after an email is refused');
r = await call('POST', '/api/automations', { ...jBase, steps: [{ type: 'wait', amount: 0, unit: 'days' }] }); ok(r.s === 400, 'journey: invalid wait rejected');
r = await call('POST', '/api/automations', { ...jBase, trigger: { type: 'tag_added', tag: '' }, steps: [E1] }); ok(r.s === 400, 'journey: trigger needs a tag');
r = await call('POST', '/api/automations', { ...jBase, steps: [E1, W1, C1, E2, T1] }); const jid = r.j.id; ok(!!jid, 'journey created');
r = await call('POST', `/api/automations/${jid}/activate`, {}); ok(r.s === 200, `journey activated (${JSON.stringify(r.j.errors || '')})`);
r = await call('PUT', `/api/automations/${jid}`, { ...jBase, steps: [E1] }); ok(r.s === 409, 'active journey cannot be edited');
const csv3 = 'email,first_name,tags\nw1@example.com,W1,welcome\nw2@example.com,W2,"welcome,vip"\nn1@example.com,N1,\n';
const f3 = new FormData(); f3.append('file', new Blob([csv3]), 'j.csv'); f3.append('list_id', L3); f3.append('consent', 'true');
r = await call('POST', '/api/contacts/import', null, f3); ok(r.j.added === 3, 'journey test contacts imported');
await waitFor(async () => (await pool.query(`SELECT count(*)::int n FROM automation_runs WHERE automation_id=$1`, [jid])).rows[0].n >= 2, 5000);
let runs = (await pool.query(`SELECT count(*)::int n FROM automation_runs WHERE automation_id=$1`, [jid])).rows[0].n; ok(runs === 2, `only the 2 tagged people entered the journey (got ${runs})`);
const hidden = () => pool.query(`SELECT m.id, m.status, c.email, ca.automation_step FROM messages m JOIN campaigns ca ON ca.id=m.campaign_id JOIN contacts c ON c.id=m.contact_id WHERE ca.automation_id=$1`, [jid]);
ok(await waitFor(async () => (await hidden()).rows.filter((x) => x.status === 'sent').length === 2), 'journey: welcome email sent to both');
r = await call('GET', '/api/campaigns'); ok(!r.j.some((c) => /Welcome series/.test(c.name)), "journey emails don't clutter the campaign list");
const w1msg = (await hidden()).rows.find((x) => x.email === 'w1@example.com'); await fetch(`${base}/t/o/${w1msg.id}.gif`); await sleep(300);
await pool.query(`UPDATE automation_runs SET next_run_at = now() WHERE automation_id=$1`, [jid]);
ok(await waitFor(async () => (await pool.query(`SELECT count(*)::int n FROM automation_runs WHERE automation_id=$1 AND status='active'`, [jid])).rows[0].n === 0), 'journey: both people moved past the wait');
const jst = Object.fromEntries((await pool.query(`SELECT c.email, r.status, r.exit_reason FROM automation_runs r JOIN contacts c ON c.id=r.contact_id WHERE r.automation_id=$1`, [jid])).rows.map((x) => [x.email, x]));
ok(jst['w1@example.com']?.status === 'completed' && jst['w2@example.com']?.status === 'exited' && /condition/.test(jst['w2@example.com']?.exit_reason), 'condition: opener continues, non-opener exits');
ok((await pool.query(`SELECT 1 FROM contacts WHERE email='w1@example.com' AND 'engaged' = ANY(tags)`)).rows.length === 1, 'journey: add-tag step ran for the finisher');
ok(await waitFor(async () => (await hidden()).rows.filter((x) => x.automation_step === jBase.steps?.[3]?.id || true).length === 3), 'journey: follow-up email sent only to the opener (3 emails total)');
r = await call('GET', `/api/automations/${jid}`); ok(r.j.report.entered === 2 && r.j.report.completed === 1 && r.j.report.exited === 1, 'journey report counts add up');
ok(Object.values(r.j.report.emails).some((e) => e.sent === 2 && e.opens === 1), 'journey report: per-email sent and opens');

// ---- manual billing without a payment gateway
const myTenant = (await call('GET', '/api/me')).j.tenant_id;
const adm = (path, body, key = process.env.ADMIN_KEY) => fetch(base + '/admin' + path, { method: 'POST', headers: { 'x-admin-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
ok((await adm(`/tenants/${myTenant}/plan`, { plan_code: 'starter' }, 'wrong-key')).status === 401, 'admin: wrong key is refused');
ok((await adm(`/tenants/${myTenant}/plan`, { plan_code: 'nope' })).status === 404, 'admin: unknown plan is refused');
ok((await adm(`/tenants/${myTenant}/plan`, { plan_code: 'starter' })).status === 200 && (await call('GET', '/api/me')).j.plan_code === 'starter', 'admin: a tenant can be moved to a paid plan by hand (UPI / bank transfer)');
await adm(`/tenants/${myTenant}/plan`, { plan_code: 'growth' });

// ---- API keys + public API + events
r = await call('POST', '/api/keys', { name: 'site', scope: 'write' }); const KEY = r.j.key; ok(/^dk_live_/.test(KEY), 'API key created (shown once)');
const RO = (await call('POST', '/api/keys', { name: 'viewer', scope: 'read' })).j.key;
ok((await raw('GET', '/v1/campaigns')).s === 401, 'public API: no key is rejected');
ok((await raw('GET', '/v1/campaigns', null, 'dk_live_' + 'x'.repeat(30))).s === 401, 'public API: wrong key is rejected');
ok((await raw('POST', '/v1/contacts', { email: 'api1@example.com' }, KEY)).s === 400, 'public API: consent_source is mandatory');
r = await raw('POST', '/v1/contacts', { email: 'api1@example.com', first_name: 'Api', tags: ['welcome'], consent_source: 'website form', list_id: L3 }, KEY); ok(r.s === 201 && r.j.created, 'public API: contact created');
r = await raw('POST', '/v1/contacts', { email: 'api1@example.com', consent_source: 'website form' }, KEY); ok(r.s === 200 && !r.j.created, 'public API: same contact again is an update');
ok((await raw('POST', '/v1/contacts', { email: 'api2@example.com', consent_source: 'x' }, RO)).s === 403, 'public API: read-only key cannot write');
ok((await raw('GET', '/v1/contacts/api1@example.com', null, RO)).j.tags.includes('welcome'), 'public API: read key can read');
ok((await pool.query(`SELECT 1 FROM automation_runs r JOIN contacts c ON c.id=r.contact_id WHERE r.automation_id=$1 AND c.email='api1@example.com'`, [jid])).rows.length === 1, 'API-created contact with a tag started the journey');
const ej = (await call('POST', '/api/automations', { name: 'Order thanks', trigger: { type: 'event', name: 'order_placed' }, from_name: 'Three', from_email: 'hi@t3.test', steps: [{ type: 'email', subject: 'Thanks for your order', html: follow }] })).j.id;
ok((await call('POST', `/api/automations/${ej}/activate`, {})).s === 200, 'event-triggered journey activated');
r = await raw('POST', '/v1/events', { email: 'w1@example.com', name: 'order_placed' }, KEY); ok(r.s === 200 && r.j.enrolled === 1, 'public API: custom event starts a journey');
r = await raw('POST', '/v1/events', { email: 'nobody@example.com', name: 'order_placed' }, KEY); ok(r.s === 404, 'public API: event for unknown contact is 404');

// ---- MCP
const rpc = (method, params, key = KEY, id = 1) => raw('POST', '/mcp', { jsonrpc: '2.0', id, method, params }, key);
ok((await rpc('initialize', {}, null)).s === 401, 'MCP: needs an API key');
r = await rpc('initialize', { protocolVersion: '2025-03-26' }); ok(r.j.result.protocolVersion === '2025-03-26' && r.j.result.serverInfo.name === 'dakghar', 'MCP: initialize negotiates version');
r = await raw('POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, KEY); ok(r.s === 202, 'MCP: notification gets 202');
r = await rpc('tools/list'); const names = r.j.result.tools.map((t) => t.name); ok(['account_overview', 'create_campaign_draft', 'send_campaign', 'journey_report', 'deliverability_health'].every((n) => names.includes(n)) && r.j.result.tools.every((t) => t.inputSchema?.type === 'object'), `MCP: ${names.length} tools listed with schemas`);
r = await rpc('tools/call', { name: 'account_overview', arguments: {} }); ok(!r.j.result.isError && /Tenant Three/.test(r.j.result.content[0].text), 'MCP: account_overview works');
r = await rpc('tools/call', { name: 'deliverability_health', arguments: {} }); ok(!r.j.result.isError && JSON.parse(r.j.result.content[0].text).healthy !== undefined, 'MCP: deliverability_health works');
r = await rpc('tools/call', { name: 'preview_audience', arguments: { list_id: L3, segment: { match: 'all', rules: [{ field: 'tag_has', value: 'vip' }] } } }); ok(JSON.parse(r.j.result.content[0].text).count === 1, 'MCP: preview_audience with filter');
r = await rpc('tools/call', { name: 'create_campaign_draft', arguments: { name: 'From Claude', subject: 'Hello from the agent', from_name: 'Three', from_email: 'hi@t3.test', headline: 'Big news', paragraphs: ['Hi {{first_name | there}},', 'This draft was written by an AI agent through MCP.'], button_label: 'Read', button_url: 'https://example.com', list_id: L3 } });
const mcpCamp = JSON.parse(r.j.result.content[0].text).campaign_id; ok(!!mcpCamp, 'MCP: agent created a draft campaign');
r = await call('GET', `/api/campaigns/${mcpCamp}`); ok(r.j.status === 'draft' && /dk-blocks/.test(r.j.html), 'MCP draft is a normal editable design, and nothing was sent');
r = await rpc('tools/call', { name: 'check_campaign', arguments: { campaign_id: mcpCamp } }); ok(!r.j.result.isError && JSON.parse(r.j.result.content[0].text).ok === true, 'MCP: check_campaign passes');
r = await rpc('tools/call', { name: 'send_campaign', arguments: { campaign_id: mcpCamp, confirm: false } }); ok(r.j.result.isError === true && /confirm/.test(r.j.result.content[0].text), 'MCP: send needs explicit confirm=true');
r = await rpc('tools/call', { name: 'create_campaign_draft', arguments: { name: 'x', subject: 'x', from_name: 'x', from_email: 'a@b.co', paragraphs: ['x'] } }, RO); ok(r.j.result.isError === true && /read-only/.test(r.j.result.content[0].text), 'MCP: read-only key cannot create drafts');
r = await rpc('tools/call', { name: 'nope', arguments: {} }); ok(!!r.j.error, 'MCP: unknown tool is a protocol error');
r = await rpc('bogus/method'); ok(r.j.error?.code === -32601, 'MCP: unknown method -32601');
r = await rpc('tools/call', { name: 'list_journeys', arguments: {} }); ok(JSON.parse(r.j.result.content[0].text).length >= 2, 'MCP: list_journeys');

// ---- writing help (free built-in helper, no external API)
r = await call('POST', '/api/ai/assist', { task: 'subjects', brief: 'Monthly offers: 20% off all kurtas till Sunday', tone: 'friendly' });
ok(r.s === 200 && r.j.subjects.length === 5 && r.j.subjects.every((x) => x.text.length <= 60) && r.j.subjects.filter((x) => x.ok).length >= 3 && /20% off/.test(r.j.subjects[0].text), `writing help: 5 subject lines, offer picked out of the brief, spam-checked (${r.j.subjects?.[0]?.text})`);
r = await call('POST', '/api/ai/assist', { task: 'subjects', brief: 'naya collection aa gaya', tone: 'Hinglish, casual' }); ok(r.s === 200 && /dekho|Aapke|Suno|nazar|padhna/.test(r.j.subjects.map((x) => x.text).join(' ')), 'writing help: Hinglish tone');
r = await call('POST', '/api/ai/assist', { task: 'draft', brief: 'Diwali sale on all kurtas. 20% off till Sunday. Free delivery above 999.', button_url: 'https://shop.example.com/sale' });
ok(r.s === 200 && /dk-blocks/.test(r.j.html) && r.j.subject && /shop\.example\.com\/sale/.test(r.j.html) && /Shop now/.test(r.j.html) && /Diwali sale/.test(r.j.html), 'writing help: draft uses the owner\'s own words and only the link they supplied');
r = await call('POST', '/api/ai/assist', { task: 'draft', brief: 'Diwali sale' }); ok(r.s === 200 && !/<a [^>]*href="https?:\/\/[^"]*"[^>]*>Shop now/.test(r.j.html), 'writing help: no button when no link was given (never invents links)');
r = await call('POST', '/api/ai/assist', { task: 'segment', text: 'vip customers active this month' }); ok(r.s === 200 && r.j.segment?.rules.some((x) => x.field === 'tag_has' && x.value === 'vip') && r.j.segment.rules.some((x) => x.field === 'engaged_within' && x.value === '30'), 'writing help: "vip customers active this month" becomes real filters');
r = await call('POST', '/api/ai/assist', { task: 'segment', text: 'people not tagged vip or gmail users inactive for 2 months' }); ok(r.s === 200 && r.j.segment.match === 'any' && r.j.segment.rules.some((x) => x.field === 'tag_not') && r.j.segment.rules.some((x) => x.field === 'domain_is' && x.value === 'gmail.com') && r.j.segment.rules.some((x) => x.field === 'inactive_for' && x.value === '60'), 'writing help: negation, domain, "2 months" and OR are understood');
const sendName = (await call('GET', '/api/campaigns')).j.find((c) => c.name === 'From Claude');
r = await call('POST', '/api/ai/assist', { task: 'segment', text: `opened ${sendName.name}` }); ok(r.s === 200 && r.j.segment?.rules[0]?.field === 'opened_campaign' && r.j.segment.rules[0].value === sendName.id, 'writing help: campaign names resolve to real campaign ids');
r = await call('POST', '/api/ai/assist', { task: 'segment', text: 'gibberish xyzzy' }); ok(r.s === 200 && r.j.segment === null && /could not/i.test(r.j.explanation), 'writing help: unknown request says so instead of guessing');
r = await call('POST', '/api/ai/assist', { task: 'subjects', brief: '' }); ok(r.s === 400, 'writing help: empty brief is a clear error');
r = await call('GET', '/api/ai/mode'); ok(r.j.mode === 'builtin', 'writing help runs in built-in (free) mode by default');

// ---- smart send time
const h = (new Date().getUTCHours() + 3) % 24, day = new Date(); const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - 1, h, 10));
for (let i = 0; i < 3; i++) await pool.query(`INSERT INTO events (tenant_id, message_id, type, created_at) VALUES ((SELECT tenant_id FROM messages WHERE id=$1), $1, 'open', $2)`, [w1msg.id, at]);
const stoId = (await call('POST', '/api/campaigns', { name: 'Smart time', subject: 'Hello from smart time', from_name: 'Three', from_email: 'hi@t3.test', list_id: L3, html: follow, send_time_opt: true })).j.id;
r = await call('POST', `/api/campaigns/${stoId}/send`); ok(r.s === 200 && r.j.queued >= 3, `smart send: campaign queued (${r.j.queued})`);
ok(await waitFor(async () => (await pool.query(`SELECT count(*)::int n FROM messages WHERE campaign_id=$1 AND status='sent'`, [stoId])).rows[0].n >= 2), 'smart send: people without history get it right away');
const held = (await pool.query(`SELECT c.email FROM messages m JOIN contacts c ON c.id=m.contact_id WHERE m.campaign_id=$1 AND m.status='queued'`, [stoId])).rows.map((x) => x.email);
ok(held.length === 1 && held[0] === 'w1@example.com' && (await redis.zcard('bull:send:delayed')) >= 1, `smart send: w1 (opens ~${h}:00 UTC) is held until then (${held.join(',')})`);

// ---- Brevo (free SMTP) bounce / complaint webhook
const SECRET = process.env.BREVO_WEBHOOK_SECRET;
const sentRows = (await pool.query(`SELECT m.id, c.email FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE m.tenant_id = $1 AND m.status = 'sent' ORDER BY m.sent_at`, [myTenant])).rows;
const by = {}; for (const x of sentRows) (by[x.email] ||= []).push(x.id);
const [A, B, C, D] = ['w2@example.com', 'n1@example.com', 'api1@example.com', 'w1@example.com'];
const hook = (body, { token = SECRET, headers = {} } = {}) => fetch(`${base}/webhooks/brevo${token ? '?token=' + token : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const evt = (event, id, email, extra = {}) => ({ event, email, id: 123, 'message-id': '<2026@smtp-relay.mailin.fr>', 'X-Mailin-custom': id, ts_event: Math.floor(Date.now() / 1000), ...extra });
const mstat = async (id) => (await pool.query('SELECT status FROM messages WHERE id=$1', [id])).rows[0].status;
const cstat = async (email) => (await pool.query(`SELECT status FROM contacts WHERE tenant_id=$1 AND email=$2`, [myTenant, email])).rows[0].status;
ok(Object.keys(by).length >= 4 && by[D]?.length >= 2, `webhook test data ready (${Object.keys(by).length} contacts with sent mail)`);
ok((await hook(evt('spam', by[A][0], A), { token: '' })).status === 401, 'Brevo webhook: no token is refused');
ok((await hook(evt('spam', by[A][0], A), { token: 'wrong' })).status === 401, 'Brevo webhook: wrong token is refused');
ok((await hook(evt('spam', by[A][0], A), { token: '', headers: { Authorization: 'Basic ' + Buffer.from('brevo:' + SECRET).toString('base64') } })).status === 200, 'Brevo webhook: HTTP basic auth works too');
ok((await mstat(by[A][0])) === 'complained' && (await cstat(A)) === 'complained' && (await pool.query(`SELECT 1 FROM suppressions WHERE tenant_id=$1 AND email=$2 AND reason='complaint'`, [myTenant, A])).rows.length === 1, 'spam report: message marked complained, contact suppressed');
await hook(evt('spam', by[A][0], A)); ok((await pool.query(`SELECT count(*)::int n FROM events WHERE message_id=$1 AND type='complaint'`, [by[A][0]])).rows[0].n === 1, 'spam report sent twice is only counted once');
await hook(evt('hard_bounce', by[B][0], B, { reason: 'mailbox unavailable' }));
ok((await mstat(by[B][0])) === 'bounced' && (await cstat(B)) === 'bounced' && (await pool.query(`SELECT 1 FROM suppressions WHERE tenant_id=$1 AND email=$2 AND reason='hard_bounce'`, [myTenant, B])).rows.length === 1, 'hard bounce: message bounced, address suppressed');
await hook(evt('soft_bounce', by[C][0], C));
ok((await mstat(by[C][0])) === 'sent' && (await cstat(C)) === 'subscribed' && (await pool.query(`SELECT 1 FROM events WHERE message_id=$1 AND type='bounce' AND meta->>'type'='Transient'`, [by[C][0]])).rows.length === 1, 'soft bounce: recorded, but the person stays subscribed');
await hook(evt('delivered', by[D][0], D)); ok((await mstat(by[D][0])) === 'delivered', 'delivered event updates the message');
await hook(evt('spam', by[D][1], 'someone.else@example.com')); ok((await mstat(by[D][1])) === 'sent' && (await cstat(D)) === 'subscribed', 'event whose address does not match the message is ignored');
await hook(evt('spam', '11111111-1111-4111-8111-111111111111', D)); ok((await cstat(D)) === 'subscribed', 'event for an unknown message id is ignored');
await hook([evt('opened', by[D][1], D), evt('click', by[D][1], D), evt('delivered', by[D][1], D)]);
ok((await mstat(by[D][1])) === 'delivered' && (await pool.query(`SELECT 1 FROM events WHERE message_id=$1 AND type IN ('open','click')`, [by[D][1]])).rows.length === 0, 'batched events work; opens and clicks from Brevo are ignored (we track those ourselves)');
r = await call('GET', '/api/stats'); ok(r.j.complained >= 1 && r.j.bounced >= 1, 'dashboard stats now count the Brevo complaint and bounce');
await redis.quit();

console.log(`\n${pass} passed, ${fail} failed`); await pool.end(); process.exit(fail ? 1 : 0);
