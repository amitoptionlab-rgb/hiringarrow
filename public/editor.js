// Visual email builder. Blocks -> table-based, email-safe HTML. No dependencies.
// The block list is saved inside the HTML as a comment so the design can be reopened later.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (n, a, b, d) => { n = Number(n); return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d; };
const color = (c, d) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : d);
const url = (u) => (/^https?:\/\/\S+$/i.test(String(u || '').trim()) ? String(u).trim() : '');
const align = (a) => (['left', 'center', 'right'].includes(a) ? a : 'left');
const uid = () => Math.random().toString(36).slice(2, 9);

export const FONTS = { Arial: 'Arial, Helvetica, sans-serif', Georgia: 'Georgia, "Times New Roman", serif', Verdana: 'Verdana, Geneva, sans-serif', Trebuchet: '"Trebuchet MS", Helvetica, sans-serif', Tahoma: 'Tahoma, Geneva, sans-serif' };
export const DEFAULT_STYLE = { bg: '#f1f3f2', width: 600, font: 'Arial', text: '#222222', accent: '#0b6e6a' };

export const TYPES = {
  heading: { label: 'Heading', icon: 'H', def: () => ({ text: 'Your headline', size: 28, align: 'left' }) },
  text: { label: 'Text', icon: '¶', def: () => ({ text: 'Write your message here. You can use **bold**, [links](https://example.com) and {{first_name | there}}.', align: 'left' }) },
  image: { label: 'Image', icon: '▣', def: () => ({ src: '', alt: '', href: '', width: 100 }) },
  button: { label: 'Button', icon: '▭', def: () => ({ label: 'Read more', href: 'https://', align: 'left' }) },
  columns: { label: 'Two columns', icon: '◫', def: () => ({ lt: 'Left title', ltx: 'Short text for the left column.', rt: 'Right title', rtx: 'Short text for the right column.' }) },
  divider: { label: 'Divider', icon: '―', def: () => ({}) },
  spacer: { label: 'Spacer', icon: '↕', def: () => ({ height: 24 }) },
  html: { label: 'Custom HTML', icon: '</>', def: () => ({ code: '<p>Your HTML</p>' }) },
};
const FIELDS = {
  heading: [['text', 'Headline', 'text'], ['size', 'Size (px)', 'number'], ['align', 'Alignment', 'align']],
  text: [['text', 'Text', 'area'], ['align', 'Alignment', 'align']],
  image: [['src', 'Image URL (https://…)', 'text'], ['alt', 'Description for screen readers', 'text'], ['href', 'Link when clicked (optional)', 'text'], ['width', 'Width (%)', 'range']],
  button: [['label', 'Button label', 'text'], ['href', 'Link URL', 'text'], ['align', 'Alignment', 'align']],
  columns: [['lt', 'Left title', 'text'], ['ltx', 'Left text', 'area'], ['rt', 'Right title', 'text'], ['rtx', 'Right text', 'area']],
  spacer: [['height', 'Height (px)', 'number']],
  html: [['code', 'HTML', 'area']],
  divider: [],
};
export const mk = (type, props) => ({ id: uid(), type, props: { ...TYPES[type].def(), ...props } });

export const TEMPLATES = {
  newsletter: { label: 'Newsletter', blocks: () => [
    mk('heading', { text: 'Hi {{first_name | there}}, here is what is new' }),
    mk('text', { text: 'A short intro in two lines. Tell people why this email is worth their time.' }),
    mk('divider'), mk('columns', { lt: 'First story', ltx: 'One sentence that makes people want to read more.', rt: 'Second story', rtx: 'Another sentence about something useful.' }),
    mk('button', { label: 'Read everything', href: 'https://example.com' }), mk('spacer'),
    mk('text', { text: 'Thanks for reading,\nYour name' })] },
  announcement: { label: 'Announcement', blocks: () => [
    mk('heading', { text: 'Something new is here', size: 32 }),
    mk('text', { text: 'Hi {{first_name | there}},\n\nWe just launched something we think you will like. Here is what it does and why it matters to you.' }),
    mk('button', { label: 'See what is new', href: 'https://example.com' })] },
  offer: { label: 'Offer', blocks: () => [
    mk('heading', { text: 'This weekend only', size: 34, align: 'center' }),
    mk('text', { text: 'Hi {{first_name | there}}, enjoy a special price on our best sellers until Sunday night.', align: 'center' }),
    mk('button', { label: 'Shop now', href: 'https://example.com', align: 'center' }), mk('spacer'),
    mk('text', { text: 'Offer ends Sunday. Terms apply.', align: 'center' })] },
};

// ---------- rendering ----------
const fmt = (t, accent) => esc(t).split(/\n{2,}/).map((par) => `<p style="margin:0 0 14px">${par.replace(/\n/g, '<br>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, l, u) => `<a href="${u}" style="color:${accent}">${l}</a>`)}</p>`).join('');

function row(b, st, canvas) {
  const p = b.props, A = color(st.accent, DEFAULT_STYLE.accent), T = color(st.text, DEFAULT_STYLE.text);
  switch (b.type) {
    case 'heading': return `<tr><td style="padding:22px 32px 8px;text-align:${align(p.align)}"><h1 style="margin:0;font-size:${clamp(p.size, 14, 48, 28)}px;line-height:1.25;color:${T}">${esc(p.text)}</h1></td></tr>`;
    case 'text': return `<tr><td style="padding:8px 32px;font-size:16px;line-height:1.6;color:${T};text-align:${align(p.align)}">${fmt(p.text, A)}</td></tr>`;
    case 'image': {
      const src = url(p.src);
      if (!src) return canvas ? '<tr><td style="padding:8px 32px"><div class="ph">Add an image URL in the panel on the right</div></td></tr>' : '';
      const img = `<img src="${esc(src)}" alt="${esc(p.alt)}" style="display:block;width:${clamp(p.width, 20, 100, 100)}%;max-width:100%;height:auto;margin:0 auto;border:0">`;
      const href = url(p.href);
      return `<tr><td style="padding:8px 32px;text-align:center">${href ? `<a href="${esc(href)}">${img}</a>` : img}</td></tr>`;
    }
    case 'button': return `<tr><td style="padding:10px 32px"><table role="presentation" cellpadding="0" cellspacing="0" align="${align(p.align)}"><tr><td bgcolor="${A}" style="background:${A};border-radius:6px"><a href="${esc(url(p.href) || '#')}" style="display:inline-block;padding:13px 26px;font-weight:bold;font-size:16px;color:#ffffff;text-decoration:none">${esc(p.label)}</a></td></tr></table></td></tr>`;
    case 'columns': return `<tr><td style="padding:8px 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td class="dk-col" width="50%" valign="top" style="padding-right:12px;font-size:15px;line-height:1.55;color:${T}"><strong style="font-size:17px">${esc(p.lt)}</strong><br>${esc(p.ltx).replace(/\n/g, '<br>')}</td>
<td class="dk-col" width="50%" valign="top" style="padding-left:12px;font-size:15px;line-height:1.55;color:${T}"><strong style="font-size:17px">${esc(p.rt)}</strong><br>${esc(p.rtx).replace(/\n/g, '<br>')}</td></tr></table></td></tr>`;
    case 'divider': return '<tr><td style="padding:12px 32px"><hr style="border:0;border-top:1px solid #dddddd;margin:0"></td></tr>';
    case 'spacer': { const h = clamp(p.height, 4, 120, 24); return `<tr><td style="height:${h}px;line-height:${h}px;font-size:1px">&nbsp;</td></tr>`; }
    case 'html': return canvas ? `<tr><td style="padding:8px 32px"><div class="ph">Custom HTML block (shown in Preview)</div></td></tr>` : `<tr><td style="padding:8px 32px">${p.code || ''}</td></tr>`;
    default: return '';
  }
}

const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
const unb64 = (s) => decodeURIComponent(escape(atob(s)));

export function toHtml(state) {
  const st = state.style, bg = color(st.bg, DEFAULT_STYLE.bg), w = clamp(st.width, 400, 720, 600);
  const marker = `<!--dk-blocks:${b64(JSON.stringify(state))}-->`;
  return `${marker}<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light">
<style>@media (max-width:620px){.dk-col{display:block!important;width:100%!important;padding:0 0 14px 0!important}.dk-wrap{width:100%!important}}</style></head>
<body style="margin:0;padding:0;background:${bg}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" class="dk-wrap" width="${w}" cellpadding="0" cellspacing="0" style="width:${w}px;max-width:100%;background:#ffffff;font-family:${FONTS[st.font] || FONTS.Arial}">
<tr><td style="height:8px;line-height:8px;font-size:1px">&nbsp;</td></tr>${state.blocks.map((b) => row(b, st, false)).join('\n')}<tr><td style="height:16px;line-height:16px;font-size:1px">&nbsp;</td></tr></table></td></tr></table></body></html>`;
}
export function fromHtml(html) {
  const m = /<!--dk-blocks:([A-Za-z0-9+/=_-]+)-->/.exec(html || '');
  if (!m) return null;
  try {
    const s = JSON.parse(unb64(m[1]));
    if (!Array.isArray(s.blocks) || !s.blocks.every((b) => TYPES[b.type] && b.props)) return null;
    return { blocks: s.blocks.map((b) => ({ id: b.id || uid(), type: b.type, props: { ...TYPES[b.type].def(), ...b.props } })), style: { ...DEFAULT_STYLE, ...s.style } };
  } catch { return null; }
}
export const hasDesign = (html) => !!fromHtml(html);
export const newDesign = (tpl = 'newsletter') => toHtml({ blocks: TEMPLATES[tpl].blocks(), style: { ...DEFAULT_STYLE } });

// ---------- the builder UI ----------
export function createBuilder(root, { html, onChange }) {
  let state = fromHtml(html) || { blocks: TEMPLATES.newsletter.blocks(), style: { ...DEFAULT_STYLE } };
  let sel = null, hist = [JSON.stringify(state)], hi = 0, timer = null;
  const $ = (s) => root.querySelector(s);

  const emit = () => onChange(toHtml(state));
  const pushHist = () => { hist = hist.slice(0, hi + 1); const j = JSON.stringify(state); if (j !== hist[hi]) { hist.push(j); hi = hist.length - 1; if (hist.length > 60) { hist.shift(); hi--; } } };
  const commit = (typing) => { clearTimeout(timer); if (typing) timer = setTimeout(pushHist, 600); else pushHist(); emit(); updateUndo(); };
  const updateUndo = () => { const u = $('[data-b=undo]'), r = $('[data-b=redo]'); if (u) u.disabled = hi === 0; if (r) r.disabled = hi >= hist.length - 1; };
  const restore = (i) => { hi = i; state = JSON.parse(hist[hi]); if (!state.blocks.find((b) => b.id === sel)) sel = null; renderCanvas(); renderInspector(); emit(); updateUndo(); };

  root.innerHTML = `<div class="bld"><aside class="bp" aria-label="Blocks"><h3>Blocks</h3><p class="muted small">Drag onto the email, or click to add.</p>
    ${Object.entries(TYPES).map(([k, t]) => `<button type="button" class="pal" draggable="true" data-b="add" data-type="${k}"><span aria-hidden="true">${t.icon}</span>${t.label}</button>`).join('')}
    <h3>Start from</h3>${Object.entries(TEMPLATES).map(([k, t]) => `<button type="button" class="pal ghost" data-b="tpl" data-tpl="${k}">${t.label}</button>`).join('')}
    <div class="hist"><button type="button" class="small ghost" data-b="undo">Undo</button><button type="button" class="small ghost" data-b="redo">Redo</button></div></aside>
    <section class="bc-wrap" aria-label="Email design"><div class="bc" data-b="canvas"></div></section>
    <aside class="bi" aria-label="Settings"></aside></div>`;

  function renderCanvas() {
    const st = state.style, w = clamp(st.width, 400, 720, 600);
    $('.bc').style.background = color(st.bg, DEFAULT_STYLE.bg);
    $('.bc').innerHTML = `<div class="bc-mail" style="max-width:${w}px;font-family:${FONTS[st.font] || FONTS.Arial}">${state.blocks.length ? state.blocks.map((b) => `<div class="bk ${sel === b.id ? 'sel' : ''}" draggable="true" data-b="select" data-id="${b.id}">
      <div class="bk-bar" role="toolbar" aria-label="${TYPES[b.type].label} actions"><span>${TYPES[b.type].label}</span><button type="button" data-b="up" data-id="${b.id}" title="Move up" aria-label="Move up">↑</button><button type="button" data-b="down" data-id="${b.id}" title="Move down" aria-label="Move down">↓</button><button type="button" data-b="dup" data-id="${b.id}" title="Duplicate" aria-label="Duplicate">⧉</button><button type="button" data-b="del" data-id="${b.id}" title="Delete" aria-label="Delete">✕</button></div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${row(b, st, true)}</table></div>`).join('') : '<div class="empty-canvas">Drag a block here, or pick a template on the left.</div>'}</div>`;
  }
  function field(label, key, kind, val) {
    const id = 'f-' + key;
    if (kind === 'area') return `<label for="${id}">${label}<textarea id="${id}" data-p="${key}" rows="5">${esc(val)}</textarea></label>`;
    if (kind === 'align') return `<label for="${id}">${label}<select id="${id}" data-p="${key}">${['left', 'center', 'right'].map((a) => `<option ${val === a ? 'selected' : ''}>${a}</option>`).join('')}</select></label>`;
    if (kind === 'range') return `<label for="${id}">${label}: <b>${esc(val)}</b><input id="${id}" type="range" min="20" max="100" step="5" data-p="${key}" data-num="1" value="${esc(val)}"></label>`;
    return `<label for="${id}">${label}<input id="${id}" type="${kind}" data-p="${key}" ${kind === 'number' ? 'data-num="1"' : ''} value="${esc(val)}"></label>`;
  }
  function renderInspector() {
    const b = state.blocks.find((x) => x.id === sel), el = $('.bi');
    if (b) {
      el.innerHTML = `<h3>${TYPES[b.type].label}</h3>${FIELDS[b.type].map(([k, l, kind]) => field(l, k, kind, b.props[k])).join('') || '<p class="muted small">Nothing to set for this block.</p>'}
        ${b.type === 'text' ? '<p class="muted small">Use **bold**, [link text](https://…) and {{first_name | there}}. A blank line starts a new paragraph.</p>' : ''}
        <button type="button" class="ghost small" data-b="deselect">Email style</button>`;
    } else {
      const s = state.style;
      el.innerHTML = `<h3>Email style</h3>
        <label for="s-bg">Page background<input id="s-bg" type="color" data-s="bg" value="${color(s.bg, DEFAULT_STYLE.bg)}"></label>
        <label for="s-accent">Button and link color<input id="s-accent" type="color" data-s="accent" value="${color(s.accent, DEFAULT_STYLE.accent)}"></label>
        <label for="s-text">Text color<input id="s-text" type="color" data-s="text" value="${color(s.text, DEFAULT_STYLE.text)}"></label>
        <label for="s-width">Email width<select id="s-width" data-s="width" data-num="1">${[480, 560, 600, 640, 680].map((w) => `<option ${+s.width === w ? 'selected' : ''}>${w}</option>`).join('')}</select></label>
        <label for="s-font">Font<select id="s-font" data-s="font">${Object.keys(FONTS).map((f) => `<option ${s.font === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
        <p class="muted small">Click a block in the email to edit it.</p>`;
    }
  }
  const idx = (id) => state.blocks.findIndex((b) => b.id === id);
  const insert = (b, at) => { state.blocks.splice(at ?? state.blocks.length, 0, b); sel = b.id; renderCanvas(); renderInspector(); commit(); };
  const move = (id, to) => { const i = idx(id); if (i < 0) return; const [b] = state.blocks.splice(i, 1); state.blocks.splice(Math.max(0, Math.min(state.blocks.length, to > i ? to - 1 : to)), 0, b); renderCanvas(); commit(); };
  const clearDrop = () => root.querySelectorAll('.drop-before,.drop-end').forEach((e) => e.classList.remove('drop-before', 'drop-end'));
  const dropIndex = (y) => { const bks = [...root.querySelectorAll('.bk')]; for (let i = 0; i < bks.length; i++) { const r = bks[i].getBoundingClientRect(); if (y < r.top + r.height / 2) return i; } return bks.length; };

  root.addEventListener('click', (ev) => {
    if (ev.target.closest('.bk a')) ev.preventDefault();
    const t = ev.target.closest('[data-b]'); if (!t) return;
    const a = t.dataset.b, id = t.dataset.id;
    if (a === 'add') return insert(mk(t.dataset.type), sel ? idx(sel) + 1 : undefined);
    if (a === 'tpl') { if (state.blocks.length && !confirm('Replace the current design with this template?')) return; state.blocks = TEMPLATES[t.dataset.tpl].blocks(); sel = null; renderCanvas(); renderInspector(); return commit(); }
    if (a === 'undo' && hi > 0) return restore(hi - 1);
    if (a === 'redo' && hi < hist.length - 1) return restore(hi + 1);
    if (a === 'deselect') { sel = null; renderCanvas(); return renderInspector(); }
    if (a === 'up' || a === 'down') { const i = idx(id), j = a === 'up' ? i - 1 : i + 1; if (j < 0 || j >= state.blocks.length) return; [state.blocks[i], state.blocks[j]] = [state.blocks[j], state.blocks[i]]; renderCanvas(); return commit(); }
    if (a === 'dup') { const i = idx(id), c = JSON.parse(JSON.stringify(state.blocks[i])); c.id = uid(); return insert(c, i + 1); }
    if (a === 'del') { state.blocks.splice(idx(id), 1); if (sel === id) sel = null; renderCanvas(); renderInspector(); return commit(); }
    if (a === 'select' && sel !== id) { sel = id; renderCanvas(); renderInspector(); }
    if (a === 'canvas' && ev.target === t) { sel = null; renderCanvas(); renderInspector(); }
  });
  root.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.dataset.p) { const b = state.blocks.find((x) => x.id === sel); if (!b) return; b.props[t.dataset.p] = t.dataset.num ? Number(t.value) : t.value; if (t.type === 'range') t.previousSibling && (t.parentElement.querySelector('b').textContent = t.value); renderCanvas(); commit(true); }
    else if (t.dataset.s) { state.style[t.dataset.s] = t.dataset.num ? Number(t.value) : t.value; renderCanvas(); commit(true); }
  });
  root.addEventListener('dragstart', (ev) => {
    const p = ev.target.closest('.pal[data-b=add]'), b = ev.target.closest('.bk');
    ev.dataTransfer.effectAllowed = 'copyMove';
    if (p) ev.dataTransfer.setData('text/plain', 'new:' + p.dataset.type); else if (b) ev.dataTransfer.setData('text/plain', 'move:' + b.dataset.id);
  });
  root.addEventListener('dragover', (ev) => {
    if (!ev.target.closest('.bc')) return;
    ev.preventDefault(); clearDrop();
    const i = dropIndex(ev.clientY), bks = root.querySelectorAll('.bk');
    (bks[i] ? bks[i] : $('.bc-mail'))?.classList.add(bks[i] ? 'drop-before' : 'drop-end');
  });
  root.addEventListener('drop', (ev) => {
    if (!ev.target.closest('.bc')) return;
    ev.preventDefault(); const at = dropIndex(ev.clientY); clearDrop();
    const d = ev.dataTransfer.getData('text/plain') || '';
    if (d.startsWith('new:') && TYPES[d.slice(4)]) insert(mk(d.slice(4)), at);
    else if (d.startsWith('move:')) move(d.slice(5), at);
  });
  root.addEventListener('dragend', clearDrop);

  renderCanvas(); renderInspector(); updateUndo(); emit();
  return {
    getHtml: () => toHtml(state),
    undo: () => hi > 0 && restore(hi - 1),
    destroy: () => { clearTimeout(timer); root.innerHTML = ''; },
  };
}
