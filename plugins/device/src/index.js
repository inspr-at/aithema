import { publicReasoningManifest, deepFreeze } from '../../../packages/core/src/plugins.js';
import { operationScope } from '../../../packages/core/src/reasoning.js';
import { createChatCompletions, responseText } from '../../../packages/core/src/chat-completions.js';
import { PluginError, normalizedError } from '../../../packages/core/src/invocation.js';
export const manifest = deepFreeze({ ...publicReasoningManifest('device', 'On my device', 'https://example.test', 'browser'),
  models: [{ ...publicReasoningManifest('device', 'On my device', 'https://example.test', 'browser').models[0],
    operations: ['stream'], structured: false, processingLocations: ['device'] }] });
export function localEndpoint(value) {
  // Validate literal bytes BEFORE URL normalization: 127.1, decimal/octal IPs and lookalikes fail.
  if (typeof value !== 'string' || !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?\/?$/u.test(value)) throw new PluginError('unavailable', 'Invalid loopback endpoint');
  let url; try { url = new URL(value); } catch { throw new PluginError('unavailable', 'Invalid loopback endpoint'); }
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) throw new PluginError('unavailable', 'Invalid loopback port');
  return url.origin;
}
const transportOptions = { mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' };
export function createDeviceReasoning({ endpoint = 'http://127.0.0.1:8000', model, fetchImpl = globalThis.fetch } = {}) {
  const origin = localEndpoint(endpoint); let models = [], selected = model;
  async function connect(options = {}) {
    const scope = operationScope(options);
    try {
      scope.signal.throwIfAborted();
      const response = await fetchImpl(`${origin}/v1/models`, { ...transportOptions, signal: scope.signal });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new PluginError('unavailable'); }
      let body; try { body = JSON.parse(await responseText(response, 256_000)); } catch (error) {
        if (error instanceof PluginError) throw error; throw new PluginError('invalid-output');
      }
      if (!Array.isArray(body?.data)) throw new PluginError('invalid-output');
      models = [...new Set(body.data.flatMap(m => typeof m?.id === 'string' && m.id.length > 0 && m.id.length <= 256 ? [m.id] : []))].slice(0, 200);
      if (!models.length || selected && !models.includes(selected)) throw new PluginError('unavailable', 'Local model unavailable');
      selected ??= models[0]; return [...models];
    } catch (error) { throw normalizedError(error, scope.signal); }
    finally { scope.dispose(); }
  }
  return {
    id: 'device', label: 'On my device', manifest, connect,
    async health(options) { await connect(options); return { available: true }; },
    async *stream(request, options) {
      if (!models.includes(selected)) throw new PluginError('unavailable', 'Connect a local model first');
      if (request.messages.length > 200 || JSON.stringify(request.messages).length > 128_000) throw new PluginError('limit');
      const client = createChatCompletions({ manifest, binding: { model: selected, endpoint: `${origin}/v1/chat/completions`, maxTokens: 2048 },
        billable: false, fetchImpl, transportOptions });
      yield* client.stream(request, options);
    },
    async structured() { throw new PluginError('unavailable', 'unavailable on device'); },
  };
}
