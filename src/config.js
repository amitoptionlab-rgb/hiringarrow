const e = process.env;
// Dev defaults allowed ONLY when NODE_ENV is explicitly development/test. Unset or misspelled NODE_ENV is treated as production.
const devMode = e.NODE_ENV === 'development' || e.NODE_ENV === 'test';
export const config = {
  port: +e.PORT || 3000,
  prod: !devMode,
  databaseUrl: e.DATABASE_URL || 'postgres://mail:mail@localhost:5432/hiringarrow',
  redisUrl: e.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: e.JWT_SECRET || 'dev-jwt-secret-change-me',
  signSecret: e.SIGN_SECRET || 'dev-sign-secret-change-me',
  baseUrl: (e.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  adminKey: e.ADMIN_KEY || '',
  autoApprove: e.AUTO_APPROVE === 'true',          // dev only: skip manual tenant review
  mailDriver: e.MAIL_DRIVER || 'log',              // 'smtp' (SES/Mailpit) or 'log' (no network)
  smtpUrl: e.SMTP_URL || '',
  smtpFallbackUrl: e.SMTP_URL_FALLBACK || '',      // second provider used when the first is down ('log' = test sink)
  // Writing help is free and built in. Optionally point it at any OpenAI-compatible endpoint (e.g. a local Ollama: http://localhost:11434/v1).
  ai: { baseUrl: (e.AI_BASE_URL || '').replace(/\/$/, ''), model: e.AI_MODEL || 'llama3.1', key: e.AI_API_KEY || '' },
  systemFrom: e.SYSTEM_FROM || 'no-reply@localhost',
  sendRatePerSec: +e.SEND_RATE_PER_SEC || 10,
  requireDomainVerified: e.REQUIRE_DOMAIN_VERIFIED === 'true',
  verifyMx: e.VERIFY_MX === 'true',
  oneCompanyPerDomain: e.ONE_COMPANY_PER_DOMAIN !== 'false',   // a verified company domain can only have one account
  blockFreeEmail: e.BLOCK_FREE_EMAIL !== 'false',   // signups need a company email; set BLOCK_FREE_EMAIL=false to allow free emails
  requireEmailVerify: e.REQUIRE_EMAIL_VERIFY === 'true',   // new signups must confirm their email before the first login
  brevo: { webhookSecret: e.BREVO_WEBHOOK_SECRET || '' },       // protects POST /webhooks/brevo
  snsVerify: e.SNS_VERIFY !== 'false',
  razorpay: {
    keyId: e.RAZORPAY_KEY_ID || '',
    keySecret: e.RAZORPAY_KEY_SECRET || '',
    webhookSecret: e.RAZORPAY_WEBHOOK_SECRET || '',
  },
  // auto-pause thresholds (Gmail/Yahoo want complaint rate well under 0.3%)
  circuit: { complaintRate: 0.001, bounceRate: 0.05, minSample: 100 },
};
if (config.prod) {
  const bad = [];
  if (config.jwtSecret.startsWith('dev-') || config.jwtSecret.length < 32) bad.push('JWT_SECRET');
  if (config.signSecret.startsWith('dev-') || config.signSecret.length < 32) bad.push('SIGN_SECRET');
  if (config.adminKey && config.adminKey.length < 32) bad.push('ADMIN_KEY');
  if (config.mailDriver === 'smtp' && !config.smtpUrl) bad.push('SMTP_URL');
  if (config.mailDriver !== 'smtp') bad.push('MAIL_DRIVER=smtp (now "' + config.mailDriver + '": mails would be marked sent without leaving)');
  if (!e.DATABASE_URL) bad.push('DATABASE_URL');
  if (!e.REDIS_URL) bad.push('REDIS_URL');
  if (!e.BASE_URL || !/^https:\/\//.test(config.baseUrl) || /localhost|127\.0\.0\.1/.test(config.baseUrl)) bad.push('BASE_URL (public https URL, used in every unsubscribe/tracking link)');
  if (!e.SYSTEM_FROM || /localhost/.test(config.systemFrom)) bad.push('SYSTEM_FROM');
  if (config.autoApprove) bad.push('AUTO_APPROVE (must not be true in production)');
  if (!config.snsVerify) bad.push('SNS_VERIFY (must not be false in production)');
  if (config.smtpFallbackUrl === 'log') bad.push('SMTP_URL_FALLBACK (must not be "log" in production)');
  if (!config.requireDomainVerified) bad.push('REQUIRE_DOMAIN_VERIFIED=true (otherwise any From domain is accepted and new domains skip the warm-up limits)');
  if (bad.length) throw new Error('Set these env vars for production: ' + bad.join(', '));
}
