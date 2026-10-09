import { createHash } from 'node:crypto';
import { IPTC_DIGITAL_SOURCE, PluginError, HTML_MEDIA_TYPE, MAX_HTML_BYTES, inspectHTML, isHTMLArtifact } from '@inspr/aithema-core';
export const promptDigest = prompt => `sha256:${createHash('sha256').update(prompt).digest('hex')}`;
const digestOf = bytes => `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
const TAG_BODY = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const PROVENANCE = /<!--\s*aithema-provenance:[\s\S]*?-->\n?/gu;
const fail = (code = 'invalid-output') => { throw new PluginError(code); };
/** Model text → one document. Repairs only remove capability; anything else is rejected later. */
export function repairHTML(content) {
  if (typeof content !== 'string') return fail();
  const source = content.replace(/^﻿/u, ''), start = source.search(/<!doctype html>/iu);
  const end = source.toLowerCase().lastIndexOf('</html>');
  if (start < 0 || end < start) return fail();
  return source.slice(start, end + '</html>'.length)
    .replace(PROVENANCE, '')
    .replace(new RegExp(`<link\\b${TAG_BODY}>`, 'giu'), '')
    .replace(new RegExp(`<meta\\b(?=${TAG_BODY}\\bhttp-equiv\\b)${TAG_BODY}>`, 'giu'), '')
    .replace(/@import\b[^;{}<]*;/giu, '')
    .replace(/(\shref\s*=\s*)(["'])(?:https?:)?\/\/[^"']*\2/giu, '$1$2#$2');
}
/** A previous dummy for edit: exact shape, current policy and a matching digest. */
export function previousDocument(artifact) {
  if (!isHTMLArtifact(artifact) || !inspectHTML(artifact.bytes).ok ||
    artifact.provenance.subject.contentDigest !== digestOf(artifact.bytes)) return fail();
  return new TextDecoder().decode(artifact.bytes).replace(PROVENANCE, '');
}
export function htmlArtifact(html, { prompt, model, operation, now = Date.now() }) {
  const origin = operation === 'edit' ? 'ai-manipulated' : 'ai-generated';
  const provenance = { version: 1, origin, modality: 'html',
    digitalSourceType: IPTC_DIGITAL_SOURCE[operation === 'edit' ? 'manipulated' : 'generated'], generatedAt: new Date(now).toISOString(),
    generator: { provider: 'openrouter', model }, techniques: ['embedded-metadata', 'response-field'],
    assurances: { digitallySigned: false, imperceptibleWatermark: 'provider-status-unknown' } };
  // The record follows the doctype so the document keeps standards mode.
  const record = Buffer.from(JSON.stringify(provenance)).toString('base64url');
  const marked = html.replace(/^<!doctype html>\s*/iu, `<!doctype html>\n<!-- aithema-provenance: ${record} -->\n`);
  const bytes = new TextEncoder().encode(marked);
  if (bytes.byteLength > MAX_HTML_BYTES) return fail('limit');
  if (!inspectHTML(bytes).ok) return fail();
  return { bytes, mediaType: HTML_MEDIA_TYPE, promptDigest: promptDigest(prompt),
    provenance: { ...provenance, subject: { contentDigest: digestOf(bytes), mediaType: HTML_MEDIA_TYPE } } };
}
