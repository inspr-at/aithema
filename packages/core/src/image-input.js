import { processingScope } from './presets.js';
import { PluginError } from './invocation.js';

export const IMAGE_INPUT_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const stagedImage = upload => upload?.kind === 'image' && upload.state?.startsWith('staged-');
export const imageReferences = request => (request.messages ?? []).flatMap(message => message.images ?? []);
export function validateImageInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['maxImages', 'maxTokensPerImage', 'perImageMicro'].includes(key)) ||
    !Number.isSafeInteger(value.maxImages) || value.maxImages < 1 || value.maxImages > 4 ||
    !Number.isSafeInteger(value.maxTokensPerImage) || value.maxTokensPerImage < 1 ||
    value.perImageMicro !== undefined && (!Number.isSafeInteger(value.perImageMicro) || value.perImageMicro < 0)) throw new TypeError('Invalid image input capability');
  return value;
}
/** Exact legacy text estimate, plus a qualified image-token ceiling. References and pixels are never text tokens. */
export function reasoningInputBound(value, capability) {
  const messages = Array.isArray(value) ? value : value.messages ?? [];
  const images = messages.flatMap(message => message.images ?? []);
  if (images.length) {
    try { validateImageInput(capability); } catch { throw new PluginError('not-admitted', 'image input capability required'); }
    if (images.length > capability.maxImages) throw new PluginError('not-admitted', 'image input limit exceeded');
  }
  const plain = messages.map(message => {
    const { images, ...rest } = message;
    // Wire image parts can only be created after admission by the adapter.
    if (Array.isArray(rest.content) && rest.content.some(part => part.type !== 'text')) throw new PluginError('not-admitted', 'image input references required');
    return rest;
  });
  const text = Array.isArray(value) ? plain : { ...value, messages: plain };
  const bytes = new TextEncoder().encode(JSON.stringify(text)).byteLength;
  const total = bytes + images.length * (capability?.maxTokensPerImage ?? 0);
  if (!Number.isSafeInteger(total)) throw new PluginError('not-admitted', 'image input bound exceeded');
  return total;
}
export const imageInputFee = (request, capability) => {
  const count = imageReferences(request).length;
  if (count) reasoningInputBound(request, capability);
  const fee = count * (capability?.perImageMicro ?? 0);
  if (!Number.isSafeInteger(fee)) throw new PluginError('not-admitted', 'image input cost exceeded');
  return fee;
};
/** Separate optional purpose, with the exact reasoning binding's recipient chain. */
export function imageInputScope(binding, operation) {
  return { ...processingScope(binding, operation), purpose: 'image-input', itemVersion: 1,
    dataCategories: ['images', 'messages', 'conversation-history', 'assessment'] };
}
