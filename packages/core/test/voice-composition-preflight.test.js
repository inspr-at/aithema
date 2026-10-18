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
