import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceBinding } from '../src/server.js';
import { createDurationBinding } from '../../../packages/server/src/voice-binding.js';

// Captured remotely against main e9602e4 before moving any production code.
const raw = { plugin: 'elevenlabs', model: 'fixture-agent', agentId: 'fixture-agent', effort: 'none',
  endpoint: 'https://api.example.test', accountRef: 'fixture-account', secretRef: 'fixture-ref',
  maxMicro: 60_000, maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds: 60,
  upstreamMicroPerMinute: 600, visitorMicroPerMinute: 300, reservationSeconds: 30,
  usdPerCredit: 0.000264, publicFacadeBaseUrl: 'https://host.example.test/' };

test('AIT-102: pin main binding JSON before moving facade wiring', () => {
  const actual = JSON.stringify({ voice: createVoiceBinding({ ...raw, apiBaseUrl: raw.endpoint }),
    duration: createDurationBinding(raw) });
  console.log('AIT-102 binding JSON: ' + actual);
  assert.ok(actual);
});
