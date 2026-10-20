import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operationScope } from '../packages/core/src/reasoning.js';
import { createHandlers, createPluginRuntime, SQLiteStorage } from '../packages/server/src/index.js';
import { createCompletionsHandler } from '../plugins/elevenlabs/src/facade.js';
import { temporaryDb } from './helpers.js';

// Both clocks are pinned: no fixture instant is compared with the real calendar.
const wall = Date.parse('2030-06-15T12:00:00Z');
const epochs = [Date.parse('2000-01-01T23:59:59Z'), Date.parse('2040-01-01T23:59:59Z')];
const consent = now => ({ coverage: ({ scope, consentRevision }) => ({
  covered: true, ...scope, scope, consentRevision, checkedAt: now(), expiresAt: now() + 60_000,
}) });

for (const epoch of epochs) test(`AIT-403 operation scope uses injected clock ${epoch}`, t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: wall });
  const now = () => epoch;
  const scope = operationScope({ now, deadlineAt: now() + 100 });
  const expired = operationScope({ now, deadlineAt: now() });
  const fallback = operationScope({ now });
  t.after(() => { scope.dispose(); expired.dispose(); fallback.dispose(); });
  assert.equal(scope.signal.aborted, false);
  assert.equal(expired.signal.aborted, true, 'exact host deadline expires synchronously');
  t.mock.timers.tick(99);
  assert.equal(scope.signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(scope.signal.reason.name, 'TimeoutError');
  assert.equal(fallback.signal.aborted, false);
  t.mock.timers.tick(29_900);
  assert.equal(fallback.signal.reason.name, 'TimeoutError');
});

test('AIT-403 retention create, event, touch, release and retry use host.now across midnight', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: wall });
  let clock = epochs[0];
  const now = () => clock, storage = new SQLiteStorage();
  const handlers = createHandlers({ storage, consent: consent(now), host: { now } });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create();
  const activity = () => storage.db.prepare('SELECT last_activity FROM session_retention WHERE session_id=?').get(session.id).last_activity;
  assert.equal(activity(), clock);
  clock += 2000;
  storage.append(session.id, 'turn.final', { id: 'host-turn', role: 'user', content: 'hello', at: new Date(clock).toISOString() });
  assert.equal(activity(), clock, 'event trigger crosses UTC midnight on the host clock');
  clock += 100;
  storage.touch(session.id);
  assert.equal(activity(), clock);
  const release = storage.hold(session.id);
  clock += 100;
  release();
  assert.equal(activity(), clock);
  const lastActivity = clock;
  clock += 100;
  storage.systemWork(() => {
    storage.touch(session.id);
    storage.append(session.id, 'session.paused', { paused: true });
    storage.hold(session.id)();
  });
  assert.equal(activity(), lastActivity, 'system activity never renews retention');
  clock = lastActivity - 1;
  storage.touch(session.id);
  assert.equal(activity(), lastActivity, 'a backwards clock cannot shorten retention');
  assert.deepEqual(storage.retirementCandidates(lastActivity, 1), []);
  assert.deepEqual(storage.retirementCandidates(lastActivity + 1, 1), [session.id]);
  storage.erase(session.id);
  storage.failRetirement(session.id);
  assert.deepEqual(storage.pendingRetirements(1), []);
  clock += 1000;
  assert.deepEqual(storage.pendingRetirements(1), [session.id]);
});

test('AIT-403 restart replaces the legacy SQLite retention trigger', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: wall });
  const path = await temporaryDb(), now = () => epochs[0];
  let storage = new SQLiteStorage(path, { now });
  storage.db.exec(`DROP TRIGGER retention_create;
    CREATE TRIGGER retention_create AFTER INSERT ON sessions BEGIN
      INSERT INTO session_retention(session_id,last_activity) VALUES (NEW.id,0); END;`);
  storage.close();
  storage = new SQLiteStorage(path, { now });
  t.after(() => storage.close());
  const session = storage.create();
  assert.equal(storage.db.prepare('SELECT last_activity FROM session_retention WHERE session_id=?').get(session.id).last_activity, now());
});

for (const epoch of epochs) test(`AIT-403 runtime admission and publication use host clock ${epoch}`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: wall });
  const now = () => epoch, storage = new SQLiteStorage();
  const port = consent(now), runtime = createPluginRuntime({ storage, consent: port, now });
  const handlers = createHandlers({ storage, pluginRuntime: runtime, consent: port, host: { now } });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ demo: true });
  assert.equal(await runtime.checkReply(session, { deadlineAt: now() + 100 }), null);
  assert.equal(await runtime.processingAllowed(session, null, { deadlineAt: now() + 100 }), true);
  assert.equal(await runtime.processingAllowed(session, null, { deadlineAt: now() }), false);
  const admission = await runtime.admit({ session, lane: 'reaction', operation: 'stream',
    request: { system: '', messages: [] }, options: { deadlineAt: now() + 100 } });
  assert.equal(admission.options.now(), now());
  let text = '';
  for await (const chunk of admission.plugin.stream({ system: '', messages: [] }, admission.options)) text += chunk;
  assert.match(text, /what should improve first/iu);
  await admission.finish();
});

test('AIT-403 handlers install the host clock on an existing runtime', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: wall });
  const now = () => epochs[1], storage = new SQLiteStorage(), port = consent(now);
  const runtime = createPluginRuntime({ storage, consent: port });
  const handlers = createHandlers({ storage, pluginRuntime: runtime, consent: port, host: { now } });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ demo: true });
  assert.equal(await runtime.processingAllowed(session, null, { deadlineAt: now() }), false);
});

for (const epoch of epochs) for (const stream of [false, true]) test(`AIT-403 facade ${stream ? 'stream' : 'JSON'} uses host clock ${epoch}`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: wall });
  const now = () => epoch, observed = [];
  const call = { callId: 'clock-call', providerSessionId: 'clock-provider', facadeSecretRef: 'fixture',
    spendDeadlineAt: now() + 10_000, browserLivenessDeadlineAt: now() + 5000 };
  const handler = createCompletionsHandler({ now, timeoutMs: 2000, log() {},
    getCall: async () => call, resolveSecret: () => 'fixture-clock-secret',
    buildRequest: async ({ messages }, options) => { observed.push(options); return { system: '', messages }; },
    admitReasoning: async ({ request, options }) => {
      observed.push(options);
      const attempt = { attemptId: 'clock-attempt' };
      return { request, options: { ...options, attempt, report() {} }, finish() {},
        plugin: { async *stream(_, opts) { yield 'Hello'; opts.report({ attemptId: attempt.attemptId, outcome: 'completed', usage: { inputTokens: 0, outputTokens: 0 } }); } } };
    } });
  const response = await handler(new Request('https://fixture.invalid/completions', {
    method: 'POST', headers: { authorization: 'Bearer fixture-clock-secret' },
    body: JSON.stringify({ stream, elevenlabs_extra_body: { aithema_call: call.callId }, messages: [{ role: 'user', content: 'hello' }] }),
  }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(await response.text(), /Hello/);
  assert.equal(observed.length, 2);
  for (const options of observed) {
    assert.equal(options.deadlineAt, now() + 2000, 'callback budget and call deadlines share one epoch');
    assert.equal(options.now(), now());
  }
});
