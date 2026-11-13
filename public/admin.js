(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  let KEY = sessionStorage.getItem('ak') || '';
  const st = { search: '', status: '', plan: '', offset: 0 };
  const LIMIT = 50;
  const fmt = (d) => (d ? new Date(d).toLocaleString() : '-');
  // All server data goes through textContent (createTextNode): no innerHTML, so user-controlled values cannot inject markup.
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
  const lock = () => { sessionStorage.removeItem('ak'); KEY = ''; $('#gate').hidden = false; $('#app').hidden = true; $('#panel').hidden = true; };

  async function api(path, method, body) {
    const r = await fetch('/admin' + path, {
      method: method || 'GET',
      headers: Object.assign({ 'x-admin-key': KEY, 'x-admin-name': 'dashboard' }, body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) { lock(); throw new Error('Wrong or missing admin key.'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  async function loadStats() {
    const o = await api('/overview');
    const box = $('#stats'); box.replaceChildren();
    [['Tenants', o.tenants], ['Pending approval', o.pending, 'review'], ['Suspended', o.suspended, 'suspended'], ['Users', o.users],
     ['Unverified users', o.unverified], ['Sent today', o.sent_today], ['Bounced 7d', o.bounced_7d], ['Complained 7d', o.complained_7d]]
      .forEach(([l, v, f]) => box.append(h('div', { class: 'card' + (f ? ' click' : ''), onclick: f ? () => { st.status = f; st.offset = 0; $('#fs').value = f; loadList(); } : null }, h('b', {}, v), h('span', {}, l))));
  }

  async function loadList() {
    const p = new URLSearchParams({ limit: LIMIT, offset: st.offset });
    ['search', 'status', 'plan'].forEach((k) => { if (st[k]) p.set(k, st[k]); });
    try {
      const rows = await api('/accounts?' + p);
      const tb = $('#rows'); tb.replaceChildren();
      rows.forEach((r) => tb.append(h('tr', { onclick: () => openDetail(r.id) },
        h('td', {}, h('b', {}, r.name), h('div', { class: 'sub' }, r.owner_email || '-')),
        h('td', {}, h('span', { class: 'pill ' + r.status }, r.status)),
        h('td', {}, r.plan || '-'), h('td', {}, r.users), h('td', {}, r.sent),
        h('td', {}, r.bounces + ' / ' + r.complaints), h('td', {}, fmt(r.last_login)), h('td', {}, fmt(r.created_at)))));
      if (!rows.length) tb.append(h('tr', {}, h('td', { colspan: 8 }, 'No accounts found.')));
      $('#page').textContent = rows.length ? 'Rows ' + (st.offset + 1) + '-' + (st.offset + rows.length) : 'No rows';
      $('#prev').disabled = st.offset === 0; $('#next').disabled = rows.length < LIMIT;
    } catch (e) { toast(e.message, true); }
  }

  const kv = (l, v) => h('div', { class: 'kv' }, h('span', {}, l), h('b', {}, v == null || v === '' ? '-' : v));
  const sec = (t, ...c) => h('section', {}, h('h3', {}, t), ...c);
  const tbl = (cols, rows) => h('div', { class: 'wrap', style: 'padding:0' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))), h('tbody', {}, rows)));

  async function openDetail(id) {
    let d;
    try { d = await api('/accounts/' + id); } catch (e) { return toast(e.message, true); }
    const t = d.tenant, u = d.usage;
    const act = async (path, body, ok) => {
      try { await api(path, 'POST', body); toast(ok || 'Done'); await Promise.all([openDetail(id), loadList(), loadStats()]); }
      catch (e) { toast(e.message, true); }
    };
    const ipBox = h('div', { class: 'sub' });
    const btns = [];
    if (t.status === 'review') btns.push(h('button', { class: 'ok', onclick: () => { const c = prompt('Daily send cap for approval', '5000'); if (c !== null) act('/tenants/' + id + '/approve', { daily_send_cap: +c }, 'Approved'); } }, 'Approve'));
    if (t.status === 'suspended') btns.push(h('button', { class: 'ok', onclick: () => act('/tenants/' + id + '/unsuspend', {}, 'Unsuspended') }, 'Unsuspend'));
    else btns.push(h('button', { class: 'danger', onclick: () => { if (confirm('Suspend ' + t.name + '? Sending campaigns will be paused.')) act('/tenants/' + id + '/suspend', {}, 'Suspended'); } }, 'Suspend'));
    btns.push(h('button', { onclick: () => { const c = prompt('Plan code: free / starter / growth / pro', t.plan || ''); if (c) act('/tenants/' + id + '/plan', { plan_code: c.trim() }, 'Plan changed'); } }, 'Change plan'));
    btns.push(h('button', { onclick: () => { const c = prompt('New daily send cap', t.daily_send_cap); if (c !== null) act('/tenants/' + id + '/cap', { daily_send_cap: +c }, 'Cap updated'); } }, 'Set daily cap'));
    btns.push(h('button', { onclick: () => { const a = prompt('Credits to add (negative to remove)'); if (!a) return; const n = prompt('Note (optional)') || ''; act('/tenants/' + id + '/credits', { amount: +a, note: n }, 'Credits adjusted'); } }, 'Adjust credits'));
    btns.push(h('button', { class: 'danger', onclick: () => { const c = prompt('This deletes the tenant and ALL its data. Type the exact name to confirm:\n' + t.name); if (c !== null) act('/tenants/' + id + '/delete', { confirm: c }, 'Deleted').then(() => { $('#panel').hidden = true; }); } }, 'Delete'));

    const P = $('#panel'); P.hidden = false; P.scrollTop = 0; P.replaceChildren(
      h('div', { class: 'head' }, h('div', {}, h('h2', {}, t.name), h('div', { class: 'sub' }, t.id)), h('span', { class: 'pill ' + t.status }, t.status), h('button', { class: 'ghost', onclick: () => { P.hidden = true; } }, 'Close')),
      sec('Account', h('div', { class: 'grid' }, kv('Plan', t.plan), kv('Daily cap', t.daily_send_cap), kv('Monthly quota', t.monthly_emails), kv('Trust score', t.trust_score), kv('Kind', t.kind), kv('Created', fmt(t.created_at)), kv('Address', t.postal_address))),
      sec('Usage', h('div', { class: 'grid' }, kv('Contacts', u.contacts), kv('Campaigns', u.campaigns), kv('Sent this month', u.sent_month), kv('Sent total', u.sent_total), kv('Bounced', u.bounced), kv('Complained', u.complained), kv('Credits', u.credits))),
      sec('Actions', h('div', { class: 'acts' }, btns)),
      sec('Users', tbl(['Email', 'Role', 'Verified', 'Last login', ''], d.users.map((x) => h('tr', {},
        h('td', {}, x.email), h('td', {}, x.role), h('td', {}, x.email_verified_at ? 'yes' : 'NO'), h('td', {}, fmt(x.last_login)),
        h('td', {}, x.email_verified_at ? '' : h('button', { class: 'link', onclick: () => act('/users/' + x.id + '/verify', {}, 'Email verified') }, 'Verify')))))),
      sec('IPs (click for other accounts on the same IP)', tbl(['IP', 'Events', 'Tenants', 'Last seen'], d.ips.map((i) => h('tr', { style: 'cursor:pointer', onclick: async () => {
        try {
          const a = await api('/ips/' + encodeURIComponent(i.ip) + '/accounts');
          ipBox.replaceChildren(h('div', {}, 'Accounts on ' + i.ip + ':'), ...a.map((x) => h('div', {}, h('button', { class: 'link', onclick: () => openDetail(x.tenant_id) }, (x.name || x.tenant_id) + ' (' + x.status + ')'), ' ' + x.events + ' events')));
        } catch (e) { toast(e.message, true); }
      } }, h('td', {}, i.ip), h('td', {}, i.events), h('td', {}, i.tenants > 1 ? 'SHARED (' + i.tenants + ')' : '1'), h('td', {}, fmt(i.last_seen))))), ipBox),
      sec('Recent campaigns', tbl(['Name', 'Status', 'Created'], d.campaigns.map((c) => h('tr', {}, h('td', {}, c.name), h('td', {}, c.status), h('td', {}, fmt(c.created_at)))))),
      sec('Recent activity', tbl(['When', 'Action', 'OK', 'IP', 'Device'], d.activity.map((a) => h('tr', { title: a.user_agent || '' }, h('td', {}, fmt(a.at)), h('td', {}, a.action), h('td', {}, a.success ? 'yes' : 'NO'), h('td', {}, a.ip), h('td', {}, (a.device_id || '').slice(0, 8))))))
    );
  }

  async function unlock() {
    KEY = $('#key').value.trim();
    if (!KEY) return;
    try { await api('/overview'); sessionStorage.setItem('ak', KEY); boot(); }
    catch (e) { $('#gerr').textContent = e.message; }
  }
  function boot() {
    $('#gate').hidden = true; $('#app').hidden = false; $('#gerr').textContent = '';
    loadStats().catch((e) => toast(e.message, true)); loadList();
  }
  let tm;
  $('#go').addEventListener('click', unlock);
  $('#key').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
  $('#lock').addEventListener('click', lock);
  $('#q').addEventListener('input', (e) => { clearTimeout(tm); tm = setTimeout(() => { st.search = e.target.value.trim(); st.offset = 0; loadList(); }, 300); });
  $('#fs').addEventListener('change', (e) => { st.status = e.target.value; st.offset = 0; loadList(); });
  $('#fp').addEventListener('change', (e) => { st.plan = e.target.value; st.offset = 0; loadList(); });
  $('#refresh').addEventListener('click', () => { loadStats(); loadList(); });
  $('#prev').addEventListener('click', () => { st.offset = Math.max(0, st.offset - LIMIT); loadList(); });
  $('#next').addEventListener('click', () => { st.offset += LIMIT; loadList(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#panel').hidden = true; });
  if (KEY) api('/overview').then(boot).catch(() => {});
})();
