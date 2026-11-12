import pg from 'pg';
import { config } from './config.js';

// DATE (OID 1082) ko JS Date nahi, plain 'YYYY-MM-DD' string rakho.
// Warna non-UTC server (IST) par local-midnight Date UTC JSON mein ek din peeche chala jaata hai.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on('error', (e) => console.error('[pg] idle client error:', e.message));
export const q = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
