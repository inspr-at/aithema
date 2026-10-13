import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceBinding } from '../src/server.js';
import { createDurationBinding } from '../../../packages/server/src/voice-binding.js';
import { normalizeElevenLabsDurationBinding } from '../src/config.js';

// Captured remotely against main e9602e4 before moving any production code.
const raw = { plugin: 'elevenlabs', model: 'fixture-agent', agentId: 'fixture-agent', effort: 'none',
  endpoint: 'https://api.example.test', accountRef: 'fixture-account', secretRef: 'fixture-ref',
  maxMicro: 60_000, maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds: 60,
  upstreamMicroPerMinute: 600, visitorMicroPerMinute: 300, reservationSeconds: 30,
  usdPerCredit: 0.000264, publicFacadeBaseUrl: 'https://host.example.test/' };

// PR 2b deliberately moves agentId, usdPerCredit and publicFacadeBaseUrl into
// adapterConfig on the generic duration binding. The adapter's legacy JSON stays pinned.
const expected = '{"voice":{"agentId":"fixture-agent","secretRef":"fixture-ref","apiBaseUrl":"https://api.example.test","upstreamMicroPerMinute":600,"visitorMicroPerMinute":300,"usdPerCredit":0.000264,"reservationSeconds":30},"duration":{"plugin":"elevenlabs","model":"fixture-agent","effort":"none","endpoint":"https://api.example.test","accountRef":"fixture-account","secretRef":"fixture-ref","maxMicro":60000,"maxTokens":1,"rates":{"inputMicro":0,"outputMicro":0},"maxDurationSeconds":60,"upstreamMicroPerMinute":600,"visitorMicroPerMinute":300,"reservationSeconds":30,"adapterConfig":{"agentId":"fixture-agent","usdPerCredit":0.000264,"publicFacadeBaseUrl":"https://host.example.test"}}}';

test('AIT-102/AIT-163: binding JSON pins the deliberate private-config move plus admission runway', () => {
  // AIT-163 adds this server admission field; the adapter binding and every
  // neutral duration field must still serialize exactly as before.
  const { minRunwaySeconds, ...duration } = createDurationBinding(normalizeElevenLabsDurationBinding(raw));
  assert.equal(minRunwaySeconds, 120);
  const actual = JSON.stringify({ voice: createVoiceBinding({ ...raw, apiBaseUrl: raw.endpoint }),
    duration });
  assert.equal(actual, expected);
});
