import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureComposedComponents } from '../src/configuration.js';
import { createComposedVoice } from '../src/server.js';
import { createComposedVoiceCoordinator, callDurationSeconds } from '../../../packages/server/src/composed-voice.js';
import { fixtureSocket, fixtureBinding, fixtureConsent, fixtureConfig, session } from '../../elevenlabs/test/component-fixtures.js';

function configured({ missing, beforeFinal, texts = [], requests = [] } = {}) {
  const stt = fixtureBinding('stt'), tts = fixtureBinding('tts');
  const reasoningBinding = { ...stt, plugin: 'openrouter', model: 'fixture/existing', endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    legal: { purpose: 'models-international', consentVersion: 1, recipient: 'OpenRouter, Inc.', processors: ['Existing model provider'],
      dataCategories: ['messages', 'conversation-history'] } };
  const consent = fixtureConsent(stt);
  consent.port.coverage = async ({ scope, consentRevision }) => ({ ...scope, scope, consentRevision,
    covered: ![scope.purpose, scope.operation].includes(missing), checkedAt: Date.now(), expiresAt: Date.now() + 60_000 });
  let stream = 0;
  const componentOptions = { elevenlabs: Object.fromEntries(['stt', 'tts'].map(role => [role, {
    binding: role === 'stt' ? stt : tts, config: fixtureConfig, resolveSecret: () => 'synthetic-auth',
    connect: request => {
      requests.push(request); const index = role === 'stt' ? stream++ : 0;
      return fixtureSocket({ role, text: `Firma ${index + 1}`, beforeFinal: () => beforeFinal?.(index) ?? Promise.resolve(),
        onSend: frame => { if (role === 'tts' && frame.text?.trim()) texts.push(frame.text); } });
    },
  }])) };
  return { enabled: true, config: { stt: 'elevenlabs', tts: 'elevenlabs' }, componentOptions, consent, reasoningBinding,
    authorize: async () => true };
}
function coordinator(t, args, overrides = {}) {
  const ports = configureComposedComponents(args), commits = [], audio = [], reports = [];
  const api = createComposedVoiceCoordinator({ ...ports, sessionId: session.id, callId: 'fixture-call',
    spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 30_000,
    commitUtterance: async envelope => { commits.push(envelope); },
    admitComponent: async ({ role, signal, deadlineAt }) => ({ signal, deadlineAt,
      attempt: { attemptId: `${role}-${crypto.randomUUID()}`, claimId: 'fixture-claim', maxMicro: 1000, consume() {} }, report: x => reports.push(x) }),
    replyExecutor: { async *execute() {
      yield { type: 'operation', replyId: 'existing-reply' }; yield { type: 'delta', text: 'Welche Firma? ' };
      yield { type: 'completion', replyId: 'existing-reply', text: 'Welche Firma? ' };
    } },
    relay: { event() {}, silence() {}, audio: x => audio.push(x) }, ...overrides });
  t.after(() => api.close()); return { api, commits, audio, reports };
}
const voiced = () => { const frame = Buffer.alloc(3200); for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(8000, i); return frame; };
async function turn(api) { await api.receiveAudio(voiced()); await api.receiveAudio(Buffer.alloc(16000)); }

for (const missing of ['voice-elevenlabs', 'models-international', 'speak']) {
  test(`AIT-160: missing ${missing} consent blocks selected pipeline before component dispatch`, async t => {
    const requests = [], h = coordinator(t, configured({ missing, requests }));
    await assert.rejects(h.api.receiveAudio(voiced()), { code: 'not-admitted' });
    assert.equal(requests.length, 0); assert.equal(h.reports.length, 0); assert.equal(h.commits.length, 0);
  });
}

test('AIT-160: configuration selects either vendor and keeps production factory opt-in', async () => {
  const args = configured();
  const plugin = createComposedVoice(args);
  assert.equal(plugin.ports.components.stt.model, 'scribe_v2_realtime');
  assert.equal(plugin.ports.components.tts.format.encoding, 'pcm_s16le');
  const voxtral = { ...args.componentOptions.elevenlabs.stt.binding, plugin: 'voxtral', model: 'voxtral-mini-transcribe-realtime-2602' };
  const options = { ...args, config: { stt: 'voxtral', tts: 'voxtral' }, componentOptions: { voxtral: {
    stt: { binding: voxtral }, tts: { binding: { ...voxtral, model: 'voxtral-mini-tts-2603' } },
  } } };
  const selected = configureComposedComponents(options);
  assert.equal(selected.stt.model, 'voxtral-mini-transcribe-realtime-2602'); assert.equal(selected.outputFormat, 'pcm_f32le');
  assert.equal((await createComposedVoice().health()).available, false);
  assert.equal(callDurationSeconds(), 900); assert.equal(callDurationSeconds({ maxDurationSeconds: 3600 }), 3600);
  assert.throws(() => configureComposedComponents({ ...args, config: { stt: 'grok', tts: 'elevenlabs' } }), TypeError);
});

test('AIT-160: actual ElevenLabs finalizers finish out of order; Rule C history stays in capture order', async t => {
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  const h = coordinator(t, configured({ beforeFinal: async index => { if (!index) await first.promise; else second.resolve(); } }));
  t.after(() => first.resolve());
  await turn(h.api); await turn(h.api); await second.promise;
  assert.equal(h.commits.length, 0); first.resolve(); await h.api.idle();
  assert.deepEqual(h.commits.map(x => x.payload.callbackBody.messages.at(-1).content), ['Firma 1', 'Firma 2']);
  assert.equal(h.audio.length, 1); assert.equal(h.audio[0].format, 'pcm_s16le');
  assert.equal(h.reports.length, 3);
});

test('AIT-160: long reasoning output is synthesized in ordered fragments bounded to 240 characters', async t => {
  const texts = [], answer = 'a'.repeat(500), h = coordinator(t, configured({ texts }), {
    replyExecutor: { async *execute() {
      yield { type: 'operation', replyId: 'existing-reply' }; yield { type: 'delta', text: answer };
      yield { type: 'completion', replyId: 'existing-reply', text: answer };
    } },
  });
  await turn(h.api); await h.api.idle();
  assert.deepEqual(texts.map(x => x.trimEnd().length), [240, 240, 20]);
  assert.equal(texts.map(x => x.trimEnd()).join(''), answer); assert.equal(h.audio.length, 3);
});

test('AIT-328: all registered and mixed compositions preflight offline with unchanged output', async () => {
  const args = configured(), source = args.componentOptions.elevenlabs;
  const vendorOptions = Object.fromEntries(['elevenlabs', 'voxtral'].map(vendor => [vendor,
    Object.fromEntries(['stt', 'tts'].map(role => [role, { ...source[role], binding: { ...source[role].binding, plugin: vendor },
      resolveSecret() { assert.fail('preflight resolved a secret'); },
      connect() { assert.fail('preflight opened a transport'); }, fetchImpl() { assert.fail('preflight fetched'); } }]))]));
  for (const stt of Object.keys(vendorOptions)) for (const tts of Object.keys(vendorOptions)) {
    const ports = configureComposedComponents({ ...args, config: { stt, tts }, componentOptions: vendorOptions });
    const result = await ports.preflight;
    assert.deepEqual(result.capture, { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 });
    assert.deepEqual(result.playback, { encoding: tts === 'elevenlabs' ? 'pcm_s16le' : 'pcm_f32le', sampleRateHz: 24000, channels: 1 });
    assert.equal(ports.outputFormat, result.playback.encoding);
    assert.deepEqual(result.capabilities.languages, ['de', 'en']);
    assert.equal(result.voice, fixtureConfig.voiceId);
  }
});


test('AIT-345: source-only start2 compatibility passes an explicit 3600-second ceiling', () => {
  const args = configured();
  for (const [raw, expected] of [[{ host: 'start2' }, 3600], [{ host: 'start2', maxDurationSeconds: 120 }, 120]]) {
    const plugin = createComposedVoice({ ...args, config: { ...args.config, ...raw } });
    assert.equal(plugin.ports.serverAdapter.config.maxDurationSeconds, expected);
    assert.equal(Object.hasOwn(plugin.ports.serverAdapter.config, 'host'), false);
    assert.equal(plugin.ports.serverAdapter.matchesConfig({ ...args.config, ...raw }), true);
  }
});
