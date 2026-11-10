import { createBuilder, hasDesign, newDesign, TEMPLATES } from '/editor.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('en-IN');
const when = (d) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const whenTime = (d) => d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
const pct = (a, b) => (b ? (100 * a / b) : 0);
const rate = (a, b) => (b ? pct(a, b).toFixed(pct(a, b) >= 10 ? 0 : 1) + '%' : '–');
let token = localStorage.getItem('dk_token');
let me = null;

// ---------- theme ----------
const prefersDark = () => !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
const getTheme = () => localStorage.getItem('dk_theme') || (prefersDark() ? 'dark' : 'light');
const setTheme = (t) => { localStorage.setItem('dk_theme', t); document.documentElement.dataset.theme = t; };
document.documentElement.dataset.theme = getTheme();

// ---------- helpers ----------
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, 4500);
}
async function api(path, { method = 'GET', body, form } = {}) {
  const r = await fetch('/api' + path, {
    method,
    headers: { ...(token && { Authorization: 'Bearer ' + token }), ...(body && { 'Content-Type': 'application/json' }) },
    body: form || (body && JSON.stringify(body)),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { logout(); throw Object.assign(new Error(j.error || 'Please log in again.'), { handled: true }); }
  if (!r.ok) throw Object.assign(new Error(j.error || 'Request failed.'), { data: j, status: r.status });
  return j;
}
const logout = () => { token = null; me = null; localStorage.removeItem('dk_token'); location.hash = ''; render(); };
const busy = async (btn, fn) => {
  if (btn) btn.disabled = true;
  try { await fn(); } catch (e) { if (!e.handled) toast(e.message, true); } finally { if (btn) btn.disabled = false; }
};

let activeModal = null;
function modal(html, cls = '') {
  closeModal();
  const o = document.createElement('div'); o.className = 'overlay';
  o.innerHTML = `<div class="dialog ${cls}" role="dialog" aria-modal="true">${html}</div>`;
  o.addEventListener('mousedown', (e) => { if (e.target === o) closeModal(); });
  document.body.append(o); activeModal = o;
  (o.querySelector('[autofocus]') || o.querySelector('input,button'))?.focus();
  return o;
}
function closeModal() { if (activeModal) { activeModal.remove(); activeModal = null; } }

// ---------- charts (inline SVG) ----------
const niceMax = (m) => { const p = 10 ** Math.floor(Math.log10(Math.max(m, 1))); const f = m / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
function chart({ labels, sent = [], opens = [], clicks = [], height = 210, label }) {
  const n = labels.length; if (!n) return '';
  const W = 720, H = height, L = 40, R = 10, T = 10, B = 26;
  const max = niceMax(Math.max(1, ...sent, ...opens, ...clicks));
  const x = (i) => L + (n === 1 ? (W - L - R) / 2 : i * (W - L - R) / (n - 1));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const bw = Math.max(3, Math.min(26, (W - L - R) / n * 0.6));
  const grid = [0, 1, 2, 3, 4].map((k) => { const v = max * k / 4; return `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${num(v)}</text>`; }).join('');
  const bars = sent.map((v, i) => v ? `<rect class="b-sent" x="${x(i) - bw / 2}" y="${y(v)}" width="${bw}" height="${H - B - y(v)}"><title>${esc(labels[i])}: ${num(v)} sent</title></rect>` : '').join('');
  const line = (arr, cls, name) => arr.some(Boolean) || n === 1 ? `<polyline class="${'l-' + cls}" points="${arr.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>` + arr.map((v, i) => `<circle class="d-${cls}" cx="${x(i)}" cy="${y(v)}" r="3.5"><title>${esc(labels[i])}: ${num(v)} ${name}</title></circle>`).join('') : '';
  const xl = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}">${esc(labels[i])}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>${grid}${bars}${line(opens, 'open', 'opens')}${line(clicks, 'click', 'clicks')}${xl}</svg>
  <div class="legend">${sent.length ? '<span><i style="background:var(--track);border:1px solid var(--line)"></i>Sent</span>' : ''}<span><i style="background:var(--teal)"></i>Opens</span><span><i style="background:var(--amber)"></i>Clicks</span></div>`;
}

// ---------- auth screen ----------
function authView(mode = 'login') {
  $('#app').innerHTML = `<div class="auth"><h1>Dakghar</h1><p class="muted">Send email to people who asked for it, and land in the inbox.</p>
  <div class="panel"><div class="tabs"><button data-mode="login" class="${mode === 'login' ? 'on' : ''}">Log in</button><button data-mode="signup" class="${mode === 'signup' ? 'on' : ''}">Create account</button></div>
  <form data-form="auth" data-mode="${mode}">
    ${mode === 'signup' ? '<label>Company or brand name<input name="company" required autocomplete="organization"></label>' : ''}
    <label>Email<input name="email" type="email" required autocomplete="email"></label>
    <label>Password<input name="password" type="password" required minlength="8" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>
    <button>${mode === 'login' ? 'Log in' : 'Create account'}</button></form></div></div>`;
}

// ---------- shell ----------
const NAV = [['overview', 'Overview'], ['campaigns', 'Campaigns'], ['automations', 'Journeys'], ['contacts', 'Contacts'], ['domains', 'Domains'], ['plan', 'Plan'], ['settings', 'Settings']];
async function shell(route, html) {
  $('#app').innerHTML = `<div class="shell"><nav class="rail" aria-label="Main"><div class="brand">Dakghar</div>
    ${NAV.map(([k, l]) => `<a href="#/${k}" class="${route === k ? 'on' : ''}" ${route === k ? 'aria-current="page"' : ''}>${l}</a>`).join('')}
    <div class="sp"></div><div class="tools"><button class="ghost small" data-act="palette">Search &amp; jump <span class="kbd">Ctrl K</span></button>
    <button class="ghost small" data-act="theme">${getTheme() === 'dark' ? 'Light mode' : 'Dark mode'}</button></div>
    <div class="who">${esc(me.name)}<br>${esc(me.email)}</div><button class="ghost" data-act="logout">Log out</button></nav>
    <main id="main">${html}</main></div>`;
}
const skeleton = () => { const m = $('#main'); if (m) m.innerHTML = '<div class="skeleton" aria-busy="true"><i></i><i></i><i></i></div>'; };

// ---------- overview ----------
function meter(label, value, limit, fmt, hint) {
  const ratio = limit ? value / limit : 0;
  const cls = ratio >= 1 ? 'bad' : ratio >= 0.5 ? 'warn' : '';
  return `<div class="meter"><div><b>${label}</b> <span class="muted">${hint || ''}</span></div>
    <div class="track"><i class="${cls}" style="width:${Math.min(100, ratio * 100)}%"></i></div>
    <div class="lim"><span>${fmt(value)}</span><span>limit ${fmt(limit)}</span></div></div>`;
}
function checklist(c) {
  const steps = [
    [c.has_address, 'Add your business postal address', '#/settings', 'Required in every email footer by anti-spam laws.'],
    [c.has_domain, 'Add your sending domain', '#/domains', 'Use a subdomain such as mail.yourbrand.com.'],
    [c.domain_verified, 'Verify SPF and DKIM', '#/domains', 'Without these, Gmail and Outlook send you to spam.'],
    [c.has_contacts, 'Import people who agreed to hear from you', '#/contacts', 'Upload a CSV with an email column.'],
    [c.has_campaign, 'Create your first campaign', '#/campaigns/new', 'Pick a template and edit it.'],
    [c.has_sent, 'Send it', '#/campaigns', 'Send a test to yourself first.'],
  ];
  const done = steps.filter((s) => s[0]).length;
  if (done === steps.length) return '';
  return `<div class="panel"><h2>Get ready to send <span class="muted" style="font-weight:400">· ${done} of ${steps.length} done</span></h2><div class="progress"><i style="width:${100 * done / steps.length}%"></i></div>
  <ul class="todo">${steps.map(([ok, t, href, d]) => `<li class="${ok ? 'done' : ''}"><span class="tick" aria-hidden="true">${ok ? '✓' : ''}</span><span class="t">${ok ? esc(t) : `<a href="${href}">${esc(t)}</a>`}</span>${ok ? '' : `<span class="muted small">${esc(d)}</span>`}</li>`).join('')}</ul></div>`;
}
async function overview() {
  const [s, camps] = await Promise.all([api('/stats'), api('/campaigns')]);
  const rows = [['Sent', s.sent, 100], ['Delivered', s.delivered, pct(s.delivered, s.sent)], ['Opened', s.opens, pct(s.opens, s.sent)], ['Clicked', s.clicks, pct(s.clicks, s.sent)]];
  const cr = pct(s.complained, s.sent) / 100, br = pct(s.bounced, s.sent) / 100;
  const banner = me.status === 'review' ? `<div class="banner"><b>Your account is under review.</b> You can send up to ${num(me.daily_send_cap)} emails a day until we approve it.</div>`
    : (['suspended', 'paused'].includes(me.status) ? '<div class="banner bad"><b>Sending is switched off for your account.</b> Contact support.</div>' : '');
  const pctFmt = (v) => (v * 100).toFixed(2) + '%';
  const labels = s.series.map((d) => new Date(d.day + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }));
  await shell('overview', `<div class="head"><div><h1>Overview</h1><p class="muted">Last 30 days</p></div><a class="btn" href="#/campaigns/new" style="text-decoration:none">New campaign</a></div>${banner}${checklist(s.checklist)}
  <div class="panel"><h2>What happened to your emails</h2>${s.sent ? `<div class="funnel">${rows.map(([l, v, p]) => `<div class="fr"><span>${l}</span><div class="bar"><i style="width:${Math.max(p, v ? 1 : 0)}%"></i></div><span><b>${num(v)}</b> <span class="muted">${p.toFixed(p === 100 ? 0 : 1)}%</span></span></div>`).join('')}</div>`
    : '<p class="muted">Nothing sent yet. Add contacts, then create your first campaign.</p>'}</div>
  ${s.series.some((d) => d.sent || d.opens || d.clicks) ? `<div class="panel"><h2>Last 14 days</h2>${chart({ labels, sent: s.series.map((d) => d.sent), opens: s.series.map((d) => d.opens), clicks: s.series.map((d) => d.clicks), label: 'Emails sent, opens and clicks per day for the last 14 days' })}</div>` : ''}
  <div class="panel"><h2>Sender health</h2><p class="muted">Gmail and Yahoo start filtering you to spam when complaints pass 0.3%. We pause a campaign at 0.1%.</p>
    <div class="meters">${meter('Spam complaints', cr, s.circuit.complaintRate, pctFmt, 'of sent')}${meter('Bounces', br, s.circuit.bounceRate, pctFmt, 'of sent')}
    ${meter('Sent today', s.day.used, s.day.limit || s.day.used || 1, num, s.day.limit ? '' : '(no daily cap)')}${meter('Sent this month', s.month.used, s.month.limit, num, '')}</div></div>
  <div class="panel"><h2>Recent campaigns</h2>${camps.length ? campaignTable(camps.slice(0, 5)) : '<p class="muted">No campaigns yet.</p>'}</div>`);
}
const statusLabel = (c) => c.status === 'scheduled' ? `scheduled · ${whenTime(c.scheduled_at)}` : c.status.replace('_', ' ');
function campaignTable(camps) {
  return `<div class="tablewrap"><table><thead><tr><th>Campaign</th><th>Status</th><th class="n">Sent</th><th class="n">Opens</th><th class="n">Clicks</th><th class="n">Bounced</th><th></th></tr></thead><tbody>
  ${camps.map((c) => `<tr><td><a href="#/campaigns/${c.id}">${esc(c.name)}</a><br><span class="muted">${esc(c.subject)}</span></td><td><span class="badge ${esc(c.status)}">${esc(statusLabel(c))}</span></td>
  <td class="n">${num(c.sent)}${c.queued ? `<br><span class="muted">${num(c.queued)} waiting</span>` : ''}</td><td class="n">${num(c.opens)}<br><span class="muted">${rate(c.opens, c.sent)}</span></td><td class="n">${num(c.clicks)}<br><span class="muted">${rate(c.clicks, c.sent)}</span></td><td class="n">${num(c.bounced)}</td>
  <td class="n">${c.status === 'sending' ? `<button class="small ghost" data-act="pause" data-id="${c.id}">Pause</button>` : c.status === 'paused' ? `<button class="small" data-act="resume" data-id="${c.id}">Resume</button>` : ''}
  <button class="small ghost" data-act="dupe" data-id="${c.id}" title="Make a copy">Copy</button></td></tr>`).join('')}</tbody></table></div>`;
}

// ---------- campaigns list ----------
async function campaigns() {
  const camps = await api('/campaigns');
  await shell('campaigns', `<div class="head"><div><h1>Campaigns</h1></div><a class="btn" href="#/campaigns/new" style="text-decoration:none">New campaign</a></div>
  <div class="panel">${camps.length ? campaignTable(camps) : '<p>No campaigns yet. Create one to send your first email.</p><a class="btn" href="#/campaigns/new" style="text-decoration:none">Create a campaign</a>'}</div>`);
}

// ---------- campaign report ----------
async function campaignReport(id) {
  const r = await api(`/campaigns/${id}/report`);
  const { campaign: c, totals: t, variants: v, timeline: tl, links, domains: dm } = r;
  const delivered = t.sent - t.bounced;
  const sentOrQueued = t.sent || 0;
  const labels = tl.map((p) => new Date(p.t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric' }));
  const ab = v.length > 1 ? (() => {
    const best = [...v].sort((a, b) => rate2(b) - rate2(a))[0];
    function rate2(x) { return x.sent ? x.opens / x.sent : 0; }
    return `<div class="panel"><h2>Subject line test</h2><div class="tablewrap"><table><thead><tr><th>Version</th><th>Subject</th><th class="n">Sent</th><th class="n">Opens</th><th class="n">Open rate</th><th class="n">Clicks</th></tr></thead><tbody>
      ${v.map((x) => `<tr><td><b>${x.variant}</b></td><td>${esc(x.variant === 'B' ? c.subject_b : c.subject)}</td><td class="n">${num(x.sent)}</td><td class="n">${num(x.opens)}</td><td class="n ${x === best && best.sent > 20 ? 'win' : ''}">${rate(x.opens, x.sent)}${x === best && best.sent > 20 ? ' ▲' : ''}</td><td class="n">${num(x.clicks)}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">${Math.min(...v.map((x) => x.sent)) < 100 ? 'Small groups can mislead. Wait for a few hundred sends per version before you trust the difference.' : 'Use the winning style for your next campaign.'}</p></div>`;
  })() : '';
  const maxClicks = Math.max(1, ...links.map((l) => l.clicks));
  const actions = [
    c.status === 'sending' ? `<button class="ghost" data-act="pause" data-id="${c.id}">Pause</button>` : '',
    c.status === 'paused' ? `<button data-act="resume" data-id="${c.id}">Resume</button>` : '',
    c.status === 'scheduled' ? `<button class="ghost" data-act="unschedule" data-id="${c.id}">Cancel schedule</button>` : '',
    ['sending', 'done'].includes(c.status) ? `<button class="ghost" data-act="send-new" data-id="${c.id}">Send to new contacts</button>` : '',
    `<button class="ghost" data-act="dupe" data-id="${c.id}">Make a copy</button>`,
  ].join('');
  await shell('campaigns', `<div class="head"><div><p class="small"><a href="#/campaigns">← All campaigns</a></p><h1>${esc(c.name)}</h1><p class="muted" style="margin:0">${esc(c.subject)}${c.subject_b ? ` <span class="muted">/ ${esc(c.subject_b)}</span>` : ''}</p>
    <span class="badge ${esc(c.status)}">${esc(statusLabel(c))}</span>${t.queued ? ` <span class="muted small">${num(t.queued)} still sending…</span>` : ''}</div><div class="actions">${actions}</div></div>
  <div class="ribbon"><div><b>${num(t.sent)}</b><span>Sent</span></div><div><b>${num(delivered)}</b><span>Delivered · ${rate(delivered, t.sent)}</span></div><div><b>${num(t.opens)}</b><span>Opened · ${rate(t.opens, t.sent)}</span></div><div><b>${num(t.clicks)}</b><span>Clicked · ${rate(t.clicks, t.sent)}</span></div><div><b>${num(t.unsubs)}</b><span>Unsubscribed</span></div><div class="${t.bounced ? 'bad' : ''}"><b>${num(t.bounced)}</b><span>Bounced · ${rate(t.bounced, t.sent)}</span></div><div class="${t.complained ? 'bad' : ''}"><b>${num(t.complained)}</b><span>Complaints</span></div></div>
  ${timelineOk(tl) ? `<div class="panel"><h2>Activity by hour</h2>${chart({ labels, sent: tl.map((p) => p.sent), opens: tl.map((p) => p.opens), clicks: tl.map((p) => p.clicks), label: 'Sent, opens and clicks per hour for this campaign' })}
    ${r.proxy_opens ? `<p class="muted small" style="margin-top:10px">${num(r.proxy_opens)} opens came through mail-provider image proxies. Open rates are approximate; clicks are the more reliable signal.</p>` : ''}</div>` : (sentOrQueued ? '<div class="panel"><p class="muted">Opens and clicks will appear here as people read the email.</p></div>' : '')}
  ${ab}
  <div class="two"><div class="panel"><h2>Top links</h2>${links.length ? links.map((l) => `<div class="hbar"><div><div class="u" title="${esc(l.url)}">${esc(l.url.replace(/^https?:\/\//, ''))}</div><div class="t"><i style="width:${100 * l.clicks / maxClicks}%"></i></div></div><b class="n">${num(l.clicks)}</b></div>`).join('') : '<p class="muted">No clicks yet.</p>'}</div>
  <div class="panel"><h2>By mailbox provider</h2>${dm.length ? `<table><thead><tr><th>Domain</th><th class="n">Sent</th><th class="n">Opens</th><th class="n">Bounced</th></tr></thead><tbody>${dm.map((d) => `<tr><td>${esc(d.domain)}</td><td class="n">${num(d.sent)}</td><td class="n">${rate(d.opens, d.sent)}</td><td class="n ${d.bounced / d.sent > 0.05 ? 'win' : ''}" style="${d.bounced / d.sent > 0.05 ? 'color:var(--red)' : ''}">${num(d.bounced)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nothing sent yet.</p>'}</div></div>`);
  if (c.status === 'sending' || t.queued) render.refresh = setTimeout(() => { if (location.hash === `#/campaigns/${id}`) render(); }, 5000);
}
const timelineOk = (tl) => tl.length > 0;

// ---------- campaign editor ----------
const SAMPLE_FIELDS = { first_name: 'Asha', last_name: 'Rao', email: 'asha@example.com' };
const personalise = (html) => html.replace(/{{\s*unsubscribe_url\s*}}/gi, '#').replace(/{{\s*postal_address\s*}}/gi, 'Your address').replace(/{{\s*([a-z0-9_]+)\s*(?:\|\s*([^}]*?))?\s*}}/gi, (m, k, d) => SAMPLE_FIELDS[k.toLowerCase()] ?? (d || ''));
const RULE_DEFS = {
  engaged_within: ['Engaged in the last … days', 'number', '30'], inactive_for: ['Not engaged for … days', 'number', '90'], added_within: ['Added in the last … days', 'number', '7'],
  tag_has: ['Has tag', 'text', 'vip'], tag_not: ['Does not have tag', 'text', 'vip'], domain_is: ['Email domain is', 'text', 'gmail.com'],
  custom_equals: ['Field equals', 'text', 'city=Delhi'], custom_contains: ['Field contains', 'text', 'city=del'],
  opened_campaign: ['Opened campaign', 'campaign'], clicked_campaign: ['Clicked in campaign', 'campaign'], not_opened_campaign: ['Got campaign but did not open it', 'campaign'],
};
const SPAMMY = ['free', 'act now', 'winner', 'urgent', 'guaranteed', 'click here', 'buy now', '100%', 'cash', 'limited time'];
function subjectTip(s) {
  s = String(s || '').trim(); if (!s) return ['', ''];
  const lower = s.toLowerCase(), letters = s.replace(/[^a-z]/gi, '');
  if (letters.length > 6 && s.replace(/[^A-Z]/g, '').length / letters.length > 0.6) return ['warn', 'Too many capital letters. It looks like shouting and triggers spam filters.'];
  if ((s.match(/!/g) || []).length > 1) return ['warn', 'Several exclamation marks hurt delivery. Keep one at most.'];
  const hit = SPAMMY.find((w) => lower.includes(w)); if (hit) return ['warn', `"${hit}" often triggers spam filters.`];
  if (s.length > 70) return ['warn', `${s.length} characters. Phones show about 40, so put the key words first.`];
  if (s.length < 15) return ['warn', 'Very short. A little context helps people open it.'];
  return ['ok', `${s.length} characters. Good length.`];
}

const ed = { id: null, status: 'draft', html: '', mode: 'design', builder: null, seg: { match: 'all', rules: [] }, dirty: false, codeDirty: false, camps: [], countTimer: null, autosave: null };

async function campaignEditor(id) {
  const [lists, domains, c, camps] = await Promise.all([api('/lists'), api('/domains'), id === 'new' ? null : api('/campaigns/' + id), api('/campaigns')]);
  const v = c || { name: 'Untitled campaign', subject: '', subject_b: null, ab_split: 50, preheader: '', from_name: me.name, from_email: '', list_id: '', html: newDesign('newsletter'), segment: null, status: 'draft' };
  Object.assign(ed, { id: c ? c.id : null, status: v.status, html: v.html, mode: 'design', builder: null, seg: v.segment ? JSON.parse(JSON.stringify(v.segment)) : { match: 'all', rules: [] }, dirty: false, codeDirty: false, camps: camps.filter((x) => x.id !== (c && c.id)) });
  const abOn = !!v.subject_b;
  await shell('campaigns', `<form id="cform" data-form="campaign" autocomplete="off">
  <div class="sticky-actions"><div><input class="title-input" name="name" value="${esc(v.name)}" aria-label="Campaign name" required> ${c ? `<span class="badge ${esc(v.status)}">${esc(v.status.replace('_', ' '))}</span>` : ''} <span class="muted small" id="dirty"></span></div>
    <div class="actions">${aiButton()}<button type="button" class="ghost" data-act="ed-save">Save</button><button type="button" class="ghost" data-act="ed-test">Send test to me</button><button type="button" data-act="ed-send">Review &amp; send</button></div></div>
  <div class="panel"><div class="step"><b>1</b><h2>Sender</h2></div>
    <div class="row"><label>From name<input name="from_name" value="${esc(v.from_name)}" required></label>
    <label>From email<input name="from_email" type="email" value="${esc(v.from_email)}" required placeholder="news@yourdomain.com" list="doms"></label></div>
    <div class="row"><label>Reply-To (optional)<input name="reply_to" type="email" value="${esc(v.reply_to || '')}" placeholder="you@yourcompany.com"><span class="muted small">Where replies go. Leave empty to use the From email.</span></label></div>
    <datalist id="doms">${domains.map((d) => `<option value="hello@${esc(d.domain)}">`).join('')}</datalist>
    </div><div class="panel"><div class="step"><b>2</b><h2>Subject and preview</h2></div><label>Subject line<input name="subject" value="${esc(v.subject)}" required maxlength="150" placeholder="What is in it for the reader?"></label><div class="tip" id="tip"></div>
    <label style="display:flex;gap:10px;align-items:center;font-weight:400"><input type="checkbox" id="ab" style="width:auto;margin:0" ${abOn ? 'checked' : ''}> Test two subject lines against each other</label>
    <div id="abbox" ${abOn ? '' : 'hidden'} style="margin:10px 0 0"><label>Subject line B<input name="subject_b" value="${esc(v.subject_b || '')}" maxlength="150"></label>
      <label>Version B goes to <b id="splitv">${v.ab_split}</b>% of people<input type="range" name="ab_split" min="10" max="90" step="5" value="${v.ab_split}"></label></div>
    <label>Preview text <span class="muted">(grey text after the subject in the inbox)</span><input name="preheader" value="${esc(v.preheader || '')}" maxlength="200"></label>
    <div class="inbox" id="inbox" aria-label="Inbox preview"></div></div>
  <div class="panel"><div class="step"><b>3</b><h2>Audience</h2></div>
    <div class="row"><label>Send to<select name="list_id"><option value="">All subscribed contacts</option>${lists.map((l) => `<option value="${l.id}" ${v.list_id === l.id ? 'selected' : ''}>${esc(l.name)} (${num(l.subscribers)})</option>`).join('')}</select></label></div>
    <div id="seg"></div><div class="count" id="count" aria-live="polite"></div>
    <label style="display:flex;gap:10px;align-items:flex-start;font-weight:400;margin-top:16px"><input type="checkbox" name="send_time_opt" style="width:auto;margin:4px 0 0" ${v.send_time_opt ? 'checked' : ''}><span><b>Smart send time.</b> Deliver to each person around the hour they usually open email (needs 3 earlier opens; everyone else gets it right away). Delivery can take up to 24 hours.</span></label></div>
  <div class="panel"><div class="step"><b>4</b><h2>Design</h2></div>
    <div class="modes" role="tablist"><button type="button" role="tab" data-act="mode" data-m="design" class="on">Design</button><button type="button" role="tab" data-act="mode" data-m="preview">Preview</button><button type="button" role="tab" data-act="mode" data-m="code">HTML code</button><span class="sp"></span>
      <span class="device" id="device" hidden><button type="button" class="small ghost" data-act="device" data-d="desktop">Desktop</button><button type="button" class="small ghost" data-act="device" data-d="mobile">Phone</button></span></div>
    <div id="m-design"></div>
    <div id="m-preview" hidden><div class="frame-wrap" id="fw"><iframe sandbox title="Email preview"></iframe></div></div>
    <div id="m-code" hidden><label>Raw HTML <span class="muted">Editing here replaces the visual design. Use {{first_name | there}} to personalise.</span><textarea id="code" style="min-height:360px"></textarea></label></div></div></form>`);
  renderSeg(); updateTip(); updateInbox(); refreshCount(true); mountDesign(); setDirty(false);
  clearInterval(ed.autosave);
  ed.autosave = setInterval(() => { if (ed.dirty && ed.id && ['draft', 'preflight_failed'].includes(ed.status) && !activeModal) saveCampaign(true).catch(() => {}); }, 30000);
}
const form = () => $('#cform')?.elements;
const setDirty = (d) => { ed.dirty = d; const e = $('#dirty'); if (e) e.textContent = d ? 'Unsaved changes' : (ed.id ? 'Saved' : ''); };
function collect() {
  const f = form(), ab = $('#ab').checked;
  return { name: f.name.value, subject: f.subject.value, subject_b: ab ? f.subject_b.value : '', ab_split: +f.ab_split.value, preheader: f.preheader.value, from_name: f.from_name.value, from_email: f.from_email.value, reply_to: f.reply_to.value,
    list_id: f.list_id.value || null, segment: ed.seg.rules.length ? ed.seg : null, html: ed.html, send_time_opt: f.send_time_opt.checked };
}
function updateTip() { const f = form(); const [cls, msg] = subjectTip(f.subject.value); const t = $('#tip'); t.className = 'tip ' + cls; t.textContent = msg; }
function updateInbox() {
  const f = form(); const b = $('#ab').checked && f.subject_b.value;
  $('#inbox').innerHTML = `<div class="f">${esc(f.from_name.value || 'Sender')}</div><div class="s"><b>${esc(f.subject.value || 'Your subject line')}</b> <span class="p">– ${esc(f.preheader.value || 'preview text appears here')}</span>${b ? `<br><b>${esc(b)}</b> <span class="p">– version B</span>` : ''}</div>`;
}
function renderSeg() {
  const rules = ed.seg.rules;
  $('#seg').innerHTML = `${rules.length ? `<p class="small" style="margin:6px 0">Send only to people who match <select data-seg-match style="display:inline;width:auto;margin:0 4px"><option value="all" ${ed.seg.match === 'all' ? 'selected' : ''}>all</option><option value="any" ${ed.seg.match === 'any' ? 'selected' : ''}>any</option></select> of these:</p>` : ''}
  ${rules.map((r, i) => { const d = RULE_DEFS[r.field]; return `<div class="seg-row"><select data-seg="field" data-i="${i}" aria-label="Condition">${Object.entries(RULE_DEFS).map(([k, x]) => `<option value="${k}" ${r.field === k ? 'selected' : ''}>${x[0]}</option>`).join('')}</select>
    ${d[1] === 'campaign' ? `<select data-seg="value" data-i="${i}" aria-label="Campaign"><option value="">Choose campaign…</option>${ed.camps.map((x) => `<option value="${x.id}" ${r.value === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : `<input data-seg="value" data-i="${i}" type="${d[1]}" value="${esc(r.value)}" placeholder="${esc(d[2])}" aria-label="Value">`}
    <button type="button" class="ghost danger" data-act="seg-del" data-i="${i}" aria-label="Remove condition">✕</button></div>`; }).join('')}
  <button type="button" class="ghost small" data-act="seg-add">+ Only some people…</button>`;
}
function refreshCount(now) {
  clearTimeout(ed.countTimer);
  ed.countTimer = setTimeout(async () => {
    const el = $('#count'); if (!el) return;
    try {
      const f = form();
      const complete = ed.seg.rules.filter((r) => String(r.value).trim());
      const r = await api('/audience/preview', { method: 'POST', body: { list_id: f.list_id.value || null, segment: complete.length ? { match: ed.seg.match, rules: complete } : null, campaign_id: ed.id && ['sending', 'done'].includes(ed.status) ? ed.id : null } });
      el.innerHTML = `<b>${num(r.count)}</b> <span>${r.count === 1 ? 'person' : 'people'} will receive this</span>${r.sample.length ? `<span class="muted small">e.g. ${r.sample.map(esc).join(', ')}</span>` : ''}`;
    } catch (e) { el.innerHTML = `<span class="muted small">${esc(e.message)}</span>`; }
  }, now ? 0 : 450);
}
function mountDesign() {
  const box = $('#m-design'); if (ed.builder) { ed.builder.destroy(); ed.builder = null; }
  ed.builderReady = false;
  if (hasDesign(ed.html)) {
    ed.builder = createBuilder(box, { html: ed.html, onChange: (h) => { if (ed.html !== h) { ed.html = h; if (ed.builderReady) setDirty(true); } } });
    ed.builderReady = true;
  } else {
    box.innerHTML = `<div class="banner"><b>This email uses custom HTML.</b> You can keep editing it in the HTML code tab, or start a visual design (this replaces the HTML).</div>
      <div class="actions">${Object.entries(TEMPLATES).map(([k, t]) => `<button type="button" class="ghost" data-act="start-design" data-tpl="${k}">Start with “${t.label}”</button>`).join('')}</div>`;
  }
}
function setMode(m) {
  if (m === 'design' && ed.mode === 'code' && ed.codeDirty) {
    if (hasDesign(ed.html) && !confirm('Your HTML edits will be replaced by the visual design. Continue?')) return;
    ed.codeDirty = false;
  }
  if (m === 'design' && ed.mode !== 'design') mountDesign();
  ed.mode = m;
  document.querySelectorAll('[data-act=mode]').forEach((b) => { const on = b.dataset.m === m; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  $('#m-design').hidden = m !== 'design'; $('#m-preview').hidden = m !== 'preview'; $('#m-code').hidden = m !== 'code'; $('#device').hidden = m !== 'preview';
  if (m === 'preview') $('#fw iframe').srcdoc = personalise(ed.html);
  if (m === 'code') $('#code').value = ed.html;
}
async function saveCampaign(quiet) {
  const body = collect();
  if (ed.id) await api('/campaigns/' + ed.id, { method: 'PUT', body });
  else { const r = await api('/campaigns', { method: 'POST', body }); ed.id = r.id; history.replaceState(null, '', '#/campaigns/' + r.id); }
  ed.status = 'draft'; setDirty(false); if (!quiet) toast('Saved.');
  return ed.id;
}
const issueList = (a, cls) => (a.length ? `<ul class="issues ${cls}">${a.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
async function reviewAndSend(btn) {
  await busy(btn, async () => {
    const id = await saveCampaign(true); const body = collect();
    const [pf, aud] = await Promise.all([api(`/campaigns/${id}/preflight`, { method: 'POST' }), api('/audience/preview', { method: 'POST', body: { list_id: body.list_id, segment: body.segment, campaign_id: null } })]);
    const blocked = pf.errors.length || !aud.count;
    const cap = me.status === 'review' ? `<p class="small muted">Your account is under review, so at most ${num(me.daily_send_cap)} emails go out per day.</p>` : '';
    modal(`<h2>${blocked ? 'Fix a few things first' : `Send to ${num(aud.count)} ${aud.count === 1 ? 'person' : 'people'}?`}</h2>
      <dl class="sumline"><dt>From</dt><dd>${esc(body.from_name)} &lt;${esc(body.from_email)}&gt;</dd><dt>Subject</dt><dd>${esc(body.subject)}${body.subject_b ? `<br>${esc(body.subject_b)} <span class="muted">(version B, ${body.ab_split}%)</span>` : ''}</dd>
      <dt>Audience</dt><dd>${num(aud.count)} ${body.segment ? 'matching your conditions' : 'subscribed contacts'}</dd><dt>Spam score</dt><dd>${pf.score}/10 ${pf.score < 3 ? '· looks safe' : ''}</dd></dl>
      ${!aud.count ? '<ul class="issues err"><li>Nobody matches this audience yet.</li></ul>' : ''}${issueList(pf.errors, 'err')}${issueList(pf.warnings, 'warn')}${cap}
      ${blocked ? '<div class="actions"><button data-act="close">Back to editing</button></div>' : `<label style="margin-top:14px">Or schedule it for later<input type="datetime-local" id="when"></label>
      <div class="actions"><button class="ghost" data-act="close">Cancel</button><button class="ghost" data-act="do-schedule" data-id="${id}">Schedule</button><button data-act="do-send" data-id="${id}" autofocus>Send now</button></div>`}`);
  });
}

// ---------- contacts ----------
let cstate = { page: 1, status: '', q: '' };
async function contacts() {
  const qs = new URLSearchParams({ page: cstate.page, status: cstate.status, q: cstate.q });
  const [data, lists] = await Promise.all([api('/contacts?' + qs), api('/lists')]);
  await shell('contacts', `<div class="head"><div><h1>Contacts</h1><p class="muted">${num(data.total)} ${cstate.status || 'total'}</p></div></div>
  <div class="panel"><h2>Import from CSV</h2><p class="muted">Your file needs an <code>email</code> column. <code>first_name</code>, <code>last_name</code>, <code>tags</code> (comma separated) and any other columns are kept for personalisation and filtering. Invalid, disposable and previously unsubscribed addresses are skipped.</p>
  <form data-form="import"><div class="row"><label>CSV file<input type="file" name="file" accept=".csv,text/csv" required></label>
  <label>Add to list<select name="list_id"><option value="">No list</option>${lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label></div>
  <label style="display:flex;gap:10px;align-items:flex-start"><input type="checkbox" name="consent" value="true" style="width:auto;margin-top:5px" required><span>These people agreed to receive email from me. I can show when and how they agreed.</span></label>
  <button>Import contacts</button><div id="imp" style="margin-top:12px"></div></form></div>
  <div class="panel"><h2>Tag a group</h2><p class="muted">Add a tag to everyone on a list. Tags can start journeys and drive filters.</p><form data-form="tagaud" class="actions"><select name="list_id" style="max-width:220px;margin:0"><option value="">All subscribed contacts</option>${lists.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select><input name="tag" placeholder="tag, e.g. vip" required style="max-width:200px;margin:0"><button class="ghost">Add tag</button></form></div>
  <div class="panel"><h2>Lists</h2>${lists.length ? `<div class="tablewrap"><table><thead><tr><th>List</th><th class="n">Subscribers</th><th>Public signup page (asks to confirm by email)</th></tr></thead><tbody>${lists.map((l) => `<tr><td>${esc(l.name)}</td><td class="n">${num(l.subscribers)}</td><td><code>${esc(l.subscribe_url)}</code></td></tr>`).join('')}</tbody></table></div>` : ''}
  <form data-form="list" class="actions" style="margin-top:12px"><input name="name" placeholder="New list name, e.g. Newsletter" required style="max-width:300px;margin:0"><button class="ghost">Create list</button></form></div>
  <div class="panel"><form data-form="cfilter" class="actions" style="margin-bottom:12px"><input name="q" value="${esc(cstate.q)}" placeholder="Search email or name" style="max-width:260px;margin:0">
  <select name="status" style="max-width:180px;margin:0"><option value="">Any status</option>${['subscribed', 'pending', 'unsubscribed', 'bounced', 'complained'].map((s) => `<option ${cstate.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select><button class="ghost">Filter</button></form>
  ${data.rows.length ? `<div class="tablewrap"><table><thead><tr><th>Email</th><th>Name</th><th>Tags</th><th>Status</th><th>Added</th><th></th></tr></thead><tbody>${data.rows.map((r) => `<tr><td>${esc(r.email)}${r.verification === 'risky' ? ' <span class="muted">(role address)</span>' : ''}</td><td>${esc([r.first_name, r.last_name].filter(Boolean).join(' '))}</td><td>${(r.tags || []).map((t) => `<span class="badge">${esc(t)}</span>`).join(' ')}</td><td><span class="badge ${esc(r.status)}">${esc(r.status)}</span></td><td>${when(r.created_at)}</td><td class="n"><button class="small danger" data-act="delcontact" data-id="${r.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>
  <div class="actions" style="margin-top:12px"><button class="ghost small" data-act="cpage" data-p="${cstate.page - 1}" ${cstate.page < 2 ? 'disabled' : ''}>Previous</button><span class="muted">Page ${data.page} of ${Math.max(1, Math.ceil(data.total / data.size))}</span><button class="ghost small" data-act="cpage" data-p="${cstate.page + 1}" ${data.page * data.size >= data.total ? 'disabled' : ''}>Next</button></div>` : '<p class="muted">No contacts match. Import a CSV above.</p>'}</div>`);
}

// ---------- domains ----------
async function domains() {
  const ds = await api('/domains');
  const yn = (b) => `<span class="badge ${b ? 'ok' : 'no'}">${b ? 'found' : 'missing'}</span>`;
  await shell('domains', `<div class="head"><div><h1>Sending domains</h1><p class="muted">Gmail, Outlook and Yahoo check these records. Without them your email goes to spam.</p></div></div>
  <div class="panel">${ds.length ? `<div class="tablewrap"><table><thead><tr><th>Domain</th><th>SPF</th><th>DKIM</th><th>DMARC</th><th>DKIM selector</th><th></th></tr></thead><tbody>${ds.map((d) => `<tr><td><b>${esc(d.domain)}</b><br>${d.verified_at ? '<span class="badge ok">verified</span>' : '<span class="badge pending">not verified</span>'}</td><td>${yn(d.spf_ok)}</td><td>${yn(d.dkim_ok)}</td><td>${yn(d.dmarc_ok)}</td>
  <td><input id="sel-${d.id}" value="${esc(d.dkim_selector || '')}" placeholder="e.g. selector1" style="margin:0;max-width:160px" aria-label="DKIM selector"></td>
  <td class="n"><button class="small" data-act="dnscheck" data-id="${d.id}">Check DNS</button> <button class="small danger" data-act="deldomain" data-id="${d.id}">Remove</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No domains yet.</p>'}
  <form data-form="domain" class="actions" style="margin-top:14px"><input name="domain" placeholder="mail.yourbrand.com" required style="max-width:280px;margin:0"><button>Add domain</button></form></div>
  <div class="panel"><h2>DNS records to add</h2><p>Add these at your domain provider (replace <code>yourbrand.com</code>), wait a few minutes, then press Check DNS.</p>
  <p><b>SPF</b> (TXT on the domain): <code>v=spf1 include:amazonses.com ~all</code></p>
  <p><b>DKIM</b>: your email provider gives you a selector and key. With Amazon SES these are three CNAME records. Type the selector name in the box above.</p>
  <p><b>DMARC</b> (TXT on <code>_dmarc.yourbrand.com</code>): <code>v=DMARC1; p=none; rua=mailto:dmarc@yourbrand.com</code>. Move to <code>p=quarantine</code> after a few weeks of clean reports.</p>
  <p class="muted">Use a subdomain like <code>mail.yourbrand.com</code> for marketing so your main domain's reputation stays safe.</p></div>`);
}

// ---------- plan & settings ----------
async function plan() {
  const [plans, s] = await Promise.all([api('/plans'), api('/stats')]);
  await shell('plan', `<div class="head"><div><h1>Plan</h1><p class="muted">You have used ${num(s.month.used)} of ${num(s.month.limit)} emails this month.</p></div></div>
  <div class="plans">${plans.map((p) => `<div class="plan ${p.code === me.plan_code ? 'cur' : ''}"><b>${esc(p.name)}</b><div class="price">${p.price_inr ? '₹' + num(p.price_inr) : 'Free'}<span class="muted" style="font-size:.9rem;font-weight:400">${p.price_inr ? ' /month' : ''}</span></div>
  <p>${num(p.monthly_emails)} emails a month<br>${num(p.max_contacts)} contacts<br>${num(p.max_domains)} sending domain${p.max_domains > 1 ? 's' : ''}<br>${p.features.automation ? 'Journeys<br>' : ''}</p>
  ${p.code === me.plan_code ? '<span class="badge ok">Current plan</span>' : `<button data-act="subscribe" data-code="${p.code}">${p.price_inr ? 'Choose ' + esc(p.name) : 'Switch to Free'}</button>`}</div>`).join('')}</div>`);
}
// ---------- AI help ----------
const aiButton = () => '<button type="button" class="ghost" data-act="ai-open">✨ Writing help</button>';
const ai = { tab: 'subjects', busy: false, subjects: null, draft: null, segment: null, err: '' };
function aiRender() {
  const d = $('.dialog.ai'); if (!d) return;
  const tabs = [['subjects', 'Subject ideas'], ['draft', 'Write the email'], ['segment', 'Find my audience']];
  const f = form();
  d.innerHTML = `<h2>✨ Writing help</h2><p class="muted small" style="margin:-6px 0 10px">${me.ai_mode === 'model' ? 'Using your connected model.' : 'Built-in helper: free, works offline, and uses only what you type. It organises your words rather than inventing new ones.'}</p><div class="modes">${tabs.map(([k, l]) => `<button type="button" data-act="ai-tab" data-t="${k}" class="${ai.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
  ${ai.err ? `<div class="banner bad">${esc(ai.err)}</div>` : ''}
  ${ai.tab === 'subjects' ? `<label>What is this email about?<textarea id="ai-brief" rows="3" style="min-height:70px;font:inherit">${esc(ai.brief ?? (f.name.value + (f.subject.value ? '. ' + f.subject.value : '')))}</textarea></label>
     <label>Tone<select id="ai-tone">${['friendly', 'professional', 'playful', 'urgent but honest', 'Hinglish, casual'].map((t) => `<option>${t}</option>`).join('')}</select></label>
     <button type="button" data-act="ai-go" ${ai.busy ? 'disabled' : ''}>${ai.busy ? 'Thinking…' : 'Suggest subject lines'}</button>
     ${ai.subjects ? `<ul class="ai-list">${ai.subjects.map((x, i) => `<li><div><b>${esc(x.text)}</b>${x.ok ? '' : `<br><span class="muted small">⚠ ${esc(x.note || 'May trigger spam filters')}</span>`}</div><div class="actions"><button type="button" class="small ghost" data-act="ai-subj" data-i="${i}" data-ab="a">Use</button><button type="button" class="small ghost" data-act="ai-subj" data-i="${i}" data-ab="b">Use as B</button></div></li>`).join('')}</ul>` : ''}` : ''}
  ${ai.tab === 'draft' ? `<label>Describe the email<textarea id="ai-brief" rows="4" style="min-height:90px;font:inherit" placeholder="e.g. Diwali sale on all kurtas, 20% off till Sunday, free delivery above ₹999">${esc(ai.brief ?? '')}</textarea></label>
     <div class="row"><label>Tone<select id="ai-tone">${['friendly', 'professional', 'playful', 'Hinglish, casual'].map((t) => `<option>${t}</option>`).join('')}</select></label><label>Button link (optional)<input id="ai-url" placeholder="https://yourshop.com/sale" value="${esc(ai.url || '')}"></label></div>
     <button type="button" data-act="ai-go" ${ai.busy ? 'disabled' : ''}>${ai.busy ? 'Writing…' : 'Write a draft'}</button>
     ${ai.draft ? `<div class="panel" style="margin-top:14px"><b>${esc(ai.draft.subject)}</b><br><span class="muted">${esc(ai.draft.preheader)}</span><p class="small muted" style="margin:8px 0 0">The design is ready. Applying replaces your current email design, subject and preview text.</p><div class="actions" style="margin-top:10px"><button type="button" data-act="ai-apply-draft">Use this draft</button></div></div>` : ''}` : ''}
  ${ai.tab === 'segment' ? `<label>Who should get it?<textarea id="ai-brief" rows="3" style="min-height:70px;font:inherit" placeholder="e.g. people tagged vip who opened something in the last month">${esc(ai.brief ?? '')}</textarea></label>
     <button type="button" data-act="ai-go" ${ai.busy ? 'disabled' : ''}>${ai.busy ? 'Thinking…' : 'Build the filter'}</button>
     ${ai.segment ? `<div class="panel" style="margin-top:14px"><p style="margin:0 0 6px">${esc(ai.segment.explanation || '')}</p>${ai.segment.segment ? `<ul class="issues">${ai.segment.segment.rules.map((r) => `<li>${esc(RULE_DEFS[r.field]?.[0] || r.field)}: <b>${esc(r.value)}</b></li>`).join('')}</ul><p class="small muted" style="margin:0">Match ${ai.segment.segment.match === 'any' ? 'any' : 'all'} of these.</p><div class="actions" style="margin-top:10px"><button type="button" data-act="ai-apply-seg">Apply filter</button></div>` : '<p class="muted">That cannot be expressed with the available filters.</p>'}</div>` : ''}` : ''}
  <div class="actions"><button type="button" class="ghost" data-act="close">Close</button></div>`;
}
async function aiGo() {
  ai.err = ''; ai.busy = true; const brief = $('#ai-brief')?.value || ''; ai.brief = brief; const tone = $('#ai-tone')?.value;
  if ($('#ai-url')) ai.url = $('#ai-url').value;
  aiRender();
  try {
    if (ai.tab === 'subjects') ai.subjects = (await api('/ai/assist', { method: 'POST', body: { task: 'subjects', brief, tone } })).subjects;
    if (ai.tab === 'draft') ai.draft = await api('/ai/assist', { method: 'POST', body: { task: 'draft', brief, tone, button_url: ai.url } });
    if (ai.tab === 'segment') ai.segment = await api('/ai/assist', { method: 'POST', body: { task: 'segment', text: brief } });
  } catch (e) { ai.err = e.message; }
  ai.busy = false; aiRender();
}

// ---------- journeys ----------
const TRIGGERS = { subscribed: 'Someone subscribes', list_joined: 'Someone joins a list', tag_added: 'Someone gets a tag', link_clicked: 'Someone clicks a link in a campaign', event: 'Your website or app sends an event' };
const STEP_TYPES = { email: ['✉', 'Send an email'], wait: ['⏱', 'Wait'], condition: ['⑂', 'Only continue if…'], add_tag: ['#', 'Add a tag'], remove_tag: ['#', 'Remove a tag'] };
const sid = () => (Math.random().toString(36) + '00000000').slice(2, 10);
const mkStep = (type, extra = {}) => ({ id: sid(), type, ...({ email: { subject: '', preheader: '', html: newDesign('announcement') }, wait: { amount: 2, unit: 'days' }, condition: { check: 'opened_prev', else: 'exit' }, add_tag: { tag: '' }, remove_tag: { tag: '' } }[type]), ...extra });
const JTEMPLATES = {
  welcome: ['Welcome series', 'Greet new subscribers and follow up two days later.', { type: 'subscribed' }, () => [mkStep('email', { subject: 'Welcome! Here is what to expect' }), mkStep('wait', { amount: 2, unit: 'days' }), mkStep('email', { subject: 'Three ways to get started' })]],
  nurture: ['Follow up only if they opened', 'Send once, wait, and only follow up with people who opened.', { type: 'tag_added', tag: 'lead' }, () => [mkStep('email', { subject: 'A quick hello' }), mkStep('wait', { amount: 3, unit: 'days' }), mkStep('condition', { check: 'opened_prev', else: 'exit' }), mkStep('email', { subject: 'Thought you might like this' }), mkStep('add_tag', { tag: 'engaged' })]],
  order: ['Order thank-you', 'Starts when your shop sends an "order_placed" event.', { type: 'event', name: 'order_placed' }, () => [mkStep('email', { subject: 'Thank you for your order' }), mkStep('wait', { amount: 7, unit: 'days' }), mkStep('email', { subject: 'How is everything going?' })]],
};
const triggerText = (t, lists = [], camps = []) => ({ subscribed: 'Someone subscribes', list_joined: `Joins ${lists.find((l) => l.id === t.list_id)?.name || 'a list'}`, tag_added: `Gets tag “${t.tag}”`, link_clicked: t.campaign_id ? `Clicks in ${camps.find((c) => c.id === t.campaign_id)?.name || 'a campaign'}` : 'Clicks any campaign link', event: `Event “${t.name}”` }[t.type] || t.type);
const jr = { id: null, a: null, report: null, status: 'draft', dirty: false, template: null, lists: [], camps: [], tmpHtml: '', builder: null };

async function journeysList() {
  const [list, lists] = await Promise.all([api('/automations'), api('/lists').catch(() => [])]);
  await shell('automations', `<div class="head"><div><h1>Journeys</h1><p class="muted">Automatic emails that send themselves when something happens.</p></div><a class="btn" href="#/automations/new" style="text-decoration:none">New journey</a></div>
  ${list.length ? `<div class="panel"><div class="tablewrap"><table><thead><tr><th>Journey</th><th>Starts when</th><th>Status</th><th class="n">Steps</th><th class="n">Entered</th><th class="n">In progress</th><th class="n">Finished</th><th></th></tr></thead><tbody>${list.map((a) => `<tr><td><a href="#/automations/${a.id}">${esc(a.name)}</a></td><td>${esc(triggerText(a.trigger_cfg, lists))}</td><td><span class="badge ${a.status === 'active' ? 'active' : a.status === 'paused' ? 'paused' : ''}">${a.status === 'active' ? 'on' : a.status}</span></td><td class="n">${a.step_count}</td><td class="n">${num(a.entered)}</td><td class="n">${num(a.active)}</td><td class="n">${num(a.completed)}</td><td class="n">${a.status === 'active' ? `<button class="small ghost" data-act="j-pause-list" data-id="${a.id}">Pause</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
  <div class="panel"><h2>${list.length ? 'Start from a template' : 'Build your first journey'}</h2><p class="muted">Pick one and change anything. Nothing sends until you turn it on.</p>
  <div class="plans">${Object.entries(JTEMPLATES).map(([k, t]) => `<div class="plan"><b>${esc(t[0])}</b><p class="muted small">${esc(t[1])}</p><button class="ghost" data-act="j-template" data-k="${k}">Use this</button></div>`).join('')}</div></div>`);
}

async function journeyEditor(id) {
  const [lists, camps, a] = await Promise.all([api('/lists'), api('/campaigns'), id === 'new' ? null : api('/automations/' + id)]);
  const t = jr.template && id === 'new' ? JTEMPLATES[jr.template] : null; jr.template = null;
  Object.assign(jr, { id: a ? a.id : null, status: a ? a.status : 'draft', report: a ? a.report : null, dirty: false, lists, camps,
    a: a ? { name: a.name, trigger: a.trigger_cfg, from_name: a.from_name || me.name, from_email: a.from_email || '', reply_to: a.reply_to || '', steps: a.steps } : { name: t ? t[0] : 'New journey', trigger: t ? { ...t[2] } : { type: 'subscribed' }, from_name: me.name, from_email: '', reply_to: '', steps: t ? t[3]() : [] } });
  await drawJourney();
  if (jr.status === 'active') render.refresh = setTimeout(() => { if (location.hash === `#/automations/${jr.id}`) render(); }, 8000);
}
function triggerFields() {
  const t = jr.a.trigger;
  return `<div class="row"><label>Starts when<select data-trig="type">${Object.entries(TRIGGERS).map(([k, l]) => `<option value="${k}" ${t.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  ${t.type === 'list_joined' ? `<label>Which list<select data-trig="list_id"><option value="">Choose…</option>${jr.lists.map((l) => `<option value="${l.id}" ${t.list_id === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>` : ''}
  ${t.type === 'tag_added' ? `<label>Tag<input data-trig="tag" value="${esc(t.tag || '')}" placeholder="e.g. welcome"></label>` : ''}
  ${t.type === 'link_clicked' ? `<label>In which campaign<select data-trig="campaign_id"><option value="">Any campaign</option>${jr.camps.map((c) => `<option value="${c.id}" ${t.campaign_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>` : ''}
  ${t.type === 'event' ? `<label>Event name<input data-trig="name" value="${esc(t.name || '')}" placeholder="order_placed"></label>` : ''}</div>
  <p class="muted small" style="margin:0 0 12px">${t.type === 'event' ? 'Send it from your site with POST /v1/events (see Settings, API keys). ' : ''}Each person goes through a journey once.</p>`;
}
function stepCard(s, i, locked) {
  const r = jr.report, [ic, label] = STEP_TYPES[s.type]; let stats = '';
  if (r) {
    const e = s.type === 'email' && r.emails[s.id];
    if (e) stats += `<div class="small muted">Sent ${num(e.sent)} · opened ${rate(e.opens, e.sent)} · clicked ${rate(e.clicks, e.sent)}</div>`;
    const w = s.type === 'wait' ? r.waiting[i + 1] : r.waiting[i];
    if (w) stats += `<div class="small"><b>${num(w)}</b> ${s.type === 'wait' ? 'waiting here' : 'about to run this step'}</div>`;
  }
  const inp = (k, v, ph) => `<input data-step="${i}" data-k="${k}" value="${esc(v ?? '')}" placeholder="${esc(ph || '')}">`;
  const sel = (k, v, opts) => `<select data-step="${i}" data-k="${k}">${opts.map(([val, l]) => `<option value="${val}" ${v === val ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  let body = '';
  if (s.type === 'email') body = `<label>Subject<input data-step="${i}" data-k="subject" value="${esc(s.subject)}" maxlength="150" placeholder="Subject line"></label><label>Preview text<input data-step="${i}" data-k="preheader" value="${esc(s.preheader || '')}" maxlength="200"></label><button type="button" class="ghost small" data-act="j-design" data-i="${i}">Design the email</button>`;
  if (s.type === 'wait') body = `<div class="row" style="grid-template-columns:100px 140px"><label>For<input data-step="${i}" data-k="amount" data-num="1" type="number" min="1" max="365" value="${esc(s.amount)}"></label><label>&nbsp;${sel('unit', s.unit, [['minutes', 'minutes'], ['hours', 'hours'], ['days', 'days']])}</label></div>`;
  if (s.type === 'condition') body = `<div class="row"><label>Continue only if${sel('check', s.check, [['opened_prev', 'they opened the last email'], ['clicked_prev', 'they clicked the last email'], ['has_tag', 'they have a tag'], ['not_has_tag', 'they do not have a tag']])}</label>
    ${s.check.includes('tag') ? `<label>Tag${inp('tag', s.tag, 'e.g. vip')}</label>` : ''}<label>Otherwise${sel('else', s.else, [['exit', 'leave the journey'], ['skip', 'skip the next step']])}</label></div>`;
  if (s.type === 'add_tag' || s.type === 'remove_tag') body = `<label>Tag${inp('tag', s.tag, 'e.g. engaged')}</label>`;
  return `<li class="stepcard ${s.type}"><span class="bub" aria-hidden="true">${ic}</span><div class="sc-body"><div class="sc-head"><b>${i + 1}. ${label}</b>${locked ? '' : `<span class="actions"><button type="button" class="small ghost" data-act="j-up" data-i="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="small ghost" data-act="j-down" data-i="${i}" aria-label="Move down" ${i === jr.a.steps.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="small danger" data-act="j-del" data-i="${i}" aria-label="Remove step">✕</button></span>`}</div>${body}${stats}</div></li>`;
}
function stepsHtml() {
  const locked = jr.status === 'active';
  return `${jr.a.steps.length ? `<ol class="timeline">${jr.a.steps.map((s, i) => stepCard(s, i, locked)).join('')}</ol>` : '<p class="muted">No steps yet. Add the first one below.</p>'}
  ${locked ? '' : `<div class="actions" style="margin-top:12px">${Object.entries(STEP_TYPES).map(([k, [, l]]) => `<button type="button" class="ghost small" data-act="j-add" data-t="${k}">+ ${l.replace('…', '')}</button>`).join('')}</div>`}`;
}
async function drawJourney() {
  const a = jr.a, locked = jr.status === 'active', r = jr.report;
  await shell('automations', `<div id="jform"><div class="sticky-actions"><div><input class="title-input" data-jname value="${esc(a.name)}" aria-label="Journey name" ${locked ? 'disabled' : ''}> ${jr.id ? `<span class="badge ${jr.status === 'active' ? 'active' : jr.status === 'paused' ? 'paused' : ''}">${jr.status === 'active' ? 'on' : jr.status}</span>` : ''} <span class="muted small" id="jdirty"></span></div>
    <div class="actions">${locked ? '<button type="button" class="ghost" data-act="j-pause">Pause to edit</button>' : '<button type="button" class="ghost" data-act="j-save">Save</button><button type="button" data-act="j-on">Turn on</button>'}</div></div>
    <p class="small"><a href="#/automations">← All journeys</a></p>
    ${locked ? '<div class="banner"><b>This journey is on.</b> Pause it to change steps. People already inside keep their place.</div>' : ''}
    ${r && r.entered ? `<div class="ribbon"><div><b>${num(r.entered)}</b><span>Entered</span></div><div><b>${num(r.active)}</b><span>In progress</span></div><div><b>${num(r.completed)}</b><span>Finished</span></div><div><b>${num(r.exited)}</b><span>Left early (unsubscribed or condition)</span></div></div>` : ''}
    <fieldset ${locked ? 'disabled' : ''} style="border:0;padding:0;margin:0;min-width:0"><div class="panel"><div class="step"><b>1</b><h2>What starts it</h2></div><div id="jtrig">${triggerFields()}</div>
    <div class="row"><label>From name<input data-jf="from_name" value="${esc(a.from_name || '')}"></label><label>From email<input data-jf="from_email" type="email" value="${esc(a.from_email || '')}" placeholder="hello@yourdomain.com"></label></div>
    <div class="row"><label>Reply-To (optional)<input data-jf="reply_to" type="email" value="${esc(a.reply_to || '')}" placeholder="you@yourcompany.com"></label></div></div>
    <div class="panel"><div class="step"><b>2</b><h2>What happens</h2></div><div id="jsteps">${stepsHtml()}</div></div></fieldset></div>`);
}
const jdirty = (d = true) => { jr.dirty = d; const e = $('#jdirty'); if (e) e.textContent = d ? 'Unsaved changes' : (jr.id ? 'Saved' : ''); };
const redrawSteps = () => { const e = $('#jsteps'); if (e) e.innerHTML = stepsHtml(); };
async function saveJourney(quiet) {
  const body = { name: $('[data-jname]').value, trigger: jr.a.trigger, from_name: jr.a.from_name, from_email: jr.a.from_email, reply_to: jr.a.reply_to, steps: jr.a.steps };
  if (jr.id) await api('/automations/' + jr.id, { method: 'PUT', body });
  else { const r = await api('/automations', { method: 'POST', body }); jr.id = r.id; history.replaceState(null, '', '#/automations/' + r.id); }
  jr.a.name = body.name; jdirty(false); if (!quiet) toast('Saved.'); return jr.id;
}
async function turnOn(btn) {
  await busy(btn, async () => {
    const id = await saveJourney(true);
    const v = await api(`/automations/${id}/check`, { method: 'POST' });
    const backfill = ['subscribed', 'list_joined', 'tag_added'].includes(jr.a.trigger.type);
    modal(`<h2>${v.errors.length ? 'Fix a few things first' : 'Turn this journey on?'}</h2>${issueList(v.errors, 'err')}${issueList(v.warnings, 'warn')}
      ${v.errors.length ? '<div class="actions"><button data-act="close">Back to editing</button></div>' : `<p>New people will enter when: <b>${esc(triggerText(jr.a.trigger, jr.lists, jr.camps))}</b>.</p>
      ${backfill ? '<label style="display:flex;gap:10px;align-items:flex-start;font-weight:400"><input type="checkbox" id="backfill" style="width:auto;margin-top:4px"><span>Also start it now for people who already match. They will get the first email right away.</span></label>' : ''}
      <div class="actions"><button class="ghost" data-act="close">Cancel</button><button data-act="j-confirm-on" data-id="${id}" autofocus>Turn on</button></div>`}`);
  });
}

// ---------- settings ----------
async function settings() {
  const keys = await api('/keys');
  const origin = location.origin;
  await shell('settings', `<div class="head"><div><h1>Settings</h1></div></div><div class="panel"><form data-form="tenant">
  <label>Company or brand name<input name="name" value="${esc(me.name)}" required></label>
  <label>Postal address <span class="muted">Shown in every email footer. Anti-spam laws require it, and campaigns will not send without it.</span><textarea name="postal_address" style="min-height:80px;font:inherit" placeholder="Street, city, PIN code, country">${esc(me.postal_address || '')}</textarea></label>
  <button>Save changes</button></form></div>
  <div class="panel"><h2>API keys</h2><p class="muted">For your website, shop or app. A key can add contacts and send events that start journeys. Read-only keys can only look.</p>
  ${keys.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Key</th><th>Access</th><th>Last used</th><th></th></tr></thead><tbody>${keys.map((k) => `<tr><td>${esc(k.name)}</td><td><code>${esc(k.prefix)}…</code></td><td><span class="badge ${k.scope === 'write' ? 'sending' : ''}">${k.scope === 'write' ? 'read &amp; write' : 'read only'}</span></td><td>${k.last_used_at ? whenTime(k.last_used_at) : 'never'}</td><td class="n"><button class="small danger" data-act="key-del" data-id="${k.id}">Revoke</button></td></tr>`).join('')}</tbody></table></div>` : ''}
  <form data-form="key" class="actions" style="margin-top:12px"><input name="name" placeholder="Key name, e.g. Website form" required style="max-width:260px;margin:0"><select name="scope" style="max-width:170px;margin:0"><option value="write">Read &amp; write</option><option value="read">Read only</option></select><button class="ghost">Create key</button></form></div>
  <div class="panel"><h2>Use it from your code</h2><p class="muted">Add a subscriber who agreed on your site, then tell us about an event to start a journey:</p>
  <pre class="code">curl -X POST ${esc(origin)}/v1/contacts \\
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \\
  -d '{"email":"asha@example.com","first_name":"Asha","tags":["customer"],"consent_source":"checkout page"}'

curl -X POST ${esc(origin)}/v1/events \\
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \\
  -d '{"email":"asha@example.com","name":"order_placed"}'</pre></div>
  <div class="panel"><h2>Let Claude run it (MCP)</h2><p class="muted">Connect Claude or any MCP client, then ask in plain words: “How did last week's campaign do?”, “Draft a Diwali email for my VIP list”, “Is my sender health okay?”. The agent can read everything and create drafts. It can only send after you approve, and only with a read &amp; write key.</p>
  <pre class="code">claude mcp add --transport http dakghar ${esc(origin)}/mcp \\
  --header "Authorization: Bearer YOUR_KEY"</pre>
  <p class="muted small">Other clients: server URL <code>${esc(origin)}/mcp</code>, header <code>Authorization: Bearer YOUR_KEY</code>. Use a read-only key if you want the agent to look but never change anything.</p></div>
  <div class="panel"><h2>Bounce and complaint feeds</h2><p class="muted">Your email provider must tell us when a message bounces or someone reports spam. Without this, bad addresses are never removed and the complaint auto-pause cannot work. Add the matching address in your provider's webhook settings.</p>
  <p><b>Amazon SES</b> (through an SNS topic): <code>${esc(origin)}/webhooks/ses</code></p>
  <p><b>Brevo</b> (free plan works): <code>${esc(origin)}/webhooks/brevo?token=YOUR_BREVO_WEBHOOK_SECRET</code><br><span class="muted small">Tick delivered, soft bounce, hard bounce, invalid email, blocked, spam and unsubscribed. The secret is the BREVO_WEBHOOK_SECRET value in your server settings.</span></p></div>`);
}

// ---------- command palette ----------
const pal = { items: [], i: 0 };
async function openPalette() {
  const camps = await api('/campaigns').catch(() => []);
  const go = (h) => () => { location.hash = h; };
  pal.all = [
    ...NAV.map(([k, l]) => ({ t: 'Go to ' + l, run: go('#/' + k) })),
    { t: 'New campaign', run: go('#/campaigns/new') }, { t: 'Import contacts', run: go('#/contacts') }, { t: 'Add a sending domain', run: go('#/domains') },
    { t: getTheme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', run: () => { setTheme(getTheme() === 'dark' ? 'light' : 'dark'); render(); } },
    { t: 'Log out', run: logout },
    ...camps.slice(0, 12).map((c) => ({ t: 'Open: ' + c.name, s: c.status, run: go('#/campaigns/' + c.id) })),
  ];
  modal(`<input id="pq" placeholder="Type to search or jump…" aria-label="Search commands" autocomplete="off"><ul class="pal-list" id="pl" role="listbox"></ul>`, 'pal-box');
  palFilter('');
}
function palFilter(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  pal.items = pal.all.filter((x) => words.every((w) => x.t.toLowerCase().includes(w))); pal.i = 0; palDraw();
}
function palDraw() {
  const l = $('#pl'); if (!l) return;
  l.innerHTML = pal.items.map((x, i) => `<li role="option" data-act="pal-run" data-i="${i}" class="${i === pal.i ? 'on' : ''}" aria-selected="${i === pal.i}">${esc(x.t)}${x.s ? `<small>${esc(x.s)}</small>` : ''}</li>`).join('') || '<li>No matches</li>';
  l.querySelector('.on')?.scrollIntoView?.({ block: 'nearest' });
}
const palRun = (i) => { const x = pal.items[i]; closeModal(); x?.run(); };

// ---------- router ----------
async function render() {
  clearTimeout(render.refresh); clearInterval(ed.autosave); clearTimeout(ed.countTimer);
  if (ed.builder) { ed.builder.destroy(); ed.builder = null; }
  if (!token) return authView(render.mode);
  try {
    const first = !me; if (first) me = await api('/me');
    if (!first && $('#main')) skeleton();
    const [route, arg] = (location.hash.replace(/^#\//, '') || 'overview').split('/');
    if (route === 'campaigns' && arg) {
      if (arg === 'new') return await campaignEditor('new');
      const c = await api('/campaigns/' + arg);
      return ['draft', 'preflight_failed'].includes(c.status) ? await campaignEditor(arg) : await campaignReport(arg);
    }
    if (route === 'automations' && arg) return await journeyEditor(arg);
    await ({ overview, campaigns, automations: journeysList, contacts, domains, plan, settings }[route] || overview)();
  } catch (e) { if (!e.handled) { toast(e.message, true); if (/not found/i.test(e.message)) location.hash = '#/campaigns'; } }
}
window.addEventListener('hashchange', render);

// ---------- events ----------
document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k' && token && me) { ev.preventDefault(); return activeModal ? closeModal() : openPalette(); }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's' && $('#cform')) { ev.preventDefault(); return saveCampaign().catch((e) => toast(e.message, true)); }
  if (ev.key === 'Escape' && activeModal) return closeModal();
  if (activeModal && $('#pl')) {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); pal.i = Math.min(pal.items.length - 1, pal.i + 1); palDraw(); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); pal.i = Math.max(0, pal.i - 1); palDraw(); }
    if (ev.key === 'Enter') { ev.preventDefault(); palRun(pal.i); }
  }
});
document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.id === 'pq') return palFilter(t.value);
  if (t.dataset?.jname !== undefined || t.dataset?.jf || t.dataset?.trig || t.dataset?.step !== undefined) {
    if (t.dataset.jf) jr.a[t.dataset.jf] = t.value;
    else if (t.dataset.trig) { const k = t.dataset.trig; if (k === 'type') { jr.a.trigger = { type: t.value }; $('#jtrig').innerHTML = triggerFields(); } else jr.a.trigger[k] = t.value || null; }
    else if (t.dataset.step !== undefined) { const st = jr.a.steps[+t.dataset.step]; st[t.dataset.k] = t.dataset.num ? Number(t.value) : t.value; if (t.tagName === 'SELECT' && t.dataset.k === 'check') redrawSteps(); }
    return jdirty(true);
  }
  if (t.id === 'ai-brief' || t.id === 'ai-tone' || t.id === 'ai-url') return;

  if (t.id === 'code') { ed.html = t.value; ed.codeDirty = true; return setDirty(true); }
  if (!t.closest?.('#cform')) return;
  if (t.dataset.seg) {
    const r = ed.seg.rules[+t.dataset.i];
    if (t.dataset.seg === 'field') { r.field = t.value; r.value = ''; renderSeg(); } else r.value = t.value;
    refreshCount();
  } else if (t.dataset.segMatch !== undefined) { ed.seg.match = t.value; refreshCount(); }
  else if (t.name === 'list_id') refreshCount();
  if (t.id === 'ab') { $('#abbox').hidden = !t.checked; }
  if (t.name === 'ab_split') $('#splitv').textContent = t.value;
  if (t.closest('#m-design,#m-code')) return;
  updateTip(); updateInbox(); setDirty(true);
});

document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-act],button[data-mode]'); if (!t) return;
  if (t.dataset.mode) { render.mode = t.dataset.mode; return authView(render.mode); }
  const { act, id } = t.dataset;
  const done = (fn) => busy(t, fn);
  if (act === 'close') { const fresh = !!$('#newkey'); closeModal(); if (fresh) render(); return; }
  if (act === 'copy-key') { navigator.clipboard?.writeText($('#newkey').textContent); return toast('Copied.'); }
  if (act === 'logout') return logout();
  if (act === 'theme') { setTheme(getTheme() === 'dark' ? 'light' : 'dark'); return render(); }
  if (act === 'palette') return openPalette();
  if (act === 'pal-run') return palRun(+t.dataset.i);
  if (act === 'pause') return done(async () => { await api(`/campaigns/${id}/pause`, { method: 'POST' }); toast('Paused'); render(); });
  if (act === 'resume') return done(async () => { const r = await api(`/campaigns/${id}/resume`, { method: 'POST' }); toast(`Resumed. ${num(r.requeued)} emails back in the queue.`); render(); });
  if (act === 'unschedule') return done(async () => { await api(`/campaigns/${id}/unschedule`, { method: 'POST' }); toast('Schedule cancelled. It is a draft again.'); location.hash = '#/campaigns/' + id; render(); });
  if (act === 'dupe') return done(async () => { const r = await api(`/campaigns/${id}/duplicate`, { method: 'POST' }); toast('Copied. You are editing the new draft.'); location.hash = '#/campaigns/' + r.id; });
  if (act === 'send-new') return done(async () => { const r = await api(`/campaigns/${id}/send`, { method: 'POST' }); toast(`${num(r.queued)} more emails queued.`); render(); });
  if (act === 'delcontact') return done(async () => { await api('/contacts/' + id, { method: 'DELETE' }); render(); });
  if (act === 'cpage') { cstate.page = +t.dataset.p; return render(); }
  if (act === 'deldomain') return done(async () => { await api('/domains/' + id, { method: 'DELETE' }); render(); });
  if (act === 'dnscheck') return done(async () => {
    const r = await api(`/domains/${id}/check`, { method: 'POST', body: { dkim_selector: $('#sel-' + id).value } });
    toast(r.verified ? 'Domain verified.' : (r.needs_selector ? 'Enter your DKIM selector, then check again.' : 'Some records are still missing. DNS can take a few minutes.'), !r.verified); render();
  });
  if (act === 'subscribe') return done(async () => {
    const r = await api('/billing/subscribe', { method: 'POST', body: { plan_code: t.dataset.code } });
    if (r.checkout_url) return (location.href = r.checkout_url);
    me = null; toast('Plan updated.'); render();
  });
  // AI help
  if (act === 'ai-open') { ai.subjects = ai.draft = ai.segment = null; ai.err = ''; ai.brief = undefined; ai.tab = 'subjects'; modal('', 'ai wide'); return aiRender(); }
  if (act === 'ai-tab') { ai.brief = $('#ai-brief')?.value ?? ai.brief; ai.tab = t.dataset.t; ai.err = ''; if (ai.tab !== 'subjects' && ai.brief && ai.brief === (form().name.value + (form().subject.value ? '. ' + form().subject.value : ''))) ai.brief = ''; return aiRender(); }
  if (act === 'ai-go') return aiGo();
  if (act === 'ai-subj') { const x = ai.subjects[+t.dataset.i]; const f = form(); if (t.dataset.ab === 'b') { $('#ab').checked = true; $('#abbox').hidden = false; f.subject_b.value = x.text; } else f.subject.value = x.text; updateTip(); updateInbox(); setDirty(true); toast('Subject updated.'); return; }
  if (act === 'ai-apply-draft') { const f = form(), d = ai.draft; ed.html = d.html; f.subject.value = d.subject; f.preheader.value = d.preheader || ''; updateTip(); updateInbox(); mountDesign(); if (ed.mode !== 'design') setMode('design'); setDirty(true); closeModal(); return toast('Draft applied. Review it, then save.'); }
  if (act === 'ai-apply-seg') { ed.seg = JSON.parse(JSON.stringify(ai.segment.segment)); renderSeg(); refreshCount(true); setDirty(true); closeModal(); return toast('Filter applied.'); }
  // journeys
  if (act === 'j-template') { jr.template = t.dataset.k; location.hash = '#/automations/new'; return; }
  if (act === 'j-pause-list') return done(async () => { await api(`/automations/${id}/pause`, { method: 'POST' }); toast('Paused.'); render(); });
  if (act === 'j-pause') return done(async () => { await api(`/automations/${jr.id}/pause`, { method: 'POST' }); toast('Paused. You can edit now.'); render(); });
  if (act === 'j-add') { jr.a.steps.push(mkStep(t.dataset.t)); redrawSteps(); return jdirty(true); }
  if (act === 'j-del') { jr.a.steps.splice(+t.dataset.i, 1); redrawSteps(); return jdirty(true); }
  if (act === 'j-up' || act === 'j-down') { const i = +t.dataset.i, j = act === 'j-up' ? i - 1 : i + 1; [jr.a.steps[i], jr.a.steps[j]] = [jr.a.steps[j], jr.a.steps[i]]; redrawSteps(); return jdirty(true); }
  if (act === 'j-save') return done(() => saveJourney());
  if (act === 'j-on') return turnOn(t);
  if (act === 'j-confirm-on') return done(async () => { const r = await api(`/automations/${id}/activate`, { method: 'POST', body: { enroll_existing: !!$('#backfill')?.checked } }); closeModal(); toast(r.enrolled ? `Journey is on. ${num(r.enrolled)} people started.` : 'Journey is on.'); render(); });
  if (act === 'j-design') {
    const i = +t.dataset.i; jr.tmpHtml = jr.a.steps[i].html;
    modal(`<h2>Design the email</h2><div id="jb"></div><div class="actions"><button type="button" class="ghost" data-act="close">Cancel</button><button type="button" data-act="j-design-done" data-i="${i}">Done</button></div>`, 'wide');
    jr.builder = createBuilder($('#jb'), { html: jr.tmpHtml, onChange: (h) => { jr.tmpHtml = h; } }); return;
  }
  if (act === 'j-design-done') { jr.a.steps[+t.dataset.i].html = jr.tmpHtml; closeModal(); jdirty(true); return toast('Email design kept. Save the journey to store it.'); }
  if (act === 'key-del') return done(async () => { if (!confirm('Revoke this key? Anything using it stops working.')) return; await api('/keys/' + id, { method: 'DELETE' }); render(); });
  // campaign editor
  if (act === 'mode') return setMode(t.dataset.m);
  if (act === 'device') { $('#fw').classList.toggle('mobile', t.dataset.d === 'mobile'); return; }
  if (act === 'seg-add') { ed.seg.rules.push({ field: 'engaged_within', value: '' }); renderSeg(); return; }
  if (act === 'seg-del') { ed.seg.rules.splice(+t.dataset.i, 1); renderSeg(); refreshCount(); return setDirty(true); }
  if (act === 'start-design') { ed.html = newDesign(t.dataset.tpl); mountDesign(); return setDirty(true); }
  if (act === 'ed-save') return done(() => saveCampaign());
  if (act === 'ed-test') return done(async () => { const cid = await saveCampaign(true); const r = await api(`/campaigns/${cid}/test`, { method: 'POST' }); toast('Test email sent to ' + r.sent_to); });
  if (act === 'ed-send') return reviewAndSend(t);
  if (act === 'do-send') return done(async () => {
    try { const r = await api(`/campaigns/${id}/send`, { method: 'POST' }); closeModal(); toast(`${num(r.queued)} emails queued.${r.note ? ' ' + r.note : ''}`); location.hash = '#/campaigns/' + id; render(); }
    catch (e) { if (e.data?.errors) { closeModal(); toast(e.message, true); } else throw e; }
  });
  if (act === 'do-schedule') return done(async () => {
    const v = $('#when').value; if (!v) throw new Error('Pick a date and time first.');
    const r = await api(`/campaigns/${id}/schedule`, { method: 'POST', body: { at: new Date(v).toISOString() } });
    closeModal(); toast('Scheduled for ' + whenTime(r.scheduled_at)); location.hash = '#/campaigns/' + id; render();
  });
});

document.addEventListener('submit', async (ev) => {
  const f = ev.target.closest('form[data-form]'); if (!f) return; ev.preventDefault();
  const kind = f.dataset.form; const btn = f.querySelector('button:not([type=button])');
  if (kind === 'campaign') return busy(null, () => saveCampaign());
  const val = Object.fromEntries(new FormData(f).entries());
  await busy(btn, async () => {
    if (kind === 'auth') {
      const r = await api('/auth/' + (f.dataset.mode === 'signup' ? 'signup' : 'login'), { method: 'POST', body: val });
      if (r.verify) { f.innerHTML = '<p><b>Check your inbox.</b> We sent a confirmation link to ' + esc(r.email) + '. Click it, then log in.</p>'; return; }
      token = r.token; localStorage.setItem('dk_token', token); me = null; location.hash = '#/overview'; render();
    } else if (kind === 'tenant') { await api('/tenant', { method: 'PATCH', body: val }); me = null; toast('Saved.'); render(); }
    else if (kind === 'key') {
      const r = await api('/keys', { method: 'POST', body: val });
      modal(`<h2>Your new key</h2><p>Copy it now. For safety we only show it once.</p><pre class="code" id="newkey">${esc(r.key)}</pre><div class="actions"><button type="button" class="ghost" data-act="close">Done</button><button type="button" data-act="copy-key">Copy key</button></div>`);
    } else if (kind === 'tagaud') { const r = await api('/audience/tag', { method: 'POST', body: { tag: val.tag, list_id: val.list_id || null } }); toast(`Tagged ${num(r.tagged)} people.`); }
    else if (kind === 'list') { await api('/lists', { method: 'POST', body: val }); render(); }
    else if (kind === 'domain') { await api('/domains', { method: 'POST', body: val }); render(); }
    else if (kind === 'cfilter') { cstate = { page: 1, status: val.status, q: val.q }; render(); }
    else if (kind === 'import') {
      const r = await api('/contacts/import', { method: 'POST', form: new FormData(f) });
      $('#imp').innerHTML = `<p><b>${num(r.added)}</b> added, ${num(r.updated)} updated, ${num(r.duplicates)} duplicates, <b>${num(r.rejected)}</b> skipped.</p>${r.rejected_sample.length ? `<p class="muted">Skipped: ${r.rejected_sample.map((x) => esc(x.email) + ' (' + esc(x.reason) + ')').join(', ')}</p>` : ''}`;
      toast('Import finished.');
    }
  });
});
window.addEventListener('beforeunload', (e) => { if (ed.dirty && $('#cform')) { e.preventDefault(); e.returnValue = ''; } });

render();
