import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { deepFreeze, beginInvocation, operationScope, validateUIReferences } from '@inspr/aithema-core';
import { manifest as imageManifest } from '../../../plugins/openai-images/src/index.js';
import { imageArtifact } from '../../../plugins/openai-images/src/image-artifact.js';

const localGenerates = new WeakSet();
export const isLocalImages = plugin => localGenerates.has(plugin?.generate);
export const localImageBinding = Object.freeze({ plugin: 'fake-images', model: 'deterministic-ui', effort: 'none',
  endpoint: 'https://example.test', accountRef: 'local-demo', secretRef: 'local-only', maxMicro: 0, maxTokens: 1,
  rates: { inputMicro: 0, outputMicro: 0 }, imageCost: { inputMicro: 0, outputMicro: 0, maxInputTokens: 200_000, maxOutputTokens: 1 } });
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); result.write(type, 4); bytes.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4); return result;
}
// A valid raster PNG dashboard fixture. Its palette responds deterministically
// to the prompt, feedback and private references, without any network transport.
function dashboard(seed) {
  const width = 480, height = 320, digest = createHash('sha256').update(seed).digest();
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const panel = x > 110 && y > 62 && x < 458 && y < 300;
    const card = panel && (y < 132 || y > 154) && (x < 276 || x > 292);
    const bar = x > 128 && x < 440 && y > 177 && y < 182 || x > 128 && x < 240 && y > 90 && y < 100;
    const color = bar ? [digest[0], 90 + digest[1] % 80, 100 + digest[2] % 80] : y < 44 || x < 92 ? [36, 59, 64] : card ? [255, 254, 249] : [232, 237, 232];
    const at = y * (width * 3 + 1) + 1 + x * 3; color.forEach((value, i) => { rows[at + i] = value; });
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
export function createLocalImages({ delayMs = 250, now = Date.now } = {}) {
  async function generate(spec, feedback, options) {
    const scope = operationScope(options); let invocation, completed = false;
    try {
      invocation = await beginInvocation({ ...options, signal: scope.signal }); scope.signal.throwIfAborted();
      const references = validateUIReferences(spec.references);
      invocation.dispatch();
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(scope.signal.reason); };
        const timer = setTimeout(() => { scope.signal.removeEventListener('abort', abort); resolve(); }, delayMs);
        scope.signal.addEventListener('abort', abort, { once: true }); if (scope.signal.aborted) abort();
      });
      const seed = JSON.stringify([spec.prompt, feedback, references.map(r => createHash('sha256').update(r.bytes).digest('hex'))]);
      const artifact = imageArtifact(dashboard(seed), { prompt: seed, provider: 'local-demo-fake', model: 'deterministic-ui',
        operation: references.length ? 'edit' : 'generate', now: now() });
      invocation.usage({ inputTokens: 1, outputTokens: 1 }); completed = true; return artifact;
    } finally { try { await invocation?.finish(completed); } finally { scope.dispose(); } }
  }
  localGenerates.add(generate);
  return { manifest: deepFreeze({ ...imageManifest, id: 'fake-images', vendor: { name: 'Local deterministic fake', url: 'https://example.test' },
    models: [{ ...imageManifest.models[0], id: 'deterministic-ui' }] }), label: 'Fake images — local deterministic PNG, no provider network', generate,
    edit: (artifact, spec, feedback, options) => generate({ ...spec, references: [{ bytes: artifact.bytes, mediaType: artifact.mediaType, role: 'previous' }, ...(spec.references ?? [])] }, feedback, options),
    async health(options) { options.signal?.throwIfAborted(); return { available: true }; } };
}
