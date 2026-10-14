import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_NOTICE, aiNoticeText } from '../packages/core/src/ai-notice.js';
import { SQLiteStorage } from '../packages/server/src/storage.js';
import { createVoiceHost } from '../demo/start2-voice-host.js';
import { createFacadeSecrets, elevenLabsCallbackPort } from '../plugins/elevenlabs/src/callbacks.js';
import { voiceOverrides } from '../plugins/elevenlabs/src/options.js';
import { createElevenLabsClient } from '../plugins/elevenlabs/src/client.js';
import { fakeSdk } from '../plugins/elevenlabs/test/fixtures.js';
import { fakeElevenLabs } from './start2-fakes.js';

const start2 = {
  de: 'Hallo, hier ist die KI-Assistenz von Augmentoring. Wie kann ich Ihnen helfen?',
  en: "Hello, this is Augmentoring's AI assistant. How can I help you?",
};
const neutral = {
  de: 'Hallo, hier ist die KI-Assistenz. Wie kann ich Ihnen helfen?',
  en: 'Hello, this is an AI assistant. How can I help you?',
};
const options = (storage, fake) => ({ storage, templateAgentId: 'template-agent', apiBaseUrl: fake.endpoint,
  publicOrigin: 'https://start2.example.test', resolveSecret: () => 'stub-key', log() {}, values: {} });

for (const locale of ['de', 'en']) {
  test(`AIT-175: ${locale} core spoken default is neutral and host-configurable; visual notice is unchanged`, () => {
    assert.equal(aiNoticeText(locale), neutral[locale]);
    assert.equal(aiNoticeText(locale, { opener: start2[locale] }), start2[locale]);
    for (const opener of [undefined, '', '   ', null]) assert.equal(aiNoticeText(locale, { opener }), neutral[locale]);
    assert.equal(aiNoticeText(locale, undefined, { voice: false }), AI_NOTICE[locale].text);
    assert.equal(aiNoticeText(locale, { text: 'Host visual notice' }, { voice: false }), 'Host visual notice');
    assert.equal(AI_NOTICE[locale].voice, locale === 'de' ? 'Gesprochene Antworten nutzen eine synthetische Stimme.' : 'Spoken replies use a synthetic voice.');
  });

  test(`AIT-175: ${locale} start2 opener reaches the SDK exactly; continuation stays empty`, async t => {
    const fake = await fakeElevenLabs(t), storage = new SQLiteStorage();
    t.after(() => storage.close());
    const host = await createVoiceHost(options(storage, fake)); t.after(() => host.close());
    assert.ok(host.binding);
    assert.equal(host.presentation(locale).agent.firstMessage, start2[locale]);
    const callbacks = elevenLabsCallbackPort.bindCallbacks({ secrets: createFacadeSecrets(),
      presentation: host.presentation, getCall() {}, buildRequest() {}, admitReasoning() {} });
    for (const continuation of [false, true]) {
      const prepared = callbacks.prepareCallback({ callId: 'stub-call', binding: host.binding, locale, continuation });
      const overrides = prepared.request.overrides;
      assert.deepEqual(overrides, { agent: { language: locale, firstMessage: continuation ? '' : start2[locale] } });
      assert.deepEqual(voiceOverrides(overrides), overrides);
      const sdk = fakeSdk();
      const client = createElevenLabsClient({ sdk, mediaDevices: sdk.mediaDevices, AudioContext: sdk.AudioContext,
        persistEvent: async () => {}, control: { start: async () => ({ callId: 'stub-call', providerSessionId: 'stub-conversation',
          overrides, credential: { providerSessionId: 'stub-conversation', connectionType: 'webrtc', conversationToken: 'fixture-token-stub-conversation', ttlMs: 60_000 },
          spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 30_000 }), close: async () => ({ closureConfirmed: true }),
          pause: async () => ({ acknowledged: true, paused: true }), resume: async () => ({ acknowledged: true, paused: false }),
          heartbeat: async () => ({ acknowledged: true, browserLivenessDeadlineAt: Date.now() + 30_000 }) } });
      const session = await client.start({ callId: 'stub-call' });
      try { assert.deepEqual(sdk.starts[0].overrides, overrides); } finally { await session.close(); }
    }
  });

  test(`AIT-175: ${locale} owned-agent create/restart writes and accepts exactly start2's opener`, async t => {
    const fake = await fakeElevenLabs(t), storage = new SQLiteStorage(); t.after(() => storage.close());
    fake.template.conversation_config.agent.language = locale;
    for (let restart = 0; restart < 2; restart++) {
      const host = await createVoiceHost({ ...options(storage, fake), fetchImpl: async (url, init) => {
        const response = await fetch(url, init);
        if (init.method !== 'GET' || !new URL(url).pathname.endsWith('/agents/owned-agent')) return response;
        const remote = await response.json(); remote.conversation_config.agent.first_message = start2[locale];
        return Response.json(remote);
      } });
      t.after(() => host.close());
      assert.ok(host.binding, host.disabledReason);
      assert.equal(fake.agents[0].conversation_config.agent.first_message, start2[locale]);
      assert.ok(fake.requests.filter(r => r.path.endsWith('/agents/template-agent')).every(r => r.method === 'GET'));
    }
  });

  for (const unexpected of ['', neutral[locale], start2[locale === 'de' ? 'en' : 'de'], `${AI_NOTICE[locale].text} ${AI_NOTICE[locale].voice}`]) {
    test(`AIT-175: ${locale} read-back rejects ${JSON.stringify(unexpected)}`, async t => {
      const fake = await fakeElevenLabs(t), storage = new SQLiteStorage(); t.after(() => storage.close());
      fake.template.conversation_config.agent.language = locale;
      const host = await createVoiceHost({ ...options(storage, fake), fetchImpl: async (url, init) => {
        const response = await fetch(url, init);
        if (init.method !== 'GET' || !new URL(url).pathname.endsWith('/agents/owned-agent')) return response;
        const remote = await response.json(); remote.conversation_config.agent.first_message = unexpected;
        return Response.json(remote);
      } });
      t.after(() => host.close());
      assert.equal(host.binding, undefined);
      assert.equal(host.disabledReason, 'agent-readback-mismatch');
    });
  }
}

test('AIT-175: a different host can configure its opener without changing the neutral core default', async t => {
  const fake = await fakeElevenLabs(t), storage = new SQLiteStorage(); t.after(() => storage.close());
  const spokenOpeners = { en: 'Welcome to Example, your AI assistant is ready.', de: 'Willkommen bei Example, hier ist Ihre KI-Assistenz.' };
  const host = await createVoiceHost({ ...options(storage, fake), spokenOpeners }); t.after(() => host.close());
  assert.ok(host.binding);
  assert.equal(fake.agents[0].conversation_config.agent.first_message, spokenOpeners.en);
  for (const locale of ['de', 'en']) {
    assert.equal(host.presentation(locale).agent.firstMessage, spokenOpeners[locale]);
    assert.deepEqual(voiceOverrides(host.presentation(locale)), host.presentation(locale));
    assert.equal(aiNoticeText(locale), neutral[locale]);
  }
  assert.equal(aiNoticeText('fr'), neutral.en);
});

test('AIT-175: undisclosed host copy is rejected before provider calls; overrides remain limited', async t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  let calls = 0;
  const host = await createVoiceHost({ storage, spokenOpeners: { en: 'Hello, a human is ready.' },
    fetchImpl: async () => { calls++; assert.fail('Invalid opener must never reach a provider'); }, values: {}, log() {} });
  t.after(() => host.close());
  assert.equal(host.binding, undefined); assert.equal(calls, 0);
  for (const language of ['de', 'en']) {
    for (const firstMessage of [' ', 'Hello, a human is ready.', start2[language === 'de' ? 'en' : 'de'],
      `${start2.de} ${start2.en}`, `AI assistant KI-Assistenz`, 1, null, 'AI assistant'.repeat(100)]) {
      assert.throws(() => voiceOverrides({ agent: { language, firstMessage } }), TypeError);
    }
    assert.throws(() => voiceOverrides({ agent: { language, firstMessage: start2[language], prompt: 'injected' } }), TypeError);
  }
});
