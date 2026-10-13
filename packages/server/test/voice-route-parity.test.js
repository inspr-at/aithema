import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createFacadeSecrets, createVoiceHandlers } from '../src/index.js';

const methods = ['POST', 'GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const actions = ['pause', 'resume', 'heartbeat', 'close', 'recover', 'events', 'takeover'];

// Proven on main e9602e4 before the implementation commit. These expected
// statuses and error bodies deliberately do not come from the moved adapter.
for (const staticCallback of [false, true]) test(`AIT-102: main route/auth parity (${staticCallback ? 'static' : 'per-call'})`, async t => {
  const storage = new SQLiteStorage(), secrets = createFacadeSecrets();
  const owner = 'fixture-owner', session = storage.create({ demo: true, ownerToken: owner });
  const resolve = secrets.resolve;
  secrets.resolve = ref => ref === 'fixture-static' ? 'fixture-value' : resolve(ref);
  const handlers = createVoiceHandlers({ storage, secrets,
    ...(staticCallback ? { staticSecretRef: 'fixture-static' } : {}),
    ownership: { token: request => request.headers.get('x-aithema-session-token') },
    readBody: async request => new Uint8Array(await request.arrayBuffer()), publish() {},
    runtime: { admitVoice() { assert.fail('Route/auth failures must not admit voice'); },
      admit() { assert.fail('Route/auth failures must not admit reasoning'); } } });
  t.after(async () => { await handlers.close(); storage.close(); });
  const request = (path, method, token = owner, authorization, body = '{}') => new Request(`https://host.example.test${path}`, {
    method, headers: { 'x-aithema-session-token': token, ...(authorization ? { authorization } : {}) },
    ...(['GET', 'HEAD'].includes(method) ? {} : { body }) });
  const check = async (req, status, error) => {
    const response = await handlers.handle(req);
    assert.equal(response?.status ?? null, status, `${req.method} ${new URL(req.url).pathname}`);
    if (response) {
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), JSON.stringify({ error }));
    }
  };
  for (const action of ['', ...actions]) {
    const path = `/api/sessions/${session.id}/voice${action ? `/fixture-call/${action}` : ''}`;
    for (const method of methods) {
      const status = method !== 'POST' ? 405 : !action ? 409 : action === 'takeover' ? 400 : 404;
      const error = status === 405 ? 'method-not-allowed' : status === 409 ? 'voice-conflict'
        : status === 400 ? 'invalid-request' : 'session-not-found';
      await check(request(path, method), status, error);
      await check(request(path, method, 'foreign-owner'), 404, 'session-not-found');
    }
  }
  for (const method of methods) {
    await check(request('/api/voice/fixture-call/llm/chat/completions', method),
      staticCallback ? 404 : method === 'POST' ? 401 : 405,
      staticCallback ? 'not-found' : method === 'POST' ? 'unauthorized' : 'method-not-allowed');
    await check(request('/api/voice/llm/chat/completions', method),
      !staticCallback ? null : method === 'POST' ? 401 : 405,
      method === 'POST' ? 'unauthorized' : 'method-not-allowed');
  }
  const callback = staticCallback ? '/api/voice/llm/chat/completions' : '/api/voice/fixture-call/llm/chat/completions';
  for (const authorization of [undefined, 'Bearer wrong']) {
    const malformed = request(callback, 'POST', owner, authorization, 'invalid-json');
    await check(malformed, 401, 'unauthorized');
    assert.equal(malformed.bodyUsed, false, 'Authentication precedes reading an unauthenticated body');
  }
  await check(request(callback, 'POST', owner, 'Bearer fixture-value'),
    staticCallback ? 403 : 401, staticCallback ? 'not-admitted' : 'unauthorized');
  if (staticCallback) {
    await check(request(callback, 'POST', owner, 'Bearer fixture-value', 'invalid-json'), 400, 'invalid-output');
    for (const identity of ['', 'unknown', 'fixture-call']) {
      await check(request(callback, 'POST', owner, 'Bearer fixture-value',
        JSON.stringify({ elevenlabs_extra_body: { aithema_call: identity } })), 403, 'not-admitted');
    }
  }
  for (const path of ['/api/voice/fixture.call/llm/chat/completions', '/api/voice/fixture-call/llm/chat/completions/',
    '/api/voice/llm/chat/completions/', `/api/sessions/${session.id}/voice/fixture-call/unknown`]) {
    await check(request(path, 'POST'), null);
  }
});
