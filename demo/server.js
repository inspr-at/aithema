import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { SQLiteStorage, createHandlers, createPluginRuntime, createMemoryConsentLedger, createFacadeSecrets, createVoiceProvider, createDurationBinding, createLocalImages, localImageBinding, createImageBinding, createSpendCap, createLocalHTML, localHTMLBinding, uiRenderLimitConfig, uploadLimitConfig } from '@inspr/aithema-server';
import { createLocalVoiceProvider, localVoiceBinding } from '../packages/server/src/local-voice.js';
import { listen } from '@inspr/aithema-server/http';
import { createMockReasoning, PluginRegistry } from '@inspr/aithema-core';
import { createOpenRouterReasoning } from '@inspr/aithema-plugin-openrouter';
import { createMistralReasoning } from '@inspr/aithema-plugin-mistral';
import { createOpenAIImages } from '@inspr/aithema-plugin-openai-images';
import { imagePluginBinding } from '../packages/server/src/image-binding.js';
import { demoPresets, providerMode } from './choices.js';
import { voiceAsset } from './voice-assets.js';
import { HTML_PREVIEW_HOST_CSP } from '../packages/core/src/ui-html.js';
import { createOwnership, startExpiry } from './session-lifecycle.js';

import { deploymentConfig, deploymentGate } from './deployment.js';
import { createVoiceHost as createStart2VoiceHost } from './start2-voice-host.js';
import { createProcessingConsent } from './processing-consent.js';
import { openRouterConfig } from './openrouter-config.js';
import { htmlConfig } from './html-config.js';
import { createClaudeHTML } from '@inspr/aithema-plugin-claude-html';
import { registerDemoExtractors } from './uploads.js';
import { createDemoHost } from './host-ports.js';

const deployment = deploymentConfig();
// The demo is deterministic unless the operator explicitly selects a provider.
// Validate models/prices before any database or live voice startup work.
const provider = process.env.AITHEMA_PROVIDER ?? 'mock';
if (!['mock', 'openrouter', 'mistral'].includes(provider)) throw new TypeError('Unknown demo provider');
const openrouter = provider === 'openrouter' ? openRouterConfig(process.env) : undefined;
// A live provider host never runs fake voice or images; fake HTML only as an explicit demo.
const live = provider !== 'mock';
const html = htmlConfig(process.env, openrouter ? [openrouter.reaction, openrouter.understanding] : [], { live });
const uiRenderLimits = uiRenderLimitConfig(process.env);
const uploadLimits = uploadLimitConfig(process.env);
const ownership = createOwnership(deployment);
const root = fileURLToPath(new URL('../', import.meta.url));
const defaultDb = resolve(root, '.data/session.sqlite');
if (!process.env.AITHEMA_DB) await mkdir(resolve(root, '.data'), { recursive: true });
const storage = new SQLiteStorage(process.env.AITHEMA_DB ?? defaultDb);
// Private references resolve from the environment at dispatch, never into public config.
const privateBinding = openrouter?.reaction ?? { plugin: provider, model: provider === 'mistral' ? (process.env.MISTRAL_MODEL ?? 'mistral-small-latest')
  : 'mock', effort: 'none',
  endpoint: provider === 'mistral' ? 'https://api.mistral.ai/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions',
  accountRef: provider === 'openrouter' ? 'start2-openrouter' : 'unverified', secretRef: provider === 'mistral' ? 'MISTRAL_API_KEY' : 'OPENROUTER_API_KEY',
  maxMicro: 1_000_000, maxTokens: 4096, rates: { inputMicro: 0, outputMicro: 0 } };
const understandingBinding = openrouter?.understanding ?? privateBinding;
const spendCap = provider === 'openrouter' || html.mode === 'claude' ? createSpendCap({ storage, account: 'start2-openrouter',
  capMicro: openrouter?.capMicro ?? html.capMicro }) : undefined;
const htmlPlugin = html.mode === 'fake' ? createLocalHTML() : html.mode === 'claude'
  ? createClaudeHTML({ binding: html.binding, spend: spendCap, capMicro: html.capMicro }) : null;
const htmlSelection = htmlPlugin ? { html: html.binding ?? localHTMLBinding } : {};
const reasoning = provider === 'mock' ? createMockReasoning() : provider === 'openrouter'
  ? createOpenRouterReasoning({ binding: privateBinding, spendCap, prices: openrouter.prices }) : createMistralReasoning({ binding: privateBinding });
const secrets = createFacadeSecrets();
const voiceMode = providerMode(process.env.AITHEMA_VOICE_MODE, live);
if (!['fake', 'off', 'elevenlabs'].includes(voiceMode)) throw new TypeError('Unknown voice mode');
let voiceHost;
if (voiceMode === 'elevenlabs') {
  const createVoiceHost = process.env.AITHEMA_VOICE_HOST_MODULE
    ? (await import((await import('node:url')).pathToFileURL(resolve(process.env.AITHEMA_VOICE_HOST_MODULE)).href)).createVoiceHost
    : createStart2VoiceHost;
  voiceHost = { ...await createVoiceHost({ storage, facadeSecrets: secrets,
    publicOrigin: deployment.publicOrigin, templateAgentId: process.env.AITHEMA_ELEVENLABS_TEMPLATE_AGENT_ID,
    resolveSecret: ref => secrets.resolve(ref) ?? process.env[ref] }) };
  if (voiceHost.binding) voiceHost.binding = createDurationBinding(voiceHost.binding);
}
const imageMode = providerMode(process.env.AITHEMA_IMAGE_MODE, live);
if (!['fake', 'off', 'openai'].includes(imageMode)) throw new TypeError('Unknown image mode');
let imageHost;
if (imageMode === 'openai') {
  if (!process.env.AITHEMA_IMAGE_HOST_MODULE) throw new TypeError('Live images host module required');
  const { createImageHost } = await import((await import('node:url')).pathToFileURL(resolve(process.env.AITHEMA_IMAGE_HOST_MODULE)).href);
  imageHost = await createImageHost({ storage });
  imageHost.binding = createImageBinding(imageHost.binding);
  if (voiceHost && imageHost.consent !== voiceHost.consent) throw new TypeError('Images and voice require the same authoritative consent port');
}
const liveBindings = [...(provider === 'openrouter' ? [privateBinding, understandingBinding] : []), ...(voiceHost?.binding ? [voiceHost.binding] : []), ...(html.binding?.legal ? [html.binding] : [])];
const consent = imageHost?.consent ?? voiceHost?.consent ?? (liveBindings.length
  ? createProcessingConsent({ storage, bindings: liveBindings }) : createMemoryConsentLedger());
if (voiceHost?.staticSecretRef) {
  const resolve = secrets.resolve;
  secrets.resolve = ref => ref === voiceHost.staticSecretRef ? process.env[ref] : resolve(ref);
}
const policy = imageHost?.policy ?? voiceHost?.policy ?? { endpoints: liveBindings.map(b => b.endpoint) };
const imagePlugin = imageMode === 'fake' ? createLocalImages() : imageHost ? createOpenAIImages({ binding: imagePluginBinding(imageHost.binding),
  resolveSecret: imageHost.resolveSecret ?? (ref => process.env[ref]) }) : null;
const imageSelection = imagePlugin ? { images: imageHost?.binding ?? localImageBinding } : {};
const voicePlugin = voiceMode === 'fake' ? createLocalVoiceProvider({ storage, provisionFacade: () => {}, revokeFacade: secrets.revoke })
  : voiceHost?.binding ? createVoiceProvider({ storage, binding: { agentId: voiceHost.binding.agentId, secretRef: voiceHost.binding.secretRef,
      apiBaseUrl: voiceHost.binding.endpoint, upstreamMicroPerMinute: voiceHost.binding.upstreamMicroPerMinute,
      visitorMicroPerMinute: voiceHost.binding.visitorMicroPerMinute }, resolveSecret: ref => process.env[ref],
    staticFacade: Boolean(voiceHost.staticSecretRef), provisionFacade: voiceHost.provisionFacade, revokeFacade: secrets.revoke, requestProviderClose: voiceHost.requestProviderClose }) : null;
const registry = new PluginRegistry().register(reasoning); if (voicePlugin) registry.register(voicePlugin); if (imagePlugin) registry.register(imagePlugin); if (htmlPlugin) registry.register(htmlPlugin);
// The operator allowlist visitors choose from in settings (demo/choices.js).
const presets = demoPresets({ provider, reaction: privateBinding, understanding: understandingBinding, voicePlugin,
  voiceBinding: voiceHost?.binding ?? localVoiceBinding, imagePlugin, imageBinding: imageSelection.images, htmlPlugin, htmlBinding: htmlSelection.html, htmlDemo: Boolean(html.demo), policy });
registerDemoExtractors(registry, presets);
const pluginRuntime = createPluginRuntime({ storage, reasoning, consent, registry, uiRenderLimits, presets });
const host = createDemoHost({ storage, demo: process.env.AITHEMA_PROVIDER === undefined,
  verificationRequired: process.env.AITHEMA_DEMO_VERIFY === '1' });
const handlers = createHandlers({ storage, reasoning, pluginRuntime, consent, ownership, host, uploads: { limits: uploadLimits }, voice: voicePlugin ? { secrets, closeOrphan: voiceHost?.closeOrphan, staticSecretRef: voiceHost?.staticSecretRef, presentation: voiceHost?.presentation } : undefined }); await handlers.resume();
const expiry = startExpiry(handlers);
let allowedHosts = new Set();
async function handle(request) {
  const refused = deploymentGate(request, deployment, allowedHosts); if (refused) return refused;
  if (request.method === 'GET' && new URL(request.url).pathname === '/healthz') return Response.json({ ok: true, commit: deployment.commit });
  const upload = /^\/api\/sessions\/[a-zA-Z0-9_-]{1,128}\/uploads$/u.test(new URL(request.url).pathname);
  if (request.method === 'POST' && !upload && request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return new Response(null, { status: 415 });
  }
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return handlers.handle(request);
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  if (url.pathname === '/demo/config') return Response.json({ label: reasoning.label, defaultPreset: 'best', voiceMode: voiceMode === 'elevenlabs' && !voiceHost?.binding ? 'off' : voiceMode,
    voiceDisabledReason: voiceHost?.disabledReason ?? null, processingConsent: consent.describe?.(), imageMode, imageLabel: imagePlugin?.label ?? 'Images off',
    htmlMode: html.mode, htmlLabel: htmlPlugin?.label ?? 'HTML off', htmlDisabledReason: html.disabledReason ?? null, hostLabel: host.label, demoHost: host.demo,
    verificationRequired: host.policy.verificationRequired });
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
      ...(file.endsWith('.html') ? { 'content-security-policy': HTML_PREVIEW_HOST_CSP } : {}),
    } });
  } catch { return new Response(null, { status: 404 }); }
}
const { server, url } = await listen(handle, { port: deployment.port, hostname: deployment.hostname });
const port = server.address().port;
allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
console.log(`Demo — Aithema reset slice 1: ${url} (${reasoning.label})`);
process.send?.({ url });
async function close() {
  clearInterval(expiry);
  server.close(); await handlers.close(); server.closeAllConnections(); storage.close();
}
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
