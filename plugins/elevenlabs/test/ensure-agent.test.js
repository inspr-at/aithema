import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '../../../packages/server/src/storage.js';
import { ensureAgent, AGENT_NAME } from '../src/ensure-agent.js';
import { createVoiceHost } from '../../../demo/start2-voice-host.js';
import { fakeElevenLabs } from '../../../test/start2-fakes.js';
import { temporaryDb } from '../../../test/helpers.js';

const options = (storage, fake, logs = []) => ({ storage, apiBaseUrl: fake.endpoint, templateAgentId: 'template-agent',
  publicOrigin: 'https://start2.example.test', resolveSecret: ref => ref === 'ELEVENLABS_API_KEY' ? 'local-key-fixture' : 'local-bearer-fixture',
  log: value => logs.push(value) });
const writes = fake => fake.requests.filter(request => request.method !== 'GET');

test('startup creates only the owned agent; whitelists template settings and references workspace secret; updates after restart', async t => {
  const fake = await fakeElevenLabs(t), path = await temporaryDb(), logs = [];
  let storage = new SQLiteStorage(path); t.after(() => storage.close());
  const first = await ensureAgent(options(storage, fake, logs));
  assert.equal(first.agentId, 'owned-agent');
  const created = writes(fake).find(r => r.path.endsWith('/agents/create')).body;
  assert.equal(created.conversation_config.tts.voice_id, 'voice-fixture');
  assert.equal(created.conversation_config.agent.language, 'en');
  assert.equal(created.conversation_config.agent.prompt.custom_llm.url, 'https://start2.example.test/api/voice/llm/chat/completions');
  assert.deepEqual(created.conversation_config.agent.prompt.custom_llm.api_key, { secret_id: 'owned-secret' });
  assert.deepEqual(created.platform_config.auth.allowlist, [{ hostname: 'https://start2.example.test' }]);
  assert.equal(created.platform_config.overrides.custom_llm_extra_body, true);
  assert.equal(created.platform_config.privacy.retention_days, 30);
  for (const text of ['template greeting', 'template persona', 'private', 'local-key-fixture', 'local-bearer-fixture']) assert.ok(!JSON.stringify(created).includes(text));
  assert.deepEqual(logs, [{ name: AGENT_NAME, id: 'owned-agent' }]);
  storage.close(); storage = new SQLiteStorage(path);
  await ensureAgent(options(storage, fake, logs));
  assert.equal(writes(fake).filter(r => r.path.endsWith('/agents/create')).length, 1);
  assert.equal(writes(fake).filter(r => r.path.endsWith('/agents/owned-agent')).length, 1);
  assert.ok(writes(fake).some(r => r.path.endsWith('/secrets/owned-secret') && r.method === 'PATCH'));
  assert.ok(fake.requests.filter(r => r.path.endsWith('/agents/template-agent')).every(r => r.method === 'GET'));
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
