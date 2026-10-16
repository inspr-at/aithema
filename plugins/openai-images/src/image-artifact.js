import { PluginError, MAX_IMAGE_BYTES } from '@inspr/aithema-core';
import { imageArtifact as createArtifact } from '@inspr/aithema-core/ui-image-artifact';
export { promptDigest } from '@inspr/aithema-core/ui-image-artifact';
export function imageArtifact(bytes, options) {
  const provider = options.provider === undefined ? 'openai' : options.provider;
  return createArtifact(bytes, { ...options, provider, watermark: provider === 'openai'
    ? { status: 'provider-declared', source: 'OpenAI declares SynthID on API images: https://help.openai.com/en/articles/8912793' }
    : { status: 'unknown', source: null } });
}
const fail = () => { throw new PluginError('invalid-output'); };
export function decodeImage(encoded) {
  if (typeof encoded !== 'string' || !encoded.length) return fail();
  if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new PluginError('limit');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) return fail();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return fail();
  return new Uint8Array(bytes);
}
