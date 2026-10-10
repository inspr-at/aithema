import { createHash } from 'node:crypto';
import { IPTC_DIGITAL_SOURCE, PluginError, imageInfo, imageCredentials, MAX_IMAGE_BYTES } from '@inspr/aithema-core';
export const promptDigest = prompt => `sha256:${createHash('sha256').update(prompt).digest('hex')}`;
const fail = () => { throw new PluginError('invalid-output'); };
export function decodeImage(encoded) {
  if (typeof encoded !== 'string' || !encoded.length) return fail();
  if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new PluginError('limit');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) return fail();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return fail();
  return new Uint8Array(bytes);
}
// Keep provider bytes intact: metadata injection can invalidate upstream C2PA signatures.
export function imageArtifact(bytes, { prompt, model, operation, provider = 'openai', now = Date.now() }) {
  const info = imageInfo(bytes), digest = promptDigest(prompt);
  const provenance = { version: 1, origin: operation === 'edit' ? 'ai-manipulated' : 'ai-generated', modality: 'image',
    digitalSourceType: IPTC_DIGITAL_SOURCE[operation === 'edit' ? 'manipulated' : 'generated'], generatedAt: new Date(now).toISOString(),
    generator: { provider, model }, promptDigest: digest, techniques: ['response-field', 'sidecar'],
    credentials: provider === 'local-demo-fake' ? { c2pa: 'absent', manifestByteLength: 0, verification: 'not-verified' } : imageCredentials(bytes),
    assurances: { digitallySigned: false, imperceptibleWatermark: provider === 'openai' ? 'provider-declared' : 'unknown',
      watermarkSource: provider === 'openai' ? 'OpenAI declares SynthID on API images: https://help.openai.com/en/articles/8912793' : null } };
  return { bytes: new Uint8Array(bytes), mediaType: info.mediaType, width: info.width, height: info.height, promptDigest: digest,
    provenance: { ...provenance, subject: { contentDigest: `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`, mediaType: info.mediaType } } };
}
