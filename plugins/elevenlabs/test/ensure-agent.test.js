import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '../../../packages/server/src/storage.js';
import { ensureAgent, AGENT_NAME } from '../src/ensure-agent.js';
import { createVoiceHost } from '../../../demo/start2-voice-host.js';
import { fakeElevenLabs } from '../../../test/start2-fakes.js';
import { temporaryDb } from '../../../test/helpers.js';
import { AI_NOTICE, aiNoticeText } from '../../../packages/core/src/ai-notice.js';

const options = (storage, fake, logs = []) => ({ storage, apiBaseUrl: fake.endpoint, templateAgentId: 'template-agent',
  publicOrigin: 'https://start2.example.test', resolveSecret: ref => ref === 'ELEVENLABS_API_KEY' ? 'local-key-fixture' : 'local-bearer-fixture',
  log: value => logs.push(value) });
const writes = fake => fake.requests.filter(request => request.method !== 'GET');

test('startup creates only the owned agent; whitelists template settings and references workspace secret; updates after restart', async t => {
  const fake = await fakeElevenLabs(t), path = await temporaryDb(), logs = [];
  let storage = new SQLiteStorage(path); t.after(() => storage.close());
  const first = await ensureAgent(options(storage, fake, logs));
  assert.equal(first.agentId, 'owned-agent');
  assert.deepEqual(writes(fake).find(r => r.path === '/v1/convai/secrets'), {
    path: '/v1/convai/secrets', search: '', method: 'POST',
    body: { type: 'new', name: 'aithema-start2-facade', value: 'local-bearer-fixture' },
  });
  const created = writes(fake).find(r => r.path.endsWith('/agents/create')).body;
  assert.equal(created.conversation_config.tts.voice_id, 'voice-fixture');
  assert.equal(created.conversation_config.agent.language, 'en');
  assert.equal(created.conversation_config.agent.prompt.custom_llm.url, 'https://start2.example.test/api/voice/llm/chat/completions');
  assert.deepEqual(created.conversation_config.agent.prompt.custom_llm.api_key, { secret_id: 'owned-secret' });
  assert.deepEqual(created.platform_settings.auth.allowlist, [{ hostname: 'start2.example.test' }]);
  assert.equal(created.platform_settings.auth.enable_auth, true);
  assert.equal(created.platform_settings.overrides.custom_llm_extra_body, true);
  assert.equal(created.conversation_config.agent.first_message, `${AI_NOTICE.en.text} ${AI_NOTICE.en.voice}`);
  assert.deepEqual(created.platform_settings.overrides.conversation_config_override, { agent: { first_message: true, language: true } });
  assert.equal(created.platform_settings.privacy.retention_days, 30);
  assert.equal(Object.hasOwn(created, 'platform_config'), false);
  for (const text of ['template greeting', 'template persona', 'private', 'local-key-fixture', 'local-bearer-fixture']) assert.ok(!JSON.stringify(created).includes(text));
  assert.deepEqual(logs, [{ name: AGENT_NAME, id: 'owned-agent' }]);
  storage.close(); storage = new SQLiteStorage(path);
  await ensureAgent(options(storage, fake, logs));
  assert.equal(writes(fake).filter(r => r.path.endsWith('/agents/create')).length, 1);
  assert.equal(writes(fake).filter(r => r.path.endsWith('/agents/owned-agent')).length, 1);
  assert.deepEqual(writes(fake).find(r => r.path === '/v1/convai/secrets/owned-secret'), {
    path: '/v1/convai/secrets/owned-secret', search: '', method: 'PATCH',
    body: { type: 'update', name: 'aithema-start2-facade', value: 'local-bearer-fixture' },
  });
  assert.ok(fake.requests.some(r => r.path === '/v1/convai/secrets' && r.method === 'GET'));
  assert.ok(fake.requests.every(r => !r.path.includes('/workspace/secrets')));
  assert.ok(fake.requests.filter(r => r.path.endsWith('/agents/template-agent')).every(r => r.method === 'GET'));
  for (const [index, request] of fake.requests.entries()) {
    if (request.method === 'PATCH' && request.path.endsWith('/agents/owned-agent') || request.path.endsWith('/agents/create')) {
      assert.equal(fake.requests[index + 1].path, '/v1/convai/agents/owned-agent');
      assert.equal(fake.requests[index + 1].method, 'GET');
    }
  }
  assert.ok(!JSON.stringify(storage.db.prepare('SELECT * FROM host_agents').all()).includes('local-'));
});
test('ambiguity across paginated exact-name matches refuses every write and leaves voice disabled', async t => {
  const fake = await fakeElevenLabs(t, { pageSize: 1, agents: [{ name: AGENT_NAME, agent_id: 'one' }, { name: `${AGENT_NAME}-other`, agent_id: 'ignored' }, { name: AGENT_NAME, agent_id: 'two' }] });
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  await assert.rejects(ensureAgent(options(storage, fake)), /agent-name-ambiguous/);
  assert.deepEqual(writes(fake), []);
  const host = await createVoiceHost(options(storage, fake));
  assert.equal(host.disabledReason, 'agent-name-ambiguous'); assert.equal(host.binding, undefined);
});
for (const foreign of ['foreign-agent', 'template-agent']) test(`never writes ${foreign} despite a matching name`, async t => {
  const fake = await fakeElevenLabs(t, { agents: [{ name: AGENT_NAME, agent_id: foreign }] });
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  await assert.rejects(ensureAgent(options(storage, fake)), /ownership-unproven|template-agent-write-forbidden/);
  assert.deepEqual(writes(fake), []);
});
test('renamed or disappeared owned agent and incomplete lists fail closed without writes', async t => {
  const fake = await fakeElevenLabs(t), storage = new SQLiteStorage(); t.after(() => storage.close());
  await ensureAgent(options(storage, fake)); fake.agents[0].name = 'renamed'; fake.requests.length = 0;
  await assert.rejects(ensureAgent(options(storage, fake)), /agent-ownership-unproven/); assert.deepEqual(writes(fake), []);
  await assert.rejects(ensureAgent({ ...options(storage, fake), fetchImpl: async () => Response.json({ agents: [], has_more: true }) }), /agent-list-incomplete/);
});
test('upstream errors never escape to logs or public disabled reason', async t => {
  const fake = await fakeElevenLabs(t), storage = new SQLiteStorage(), logs = []; t.after(() => storage.close());
  const host = await createVoiceHost({ ...options(storage, fake, logs), fetchImpl: async () => { throw new Error('local-bearer-fixture config body'); } });
  assert.equal(host.disabledReason, 'agent-api-unavailable'); assert.deepEqual(logs, []);
});
test('the allowlist uses the origin host including its port and excludes the scheme', async t => {
  const fake = await fakeElevenLabs(t), storage = new SQLiteStorage(); t.after(() => storage.close());
  const host = await createVoiceHost({ ...options(storage, fake), publicOrigin: 'https://start2.example.test:8443' });
  assert.ok(host.binding);
  assert.deepEqual(fake.agents[0].platform_settings.auth.allowlist, [{ hostname: 'start2.example.test:8443' }]);
});

const mismatches = [
  ['platform_settings.auth.enable_auth', false],
  ['platform_settings.auth.allowlist', []],
  ['platform_settings.auth.allowlist', [{ hostname: 'https://start2.example.test' }]],
  ['platform_settings.auth.allowlist', [{ hostname: 'start2.example.test' }, { hostname: 'foreign.test' }]],
  ['platform_settings.overrides.custom_llm_extra_body', false],
  ['platform_settings.overrides.conversation_config_override.agent.first_message', false],
  ['platform_settings.overrides.conversation_config_override.agent.language', false],
  ['conversation_config.agent.first_message', ''],
  ['conversation_config.agent.first_message', ' '],
  ['conversation_config.agent.first_message', 'template greeting'],
  ['conversation_config.agent.prompt.llm', 'other-llm'],
  ['conversation_config.agent.prompt.custom_llm.url', 'https://foreign.test/callback'],
  ['conversation_config.agent.prompt.custom_llm.api_key.secret_id', 'foreign-secret'],
  ['platform_settings.privacy.record_voice', true],
  ['platform_settings.privacy.retention_days', 99],
  ['platform_settings.privacy.delete_audio', false],
  ['platform_settings.privacy.delete_transcript', false],
  ['platform_settings.privacy.zero_retention_mode', false],
];
for (const mode of ['create', 'PATCH']) {
  for (const [field, value] of mismatches) test(`${mode} read-back refuses ${field}=${JSON.stringify(value)} and disables voice`, async t => {
    const fake = await fakeElevenLabs(t), storage = new SQLiteStorage(), logs = [];
    t.after(() => storage.close());
    Object.assign(fake.template.platform_settings.privacy, { delete_audio: true, delete_transcript: true, zero_retention_mode: true });
    if (mode === 'PATCH') await ensureAgent(options(storage, fake));
    let written = false;
    const host = await createVoiceHost({ ...options(storage, fake, logs), fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (init.method !== 'GET' && new URL(url).pathname.startsWith('/v1/convai/agents/')) written = true;
      if (written && init.method === 'GET' && new URL(url).pathname.endsWith('/agents/owned-agent')) {
        const saved = await response.json(), path = field.split('.'), key = path.pop();
        const target = path.reduce((object, part) => object[part], saved);
        target[key] = structuredClone(value);
        return Response.json(saved);
      }
      return response;
    } });
    assert.equal(written, true);
    assert.equal(host.binding, undefined);
    assert.equal(host.disabledReason, 'agent-readback-mismatch');
    assert.deepEqual(logs, [{ name: AGENT_NAME, id: 'owned-agent', fields: [field] }]);
  });
  test(`${mode} rejects the wrong top-level platform key and disables voice`, async t => {
    const fake = await fakeElevenLabs(t), storage = new SQLiteStorage(); t.after(() => storage.close());
    if (mode === 'PATCH') await ensureAgent(options(storage, fake));
    const host = await createVoiceHost({ ...options(storage, fake), fetchImpl: async (url, init) => {
      if (init.method !== 'GET' && new URL(url).pathname.startsWith('/v1/convai/agents/')) {
        const body = JSON.parse(init.body);
        body.platform_config = body.platform_settings; delete body.platform_settings;
        init = { ...init, body: JSON.stringify(body) };
      }
      return fetch(url, init);
    } });
    assert.equal(host.binding, undefined);
    assert.equal(host.disabledReason, `agent-api-${mode === 'create' ? 'post' : 'patch'}-400`);
  });
  test(`${mode} read-back failure disables voice without logging provider values`, async t => {
    const fake = await fakeElevenLabs(t), storage = new SQLiteStorage(), logs = []; t.after(() => storage.close());
    if (mode === 'PATCH') await ensureAgent(options(storage, fake));
    let written = false;
    const host = await createVoiceHost({ ...options(storage, fake, logs), fetchImpl: async (url, init) => {
      if (written && init.method === 'GET' && new URL(url).pathname.endsWith('/agents/owned-agent')) {
        return new Response('private provider details', { status: 500 });
      }
      const response = await fetch(url, init);
      if (init.method !== 'GET' && new URL(url).pathname.startsWith('/v1/convai/agents/')) written = true;
      return response;
    } });
    assert.equal(host.binding, undefined); assert.equal(host.disabledReason, 'agent-api-get-500');
    assert.deepEqual(logs, [{ name: AGENT_NAME, id: 'owned-agent', fields: ['agent-readback'] }]);
  });
}
test('an uncertain secret creation stays closed across restart and names only the orphan secret', async t => {
  const fake = await fakeElevenLabs(t), storage = new SQLiteStorage(), logs = []; t.after(() => storage.close());
  const host = await createVoiceHost({ ...options(storage, fake, logs), fetchImpl: async (url, init) => {
    const response = await fetch(url, init);
    if (init.method === 'POST' && new URL(url).pathname === '/v1/convai/secrets') {
      await response.body.cancel(); return Response.json({});
    }
    return response;
  } });
  assert.equal(host.binding, undefined); assert.equal(host.disabledReason, 'secret-create-invalid');
  const restarted = await createVoiceHost(options(storage, fake, logs));
  assert.equal(restarted.binding, undefined); assert.equal(restarted.disabledReason, 'secret-ownership-unproven');
  assert.deepEqual(logs, [{ name: 'aithema-start2-facade' }, { name: 'aithema-start2-facade' }]);
  assert.equal(storage.db.prepare('SELECT * FROM host_voice_secrets').all().length, 0);
  assert.equal(writes(fake).length, 1);
});
test('the spoken AI notice follows the template language, a host may reword it, never blank it (AIT-119)', async t => {
  const fake = await fakeElevenLabs(t), storage = new SQLiteStorage(); t.after(() => storage.close());
  fake.template.conversation_config.agent.language = 'de';
  const host = await createVoiceHost({ ...options(storage, fake), notice: { de: { text: '  ', voice: 'Antworten klingen synthetisch.' } } });
  assert.ok(host.binding);
  const spoken = `${AI_NOTICE.de.text} Antworten klingen synthetisch.`;
  assert.equal(writes(fake).find(r => r.path.endsWith('/agents/create')).body.conversation_config.agent.first_message, spoken);
  assert.equal(fake.agents[0].conversation_config.agent.first_message, spoken);
  // Every call speaks the notice first in its conversation's language.
  assert.deepEqual(host.presentation('de'), { agent: { language: 'de', firstMessage: spoken } });
  assert.deepEqual(host.presentation('en'), { agent: { language: 'en', firstMessage: aiNoticeText('en') } });
  assert.equal(host.presentation('fr'), undefined);
});
