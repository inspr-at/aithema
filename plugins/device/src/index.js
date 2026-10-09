import { publicReasoningManifest, deepFreeze } from '../../../packages/core/src/plugins.js';
import { operationScope } from '../../../packages/core/src/reasoning.js';
import { createChatCompletions, responseText } from '../../../packages/core/src/chat-completions.js';
import { PluginError, normalizedError } from '../../../packages/core/src/invocation.js';
export const manifest = deepFreeze({ ...publicReasoningManifest('device', 'On my device', 'https://example.test', 'browser'),
  models: [{ ...publicReasoningManifest('device', 'On my device', 'https://example.test', 'browser').models[0],
    operations: ['stream'], structured: false, processingLocations: ['device'] }] });
// START local-openai.ts recovery codes: endpoint, auth, access, api, cors, models,
// response, stream, limit, timeout. They select setup help, never a fallback route.
export const LOCAL_FAILURES = Object.freeze(['endpoint', 'auth', 'access', 'api', 'cors', 'models', 'response', 'stream', 'limit', 'timeout']);
const failure = (code, local, message = code) => Object.assign(new PluginError(code, message), { local });
/** The recovery code for any device error, including the shared chat stream's codes. */
export function localFailure(error) {
  if (LOCAL_FAILURES.includes(error?.local)) return error.local;
  return { auth: 'auth', 'invalid-output': 'stream', limit: 'limit', deadline: 'timeout' }[error?.code] ?? 'response';
}
export function localEndpoint(value) {
  // Validate literal bytes BEFORE URL normalization: 127.1, decimal/octal IPs and lookalikes fail.
  if (typeof value !== 'string' || !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?\/?$/u.test(value)) throw failure('unavailable', 'endpoint', 'Invalid loopback endpoint');
  let url; try { url = new URL(value); } catch { throw failure('unavailable', 'endpoint', 'Invalid loopback endpoint'); }
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) throw failure('unavailable', 'endpoint', 'Invalid loopback port');
  return url.origin;
}
const transportOptions = { mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' };
export function createDeviceReasoning({ endpoint = 'http://127.0.0.1:8000', model, fetchImpl = globalThis.fetch } = {}) {
  const origin = localEndpoint(endpoint); let models = [], selected = model;
  async function connect(options = {}) {
    const scope = operationScope(options);
    try {
      scope.signal.throwIfAborted();
      let response;
      // The browser hides whether a stopped server, CORS or a permission blocked the request.
      try { response = await fetchImpl(`${origin}/v1/models`, { ...transportOptions, signal: scope.signal }); }
      catch (error) { if (scope.signal.aborted) throw error; throw failure('unavailable', 'cors'); }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw failure('unavailable', response.status === 401 ? 'auth' : response.status === 403 ? 'access' : response.status === 404 ? 'api' : 'response');
      }
      let body; try { body = JSON.parse(await responseText(response, 256_000)); } catch (error) {
        if (error instanceof PluginError) throw Object.assign(error, { local: error.code === 'limit' ? 'limit' : 'models' });
        throw failure('invalid-output', 'models');
      }
      if (!Array.isArray(body?.data)) throw failure('invalid-output', 'models');
      models = [...new Set(body.data.flatMap(m => typeof m?.id === 'string' && m.id.length > 0 && m.id.length <= 256 ? [m.id] : []))].slice(0, 200);
      if (!models.length || selected && !models.includes(selected)) throw failure('unavailable', 'models', 'Local model unavailable');
      selected ??= models[0]; return [...models];
    } catch (error) { throw normalizedError(error, scope.signal); }
    finally { scope.dispose(); }
  }
  return {
    id: 'device', label: 'On my device', manifest, connect, origin,
    get model() { return models.includes(selected) ? selected : null; },
    models: () => [...models],
    /** Choose one of the models the last handshake returned. */
    select(next) {
      if (!models.includes(next)) throw failure('unavailable', 'models', 'Local model unavailable');
      selected = next; return next;
    },
    disconnect() { models = []; selected = model; },
    async health(options) { await connect(options); return { available: true }; },
    async *stream(request, options) {
      if (!models.includes(selected)) throw failure('unavailable', 'models', 'Connect a local model first');
      if (request.messages.length > 200 || JSON.stringify(request.messages).length > 128_000) throw failure('limit', 'limit');
      const client = createChatCompletions({ manifest, binding: { model: selected, endpoint: `${origin}/v1/chat/completions`, maxTokens: 2048 },
        billable: false, fetchImpl, transportOptions });
      yield* client.stream(request, options);
    },
    async structured() { throw new PluginError('unavailable', 'unavailable on device'); },
  };
}
