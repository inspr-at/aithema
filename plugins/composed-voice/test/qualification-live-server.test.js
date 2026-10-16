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
    maxDurationSeconds: 60, reasoningAttempts: 2,
  };
}

test('live server refuses missing and malformed money binding at construction', () => {
  assert.throws(() => createQualificationServer({}), /binding/i);
  for (const role of ['stt', 'tts', 'reasoning', 'baseline']) {
    const binding = liveBinding(); delete binding[role];
    assert.throws(() => validateQualificationBinding(binding), /binding/i);
  }
  for (const [role, field, value] of [['stt', 'microPerSecond', undefined], ['tts', 'voiceId', ''],
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
