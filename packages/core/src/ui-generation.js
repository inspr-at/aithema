// START port: generated-ui.ts / provenance.ts, generic contract only (D3).
import { PluginError } from './invocation.js';
import { imageInfo } from './image-info.js';
export const MAX_UI_REFERENCES = 9;
const exactKeys = (value, keys) => value && typeof value === 'object' &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
/** Private bytes only, at most nine images of at most 12 MiB each. */
export function validateUIReferences(references = []) {
  if (!Array.isArray(references)) throw new PluginError('invalid-output');
  if (references.length > MAX_UI_REFERENCES) throw new PluginError('limit');
  for (const reference of references) {
    if (!exactKeys(reference, ['bytes', 'mediaType', 'role']) ||
      !['previous', 'rejected', 'upload'].includes(reference.role) ||
      imageInfo(reference.bytes).mediaType !== reference.mediaType) throw new PluginError('invalid-output');
  }
  return references;
}
export const IPTC_DIGITAL_SOURCE = Object.freeze({
  generated: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia',
  manipulated: 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia',
});
export function assertUIGeneration(plugin) {
  if (!plugin || ['generate', 'edit', 'health'].some(key => typeof plugin[key] !== 'function')) {
    throw new TypeError('UI generation requires generate, edit and health');
  }
  return plugin;
}
export function isUIArtifact(artifact) {
  const p = artifact?.provenance;
  return Boolean(artifact && typeof artifact === 'object' && Reflect.ownKeys(artifact).every(key =>
    ['bytes', 'mediaType', 'width', 'height', 'promptDigest', 'provenance'].includes(key)) &&
    artifact.bytes instanceof Uint8Array && artifact.bytes.byteLength > 0 &&
    ['image/png', 'image/webp', 'image/jpeg'].includes(artifact.mediaType) &&
    ['width', 'height'].every(key => Number.isSafeInteger(artifact[key]) && artifact[key] > 0) &&
    /^sha256:[a-f0-9]{64}$/u.test(artifact.promptDigest) &&
    exactKeys(p, ['version', 'origin', 'modality', 'digitalSourceType', 'generatedAt', 'generator', 'techniques', 'assurances', 'subject']) &&
    p.version === 1 && p.modality === 'image' &&
    ['ai-generated', 'ai-manipulated'].includes(p.origin) &&
    p.digitalSourceType === IPTC_DIGITAL_SOURCE[p.origin === 'ai-generated' ? 'generated' : 'manipulated'] &&
    typeof p.generatedAt === 'string' && Number.isFinite(Date.parse(p.generatedAt)) &&
    exactKeys(p.generator, ['provider', 'model']) &&
    typeof p.generator.provider === 'string' && p.generator.provider.length > 0 &&
    typeof p.generator?.model === 'string' && p.generator.model.length > 0 &&
    Array.isArray(p.techniques) && p.techniques.includes('response-field') &&
    exactKeys(p.subject, ['contentDigest', 'mediaType']) &&
    /^sha-256=:[A-Za-z0-9+/]{43}=:$/u.test(p.subject.contentDigest) &&
    p.subject.mediaType === artifact.mediaType && exactKeys(p.assurances, ['digitallySigned', 'imperceptibleWatermark']) &&
    p.assurances.digitallySigned === false &&
    p.assurances.imperceptibleWatermark === 'provider-status-unknown');
}
