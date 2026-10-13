import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceOverrides } from '../src/options.js';
import { aiNoticeText } from '../../../packages/core/src/ai-notice.js';
import { createElevenLabsClient } from '../src/client.js';
import { fakeSdk, flush } from './fixtures.js';

for (const language of ['de', 'en']) test(`AIT-138: ${language} continuation accepts empty firstMessage but rejects arbitrary greetings`, () => {
  const continuation = { agent: { language, firstMessage: '' } };
  assert.deepEqual(voiceOverrides(continuation), continuation);
  assert.deepEqual(voiceOverrides({ agent: { language, firstMessage: aiNoticeText(language) } }), { agent: { language, firstMessage: aiNoticeText(language) } });
  assert.throws(() => voiceOverrides({ agent: { language, firstMessage: 'another greeting' } }));
  assert.throws(() => voiceOverrides({ agent: { firstMessage: '' } }));
});

test('AIT-138: replacement SDK startup receives empty firstMessage and never sends a synthetic resume turn', async t => {
  const sdk = fakeSdk(); let generation = 0;
  const receipt = callId => {
    const providerSessionId = `conv_${++generation}`;
    return { callId, providerSessionId, presentation: generation === 1 ? 'opening' : 'continuation',
      credential: { providerSessionId, connectionType: 'webrtc', conversationToken: `fixture-token-${providerSessionId}`, ttlMs: 60_000 },
      overrides: { agent: { language: 'de', firstMessage: generation === 1 ? aiNoticeText('de') : '' } },
      spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 30_000 };
  };
  const control = { start: async ({ callId }) => receipt(callId), recover: async ({ callId }) => receipt(callId),
    close: async () => ({ closureConfirmed: true }), pause: async () => ({ acknowledged: true, paused: true }),
    resume: async () => ({ acknowledged: true, paused: false }), heartbeat: async () => ({ acknowledged: true, browserLivenessDeadlineAt: Date.now() + 30_000 }) };
  const session = await createElevenLabsClient({ sdk, control, persistEvent: async () => {}, mediaDevices: sdk.mediaDevices, AudioContext: sdk.AudioContext }).start({ callId: 'continuation' });
  const observed = [], reader = (async () => { for await (const event of session.events) observed.push(event); })();
  t.after(async () => { await session.close(); await reader; });
  sdk.starts[0].onDisconnect();
  for (let i = 0; i < 100 && !observed.some(event => event.type === 'recovered'); i++) await flush();
  assert.ok(observed.some(event => event.type === 'recovered'));
  assert.equal(sdk.starts[0].overrides.agent.firstMessage, aiNoticeText('de'));
  assert.deepEqual(sdk.starts[1].overrides, { agent: { language: 'de', firstMessage: '' } });
  assert.equal(sdk.effects.some(([name]) => name === 'sendUserMessage'), false, 'Rule C forbids aliasing a synthetic cross-generation turn');
});
