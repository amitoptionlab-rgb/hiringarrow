import fs from 'node:fs';
import { pool } from '../src/db.js';

const read = (f) => fs.readFileSync(new URL(`../db/${f}`, import.meta.url), 'utf8');
const { rows } = await pool.query("SELECT to_regclass('public.tenants') AS t");
if (rows[0].t) console.log('Base schema present.');
else { await pool.query(read('schema.sql')); console.log('Base schema created.'); }
for (const f of fs.readdirSync(new URL('../db/', import.meta.url)).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
  await pool.query(read(f)); console.log('Applied', f);
}
await pool.end();
