import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SQLiteStorage } from '../../../packages/server/src/storage.js';
import { SQLiteBudgetLedger, createVoiceHandlers } from '../../../packages/server/src/index.js';
import { createVoiceHost } from '../../../demo/start2-voice-host.js';
import { stubAgentApi } from '../../../test/fixtures/voice-self-heal-host.js';
import { createFacadeSecrets, elevenLabsCallbackPort } from '../src/callbacks.js';

const WINDOW = 30 * 60_000, DETECTION = 5 * 60_000;
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const storage = new SQLiteStorage(), api = stubAgentApi(), secrets = createFacadeSecrets(), logs = [];
  const bearer = 'fixture-current-callback-value', foreign = 'fixture-out-of-band-value';
  let upstreamValue, patchFailure = false, gate, ensureAttempts = 0;
  const patches = [];
  secrets.resolve = () => bearer;
  const host = await createVoiceHost({ storage, facadeSecrets: secrets, templateAgentId: 'template-agent',
    publicOrigin: 'https://fixture.test', apiBaseUrl: api.endpoint, values: {}, random: () => 0.5,
    resolveSecret: () => bearer, log: entry => logs.push(entry), fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/v1/convai/agents') ensureAttempts++;
      if (path.includes('/secrets') && ['POST', 'PATCH'].includes(init.method)) {
        const body = JSON.parse(init.body);
        if (init.method === 'PATCH') {
          patches.push({ at: Date.now(), currentValue: body.value === bearer });
          if (gate) await gate.promise;
          if (patchFailure) return new Response(null, { status: patchFailure === true ? 503 : patchFailure });
        }
        upstreamValue = body.value;
      }
      return api.fetchImpl(url, init);
    } });
  t.after(async () => { await host.close(); storage.close(); });
  const callbacks = elevenLabsCallbackPort.bindCallbacks({ secrets, staticSecretRef: host.staticSecretRef,
    log: line => logs.push(line), getCall: () => ({ callId: 'fixture-call', facadeCallId: 'fixture-identity',
      providerSessionId: 'fixture-provider', facadeSecretRef: host.staticSecretRef,
      spendDeadlineAt: Date.now() + WINDOW * 10, browserLivenessDeadlineAt: Date.now() + WINDOW * 10 }),
    buildRequest: () => ({}), admitReasoning: () => ({ options: { attempt: {}, report() {} }, finish() {},
      plugin: { async *stream(input, options) { yield 'Fixture reply'; options.report({}); } } }) });
  const route = callbacks.callbackRoutes.find(route => !route.path.includes(':callId'));
  const request = async (value = upstreamValue, badBody = true) => {
    const req = new Request('https://fixture.test' + route.path, { method: 'POST',
      headers: { authorization: `Bearer ${value}` }, body: badBody ? 'invalid-json' : JSON.stringify({
        elevenlabs_extra_body: { aithema_call: 'fixture-identity' }, messages: [{ role: 'user', content: 'hello' }] }) });
    const response = await route.handle(req);
    if (response.status === 401) { assert.equal(req.bodyUsed, false); assert.deepEqual(await response.json(), { error: 'unauthorized' }); }
    return response;
  };
  const receipt = () => storage.db.prepare('SELECT * FROM host_voice_secret_hashes').all();
  const repairs = () => logs.filter(entry => entry.event === 'voice-secret-repair');
  const assertPrivate = () => {
    const rows = storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .flatMap(({ name }) => storage.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all());
    for (const value of [bearer, foreign]) {
      assert.ok(!JSON.stringify(logs).includes(value), 'logs contain no bearer values');
      assert.ok(!JSON.stringify(rows).includes(value), 'stored rows contain no bearer values');
    }
    const serializedLogs = JSON.stringify(logs);
    assert.ok(!serializedLogs.includes(createHash('sha256').update(bearer).digest('hex')), 'logs contain no secret hash');
    assert.ok(!/authorization|xi-api-key/iu.test(serializedLogs), 'logs contain no credential headers');
    assert.deepEqual(repairs().map(entry => Object.keys(entry).sort()), repairs().map(() => ['event', 'name']));
  };
  return { host, storage, api, patches, receipt, repairs, assertPrivate, request,
    get ensureAttempts() { return ensureAttempts; },
    availability: () => logs.filter(entry => entry.event === 'voice-availability'),
    drift() { upstreamValue = foreign; }, failPatch(value) { patchFailure = value; },
    holdPatch() { gate = Promise.withResolvers(); return gate; } };
}

test('AIT-226 same-id value drift repairs in process once, restores calls and retains only SHA-256', async t => {
  const f = await fixture(t), original = f.receipt(), binding = f.host.binding;
  f.host.onAvailable(() => assert.fail('secret repair must retain the prepared runtime'));
  f.drift();
  for (let i = 0; i < 2; i++) {
    assert.equal((await f.request()).status, 401); await flush();
    assert.equal(f.patches.length, 0); assert.deepEqual(f.receipt(), original);
  }
  const gate = f.holdPatch();
  assert.equal((await f.request()).status, 401); await flush();
  assert.deepEqual(f.receipt(), [], 'receipt cleared before repair completes');
  assert.equal(f.patches.length, 1); assert.ok(f.patches[0].currentValue);
  gate.resolve(); await flush();
  assert.equal((await f.request(undefined, false)).status, 200);
  assert.deepEqual(f.receipt(), original); assert.equal(f.host.binding, binding);
  assert.ok(f.receipt()[0].value_hash === createHash('sha256').update('fixture-current-callback-value').digest('hex'));
  assert.deepEqual(f.repairs(), [{ event: 'voice-secret-repair', name: 'aithema-start2-facade' }]);
  f.assertPrivate();
});

test('AIT-226 stray and expired rejections leave the receipt intact', async t => {
  const f = await fixture(t), original = f.receipt(); f.drift();
  assert.equal((await f.request()).status, 401);
  t.mock.timers.tick(DETECTION + 1);
  for (let i = 0; i < 2; i++) assert.equal((await f.request()).status, 401);
  await flush(); assert.equal(f.patches.length, 0); assert.deepEqual(f.receipt(), original);
  assert.deepEqual(f.repairs(), []); f.assertPrivate();
});

test('AIT-226 flood permits one idempotent PATCH per window, with fresh threshold after cooldown', async t => {
  const f = await fixture(t), original = f.receipt();
  const bad = () => f.request('fixture-out-of-band-value');
  for (let window = 0; window < 2; window++) {
    await Promise.all(Array.from({ length: 100 }, bad)); await flush();
    assert.equal(f.patches.length, window + 1); assert.ok(f.patches.every(patch => patch.currentValue));
    assert.deepEqual(f.receipt(), original);
    t.mock.timers.tick(WINDOW - 1);
    await Promise.all(Array.from({ length: 20 }, bad)); await flush();
    assert.equal(f.patches.length, window + 1);
    t.mock.timers.tick(1);
    for (let i = 0; i < 2; i++) await bad();
    await flush(); assert.equal(f.patches.length, window + 1);
  }
  assert.equal(f.repairs().length, 2); f.assertPrivate();
});

test('AIT-226 failed PATCH uses existing recovery without retrying writes inside the cooldown', async t => {
  const f = await fixture(t), binding = f.host.binding; f.drift(); f.failPatch(true);
  f.host.onAvailable(() => assert.fail('repair retry must restore the prepared runtime'));
  for (let i = 0; i < 3; i++) await f.request();
  await flush(); assert.equal(f.patches.length, 1); assert.deepEqual(f.receipt(), []);
  assert.equal(f.host.transient, true);
  for (let i = 0; i < 100; i++) await f.request();
  t.mock.timers.tick(WINDOW - 1); await flush(); assert.equal(f.patches.length, 1);
  f.failPatch(false); t.mock.timers.tick(1); await flush();
  assert.equal(f.patches.length, 2); assert.equal(f.host.binding, binding);
  assert.equal((await f.request(undefined, false)).status, 200);
  assert.equal(f.repairs().length, 1); f.assertPrivate();
});

test('AIT-226 shutdown disconnects detection and cancels a repair retry', async t => {
  const f = await fixture(t); f.drift(); f.failPatch(true);
  for (let i = 0; i < 3; i++) await f.request();
  await flush(); assert.equal(f.patches.length, 1);
  await f.host.close();
  t.mock.timers.tick(WINDOW * 2);
  for (let i = 0; i < 10; i++) await f.request();
  await flush(); assert.equal(f.patches.length, 1); assert.equal(f.repairs().length, 1);
});

test('AIT-279 a repair PATCH rejected once recovers after cooldown without restart', async t => {
  const f = await fixture(t), binding = f.host.binding;
  f.host.onAvailable(() => assert.fail('repair must reuse the prepared runtime'));
  f.drift(); f.failPatch(403);
  for (let i = 0; i < 3; i++) await f.request();
  await flush();
  assert.equal(f.host.binding, undefined);
  assert.equal(f.host.disabledReason, 'agent-api-patch-403');
  assert.equal(f.patches.length, 1);
  assert.equal(f.ensureAttempts, 2);
  f.failPatch(false);
  t.mock.timers.tick(WINDOW - 1); await flush();
  assert.equal(f.patches.length, 1);
  assert.equal(f.ensureAttempts, 2);
  t.mock.timers.tick(1); await flush();
  assert.equal(f.patches.length, 2);
  assert.equal(f.ensureAttempts, 3);
  assert.equal(f.host.binding, binding);
  assert.equal(f.host.transient, false);
  assert.equal(f.host.disabledReason, null);
  assert.equal(f.availability().at(-1).to, 'available');
  assert.equal((await f.request(undefined, false)).status, 200);
  t.mock.timers.tick(WINDOW * 2); await flush();
  assert.equal(f.ensureAttempts, 3, 'successful repair cancels further retries');
  f.assertPrivate();
});

for (const status of [422, 503]) test(`AIT-279 persistent repair PATCH ${status} stays bounded and recovers when API does`, async t => {
  const f = await fixture(t), binding = f.host.binding;
  f.host.onAvailable(() => assert.fail('repair must reuse the prepared runtime'));
  f.drift(); f.failPatch(status);
  for (let i = 0; i < 3; i++) await f.request();
  await flush();
  for (let window = 0; window < 3; window++) {
    assert.equal(f.patches.length, window + 1);
    assert.equal(f.ensureAttempts, window + 2);
    assert.equal(f.host.binding, undefined);
    assert.equal(f.receipt().length, 0);
    for (let i = 0; i < 100; i++) await f.request();
    t.mock.timers.tick(WINDOW - 1); await flush();
    assert.equal(f.patches.length, window + 1);
    assert.equal(f.ensureAttempts, window + 2, 'no ensure loop during cooldown');
    if (window === 2) f.failPatch(false);
    t.mock.timers.tick(1); await flush();
  }
  assert.equal(f.patches.length, 4);
  assert.equal(f.ensureAttempts, 5);
  assert.ok(f.patches.slice(1).every((patch, i) => patch.at - f.patches[i].at >= WINDOW));
  assert.equal(f.host.binding, binding);
  assert.equal(f.host.disabledReason, null);
  assert.equal(f.host.transient, false);
  assert.equal(f.availability().at(-1).to, 'available');
  assert.equal((await f.request(undefined, false)).status, 200);
  assert.equal(f.repairs().length, 1, 'rejections cannot start another repair loop');
  t.mock.timers.tick(WINDOW * 2); await flush();
  assert.equal(f.ensureAttempts, 5);
  f.assertPrivate();
});

test('AIT-279 orphan sweep retains a call while repair is off and reconciles it after recovery', async t => {
  const f = await fixture(t), ledger = new SQLiteBudgetLedger(f.storage);
  const session = f.storage.create({ ownerToken: 'fixture-owner' });
  const { attemptId } = ledger.admit({ sessionId: session.id, lane: 'voice', maxMicro: 50_000,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const claim = ledger.claim(attemptId); claim.consume();
  const terminal = { providerSessionId: 'fixture-conversation', outcome: 'uncertain', closureConfirmed: false,
    chargedMicro: 50_000, usage: null };
  ledger.settleVoice(claim.claimId, terminal);
  f.storage.saveVoiceCall(session.id, { callId: 'orphan-call', providerSessionId: terminal.providerSessionId,
    startedAt: Date.now(), attemptId, claimId: claim.claimId, maxMicro: 50_000,
    facadeSecretRef: f.host.staticSecretRef, terminal, reconciliationPending: true });
  let lookups = 0;
  const handlers = createVoiceHandlers({ storage: f.storage,
    runtime: { budget: ledger, reconcileVoice: (id, result) => ledger.reconcileVoice(id, result) },
    secrets: createFacadeSecrets(), staticSecretRef: f.host.staticSecretRef, publish() {}, reconcileIntervalMs: 60_000,
    closeOrphan(record, options) { lookups++; return f.host.closeOrphan(record, options); } });
  t.after(() => handlers.close());
  f.drift(); f.failPatch(403);
  for (let i = 0; i < 3; i++) await f.request();
  await flush(); assert.equal(f.host.binding, undefined);
  await assert.doesNotReject(handlers.resume(), 'the orphan sweep catches AgentEnsureError');
  assert.equal(lookups, 1);
  assert.equal(f.storage.voiceCalls()[0].reconciliationPending, true);
  assert.equal(ledger.breakdown(session.id).uncertainSpendMicro, 50_000);
  t.mock.timers.tick(60_000); await flush(); await handlers.idle();
  assert.equal(lookups, 2, 'the pending orphan is retried while voice is off');
  assert.equal(f.storage.voiceCalls()[0].reconciliationPending, true);
  f.failPatch(false);
  t.mock.timers.tick(WINDOW - 60_000); await flush(); await handlers.idle();
  t.mock.timers.tick(60_000); await flush(); await handlers.idle();
  assert.equal(f.patches.length, 2);
  assert.equal(f.host.disabledReason, null);
  assert.equal(f.storage.voiceCalls().length, 1, 'the orphan record survives');
  assert.equal(f.storage.voiceCalls()[0].reconciliationPending, false);
  assert.equal(f.storage.voiceCalls()[0].reconciliation.closureConfirmed, true);
  assert.equal(ledger.breakdown(session.id).uncertainSpendMicro, 0);
  assert.equal(ledger.breakdown(session.id).confirmedSpendMicro, 1000);
  f.assertPrivate();
});
