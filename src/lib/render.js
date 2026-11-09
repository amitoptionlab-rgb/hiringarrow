import { htmlToText } from 'html-to-text';
import { config } from '../config.js';
import { signLink } from './tokens.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const b64 = (s) => Buffer.from(s).toString('base64url');

export function renderMessage({ html, preheader, contact, messageId, unsubUrl, address }) {
  const vars = {
    first_name: contact.first_name, last_name: contact.last_name, email: contact.email,
    ...(contact.custom_fields || {}),
  };
  html = html.replace(/<!--dk-blocks:[A-Za-z0-9+/=_-]*-->/g, '');
  const hasUnsub = /{{\s*unsubscribe_url\s*}}/i.test(html);
  let out = html.replace(/{{\s*([a-z0-9_]+)\s*(?:\|\s*([^}]*?))?\s*}}/gi, (_, key, fallback) => {
    const k = key.toLowerCase();
    if (k === 'unsubscribe_url') return unsubUrl;
    if (k === 'postal_address') return esc(address);
    const v = vars[k];
    return esc(v !== undefined && v !== null && String(v).trim() !== '' ? v : (fallback ?? '').trim());
  });

  if (preheader) out = `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>` + out;

  // click tracking: signed so the redirect cannot be abused as an open redirect
  out = out.replace(/href=(["'])(https?:\/\/[^"']+)\1/gi, (m, q, url) => {
    if (url === unsubUrl || url.startsWith(`${config.baseUrl}/u/`)) return m;
    const clean = url.replace(/&amp;/g, '&');
    return `href=${q}${config.baseUrl}/t/c/${messageId}?u=${b64(clean)}&s=${signLink(messageId, clean)}${q}`;
  });

  if (!hasUnsub) {
    const footer = `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #ddd;font:12px/1.5 Arial,sans-serif;color:#777;text-align:center">${esc(address)}<br>You are receiving this because you subscribed. <a href="${unsubUrl}" style="color:#777">Unsubscribe</a></div>`;
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, () => footer + '</body>') : out + footer;
  }
  const pixel = `<img src="${config.baseUrl}/t/o/${messageId}.gif" width="1" height="1" alt="" style="display:none">`;
  out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, () => pixel + '</body>') : out + pixel;

  const text = htmlToText(out, { wordwrap: 100, selectors: [{ selector: 'img', format: 'skip' }, { selector: 'a', options: { ignoreHref: false, hideLinkHrefIfSameAsText: true } }] });
  return { html: out, text };
}
