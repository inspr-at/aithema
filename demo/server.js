import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { SQLiteStorage, createHandlers, createPluginRuntime, createMemoryConsentLedger, createFacadeSecrets, createVoiceProvider, createDurationBinding, mockPresets } from '@inspr/aithema-server';
import { createLocalVoiceProvider, localVoiceBinding } from '../packages/server/src/local-voice.js';
import { listen } from '@inspr/aithema-server/http';
import { createMockReasoning, PluginRegistry } from '@inspr/aithema-core';
import { createOpenRouterReasoning } from '@inspr/aithema-plugin-openrouter';
import { createMistralReasoning } from '@inspr/aithema-plugin-mistral';
import { config } from './config.js';
import { voiceAsset } from './voice-assets.js';
import { ownership, startExpiry } from './session-lifecycle.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultDb = resolve(root, '.data/session.sqlite');
if (!process.env.AITHEMA_DB) await mkdir(resolve(root, '.data'), { recursive: true });
const storage = new SQLiteStorage(process.env.AITHEMA_DB ?? defaultDb);
// The demo is deterministic unless the operator explicitly selects a provider.
// Private references resolve from the environment at dispatch, never into public config.
const provider = process.env.AITHEMA_PROVIDER ?? 'mock';
if (!['mock', 'openrouter', 'mistral'].includes(provider)) throw new TypeError('Unknown demo provider');
const privateBinding = { plugin: provider, model: provider === 'mistral' ? (process.env.MISTRAL_MODEL ?? 'mistral-small-latest')
  : (process.env.OPENROUTER_MODEL ?? config.model), effort: 'none',
  endpoint: provider === 'mistral' ? 'https://api.mistral.ai/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions',
  accountRef: 'unverified', secretRef: provider === 'mistral' ? 'MISTRAL_API_KEY' : 'OPENROUTER_API_KEY',
  maxMicro: 1_000_000, maxTokens: 4096, rates: { inputMicro: 0, outputMicro: 0 } };
const reasoning = provider === 'mock' ? createMockReasoning() : provider === 'openrouter'
  ? createOpenRouterReasoning({ binding: privateBinding }) : createMistralReasoning({ binding: privateBinding });
const secrets = createFacadeSecrets();
const voiceMode = process.env.AITHEMA_VOICE_MODE ?? 'fake';
if (!['fake', 'off', 'elevenlabs'].includes(voiceMode)) throw new TypeError('Unknown voice mode');
let voiceHost;
if (voiceMode === 'elevenlabs') {
  // Host-private module supplies account evidence, authoritative consent and a proven
  // per-call provisioning channel. References, never resolved keys, select secrets.
  if (!process.env.AITHEMA_VOICE_HOST_MODULE) throw new TypeError('Live voice host module required');
  const { createVoiceHost } = await import((await import('node:url')).pathToFileURL(resolve(process.env.AITHEMA_VOICE_HOST_MODULE)).href);
  voiceHost = { ...await createVoiceHost({ storage, facadeSecrets: secrets, resolveSecret: ref => secrets.resolve(ref) ?? process.env[ref] }) };
  voiceHost.binding = createDurationBinding(voiceHost.binding);
}
const consent = voiceHost?.consent ?? createMemoryConsentLedger();
const voicePlugin = voiceMode === 'fake' ? createLocalVoiceProvider({ storage, provisionFacade: () => {}, revokeFacade: secrets.revoke })
  : voiceHost ? createVoiceProvider({ storage, binding: { agentId: voiceHost.binding.agentId, secretRef: voiceHost.binding.secretRef,
      apiBaseUrl: voiceHost.binding.endpoint, upstreamMicroPerMinute: voiceHost.binding.upstreamMicroPerMinute,
      visitorMicroPerMinute: voiceHost.binding.visitorMicroPerMinute }, resolveSecret: ref => process.env[ref],
    provisionFacade: voiceHost.provisionFacade, revokeFacade: secrets.revoke, requestProviderClose: voiceHost.requestProviderClose }) : null;
const registry = new PluginRegistry().register(reasoning); if (voicePlugin) registry.register(voicePlugin);
const voiceSelection = voicePlugin ? { voice: voiceHost?.binding ?? localVoiceBinding } : {};
const localPresets = { ...mockPresets(), best: { plugins: ['mock', ...(voicePlugin ? [voicePlugin.manifest.id] : [])],
  bindings: { ...mockPresets().best.bindings, ...voiceSelection }, policy: voiceHost?.policy } };
const pluginRuntime = provider === 'mock' ? createPluginRuntime({ storage, reasoning, consent, registry, presets: localPresets }) : createPluginRuntime({ storage, consent,
  registry, presets: {
    best: { plugins: [provider, ...(voicePlugin ? [voicePlugin.manifest.id] : [])],
      bindings: { reaction: privateBinding, understanding: privateBinding, ...voiceSelection }, policy: voiceHost?.policy },
    eu: { plugins: [], bindings: {} }, custom: { plugins: [], bindings: {} },
  } });
const handlers = createHandlers({ storage, reasoning, pluginRuntime, consent, ownership, voice: voicePlugin ? { secrets, closeOrphan: voiceHost?.closeOrphan } : undefined }); await handlers.resume();
const expiry = startExpiry(handlers);
let allowedHosts = new Set();
async function handle(request) {
  if (!allowedHosts.has(request.headers.get('host'))) return new Response(null, { status: 403 });
  if (request.method === 'POST' && request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return new Response(null, { status: 415 });
  }
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return handlers.handle(request);
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  if (url.pathname === '/demo/config') return Response.json({ label: reasoning.label, defaultPreset: 'best', voiceMode });
  if (url.pathname.startsWith('/vendor/elevenlabs/worklets/')) {
    const bytes = await voiceAsset(url.pathname.slice('/vendor/elevenlabs/worklets/'.length));
    return bytes ? new Response(request.method === 'HEAD' ? null : bytes, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' } }) : new Response(null, { status: 404 });
  }
  if (url.pathname === '/vendor/elevenlabs/lib.iife.js') {
    const bytes = await readFile(resolve(root, 'node_modules/@elevenlabs/client/dist/lib.iife.js'));
    return new Response(request.method === 'HEAD' ? null : bytes, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' } });
  }
  const path = url.pathname === '/' ? '/demo/index.html' : url.pathname;
  // Explicit source/static allowlist; no arbitrary files, lockfiles or credentials.
  if (!/^\/(?:demo\/(?:index\.html|host\.js|fake-voice\.js)|plugins\/device\/src\/index\.js|plugins\/elevenlabs\/src\/(?:client|manifest|options)\.js|packages\/(?:ui|core)\/src\/[a-z0-9/-]+\.js)$/u.test(path)) return new Response(null, { status: 404 });
  const file = resolve(root, `.${path}`);
  if (!file.startsWith(root + (root.endsWith(sep) ? '' : sep))) return new Response(null, { status: 404 });
  try {
    const bytes = await readFile(file);
    return new Response(request.method === 'HEAD' ? null : bytes, { headers: {
      'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    } });
  } catch { return new Response(null, { status: 404 }); }
}
const { server, url } = await listen(handle, { port: Number(process.env.PORT ?? config.port) });
const port = server.address().port;
allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
console.log(`Demo — Aithema reset slice 1: ${url} (${reasoning.label})`);
process.send?.({ url });
async function close() {
  clearInterval(expiry);
  server.close(); await handlers.close(); server.closeAllConnections(); storage.close();
}
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
