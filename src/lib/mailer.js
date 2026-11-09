import nodemailer from 'nodemailer';
import { config } from '../config.js';

const make = (url) => (url === 'log'
  ? nodemailer.createTransport({ jsonTransport: true })
  : nodemailer.createTransport(url, { pool: true, maxConnections: 5, maxMessages: 200, connectionTimeout: 8000, greetingTimeout: 8000 }));
const primary = make(config.mailDriver === 'smtp' ? config.smtpUrl : 'log');
const fallback = config.smtpFallbackUrl ? make(config.smtpFallbackUrl) : null;
let primaryDownUntil = 0;

// Connection-level failures and provider throttling mean "try the other provider".
// Recipient-level errors (bad mailbox, greylisting) must NOT fail over.
const providerProblem = (e) => ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED', 'EDNS', 'ENOTFOUND', 'EAUTH'].includes(e.code) || [421, 454, 530, 535].includes(e.responseCode);

// SES SMTP answers "250 Ok <message-id>", which is the id its SNS events use.
export function providerId(info) {
  const m = /^250 Ok ([\w-]+)/i.exec(info.response || '');
  return m ? m[1] : info.messageId;
}

export async function sendMail(opts) {
  const useFallbackFirst = fallback && Date.now() < primaryDownUntil;
  const order = useFallbackFirst ? [['fallback', fallback], ['primary', primary]] : [['primary', primary], ...(fallback ? [['fallback', fallback]] : [])];
  let lastErr;
  for (const [via, t] of order) {
    try {
      const info = await t.sendMail(opts);
      return { info, providerMsgId: providerId(info), via };
    } catch (e) {
      lastErr = e;
      if (!providerProblem(e)) throw e;
      if (via === 'primary') { primaryDownUntil = Date.now() + 60_000; console.warn(`[mail] primary provider failed (${e.code || e.responseCode}), trying fallback`); }
    }
  }
  throw lastErr;
}
