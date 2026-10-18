import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as components from '../src/voice-components.js';

import { compositionFixture, invalidCompositions } from './voice-composition-fixtures.js';

for (const [label, code, mutate] of invalidCompositions) {
  test(`AIT-328: ${label} fails offline with ${code}`, async () => {
    const f = compositionFixture(); mutate(f);
    await assert.rejects(async () => components.preflightVoiceComposition(f), { code });
    assert.deepEqual({ claims: f.counters.claims, secrets: f.counters.secrets, transport: f.counters.transport },
      { claims: 0, secrets: 0, transport: 0 });
  });
}

test('AIT-328: preflight negotiates offered formats and limits languages without dispatch', async () => {
  const f = compositionFixture();
  const result = await components.preflightVoiceComposition({ ...f, languages: ['DE', 'fr'] });
  assert.deepEqual(result.capture, f.capture); assert.deepEqual(result.playback, f.playback);
  assert.deepEqual(result.capabilities, { languages: ['de'], streaming: { stt: false, tts: false }, partialTranscripts: false, heardPrefix: 'unavailable' });
  assert.equal(result.voice, 'fixture-voice');
  assert.deepEqual(f.counters, { claims: 0, secrets: 0, transport: 0, negotiation: 2 });
});

test('AIT-328: negotiation failures have stable role codes', async () => {
  for (const [role, code] of [['stt', 'composition-capture-format'], ['tts', 'composition-playback-format']]) {
    const f = compositionFixture(); f[role].negotiateAudioFormat = async () => { throw new Error('synthetic unavailable'); };
    await assert.rejects(async () => components.preflightVoiceComposition(f), { code });
  }
});

test('AIT-328: offline voice policy rejects an unsupported component voice', async () => {
  const f = compositionFixture(); f.tts.validateVoice = voice => voice === 'another-voice';
  await assert.rejects(async () => components.preflightVoiceComposition(f), { code: 'composition-voice-invalid' });
});

test('AIT-328: a composition may advertise a lower truthful capability ceiling', async () => {
  const f = compositionFixture();
  f.stt.capabilities = { ...f.stt.capabilities, streaming: true, partialTranscripts: true };
  f.stt.stream = async function* () { yield { text: 'synthetic', final: true }; };
  f.tts.capabilities = { ...f.tts.capabilities, streaming: true, heardPrefix: 'aligned' };
  f.tts.speakAligned = async function* () { yield { audio: new Uint8Array(2), textEnd: 0 }; };
  const capabilities = { languages: ['de'], streaming: { stt: false, tts: false }, partialTranscripts: false, heardPrefix: 'unavailable' };
  assert.deepEqual((await components.preflightVoiceComposition({ ...f, capabilities })).capabilities, capabilities);
});

test('AIT-328: malformed declarations cannot evade capability and voice validation', async () => {
  for (const capabilities of [null, {}, { languages: ['de'], streaming: { stt: 'yes', tts: false }, partialTranscripts: false, heardPrefix: 'unavailable' }]) {
    await assert.rejects(components.preflightVoiceComposition({ ...compositionFixture(), capabilities }), { code: 'composition-capabilities-exceeded' });
  }
  for (const voice of ['', 12, 'fixture-voice\n', ' fixture-voice']) {
    await assert.rejects(components.preflightVoiceComposition({ ...compositionFixture(), voice }), { code: 'composition-voice-invalid' });
  }
  await assert.rejects(components.preflightVoiceComposition(null), { code: 'composition-stt-invalid' });
});

test('AIT-328: cancellation and a stalled offline negotiator remain bounded without dispatch', async () => {
  const f = compositionFixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(components.preflightVoiceComposition(f, { signal: controller.signal }), { code: 'cancelled' });
  f.stt.negotiateAudioFormat = () => new Promise(() => {});
  await assert.rejects(components.preflightVoiceComposition(f, { deadlineAt: Date.now() + 30 }), { code: 'deadline' });
  assert.deepEqual(f.counters, { claims: 0, secrets: 0, transport: 0, negotiation: 0 });
});
