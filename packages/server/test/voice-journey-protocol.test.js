import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteStorage, createHandlers, createPluginRuntime, createVoiceProvider, createFacadeSecrets, mockPresets, createVoiceCap } from '../src/index.js';
import { PluginRegistry, createMockReasoning } from '@inspr/aithema-core';
import { temporaryDb } from '../../../test/helpers.js';
import { eventProbe } from '../../../test/voice-test-events.js';
import { createElevenLabsClient } from '../../../plugins/elevenlabs/src/client.js';
import { mintConversationCredential } from '../../../plugins/elevenlabs/src/server.js';
import { fakeSdk, binding } from '../../../plugins/elevenlabs/test/fixtures.js';
import { Window } from 'happy-dom';
import { AudioRail } from '../../ui/src/audio-rail.js';
import { createVoiceControl } from '../../ui/src/voice-control.js';
import { paintVoiceInterruption } from '../../ui/src/voice-transcript.js';
import { de } from '../../ui/src/i18n/de.js';
import { en } from '../../ui/src/i18n/en.js';


// No sockets or provider credentials: the real provider token primitive consumes
// an offline Response, then traverses the session route, control and rail.
for (const retryAfter of ['12', null]) test(`AIT-378 R1 real token 429, Retry-After ${retryAfter}`, { timeout: 10_000 }, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
  const h = voiceFixture(t), window = new Window(), root = window.document.createElement('div');
  window.document.body.append(root);
  h.failMint(Response.json({}, { status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : {} }));
  const response = await h.route('/voice', { callId: 'direct-429' });
  assert.equal(response.status, retryAfter ? 429 : 502); assert.equal(response.headers.get('retry-after'), retryAfter);
  const requests = [], entered = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(Date.now());
    const suffix = new URL(url, 'http://fixture').pathname.split(h.session.id)[1];
    const response = await h.route(suffix, JSON.parse(options.body)); entered.resolve(); return response;
  });
  const { control } = createVoiceControl({ sessionId: h.session.id });
  const rail = new AudioRail({ root, client: { manifest: h.plugin.manifest, async start(request) { await control.start(request); } },
    copy: de, context: () => ({}), feature: () => ({ available: true }) });
  t.after(async () => { rail.destroy(); await window.happyDOM.close(); });
  await rail.start(); await entered.promise;
  assert.equal(rail.retryAt, retryAfter ? Date.now() + 12_000 : 0);
  const before = requests.length, pending = rail.start();
  // A deferred control request signals dispatch; virtual time alone owns cooldown.
  await new Promise(resolve => setImmediate(resolve));
  if (retryAfter) {
    assert.equal(rail.state, 'connecting');
    t.mock.timers.tick(11_800); await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, before, 'Retry never starts before 11.8 seconds');
    t.mock.timers.tick(199); await new Promise(resolve => setImmediate(resolve)); assert.equal(requests.length, before);
    t.mock.timers.tick(1);
  }
  await pending; assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1) - requests[0], retryAfter ? 12_000 : 0);
});

for (const prefix of [null, 'Heard.']) test(`AIT-378 ${prefix === null ? 'I2' : 'I1'} SDK confirmation persists through route and reload`, { timeout: 10_000 }, async t => {
  const path = await temporaryDb(), h = voiceFixture(t, { path }), sdk = fakeSdk();
  const started = await h.route('/voice', { callId: 'native-call', tabId: 'sdk-tab' });
  assert.equal(started.status, 201); const grant = await started.json();
  grant.credential.conversationToken = `fixture-token-${grant.providerSessionId}`;
  const identity = { providerSessionId: grant.providerSessionId, epoch: grant.epoch, tabId: grant.controllingTabId };
  const finalStored = Promise.withResolvers();
  const publish = async event => {
    const response = await h.route(`/voice/${grant.callId}/events`, { ...identity, event });
    try { assert.equal(response.status, 200); if (event.type === 'final') finalStored.resolve(); }
    catch (error) { finalStored.reject(error); throw error; }
  };
  const client = createElevenLabsClient({ sdk, mediaDevices: sdk.mediaDevices, AudioContext: sdk.AudioContext,
    control: { start: async () => grant, close: async () => ({}), reportActivity: publish,
      pause: async () => ({ acknowledged: true, paused: true }), resume: async () => ({ acknowledged: true, paused: false }), heartbeat: async () => ({}) },
    persistEvent: publish });
  const session = await client.start({ callId: grant.callId }); t.after(() => session.close());
  const callbacks = sdk.starts[0], full = 'Heard. Unheard remainder.';
  callbacks.onMessage({ role: 'agent', event_id: 8, message: full });
  callbacks.onModeChange({ mode: 'speaking' }); callbacks.onModeChange({ mode: 'listening' });
  await finalStored.promise;
  assert.equal(h.storage.get(h.session.id).transcript.at(-1).interruption, undefined, 'I3 silence/end of reply never mark');
  await session.pause();
  assert.equal(h.storage.get(h.session.id).transcript.at(-1).interruption, undefined, 'I3 explicit pause never marks a barge-in');
  await session.resume();
  callbacks.onInterruption({ event_id: 8 });
  if (prefix !== null) callbacks.onAgentResponseCorrection({ event_id: 8, original_agent_response: full, corrected_agent_response: prefix });
  // close drains captured persistence, without sleeps or a polling race.
  await session.close();
  const turn = h.storage.get(h.session.id).transcript.at(-1);
  const reopened = new DatabaseSync(path, { readOnly: true });
  const durable = JSON.parse(reopened.prepare('SELECT snapshot FROM sessions WHERE id=?').get(h.session.id).snapshot); reopened.close();
  assert.deepEqual(durable.transcript.at(-1).interruption, turn.interruption, 'fresh read-only connection sees the durable marker');
  assert.equal(turn.content, prefix ?? full);
  assert.equal(turn.interruption?.heardLength, prefix === null ? 'unknown' : prefix.length);
  const replayed = h.storage.read(h.session.id).filter(event => event.type === 'voice.interrupted');
  assert.ok(replayed.length > 0, 'confirmation is durable');
  if (prefix !== null) {
    const late = await h.route(`/voice/${grant.callId}/events`, { ...identity, event: { type: 'interrupted', callId: grant.callId,
      providerSessionId: grant.providerSessionId, turnId: `${grant.providerSessionId}:assistant:8`, heardLength: 'unknown' } });
    assert.equal(late.status, 200);
    assert.equal(h.storage.get(h.session.id).transcript.at(-1).interruption.heardLength, prefix.length, 'late confirmation cannot downgrade known offset');
  }
  const window = new Window(); t.after(() => window.happyDOM.close());
  for (const copy of [de, en]) {
    const row = window.document.createElement('div'); row.innerHTML = '<strong></strong>';
    paintVoiceInterruption(row, turn, copy);
    assert.equal(row.querySelector('.voice-interruption-label')?.textContent, copy.voiceInterrupted);
    assert.equal(row.querySelector('[role="tooltip"]')?.textContent, prefix === null ? copy.voiceInterruptedDescription
      : copy === de ? 'Die Wiedergabe wurde an dieser Stelle unterbrochen.' : 'Playback was interrupted here.');
  }
  const takeover = await h.route(`/voice/${grant.callId}/takeover`, { ...identity, tabId: 'new-tab', explicit: true });
  assert.equal(takeover.status, 200);
  const stale = await h.route(`/voice/${grant.callId}/events`, { ...identity, event: { type: 'interrupted', callId: grant.callId,
    providerSessionId: grant.providerSessionId, turnId: `${grant.providerSessionId}:assistant:8`, heardLength: 'unknown' } });
  assert.equal(stale.status, 409, 'stale epoch cannot mark a reply');
});


for (const [header, expected] of [['Thu, 01 Jan 1970 00:01:52 GMT', '12'], ['not-a-delay', undefined]]) {
  test(`AIT-378 provider Retry-After normalization: ${header}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
    await assert.rejects(mintConversationCredential(binding, {}, {}, {
      resolveSecret: () => 'offline-fixture',
      fetchImpl: async () => Response.json({}, { status: 429, headers: { 'Retry-After': header } }),
    }), error => {
      assert.equal(error.code, 'rate-limit'); assert.equal(error.status, 429);
      assert.equal(error.retryAfter, expected); return true;
    });
  });
}

// Isolated copy of the existing offline voice fixture; no test-module imports.
export function voiceFixture(t, { unknown = false, leaseMs = 30_000, slowClosure = false, path, cap, reasoning = createMockReasoning(), durationBinding = {}, voiceOptions = {}, host: createHost } = {}) {
  const storage = new SQLiteStorage(path), secrets = createFacadeSecrets();
  let clock = Date.now(), sequence = 0, covered = true, secretReads = 0, coverageReads = 0, healthReads = 0, releasing = false, mintFailure, beforeCoverage;
  const opened = new Map(), ended = new Set(), waiting = new Map(), provisioned = [], traffic = [], closeRequests = [];
  const providerEvents = eventProbe();
  const endClient = id => { ended.add(id); waiting.get(id)?.(); waiting.delete(id); };
  const now = () => clock;
  const voiceCap = cap ? createVoiceCap({ storage, now, ...cap }) : undefined;
  const binding = { plugin: 'elevenlabs', model: 'fixture-agent', agentId: 'fixture-agent', effort: 'none',
    endpoint: 'https://provider.test', accountRef: 'fixture', secretRef: 'fixture-ref', maxMicro: 60_000,
    maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds: 60, minRunwaySeconds: 1,
    upstreamMicroPerMinute: 60_000, visitorMicroPerMinute: 120_000, publicFacadeBaseUrl: 'https://facade.test', ...durationBinding };
  binding.legal = { approved: true, countries: ['AT'], training: false, retention: 'fixture', purpose: 'conversation',
    recipient: 'fixture', processors: [], dataCategories: ['conversation'], consentVersion: 1,
    evidence: { qualified: true, accountRef: binding.accountRef, secretRef: binding.secretRef,
      model: binding.model, endpoint: binding.endpoint, routing: {}, verifiedAt: clock - 1000, expiresAt: clock + 100_000 } };
  const plugin = createVoiceProvider({ storage, now, binding: { agentId: binding.agentId, secretRef: binding.secretRef,
    apiBaseUrl: binding.endpoint, upstreamMicroPerMinute: binding.upstreamMicroPerMinute, visitorMicroPerMinute: binding.visitorMicroPerMinute,
    reservationSeconds: binding.reservationSeconds, usdPerCredit: binding.usdPerCredit },
    resolveSecret: () => { secretReads++; return 'provider-fixture-value'; }, revokeFacade: secrets.revoke,
    closureTimeoutMs: slowClosure ? 30_000 : 10_000,
    requestProviderClose: record => { closeRequests.push(record.providerSessionId); providerEvents.record({ type: 'close', id: record.providerSessionId }); },
    async provisionFacade(record) { assert.ok(secrets.resolve(record.facadeSecretRef)); provisioned.push(record); },
    fetchImpl: async url => {
      traffic.push(String(url));
      if (String(url).includes('/token?')) {
        if (mintFailure) {
          providerEvents.record({ type: 'mint-failed' });
          return typeof mintFailure === 'number' ? Response.json({}, { status: mintFailure }) : mintFailure;
        }
        const id = `provider-${++sequence}`; opened.set(id, clock);
        return Response.json({ token: 'fixture-credential', conversation_id: id });
      }
      const id = String(url).split('/').at(-1);
      providerEvents.record({ type: 'details', id });
      // Provider closure is unavailable until the browser ends the SDK session.
      if (slowClosure && !ended.has(id) && !releasing) await new Promise(resolve => waiting.set(id, resolve));
      return Response.json({ conversation_id: id, status: unknown ? 'processing' : 'done',
        metadata: { start_time_unix_secs: opened.get(id) / 1000, call_duration_secs: (clock - opened.get(id)) / 1000, cost: 7 } });
    } });
  const presets = mockPresets();
  const health = plugin.health; plugin.health = options => { healthReads++; return health(options); };
  presets.best.plugins.push('elevenlabs'); presets.best.bindings.voice = binding; presets.best.policy = { endpoints: [binding.endpoint] };
  const consent = { async coverage({ scope, consentRevision }) { coverageReads++; await beforeCoverage?.(); return { covered, ...scope, scope, consentRevision, checkedAt: clock, expiresAt: clock + 100_000 }; } };
  const registry = new PluginRegistry().register(createMockReasoning()).register(plugin);
  const admittedRuntime = createPluginRuntime({ storage, registry, presets, consent, now, voiceCap });
  // Instrument reasoning after canonical admission; wrappers never gain mock trust.
  const runtime = { ...admittedRuntime, async admit(args) {
    const admitted = await admittedRuntime.admit(args);
    return args.lane === 'voice' ? admitted : { ...admitted, plugin: reasoning };
  } };
  const host = createHost?.({ storage, now });
  let handlers = createHandlers({ storage, reasoning, pluginRuntime: runtime, consent, host, voice: { secrets, now, browserLeaseMs: leaseMs, ...voiceOptions } });
  t.after(async () => { releasing = true; for (const id of waiting.keys()) endClient(id); await handlers.close(); storage.close(); });
  const token = 'voice-owner', session = storage.create({ ownerToken: token, demo: true });
  const route = async (suffix, body = {}, owner = token) => handlers.handle(new Request(`http://host/api/sessions/${session.id}${suffix}`, {
    method: 'POST', headers: { 'x-aithema-session-token': owner }, body: JSON.stringify(body) }));
  const start = async (callId = 'call-1') => {
    const response = await route('/voice', { callId }); assert.equal(response.status, 201); return response.json();
  };
  return { storage, secrets, runtime, get handlers() { return handlers; }, replaceHandlers(value) { handlers = value; }, consent,
    host, session, route, start, presets, provisioned, traffic, now, voiceCap, plugin: registry.get('elevenlabs'), endClient, closeRequests,
    failMint: failure => { mintFailure = failure; },
    waitForMintFailure: () => providerEvents.waitFor(event => event.type === 'mint-failed'),
    waitForClosure: id => providerEvents.waitFor(event => event.type === 'details' && event.id === id),
    authChecks: () => ({ secretReads, coverageReads, healthReads }),
    advance: ms => { clock += ms; }, coverage: value => { covered = value; }, beforeCoverage: fn => { beforeCoverage = fn; } };
}

