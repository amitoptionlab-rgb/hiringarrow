import { htmlToText } from 'html-to-text';
import { config } from '../config.js';

const SPAM_WORDS = ['free money', 'act now', 'click here', 'buy now', '100% free', 'risk free', 'winner', 'congratulations', 'guaranteed', 'no obligation', 'cash bonus', 'earn $', 'make money fast', 'double your', 'limited time', 'urgent', 'viagra', 'lottery', 'credit card required', 'once in a lifetime'];
const SHORTENERS = /https?:\/\/(bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at)\//i;

export function subjectChecks(subject) {
  const errors = [], warnings = [];
  let score = 0;
  const bump = (n) => { score += n; };
  const subj = String(subject || '').trim();
  if (!subj) errors.push('Add a subject line.');
  if (subj.length > 120) { warnings.push('Subject is over 120 characters and may be cut off.'); bump(1); }
  const letters = subj.replace(/[^a-z]/gi, '');
  if (letters.length > 6 && subj.replace(/[^A-Z]/g, '').length / letters.length > 0.6) { warnings.push('Subject is mostly capital letters.'); bump(2); }
  if ((subj.match(/!/g) || []).length > 1) { warnings.push('Subject has several exclamation marks.'); bump(1.5); }
  if (/^(re|fwd?):/i.test(subj)) { errors.push('Subject starts with a fake "Re:" or "Fwd:". Remove it.'); }

  return { errors, warnings, score };
}

export function preflight({ subject, subjectB, html, fromEmail, tenant, domain }) {
  const errors = [], warnings = [];
  let score = 0;
  const bump = (n) => { score += n; };

  const subj = String(subject || '').trim();
  const sa = subjectChecks(subject);
  errors.push(...sa.errors); warnings.push(...sa.warnings); bump(sa.score);
  if (subjectB !== undefined && subjectB !== null && String(subjectB).trim()) {
    const sb = subjectChecks(subjectB);
    errors.push(...sb.errors.map((e) => 'Subject B: ' + e)); warnings.push(...sb.warnings.map((w) => 'Subject B: ' + w)); bump(sb.score / 2);
  }

  const h = String(html || '');
  const text = htmlToText(h, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] }).trim();
  const lower = (subj + ' ' + text).toLowerCase();
  const hits = SPAM_WORDS.filter((w) => lower.includes(w));
  if (hits.length) { warnings.push(`Spam-trigger phrases found: ${hits.slice(0, 5).join(', ')}.`); bump(Math.min(hits.length * 1.2, 4)); }

  if (text.length < 40) { errors.push('The email has almost no text. Image-only emails land in spam. Add real copy.'); }
  const imgs = (h.match(/<img\b/gi) || []).length;
  if (imgs > 0 && text.length / imgs < 80) { warnings.push('Many images for the amount of text.'); bump(1.5); }
  const links = h.match(/href=["']https?:\/\/[^"']+/gi) || [];
  if (links.length > 15) { warnings.push(`${links.length} links is a lot. Keep it under 15.`); bump(1.5); }
  if (SHORTENERS.test(h)) { errors.push('Remove URL shorteners (bit.ly etc). Mail providers flag them.'); }
  if (/<script\b|<iframe\b|<form\b/i.test(h)) { errors.push('Scripts, iframes and forms are blocked by inboxes. Remove them.'); }
  if (/\.(exe|zip|scr|js)(["'?])/i.test(h)) { warnings.push('Links to executable or archive files look suspicious.'); bump(2); }

  if (!tenant?.postal_address?.trim()) errors.push('Add your business postal address in Settings. It is required in every footer.');
  if (!/{{\s*unsubscribe_url\s*}}/i.test(h)) warnings.push('No {{unsubscribe_url}} in your HTML. An unsubscribe footer will be added automatically.');

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromEmail || '')) errors.push('Enter a valid From address.');
  const fromDomain = String(fromEmail || '').split('@')[1]?.toLowerCase();
  if (/^(gmail|yahoo|outlook|hotmail|rediffmail)\./.test(fromDomain || '')) errors.push('Do not send from a free mailbox domain (gmail, yahoo…). Use your own domain, or DMARC will reject it.');
  if (config.requireDomainVerified) {
    if (!domain) errors.push(`Add ${fromDomain || 'your sending domain'} under Domains first.`);
    else if (!domain.verified_at) errors.push(`${domain.domain} is not verified yet. Run the DNS check under Domains.`);
    else if (!domain.dmarc_ok) warnings.push('No DMARC record found. Gmail and Yahoo expect one for bulk senders.');
  }

  score = Math.min(10, Math.round(score * 10) / 10);
  if (score >= 7) errors.push(`Spam score is ${score}/10. Fix the warnings above before sending.`);
  return { score, errors, warnings, ok: errors.length === 0 };
}
