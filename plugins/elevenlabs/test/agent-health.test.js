import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const required = ['conversation_initiation_metadata', 'asr_initiation_metadata', 'audio', 'interruption',
  'user_transcript', 'tentative_user_transcript', 'agent_response', 'agent_response_correction',
  'agent_chat_response_part', 'agent_response_metadata', 'agent_tool_response', 'ping'];
const load = async () => (await import('../src/agent-health.js')).checkAgentHealth;
function fixture(clientEvents = required) {
  const requests = [], secrets = [];
  return { requests, secrets, options: { agentId: 'configured-agent', apiBaseUrl: 'https://provider.example.test',
    resolveSecret: async name => { secrets.push(name); return 'synthetic-health-credential'; },
    fetchImpl: async (url, init) => {
      requests.push({ url, ...init });
      assert.equal(init.method, 'GET', 'health must never mutate provider configuration');
      assert.equal(init.body, undefined);
      return Response.json({ agent_id: 'configured-agent', conversation_config: { conversation: { client_events: clientEvents } } });
    } } };
}
function assertOnlyConfiguredGet(local) {
  assert.deepEqual(local.requests.map(({ url, method }) => ({ url, method })),
    [{ url: 'https://provider.example.test/v1/convai/agents/configured-agent', method: 'GET' }]);
  assert.deepEqual(local.secrets, ['ELEVENLABS_API_KEY']);
  assert.equal(local.requests[0].redirect, 'error');
}
test('AIT-379: health reads only the configured agent and accepts the complete event contract', async () => {
  const checkAgentHealth = await load(), local = fixture();
  assert.deepEqual(await checkAgentHealth(local.options), { healthy: true, agentId: 'configured-agent', clientEvents: required });
  assertOnlyConfiguredGet(local);
});
for (const [label, value] of [['missing end-call', required.filter(event => event !== 'agent_tool_response')],
  ['missing transcript', required.filter(event => event !== 'user_transcript')], ['absent', undefined],
  ['null', null], ['wrong shape', 'audio'], ['empty', []], ['extra', [...required, 'unknown']],
  ['duplicate', [...required, 'ping']], ['order drift', [...required].reverse()]]) {
  test(`AIT-379: health fails actionably without mutation: ${label}`, async () => {
    const checkAgentHealth = await load(), local = fixture(value);
    // Preserve an explicitly missing setting rather than fixture()'s default.
    if (label === 'absent') local.options.fetchImpl = async (url, init) => {
      local.requests.push({ url, ...init }); return Response.json({ agent_id: 'configured-agent' });
    };
    await assert.rejects(checkAgentHealth(local.options), error => {
      assert.equal(error.code, 'agent-client-events-mismatch');
      assert.match(error.message, /conversation_config.conversation.client_events/);
      assert.match(error.message, /agent_tool_response/);
      assert.match(error.message, /ensure/);
      assert.ok(!error.message.includes('synthetic-health-credential'));
      return true;
    });
    assertOnlyConfiguredGet(local);
  });
}
for (const status of [401, 404, 429, 503]) test(`AIT-379: health HTTP ${status} has a safe actionable failure and never retries with writes`, async () => {
  const checkAgentHealth = await load(), local = fixture();
  local.options.fetchImpl = async (url, init) => {
    local.requests.push({ url, ...init }); return new Response('private provider body', { status });
  };
  await assert.rejects(checkAgentHealth(local.options), error => {
    assert.match(error.message, new RegExp(`GET.*${status}.*configured agent`));
    assert.ok(!error.message.includes('private provider body')); return true;
  });
  assertOnlyConfiguredGet(local);
});
test('AIT-379: health sanitizes network failures and refuses invalid configuration before requesting', async () => {
  const checkAgentHealth = await load(), local = fixture();
  local.options.fetchImpl = async (url, init) => { local.requests.push({ url, ...init }); throw new Error('synthetic-health-credential'); };
  await assert.rejects(checkAgentHealth(local.options), /Agent health GET failed; check provider connectivity/);
  assertOnlyConfiguredGet(local);
  for (const invalid of [{ agentId: '../foreign' }, { apiBaseUrl: 'http://provider.example.test' },
    { apiBaseUrl: 'https://user:secret@provider.example.test' }, { apiBaseUrl: 'https://provider.example.test?query=yes' }]) {
    let calls = 0;
    await assert.rejects(checkAgentHealth({ ...local.options, ...invalid, fetchImpl: async () => { calls++; } }));
    assert.equal(calls, 0);
  }
});

test('AIT-379: historical readback without agent_tool_response fails the GET-only health check', async () => {
  const checkAgentHealth = await load(), local = fixture();
  const captured = JSON.parse(await readFile(new URL('./fixtures/agent-readback-live.json', import.meta.url), 'utf8'));
  local.options.fetchImpl = async (url, init) => { local.requests.push({ url, ...init }); return Response.json(captured); };
  await assert.rejects(checkAgentHealth(local.options), /Missing required events: agent_tool_response/);
  assertOnlyConfiguredGet(local);
});
