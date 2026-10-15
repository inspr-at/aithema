import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '@inspr/aithema-server';
import { createElevenLabsVoiceHost, normalizeElevenLabsDurationBinding } from '@inspr/aithema-plugin-elevenlabs/voice-host';
import { stubAgentApi } from './fixtures/voice-self-heal-host.js';

test('external voice host injects naming, costs, openers and its own qualification', async t => {
  const api = stubAgentApi(), storage = new SQLiteStorage();
  t.after(() => storage.close());
  const openers = { de: 'Hallo, hier ist die KI-Assistenz von START.', en: "Hello, this is START's AI assistant." };
  let qualified;
  const host = await createElevenLabsVoiceHost({ storage, templateAgentId: 'template-agent',
    publicOrigin: 'https://host.example.test', agentName: 'start-host', facadeSecretName: 'start-facade',
    apiBaseUrl: api.endpoint, fetchImpl: api.fetchImpl, resolveSecret: () => 'fixture-secret', log() {},
    spokenOpeners: openers, costConfig: { maxDurationSeconds: 600, reservationSeconds: 15,
      minRunwaySeconds: 60, upstreamMicroPerMinute: 200_000 },
    qualifyBinding: binding => { qualified = binding; return { ...binding, qualification: 'host-owned' }; } });
  t.after(() => host.close());
  assert.equal(host.disabledReason, null);
  assert.equal(api.agents[0].name, 'start-host');
  assert.equal(api.secrets[0].name, 'start-facade');
  assert.equal(api.agents[0].conversation_config.conversation.max_duration_seconds, 600);
  assert.equal(host.binding.qualification, 'host-owned');
  assert.equal(qualified.accountRef, 'start-host');
  assert.equal(qualified.maxMicro, 50_000);
  assert.equal(host.presentation('de').agent.firstMessage, openers.de);
  assert.equal(host.presentation('en').agent.firstMessage, openers.en);
  assert.equal(normalizeElevenLabsDurationBinding(host.binding).adapterConfig.agentId, 'owned-agent');
  assert.ok(api.requests.filter(r => r.path.endsWith('/template-agent')).every(r => r.method === 'GET'));
});

const hostArguments = { agentName: 'external-host', facadeSecretName: 'external-facade',
  costConfig: {}, qualifyBinding: binding => binding };
for (const [name, invalid] of Object.entries({ agentName: ['', 'invalid name', 42, null],
  facadeSecretName: ['', 'invalid name', 42, null], costConfig: [null, [], 'costs', 42],
  qualifyBinding: [null, {}, 'qualify'] })) {
  test(`voice host requires and validates ${name} before touching any provider`, async () => {
    const options = { ...hostArguments, fetchImpl: () => assert.fail('must not contact provider') };
    delete options[name];
    for (const value of [undefined, ...invalid]) {
      await assert.rejects(createElevenLabsVoiceHost({ ...options, [name]: value }),
        error => error instanceof TypeError && error.message.includes(name));
    }
  });
}

test('ensureAgent rejects omitted host names without touching Aithema agents', async () => {
  const { ensureAgent } = await import('../plugins/elevenlabs/src/ensure-agent.js');
  for (const name of ['agentName', 'facadeSecretName']) {
    const options = { ...hostArguments, fetchImpl: () => assert.fail('must not contact provider') };
    delete options[name];
    await assert.rejects(ensureAgent(options), error => error.message.includes(name));
  }
});

test('start2 undefined options preserve host defaults', async t => {
  const { createVoiceHost, START2_VOICE_OPENERS } = await import('../demo/start2-voice-host.js');
  const api = stubAgentApi(), storage = new SQLiteStorage();
  t.after(() => storage.close());
  const host = await createVoiceHost({ storage, templateAgentId: 'template-agent', publicOrigin: 'https://host.example.test',
    apiBaseUrl: api.endpoint, fetchImpl: api.fetchImpl, resolveSecret: () => 'fixture-secret', values: {}, log() {},
    agentName: undefined, facadeSecretName: undefined, costConfig: undefined, qualifyBinding: undefined,
    spokenOpeners: undefined, accountRef: undefined });
  t.after(() => host.close());
  assert.equal(host.disabledReason, null);
  assert.equal(api.agents[0].name, 'aithema-start2');
  assert.equal(api.secrets[0].name, 'aithema-start2-facade');
  assert.equal(host.binding.accountRef, 'start2-elevenlabs');
  assert.equal(host.binding.maxDurationSeconds, 3600);
  for (const locale of ['de', 'en']) assert.equal(host.presentation(locale).agent.firstMessage, START2_VOICE_OPENERS[locale]);
});

test('local voice production requires an explicit boolean simulator opt-in', async t => {
  const { createLocalVoiceProvider, isLocalVoice } = await import('@inspr/aithema-server/dev/local-voice');
  const previous = process.env.NODE_ENV;
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  process.env.NODE_ENV = 'production';
  for (const allowProductionSimulator of [undefined, false, 'true', 1]) {
    assert.throws(() => createLocalVoiceProvider({ storage, allowProductionSimulator }), /production requires allowProductionSimulator: true/u);
  }
  assert.ok(isLocalVoice(createLocalVoiceProvider({ storage, allowProductionSimulator: true })));
  process.env.NODE_ENV = 'development';
  assert.ok(isLocalVoice(createLocalVoiceProvider({ storage })));
});


test('host cannot register a real provider as the local voice simulator', async () => {
  const identity = await import('@inspr/aithema-server/local-voice-identity');
  assert.deepEqual(Object.keys(identity), ['isLocalVoice']);
  const provider = { start() {} };
  assert.equal(identity.isLocalVoice(provider), false);
  for (const path of ['dev-voice-identity', 'src/dev-voice-identity.js', 'src/local-voice-identity.js']) {
    await assert.rejects(import(`@inspr/aithema-server/${path}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
  assert.equal(identity.isLocalVoice(provider), false);
});
