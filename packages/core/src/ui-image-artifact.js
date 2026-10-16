import { createHash } from 'node:crypto';
import { IPTC_DIGITAL_SOURCE } from './ui-generation.js';
import { imageInfo } from './image-info.js';
import { imageCredentials } from './image-credentials.js';
export const promptDigest = prompt => `sha256:${createHash('sha256').update(prompt).digest('hex')}`;
// Keep provider bytes intact: metadata injection can invalidate upstream C2PA signatures.
export function imageArtifact(bytes, { prompt, model, operation, provider, watermark = { status: 'unknown', source: null }, now = Date.now() }) {
  const info = imageInfo(bytes), digest = promptDigest(prompt);
  const provenance = { version: 1, origin: operation === 'edit' ? 'ai-manipulated' : 'ai-generated', modality: 'image',
    digitalSourceType: IPTC_DIGITAL_SOURCE[operation === 'edit' ? 'manipulated' : 'generated'], generatedAt: new Date(now).toISOString(),
    generator: { provider, model }, promptDigest: digest, techniques: ['response-field', 'sidecar'],
    credentials: provider === 'local-demo-fake' ? { c2pa: 'absent', manifestByteLength: 0, verification: 'not-verified' } : imageCredentials(bytes),
    assurances: { digitallySigned: false, imperceptibleWatermark: watermark.status,
      watermarkSource: watermark.source } };
  return { bytes: new Uint8Array(bytes), mediaType: info.mediaType, width: info.width, height: info.height, promptDigest: digest,
    provenance: { ...provenance, subject: { contentDigest: `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`, mediaType: info.mediaType } } };
}
