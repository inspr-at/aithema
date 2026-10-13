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

const expected = '{"voice":{"agentId":"fixture-agent","secretRef":"fixture-ref","apiBaseUrl":"https://api.example.test","upstreamMicroPerMinute":600,"visitorMicroPerMinute":300,"usdPerCredit":0.000264,"reservationSeconds":30},"duration":{"plugin":"elevenlabs","model":"fixture-agent","effort":"none","endpoint":"https://api.example.test","accountRef":"fixture-account","secretRef":"fixture-ref","maxMicro":60000,"maxTokens":1,"rates":{"inputMicro":0,"outputMicro":0},"agentId":"fixture-agent","maxDurationSeconds":60,"upstreamMicroPerMinute":600,"visitorMicroPerMinute":300,"reservationSeconds":30,"usdPerCredit":0.000264,"publicFacadeBaseUrl":"https://host.example.test"}}';

test('AIT-102: binding JSON stays byte-identical to main e9602e4', () => {
  const actual = JSON.stringify({ voice: createVoiceBinding({ ...raw, apiBaseUrl: raw.endpoint }),
    duration: createDurationBinding(raw) });
  assert.equal(actual, expected);
});
