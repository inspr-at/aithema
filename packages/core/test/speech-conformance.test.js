import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sttConformance, ttsConformance } from '@inspr/aithema-core';
import { PluginError, voiceOperation } from '@inspr/aithema-core';
import { speechFixture, request, format } from './speech-fixtures.js';

for (const [role, kit] of [['stt', sttConformance], ['tts', ttsConformance]]) {
  test(`${role} offline speech conformance passes all rules`, async () => {
    const { component, fixtures } = speechFixture(role);
    assert.deepEqual(await kit(component, request(role), fixtures), { ok: true, failures: [] });
  });
  for (const [fault, rule] of [
    ['format', 'format negotiation'], ['cancel', 'ignored active-cancelled'], ['deadline', 'ignored active-deadline'], ['dispatch', 'consume-before-dispatch'], ['fresh', 'fresh retry/fragment claims'],
    ['settlement', 'once-only terminal'], ['duplicate', 'once-only terminal'], ['identity', 'attempt identity'],
    ['uncertain', 'uncertain >= max(maxMicro, observed)'], ['observed', 'uncertain >= max(maxMicro, observed)'],
    ['usage', 'terminal accounting: usage'], ['cleanup', 'cancellation cleanup'], ['bounds', 'stream bounds'],
    ...(role === 'stt' ? [['input-bounds', 'stream bounds'], ['finality', 'transcript finality'], ['after-final', 'event after final'], ['replacement', 'replacement hypotheses']]
      : [['total-bounds', 'stream bounds'], ['alignment', 'aligned offsets'], ['alignment-backwards', 'aligned offsets'], ['alignment-range', 'aligned offsets'], ['alignment-fraction', 'aligned offsets'], ['heard', 'playback-confirmed heard prefixes']]),
  ]) test(`${role} broken fake names ${rule} (${fault})`, async () => {
    const { component, fixtures } = speechFixture(role, fault);
    const result = await kit(component, request(role), fixtures);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some(value => value.includes(rule)), JSON.stringify(result));
  });
  test(`${role} refuses missing offline observations`, async () => {
    const { component } = speechFixture(role);
    assert.ok((await kit(component, request(role))).failures.includes(`${role}: offline fixtures required`));
  });
}

test('format negotiation allows providers with broader sample-rate support', async () => {
  const { component, fixtures } = speechFixture('stt');
  component.negotiateAudioFormat = (offered, options) => voiceOperation(options, () => {
    const selected = offered.find(value => value.encoding === format.encoding && value.channels === 1 && value.sampleRateHz > 0);
    if (!selected) throw new PluginError('unavailable');
    return selected;
  });
  fixtures.formats = [{ ...format, sampleRateHz: 16001 }];
  fixtures.incompatibleFormats = [[{ ...format, encoding: 'unsupported-fixture' }], [{ ...format, channels: 99 }]];
  assert.deepEqual(await sttConformance(component, request('stt'), fixtures), { ok: true, failures: [] });
});
