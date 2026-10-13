import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '../src/storage.js';
import { createVoiceHandlers } from '../src/voice-handlers.js';
import { createFacadeSecrets, elevenLabsCallbackPort } from '../../../plugins/elevenlabs/src/callbacks.js';
import { temporaryDb } from '../../../test/helpers.js';

test('AIT-102 fix1: restart revokes every plain-vault orphan through runtime adapters and the fallback', async t => {
  const path = await temporaryDb(), prior = new SQLiteStorage(path);
  const session = prior.create({ demo: true, ownerToken: 'fixture-owner' });
  const refs = ['fixture-orphan-1', 'fixture-orphan-2', 'fixture-orphan-3'];
  const values = new Map(), revoked = [], fallbackRevoked = [];
  const secrets = {
    provision(ref) { values.set(ref, 'fixture-value'); },
    resolve: ref => values.get(ref),
    async revoke(ref) { revoked.push(ref); values.delete(ref); },
  };
  assert.equal(secrets.serverAdapter, undefined, 'The documented host vault has no compatibility injection');
  try {
    for (const [i, facadeSecretRef] of refs.entries()) {
      secrets.provision(facadeSecretRef);
      prior.saveVoiceCall(session.id, { callId: i < 2 ? 'fixture-call' : 'fixture-other-call',
        providerSessionId: `fixture-generation-${i}`, facadeSecretRef, attemptId: `fixture-attempt-${i}`, maxMicro: 0 });
    }
  } finally { prior.close(); }
  const storage = new SQLiteStorage(path);
  const handlers = createVoiceHandlers({ storage, secrets, publish() {},
    runtime: { voiceServerAdapters: () => [elevenLabsCallbackPort], budget: { get: () => null } },
    callbackAdapter: { callbackRoutes: [], async revokeRecord(record) { fallbackRevoked.push(record.facadeSecretRef); } } });
  t.after(async () => { await handlers.close(); storage.close(); });
  await handlers.resume();
  assert.deepEqual(revoked, refs, 'Every persisted generation must revoke its own credential');
  assert.deepEqual(fallbackRevoked, refs, 'Startup must use the fallback as well as registered adapters');
  assert.ok(refs.every(ref => secrets.resolve(ref) === undefined));
  await handlers.resume();
  assert.deepEqual(revoked, [...refs, ...refs], 'Revocation remains idempotent on repeated startup recovery');
  assert.deepEqual(fallbackRevoked, [...refs, ...refs]);
});

for (const [name, config, error] of [
  ['missing vault', {}, /Private facade secret store required/u],
  ['non-function presentation', { secrets: { provision() {}, resolve() {}, revoke() {} }, presentation: {} },
    /Voice presentation must be a function/u],
]) test(`AIT-102 fix1: configured ElevenLabs rejects ${name} during construction`, t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  assert.throws(() => createVoiceHandlers({ storage, ...config,
    runtime: { voiceServerAdapters: () => [elevenLabsCallbackPort] } }), error);
});

test('AIT-102 fix1: generic voice handlers without a callback adapter need no vault', async t => {
  const storage = new SQLiteStorage(), handlers = createVoiceHandlers({ storage, runtime: {} });
  t.after(async () => { await handlers.close(); storage.close(); });
  assert.equal(await handlers.handle(new Request('https://host.example.test/unmatched')), null);
});

test('AIT-102 fix1: callback method matching selects the declared handler and rejects before body reads', async t => {
  const storage = new SQLiteStorage(), handled = [];
  const adapter = { callbackRoutes: ['POST', 'GET'].map(method => ({ method, path: '/provider-callback/:identity',
    async handle() { handled.push(method); return Response.json({ method }); } })) };
  const handlers = createVoiceHandlers({ storage, runtime: { voiceServerAdapters: () => [adapter] } });
  t.after(async () => { await handlers.close(); storage.close(); });
  const url = 'https://host.example.test/provider-callback/fixture-identity';
  assert.deepEqual(await (await handlers.handle(new Request(url, { method: 'GET' }))).json(), { method: 'GET' });
  const wrongMethod = new Request(url, { method: 'DELETE', body: 'invalid-json' });
  const rejected = await handlers.handle(wrongMethod);
  assert.equal(rejected.status, 405); assert.deepEqual(await rejected.json(), { error: 'method-not-allowed' });
  assert.equal(wrongMethod.bodyUsed, false); assert.deepEqual(handled, ['GET']);
  assert.deepEqual(await (await handlers.handle(new Request(url, { method: 'POST', body: '{}' }))).json(), { method: 'POST' });
  assert.deepEqual(handled, ['GET', 'POST']);
});

for (const path of ['/api/sessions', '/api/sessions/:sessionId', '/api/sessions/:sessionId/voice',
  '/api/operator', '/api/operator/:action', '/privacy', '/privacy/:locale', '/confirm-email', '/healthz',
  '/api/library', '/api/library/:entryId/delete', '/api/visitor/email', '/api/visitor/erase',
  '/api/:resource/:identity', '/:root/sessions/:identity']) {
  test(`AIT-102 fix1: callback registration refuses reserved core prefix ${path}`, t => {
    const storage = new SQLiteStorage(); t.after(() => storage.close());
    const adapter = { callbackRoutes: [{ method: 'POST', path, async handle() { assert.fail('A reserved callback route must never mount'); } }] };
    assert.throws(() => createVoiceHandlers({ storage, runtime: { voiceServerAdapters: () => [adapter] } }),
      /Reserved core route prefix/u);
  });
}

test('AIT-102 fix1: fallback callback registration also refuses reserved core routes', t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  assert.throws(() => createVoiceHandlers({ storage, runtime: {}, callbackAdapter: {
    bindCallbacks: () => ({ callbackRoutes: [{ method: 'POST', path: '/api/sessions/:identity/turns',
      async handle() { assert.fail('A bound reserved callback route must never mount'); } }] }),
  } }), /Reserved core route prefix/u);
});

test('AIT-102 fix1: callback start request keeps settingsRevision before overrides', async t => {
  const storage = new SQLiteStorage(), secrets = createFacadeSecrets();
  const session = storage.create({ demo: true, ownerToken: 'fixture-owner' }); let started;
  const handlers = createVoiceHandlers({ storage, secrets, publish() {},
    presentation: () => ({ agent: { language: 'en', firstMessage: 'Fixture notice' } }),
    ownership: { token: () => 'fixture-owner' }, readBody: async request => new Uint8Array(await request.arrayBuffer()),
    runtime: { async admitVoice({ options }) {
      return { binding: { maxDurationSeconds: 60, publicFacadeBaseUrl: 'https://host.example.test' }, options, finish() {},
        plugin: { ports: { serverAdapter: elevenLabsCallbackPort }, async start(request, opts) {
          started = request;
          return { callId: request.callId, providerSessionId: 'fixture-generation', credential: 'fixture-credential',
            signal: new AbortController().signal, spendDeadlineAt: opts.spendDeadlineAt,
            browserLivenessDeadlineAt: opts.browserLivenessDeadlineAt,
            snapshot: () => ({}), close: async () => ({ closureConfirmed: true, outcome: 'cancelled' }) };
        } } };
    } } });
  t.after(async () => { await handlers.close(); storage.close(); });
  const response = await handlers.handle(new Request(`https://host.example.test/api/sessions/${session.id}/voice`, {
    method: 'POST', body: JSON.stringify({ callId: 'fixture-call' }) }));
  assert.equal(response.status, 201);
  assert.deepEqual(Object.keys(started), ['callId', 'sessionId', 'ownerToken', 'facadeSecretRef', 'facadeUrl', 'settingsRevision', 'overrides']);
  assert.deepEqual(started.overrides, { agent: { language: 'en', firstMessage: 'Fixture notice' } });
});
