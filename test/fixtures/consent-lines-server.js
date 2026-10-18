// Real server/storage and reference UI, with a durable local consent host.
// The ordinary demo intentionally loses mock grants on restart (AIT-116).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { SQLiteStorage, createHandlers, createPluginRuntime, createFacadeSecrets } from '../../packages/server/src/index.js';
import { listen } from '../../packages/server/src/http.js';
import { createMockReasoning, PluginRegistry, MOCK_PROCESSING_SCOPE, inputRevision } from '../../packages/core/src/index.js';
import { createLocalVoiceProvider, localVoiceBinding } from '../../packages/server/src/dev/local-voice.js';
import { demoPresets } from '../../demo/choices.js';
import { createOwnership } from '../../demo/session-lifecycle.js';
import { createDemoHost } from '../../demo/host-ports.js';
import { createMockConsent } from '../../demo/mock-consent.js';
import { buildInfo } from '../../demo/build-info.js';
import { start2PurposePolicy } from '../../demo/safeguards.js';
import { HTML_PREVIEW_HOST_CSP } from '../../packages/core/src/ui-html.js';

globalThis.fetch = async () => assert.fail('Continuity fixture must never contact a provider');
const root = fileURLToPath(new URL('../../', import.meta.url)), storage = new SQLiteStorage(process.env.AITHEMA_DB);
const revisionFixture = Boolean(process.env.AITHEMA_CONSENT_REVISION_FIXTURE);
const consentStats = { grants: 0, withdrawals: 0 };
const selections = new Map();
const consent = revisionFixture ? {
  coverage: () => ({ covered: false }),
  describe: id => ({ contract: `images-v${storage.get(id).consentRevision}`, selected: selections.get(id) ?? [],
    items: [{ id: 'images', version: 1, title: 'Images', recipients: 'Local image processor', text: 'Generate images for this conversation.' }] }),
  grant: ({ sessionId, decision }) => { consentStats.grants++; selections.set(sessionId, [...decision.items]); return true; },
  withdraw: ({ sessionId }) => { consentStats.withdrawals++; selections.set(sessionId, []); },
} : createMockConsent(storage);
const admitted = { reaction: 0, understanding: 0 };
const assessmentMessages = [];
let release; const pending = new Promise(resolve => { release = resolve; });
const reasoning = createMockReasoning(), secrets = createFacadeSecrets(), voicePlugin = createLocalVoiceProvider({ storage,
  provisionFacade: () => {}, revokeFacade: secrets.revoke });
const presets = demoPresets({ provider: 'mock', reaction: { plugin: 'mock', model: 'mock', effort: 'none', maxMicro: 0, maxTokens: 4096,
  rates: { inputMicro: 0, outputMicro: 0 } }, voicePlugin, voiceBinding: localVoiceBinding, policy: { endpoints: [] } });
const registry = new PluginRegistry().register(reasoning).register(voicePlugin);
const pluginRuntime = createPluginRuntime({ storage, registry, presets, consent });
if (revisionFixture) pluginRuntime.scopes = () => [{ purpose: 'images' }];
const admit = pluginRuntime.admit.bind(pluginRuntime);
pluginRuntime.admit = async args => {
  const result = await admit(args);
  if (args.lane in admitted) { admitted[args.lane]++; if (args.lane === 'understanding') assessmentMessages.push(args.request.messages); await pending; }
  return result;
};
const ownership = createOwnership(), host = createDemoHost({ storage, demo: true, ownerGuard: false });
const handlers = createHandlers({ storage, reasoning, pluginRuntime, ownership, consent, host, voice: { secrets }, ...(process.env.AITHEMA_PURPOSE_FIXTURE ? { purposePolicy: start2PurposePolicy } : {}) });
await handlers.resume();
const handle = async request => {
  const path = new URL(request.url).pathname;
  if (path === '/fixture/assessment-messages') return Response.json(assessmentMessages);
  if (path === '/fixture/pause') {
    const { id, project, locale } = await request.json();
    storage.changeLocale(id, locale);
    const turns = [...(project ? [locale === 'de' ? 'Wir brauchen eine Website.' : 'We need a website.'] : []), ...Array(3).fill('Give me a soup recipe.')];
    for (const [index, content] of turns.entries()) {
      storage.postTurn(id, `r3-${index}`, Buffer.from(content), content);
      storage.appendPurposeReply(id, { id: `r3-reply-${index}`, role: 'assistant', content: 'What should the project improve?', inputRevision: inputRevision(storage.get(id)) }, inputRevision(storage.get(id)), !project || index > 0, 3);
    }
    const session = storage.get(id); return Response.json({ ...session, operations: { inputRevision: inputRevision(session), running: [], lastFailure: null }, visualsBound: pluginRuntime.visualsBound(), featureMatrix: await pluginRuntime.matrix(session) });
  }
  if (path === '/fixture/consent-stats' && revisionFixture) return Response.json(consentStats);
  if (path === '/fixture/stats') return Response.json(admitted);
  if (path === '/fixture/release') { release(); return Response.json({ ok: true }); }
  if (path === '/fixture/turn') {
    const { id, content } = await request.json(); storage.postTurn(id, 'r2-person', Buffer.from(content), content);
    const session = storage.get(id); return Response.json({ ...session, visualsBound: pluginRuntime.visualsBound(), featureMatrix: await pluginRuntime.matrix(session) });
  }
  if (path.startsWith('/api/')) return handlers.handle(request);
  if (path === '/demo/config') return Response.json({ label: reasoning.label, defaultPreset: 'best', voiceMode: 'fake', voicePresentation: voicePlugin.manifest.presentation,
    imageMode: 'off', imageLabel: 'Images off', htmlMode: 'off', htmlLabel: 'HTML off', demoHost: true, verificationRequired: false, build: buildInfo() });
  const file = path === '/' ? '/demo/index.html' : path;
  if (!/^\/(?:demo\/[a-z-]+\.(?:html|css|js)|packages\/(?:ui|core)\/src\/[a-z0-9/-]+\.js|packages\/server\/src\/dev\/local-voice-manifest\.js|packages\/ui\/src\/versioning\/display\.json|plugins\/(?:device|elevenlabs|fake-voice)\/src\/[a-z-]+\.js)$/u.test(file)) return new Response(null, { status: 404 });
  try { return new Response(await readFile(resolve(root, '.' + file)), { headers: { 'content-type': file.endsWith('.html') ? 'text/html'
    : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/javascript', 'cache-control': 'no-store', 'content-security-policy': HTML_PREVIEW_HOST_CSP } }); }
  catch { return new Response(null, { status: 404 }); }
};
const { server, url } = await listen(handle, { hostname: '127.0.0.1', port: Number(process.env.PORT ?? 0) });
process.send?.({ url });
const close = async () => { release(); server.close(); server.closeAllConnections(); await handlers.close(); storage.close(); };
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
