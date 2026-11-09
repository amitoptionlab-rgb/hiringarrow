import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// Needs: npm i -D jsdom, and the app + worker running (see README). Run: node scripts/ui-smoke.mjs
const base = 'http://localhost:3000';
const ed = fs.readFileSync(path.join(PUB, 'editor.js'), 'utf8').replace(/^export /gm, '');
const app = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8').replace(/^import .*$/m, 'const { createBuilder, hasDesign, newDesign, TEMPLATES } = __ed;');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/<script[^>]*><\/script>/, '').replace(/<link[^>]*>/g, '');
const dom = new JSDOM(html, { url: base + '/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window; w.fetch = (u, o) => fetch(new URL(u, base), o); w.confirm = () => true;
const errors = []; w.addEventListener('error', (e) => errors.push(e.message)); w.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason?.stack || e.reason)));
w.eval('const __ed = (() => {' + ed + '\nreturn { createBuilder, hasDesign, newDesign, TEMPLATES };})();\n' + app);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => w.document.querySelector(s), $$ = (s) => [...w.document.querySelectorAll(s)];
const txt = () => w.document.body.textContent.replace(/\s+/g, ' ');
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const fire = (el, type = 'input') => el.dispatchEvent(new w.Event(type, { bubbles: true, cancelable: true }));
const setv = (el, v) => { el.value = v; fire(el); };
const go = async (h, ms = 900) => { w.location.hash = h; await sleep(ms); };
const toastErr = () => $('#toast').className.includes('err') ? $('#toast').textContent : '';

await sleep(200);
$('[data-mode=signup]').click(); await sleep(50);
let f = $('form[data-form=auth]').elements; f.company.value = 'UI Co'; f.email.value = `ui${Date.now()}@example.com`; f.password.value = 'correct-horse-9';
fire($('form[data-form=auth]'), 'submit'); await sleep(1500);
ok(/Get ready to send/.test(txt()) && /0 of 6 done/.test(txt()), 'overview shows onboarding checklist');
for (const r of ['campaigns', 'contacts', 'domains', 'plan', 'settings']) { await go('#/' + r, 700); ok(txt().length > 80 && !toastErr(), `page ${r} renders ${toastErr()}`); }

// token for API-side setup
const token = w.localStorage.getItem('dk_token');
const api = async (p, o = {}) => (await fetch(base + '/api' + p, { ...o, headers: { Authorization: 'Bearer ' + token, ...(o.body && !(o.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, body: o.body && !(o.body instanceof FormData) ? JSON.stringify(o.body) : o.body })).json();

await go('#/campaigns/new', 1200);
ok($$('.bk').length >= 5 && !!$('.bc-mail'), `builder shows starter template (${$$('.bk').length} blocks)`);
const before = $$('.bk').length;
$('[data-b=add][data-type=heading]').click(); await sleep(50);
ok($$('.bk').length === before + 1, 'clicking a palette block adds it');
ok(!!$('.bi input[data-p=text]'), 'new block is selected and its settings open');
setv($('.bi input[data-p=text]'), 'Hello builder'); ok(/Hello builder/.test($('.bc').textContent), 'editing settings updates the canvas live');
$('[data-b=undo]').click(); await sleep(30); $('[data-b=undo]').click(); await sleep(30);
ok($$('.bk').length === before, 'undo removes the added block');
$('[data-b=redo]').click(); await sleep(30);
ok($$('.bk').length === before + 1, 'redo brings it back');
$$('.bk').find((b) => /Your headline/.test(b.textContent)).click(); await sleep(30); $('.bk.sel [data-b=del]').click(); await sleep(30); ok($$('.bk').length === before, 'delete works');

f = $('#cform').elements; setv(f.subject, 'FREE MONEY!!! ACT NOW'); ok(/capital|exclamation|filters/.test($('#tip').textContent), `subject tip warns about spammy subject (${$('#tip').textContent})`);
setv(f.subject, 'Our November update'); ok($('#tip').className.includes('ok'), 'subject tip turns green for a good subject');
setv(f.from_name, 'Acme'); setv(f.from_email, 'news@acme.test');
ok(/Acme/.test($('#inbox').textContent) && /Our November update/.test($('#inbox').textContent), 'inbox preview reflects sender and subject');
$('#ab').checked = true; fire($('#ab')); ok(!$('#abbox').hidden, 'A/B box opens'); setv(f.subject_b, 'Just landed: November'); setv(f.ab_split, '40'); ok($('#splitv').textContent === '40', 'A/B split slider updates');
$('[data-act=seg-add]').click(); await sleep(30); ok($$('.seg-row').length === 1, 'segment condition row added');
setv($('.seg-row select'), 'tag_has'); setv($('.seg-row input'), 'vip'); await sleep(700); ok(/0/.test($('#count').textContent), `audience count shows (${$('#count').textContent.slice(0, 40)})`);
$('[data-act=mode][data-m=preview]').click(); await sleep(50); const sd = $('#fw iframe').srcdoc || $('#fw iframe').getAttribute('srcdoc') || ''; ok(/Asha/.test(sd) && !/{{/.test(sd), `preview personalises {{first_name | there}} (len ${sd.length}, has{{: ${/{{/.test(sd)}, Asha: ${/Asha/.test(sd)})`);
$('[data-act=mode][data-m=code]').click(); await sleep(50); ok(/dk-blocks/.test($('#code').value), 'code tab shows generated HTML');
$('[data-act=mode][data-m=design]').click(); await sleep(50); ok($$('.bk').length === before, 'back to design keeps blocks');
$('[data-act=ed-save]').click(); await sleep(1000);
const m = /#\/campaigns\/([0-9a-f-]{36})/.exec(w.location.hash); ok(!!m, `save creates the campaign and updates URL (${toastErr()})`);
const saved = m ? await api('/campaigns/' + m[1]) : {};
ok(saved.subject_b === 'Just landed: November' && saved.ab_split === 40 && saved.segment?.rules?.[0]?.field === 'tag_has' && /dk-blocks/.test(saved.html || ''), 'saved campaign has A/B, segment and design');

// review modal: blocked first (no address, nobody matches)
$('[data-act=ed-send]').click(); await sleep(1200);
ok(/Fix a few things first/.test(txt()) && /postal address/i.test(txt()), 'review modal blocks until address is set');
$('[data-act=close]').click(); await sleep(30);
await api('/tenant', { method: 'PATCH', body: { name: 'UI Co', postal_address: '5 Test Road, Pune 411001, India' } });
const fd = new FormData(); fd.append('file', new Blob(['email,first_name,tags\nr1@example.com,R1,vip\nr2@example.com,R2,\nr3@example.com,R3,vip\n']), 'c.csv'); fd.append('consent', 'true'); await api('/contacts/import', { method: 'POST', body: fd });
setv($('.seg-row input'), 'vip'); $('[data-act=ed-send]').click(); await sleep(1500);
ok(/Send to 2 people\?/.test(txt()), `review modal counts the segment (${(txt().match(/Send to [^?]*\?|Fix a few[^.]*/) || [''])[0]})`);
$('[data-act=do-send]').click(); await sleep(2500);
ok(new RegExp('#/campaigns/' + m[1]).test(w.location.hash) && /Subject line test|Activity|Sent/.test(txt()), 'send leads to the campaign report');
await sleep(2500); await go(w.location.hash, 900);
ok(/2/.test($('.ribbon')?.textContent || '') && /Sent/.test($('.ribbon')?.textContent || ''), `report ribbon shows sent count (${($('.ribbon')?.textContent || '').slice(0, 40)})`);

// ---------- journeys, AI, API keys ----------
await go('#/automations', 1000); ok(/Build your first journey/.test(txt()) && $$('[data-act=j-template]').length === 3, 'journeys page offers templates');
$('[data-act=j-template][data-k=welcome]').click(); await sleep(1500);
ok($$('.stepcard').length === 3 && /What starts it/.test(txt()), `template opens as a 3-step timeline (${$$('.stepcard').length})`);
$('[data-jf=from_email]').value = 'hello@acme.test'; fire($('[data-jf=from_email]'));
$('[data-act=j-add][data-t=wait]').click(); await sleep(50); ok($$('.stepcard').length === 4, 'add step works'); $$('[data-act=j-del]').pop().click(); await sleep(50); ok($$('.stepcard').length === 3, 'remove step works');
$$('[data-act=j-down]')[0].click(); await sleep(50); $$('[data-act=j-up]')[1].click(); await sleep(50);
$('[data-act=j-design][data-i="0"]').click(); await sleep(400); ok(!!$('#jb .bk') && $$('#jb .bk').length >= 1, 'email step opens the visual builder in a dialog');
$('#jb [data-b=add][data-type=heading]').click(); await sleep(50); $('[data-act=j-design-done]').click(); await sleep(100);
$('[data-act=j-save]').click(); await sleep(900); const jm = /#\/automations\/([0-9a-f-]{36})/.exec(w.location.hash); ok(!!jm, `journey saved and URL updated (${toastErr()})`);
const jsaved = jm ? await api('/automations/' + jm[1]) : {}; ok(jsaved.steps?.length === 3 && jsaved.from_email === 'hello@acme.test' && /dk-blocks/.test(jsaved.steps?.[0]?.html || ''), 'saved journey keeps steps, sender and the designed email');
$('[data-act=j-on]').click(); await sleep(1200); ok(/Turn this journey on\?/.test(txt()) && !!$('#backfill'), 'turn-on dialog offers to include existing subscribers');
$('#backfill').checked = true; $('[data-act=j-confirm-on]').click(); await sleep(1800);
ok(/This journey is on/.test(txt()) && !!$('[data-act=j-pause]'), `journey is on and locked for editing (${toastErr()})`);
await sleep(8500); await go(w.location.hash, 1200);
ok(/Entered/.test(txt()) && /Sent/.test(txt()), 'journey page shows live entered/sent numbers');
$('[data-act=j-pause]').click(); await sleep(1500); ok(!!$('[data-act=j-on]'), 'pausing unlocks the journey');

await go('#/plan', 900); $('[data-act=subscribe][data-code=growth]').click(); await sleep(1500);
await go('#/campaigns/new', 1400); ok(!!$('[data-act=ai-open]'), 'writing help button is on every plan');
$('[data-act=ai-open]').click(); await sleep(200); setv($('#ai-brief'), 'monthly offers for my clothing shop'); $('[data-act=ai-go]').click(); await sleep(1500);
ok($$('.ai-list li').length === 5 && /Built-in helper/.test(txt()), 'writing help lists 5 subject ideas and says it is the free built-in helper');
$$('[data-act=ai-subj][data-ab=a]')[0].click(); await sleep(50); ok($('#cform').elements.subject.value.length > 5 && /offers/i.test($('#cform').elements.subject.value), 'picking a suggestion fills the subject');
$('[data-act=ai-tab][data-t=segment]').click(); await sleep(50); setv($('#ai-brief'), 'vip customers active this month'); $('[data-act=ai-go]').click(); await sleep(1500);
$('[data-act=ai-apply-seg]').click(); await sleep(300); ok($$('.seg-row').length === 2, 'plain-words audience filter becomes real condition rows');
ok(!!$('#cform').elements.send_time_opt, 'smart send time option is on the campaign form');

await go('#/contacts', 1000); $('form[data-form=tagaud]').elements.tag.value = 'vip'; fire($('form[data-form=tagaud]'), 'submit'); await sleep(900); ok(/Tagged \d+ people/.test($('#toast').textContent), 'tag a group works');
await go('#/settings', 1000); const kf = $('form[data-form=key]'); kf.elements.name.value = 'UI test key'; fire(kf, 'submit'); await sleep(900);
ok(/dk_live_/.test($('#newkey')?.textContent || ''), 'new API key is shown once in a dialog'); $('[data-act=close]').click(); await sleep(100);
await go('#/settings', 900); ok(/UI test key/.test(txt()) && /\/mcp/.test(txt()) && /v1\/events/.test(txt()), 'settings lists the key and shows MCP + API instructions');

// palette + theme
w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); await sleep(700);
ok(!!$('#pq'), 'Ctrl+K opens the command palette'); setv($('#pq'), 'contacts'); ok($$('#pl li').length >= 1 && /contacts/i.test($('#pl li').textContent), 'palette filters');
w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(900); ok(w.location.hash === '#/contacts' && !$('#pq'), 'Enter jumps to the page');
const t0 = w.document.documentElement.dataset.theme; $('[data-act=theme]').click(); await sleep(600); ok(w.document.documentElement.dataset.theme !== t0, 'dark/light toggle works');
console.log(errors.length ? 'PAGE ERRORS: ' + errors.join('\n') : 'page errors: none'); console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
