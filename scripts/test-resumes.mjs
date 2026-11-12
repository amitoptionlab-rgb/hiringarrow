import express from 'express';
import JSZip from 'jszip'; // mammoth ki dependency hai, test ke liye real .docx banane ko
import { q, pool } from '../src/db.js';
import { consultants } from '../src/consultants.js';

// Safety: this script runs DELETE ... LIKE 'ZZTEST %' on tenants, so it must never touch a remote DB.
const dbHost = new URL(pool.options.connectionString).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(dbHost)) {
  console.error('ABORT: test-resumes only runs against a local DB, got host "' + dbHost + '"');
  process.exit(1);
}
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   -> ' + extra}`); };
const mk = async (label) => {
  const { rows: [t] } = await q("INSERT INTO tenants (name, status) VALUES ($1, 'active') RETURNING id", [`ZZTEST ${label}`]);
  const { rows: [u] } = await q("INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, 'x', 'owner') RETURNING id", [t.id, `zztest-${label}-${Date.now()}@example.invalid`]);
  return { tid: t.id, uid: u.id };
};

const mkPdf = (text) => {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n'; const off = [];
  objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
};
const mkDocx = async (text) => {
  const hdr = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const z = new JSZip();
  z.file('[Content_Types].xml', hdr + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', hdr + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', hdr + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return z.generateAsync({ type: 'nodebuffer' });
};

let server;
try {
  const A = await mk('A'), B = await mk('B');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { tid: req.get('x-tid'), uid: req.get('x-uid'), role: 'owner' }; next(); });
  app.use('/consultants', consultants);
  server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/consultants`;
  const hdrs = (w) => ({ 'x-tid': w.tid, 'x-uid': w.uid });
  const call = async (who, method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...hdrs(who) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    return { s: r.status, j };
  };
  const upload = async (who, id, buf, name, type) => {
    const fd = new FormData(); fd.append('file', new Blob([buf], { type }), name);
    const r = await fetch(`${base}/${id}/resume`, { method: 'POST', headers: hdrs(who), body: fd });
    let j = null; try { j = await r.json(); } catch {}
    return { s: r.status, j };
  };
  const download = async (who, id) => {
    const r = await fetch(`${base}/${id}/resume`, { headers: hdrs(who) });
    return { s: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) };
  };

  const c = await call(A, 'POST', '/', { full_name: 'Asha Rao', title: 'DevOps Engineer', skills: 'aws', work_auth: 'GC' });
  const id = c.j?.id;
  check('profile created', c.s === 201 && id, JSON.stringify(c));

  const fs = await import('node:fs');
  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
  const pdf = fs.readFileSync(process.env.TEST_PDF);
  const words = (await pdfParse(pdf)).text.toLowerCase().match(/[a-z]{7,}/g) || [];
  const pdfWord = words[0];
  if (!pdfWord) throw new Error('TEST_PDF mein 7+ letters ka koi english word nahi mila (scanned PDF?). Doosri PDF lo.');
  console.log('PDF keyword for search test:', pdfWord);
  const u1 = await upload(A, id, pdf, 'asha resume.pdf', 'application/pdf');
  check('PDF upload -> 201, text extracted', u1.s === 201 && u1.j?.text_extracted === true, JSON.stringify(u1));
  const s1 = await call(B, 'GET', `/search?q=${pdfWord}`);
  check('B finds profile via PDF text', s1.j?.rows?.length === 1 && s1.j.rows[0].id === id, JSON.stringify(s1.j));
  const m1 = await call(A, 'GET', '/mine');
  check('/mine has_file = true', m1.j?.rows?.[0]?.has_file === true, JSON.stringify(m1.j?.rows?.[0]));

  const dB = await download(B, id);
  check('B cannot download A resume (404)', dB.s === 404, String(dB.s));
  const dA = await download(A, id);
  check('A downloads own PDF (bytes identical, application/pdf)', dA.s === 200 && dA.type === 'application/pdf' && dA.buf.equals(pdf), `${dA.s} ${dA.type} ${dA.buf.length}/${pdf.length}`);

  const uB = await upload(B, id, pdf, 'x.pdf', 'application/pdf');
  const delB = await call(B, 'DELETE', `/${id}/resume`);
  check("B cannot upload/delete on A's profile (404)", uB.s === 404 && delB.s === 404, `${uB.s}/${delB.s}`);

  const uTxt = await upload(A, id, Buffer.from('just plain text'), 'cv.pdf', 'application/pdf');
  check('plain text renamed .pdf -> 400', uTxt.s === 400, JSON.stringify(uTxt));
  const uBad = await upload(A, id, Buffer.from('%PDF-1.4\nthis is garbage, not a pdf'), 'bad.pdf', 'application/pdf');
  check('corrupt PDF -> 400', uBad.s === 400, JSON.stringify(uBad));
  const uBig = await upload(A, id, Buffer.concat([pdf, Buffer.alloc(5.5 * 1024 * 1024)]), 'big.pdf', 'application/pdf');
  check('> 5 MB -> 413', uBig.s === 413, JSON.stringify(uBig));
  const still = await download(A, id);
  check('failed uploads did not touch the stored PDF', still.s === 200 && still.buf.equals(pdf));

  const docx = await mkDocx('Snowflake Airflow Scala');
  const u2 = await upload(A, id, docx, 'asha.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  check('DOCX upload replaces PDF -> 201, text extracted', u2.s === 201 && u2.j?.text_extracted === true, JSON.stringify(u2));
  const s2 = await call(B, 'GET', '/search?q=snowflake');
  const s3 = await call(B, 'GET', `/search?q=${pdfWord}`);
  check('new text searchable, old PDF text gone', s2.j?.rows?.length === 1 && s3.j?.rows?.length === 0, `${s2.j?.rows?.length}/${s3.j?.rows?.length}`);
  const dd = await download(A, id);
  check('download now returns the DOCX', dd.s === 200 && dd.buf.equals(docx), `${dd.s} ${dd.type}`);

  const del = await call(A, 'DELETE', `/${id}/resume`);
  const gone = await download(A, id);
  const s4 = await call(B, 'GET', '/search?q=snowflake');
  check('delete resume -> file gone (404) and text cleared from search', del.s === 200 && gone.s === 404 && s4.j?.rows?.length === 0, `${del.s}/${gone.s}/${s4.j?.rows?.length}`);

  await upload(A, id, pdf, 'again.pdf', 'application/pdf');
  const delP = await call(A, 'DELETE', '/' + id);
  const { rows: [left] } = await q('SELECT count(*)::int AS n FROM consultant_resumes WHERE consultant_id = $1', [id]);
  check('deleting profile cascades to resume row', delP.s === 200 && left.n === 0, `${delP.s}/${left.n}`);
} catch (e) {
  console.error('ERROR:', e.stack || e.message); results.push(false);
} finally {
  await q("DELETE FROM tenants WHERE name LIKE 'ZZTEST %'");
  if (server) server.close();
  await pool.end();
  console.log(results.length && results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
}