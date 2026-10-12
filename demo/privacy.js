import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export const MAX_PRIVACY_BYTES = 256 * 1024;
export const PRIVACY_CSP = "default-src 'none'; script-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const tags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'section', 'article', 'div', 'span', 'strong', 'em', 'b', 'i', 'small', 'abbr', 'blockquote', 'address', 'a', 'br', 'hr']);
const voidTags = new Set(['br', 'hr']);
const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const invalid = () => { throw new TypeError('Invalid privacy document'); };
function safeLink(value) {
  // No encoded attributes, network-path URLs, backslashes or control/space tricks.
  if (/[\s\u0000-\u001f\u007f&<>\\]/u.test(value)) return false;
  if (/^#[a-z0-9_-]+$/iu.test(value) || /^\/(?!\/)/u.test(value)) return true;
  if (/^mailto:[a-z0-9.!#$%'*+\-/=?^_`{|}~]+@[a-z0-9.-]+$/iu.test(value)) return true;
  try { const url = new URL(value); return value.startsWith('https://') && url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}
/** A deliberately small HTML fragment grammar, not the executable click-dummy
 * inspector. Unknown/malformed markup fails startup; accepted tags/attributes
 * are reconstructed so only the allowlist can reach the host page. */
function validateHTML(html) {
  if (!html.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(html)) invalid();
  const stack = [], output = [];
  const tagPattern = /<(\/?)([a-z][a-z0-9]*)([^<>]*)>/iy;
  const attrPattern = /\s+([a-z][a-z0-9-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/iy;
  let offset = 0;
  while (offset < html.length) {
    const next = html.indexOf('<', offset);
    if (next === -1) { output.push(html.slice(offset)); break; }
    output.push(html.slice(offset, next)); tagPattern.lastIndex = next;
    const match = tagPattern.exec(html); if (!match) invalid();
    const [, closing, rawTag, source] = match, tag = rawTag.toLowerCase();
    if (!tags.has(tag)) invalid();
    if (closing) {
      if (source.trim() || voidTags.has(tag) || stack.pop() !== tag) invalid();
      output.push(`</${tag}>`);
    } else {
      let attributes = source;
      if (attributes.endsWith('/')) { if (!voidTags.has(tag)) invalid(); attributes = attributes.slice(0, -1); }
      const seen = new Set(), attrs = [];
      let at = 0;
      while (attributes.slice(at).trim()) {
        attrPattern.lastIndex = at;
        const attr = attrPattern.exec(attributes); if (!attr) invalid();
        const name = attr[1].toLowerCase(), value = attr[2] ?? attr[3];
        if (seen.has(name) || !['id', 'lang', 'title', ...(tag === 'a' ? ['href'] : [])].includes(name)) invalid();
        if (name === 'href' && !safeLink(value) || name === 'id' && !/^[a-z][a-z0-9_-]*$/iu.test(value) ||
          name === 'lang' && !/^[a-z]{2}(?:-[a-z]{2})?$/iu.test(value)) invalid();
        seen.add(name); attrs.push(` ${name}="${escape(value)}"`); at = attrPattern.lastIndex;
      }
      output.push(`<${tag}${attrs.join('')}>`);
      if (!voidTags.has(tag)) stack.push(tag);
    }
    offset = tagPattern.lastIndex;
  }
  if (stack.length || !output.join('').replace(/<[^>]*>/gu, '').trim()) invalid();
  return output.join('');
}
async function readDocument(path) {
  if (typeof path !== 'string' || !path.trim()) invalid();
  let file;
  try {
    // Nonblocking open avoids hanging on a mistakenly configured FIFO. fstat
    // and bounded reads apply to the same handle, including file-change races.
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_PRIVACY_BYTES || stat.size === 0) invalid();
    const bytes = Buffer.alloc(MAX_PRIVACY_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_PRIVACY_BYTES) invalid();
    return validateHTML(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } catch { invalid(); }
  finally { await file?.close(); }
}

/** Deployment documents are validated once, before DB/provider startup. File
 * paths never appear in the public config; a restart applies document changes. */
export async function loadPrivacyDocuments(paths = {}) {
  const documents = new Map();
  for (const [locale, path] of Object.entries(paths)) if (path !== undefined) documents.set(locale, await readDocument(path));
  const configured = documents.size > 0;
  const config = configured ? Object.freeze({ url: '/privacy' }) : null;
  return { config, privacyDocumentConfigured: () => configured,
    handle(request) {
      const url = new URL(request.url);
      if (!['/privacy', '/privacy/'].includes(url.pathname)) return null;
      if (!configured) return new Response(null, { status: 404 });
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
      const locale = url.searchParams.get('locale') === 'en' ? 'en' : 'de';
      const content = documents.get(url.searchParams.get('locale')) ?? documents.get('default') ?? documents.get('de') ?? documents.get('en');
      const title = locale === 'de' ? 'Datenschutzerklärung' : 'Privacy policy';
      const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/demo/host.css"></head><body><header class="masthead"><a class="wordmark" href="/">Aithema</a></header><main class="privacy-page">${content}</main></body></html>`;
      return new Response(request.method === 'HEAD' ? null : html, { headers: { 'content-type': 'text/html; charset=utf-8',
        'content-security-policy': PRIVACY_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    },
  };
}
