import { createHash } from 'node:crypto';
import { IPTC_DIGITAL_SOURCE } from './ui-generation.js';
import { PluginError } from './invocation.js';
import { HTML_MEDIA_TYPE, MAX_HTML_BYTES, inspectHTML, isHTMLArtifact } from './ui-html.js';
export const promptDigest = prompt => `sha256:${createHash('sha256').update(prompt).digest('hex')}`;
const digestOf = bytes => `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
const PROVENANCE = /<!--\s*aithema-provenance:[\s\S]*?-->\n?/gu;
const fail = (code = 'invalid-output') => { throw new PluginError(code); };
/** A previous dummy for edit: exact shape, current policy and a matching digest. */
export function previousDocument(artifact) {
  if (!isHTMLArtifact(artifact) || !inspectHTML(artifact.bytes).ok ||
    artifact.provenance.subject.contentDigest !== digestOf(artifact.bytes)) return fail();
  return new TextDecoder().decode(artifact.bytes).replace(PROVENANCE, '');
}
export function htmlArtifact(html, { prompt, model, operation, provider, now = Date.now() }) {
  const origin = operation === 'edit' ? 'ai-manipulated' : 'ai-generated';
  const provenance = { version: 1, origin, modality: 'html',
    digitalSourceType: IPTC_DIGITAL_SOURCE[operation === 'edit' ? 'manipulated' : 'generated'], generatedAt: new Date(now).toISOString(),
    generator: { provider, model }, techniques: ['embedded-metadata', 'response-field'],
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
