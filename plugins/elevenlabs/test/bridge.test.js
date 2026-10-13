import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElevenLabsConfig, createVoiceBinding, createElevenLabsReplyExecutor } from '../src/server.js';
import { elevenLabsMediaGrant } from '../src/client.js';
import { createDurationBinding, durationPluginMatches } from '../../../packages/server/src/voice-binding.js';
import { assertVoicePorts, assertVoiceSession } from '../../../packages/core/src/live-voice.js';
import { binding as commonBinding } from '../../../test/plugin-fixtures.js';
import { fixture, invocationOptions, receipt } from './fixtures.js';
import { SQLiteStorage } from '../../../packages/server/src/storage.js';
import { createVoiceTurnOperations } from '../../../packages/server/src/voice-turns.js';
import { normalizeElevenLabsDurationBinding } from '../src/config.js';

test('AIT-102: private config normalizes legacy fields without coupling model identity', () => {
  const config = createElevenLabsConfig({ agentId: 'agent', usdPerCredit: 0.000264, publicFacadeBaseUrl: 'https://host.example.test/' });
  const raw = { ...commonBinding('elevenlabs', 'https://api.example.test', { model: 'agent' }),
    ...config, maxDurationSeconds: 60, upstreamMicroPerMinute: 600, visitorMicroPerMinute: 300 };
  const flat = createDurationBinding(normalizeElevenLabsDurationBinding(raw));
  const { agentId, usdPerCredit, publicFacadeBaseUrl, ...generic } = raw;
  const nested = createDurationBinding({ ...generic, adapterConfig: config });
  assert.equal(JSON.stringify(flat), JSON.stringify(nested));
  assert.ok(Object.isFrozen(flat.adapterConfig));
  assert.equal(flat.adapterConfig.agentId, config.agentId); assert.equal(flat.adapterConfig.publicFacadeBaseUrl, 'https://host.example.test');
  assert.equal(Object.keys(flat).includes('adapterConfig'), true);
  assert.equal(Object.hasOwn(flat, 'agentId'), false);
  const serverFlat = createVoiceBinding({ ...raw, apiBaseUrl: raw.endpoint });
  const serverNested = createVoiceBinding({ ...generic, apiBaseUrl: raw.endpoint, adapterConfig: config });
  assert.equal(JSON.stringify(serverFlat), JSON.stringify(serverNested));
  assert.equal(durationPluginMatches({ binding: { endpoint: serverNested.apiBaseUrl, secretRef: serverNested.secretRef,
    upstreamMicroPerMinute: serverNested.upstreamMicroPerMinute, visitorMicroPerMinute: serverNested.visitorMicroPerMinute,
    adapterConfig: config } }, flat), true);
  assert.equal(createDurationBinding({ ...generic, model: 'other', adapterConfig: config }).model, 'other');
  assert.throws(() => createElevenLabsConfig({ agentId: 'bad/agent' }), TypeError);
  assert.throws(() => createElevenLabsConfig({ ...config, usdPerCredit: -1 }), TypeError);
  assert.throws(() => createElevenLabsConfig({ ...config, publicFacadeBaseUrl: 'https://user:pass@host.example.test' }), TypeError);
});

test('AIT-102: server port consumes admission and delegates closure and reconciliation', async t => {
  const f = fixture({ providerDetails: { conversation_id: 'conv_1', status: 'done', metadata: { call_duration_secs: 120, cost: 0 } } });
  const port = assertVoicePorts(f.server.ports).serverAdapter;
  assert.ok(Object.isFrozen(port.config));
  await assert.rejects(port.startSegment({ callId: 'refused', facadeSecretRef: 'fixture-facade-ref' },
    invocationOptions({ attempt: { attemptId: 'refused', claimId: 'refused', maxMicro: 10_000, consume() { throw new Error('refused'); } } })), /refused/);
  assert.equal(f.requests.length, 0);
  const options = invocationOptions();
  const segment = await port.startSegment({ callId: 'call', facadeSecretRef: 'fixture-facade-ref' }, options);
  t.after(() => segment.close('closed'));
  assert.equal(segment.grant.callId, segment.callId); assert.equal(segment.grant.providerSessionId, segment.providerSessionId);
  assert.ok(segment.grant.expiresAt > Date.now());
  assert.equal(JSON.stringify(segment.grant).includes('fixture-api-key'), false);
  assert.equal(JSON.stringify(segment.grant).includes('fixture-facade-ref'), false);
  const evidence = await port.reconciliationEvidence({ call: segment.snapshot(), maxMicro: 10_000 }, { deadlineAt: Date.now() + 1000 });
  assert.equal(evidence.details.status, 'done'); assert.equal(evidence.terminal.closureConfirmed, true);
  const closed = await port.stopSegment(segment, { reason: 'closed', deadlineAt: Date.now() + 1000 });
  assert.deepEqual(closed, evidence.terminal);
  assert.equal(options.reports.length, 1);
});

test('AIT-102: browser port uses the existing capture, playback and synchronous teardown', async t => {
  const f = fixture();
  const server = await f.server.start({ callId: 'call', facadeSecretRef: 'fixture-facade-ref' }, invocationOptions());
  f.sessions.set(server.providerSessionId, server);
  t.after(() => server.close('closed'));
  const port = assertVoicePorts(f.client.ports).browserMedia;
  const grant = elevenLabsMediaGrant(receipt(server));
  const session = assertVoiceSession(await port.connect(grant, { deadlineAt: Date.now() + 1000 }));
  t.after(() => session.close({ deadlineAt: Date.now() + 1000 }));
  assert.equal(f.requests.filter(r => r.url.pathname.endsWith('/token')).length, 1, 'connecting a grant does not mint again');
  await port.capture(session, false, { deadlineAt: Date.now() + 1000 });
  assert.equal(f.sdk.conversations[0].track.readyState, 'ended');
  await port.playback(session, false, { deadlineAt: Date.now() + 1000 });
  assert.deepEqual(f.sdk.effects.filter(e => e[0] === 'setVolume').at(-1), ['setVolume', 0]);
  const closed = port.teardown(session, { deadlineAt: Date.now() + 1000 });
  assert.ok(f.sdk.acquired.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
  await closed;
  const starts = f.sdk.starts.length;
  await assert.rejects(port.connect({ ...grant, expiresAt: Date.now() - 1 }, {}), { code: 'deadline' });
  assert.equal(f.sdk.starts.length, starts);
});

test('AIT-102: provider-owned STT/TTS ports explicitly return unavailable without work', async () => {
  const f = fixture(), { stt, tts } = assertVoicePorts(f.server.ports).components;
  await assert.rejects(stt.transcribe({}, {}), { code: 'unavailable' });
  await assert.rejects(stt.negotiateAudioFormat([], {}), { code: 'unavailable' });
  await assert.rejects(tts.negotiateAudioFormat([], {}), { code: 'unavailable' });
  await assert.rejects(tts.speak({}, {}).next(), { code: 'unavailable' });
  assert.equal(f.requests.length, 0);
});

test('AIT-102: reply bridge emits operation, deltas and completion from the unchanged SSE codec', async () => {
  const fixtures = JSON.parse(await readFile(new URL('../../../test/fixtures/elevenlabs-wire.json', import.meta.url), 'utf8'));
  const wire = fixtures.callbacks.find(c => c.name === 'retry-stream').response;
  const operation = { key: 'rule-c-key', callId: 'call', providerSessionId: 'generation', ordinal: 1 };
  const envelope = { source: 'authenticated-provider', payload: { callbackBody: {} } };
  let executions = 0;
  const bridge = createElevenLabsReplyExecutor({ execute(value) { assert.equal(value, envelope); executions++; return { operation, response: new Response(wire.body, wire) }; } });
  assertVoicePorts({ replyExecutor: bridge });
  const events = [];
  for await (const event of bridge.execute(envelope, { deadlineAt: Date.now() + 1000 })) events.push(event);
  assert.deepEqual(events[0], { type: 'operation', operation, replyId: 'chatcmpl-FIXTURE' });
  assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), 'Die erste Frage: Was soll entstehen?');
  assert.deepEqual(events.at(-1), { type: 'completion', replyId: 'chatcmpl-FIXTURE', text: 'Die erste Frage: Was soll entstehen?' });
  await assert.rejects(bridge.execute({ ...envelope, source: 'browser-final' }, {}).next(), { code: 'not-admitted' });
  assert.equal(executions, 1);
  const partial = fixtures.callbacks.find(c => c.name === 'partial-failure').response;
  const broken = createElevenLabsReplyExecutor({ execute: () => ({ operation, response: new Response(partial.body, partial) }) });
  const received = [];
  await assert.rejects(async () => { for await (const event of broken.execute(envelope, {})) received.push(event); }, { code: 'provider' });
  assert.ok(!received.some(e => e.type === 'completion'));
});

test('AIT-102: reply bridge uses Rule C identity and duplicate execution from the existing store', async t => {
  const fixtures = JSON.parse(await readFile(new URL('../../../test/fixtures/elevenlabs-wire.json', import.meta.url), 'utf8'));
  const wire = fixtures.callbacks.find(c => c.name === 'retry-stream').response;
  const storage = new SQLiteStorage(), session = storage.create({ demo: true, ownerToken: 'fixture-owner' });
  const turns = createVoiceTurnOperations({ storage });
  t.after(async () => { await turns.idle(); storage.close(); });
  let executions = 0;
  const payload = { sessionId: session.id, callId: 'call', providerSessionId: 'generation', stream: true,
    callbackBody: { messages: [{ role: 'user', content: 'Ja' }], metadata: { fixture: true } } };
  const bridge = createElevenLabsReplyExecutor({ async execute(envelope, options) {
    const context = { ...envelope.payload, stream: true };
    const response = await turns.run(context, async operation => {
      operation.beforeAdmission(); operation.admitted(`fixture-attempt-${++executions}`);
      return new Response(wire.body, wire);
    }, options);
    const { operation } = storage.voiceTurnStore.claim(context);
    return { operation: { key: operation.key, callId: operation.callId, providerSessionId: operation.providerSessionId, ordinal: operation.ordinal }, response };
  } });
  const identities = [];
  for (let retry = 0; retry < 2; retry++) {
    for await (const event of bridge.execute({ source: 'authenticated-provider', payload, operation: { key: 'forged-input-key' } }, {})) {
      if (event.type === 'operation') identities.push(event.operation);
    }
  }
  assert.equal(executions, 1); assert.deepEqual(identities[0], identities[1]);
  assert.equal(identities[0].key, storage.voiceTurnStore.list(session.id)[0].key);
  assert.notEqual(identities[0].key, 'forged-input-key');
});
