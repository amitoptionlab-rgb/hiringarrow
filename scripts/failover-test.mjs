// Checks provider failover. Run with: MAIL_DRIVER=smtp SMTP_URL=smtp://127.0.0.1:9 SMTP_URL_FALLBACK=log node scripts/failover-test.mjs
const { sendMail } = await import('../src/lib/mailer.js');
const t0 = Date.now();
const a = await sendMail({ from: 'a@x.test', to: 'b@y.test', subject: 'hi', text: 'hi' });
const t1 = Date.now();
const b = await sendMail({ from: 'a@x.test', to: 'b@y.test', subject: 'hi', text: 'hi' });
const ok = a.via === 'fallback' && b.via === 'fallback' && Date.now() - t1 < 2000;
console.log(`${ok ? 'PASS' : 'FAIL'}  primary down -> fallback used (first ${t1 - t0}ms, second ${Date.now() - t1}ms, skips dead primary)`);
process.exit(ok ? 0 : 1);
