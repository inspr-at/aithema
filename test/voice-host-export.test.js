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
