import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

export class ImportError extends Error {}

const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;

const ALIAS = {
  'email': 'email', 'e-mail': 'email', 'email address': 'email', 'email id': 'email',
  'emailid': 'email', 'email_address': 'email', 'mail': 'email', 'e mail': 'email',
  'first name': 'first_name', 'first_name': 'first_name', 'firstname': 'first_name', 'fname': 'first_name',
  'last name': 'last_name', 'last_name': 'last_name', 'lastname': 'last_name', 'lname': 'last_name',
  'full name': 'name', 'name': 'name',
  'tag': 'tags', 'tags': 'tags',
};

// Notepad "Unicode" saves UTF-16; handle it along with normal UTF-8.
function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const b = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    b.swap16();
    return b.toString('utf16le');
  }
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

// rows = array of arrays of strings. Uses a header row if it has an email column,
// otherwise pulls every email address it can find in each row.
function fromRows(rows) {
  rows = rows.filter((r) => r.some((c) => String(c ?? '').trim()));
  if (!rows.length) return [];
  const head = rows[0].map((c) => { const h = String(c ?? '').trim().toLowerCase(); return ALIAS[h] || h; });
  if (head.includes('email')) {
    return rows.slice(1).map((r) => {
      const o = {};
      head.forEach((h, i) => { if (h) o[h] = String(r[i] ?? '').trim(); });
      return o;
    });
  }
  const out = [];
  for (const r of rows) for (const m of r.join(' ').matchAll(EMAIL_RE)) out.push({ email: m[0] });
  return out;
}

// Free text: one per line, comma separated, "Name <email>", anything.
function fromText(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const ms = [...line.matchAll(EMAIL_RE)];
    if (!ms.length) continue;
    let name = null;
    if (ms.length === 1 && line.includes('<')) {
      name = line.split('<')[0].replace(/["']/g, '').trim() || null;
    }
    for (const m of ms) out.push(name ? { email: m[0], name } : { email: m[0] });
  }
  return out;
}

function fromVcf(text) {
  const out = [];
  for (const card of text.split(/BEGIN:VCARD/i).slice(1)) {
    const fn = (card.match(/^FN[^:]*:(.+)$/im) || [])[1]?.trim() || null;
    for (const m of card.matchAll(/^(?:item\d+\.)?EMAIL[^:]*:(.+)$/gim)) {
      const e = (m[1].match(EMAIL_RE) || [])[0];
      if (e) out.push(fn ? { email: e, name: fn } : { email: e });
    }
  }
  return out;
}

function fromJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(data)) return null;
  const out = [];
  for (const it of data) {
    if (typeof it === 'string') { const e = (it.match(EMAIL_RE) || [])[0]; if (e) out.push({ email: e }); }
    else if (it && typeof it === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(it)) {
        const h = String(k).trim().toLowerCase();
        o[ALIAS[h] || h] = typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
      }
      if (o.email) out.push(o);
    }
  }
  return out;
}

async function fromXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch { throw new ImportError('Could not read that Excel file. Save it as .xlsx or CSV and try again.'); }
  const out = [];
  for (const ws of wb.worksheets) {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      rows.push(Array.from({ length: row.cellCount }, (_, i) => row.getCell(i + 1).text || ''));
    });
    out.push(...fromRows(rows));
  }
  return out;
}

function delimiter(text) {
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const counts = [',', '\t', ';', '|'].map((d) => [d, first.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : null;
}

export async function parseContactsFile(file) {
  const buf = file.buffer;
  if (!buf?.length) throw new ImportError('That file is empty.');
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    throw new ImportError('Old .xls files are not supported. In Excel use Save As and pick .xlsx or CSV.');
  }
  if (buf[0] === 0x50 && buf[1] === 0x4b) return fromXlsx(buf);          // zip container = .xlsx

  const text = decode(buf);
  if (/BEGIN:VCARD/i.test(text)) return fromVcf(text);
  if (/^\s*[\[{]/.test(text)) { const j = fromJson(text); if (j) return j; }

  const d = delimiter(text);
  if (d) {
    try {
      const rows = parse(text, { delimiter: d, skip_empty_lines: true, relax_column_count: true, relax_quotes: true, trim: true });
      const rec = fromRows(rows);
      if (rec.length) return rec;
    } catch { /* fall through to plain text scan */ }
  }
  return fromText(text);
}