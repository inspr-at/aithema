import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SQLiteStorage } from '../../../packages/server/src/storage.js';
import { createVoiceTurnOperations } from '../../../packages/server/src/voice-turns.js';
import { beginInvocation, PluginError } from '../../../packages/core/src/invocation.js';
import { voiceOperation } from '../../../packages/core/src/live-voice.js';
import { normalizeVoiceWire, VOICE_WIRE_EPOCH } from '../../../test/voice-wire-fixtures.js';
import { createFacadeSecrets } from '../src/server.js';
import { fixture } from './fixtures.js';

test('AIT-102: all twelve baseline callbacks preserve their bytes through the server adapter routes', { timeout: 15_000 }, async t => {
  t.mock.method(Date, 'now', () => VOICE_WIRE_EPOCH);
  const bytes = await readFile(new URL('../../../test/fixtures/elevenlabs-wire.json', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '6c5dd15cf80f6824b7ca64a99440485a839ae60b609169639dba25ae8dd32955');
  const baseline = JSON.parse(bytes), observed = [];
  const storage = new SQLiteStorage(), session = storage.create({ demo: true, ownerToken: 'fixture-owner' });
  const turns = createVoiceTurnOperations({ storage, now: () => VOICE_WIRE_EPOCH });
  t.after(async () => { await turns.idle(); storage.close(); });
  const call = { callId: 'call_fixture', providerSessionId: 'conv_fixture', facadeSecretRef: 'fixture-callback-ref',
    facadeCallId: 'facade_fixture', spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 60_000 };
  const secrets = createFacadeSecrets(); secrets.resolve = () => 'fixture-callback-value';
  let admissions = 0, partialRelease;
  const operations = { secrets, now: () => VOICE_WIRE_EPOCH, log() {},
    getCall(identity, { callbackIdentity }) {
      assert.equal(identity, callbackIdentity ? call.facadeCallId : call.callId);
      return call;
    },
    buildRequest: ({ messages }) => ({ system: 'Canonical fixture prompt', locale: 'de', messages }),
    turnOperations: { run: (context, execute, options) => turns.run({ ...context, sessionId: session.id }, execute, options) },
    admitReasoning({ request, options, beforeAdmission }) {
      beforeAdmission?.();
      const attemptId = `fixture-attempt-${++admissions}`;
      return { request, producer: { plugin: 'fixture', model: 'fixture-model' },
        options: { ...options, attempt: { attemptId, claimId: `fixture-claim-${admissions}`, consume() {} }, report() {} },
        plugin: { async *stream(input, opts) {
          const invocation = await beginInvocation(opts); let completed = false;
          try {
            invocation.dispatch();
            if (input.messages.at(-1).content === 'opener guard') yield 'Danke für die Info. ';
            yield 'Die erste Frage: ';
            if (input.messages.at(-1).content === 'partial failure') { await partialRelease.promise; throw new PluginError('provider'); }
            yield 'Was soll entstehen?'; invocation.usage({ inputTokens: 7, outputTokens: 5 }); completed = true;
          } finally { await invocation.finish(completed); }
        } }, finish() {} };
    } };
  const port = fixture().server.ports.serverAdapter;
  const perCall = port.bindCallbacks(operations), staticCallback = port.bindCallbacks({ ...operations, staticSecretRef: 'fixture-static-ref' });
  for (const record of baseline.callbacks) {
    partialRelease = record.name === 'partial-failure' ? Promise.withResolvers() : undefined;
    const callbacks = record.name.startsWith('static-') ? staticCallback : perCall;
    const path = new URL(record.request.url).pathname;
    const route = callbacks.callbackRoutes.find(route => route.path.replace(':callId', call.callId) === path);
    assert.ok(route, record.name); assert.equal(route.method, record.request.method);
    const response = await route.handle(new Request(record.request.url, record.request));
    const reader = response.body.getReader(), decoder = new TextDecoder(); let body = '';
    try {
      for (;;) {
        const item = await voiceOperation({ deadlineAt: Date.now() + 5000 }, () => reader.read());
        if (item.done) { body += decoder.decode(); break; }
        body += decoder.decode(item.value, { stream: true });
        if (body.includes('"delta":{"content":')) partialRelease?.resolve();
      }
    } finally { partialRelease?.resolve(); void reader.cancel().catch(() => {}); reader.releaseLock(); }
    const actual = { status: response.status, headers: Object.fromEntries(response.headers), body: normalizeVoiceWire(body) };
    assert.deepEqual(actual, record.response, record.name);
    observed.push({ ...record, response: actual });
  }
  assert.equal(admissions, baseline.admissions, 'Rule C duplicate callbacks still share admissions');
  assert.equal(`${JSON.stringify({ ...baseline, callbacks: observed, admissions }, null, 2)}\n`, bytes);
});

for (const staticCallback of [false, true]) test(`AIT-102: adapter owns callback credentials, URLs and SDK presentation (${staticCallback ? 'static' : 'per-call'})`, async () => {
  const secrets = createFacadeSecrets(), provisioned = [], revoked = [];
  const provision = secrets.provision, revoke = secrets.revoke;
  secrets.provision = ref => { provisioned.push(ref); provision(ref); };
  secrets.revoke = ref => { revoked.push(ref); revoke(ref); };
  const port = fixture().server.ports.serverAdapter;
  const callbacks = port.bindCallbacks({ secrets, ...(staticCallback ? { staticSecretRef: 'fixture-static-ref' } : {}),
    presentation: locale => ({ agent: { language: locale, firstMessage: 'Fixture AI notice' } }),
    getCall: () => null, buildRequest() {}, admitReasoning() { assert.fail('Preparing callbacks never admits reasoning'); } });
  const request = { callId: 'fixture-call', binding: { publicFacadeBaseUrl: 'https://host.example.test' }, locale: 'de' };
  const opening = callbacks.prepareCallback(request); await opening.prepare();
  assert.equal(opening.request.facadeUrl, staticCallback ? 'https://host.example.test/api/voice/llm' : 'https://host.example.test/api/voice/fixture-call/llm');
  assert.deepEqual(opening.request.overrides, { agent: { language: 'de', firstMessage: 'Fixture AI notice' } });
  assert.equal(provisioned.length, staticCallback ? 0 : 1);
  assert.deepEqual(opening.receipt, staticCallback ? { facadeCallId: opening.identity } : {});
  const continuation = callbacks.prepareCallback({ ...request, continuation: true }); await continuation.prepare();
  assert.deepEqual(continuation.request.overrides, { agent: { language: 'de', firstMessage: '' } });
  if (staticCallback) assert.notEqual(opening.identity, continuation.identity);
  else assert.notEqual(opening.details.facadeSecretRef, continuation.details.facadeSecretRef);
  opening.revoke(); continuation.revoke(); callbacks.revokeRecord({ facadeSecretRef: 'fixture-orphan' });
  assert.equal(revoked.length, staticCallback ? 0 : 3);
  if (!staticCallback) assert.equal(secrets.resolve(opening.details.facadeSecretRef), undefined);
});

for (const staticCallback of [false, true]) test(`AIT-102: adapter authentication fences generic operations (${staticCallback ? 'static' : 'per-call'})`, async () => {
  const secrets = createFacadeSecrets(); secrets.resolve = () => 'fixture-value';
  const call = { callId: 'fixture-call', providerSessionId: 'fixture-generation', facadeSecretRef: 'fixture-ref',
    facadeCallId: 'fixture-callback', paused: true, spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 60_000 };
  const forbidden = () => assert.fail('Authentication and call eligibility must precede generic operations');
  const callbacks = fixture().server.ports.serverAdapter.bindCallbacks({ secrets,
    ...(staticCallback ? { staticSecretRef: 'fixture-static-ref' } : {}),
    getCall: () => call, buildRequest: forbidden, admitReasoning: forbidden, onCompletion: forbidden,
    turnOperations: { run: forbidden } });
  const route = callbacks.callbackRoutes.find(route => staticCallback ? !route.path.includes(':callId') : route.path.includes(':callId'));
  const url = 'https://host.example.test' + route.path.replace(':callId', call.callId);
  for (const authorization of [undefined, 'Bearer wrong']) {
    const request = new Request(url, { method: 'POST', headers: authorization ? { authorization } : {}, body: 'invalid-json' });
    assert.equal((await route.handle(request)).status, 401); assert.equal(request.bodyUsed, false);
  }
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    assert.equal((await route.handle(new Request(url, { method }))).status, 405);
  }
  const response = await route.handle(new Request(url, { method: 'POST', headers: { authorization: 'Bearer fixture-value' },
    body: JSON.stringify({ elevenlabs_extra_body: { aithema_call: staticCallback ? call.facadeCallId : call.callId },
      messages: [{ role: 'user', content: 'Fixture input' }] }) }));
  assert.equal(response.status, 403, 'An authenticated paused call cannot enter generic operations');
});
