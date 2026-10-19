import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry, publicReasoningManifest, processingScope } from '@inspr/aithema-core';
import { SQLiteStorage } from '../../../packages/server/src/storage.js';
import { createPluginRuntime } from '../../../packages/server/src/plugin-runtime.js';
import { createVoiceHandlers } from '../../../packages/server/src/voice-handlers.js';
import { createGrokVoiceClient } from '../src/client.js';
import { createComposedComponentAccounting } from '@inspr/aithema-server/composed-voice/accounting';
import { SQLiteBudgetLedger } from '../../../packages/server/src/budget.js';
import { binding, provider } from './admission-fixtures.js';
import { harness as sttHarness } from './fixtures.js';
import { ttsHarness } from './tts-fixtures.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const pcm = () => { const bytes = Buffer.alloc(3200); for (let i = 0; i < bytes.length; i += 2) bytes.writeInt16LE(8000, i); return bytes; };

function fixture(t, { denied, preset = 'best', missingTransport = false, defaultAccounting = false, visitorMicroPerMinute = 0, ttsMode = 'completed', ttsAudioBytes = 4 } = {}) {
  const storage = new SQLiteStorage(), session = storage.create({ ownerToken: 'owner' });
  const voice = binding(), stt = sttHarness(), tts = ttsHarness({ mode: ttsMode, audioBytes: ttsAudioBytes }), consumed = [], reports = [], coverage = [], played = [], persisted = [], reasoningRequests = [], controlErrors = [];
  const budget = new SQLiteBudgetLedger(storage), accounting = createComposedComponentAccounting({ storage, budget });
  voice.visitorMicroPerMinute = visitorMicroPerMinute;
  const reasoning = { plugin: 'fixture-reasoning', model: 'admitted-answer', endpoint: 'https://reasoning.test',
    effort: 'none', accountRef: 'private:reasoning-account', secretRef: 'private:reasoning-secret',
    maxMicro: 100000, maxTokens: 100, rates: { inputMicro: 1, outputMicro: 1 } };
  reasoning.legal = { ...voice.legal, purpose: 'models-international', recipient: 'Separate model recipient', countries: ['AT'],
    evidence: { ...voice.legal.evidence, accountRef: reasoning.accountRef, secretRef: reasoning.secretRef,
      endpoint: reasoning.endpoint, model: reasoning.model } };
  const consent = { async coverage({ scope, consentRevision }) {
    coverage.push(scope);
    return { ...scope, scope, covered: ![scope.purpose, scope.operation].includes(denied), consentRevision,
      checkedAt: Date.now(), expiresAt: Date.now() + 60000 };
  } };
  const reasoningPlugin = { binding: reasoning, manifest: publicReasoningManifest(reasoning.plugin, 'Fixture reasoning', reasoning.endpoint),
    health: async () => ({ available: true }), structured() { assert.fail('Voice reasoning must use streaming'); }, async *stream(request, options) {
      await options.attempt.consume(); consumed.push('reasoning'); reasoningRequests.push(request);
      assert.ok(request.messages.some(message => message.role === 'user' && message.content === 'Hello world.'));
      yield 'Which company?'; await options.report({ attemptId: options.attempt.attemptId, outcome: 'completed', chargedMicro: 1,
        usage: { inputTokens: 2, outputTokens: 3 } });
    } };
  const p = provider({ storage, consent, binding: voice, connect: missingTransport ? undefined : options =>
    options.url.includes('/v1/stt') ? stt.connect(options) : tts.connect(options),
    authenticateRelay: request => request.headers.get('x-owner'), relayOrigin: 'https://host.test',
    admitComponent: defaultAccounting ? undefined : async request => {
      const { role, binding: selected } = request;
      assert.equal(selected.plugin, 'grok-voice');
      const admission = await accounting.admit(request);
      return { ...admission, attempt: { ...admission.attempt, async consume() {
        await admission.attempt.consume(); consumed.push(role);
      } }, report(terminal) { reports.push(terminal); return admission.report(terminal); } };
    } });
  const registry = new PluginRegistry().register(p).register(reasoningPlugin);
  const settings = { plugins: ['grok-voice', reasoning.plugin], bindings: { voice, reaction: reasoning, understanding: reasoning },
    policy: { endpoints: [voice.endpoint, reasoning.endpoint] } };
  const runtime = createPluginRuntime({ storage, budget, registry, consent, presets: { best: settings, eu: settings } });
  if (preset !== 'best') storage.db.prepare('UPDATE sessions SET snapshot=json_set(snapshot,\'$.processingPreset\',?) WHERE id=?').run(preset, session.id);
  const handlers = createVoiceHandlers({ storage, runtime, ownership: { token: request => request.headers.get('x-owner') },
    readBody: async request => new Uint8Array(await request.arrayBuffer()), publish: (_id, event) => persisted.push(event), onTurn() {} });
  const post = (suffix = '', body = {}, owner = 'owner') => handlers.handle(new Request(`https://host.test/api/sessions/${session.id}/voice${suffix}`, {
    method: 'POST', headers: { 'x-owner': owner }, body: JSON.stringify(body) }));
  const control = { start: request => post('', { ...request, tabId: 'tab' }).then(async response => {
    const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status, code: value.error }); return value;
  }) };
  for (const action of ['close', 'pause', 'resume', 'heartbeat', 'recover']) control[action] = async identity => {
    const response = await post(`/${identity.callId}/${action}`, { ...identity, tabId: 'tab' });
    const value = await response.json(); if (!response.ok) { controlErrors.push({ action, ...value }); throw Object.assign(new Error(value.error), { status: response.status, code: value.error }); } return value;
  };
  let onAudio, captureStops = 0, stops = 0;
  const client = createGrokVoiceClient({ control,
    network: { url: 'https://host.test/composed/relay', headers: { 'x-owner': 'owner' },
      fetch: (url, init) => handlers.handle(new Request(url, init)) },
    capture: async options => { onAudio = options.onAudio; return { stop() { captureStops++; } }; },
    player: { play(bytes, format) { played.push({ bytes, ...format }); }, stop() { stops++; } } });
  t.after(async () => { p.networkRelay?.close(); await handlers.close(); storage.close(); });
  return { storage, session, runtime, post, p, client, control, played, consumed, reports, coverage, persisted, reasoningRequests, controlErrors,
    audio: bytes => onAudio(bytes), get captureStops() { return captureStops; }, get stops() { return stops; } };
}

test('AIT-346: normal start receipt runs actual Grok fixtures through admitted reasoning and PCM relay', async t => {
  const h = fixture(t), session = await h.client.start({ callId: 'chain' }, { deadlineAt: Date.now() + 5000 });
  t.after(() => session.close());
  await h.audio(pcm()); await h.audio(Buffer.alloc(16000));
  for (let i = 0; i < 200 && !h.played.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  if (h.consumed.length !== 3) t.diagnostic(JSON.stringify({ reports: h.reports, transcript: h.storage.get(h.session.id).transcript, calls: h.storage.voiceCalls(h.session.id), operations: h.storage.voiceOperations(h.session.id) }));
  assert.deepEqual(h.consumed, ['stt', 'reasoning', 'tts']);
  assert.equal(h.played.length, 1); assert.equal(h.played[0].format, 'pcm_s16le'); assert.equal(h.played[0].sampleRateHz, 24000);
  assert.deepEqual(h.storage.get(h.session.id).transcript.filter(turn => !turn.erased).map(turn => [turn.role, turn.content]),
    [['user', 'Hello world.'], ['assistant', 'Which company?']]);
  assert.equal(h.reports.length, 2); assert.ok(h.reports.every(report => report.usage.estimated));
  const scopes = h.runtime.scopes(h.storage.get(h.session.id), { feature: 'voice' });
  assert.ok(scopes.some(scope => scope.plugin === 'fixture-reasoning'));
  for (const operation of ['start', 'stream', 'speak']) assert.ok(scopes.some(scope => scope.purpose === 'voice-xai' && scope.operation === operation));
  await session.setInput(false); await session.setOutput(false); assert.ok(h.captureStops > 0); assert.ok(h.stops > 0);
  await session.close();
});
test('AIT-347 P7/P8: ordinary Grok mount persists children and charges visitors with a zero upstream parent', async t => {
  const h = fixture(t, { defaultAccounting: true, visitorMicroPerMinute: 600 });
  const session = await h.client.start({ callId: 'durable-chain' }, { deadlineAt: Date.now() + 5000 });
  t.after(() => session.close());
  await h.audio(pcm()); await h.audio(Buffer.alloc(16000));
  for (let i = 0; i < 200 && !h.played.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.played.length, 1);
  await session.close();
  const rows = h.storage.db.prepare('SELECT * FROM budget_attempts WHERE session_id=?').all(h.session.id);
  const parent = rows.find(row => row.lane === 'voice'), children = rows.filter(row => ['stt', 'tts'].includes(row.lane));
  assert.equal(parent.settled_micro, 0); assert.ok(parent.settled_visitor_micro > 0);
  assert.deepEqual(children.map(row => row.lane), ['stt', 'tts']);
  assert.ok(children.every(row => row.state === 'settled' && row.settled_micro > 0 && row.settled_visitor_micro === 0));
  assert.ok(children.every(row => JSON.parse(row.component_json).parentAttemptId === parent.attempt_id));
  assert.ok(children.every(row => JSON.parse(row.usage).estimated === true));
  assert.equal(h.runtime.budget.used(h.session.id), children.reduce((sum, row) => sum + row.settled_micro, 0) + 1);
});
for (const denied of ['voice-xai', 'models-international', 'stream', 'speak']) test(`AIT-346: production start denies ${denied} before any claim dispatch`, async t => {
  const h = fixture(t, { denied });
  assert.equal((await h.post('', { callId: 'denied', tabId: 'tab' })).status, 403);
  assert.deepEqual(h.consumed, []); assert.deepEqual(h.reports, []);
});
test('AIT-346: unavailable components never fall back', async t => {
  const h = fixture(t, { missingTransport: true });
  assert.equal((await h.post('', { callId: 'denied', tabId: 'tab' })).status, 403); assert.deepEqual(h.consumed, []);
});
test('AIT-383 round 3: typed interruption persists through the real Grok host and reload', async t => {
  const h = fixture(t, { ttsAudioBytes: 48000 });
  const session = await h.client.start({ callId: 'typed-interruption-chain' }, { deadlineAt: Date.now() + 5000 });
  t.after(() => session.close().catch(() => {}));
  await h.audio(pcm()); await h.audio(Buffer.alloc(16000));
  for (let i = 0; i < 200 && !h.played.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.played.length, 1);
  const reply = h.storage.get(h.session.id).transcript.find(turn => turn.role === 'assistant');
  await session.sendText('Please continue', { deliveryId: 'typed-interruption' });
  assert.deepEqual(h.storage.get(h.session.id).transcript.find(turn => turn.id === reply.id).interruption,
    { heardLength: 'unknown' });
  assert.equal(h.storage.get(h.session.id).transcript.find(turn => turn.id === reply.id).content, 'Which company?');
  assert.equal(h.persisted.filter(event => event.type === 'voice.interrupted' && event.data.id === reply.id).length, 1);
  assert.equal(h.storage.read(h.session.id).some(event => event.type === 'turn.corrected'), false);
  await session.sendText('Please continue', { deliveryId: 'typed-interruption' });
  assert.equal(h.persisted.filter(event => event.type === 'voice.interrupted' && event.data.id === reply.id).length, 1);
  // Retire the browser reader before fixture teardown revokes its relay.
  // Otherwise the still-live reader can attempt recovery against a closed host.
  await session.close();
});

test('AIT-346: authenticated grant rejects wrong origin, owner, stale epoch and replay', async t => {
  const h = fixture(t), response = await h.post('', { callId: 'relay', tabId: 'tab' });
  assert.equal(response.status, 201); const receipt = await response.json();
  const post = (grant, owner = 'owner', origin = 'https://host.test') => h.p.networkRelay.handle(new Request('https://host.test/composed/relay', {
    method: 'POST', headers: { 'x-owner': owner, origin, 'x-composed-action': 'open' }, body: JSON.stringify(grant) }));
  assert.equal((await post(receipt.mediaGrant, 'other')).status, 403);
  assert.equal((await post(receipt.mediaGrant, 'owner', 'https://evil.test')).status, 403);
  assert.equal((await post({ ...receipt.mediaGrant, opaque: { ...receipt.mediaGrant.opaque, epoch: 99 } })).status, 403);
  assert.equal((await post({ ...receipt.mediaGrant, expiresAt: Date.now() - 1 })).status, 403);
  assert.equal((await post(receipt.mediaGrant)).status, 200); assert.equal((await post(receipt.mediaGrant)).status, 403);
});
test('AIT-346: withdrawal fences queued output and stops browser media', async t => {
  const h = fixture(t), session = await h.client.start({ callId: 'withdraw' }, { deadlineAt: Date.now() + 5000 });
  h.storage.reviseConsent(h.session.id, false, { ownerToken: 'owner' });
  await assert.rejects(h.audio(pcm()));
  for (let i = 0; i < 15; i++) await tick();
  assert.equal(h.played.length, 0); assert.ok(h.captureStops > 0); assert.ok(h.stops > 0);
  await session.close().catch(() => {});
});

for (const denied of ['voice-xai', undefined]) test(`AIT-350: Settings switches binding only with current Grok consent (${denied ?? 'granted'}) without starting media`, async t => {
  const h = fixture(t, { denied }), session = { ...h.storage.get(h.session.id), settings: { ...h.storage.get(h.session.id).settings, voice: 'off' } };
  const catalog = await h.runtime.catalog(session), voice = catalog.presets.best.voices[0];
  const result = await h.runtime.validate(session, { voice: voice.id });
  if (denied) assert.deepEqual(result, { status: 409, error: 'setting-not-allowed', field: 'voice', reason: 'current processing consent required' });
  else assert.equal(result.settings.voice, voice.id);
  assert.deepEqual(voice.facts.providerProcessing, { vendor: 'xAI', recipientCountries: ['US'], processingCountries: null, verification: 'current' });
  assert.equal(voice.facts.hostCountries, undefined, 'recipient nationality cannot qualify the processing vial');
  assert.deepEqual(h.consumed, [], 'catalogue and Settings never start paid components');
});

test('AIT-349: real Grok chain interrupts synthesis locally, persists full reply once, and recovers with model awareness', async t => {
  const h = fixture(t, { ttsAudioBytes: 48000 });
  const session = await h.client.start({ callId: 'truthful-chain' }, { deadlineAt: Date.now() + 5000 });
  t.after(() => session.close().catch(() => {}));
  await h.audio(pcm()); await h.audio(Buffer.alloc(16000));
  for (let i = 0; i < 200 && !h.played.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.played.length, 1);
  const before = h.stops, interrupt = session.interrupt();
  assert.ok(h.stops > before, 'browser silence precedes remote acknowledgement');
  await interrupt; await session.interrupt();
  for (let i = 0; i < 15; i++) await tick();
  const reply = h.storage.get(h.session.id).transcript.find(turn => turn.role === 'assistant');
  assert.equal(reply.content, 'Which company?'); assert.deepEqual(reply.interruption, { heardLength: 'unknown' });
  assert.equal(h.persisted.filter(event => event.type === 'voice.interrupted').length, 1);
  const original = session.providerSessionId;
  await session.pause();
  try { await session.resume(); } catch (error) { t.diagnostic(JSON.stringify(h.controlErrors)); throw error; }
  assert.notEqual(session.providerSessionId, original);
  assert.deepEqual(h.storage.get(h.session.id).transcript.find(turn => turn.id === reply.id).interruption, { heardLength: 'unknown' });
  assert.equal(h.storage.read(h.session.id).some(event => event.type === 'turn.corrected'), false);
  assert.equal(h.played.length, 1, 'recovery never replays old synthesis');
  await session.sendText('Continue', { deliveryId: 'after-recovery' });
  for (let i = 0; i < 200 && h.reasoningRequests.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.reasoningRequests.length, 2);
  assert.match(h.reasoningRequests[1].system, /heard length is unknown/u);
  assert.ok(h.reasoningRequests[1].messages.some(message => message.content.includes('Which company?')));
});

test('AIT-349: an authenticated browser cannot invent a Grok heard prefix or truncate the generated record', async t => {
  const h = fixture(t), session = await h.client.start({ callId: 'unavailable-heard' }, { deadlineAt: Date.now() + 5000 });
  t.after(() => session.close());
  await h.audio(pcm()); await h.audio(Buffer.alloc(16000));
  for (let i = 0; i < 200 && !h.played.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const reply = h.storage.get(h.session.id).transcript.find(turn => turn.role === 'assistant');
  assert.ok(reply);
  const response = await h.post(`/${session.callId}/events`, { providerSessionId: session.providerSessionId, epoch: session.epoch, tabId: 'tab',
    event: { type: 'heard', callId: session.callId, providerSessionId: session.providerSessionId, turnId: reply.id, prefix: 'Which' } });
  assert.equal(response.status, 403);
  assert.equal(h.storage.get(h.session.id).transcript.find(turn => turn.id === reply.id).content, 'Which company?');
  assert.equal(h.storage.read(h.session.id).some(event => event.type === 'turn.corrected'), false);
  await session.close();
});
