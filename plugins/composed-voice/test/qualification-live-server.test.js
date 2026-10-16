import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQualificationServer, validateQualificationBinding, matchQualificationEntities } from '../ops/qualification-live-server.mjs';
import { fixtureBinding } from '../../elevenlabs/test/component-fixtures.js';

// Models/formats: elevenlabs/src/components.js STT_MODEL/TTS_MODEL.
// All amounts are synthetic fixture tariffs, never qualification thresholds.
export function liveBinding() {
  return {
    stt: { ...fixtureBinding('stt'), secretRef: 'ELEVENLABS_API_KEY', microPerSecond: 10 },
    tts: { ...fixtureBinding('tts'), secretRef: 'ELEVENLABS_API_KEY', voiceId: 'fixture-voice', microPerCharacter: 2 },
    reasoning: { plugin: 'openrouter', model: 'anthropic/fixture', effort: 'none',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions', accountRef: 'fixture-reasoning', secretRef: 'OPENROUTER_API_KEY',
      maxMicro: 100_000, maxTokens: 128, maxInputTokens: 4096, rates: { inputMicro: 1, outputMicro: 2 },
      legal: { purpose: 'models-international', consentVersion: 1, recipient: 'OpenRouter, Inc.',
        processors: ['Anthropic'], dataCategories: ['messages', 'conversation-history'] } },
    baseline: { ...fixtureBinding('stt'), model: 'agent_fixture', agentId: 'agent_fixture', secretRef: 'ELEVENLABS_API_KEY',
      microPerMinute: 1000 },
    baselineOrigin: 'https://start2.example', baselineReasoningCeilingMicro: 23, maxDurationSeconds: 60, reasoningAttempts: 2,
  };
}

test('live server refuses missing and malformed money binding at construction', () => {
  assert.throws(() => createQualificationServer({}), /binding/i);
  for (const role of ['stt', 'tts', 'reasoning', 'baseline']) {
    const binding = liveBinding(); delete binding[role];
    assert.throws(() => validateQualificationBinding(binding), /binding/i);
  }
  for (const [role, field, value] of [['reasoning', 'effort', 'unsupported'], ['stt', 'microPerSecond', undefined], ['tts', 'voiceId', ''],
    ['baseline', 'agentId', ''], ['reasoning', 'model', ''], ['tts', 'microPerCharacter', -1]]) {
    const binding = liveBinding(); binding[role][field] = value;
    assert.throws(() => validateQualificationBinding(binding), /binding/i);
  }
  assert.equal(validateQualificationBinding(liveBinding()).stt.model, 'scribe_v2_realtime');
});

test('entity matching uses evaluateQualification NFC, de-AT case and whitespace normalization with token boundaries', () => {
  assert.deepEqual(matchQualificationEntities('In WIEN arbeitet Mu\u0308ller   GmbH mit 142 Leuten.',
    [' Wien ', 'Müller GmbH', '42', 'Graz']), [
    { expected: ' Wien ', actual: 'wien' }, { expected: 'Müller GmbH', actual: 'müller gmbh' },
    { expected: '42', actual: '' }, { expected: 'Graz', actual: '' },
  ]);
});

test('baseline requires an explicit HTTPS production origin; loopback and URL extras refuse', () => {
  const missing = liveBinding(); delete missing.baselineOrigin;
  assert.throws(() => validateQualificationBinding(missing), /binding/i);
  for (const baselineOrigin of [undefined, 'http://start2.example', 'https://localhost', 'https://127.0.0.1',
    'https://127.1', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://start2.example/',
    'https://user@start2.example', 'https://start2.example/path']) {
    assert.throws(() => validateQualificationBinding({ ...liveBinding(), baselineOrigin }), /baselineOrigin|binding/i);
  }
  assert.equal(validateQualificationBinding({ ...liveBinding(), baselineOrigin: 'https://start2.example' }).baselineOrigin, 'https://start2.example');
});

test('qualification operation mapping preserves HTML generate/edit consent scopes', () => {
  assert.deepEqual(qualificationProcessingOperations({ plugin: 'claude-html' }), ['generate', 'edit']);
});

import { SQLiteStorage } from '@inspr/aithema-server';
import { fixtureSocket } from '../../elevenlabs/test/component-fixtures.js';
import { createNetworkRelayClient } from '../src/network-client.js';
import { PluginError } from '@inspr/aithema-core/invocation';

const owner = 'fixture-owner', relayOrigin = 'http://127.0.0.1:4567';
const sentinel = 'SYNTHETIC_ONLY_NEVER_IN_EVIDENCE';
const keys = Object.freeze({ ELEVENLABS_API_KEY: sentinel, OPENROUTER_API_KEY: sentinel });
// Corpus packets and endpoint silence mirror configuration.test.js turn(); the
// 500 ms endpoint is composed-voice.js's endpointMs default, not a new threshold.
const voiced = () => { const bytes = Buffer.alloc(3200); for (let i = 0; i < bytes.length; i += 2) bytes.writeInt16LE(8000, i); return bytes; };
async function harness(t, { covered = true, retry = false, refuse, refuseConsume, texts = ['In Wien bei Müller GmbH.'], durationSeconds } = {}) {
  const storage = new SQLiteStorage(), session = storage.create({ ownerToken: owner, locale: 'de' });
  const logs = [], browserResponses = [];
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...args) => logs.push(args));
  const specs = [], reports = [], wires = [], order = [], terminals = new Map(), sockets = [];
  let sttIndex = 0, reasoningIndex = 0;
  const observed = role => {
    const spec = specs.findLast(value => value.role === role && !reports.some(report => report.attemptId === value.attemptId));
    assert.ok(spec, `${role} wire has an admission`);
    assert.ok(order.includes(`consume:${spec.attemptId}`), `${role} consume completes before transport`);
    wires.push({ role, attemptId: spec.attemptId }); order.push(`wire:${spec.attemptId}`); return spec;
  };
  const transports = {
    async connect(request) {
      if (request.url.includes('speech-to-text/realtime')) {
        observed('stt'); assert.equal(request.headers['xi-api-key'], sentinel);
        const socket = fixtureSocket({ role: 'stt', text: texts[sttIndex++] ?? 'Spätere Unterbrechung' }); sockets.push(socket); return socket;
      }
      if (request.url.includes('text-to-speech')) {
        observed('tts'); assert.equal(request.headers['xi-api-key'], sentinel);
        const socket = fixtureSocket({ role: 'tts' }); sockets.push(socket); return socket;
      }
      throw new Error('Unexpected component socket');
    },
    async fetch(url, init) {
      observed('reasoning'); assert.equal(init.headers.authorization, `Bearer ${sentinel}`);
      assert.equal(JSON.parse(init.body).model, liveBinding().reasoning.model);
      assert.deepEqual(JSON.parse(init.body), specs.at(-1).request, 'admission digest covers actual reasoning wire body');
      if (retry && reasoningIndex++ === 0) return new Response('{}', { status: 503 });
      return new Response('data: {"id":"gen-fixture","choices":[{"delta":{"content":"Danke. "},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    },
  };
  const configured = liveBinding(); if (durationSeconds) configured.maxDurationSeconds = durationSeconds;
  const server = createQualificationServer({ binding: configured, storage, keys, relayOrigin, transports,
    authenticateRelay: () => owner,
    handlers: { consent: { coverage(input) { return { ...input.scope, scope: input.scope, covered, consentRevision: input.consentRevision,
      checkedAt: Date.now(), expiresAt: Date.now() + 60_000 }; } } } });
  t.after(async () => { await server.networkRelay.close(); for (const socket of sockets) await socket.close(); storage.close(); });
  async function admit(spec) {
    if (spec.role === refuse) throw new PluginError('not-admitted');
    specs.push(spec); order.push(`admit:${spec.attemptId}`);
    const report = terminal => {
      assert.equal(terminals.has(spec.attemptId), false, 'one terminal per admitted attempt');
      terminals.set(spec.attemptId, terminal); reports.push(terminal); order.push(`report:${spec.attemptId}`);
    };
    return { attempt: { attemptId: spec.attemptId, claimId: `qualification-${spec.attemptId}`, maxMicro: spec.maxMicro,
      async consume() { if (spec.role === refuseConsume) throw new PluginError('not-admitted'); order.push(`consume:${spec.attemptId}`); } }, report };
  }
  const start = (lane = 'candidate', overrides = {}) => server.createSample({ lane, runId: 'fixture-run', owner, admit,
    item: { id: 'one', sessionId: session.id, expectedEntities: ['Wien', 'Müller GmbH'] }, ...overrides });
  async function open(sample) {
    return createNetworkRelayClient({ url: `${relayOrigin}/composed/relay`, fetch: async (url, init) => {
      const response = await server.networkRelay.handle(new Request(url, init));
      browserResponses.push(await response.clone().text()); return response;
    } })(sample.grant);
  }
  async function audioFrame(transport) {
    for (;;) {
      const value = await transport.frames.next();
      assert.equal(value.done, false);
      if (value.value.type === 'audio') return value.value;
      assert.notEqual(value.value.event?.type, 'waiting', JSON.stringify(value.value));
    }
  }
  return { logs, browserResponses, server, storage, session, specs, reports, order, wires, start, open, audioFrame, admit,
  };
}

test('candidate uses real component wire parsers and Rule C; consumes before transport, reports once, links retries', async t => {
  const h = await harness(t, { retry: true }), sample = await h.start(), transport = await h.open(sample);
  await transport.sendAudio(voiced()); await transport.sendAudio(Buffer.alloc(16000));
  await h.audioFrame(transport);
  await sample.close();
  const answer = await sample.result;
  assert.equal(answer.hypothesis, 'In Wien bei Müller GmbH.');
  assert.deepEqual(answer.entities, [{ expected: 'Wien', actual: 'wien' }, { expected: 'Müller GmbH', actual: 'müller gmbh' }]);
  const reasoning = h.specs.filter(spec => spec.role === 'reasoning');
  assert.equal(reasoning.length, 2); assert.equal(reasoning[1].retryOf, reasoning[0].attemptId);
  assert.equal(h.storage.voiceOperations(h.session.id).length, 1, 'retry stays in the existing Rule C operation');
  assert.equal(h.reports.length, h.specs.length);
  for (const spec of h.specs) {
    assert.equal(h.reports.filter(report => report.attemptId === spec.attemptId).length, 1);
    assert.ok(h.order.indexOf(`consume:${spec.attemptId}`) < h.order.indexOf(`wire:${spec.attemptId}`));
    assert.ok(h.order.indexOf(`wire:${spec.attemptId}`) < h.order.indexOf(`report:${spec.attemptId}`));
  }
  assert.doesNotMatch(JSON.stringify({ logs: h.logs, browserResponses: h.browserResponses, specs: h.specs, reports: h.reports, answer, grant: sample.grant, records: h.storage.voiceCalls(h.session.id) }), new RegExp(sentinel));
  assert.equal(h.storage.voiceCalls(h.session.id)[0].terminal.usage.costSource, 'separate-component-claims');
});

for (const refusal of ['admit', 'consume']) test(`refused ${refusal} blocks candidate STT transport`, async t => {
  const h = await harness(t, { [refusal === 'admit' ? 'refuse' : 'refuseConsume']: 'stt' });
  const sample = await h.start(), transport = await h.open(sample);
  await transport.sendAudio(voiced());
  for (;;) {
    const frame = (await transport.frames.next()).value;
    if (frame.event?.type === 'waiting') break;
  }
  await sample.close(); await assert.rejects(sample.result);
  assert.equal(h.wires.length, 0);
  assert.equal(h.reports.length, refusal === 'consume' ? 1 : 0);
});

for (const [name, options, setup] of [
  ['owner', {}, h => ({ owner: 'someone-else' })], ['consent', { covered: false }, () => ({})],
  ['pause', {}, h => { h.storage.pause(h.session.id, true); return {}; }],
  ['withdrawn', {}, h => { h.storage.reviseConsent(h.session.id, false); return {}; }],
  ['lifecycle hold', {}, h => { h.storage.transitionVoiceLifecycle(h.session.id, 'held-call', { type: 'start' }); h.storage.transitionVoiceLifecycle(h.session.id, 'held-call', { type: 'pause', reason: 'purpose' }); return {}; }],
]) test(`live ${name} refusal precedes every admission`, async t => {
  const h = await harness(t, options), override = setup(h);
  await assert.rejects(h.start('candidate', override));
  await assert.rejects(h.start('baseline', override));
  assert.equal(h.specs.length, 0); assert.equal(h.wires.length, 0);
});

test('candidate corpus hypothesis excludes a later committed barge-in utterance', async t => {
  const h = await harness(t, { texts: ['Wien', 'Bitte aufhören'] }), sample = await h.start(), transport = await h.open(sample);
  await transport.sendAudio(voiced()); await transport.sendAudio(Buffer.alloc(16000)); await h.audioFrame(transport);
  await transport.command('interrupt');
  await transport.sendAudio(voiced()); await transport.sendAudio(Buffer.alloc(16000)); await h.audioFrame(transport);
  await sample.close();
  assert.equal((await sample.result).hypothesis, 'Wien');
  assert.equal(h.reports.length, h.specs.length);
});

test('loopback baseline refuses before admission, credential mint or transport', async t => {
  const h = await harness(t);
  await assert.rejects(h.start('baseline'), /production origin/);
  assert.equal(h.specs.length, 0); assert.equal(h.wires.length, 0);
});

test('host revoke stops sample before acknowledging the hold; next sample uses a fresh grant', async t => {
  const h = await harness(t), sample = await h.start(), transport = await h.open(sample);
  await transport.sendAudio(voiced()); await transport.sendAudio(Buffer.alloc(16000)); await h.audioFrame(transport);
  await h.server.revokeSession(h.session.id); await sample.result;
  assert.ok(h.storage.voiceCalls(h.session.id).every(call => call.terminal));
  const next = await h.start(); assert.notEqual(next.grant.providerSessionId, sample.grant.providerSessionId);
  await next.close(); await assert.rejects(next.result);
});

import { createProcessingConsent } from '../../../demo/processing-consent.js';
import { qualificationProcessingBindings, qualificationProcessingOperations } from '../ops/qualification-live-server.mjs';
import { consentCoverage, processingScope } from '@inspr/aithema-core';

test('normal persistent consent ledger covers the exact selected component, reasoning and baseline scopes', async t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const session = storage.create({ ownerToken: owner }), binding = liveBinding();
  const consent = createProcessingConsent({ storage, bindings: qualificationProcessingBindings(binding), operationsForBinding: qualificationProcessingOperations });
  const document = consent.describe(session.id);
  assert.equal(consent.grant({ sessionId: session.id, consentRevision: session.consentRevision + 1,
    decision: { contract: document.contract, items: ['voice-elevenlabs', 'models-international'] } }), true);
  storage.reviseConsent(session.id, true);
  for (const [role, operation] of [['stt', 'stream'], ['tts', 'speak'], ['reasoning', 'stream'], ['baseline', 'start']]) {
    assert.equal(await consentCoverage(consent, storage.get(session.id), processingScope(binding[role], operation)), true);
  }
  assert.equal(await consentCoverage(consent, storage.get(session.id), processingScope({ ...binding.tts, model: 'other-model' }, 'speak')), false);
  storage.reviseConsent(session.id, false);
  assert.equal(await consentCoverage(consent, storage.get(session.id), processingScope(binding.stt, 'stream')), false);
});


test('baseline reasoning ceiling is required, nonnegative integer micro and safe when combined with the conversation ceiling', () => {
  for (const baselineReasoningCeilingMicro of [undefined, null, -1, .5, '23', Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => validateQualificationBinding({ ...liveBinding(), baselineReasoningCeilingMicro }), /binding/i);
  }
  for (const baselineReasoningCeilingMicro of [0, 23]) {
    assert.equal(validateQualificationBinding({ ...liveBinding(), baselineReasoningCeilingMicro }).baselineReasoningCeilingMicro, baselineReasoningCeilingMicro);
  }
});
