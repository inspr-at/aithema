import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureComposedComponents } from '../src/configuration.js';
import { createComposedVoice } from '../src/server.js';
import { compositionFixture, invalidCompositions } from '../../../packages/core/test/voice-composition-fixtures.js';
import { fixtureBinding, fixtureConsent } from '../../elevenlabs/test/component-fixtures.js';

function configured(f) {
  const binding = { ...fixtureBinding('stt'), plugin: 'synthetic' };
  const reasoningBinding = { ...binding, plugin: 'openrouter', legal: { ...binding.legal, purpose: 'models-international', consentVersion: 1 } };
  return { enabled: true, config: { stt: 'synthetic', tts: 'synthetic' },
    componentFactories: { synthetic: { stt: () => f.stt, tts: () => f.tts } },
    componentOptions: { synthetic: { stt: { binding }, tts: { binding } } },
    composition: f, reasoningBinding, consent: fixtureConsent(binding),
    authorize: () => { f.counters.claims++; return true; } };
}

for (const [label, code, mutate] of invalidCompositions) {
  test(`AIT-328: configured ${label} fails before authority, secrets or transport`, async () => {
    const f = compositionFixture(); mutate(f);
    const args = configured(f);
    // Independently observe the configured host hooks, including secret/transport access.
    const options = args.componentOptions.synthetic;
    for (const role of ['stt', 'tts']) Object.assign(options[role], {
      resolveSecret() { f.counters.secrets++; }, connect() { f.counters.transport++; }, fetchImpl() { f.counters.transport++; },
    });
    const ports = configureComposedComponents(args);
    await assert.rejects(ports.preflight, { code });
    await assert.rejects(ports.authorize({}, { deadlineAt: Date.now() + 1000 }), { code });
    if (typeof f.stt.transcribe === 'function') await assert.rejects(ports.stt.transcribe({}, {}), { code });
    if (typeof f.tts.speak === 'function') await assert.rejects(async () => { for await (const chunk of ports.tts.speak({}, {})) void chunk; }, { code });
    assert.deepEqual({ claims: f.counters.claims, secrets: f.counters.secrets, transport: f.counters.transport },
      { claims: 0, secrets: 0, transport: 0 });
  });
}

test('AIT-328: start waits for negotiation before consuming the parent claim', async () => {
  const f = compositionFixture(), pending = Promise.withResolvers();
  f.stt.negotiateAudioFormat = () => pending.promise;
  const plugin = createComposedVoice({ ...configured(f), storage: { saveVoiceCall() {} }, commitUtterance() {} });
  const starting = plugin.start({ callId: 'synthetic-call' }, { attempt: { maxMicro: 0, consume() { f.counters.claims++; } } });
  await Promise.resolve(); await Promise.resolve(); assert.equal(f.counters.claims, 0);
  pending.resolve({ ...f.capture, encoding: 'incompatible' });
  await assert.rejects(starting, { code: 'composition-capture-format' });
  assert.deepEqual({ claims: f.counters.claims, secrets: f.counters.secrets, transport: f.counters.transport },
    { claims: 0, secrets: 0, transport: 0 });
});
