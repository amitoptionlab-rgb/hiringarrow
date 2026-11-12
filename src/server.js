import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool } from './db.js';
import { api } from './api.js';
import { pub } from './public.js';
import { webhooks } from './webhooks.js';
import { admin } from './admin.js';
import { v1 } from './v1.js';
import { mcp } from './mcp.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      frameSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: null,   // would break plain-http local dev
    },
  },
}));

app.use('/webhooks', webhooks);                      // these parse their own raw bodies
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.get('/health', async (req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); });
app.use('/api', api);
app.use('/admin', admin);
app.use('/v1', v1);
app.use('/mcp', mcp);
app.use(pub);
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request body.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

app.listen(config.port, () => console.log(`App on ${config.baseUrl} (port ${config.port}, mail driver: ${config.mailDriver})`));
