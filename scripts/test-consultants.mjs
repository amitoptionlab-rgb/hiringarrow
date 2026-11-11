import express from 'express';
import { q, pool } from '../src/db.js';
import { consultants } from '../src/consultants.js';

const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   -> ' + extra}`); };
const mk = async (label) => {
  const { rows: [t] } = await q("INSERT INTO tenants (name, status) VALUES ($1, 'active') RETURNING id", [`ZZTEST ${label}`]);
  const { rows: [u] } = await q("INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, 'x', 'owner') RETURNING id", [t.id, `zztest-${label}-${Date.now()}@example.invalid`]);
  return { tid: t.id, uid: u.id };
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
  const call = async (who, method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-tid': who.tid, 'x-uid': who.uid }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    return { s: r.status, j };
  };

  const c1 = await call(A, 'POST', '/', { full_name: 'Ravi Kumar', title: 'Senior Java Developer', skills: 'Java, Spring Boot, AWS', experience_yrs: 9, work_auth: 'h1b', engagement: 'c2c,w2', rate_usd_hr: 65, city: 'Dallas', state: 'TX', relocate: true, contact_email: 'ravi@example.com', contact_phone: '+1 555 123 4567', resume_text: 'Built Kafka pipelines. Reach me at ravi.k@gmail.com or +1 (555) 987-6543.' });
  const id = c1.j?.id;
  check('create -> 201 + id', c1.s === 201 && id, JSON.stringify(c1));
  const badRes = await call(A, 'POST', '/', { full_name: 'X', title: 'Y', work_auth: 'XYZ' });
  check('invalid work_auth -> 400', badRes.s === 400, JSON.stringify(badRes));

  const s1 = await call(B, 'GET', '/search?q=java%20kafka');
  const row = s1.j?.rows?.[0];
  check('B finds it via resume text', s1.j?.rows?.length === 1 && row?.id === id, JSON.stringify(s1));
  check('name masked for B', row?.full_name === 'Ravi K.', row?.full_name);
  check('no contact/tenant/resume fields in search rows', row && !('contact_email' in row) && !('contact_phone' in row) && !('tenant_id' in row) && !('resume_text' in row), Object.keys(row || {}).join(','));
  const s2 = await call(B, 'GET', '/search?q=java%20-kafka');
  check('exclusion (java -kafka) -> 0', s2.j?.rows?.length === 0, JSON.stringify(s2.j));
  const s3 = await call(B, 'GET', '/search?work_auth=H1B&engagement=C2C&max_rate=70&state=tx&skills=java,aws');
  check('filters match (H1B, C2C, <=70, TX, java+aws)', s3.j?.rows?.length === 1, JSON.stringify(s3.j));
  const s4 = await call(B, 'GET', '/search?max_rate=50');
  check('max_rate=50 -> 0', s4.j?.rows?.length === 0, JSON.stringify(s4.j));

  const d = await call(B, 'GET', '/' + id);
  check('detail hides email/phone, masks resume', d.s === 200 && d.j.resume_text.includes('[email hidden]') && d.j.resume_text.includes('[phone hidden]') && !d.j.resume_text.includes('gmail') && !d.j.resume_text.includes('987') && !('contact_email' in d.j), JSON.stringify(d.j));
  const put = await call(B, 'PUT', '/' + id, { title: 'Hacked' });
  const del = await call(B, 'DELETE', '/' + id);
  check("B cannot edit/delete A's profile (404)", put.s === 404 && del.s === 404, `${put.s}/${del.s}`);

  const mine = await call(A, 'GET', '/mine');
  check('A sees own contact details', mine.j?.rows?.length === 1 && mine.j.rows[0].contact_email === 'ravi@example.com', JSON.stringify(mine.j));
  const up = await call(A, 'PUT', '/' + id, { visibility: 'private' });
  const s5 = await call(B, 'GET', '/search?q=java');
  const d2 = await call(B, 'GET', '/' + id);
  check('private -> hidden from B (search 0, detail 404)', up.s === 200 && s5.j?.rows?.length === 0 && d2.s === 404, `${up.s}/${s5.j?.rows?.length}/${d2.s}`);
  const delA = await call(A, 'DELETE', '/' + id);
  const mine2 = await call(A, 'GET', '/mine');
  check('A can delete own', delA.s === 200 && mine2.j?.total === 0, JSON.stringify(mine2.j));
} catch (e) {
  console.error('ERROR:', e.message); results.push(false);
} finally {
  await q("DELETE FROM tenants WHERE name LIKE 'ZZTEST %'");
  if (server) server.close();
  await pool.end();
  console.log(results.length && results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
}
