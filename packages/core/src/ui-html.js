// HTML click-dummy artifacts (AIT-113): one self-contained UTF-8 document.
// inspectHTML is a static policy for well-behaved output and defense in depth;
// the enforcement boundary is the sandboxed, CSP-locked preview frame.
import { IPTC_DIGITAL_SOURCE } from './ui-generation.js';
export const HTML_MEDIA_TYPE = 'text/html';
export const HTML_PREVIEW_HOST_CSP = "frame-src 'none'; child-src 'none'";
export const MAX_HTML_BYTES = 512 * 1024;
export const HTML_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
  "img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
/** Charset follows the doctype, then CSP precedes all untrusted content. Standalone exports disable scripts too:
 * meta CSP cannot supply the preview's opaque-origin sandbox/host navigation gate.
 * inspectHTML permits only fragment links and rejects refresh/embedded documents.
 */
export function frameDocument(html, { standalone = false } = {}) {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><meta name="referrer" content="no-referrer">${
    standalone ? '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'">' : ''}${html.replace(/^\s*<!doctype[^>]*>/iu, '')}`;
}
export const HTML_PROBLEMS = Object.freeze(['empty', 'size', 'utf-8', 'control-character', 'document', 'external-reference',
  'base', 'http-equiv', 'form', 'embedded-content', 'module-script', 'network-api', 'storage', 'navigation', 'obfuscation']);
const exactKeys = (value, keys) => value && typeof value === 'object' &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
// XML namespace names are identifiers, never fetched.
const NAMESPACES = /http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink|1999\/xhtml|XML\/1998\/namespace)/gu;
const EMBEDDING = new Set(['base', 'link', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal', 'fencedframe']);
const FETCHING = new Set(['srcset', 'imagesrcset', 'ping', 'background', 'lowsrc', 'dynsrc', 'codebase', 'archive', 'manifest', 'srcdoc']);
const SCRIPT_TYPES = ['', 'text/javascript', 'application/javascript', 'application/json', 'application/ld+json'];
const ATTRS = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
const RAW = /<!--[\s\S]*?-->|<(script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\1\s*>/giu;
const TAG = /<([a-z][a-z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/giu;
const JS_RULES = [
  ['network-api', /\bfetch\s*\(|\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|SharedWorker|serviceWorker|RTCPeerConnection|WebTransport)\b|\bnew\s+Worker\b|\bimport\s*\(|\bwindow\s*\.\s*open\b|\.opener\b/u],
  ['storage', /\b(?:localStorage|sessionStorage|indexedDB)\b|\bdocument\s*\.\s*cookie\b/u],
  ['navigation', /\b(?:window|document|self|globalThis|top|parent)\s*\.\s*location\b(?!\s*\.\s*hash\b)|(?<![\w$.'"`-])location\s*(?:\.\s*(?:href|assign|replace|reload)\b|=(?!=))|\.(?:src|poster)\s*=\s*["'`](?!data:image\/)|\.href\s*=\s*["'`](?!#)/u],
  ['obfuscation', /\beval\s*\(|\bFunction\s*\(|\batob\s*\(|\bfromCharCode\b|\bset(?:Timeout|Interval)\s*\(\s*["'`]|\\x[2-7][0-9a-f]|\\u00[2-7][0-9a-f]|\\u\{0*[2-7][0-9a-f]\}/iu],
];
function css(text, fail) {
  if (/@import\b|image-set\(\s*["']/iu.test(text)) fail('external-reference');
  for (const [, value] of text.matchAll(/url\(\s*["']?\s*([^"')\s]*)/giu)) if (!/^(?:#|data:)/iu.test(value)) fail('external-reference');
  // Escaped letters, digits or URL punctuation only serve to hide url( or @import.
  for (const [escape, hex] of text.matchAll(/\\([0-9a-f]{1,6}\s?|[g-z():/@.])/giu)) {
    const char = /^[0-9a-f]/iu.test(hex) ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : escape.slice(1);
    if (/[a-z0-9():/@.]/iu.test(char)) fail('obfuscation');
  }
}
const js = (text, fail) => { for (const [code, rule] of JS_RULES) if (rule.test(text)) fail(code); };
// Attribute character references are decoded by the HTML parser before handlers
// execute. Reject encoded executable attributes rather than guessing a partial
// named-entity table (numeric references may also omit their semicolon).
const ENCODED = /&(?:#(?:x[0-9a-f]+|[0-9]+);?|[a-z][a-z0-9]*;)/iu;
function attributes(tag, source, fail) {
  const seen = {};
  for (const [, rawName, ...values] of source.matchAll(ATTRS)) {
    const name = rawName.toLowerCase(), value = (values.find(v => v !== undefined) ?? '').trim();
    seen[name] = value;
    if (name === 'http-equiv') fail('http-equiv');
    else if (name === 'action' || name === 'formaction' || name === 'method' && value.toLowerCase() === 'post') fail('form');
    else if (FETCHING.has(name)) fail('external-reference');
    else if (name === 'href' || name.endsWith(':href')) { if (!value.startsWith('#')) fail('external-reference'); }
    else if (name === 'src' || name === 'poster') { if (tag === 'script' || !/^data:image\//iu.test(value)) fail('external-reference'); }
    else if (name === 'attributename' && /href|src/iu.test(value)) fail('external-reference');
    else if (name === 'style') { if (ENCODED.test(value)) fail('obfuscation'); css(value, fail); }
    else if (name.startsWith('on')) { if (ENCODED.test(value)) fail('obfuscation'); js(value, fail); }
  }
  return seen;
}
/** Static policy check of private HTML bytes; returns stable problem codes. */
export function inspectHTML(bytes) {
  const problems = new Set(), fail = code => problems.add(code);
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) return { ok: false, problems: ['empty'] };
  if (bytes.byteLength > MAX_HTML_BYTES) return { ok: false, problems: ['size'] };
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { ok: false, problems: ['utf-8'] }; }
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(text)) fail('control-character');
  const count = pattern => (text.match(pattern) ?? []).length;
  if (!/^<!doctype html>/iu.test(text) || !/<\/html>\s*$/iu.test(text) || count(/<!doctype\b/giu) !== 1 ||
    [/<html[\s>]/giu, /<\/html>/giu, /<head[\s>]/giu, /<body[\s>]/giu].some(p => count(p) !== 1)) fail('document');
  if (/\b(?:https?|wss?|ftp|file):\/\//iu.test(text.replace(NAMESPACES, ''))) fail('external-reference');
  if (/<base\b/iu.test(text)) fail('base');
  const markup = text.replace(RAW, (whole, kind, attrs = '', body = '') => {
    if (!kind) return ' ';
    const seen = attributes(kind.toLowerCase(), attrs, fail);
    if (kind.toLowerCase() === 'style') css(body, fail);
    else if (SCRIPT_TYPES.includes((seen.type ?? '').toLowerCase())) js(body, fail);
    else fail('module-script');
    return ' ';
  });
  if (/<!--|<(?:script|style)\b/iu.test(markup)) fail('document');
  // Every tag opener must start a well-formed tag; a swallowed one hides attributes.
  const starts = new Set();
  for (const { 1: name, 2: attrs, index } of markup.matchAll(TAG)) {
    starts.add(index); const tag = name.toLowerCase();
    if (EMBEDDING.has(tag)) fail(tag === 'base' ? 'base' : 'embedded-content');
    attributes(tag, attrs, fail);
  }
  for (const { index } of markup.matchAll(/<[a-z]/giu)) if (!starts.has(index)) fail('document');
  return { ok: problems.size === 0, problems: HTML_PROBLEMS.filter(code => problems.has(code)) };
}
/** Exact shape of an html ui-generation artifact; content is checked by verifyHTMLArtifact. */
export function isHTMLArtifact(artifact) {
  const p = artifact?.provenance;
  return Boolean(exactKeys(artifact, ['bytes', 'mediaType', 'promptDigest', 'provenance']) &&
    artifact.bytes instanceof Uint8Array && artifact.bytes.byteLength > 0 && artifact.bytes.byteLength <= MAX_HTML_BYTES &&
    artifact.mediaType === HTML_MEDIA_TYPE && /^sha256:[a-f0-9]{64}$/u.test(artifact.promptDigest) &&
    exactKeys(p, ['version', 'origin', 'modality', 'digitalSourceType', 'generatedAt', 'generator', 'techniques', 'assurances', 'subject']) &&
    p.version === 1 && p.modality === 'html' && ['ai-generated', 'ai-manipulated'].includes(p.origin) &&
    p.digitalSourceType === IPTC_DIGITAL_SOURCE[p.origin === 'ai-generated' ? 'generated' : 'manipulated'] &&
    typeof p.generatedAt === 'string' && Number.isFinite(Date.parse(p.generatedAt)) &&
    exactKeys(p.generator, ['provider', 'model']) && [p.generator.provider, p.generator.model].every(v => typeof v === 'string' && v.length > 0) &&
    Array.isArray(p.techniques) && p.techniques.includes('response-field') &&
    exactKeys(p.subject, ['contentDigest', 'mediaType']) && /^sha-256=:[A-Za-z0-9+/]{43}=:$/u.test(p.subject.contentDigest) &&
    p.subject.mediaType === HTML_MEDIA_TYPE && exactKeys(p.assurances, ['digitallySigned', 'imperceptibleWatermark']) &&
    p.assurances.digitallySigned === false && p.assurances.imperceptibleWatermark === 'provider-status-unknown');
}
export async function contentDigest(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha-256=:${btoa(String.fromCharCode(...digest))}:`;
}
/** Shape, static policy and subject digest against the actual bytes. */
export async function verifyHTMLArtifact(artifact) {
  if (!isHTMLArtifact(artifact) || !inspectHTML(artifact.bytes).ok) return false;
  return artifact.provenance.subject.contentDigest === await contentDigest(artifact.bytes);
}
