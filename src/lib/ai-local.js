// Free, offline writing helper. No API, no account, no cost. It organises what the user typed
// (it does not invent facts). Plug in your own local model for richer writing: see AI_BASE_URL.
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const sentence = (s) => { s = cap(clean(s)); return s && !/[.!?]$/.test(s) ? s + '.' : s; };

function topicOf(brief) {
  let t = clean(brief).split(/[.!?\n,;:]/)[0].replace(/^(please\s+)?(write|create|make|send|draft)\s+(me\s+)?(an?\s+)?(email|mail|newsletter)?\s*(about|for|on|to announce)?\s*/i, '').replace(/[,;:\-–\s]+$/, '').trim();
  if (t.length > 50) t = t.slice(0, 50).replace(/\s+\S*$/, '');
  return cap(t) || 'Our latest news';
}
const find = (re, s) => { const m = re.exec(s); return m ? m : null; };

const TEMPLATES = {
  friendly: [(t) => t, (t) => `A little something: ${t}`, (t) => `${t}, just for you`, (t) => `Thought you would like this: ${t}`, (t) => `Quick update: ${t}`, (t) => `${t}: take a look`],
  professional: [(t) => t, (t) => `Update: ${t}`, (t) => `${t}: what you need to know`, (t) => `Introducing: ${t}`, (t) => `${t} (a short read)`, (t) => `${t}: our latest`],
  playful: [(t) => `Psst… ${t}`, (t) => `Guess what? ${t}`, (t) => `Good news: ${t}`, (t) => `${t} ✨`, (t) => `Open this one: ${t}`],
  'urgent but honest': [(t) => `${t}: ends soon`, (t) => `Last call: ${t}`, (t) => `Do not miss: ${t}`, (t) => `${t}, before it ends`, (t) => `Reminder: ${t}`],
  'Hinglish, casual': [(t) => `${t}: dekho kya naya hai`, (t) => `Aapke liye: ${t}`, (t) => `${t}, ek nazar zaroor`, (t) => `Suno! ${t}`, (t) => `${t} (padhna mat bhoolna)`],
};

export function subjectsLocal(brief, tone) {
  const t = topicOf(brief), b = clean(brief);
  const pct = find(/(\d{1,2})\s*%\s*(off|discount)?/i, b), until = find(/\b(?:till|until|by|ends?)\s+(tonight|tomorrow|[a-z]+day|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+)/i, b);
  const first = [];
  if (pct) first.push(`${pct[1]}% off: ${t}`);
  if (until) first.push(`${t} until ${cap(until[1])}`);
  const fit = (f) => clean(f(t));
  const out = [];
  for (const x of [...first.map(clean), ...(TEMPLATES[tone] || TEMPLATES.friendly).map(fit), ...TEMPLATES.friendly.map(fit), ...TEMPLATES.professional.map(fit)]) {
    if (x && x.length <= 60 && !out.includes(x)) out.push(x);
    if (out.length === 5) break;
  }
  return out.length ? out : [t.slice(0, 60)];
}

export function draftLocal({ brief, tone, buttonUrl }) {
  const topic = topicOf(brief), b = clean(brief);
  const parts = b.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 4).map(sentence);
  const opener = { friendly: 'We have something we think you will like.', professional: 'Here is a short update from us.', playful: 'Quick one, and we think you will enjoy it.', 'urgent but honest': 'A quick heads up, so you do not miss out.', 'Hinglish, casual': 'Aapke liye ek chhoti si khabar hai.' }[tone] || 'We have something we think you will like.';
  const label = /\b(sale|offer|off|discount|deal|shop|buy|order)\b/i.test(b) ? 'Shop now' : /\b(webinar|event|workshop|register|join|rsvp|seat)\b/i.test(b) ? 'Reserve my spot' : /\b(new|launch|introducing|arrival)\b/i.test(b) ? 'See what is new' : 'Read more';
  return {
    subject: subjectsLocal(brief, tone)[0], preheader: (parts[0] || topic).slice(0, 90), headline: topic,
    paragraphs: ['Hi {{first_name | there}},', `${opener} ${parts.join(' ')}`.trim(), 'Reply to this email if you have any questions. We read every message.'],
    button_label: buttonUrl ? label : '',
  };
}

const DAYS = { day: 1, week: 7, month: 30, year: 365 };
const days = (n, unit) => Math.max(1, Math.round(n * DAYS[unit]));
const domainNames = { gmail: 'gmail.com', yahoo: 'yahoo.com', outlook: 'outlook.com', hotmail: 'hotmail.com', rediffmail: 'rediffmail.com', icloud: 'icloud.com' };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Plain words -> filter conditions. Only uses tags, fields and campaigns that really exist in the account.
export function segmentLocal(text, { tags = [], fields = [], camps = [] } = {}) {
  const t = ' ' + clean(text).toLowerCase().replace(/[“”]/g, '"').replace(/[’]/g, "'") + ' ';
  const rules = [], notes = [];
  const add = (field, value, note) => { if (!rules.some((r) => r.field === field && r.value === String(value))) { rules.push({ field, value: String(value) }); notes.push(note); } };

  const dur = find(/(\d+)\s*(day|week|month|year)s?/, t);
  const window = (dflt) => dur ? days(+dur[1], dur[2]) : (/this week/.test(t) ? 7 : /this month/.test(t) ? 30 : /this year/.test(t) ? 365 : dflt);
  if (/\b(inactive|not engaged|dormant|haven'?t (opened|engaged|clicked)|did ?n[o']?t engage)\b/.test(t)) { const d = window(90); add('inactive_for', d, `not engaged for ${d} days`); }
  else if (/\b(active|engaged|opened anything|recently engaged)\b/.test(t)) { const d = window(30); add('engaged_within', d, `engaged in the last ${d} days`); }
  if (/\b(new|recent)\s+(\w+\s+)?(subscribers?|contacts?|customers?|people|signups?|leads?|users?)\b/.test(t)) { const d = dur ? days(+dur[1], dur[2]) : (/this month/.test(t) ? 30 : 7); add('added_within', d, `added in the last ${d} days`); }

  for (const tag of tags) {
    const re = new RegExp(`(\\bnot\\b|\\bwithout\\b|\\bno\\b)?\\s*(?:\\btag(?:ged|s)?\\s+(?:as\\s+|with\\s+)?)?\\b${esc(tag.toLowerCase())}\\b`);
    const m = re.exec(t); if (!m) continue;
    const neg = !!m[1];
    neg ? add('tag_not', tag, `without tag “${tag}”`) : add('tag_has', tag, `tagged “${tag}”`);
  }
  const explicit = find(/\btag(?:ged|s)?\s+(?:as\s+|with\s+)?"?([a-z0-9][a-z0-9_.-]{0,28})"?/, t);
  if (explicit && !tags.map((x) => x.toLowerCase()).includes(explicit[1])) add('tag_has', explicit[1], `tagged “${explicit[1]}”`);

  const dm = find(/\b([a-z0-9-]+\.(?:com|in|org|net|co|io|edu))\b/, t) || (() => { const m = find(/\b(gmail|yahoo|outlook|hotmail|rediffmail|icloud)\b/, t); return m && [null, domainNames[m[1]]]; })();
  if (dm && dm[1]) add('domain_is', dm[1], `email domain ${dm[1]}`);

  for (const f of fields) { const m = find(new RegExp(`\\b${esc(f.toLowerCase())}\\s*(?:is|=|:|equals)\\s*"?([a-z0-9][a-z0-9 ]{0,30}?)"?(?=\\s+(?:and|or)\\b|\\s*$|,|\\.)`), t); if (m) add('custom_equals', `${f}=${m[1].trim()}`, `${f} is ${m[1].trim()}`); }

  for (const c of camps) {
    const name = c.name.toLowerCase(); if (name.length < 3) continue;
    const i = t.indexOf(name); if (i < 0) continue;
    const before = t.slice(Math.max(0, i - 45), i);
    if (/(did ?n[o']?t open|not opened|never opened|ignored|haven'?t opened|but did ?n[o']?t)/.test(before)) add('not_opened_campaign', c.id, `got “${c.name}” but did not open it`);
    else if (/clicked/.test(before)) add('clicked_campaign', c.id, `clicked in “${c.name}”`);
    else if (/opened/.test(before)) add('opened_campaign', c.id, `opened “${c.name}”`);
  }
  if (!rules.length) return { segment: null, explanation: 'I could not match that to a filter. Try words like: active in the last 30 days, inactive for 90 days, tagged vip, gmail users, or opened one of your campaigns by name.' };
  return { segment: { match: / or /.test(t) && !/ and /.test(t) ? 'any' : 'all', rules }, explanation: 'People who are ' + notes.join(rules.length > 1 && / or /.test(t) && !/ and /.test(t) ? ' or ' : ' and ') + '.' };
}
