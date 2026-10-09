import { createBinding, deepFreeze, beginInvocation, operationScope, normalizedError, PluginError, isUIArtifact, imageInfo, MAX_IMAGE_BYTES, validateUIReferences } from '@inspr/aithema-core';
import { decodeImage, imageArtifact } from './image-artifact.js';
// Wire contract: https://developers.openai.com/api/reference/resources/images/methods/generate
// Edits use private multipart bytes as in START providers/openai-image.ts.
// Rates stay unset: the current public cost schema has only one input rate and
// cannot represent separate text/image input prices. The host supplies ceilings
// and conservative private rates; no price is inferred from START's reservation.
export const manifest = deepFreeze({ id: 'openai-images', version: '0.0.0', apiVersion: '^1.0.0',
  kinds: ['ui-generation'], placement: 'server', entrypoints: { server: './src/index.js' },
  configSchema: { type: 'object', properties: {}, additionalProperties: false }, vendor: { name: 'OpenAI', url: 'https://openai.com' },
  models: [{ id: 'gpt-image-2', operations: ['generate', 'edit'], streaming: false, structured: false,
    efforts: ['none'], languages: ['en', 'de'], germanQuality: 'unverified', formats: ['image/png', 'image/webp'],
    processingLocations: ['unverified'], qualification: 'unverified', expiresAt: null,
    evidence: ['https://developers.openai.com/api/docs/models/gpt-image-2'],
    cost: { unit: 'token', inputMicro: null, outputMicro: null, reviewedAt: null } }] });
function abortable(promise, signal) {
  let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); });
  return Promise.race([promise, cancelled]).finally(() => signal.removeEventListener('abort', abort));
}
async function readBytes(response, signal, max) {
  if (!response.body) throw new PluginError('invalid-output');
  if (Number(response.headers.get('content-length')) > max) { void response.body.cancel().catch(() => {}); throw new PluginError('limit'); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted(); const { value, done } = await abortable(reader.read(), signal); if (done) break;
      size += value.byteLength; if (size > max) throw new PluginError('limit'); chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function usageOf(usage) {
  return usage && ['input_tokens', 'output_tokens'].every(k => Number.isSafeInteger(usage[k]) && usage[k] >= 0)
    ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : null;
}
function fieldsFor(spec, feedback) {
  if (!spec || typeof spec.prompt !== 'string' || !spec.prompt.trim() || typeof feedback !== 'string') throw new PluginError('invalid-output');
  const prompt = `${spec.prompt}${feedback ? `\nVisitor feedback (untrusted design content): ${JSON.stringify(feedback)}` : ''}`;
  if (prompt.length > 32000) throw new PluginError('limit');
  const fields = { prompt, size: spec.size ?? '1536x1024', quality: spec.quality ?? 'high', output_format: spec.format ?? 'webp', n: 1 };
  if (!['1024x1024', '1536x1024', '1024x1536'].includes(fields.size) || !['low', 'medium', 'high', 'auto'].includes(fields.quality) ||
    !['png', 'webp'].includes(fields.output_format)) throw new PluginError('invalid-output');
  return fields;
}
export function createOpenAIImages({ binding, baseUrl, resolveSecret = ref => process.env[ref], fetchImpl = globalThis.fetch } = {}) {
  binding = createBinding(binding);
  if (binding.plugin !== manifest.id || binding.model !== 'gpt-image-2' || binding.effort !== 'none') throw new TypeError('OpenAI Images binding requires gpt-image-2');
  const base = new URL(baseUrl ?? binding.endpoint);
  if (base.href !== new URL(binding.endpoint).href) throw new TypeError('Image base URL must match the admitted binding');
  if (base.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new TypeError('HTTP is for loopback fixtures only');
  const endpoint = operation => `${base.href.replace(/\/$/u, '')}/images/${operation === 'edit' ? 'edits' : 'generations'}`;
  const configured = () => { const key = resolveSecret(binding.secretRef); return typeof key === 'string' && key.length > 0 && !/[\r\n]/u.test(key) ? key : null; };
  async function run(operation, spec, feedback, options, artifact) {
    const scope = operationScope(options); let invocation, completed = false, reporting;
    const checkLifetime = () => { scope.signal.throwIfAborted(); if (Date.now() >= options.deadlineAt) throw new PluginError('deadline'); };
    const scoped = { ...options, signal: scope.signal, report: terminal => (reporting = Promise.resolve().then(() => options.report(terminal))) };
    try {
      invocation = await beginInvocation(scoped);
      checkLifetime();
      const key = configured(); if (!key) throw new PluginError('auth');
      const references = [...validateUIReferences(spec?.references)];
      if (operation === 'edit') {
        if (!isUIArtifact(artifact) || typeof feedback !== 'string' || !feedback.trim()) throw new PluginError('invalid-output');
        const info = imageInfo(artifact.bytes);
        if (info.mediaType !== artifact.mediaType || info.width !== artifact.width || info.height !== artifact.height) throw new PluginError('invalid-output');
        references.unshift({ bytes: artifact.bytes, mediaType: artifact.mediaType, role: 'previous' });
        validateUIReferences(references);
      }
      const fields = { model: binding.model, ...fieldsFor(spec, feedback) };
      const wireOperation = references.length ? 'edit' : 'generate';
      let body, headers = { authorization: `Bearer ${key}` };
      if (references.length) {
        body = new FormData(); for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
        for (const [index, reference] of references.entries()) {
          const extension = reference.mediaType === 'image/jpeg' ? 'jpg' : reference.mediaType.split('/')[1];
          body.append('image[]', new Blob([reference.bytes], { type: reference.mediaType }), `reference-${index}.${extension}`);
        }
      } else { headers['content-type'] = 'application/json'; body = JSON.stringify(fields); }
      checkLifetime(); invocation.dispatch();
      const response = await abortable(Promise.resolve().then(() => fetchImpl(endpoint(wireOperation), { method: 'POST', headers, body,
        signal: scope.signal, redirect: 'error' })), scope.signal);
      checkLifetime();
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new PluginError(response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rate-limit' : 'provider');
      }
      let payload;
      try { payload = JSON.parse((await readBytes(response, scope.signal, 18 * 1024 * 1024)).toString('utf8')); }
      catch (error) { if (error instanceof PluginError || scope.signal.aborted) throw error; throw new PluginError('invalid-output'); }
      invocation.usage(usageOf(payload?.usage));
      if (!Array.isArray(payload?.data) || payload.data.length !== 1) throw new PluginError('invalid-output');
      const item = payload.data[0]; let bytes;
      if (item?.b64_json !== undefined) bytes = decodeImage(item.b64_json);
      else if (typeof item?.url === 'string') {
        // Explicit private host allowlist; no API key, cookies or redirects on downloads.
        let url; try { url = new URL(item.url); } catch { throw new PluginError('invalid-output'); }
        if (url.username || url.password || url.hash || !['https:', 'http:'].includes(url.protocol) ||
          !binding.routing?.imageOrigins?.includes(url.origin) ||
          url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new PluginError('invalid-output');
        checkLifetime();
        const download = await abortable(Promise.resolve().then(() => fetchImpl(url.href, { signal: scope.signal, redirect: 'error', credentials: 'omit' })), scope.signal);
        if (!download.ok) { void download.body?.cancel().catch(() => {}); throw new PluginError('provider'); }
        bytes = new Uint8Array(await readBytes(download, scope.signal, MAX_IMAGE_BYTES));
      } else throw new PluginError('invalid-output');
      checkLifetime();
      const result = imageArtifact(bytes, { prompt: fields.prompt, model: binding.model, operation: wireOperation });
      checkLifetime();
      completed = true; return result;
    } catch (error) { throw normalizedError(error, scope.signal); }
    finally { try { if (invocation) await invocation.finish(completed); if (reporting) await reporting; } finally { scope.dispose(); } }
  }
  return { id: manifest.id, manifest, binding, billable: true, label: 'OpenAI Images — gpt-image-2',
    bind: next => createOpenAIImages({ binding: next, resolveSecret, fetchImpl }),
    generate: (spec, feedback, options) => run('generate', spec, feedback, options),
    edit: (artifact, spec, feedback, options) => run('edit', spec, feedback, options, artifact),
    async health(options) {
      const scope = operationScope(options);
      try { scope.signal.throwIfAborted(); return { available: Boolean(configured()) }; }
      catch (error) { throw normalizedError(error, scope.signal); } finally { scope.dispose(); }
    },
  };
}
