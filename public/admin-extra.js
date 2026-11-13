(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const fmt = (d) => (d ? new Date(d).toLocaleString() : '-');
  // textContent only (no innerHTML): server values cannot inject markup.
  const h = (tag, a, ...kids) => {
    const e = document.createElement(tag);
    for (const k in (a || {})) {
      if (k === 'class') e.className = a[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), a[k]);
      else e.setAttribute(k, a[k]);
    }
    for (const c of kids.flat()) { if (c == null || c === false) continue; e.append(c.nodeType ? c : document.createTextNode(String(c))); }
    return e;
  };
  const toast = (m, bad) => {
    const t = $('#toast'); t.textContent = m; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, 3500);
  };
  async function api(path) {
    const r = await fetch('/admin' + path, { headers: { 'x-admin-key': sessionStorage.getItem('ak') || '', 'x-admin-name': 'dashboard' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }
  const tbl = (cols, rows) => h('div', { class: 'xwrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))), h('tbody', {}, rows)));

  // ---- SVG charts ----
  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, a, ...k) => {
    const e = document.createElementNS(NS, tag);
    for (const n in (a || {})) e.setAttribute(n, a[n]);
    k.forEach((c) => e.append(c.nodeType ? c : document.createTextNode(String(c))));
    return e;
  };
  function chart(title, data, lines) {
    const W = 640, H = 170, L = 36, R = 8, T = 10, B = 24, n = data.length;
    const max = Math.max(1, ...lines.flatMap((l) => data.map((d) => d[l.key])));
    const x = (i) => L + (n <= 1 ? 0 : (i * (W - L - R)) / (n - 1));
    const y = (v) => T + (H - T - B) * (1 - v / max);
    const svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': title });
    svg.append(
      sv('line', { x1: L, y1: y(0), x2: W - R, y2: y(0), class: 'ax' }),
      sv('line', { x1: L, y1: T, x2: W - R, y2: T, class: 'ax' }),
      sv('text', { x: 2, y: T + 4, class: 'tk' }, max), sv('text', { x: 2, y: y(0) + 4, class: 'tk' }, 0),
      sv('text', { x: L, y: H - 6, class: 'tk' }, data[0].day.slice(5)),
      sv('text', { x: W - R, y: H - 6, class: 'tk', 'text-anchor': 'end' }, data[n - 1].day.slice(5)));
    lines.forEach((l) => {
      svg.append(sv('polyline', { fill: 'none', class: 'ln ' + l.cls, points: data.map((d, i) => x(i).toFixed(1) + ',' + y(d[l.key]).toFixed(1)).join(' ') }));
      data.forEach((d, i) => svg.append(sv('circle', { cx: x(i).toFixed(1), cy: y(d[l.key]).toFixed(1), r: 3, class: 'pt ' + l.cls }, sv('title', {}, d.day + ': ' + d[l.key] + ' ' + l.label))));
    });
    return h('div', {}, h('div', { class: 'legend' }, lines.map((l) => h('span', { class: 'lg ' + l.cls }, l.label))), svg);
  }

  // ---- tabs ----
  const views = { alerts: $('#v-alerts'), audit: $('#v-audit'), trends: $('#v-trends') };
  const accEls = () => ['.bar', '.wrap', '.pager'].map($);
  let tab = 'accounts';
  const loaders = { alerts: () => loadAlerts(), audit: () => { au.offset = 0; return loadAudit(); }, trends: () => loadTrends() };
  function show(t) {
    tab = t;
    accEls().forEach((e) => { if (e) e.hidden = t !== 'accounts'; });
    Object.entries(views).forEach(([k, e]) => { e.hidden = k !== t; });
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    if (loaders[t]) loaders[t]().catch((e) => toast(e.message, true));
  }

  // ---- alerts ----
  const setBadge = (n) => {
    const b = document.querySelector('#tabs [data-tab="alerts"]');
    b.textContent = n ? 'Alerts (' + n + ')' : 'Alerts'; b.classList.toggle('warn', n > 0);
  };
  async function loadAlerts() {
    const a = await api('/alerts');
    setBadge(a.total);
    const th = a.thresholds, none = (m) => h('p', { class: 'sub' }, m);
    views.alerts.replaceChildren(
      h('p', { class: 'sub' }, 'Bounce >= ' + th.bounce_pct + '% or complaint >= ' + th.complaint_pct + '% (last ' + th.days + ' days, min ' + th.min_sent + ' sends). Operator/admin activity is ignored for shared IPs.'),
      h('h3', {}, 'Shared IPs (30 days, user activity only)'),
      a.shared_ips.length ? tbl(['IP', 'Tenants', 'Names', 'Events', 'Last seen'], a.shared_ips.map((r) => h('tr', {}, h('td', {}, r.ip), h('td', {}, r.tenants), h('td', {}, (r.names || []).join(', ')), h('td', {}, r.events), h('td', {}, fmt(r.last_seen))))) : none('None.'),
      h('h3', {}, 'High bounce / complaint rate'),
      a.rates.length ? tbl(['Tenant', 'Status', 'Sent', 'Bounced', 'Complained'], a.rates.map((r) => h('tr', {}, h('td', {}, r.name), h('td', {}, r.status), h('td', {}, r.sent), h('td', {}, r.bounced + ' (' + r.bounce_pct + '%)'), h('td', {}, r.complained + ' (' + r.complaint_pct + '%)')))) : none('None.'),
      h('h3', {}, 'Low trust score (< ' + th.low_trust + ')'),
      a.low_trust.length ? tbl(['Tenant', 'Status', 'Trust score'], a.low_trust.map((r) => h('tr', {}, h('td', {}, r.name), h('td', {}, r.status), h('td', {}, r.trust_score)))) : none('None.'));
  }

  // ---- audit log ----
  const au = { offset: 0 }, AL = 100;
  const auParams = (limit, offset) => {
    const p = new URLSearchParams({ limit, offset });
    [['email', '#au-email'], ['ip', '#au-ip'], ['action', '#au-action'], ['tenant', '#au-tenant'], ['from', '#au-from'], ['to', '#au-to']]
      .forEach(([k, id]) => { const v = $(id).value.trim(); if (v) p.set(k, v); });
    return p;
  };
  async function loadAudit() {
    const rows = await api('/audit?' + auParams(AL, au.offset));
    const tb = $('#au-rows'); tb.replaceChildren();
    rows.forEach((r) => tb.append(h('tr', { title: (r.user_agent || '') + '\n' + JSON.stringify(r.details || {}) },
      h('td', {}, fmt(r.at)), h('td', {}, r.actor_label || r.actor_type), h('td', {}, r.tenant_name || '-'), h('td', {}, r.action),
      h('td', {}, r.success ? 'yes' : 'NO'), h('td', {}, r.ip || '-'), h('td', {}, (r.device_id || '').slice(0, 8)), h('td', {}, [r.target_type, r.target_id].filter(Boolean).join(' ') || '-'))));
    if (!rows.length) tb.append(h('tr', {}, h('td', { colspan: 8 }, 'No rows.')));
    $('#au-page').textContent = rows.length ? 'Rows ' + (au.offset + 1) + '-' + (au.offset + rows.length) : 'No rows';
    $('#au-prev').disabled = au.offset === 0; $('#au-next').disabled = rows.length === 0;
  }
  // Leading = + - @ would be run as a formula by Excel; user-agent etc. are attacker-controlled.
  const csvCell = (v) => {
    let t = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return '"' + t.replace(/"/g, '""') + '"';
  };
  async function exportCsv() {
    const cols = ['id', 'at', 'actor_type', 'actor_label', 'tenant_id', 'tenant_name', 'user_id', 'action', 'success', 'ip', 'user_agent', 'device_id', 'target_type', 'target_id', 'details'];
    const out = [cols.join(',')], MAX = 5000;
    let off = 0, total = 0;
    while (total < MAX) {
      const rows = await api('/audit?' + auParams(AL, off));
      if (!rows.length) break;
      rows.forEach((r) => out.push(cols.map((c) => csvCell(r[c])).join(',')));
      off += rows.length; total += rows.length;
    }
    const url = URL.createObjectURL(new Blob(['\ufeff' + out.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: 'audit-' + new Date().toISOString().slice(0, 10) + '.csv' });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Exported ' + total + ' rows' + (total >= MAX ? ' (cap 5000)' : ''));
  }

  // ---- trends ----
  async function loadTrends() {
    const d = await api('/series?days=' + $('#tr-days').value);
    const box = $('#tr-box'); box.replaceChildren();
    if (!d.length) { box.append(h('p', { class: 'sub' }, 'No data.')); return; }
    box.append(
      h('h3', {}, 'Signups per day'), chart('Signups per day', d, [{ key: 'signups', label: 'signups', cls: 'c1' }]),
      h('h3', {}, 'Sent vs bounced per day'), chart('Sent vs bounced per day', d, [{ key: 'sent', label: 'sent', cls: 'c3' }, { key: 'bounced', label: 'bounced', cls: 'c2' }]));
  }

  // ---- wiring ----
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  $('#au-go').addEventListener('click', () => { au.offset = 0; loadAudit().catch((e) => toast(e.message, true)); });
  $('#au-csv').addEventListener('click', () => exportCsv().catch((e) => toast(e.message, true)));
  $('#au-prev').addEventListener('click', () => { au.offset = Math.max(0, au.offset - AL); loadAudit().catch((e) => toast(e.message, true)); });
  $('#au-next').addEventListener('click', () => { au.offset += AL; loadAudit().catch((e) => toast(e.message, true)); });
  document.querySelectorAll('#v-audit input').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#au-go').click(); }));
  $('#tr-days').addEventListener('change', () => loadTrends().catch((e) => toast(e.message, true)));
  $('#refresh').addEventListener('click', () => { if (tab !== 'accounts') show(tab); else loadAlerts().catch(() => {}); });

  const app = $('#app');
  new MutationObserver(() => { if (!app.hidden) { show('accounts'); loadAlerts().catch(() => {}); } }).observe(app, { attributes: true, attributeFilter: ['hidden'] });
  if (!app.hidden) loadAlerts().catch(() => {});
})();
