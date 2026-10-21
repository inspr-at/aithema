import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operationScope } from '../packages/core/src/reasoning.js';
import { PluginRegistry, createMockReasoning, publicReasoningManifest, bindingReason } from '@inspr/aithema-core';
import { createHandlers, createPluginRuntime, SQLiteStorage, mockPresets, createVoiceCap } from '../packages/server/src/index.js';
import { createCompletionsHandler } from '../plugins/elevenlabs/src/facade.js';
import { temporaryDb, ownedRequest, testToken } from './helpers.js';
import { bindSQLiteClock } from './fixtures/sqlite-clock.js';

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
  // Pin SQLite's former wall clock too, deliberately apart from host.now.
  const now = () => clock, storage = bindSQLiteClock(new SQLiteStorage(), () => wall);
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
  let storage = bindSQLiteClock(new SQLiteStorage(path, { now }), () => wall);
  storage.db.exec(`DROP TRIGGER retention_create;
    CREATE TRIGGER retention_create AFTER INSERT ON sessions BEGIN
      INSERT INTO session_retention(session_id,last_activity) VALUES (NEW.id,0); END;`);
  storage.close();
  storage = bindSQLiteClock(new SQLiteStorage(path, { now }), () => wall);
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

for (const epoch of epochs) test(`AIT-403 HTTP text turn keeps the host deadline epoch ${epoch}`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: wall });
  const now = () => epoch, storage = new SQLiteStorage();
  const handlers = createHandlers({ storage, consent: consent(now), host: { now }, log() {} });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ demo: true, ownerToken: testToken });
  const response = await handlers.handle(ownedRequest(`http://fixture.invalid/api/sessions/${session.id}/turns`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientEventId: 'clock-http-turn', content: 'systems: API' }),
  }));
  assert.equal(response.status, 200);
  await handlers.idle();
  assert.equal(storage.get(session.id).transcript.some(turn => turn.role === 'assistant'), true);
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

// A noncanonical, priced offline adapter exercises binding evidence, budget and
// aggregate duration admission. It cannot gain the canonical mock exemption.
function voiceClockFixture(t, { evidenceMs = 300_000, explicitRuntimeClock = false, voiceClock = false,
  initialClock = wall - 120_000, capLimits = { capMilliseconds: 300_000 } } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: wall });
  let clock = initialClock;
  const now = () => clock, storage = new SQLiteStorage(), starts = [];
  const binding = { plugin: 'clock-voice', model: 'fixture', effort: 'none', endpoint: 'https://voice.example.test',
    accountRef: 'fixture', secretRef: 'fixture', maxMicro: 600, maxTokens: 1,
    rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds: 60, minRunwaySeconds: 1,
    upstreamMicroPerMinute: 600, visitorMicroPerMinute: 300 };
  binding.legal = { approved: true, countries: ['AT'], training: false, retention: 'fixture',
    purpose: 'conversation', recipient: 'fixture', processors: [], dataCategories: ['conversation'], consentVersion: 1,
    evidence: { qualified: true, accountRef: binding.accountRef, secretRef: binding.secretRef, model: binding.model,
      endpoint: binding.endpoint, routing: {}, verifiedAt: now() - 1000, expiresAt: now() + evidenceMs } };
  const base = publicReasoningManifest(binding.plugin, 'Clock voice fixture', binding.endpoint);
  const plugin = { binding,
    manifest: { ...base, kinds: ['live-voice'], entrypoints: { server: './server.js', browser: './browser.js' },
      models: [{ ...base.models[0], operations: ['start'], structured: false, cost: { ...base.models[0].cost, unit: 'minute' } }],
      liveVoice: { reasoning: 'native', transcript: { finality: 'turns', persistence: 'durable' },
        capabilities: Object.fromEntries(['sendText', 'updateContext', 'setInput', 'setOutput', 'pause', 'resume', 'interrupt', 'heard'].map(k => [k, 'unavailable'])),
        billing: { visitor: 'duration', upstream: 'duration' } } },
    health: async () => ({ available: true }),
    async start(request, options) {
      await options.attempt.consume();
      starts.push(options);
      const record = { callId: request.callId, providerSessionId: `clock-provider-${starts.length}`,
        attemptId: options.attempt.attemptId, claimId: options.attempt.claimId, startedAt: now(),
        spendDeadlineAt: options.spendDeadlineAt, browserLivenessDeadlineAt: options.browserLivenessDeadlineAt };
      storage.saveVoiceCall(request.sessionId, record);
      return { ...record, signal: new AbortController().signal, snapshot: () => record,
        async close(reason) {
          const terminal = { outcome: 'completed', closureConfirmed: true, chargedMicro: 0,
            usage: { providerSeconds: 0, providerMinutes: 0, pausedSeconds: 0, visitorSeconds: 0, upstreamMicro: 0, visitorMicro: 0 } };
          options.report({ ...terminal, attemptId: record.attemptId });
          storage.saveVoiceCall(request.sessionId, { ...record, endedAt: now(), reason, terminal });
          return terminal;
        } };
    } };
  const presets = mockPresets();
  presets.best.plugins.push(binding.plugin); presets.best.bindings.voice = binding;
  presets.best.policy = { endpoints: [binding.endpoint] };
  // Match demo/server.js: construct the cap without a clock; only handlers
  // install host.now on the runtime (or preserve its explicitly configured now).
  const port = consent(now), cap = createVoiceCap({ storage, ...capLimits });
  const runtime = createPluginRuntime({ storage, consent: port, presets, voiceCap: cap,
    registry: new PluginRegistry().register(createMockReasoning()).register(plugin), ...(explicitRuntimeClock ? { now } : {}) });
  const handlers = createHandlers({ storage, pluginRuntime: runtime, consent: port, host: voiceClock ? undefined : { now: explicitRuntimeClock ? () => wall : now },
    voice: voiceClock ? { now } : {}, log() {} });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ ownerToken: testToken, demo: true });
  const route = (suffix, body) => handlers.handle(ownedRequest(`https://fixture.invalid/api/sessions/${session.id}/voice${suffix}`, {
    method: 'POST', body: JSON.stringify(body),
  }));
  return { now, advance: ms => { clock += ms; }, storage, session, binding, plugin, presets, runtime, starts, cap, route };
}

for (const explicitRuntimeClock of [false, true]) {
  test(`AIT-403 demo-wired voice day cap refuses an exhausted lagging host day (explicit runtime: ${explicitRuntimeClock})`, async t => {
    const h = voiceClockFixture(t, { explicitRuntimeClock, initialClock: wall - 43_230_000,
      capLimits: { capMilliseconds: 300_000, perDayMilliseconds: 60_000 } });
    const hostDay = new Date(h.now()).toISOString().slice(0, 10);
    // Durable usage from the host's current UTC day, before wall-clock midnight.
    h.storage.db.prepare('INSERT INTO voice_cap_reservations VALUES (?,?,?,?,?,?)')
      .run('previous-attempt', h.session.id, 'previous-call', hostDay, 60_000, 60_000);
    const attempts = () => h.storage.db.prepare('SELECT COUNT(*) n FROM budget_attempts').get().n;
    const before = attempts();
    const refused = await h.route('', { callId: 'day-cap-refused' });
    assert.equal(refused.status, 403, 'a new wall-clock day must not reopen the exhausted host day');
    assert.deepEqual(await refused.json(), { error: 'not-admitted', reason: 'Voice minute cap reached for this UTC day' });
    await assert.rejects(h.runtime.checkVoice(h.storage.get(h.session.id)),
      { code: 'not-admitted', message: 'Voice minute cap reached for this UTC day' });
    assert.equal(attempts(), before, 'day-cap refusal precedes every spend reservation');
    assert.equal(h.starts.length, 0);
    assert.equal(h.cap.snapshot().day, hostDay);
    assert.equal(h.cap.snapshot().perDay.spentMilliseconds, 60_000);
    assert.equal(h.cap.snapshot().reservedMilliseconds, 0);
    h.advance(30_000);
    const admitted = await h.route('', { callId: 'next-host-day' });
    assert.equal(admitted.status, 201, await admitted.clone().text());
    assert.equal(h.cap.snapshot().perDay.spentMilliseconds, 0);
    assert.equal(h.cap.snapshot().perDay.reservedMilliseconds, 60_000);
    assert.equal(h.cap.snapshot().spentMilliseconds, 60_000, 'rollover retains lifetime spend');
    assert.equal(h.starts.length, 1);
  });

  test(`AIT-403 demo-wired voice cap reserves on the runtime day and follows clock installation (explicit runtime: ${explicitRuntimeClock})`, async t => {
    const h = voiceClockFixture(t, { explicitRuntimeClock, initialClock: wall - 43_230_000,
      capLimits: { capMilliseconds: 300_000, perDayMilliseconds: 60_000 } });
    const response = await h.route('', { callId: 'day-cap-reserved' });
    assert.equal(response.status, 201, await response.clone().text());
    const row = h.storage.db.prepare('SELECT day,reserved_ms,actual_ms FROM voice_cap_reservations WHERE attempt_id=?')
      .get(h.starts[0].attempt.attemptId);
    assert.deepEqual({ ...row }, { day: new Date(h.runtime.now()).toISOString().slice(0, 10), reserved_ms: 60_000, actual_ms: null });
    assert.equal(h.cap.reason(1), 'Voice minute cap reached for this UTC day');
    h.runtime.setHostClock(() => h.now() + 86_400_000);
    assert.equal(h.cap.snapshot().day, new Date(h.runtime.now()).toISOString().slice(0, 10));
    assert.equal(h.cap.snapshot().perDay.reservedMilliseconds, explicitRuntimeClock ? 60_000 : 0);
    assert.equal(h.cap.snapshot().reservedMilliseconds, 60_000, 'clock installation cannot release an unreconciled hold');
    assert.equal(h.cap.reason(1), explicitRuntimeClock ? 'Voice minute cap reached for this UTC day' : null);
  });
}

for (const explicitRuntimeClock of [false, true]) test(`AIT-447 / AIT-403 voice continuation funds host-clock remainder and reserves full liability (explicit runtime: ${explicitRuntimeClock})`, async t => {
  const h = voiceClockFixture(t, { explicitRuntimeClock }), startedAt = h.now();
  const firstResponse = await h.route('', { callId: 'clock-call' });
  assert.equal(firstResponse.status, 201, await firstResponse.clone().text());
  const first = await firstResponse.json();
  h.advance(45_000);
  assert.equal((await h.route('/clock-call/close', { providerSessionId: first.providerSessionId, reason: 'transport-lost' })).status, 200);
  const nextResponse = await h.route('/clock-call/recover', { providerSessionId: first.providerSessionId });
  assert.equal(nextResponse.status, 200, await nextResponse.clone().text());
  const next = await nextResponse.json(), attempt = h.starts[1].attempt;
  assert.equal(attempt.fundedSeconds, 15, 'lagging host must not inflate continuation to maxDuration');
  assert.equal(attempt.maxMicro, 600);
  assert.equal(h.runtime.budget.get(attempt.attemptId).max_visitor_micro, 300);
  assert.equal(h.cap.snapshot().reservedMilliseconds, 60_000, 'AIT-450: minute cap holds the full credential, independently of the 15-second runway');
  assert.equal(first.spendDeadlineAt, startedAt + 60_000);
  assert.equal(first.browserLivenessDeadlineAt, startedAt + 30_000);
  assert.equal(next.spendDeadlineAt, first.spendDeadlineAt);
  assert.equal(h.starts[1].now(), h.now());
  h.advance(15_000);
  assert.equal((await h.route('/clock-call/close', { providerSessionId: next.providerSessionId, reason: 'transport-lost' })).status, 200);
  assert.equal((await h.route('/clock-call/recover', { providerSessionId: next.providerSessionId })).status, 403, 'exact spend expiry cannot reserve or dispatch');
  assert.equal(h.starts.length, 2);
  assert.equal(h.cap.snapshot().reservedMilliseconds, 0);
});

test('AIT-403 voice binding evidence is valid on the deadline clock and refuses exact expiry before spend', async t => {
  const h = voiceClockFixture(t, { evidenceMs: 30_000 });
  const response = await h.route('', { callId: 'evidence-call' });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(bindingReason({ binding: h.binding, plugin: h.plugin, preset: 'best', policy: h.presets.best.policy,
    now: h.starts[0].now() }), null, 'an admitted binding cannot already be expired on the voice deadline clock');
  const first = await response.json();
  await h.route('/evidence-call/close', { providerSessionId: first.providerSessionId, reason: 'transport-lost' });
  h.advance(30_000);
  const before = h.storage.db.prepare('SELECT COUNT(*) n FROM budget_attempts').get().n;
  const expired = await h.route('/evidence-call/recover', { providerSessionId: first.providerSessionId });
  assert.equal(expired.status, 403);
  assert.deepEqual(await expired.json(), { error: 'not-admitted' });
  await assert.rejects(h.runtime.checkVoice(h.storage.get(h.session.id)), { code: 'not-admitted', message: 'binding evidence expired' });
  assert.equal(h.storage.db.prepare('SELECT COUNT(*) n FROM budget_attempts').get().n, before);
  assert.equal(h.starts.length, 1);
  assert.equal(h.cap.snapshot().reservedMilliseconds, 0);
});

test('AIT-403 legacy voice.now configures the shared runtime admission clock without a host', async t => {
  const h = voiceClockFixture(t, { voiceClock: true });
  const response = await h.route('', { callId: 'voice-clock' });
  assert.equal(response.status, 201, await response.clone().text());
  const call = await response.json();
  assert.equal(call.spendDeadlineAt, h.now() + 60_000);
  assert.equal(h.runtime.now(), h.now());
  assert.equal(h.starts[0].now(), h.now());
  assert.equal(h.runtime.budget.now(), h.now());
  assert.equal(h.storage.now(), h.now());
});
