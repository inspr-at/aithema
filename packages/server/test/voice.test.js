import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers, createPluginRuntime, createVoiceProvider, createFacadeSecrets, mockPresets,
  SQLiteBudgetLedger, createVoiceCap, VOICE_CAP_REASON, VOICE_DAY_CAP_REASON } from '../src/index.js';
import { PluginRegistry, createMockReasoning, activeTurns, PluginError, inputRevision } from '@inspr/aithema-core';
import * as core from '@inspr/aithema-core';
import { readFile } from 'node:fs/promises';
import { temporaryDb, unzip } from '../../../test/helpers.js';
import { eventProbe } from '../../../test/voice-test-events.js';
import { createElevenLabsServer } from '../../../plugins/elevenlabs/src/server.js';

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);

for (const locale of ['de', 'en']) test(`AIT-138: server alone chooses ${locale} continuation, regardless of browser presentation`, async t => {
  const h = voiceFixture(t, { voiceOptions: { presentation: language => ({ agent: { language, firstMessage: core.aiNoticeText(language) } }) } });
  if (locale === 'de') await h.route('/locale', { locale });
  const first = await h.start();
  assert.equal(first.overrides.agent.firstMessage, core.aiNoticeText(locale));
  const response = await h.route(`/voice/${first.callId}/recover`, { providerSessionId: first.providerSessionId, presentation: 'opening' });
  assert.equal(response.status, 200); const next = await response.json();
  assert.equal(next.callId, first.callId); assert.equal(next.spendDeadlineAt, first.spendDeadlineAt);
  assert.equal(next.presentation, 'continuation'); assert.deepEqual(next.overrides, { agent: { language: locale, firstMessage: '' } });
});

test('AIT-138: transcript persistence during awaited heartbeat eligibility keeps call authorization', async t => {
  const h = voiceFixture(t), first = await h.start(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  h.beforeCoverage(async () => { entered.resolve(); await release.promise; });
  t.after(() => release.resolve());
  const beat = h.route(`/voice/${first.callId}/heartbeat`, { providerSessionId: first.providerSessionId });
  await entered.promise;
  h.storage.postTurn(h.session.id, 'new-input', new Uint8Array([1]), 'A final arrived while eligibility awaited', { ownerToken: 'voice-owner' });
  release.resolve(); assert.equal((await beat).status, 200);
  assert.deepEqual(h.closeRequests, []);
});

test('AIT-138: explicit hangup cannot be resurrected by a recover request', async t => {
  const h = voiceFixture(t), first = await h.start();
  await h.route(`/voice/${first.callId}/close`, { providerSessionId: first.providerSessionId, reason: 'closed' });
  const before = h.traffic.length;
  const response = await h.route(`/voice/${first.callId}/recover`, { providerSessionId: first.providerSessionId });
  assert.equal(response.status, 403); assert.equal(h.traffic.length, before);
});

export function voiceFixture(t, { unknown = false, leaseMs = 30_000, slowClosure = false, path, cap, reasoning = createMockReasoning(), durationBinding = {}, voiceOptions = {} } = {}) {
  const storage = new SQLiteStorage(path), secrets = createFacadeSecrets();
  let clock = Date.now(), sequence = 0, covered = true, secretReads = 0, coverageReads = 0, healthReads = 0, releasing = false, mintFailure, beforeCoverage;
  const opened = new Map(), ended = new Set(), waiting = new Map(), provisioned = [], traffic = [], closeRequests = [];
  const providerEvents = eventProbe();
  const endClient = id => { ended.add(id); waiting.get(id)?.(); waiting.delete(id); };
  const now = () => clock;
  const voiceCap = cap ? createVoiceCap({ storage, now, ...cap }) : undefined;
  const binding = { plugin: 'elevenlabs', model: 'fixture-agent', agentId: 'fixture-agent', effort: 'none',
    endpoint: 'https://provider.test', accountRef: 'fixture', secretRef: 'fixture-ref', maxMicro: 60_000,
    maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds: 60,
    upstreamMicroPerMinute: 60_000, visitorMicroPerMinute: 120_000, publicFacadeBaseUrl: 'https://facade.test', ...durationBinding };
  binding.legal = { approved: true, countries: ['AT'], training: false, retention: 'fixture', purpose: 'conversation',
    recipient: 'fixture', processors: [], dataCategories: ['conversation'], consentVersion: 1,
    evidence: { qualified: true, accountRef: binding.accountRef, secretRef: binding.secretRef,
      model: binding.model, endpoint: binding.endpoint, routing: {}, verifiedAt: clock - 1000, expiresAt: clock + 100_000 } };
  const plugin = createVoiceProvider({ storage, now, binding: { agentId: binding.agentId, secretRef: binding.secretRef,
    apiBaseUrl: binding.endpoint, upstreamMicroPerMinute: binding.upstreamMicroPerMinute, visitorMicroPerMinute: binding.visitorMicroPerMinute },
    resolveSecret: () => { secretReads++; return 'provider-fixture-value'; }, revokeFacade: secrets.revoke,
    closureTimeoutMs: slowClosure ? 30_000 : 10_000,
    requestProviderClose: record => { closeRequests.push(record.providerSessionId); providerEvents.record({ type: 'close', id: record.providerSessionId }); },
    async provisionFacade(record) { assert.ok(secrets.resolve(record.facadeSecretRef)); provisioned.push(record); },
    fetchImpl: async url => {
      traffic.push(String(url));
      if (String(url).includes('/token?')) {
        if (mintFailure) {
          providerEvents.record({ type: 'mint-failed' });
          return typeof mintFailure === 'number' ? Response.json({}, { status: mintFailure }) : mintFailure;
        }
        const id = `provider-${++sequence}`; opened.set(id, clock);
        return Response.json({ token: 'fixture-credential', conversation_id: id });
      }
      const id = String(url).split('/').at(-1);
      providerEvents.record({ type: 'details', id });
      // Provider closure is unavailable until the browser ends the SDK session.
      if (slowClosure && !ended.has(id) && !releasing) await new Promise(resolve => waiting.set(id, resolve));
      return Response.json({ conversation_id: id, status: unknown ? 'processing' : 'done',
        metadata: { start_time_unix_secs: opened.get(id) / 1000, call_duration_secs: (clock - opened.get(id)) / 1000, cost: 7 } });
    } });
  const presets = mockPresets();
  const health = plugin.health; plugin.health = options => { healthReads++; return health(options); };
  presets.best.plugins.push('elevenlabs'); presets.best.bindings.voice = binding; presets.best.policy = { endpoints: [binding.endpoint] };
  const consent = { async coverage({ scope, consentRevision }) { coverageReads++; await beforeCoverage?.(); return { covered, ...scope, scope, consentRevision, checkedAt: clock, expiresAt: clock + 100_000 }; } };
  const registry = new PluginRegistry().register(createMockReasoning()).register(plugin);
  const admittedRuntime = createPluginRuntime({ storage, registry, presets, consent, now, voiceCap });
  // Instrument reasoning after canonical admission; wrappers never gain mock trust.
  const runtime = { ...admittedRuntime, async admit(args) {
    const admitted = await admittedRuntime.admit(args);
    return args.lane === 'voice' ? admitted : { ...admitted, plugin: reasoning };
  } };
  const handlers = createHandlers({ storage, reasoning, pluginRuntime: runtime, consent, voice: { secrets, now, browserLeaseMs: leaseMs, ...voiceOptions } });
  t.after(async () => { releasing = true; for (const id of waiting.keys()) endClient(id); await handlers.close(); storage.close(); });
  const token = 'voice-owner', session = storage.create({ ownerToken: token, demo: true });
  const route = async (suffix, body = {}, owner = token) => handlers.handle(new Request(`http://host/api/sessions/${session.id}${suffix}`, {
    method: 'POST', headers: { 'x-aithema-session-token': owner }, body: JSON.stringify(body) }));
  const start = async (callId = 'call-1') => {
    const response = await route('/voice', { callId }); assert.equal(response.status, 201); return response.json();
  };
  return { storage, secrets, runtime, handlers, session, route, start, presets, provisioned, traffic, now, voiceCap, plugin: registry.get('elevenlabs'), endClient, closeRequests,
    failMint: failure => { mintFailure = failure; },
    waitForMintFailure: () => providerEvents.waitFor(event => event.type === 'mint-failed'),
    waitForClosure: id => providerEvents.waitFor(event => event.type === 'details' && event.id === id),
    authChecks: () => ({ secretReads, coverageReads, healthReads }),
    advance: ms => { clock += ms; }, coverage: value => { covered = value; }, beforeCoverage: fn => { beforeCoverage = fn; } };
}

function assertUnbillableStart(h) {
  const row = h.storage.db.prepare('SELECT * FROM budget_attempts WHERE lane=\'voice\' ORDER BY rowid DESC LIMIT 1').get();
  assert.equal(row.state, 'settled'); assert.equal(row.outcome, 'cancelled');
  assert.equal(row.settled_micro, 0); assert.equal(row.settled_visitor_micro, 0);
  const terminal = JSON.parse(row.terminal_json);
  assert.equal(terminal.closureConfirmed, true); assert.equal(terminal.chargedMicro, 0);
  assert.equal(terminal.usage.providerSeconds, 0);
  assert.equal(h.storage.db.prepare('SELECT actual_ms FROM voice_cap_reservations WHERE attempt_id=?').get(row.attempt_id).actual_ms, 0);
  assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 0);
}

test('AIT-134 round 2: a padded nonrolling duration maximum admits and remains the closing exposure', async t => {
  const h = voiceFixture(t, { durationBinding: { maxMicro: 200_000, upstreamMicroPerMinute: 100_000 } });
  const admitted = await h.runtime.admitVoice({ session: h.storage.get(h.session.id), request: { callId: 'padded' } });
  const attempt = admitted.options.attempt, row = h.runtime.budget.get(attempt.attemptId);
  assert.equal(row.max_micro, 200_000);
  assert.equal(row.voice_exposure_micro, 200_000, 'the padded maximum exceeds the computed 100,000 exposure');
  assert.equal(row.max_visitor_micro, 120_000);
  assert.equal(row.voice_visitor_exposure_micro, 120_000);
  await attempt.consume(); admitted.finish();
  assert.equal(h.runtime.budget.used(h.session.id), 200_000);
  assert.equal(h.runtime.budget.breakdown(h.session.id).uncertainSpendMicro, 200_000);
  assert.equal(h.runtime.budget.visitorUsed(h.session.id), 120_000);
});

test('AIT-127: locale is authenticated, durable, in place, and refused after any turn', async t => {
  const h = voiceFixture(t), id = h.session.id;
  assert.equal((await h.route('/locale', { locale: 'de' }, 'stranger')).status, 404);
  for (const locale of ['fr', '', null]) assert.equal((await h.route('/locale', { locale })).status, 400);
  const response = await h.route('/locale', { locale: 'de' }); assert.equal(response.status, 200);
  const ack = await response.json();
  assert.equal(ack.session.id, id); assert.equal(ack.session.locale, 'de'); assert.equal(ack.session.understanding.locale, 'de');
  assert.equal(ack.event.type, 'session.locale-changed');
  assert.equal(h.storage.read(id).at(-1).type, 'session.locale-changed');
  assert.equal((await h.route('/turns', { clientEventId: 'first', content: 'Hallo' })).status, 200);
  assert.equal((await h.route('/locale', { locale: 'en' })).status, 409);
  assert.equal(h.storage.get(id).transcript[0].content, 'Hallo');
  await h.handlers.idle(); await h.route('/withdraw', { turnId: 'first' });
  assert.equal((await h.route('/locale', { locale: 'en' })).status, 409, 'withdrawn turns still mark a started conversation');
});

test('AIT-127: locale cannot interrupt a connecting or active call with no turns', async t => {
  const h = voiceFixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const admit = h.runtime.admitVoice.bind(h.runtime);
  h.runtime.admitVoice = async (...args) => { entered.resolve(); await release.promise; return admit(...args); };
  const pending = h.route('/voice', { callId: 'connecting' }); await entered.promise;
  const refused = await h.route('/locale', { locale: 'de' });
  release.resolve(); const started = await pending; const call = await started.json();
  assert.equal(refused.status, 409); assert.equal(started.status, 201);
  assert.equal((await h.route('/locale', { locale: 'de' })).status, 409);
  assert.equal(h.storage.get(h.session.id).transcript.length, 0); assert.equal(h.storage.get(h.session.id).locale, 'en');
  assert.deepEqual(h.closeRequests, []);
  await h.route(`/voice/${call.callId}/close`, { providerSessionId: call.providerSessionId });
  assert.equal((await h.route('/locale', { locale: 'de' })).status, 200);
});

test('AIT-127: a locale body overtaken by a first turn is refused; a turn body overtaken by locale is retained', async t => {
  const h = voiceFixture(t);
  function delayed(suffix, body) {
    let writer;
    const request = new Request(`http://host/api/sessions/${h.session.id}${suffix}`, { method: 'POST', duplex: 'half',
      headers: { 'x-aithema-session-token': 'voice-owner' }, body: new ReadableStream({ start(controller) { writer = controller; } }) });
    return { response: h.handlers.handle(request), finish() { writer.enqueue(new TextEncoder().encode(JSON.stringify(body))); writer.close(); } };
  }
  const turn = delayed('/turns', { clientEventId: 'first', content: 'First turn' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.route('/locale', { locale: 'de' })).status, 200);
  turn.finish(); assert.equal((await turn.response).status, 200);
  assert.equal(h.storage.get(h.session.id).transcript[0].content, 'First turn');
  const other = voiceFixture(t), gate = Promise.withResolvers();
  const pending = other.handlers.handle(new Request(`http://host/api/sessions/${other.session.id}/locale`, { method: 'POST', duplex: 'half',
    headers: { 'x-aithema-session-token': 'voice-owner' }, body: new ReadableStream({ async start(controller) {
      await gate.promise; controller.enqueue(new TextEncoder().encode('{"locale":"de"}')); controller.close();
    } }) }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await other.route('/turns', { clientEventId: 'first', content: 'First turn' })).status, 200);
  gate.resolve(); assert.equal((await pending).status, 409);
  assert.equal(other.storage.get(other.session.id).locale, 'en');
});

test('AIT-127: legacy facade provisioning receives the base URL for one completion suffix', async t => {
  const h = voiceFixture(t), call = await h.start();
  assert.equal(h.provisioned[0].url, `https://facade.test/api/voice/${call.callId}/llm`);
  assert.equal(new URL(`${h.provisioned[0].url}/chat/completions`).pathname, `/api/voice/${call.callId}/llm/chat/completions`);
});

for (const status of [500, 429]) {
  test(`failed credential mint (${status}) durably releases minutes and both budgets before a later call`, async t => {
    const h = voiceFixture(t, { cap: { capMilliseconds: 60_000, perDayMilliseconds: 60_000 } });
    h.failMint(status);
    assert.equal((await h.route('/voice', { callId: 'failed' })).status, 502);
    assertUnbillableStart(h); assert.equal(h.storage.voiceCalls().length, 0);
    assert.equal(h.runtime.budget.used(h.session.id), 0); assert.equal(h.runtime.budget.visitorUsed(h.session.id), 0);
    h.failMint(null); await h.start('later-call');
    assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 60_000);
  });
}

test('timed-out mint releases the cap and a late credential cannot create a billable call', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = voiceFixture(t, { cap: { capMilliseconds: 60_000 } }), late = Promise.withResolvers();
  h.failMint(late.promise);
  const pending = h.route('/voice', { callId: 'timeout' });
  await h.waitForMintFailure(); h.advance(30_000); t.mock.timers.tick(30_000);
  assert.equal((await pending).status, 504); assertUnbillableStart(h);
  late.resolve(Response.json({ token: 'fixture-late-credential', conversation_id: 'late-provider' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.storage.voiceCalls().length, 0); assertUnbillableStart(h);
  h.failMint(null); await h.start('later-call');
});

test('saveCall failure before a provider identity still releases minutes and money on the failure path', async t => {
  const h = voiceFixture(t, { cap: { capMilliseconds: 60_000 } }), original = h.plugin.start;
  let saves = 0;
  const server = createElevenLabsServer({ binding: h.plugin.binding,
    prepareCall: () => { throw new Error('preflight failed'); },
    saveCall: record => { saves++; assert.equal(record.providerSessionId, undefined); throw new Error('journal failed'); },
    fetchImpl: () => { assert.fail('no provider work before preflight succeeds'); } });
  h.plugin.start = (request, options) => server.start(request, options);
  assert.equal((await h.route('/voice', { callId: 'failed-save' })).status, 503);
  assert.equal(saves, 1); assertUnbillableStart(h);
  h.plugin.start = original; await h.start('later-call');
});

test('post-mint journal failure withholds the credential and durably releases the cap and both budgets', async t => {
  const h = voiceFixture(t, { cap: { capMilliseconds: 60_000 } }), save = h.storage.saveVoiceCall;
  h.storage.saveVoiceCall = () => { throw new Error('journal failed'); };
  assert.equal((await h.route('/voice', { callId: 'failed-save' })).status, 503);
  assertUnbillableStart(h); assert.equal(h.closeRequests.length, 0);
  h.storage.saveVoiceCall = save; await h.start('later-call');
});

test('failed recovery mint releases only its own hold and permits a later call', async t => {
  const h = voiceFixture(t, { cap: { capMilliseconds: 65_000 } }), first = await h.start();
  h.advance(5000);
  await h.route(`/voice/${first.callId}/close`, { providerSessionId: first.providerSessionId, reason: 'transport-lost' });
  h.failMint(500);
  assert.equal((await h.route(`/voice/${first.callId}/recover`, { providerSessionId: first.providerSessionId })).status, 502);
  assertUnbillableStart(h); assert.equal(h.voiceCap.snapshot().spentMilliseconds, 5000);
  assert.equal(h.runtime.budget.used(h.session.id), 5000); assert.equal(h.runtime.budget.visitorUsed(h.session.id), 10_000);
  h.failMint(null); await h.start('later-call');
  assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 60_000);
});

for (const [limits, reason] of [[{ capMilliseconds: 59_999 }, VOICE_CAP_REASON], [{ perDayMilliseconds: 59_999 }, VOICE_DAY_CAP_REASON]]) {
  test(`aggregate admission exposes ${reason} before credential minting or facade provisioning`, async t => {
    const h = voiceFixture(t, { cap: limits });
    const response = await h.route('/voice', { callId: 'denied' });
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'not-admitted', reason });
    assert.deepEqual(h.traffic, []); assert.deepEqual(h.provisioned, []);
    assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 0);
    assert.deepEqual((await h.runtime.matrix(h.storage.get(h.session.id))).best.voice, { available: false, reason });
  });
}

test('parallel starts from different sessions cannot overshoot the deployment duration cap', async t => {
  const h = voiceFixture(t, { cap: { capMilliseconds: 120_000, perDayMilliseconds: 120_000 } });
  const sessions = Array.from({ length: 8 }, () => h.storage.create({ ownerToken: 'voice-owner', demo: true }));
  const responses = await Promise.all(sessions.map((session, i) => h.handlers.handle(new Request(`http://host/api/sessions/${session.id}/voice`, {
    method: 'POST', headers: { 'x-aithema-session-token': 'voice-owner' }, body: JSON.stringify({ callId: `parallel-${i}` }) }))));
  assert.equal(responses.filter(r => r.status === 201).length, 2);
  assert.equal(responses.filter(r => r.status === 403).length, 6);
  assert.equal(h.traffic.filter(url => url.includes('/token?')).length, 2);
  assert.equal(h.provisioned.length, 2); assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 120_000);
  for (const response of responses.filter(r => r.status === 403)) assert.equal((await response.json()).reason, VOICE_CAP_REASON);
});

test('confirmed closure releases unused aggregate minutes including paused provider time; active calls remain authorized at the cap', async t => {
  const h = voiceFixture(t, { cap: { capMilliseconds: 70_000, perDayMilliseconds: 70_000 } }), first = await h.start();
  assert.equal((await h.runtime.matrix(h.storage.get(h.session.id))).best.voice.reason, VOICE_CAP_REASON);
  h.advance(5000);
  const identity = { providerSessionId: first.providerSessionId };
  assert.equal((await h.route(`/voice/${first.callId}/pause`, identity)).status, 200);
  h.advance(5000);
  assert.equal((await h.route(`/voice/${first.callId}/resume`, identity)).status, 200);
  assert.equal((await h.route(`/voice/${first.callId}/heartbeat`, identity)).status, 200);
  assert.equal((await h.route(`/voice/${first.callId}/close`, identity)).status, 200);
  assert.equal(h.voiceCap.snapshot().spentMilliseconds, 10_000, 'paused provider duration remains billable');
  assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 0);
  await h.start('next-call'); assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 60_000);
});

test('unknown closure keeps aggregate duration until authenticated reconciliation', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = voiceFixture(t, { unknown: true, cap: { capMilliseconds: 60_000 } }), grant = await h.start();
  h.advance(2000); const closing = h.route(`/voice/${grant.callId}/close`, { providerSessionId: grant.providerSessionId });
  await h.waitForClosure(grant.providerSessionId); t.mock.timers.tick(10_000);
  const terminal = await closing.then(r => r.json());
  assert.equal(terminal.outcome, 'uncertain'); assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 60_000);
  assert.equal((await h.route('/voice', { callId: 'denied' })).status, 403);
  const record = h.storage.voiceCalls()[0];
  h.runtime.reconcileVoice(record.attemptId, { ...terminal, outcome: 'completed', closureConfirmed: true,
    usage: { providerSeconds: 2, providerMinutes: 2 / 60, pausedSeconds: 0, visitorSeconds: 2, upstreamMicro: 2000, visitorMicro: 4000 } });
  assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 0); assert.equal(h.voiceCap.snapshot().spentMilliseconds, 2000);
});

test('recovery and stale reconnect replay use remaining aggregate duration under one call identity', async t => {
  const h = voiceFixture(t, { cap: { capMilliseconds: 60_000, perDayMilliseconds: 60_000 } }), first = await h.start();
  h.advance(10_000);
  assert.equal((await h.route(`/voice/${first.callId}/close`, { providerSessionId: first.providerSessionId, reason: 'transport-lost' })).status, 200);
  const response = await h.route(`/voice/${first.callId}/recover`, { providerSessionId: first.providerSessionId });
  assert.equal(response.status, 200); const next = await response.json();
  assert.equal(next.callId, first.callId); assert.equal(next.spendDeadlineAt, first.spendDeadlineAt);
  assert.equal(h.voiceCap.snapshot().spentMilliseconds, 10_000); assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 50_000);
  const replay = await h.route(`/voice/${first.callId}/recover`, { providerSessionId: first.providerSessionId });
  assert.equal(replay.status, 200); assert.equal((await replay.json()).providerSessionId, next.providerSessionId);
  assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 50_000);
  const rows = h.storage.db.prepare('SELECT call_id, reserved_ms FROM voice_cap_reservations').all();
  assert.deepEqual(rows.map(r => r.reserved_ms), [60_000, 50_000]); assert.ok(rows.every(r => r.call_id === first.callId));
});

test('overlapping recovery extends the call conservatively and an old settlement cannot release the successor hold', async t => {
  const h = voiceFixture(t, { slowClosure: true, cap: { capMilliseconds: 120_000 } }), first = await h.start();
  h.advance(5000);
  const response = await h.route(`/voice/${first.callId}/recover`, { providerSessionId: first.providerSessionId });
  assert.equal(response.status, 200); const next = await response.json();
  assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 115_000);
  await h.waitForClosure(first.providerSessionId); h.endClient(first.providerSessionId); await h.handlers.idle();
  assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 55_000); assert.equal(h.voiceCap.snapshot().spentMilliseconds, 5000);
  assert.equal((await h.route(`/voice/${next.callId}/heartbeat`, { providerSessionId: next.providerSessionId })).status, 200);
});

test('recovery refuses before minting while the predecessor is unconfirmed, then reuses its released headroom', async t => {
  const h = voiceFixture(t, { slowClosure: true, cap: { capMilliseconds: 60_000 } }), first = await h.start();
  h.advance(5000);
  const denied = await h.route(`/voice/${first.callId}/recover`, { providerSessionId: first.providerSessionId });
  assert.equal(denied.status, 403); assert.equal((await denied.json()).reason, VOICE_CAP_REASON);
  assert.equal(h.traffic.filter(url => url.includes('/token?')).length, 1);
  assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 60_000);
  await h.waitForClosure(first.providerSessionId); h.endClient(first.providerSessionId); await h.handlers.idle();
  const retry = await h.route(`/voice/${first.callId}/recover`, { providerSessionId: first.providerSessionId });
  assert.equal(retry.status, 200); const next = await retry.json();
  assert.equal(next.callId, first.callId); assert.equal(next.spendDeadlineAt, first.spendDeadlineAt);
  assert.equal(h.voiceCap.snapshot().spentMilliseconds, 5000); assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 55_000);
});

test('an undispatched admission releases its aggregate hold after the consent check fails', async t => {
  const h = voiceFixture(t, { cap: { capMilliseconds: 60_000 } });
  const admitted = await h.runtime.admitVoice({ session: h.storage.get(h.session.id), request: { callId: 'revoked' } });
  assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 60_000);
  h.storage.reviseConsent(h.session.id, false);
  await assert.rejects(admitted.options.attempt.consume(), /refused/); admitted.finish();
  assert.equal(h.voiceCap.snapshot().reservedMilliseconds, 0); assert.equal(h.voiceCap.snapshot().spentMilliseconds, 0);
  assert.deepEqual(h.traffic, []);
});

test('voice start, speak, heard correction, type, pause, resume and close share durable turns and duration settlement', async t => {
  const h = voiceFixture(t), grant = await h.start(), identity = { providerSessionId: grant.providerSessionId };
  const event = async value => {
    const response = await h.route(`/voice/${grant.callId}/events`, { ...identity, event: { callId: grant.callId, ...value } });
    assert.equal(response.status, 200); return response.json();
  };
  const spoken = { type: 'final', turnId: `${grant.providerSessionId}:user:1`, role: 'user', text: 'systems: API; data: public' };
  const person = await event(spoken);
  for (const key of ['origin', 'model', 'provider']) assert.equal(Object.hasOwn(person.data, key), false);
  const rows = h.storage.read(h.session.id).filter(e => e.type === 'turn.final').length;
  await event(spoken); assert.equal(h.storage.read(h.session.id).filter(e => e.type === 'turn.final').length, rows, 'final callback is idempotent');
  await event({ type: 'final', turnId: `${grant.providerSessionId}:assistant:2`, role: 'assistant', text: 'Understood. This remainder was not heard.' });
  const corrected = await event({ type: 'heard', turnId: `${grant.providerSessionId}:assistant:2`, prefix: 'Understood.' });
  assert.equal(corrected.data.origin, 'ai-generated'); assert.equal(corrected.data.model, 'fixture-agent'); assert.equal(corrected.data.provider, 'elevenlabs');
  await event({ type: 'final', turnId: `${grant.providerSessionId}:user:3`, role: 'user', text: 'Typed during the call' });
  h.advance(2000);
  const pause = await h.route(`/voice/${grant.callId}/pause`, identity); assert.deepEqual(await pause.json(), { acknowledged: true, paused: true });
  assert.equal(h.storage.get(h.session.id).paused, true);
  h.advance(5000);
  const beat = await h.route(`/voice/${grant.callId}/heartbeat`, { ...identity, browserLivenessDeadlineAt: 1e15 });
  const lease = await beat.json(); assert.equal(lease.browserLivenessDeadlineAt, h.now() + 30_000);
  const resume = await h.route(`/voice/${grant.callId}/resume`, identity); assert.equal((await resume.json()).acknowledged, true);
  h.advance(3000);
  const terminal = await h.route(`/voice/${grant.callId}/close`, identity).then(r => r.json());
  assert.equal(terminal.outcome, 'completed'); assert.equal(terminal.closureConfirmed, true);
  assert.deepEqual(terminal.usage, { providerSeconds: 10, providerMinutes: 10 / 60, pausedSeconds: 5, visitorSeconds: 5,
    upstreamMicro: 10_000, visitorMicro: 10_000, providerCredits: 7,
    costSource: 'duration-estimate', costEstimated: true, estimateMicroPerMinute: 60_000 });
  assert.deepEqual(await h.route(`/voice/${grant.callId}/close`, identity).then(r => r.json()), terminal);
  const budget = h.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='voice'").all();
  assert.equal(budget.length, 1); assert.equal(budget[0].settled_micro, 10_000); assert.equal(budget[0].settled_visitor_micro, 10_000);
  assert.equal(h.runtime.budget.visitorUsed(h.session.id), 10_000); assert.equal(budget[0].state, 'settled');
  assert.equal(JSON.parse(budget[0].usage).visitorSeconds, 5);
  await h.handlers.idle();
  assert.ok(h.storage.get(h.session.id).understanding.constraints.systems);
  const exported = await h.handlers.handle(new Request(`http://host/api/sessions/${h.session.id}/export`, { headers: { 'x-aithema-session-token': 'voice-owner' } }));
  const bytes = Buffer.from(await exported.arrayBuffer()).toString(); assert.ok(!bytes.includes('This remainder was not heard'));
  assert.ok(h.storage.read(h.session.id).some(e => e.type === 'turn.corrected' && e.data.content === 'Understood.'));
  assert.equal(h.secrets.resolve(h.provisioned[0].facadeSecretRef), undefined);
  assert.ok(!JSON.stringify(h.storage.voiceCalls()).includes('fixture-credential'));
});

test('voice facade uses per-call auth, route binding, session reasoning and separately settled reaction claims', async t => {
  const h = voiceFixture(t), grant = await h.start();
  const secret = h.secrets.resolve(h.provisioned[0].facadeSecretRef);
  const facade = (callId = grant.callId, auth = secret, extra = {}) => h.handlers.handle(new Request(`https://facade.test/api/voice/${callId}/llm/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify({ aithema_call: grant.callId,
      messages: [{ role: 'user', content: 'Hello' }], ...extra }) }));
  assert.equal((await facade('other')).status, 401); assert.equal((await facade(grant.callId, 'wrong')).status, 401);
  const completion = await facade(); assert.equal(completion.status, 200); assert.ok((await completion.json()).choices[0].message.content);
  const row = h.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='reaction'").get(); assert.equal(row.state, 'settled');
  await h.route(`/voice/${grant.callId}/pause`, { providerSessionId: grant.providerSessionId });
  assert.equal((await facade()).status, 403);
  await h.route(`/voice/${grant.callId}/close`, { providerSessionId: grant.providerSessionId });
  assert.equal((await facade()).status, 401);
});

async function voicePromptFixture(t, prepare = () => {}, { stream } = {}) {
  const requests = [], base = createMockReasoning();
  const h = voiceFixture(t, { reasoning: { ...base, async *stream(request, options) {
    requests.push(request); yield* (stream ? stream(request, options) : base.stream(request, options));
  }, async structured(request, options) {
    // Keep background understanding from adding a separate focused-question message.
    return { ...await base.structured(request, options), openQuestions: [] };
  } } });
  prepare(h);
  const grant = await h.start(), secret = h.secrets.resolve(h.provisioned[0].facadeSecretRef);
  const persist = async (role, id, text) => {
    const response = await h.route(`/voice/${grant.callId}/events`, { providerSessionId: grant.providerSessionId,
      event: { type: 'final', callId: grant.callId, turnId: `${grant.providerSessionId}:${role}:${id}`, role, text } });
    assert.equal(response.status, 200); return response.json();
  };
  const callbackResponse = messages => h.handlers.handle(new Request(`https://facade.test/api/voice/${grant.callId}/llm/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ aithema_call: grant.callId, messages }) }));
  const callback = async messages => {
    const response = await callbackResponse(messages);
    assert.equal(response.status, 200); await response.json();
    // The first message is server-added understanding, before the conversation.
    return requests.at(-1).messages.slice(1);
  };
  const recorded = () => activeTurns(h.storage.get(h.session.id)).map(({ role, content }) => ({ role, content }));
  return { ...h, grant, requests, persist, callback, callbackResponse, recorded };
}

function voiceUnderstanding(h, question, { draft = false, openQuestions = [question] } = {}) {
  const session = h.storage.get(h.session.id);
  // New assessments must not reuse the hydrated record's content reference.
  const { contentRef, hash, ...understanding } = session.understanding;
  h.storage.append(session.id, 'understanding.updated', { ...understanding,
    inputRevision: inputRevision(session), draft, openQuestions });
  h.storage.append(session.id, 'question.focused', { question });
}

test('AIT-144: a persisted answer invalidates the old voice focus while understanding is pending', async t => {
  const h = await voicePromptFixture(t), question = 'Sind ein bis zwei Polster am Tag insgesamt gemeint?';
  voiceUnderstanding(h, question);
  // Persist speech without completing the asynchronous understanding lane.
  h.storage.postVoiceEvent(h.session.id, h.grant.callId, h.grant.providerSessionId, {
    type: 'final', callId: h.grant.callId, turnId: `${h.grant.providerSessionId}:user:answer`,
    role: 'user', text: 'Insgesamt gemeint.' });
  await h.callback(h.recorded());
  const request = h.requests.at(-1), context = JSON.parse(request.messages[0].content);
  assert.equal(context.stale, true);
  assert.equal(request.messages.some(m => m.content.includes('untrusted-focused-question')), false,
    'the already answered focus must not be offered as a next question');
  assert.match(request.system, /Never re-ask[^\n]*canonical/iu);
});

test('AIT-144: a callback answer not yet persisted makes even a current understanding stale', async t => {
  const h = await voicePromptFixture(t), question = 'Versand nach Deutschland, Österreich und in die Schweiz?';
  voiceUnderstanding(h, question);
  await h.callback([{ role: 'user', content: 'Genau diese drei Länder, das passt.' }]);
  const request = h.requests.at(-1), context = JSON.parse(request.messages[0].content);
  assert.equal(context.stale, true, 'understanding has not seen the callback answer');
  assert.equal(request.messages.some(m => m.content.includes('untrusted-focused-question')), false);
  assert.equal(request.messages.at(-1).content, 'Genau diese drei Länder, das passt.');
  assert.equal(h.storage.get(h.session.id).transcript.length, 0, 'prompt construction does not persist input');
});

test('AIT-144: only a current final open question can supply voice focus', async t => {
  const h = await voicePromptFixture(t), question = 'Welche Domain wünschen Sie?';
  h.storage.postVoiceEvent(h.session.id, h.grant.callId, h.grant.providerSessionId, {
    type: 'final', callId: h.grant.callId, turnId: `${h.grant.providerSessionId}:assistant:question`,
    role: 'assistant', text: question });
  for (const [name, options, expected] of [
    ['current final', {}, true], ['draft', { draft: true }, false],
    ['removed from current questions', { openQuestions: [] }, false],
  ]) {
    // Understanding changes alone do not create a new voice operation. Give
    // each focus case a final user turn and its own callback admission.
    h.storage.postVoiceEvent(h.session.id, h.grant.callId, h.grant.providerSessionId, {
      type: 'final', callId: h.grant.callId, turnId: `${h.grant.providerSessionId}:user:focus-${name}`,
      role: 'user', text: `Input for ${name}` });
    voiceUnderstanding(h, question, options);
    await h.callback(h.recorded());
    const messages = h.requests.at(-1).messages;
    assert.equal(messages.some(m => m.content.includes('untrusted-focused-question')), expected, name);
  }
  assert.equal(h.requests.length, 3, 'all three cases build fresh requests');
});

test('AIT-144: voice guidance varies openings and limits speech to one short question', async t => {
  const h = await voicePromptFixture(t);
  await h.callback([{ role: 'user', content: 'Hallo' }]);
  const { system } = h.requests.at(-1);
  assert.match(system, /Never open[^\n]*Danke/iu);
  assert.match(system, /Vary acknowledgements/iu);
  assert.match(system, /two or three short sentences/iu);
  assert.match(system, /at most one question/iu);
  assert.match(system, /Do not read back[^\n]*summary/iu);
  assert.match(system, /stale[^\n]*open questions/iu);
  assert.match(system, /canonical[^\n]*latest[^\n]*take precedence/iu);
});

for (const locale of ['de', 'en']) {
  test(`AIT-150: ${locale} voice replies inherit the conditional German address rule once from core`, async t => {
    const h = await voicePromptFixture(t, h => h.storage.append(h.session.id, 'session.locale-changed', { locale }));
    await h.callback([{ role: 'user', content: locale === 'de' ? 'Hallo' : 'Hello' }]);
    const { system } = h.requests.at(-1);
    const rule = 'When the conversation language is German, address the person with the polite Sie form consistently (never du or ihr); use idiomatic German.';
    assert.ok(core.GENERIC_POLICY.includes(rule));
    assert.equal(system.split(core.GENERIC_POLICY).length, 2);
    assert.ok(system.includes(rule));
    assert.equal(system.split('polite Sie form').length, 2, 'voice must not duplicate the shared rule');
    assert.ok(system.includes(`Write in ${locale === 'de' ? 'German' : 'English'} (locale ${locale})`));
    assert.doesNotMatch(system, /when the locale is German/u);
  });

  test(`AIT-148: ${locale} voice replies compose the shared core policy with voice-only guidance`, async t => {
    const h = await voicePromptFixture(t, h => h.storage.append(h.session.id, 'session.locale-changed', { locale }));
    await h.callback([{ role: 'user', content: locale === 'de' ? 'Hallo' : 'Hello' }]);
    const { system } = h.requests.at(-1);
    assert.equal(typeof core.REPLY_POLICY, 'string');
    assert.ok(core.REPLY_POLICY.length > 0);
    assert.equal(system.split(core.REPLY_POLICY).length, 2);
    assert.match(system, /Never open formulaically with "Danke", "Vielen Dank", "Thanks" or "Thank you"/u);
    assert.match(system, /Do not replace these with another repeated stock opener or praise/u);
    assert.match(system, /Vary acknowledgements and engage directly/u);
    assert.match(system, /Never re-ask[^\n]*canonical person turns/iu);
    assert.match(system, /two or three short sentences[^\n]*at most 60 words[^\n]*at most one question/iu);
    assert.match(system, /Do not read back[^\n]*summary/iu);
    assert.match(system, /stale or draft, ignore its open questions/iu);
    assert.match(system, /focused question is only a suggestion/iu);
  });
}

test('AIT-144: transcript replay keeps confirmed capacity and DACH out of fake replies', async t => {
  // De-identified excerpts of the reported German call. Provider metadata and
  // business identifiers are deliberately absent. The fake probes the prompt
  // contract; its output scores are not evidence of real-model performance.
  const capacity = 'Sind ein bis zwei Polster am Tag insgesamt oder zusätzlich gemeint?';
  const region = 'Versand nach Deutschland, Österreich und in die Schweiz?';
  const replay = [
    [capacity, 'Insgesamt gemeint.', 'capacity'],
    [capacity, 'Zwischen fünf bis zehn Werktagen.', null, 'Wie lange möchten Sie als Lieferzeit zusagen?'],
    [capacity, 'Ja, stimmt.', 'capacity'],
    ['Haben Sie Fotos, Beschreibungen und Preise?', 'Ja, auf jeden Fall hab ich das zur Verfügung.', null],
    ['Wer hat die Rechte auf das Foto?', 'Der Kunde muss einfach angeben, dass er die Rechte auf das Foto hat.', null],
    [region, 'Der Versand findet im deutschsprachigen Raum statt.', null],
    [region, 'Genau diese drei Länder, das passt.', 'region'],
    [region, '5 Prozent.', null, 'Wie hoch soll die Bearbeitungsgebühr sein?'],
    ['Welche Versandkosten?', 'Versandkosten pro Polster sind 20 Euro plus zusätzlichen Polster jeweils 5 Euro.', null],
    ['Gilt die Versandpauschale für alle Länder?', 'Ja, die Versandpauschalen gelten für alle Länder.', null],
  ];
  const base = createMockReasoning(), replies = [], confirmed = new Set();
  const h = await voicePromptFixture(t, h => h.storage.append(h.session.id, 'session.locale-changed', { locale: 'de' }), { async *stream(request, options) {
    const context = JSON.parse(request.messages[0].content);
    const focus = request.messages.find(m => m.content.includes('untrusted-focused-question'));
    // Behave like a model that picks the offered focus first; otherwise use
    // current open questions. The production bug offers an answered old focus.
    const question = focus ? JSON.parse(focus.content).question : context.stale ? null : context.understanding.openQuestions[0];
    const opener = /Never open[^\n]*Danke/iu.test(request.system) ? '' : 'Danke, ';
    const content = opener + (question ?? 'Die Einschätzung wird aktualisiert.');
    replies.push(content);
    // Use the admitted fake for terminal accounting, replacing only its text.
    for await (const ignored of base.stream(request, options)) { void ignored; }
    yield content;
  } });
  const record = (role, index, text) => h.storage.postVoiceEvent(h.session.id, h.grant.callId, h.grant.providerSessionId, {
    type: 'final', callId: h.grant.callId, turnId: `${h.grant.providerSessionId}:${role}:replay-${index}`, role, text });
  for (const [index, [question, answer, slot, heardQuestion = question]] of replay.entries()) {
    record('assistant', index, heardQuestion);
    const prior = h.recorded();
    voiceUnderstanding(h, question);
    if (slot) confirmed.add(slot);
    const latest = { role: 'user', content: answer };
    // Replay both arrival orders: final-event first and callback first.
    if (index % 2 === 0) record('user', index, answer);
    await h.callback([...h.recorded(), ...(index % 2 === 0 ? [] : [latest])]);
    const request = h.requests.at(-1);
    assert.equal(request.messages.filter(m => m.content === answer).length, 1);
    assert.deepEqual(request.messages.filter(m => prior.some(t => t.content === m.content)), prior);
    const reply = replies.at(-1);
    if (confirmed.has('capacity')) assert.doesNotMatch(reply, /(?:insgesamt|zusätzlich)[^?]*\?/iu, `replay ${index}: capacity`);
    if (confirmed.has('region')) assert.doesNotMatch(reply, /(?:Versand|Länder|Schweiz)[^?]*\?/iu, `replay ${index}: DACH`);
    assert.ok((reply.match(/\?/gu) ?? []).length <= 1);
    assert.ok(reply.split(/\s+/u).length <= 60);
    if (index % 2 !== 0) record('user', index, answer);
  }
  const formulaic = replies.filter(reply => /^(?:Danke|Vielen Dank|Thanks|Thank you)\b/iu.test(reply));
  assert.ok(formulaic.length / replies.length <= .2, `${formulaic.length}/${replies.length} formulaic openers`);
});

// Hold the actual consent evaluation, rather than wrapping an already completed check.
// Restore the port before waiting so a concurrent persistEvent can authorize normally.
function pendingVoiceConsent(t, h) {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const coverage = h.runtime.consent.coverage;
  h.runtime.consent.coverage = async (...args) => {
    if (args[0].scope.plugin !== 'elevenlabs') return coverage(...args);
    h.runtime.consent.coverage = coverage;
    entered.resolve(); await release.promise;
    return coverage(...args);
  };
  t.after(() => { h.runtime.consent.coverage = coverage; release.resolve(); });
  return { entered: entered.promise, release: () => release.resolve() };
}

test('AIT-130 round 4 keeps the newest Ja with balanced provider and typed histories', async t => {
  const h = await voicePromptFixture(t, h => {
    for (const [id, content] of [['typed-1', 'T1'], ['typed-2', 'T2']]) {
      h.storage.postTurn(h.session.id, id, Buffer.from(content), content);
    }
  });
  await h.persist('assistant', 'question', 'Q');
  assert.equal((await h.route('/turns', { clientEventId: 'typed-ja', content: 'Ja',
    voiceCallId: h.grant.callId, providerSessionId: h.grant.providerSessionId })).status, 200);
  const recorded = h.recorded(), latest = { role: 'user', content: 'Ja' };
  const history = [{ role: 'assistant', content: 'Greeting' }, latest, { role: 'assistant', content: 'Q' }, latest];
  assert.equal(history.length, recorded.length);
  assert.deepEqual(await h.callback(history), [...recorded, latest]);
});

test('AIT-130 round 4 never suppresses spoken Ja with a typed Ja during the same call', async t => {
  const h = await voicePromptFixture(t);
  assert.equal((await h.route('/turns', { clientEventId: 'typed-ja', content: 'Ja',
    voiceCallId: h.grant.callId, providerSessionId: h.grant.providerSessionId })).status, 200);
  const latest = { role: 'user', content: 'Ja' };
  assert.deepEqual(await h.callback([latest]), [...h.recorded(), latest]);
});

for (const [name, callId, providerSessionId] of [
  ['an earlier call', 'earlier-call', 'earlier-provider'],
  ['an earlier provider generation of the same call', 'call-1', 'earlier-provider'],
]) {
  test(`AIT-130 round 4 never suppresses current Ja with Ja from ${name}`, async t => {
    const h = await voicePromptFixture(t, h => {
      h.storage.postVoiceEvent(h.session.id, callId, providerSessionId, {
        type: 'final', callId, turnId: `${providerSessionId}:user:ja`, role: 'user', text: 'Ja' });
    });
    const latest = { role: 'user', content: 'Ja' };
    assert.deepEqual(await h.callback([latest]), [...h.recorded(), latest]);
  });
}

test('AIT-130 round 4 deduplicates a normalized utterance already persisted by the same call', async t => {
  const h = await voicePromptFixture(t);
  await h.persist('user', 'ja', ' Ja\n bitte ');
  assert.deepEqual(await h.callback([{ role: 'user', content: 'Ja  bitte' }]), h.recorded());
});

test('AIT-130 round 4 keeps a repeated utterance after a later typed turn', async t => {
  const h = await voicePromptFixture(t);
  await h.persist('user', 'ja', 'Ja');
  assert.equal((await h.route('/turns', { clientEventId: 'typed-ja', content: 'Ja',
    voiceCallId: h.grant.callId, providerSessionId: h.grant.providerSessionId })).status, 200);
  const recorded = h.recorded(), latest = { role: 'user', content: 'Ja' };
  assert.deepEqual(await h.callback([latest, latest]), [...recorded, latest]);
});

test('AIT-130 round 4 keeps a repeated utterance after a later assistant turn', async t => {
  const h = await voicePromptFixture(t);
  await h.persist('user', 'ja', 'Ja');
  await h.persist('assistant', 'question', 'Another question?');
  const latest = { role: 'user', content: 'Ja' };
  assert.deepEqual(await h.callback([...h.recorded(), latest]), [...h.recorded(), latest]);
});

test('AIT-130 round 4 includes legacy turns whose voice provenance is unknown', async t => {
  const h = await voicePromptFixture(t, h => {
    h.storage.append(h.session.id, 'turn.final', { id: 'legacy-voice', role: 'user', content: 'Ja' });
  });
  const latest = { role: 'user', content: 'Ja' };
  assert.deepEqual(await h.callback([latest]), [...h.recorded(), latest]);
});

test('AIT-130 round 4 persists server voice provenance through receipts, heard corrections and reopen', async () => {
  const path = await temporaryDb(); let storage = new SQLiteStorage(path);
  try {
    const session = storage.create(), callId = 'call', providerSessionId = 'provider';
    const spoken = { type: 'final', callId, turnId: `${providerSessionId}:user:ja`, role: 'user', text: 'Ja',
      providerSessionId: 'client-asserted-provider' };
    storage.postVoiceEvent(session.id, callId, providerSessionId, spoken);
    storage.postVoiceEvent(session.id, callId, providerSessionId, {
      type: 'final', callId, turnId: `${providerSessionId}:assistant:reply`, role: 'assistant', text: 'Heard. Unheard.' });
    storage.postVoiceEvent(session.id, callId, providerSessionId, {
      type: 'heard', callId, turnId: `${providerSessionId}:assistant:reply`, prefix: 'Heard.' });
    storage.close(); storage = new SQLiteStorage(path);
    const identity = turn => ({ callId: turn.callId, providerSessionId: turn.providerSessionId });
    const expected = { callId, providerSessionId };
    assert.deepEqual(storage.get(session.id).transcript.map(identity), [expected, expected]);
    assert.deepEqual(storage.read(session.id).filter(e => ['turn.final', 'turn.corrected'].includes(e.type))
      .map(e => identity(e.data)), [expected, expected, expected]);
    const replay = storage.postVoiceEvent(session.id, callId, providerSessionId, spoken);
    assert.equal(replay.replayed, true); assert.deepEqual(identity(replay.event.data), expected);
  } finally { storage.close(); }
});

test('AIT-130 round 4 never upgrades typed provenance when a provider echo is absorbed', async t => {
  const h = await voicePromptFixture(t);
  assert.equal((await h.route('/turns', { clientEventId: 'typed-ja', content: 'Ja',
    voiceCallId: h.grant.callId, providerSessionId: h.grant.providerSessionId })).status, 200);
  await h.persist('user', 'typed-echo', 'Ja');
  const typed = h.storage.get(h.session.id).transcript.at(-1);
  assert.equal(typed.id, 'typed-ja');
  assert.equal(typed.callId, undefined); assert.equal(typed.providerSessionId, undefined);
  const latest = { role: 'user', content: 'Ja' };
  assert.deepEqual(await h.callback([latest]), [...h.recorded(), latest]);
});

test('AIT-130 round 3 keeps a second Ja after an identical earlier reply and a delayed newest reply', async t => {
  const h = await voicePromptFixture(t);
  await h.persist('user', 'opening', 'Ask me a question');
  await h.persist('assistant', 'earlier-reply', 'Noch eine Frage?');
  await h.persist('user', 'first-ja', 'Ja');
  const recorded = h.recorded(), latest = { role: 'user', content: 'Ja' };
  const history = [...recorded, { role: 'assistant', content: 'Noch eine Frage?' }, latest];
  assert.deepEqual(await h.callback(history), [...recorded, latest]);
});

test('AIT-130 round 3 never matches an empty heard prefix to a provider reply', async t => {
  const h = await voicePromptFixture(t);
  await h.persist('assistant', 'reply', 'An entirely unheard reply');
  assert.equal((await h.route(`/voice/${h.grant.callId}/events`, { providerSessionId: h.grant.providerSessionId,
    event: { type: 'heard', callId: h.grant.callId, turnId: `${h.grant.providerSessionId}:assistant:reply`, prefix: '' } })).status, 200);
  await h.persist('user', 'first-ja', 'Ja');
  const recorded = h.recorded(), latest = { role: 'user', content: 'Ja' };
  assert.deepEqual(await h.callback([{ role: 'assistant', content: 'A different unpersisted reply' }, latest]),
    [...recorded, latest]);
});

test('AIT-130 round 3 accepts persistence while the actual voice consent check is pending', async t => {
  const h = await voicePromptFixture(t);
  await h.persist('user', 'old', 'Earlier spoken input');
  await h.persist('assistant', 'reply', 'Earlier recorded reply');
  const latest = { role: 'user', content: 'Persisted while consent is pending' }, history = [...h.recorded(), latest];
  const pending = pendingVoiceConsent(t, h), callback = h.callback(history);
  await pending.entered;
  await h.persist('user', 'new', latest.content);
  assert.equal(h.requests.length, 0, 'the voice check has not dispatched reasoning yet');
  pending.release();
  assert.deepEqual(await callback, h.recorded(), 'the newest utterance is dispatched exactly once');
});

test('AIT-130 round 3 includes a typed turn arriving between prompt build and admission', async t => {
  const h = await voicePromptFixture(t);
  await h.persist('user', 'old', 'Earlier spoken input');
  await h.persist('assistant', 'reply', 'Earlier recorded reply');
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), checkVoice = h.runtime.checkVoice;
  h.runtime.checkVoice = async (...args) => {
    await checkVoice(...args); h.runtime.checkVoice = checkVoice;
    entered.resolve(); await release.promise;
  };
  t.after(() => release.resolve());
  const latest = { role: 'user', content: 'Newest spoken input' }, callback = h.callback([...h.recorded(), latest]);
  await entered.promise;
  assert.equal((await h.route('/turns', { clientEventId: 'typed-gap', content: 'Typed in the admission gap',
    voiceCallId: h.grant.callId, providerSessionId: h.grant.providerSessionId })).status, 200);
  assert.equal(h.requests.length, 0);
  release.resolve();
  assert.deepEqual(await callback, [...h.recorded(), latest]);
});

test('AIT-130 round 3 rebuilds a heard-prefix correction arriving during the voice check', async t => {
  const h = await voicePromptFixture(t);
  await h.persist('user', 'old', 'Earlier spoken input');
  await h.persist('assistant', 'reply', 'Heard prefix. Unheard remainder.');
  const latest = { role: 'user', content: 'Barge-in during admission' };
  const pending = pendingVoiceConsent(t, h), callback = h.callback([...h.recorded(), latest]);
  await pending.entered;
  assert.equal((await h.route(`/voice/${h.grant.callId}/events`, { providerSessionId: h.grant.providerSessionId,
    event: { type: 'heard', callId: h.grant.callId, turnId: `${h.grant.providerSessionId}:assistant:reply`, prefix: 'Heard prefix.' } })).status, 200);
  pending.release();
  assert.deepEqual(await callback, [...h.recorded(), latest]);
  assert.ok(!JSON.stringify(h.requests.at(-1)).includes('Unheard remainder.'));
});

for (const withdrawal of ['turn', 'consent']) {
  test(`AIT-130 round 3 refuses ${withdrawal} withdrawal while the voice check is pending`, async t => {
    const h = await voicePromptFixture(t);
    await h.persist('user', 'private', 'Private input to withdraw');
    const pending = pendingVoiceConsent(t, h);
    const callback = h.callbackResponse([...h.recorded(), { role: 'user', content: 'Newest input' }]);
    await pending.entered;
    const response = withdrawal === 'turn'
      ? await h.route('/withdraw', { turnId: `${h.grant.providerSessionId}:user:private` })
      : await h.route('/consent', { granted: false });
    assert.equal(response.status, 200);
    pending.release();
    const refused = await callback;
    assert.notEqual(refused.status, 200);
    assert.ok(['not-admitted', 'cancelled'].includes((await refused.json()).error));
    assert.equal(h.requests.length, 0, 'withdrawn context never reaches the reasoning plugin');
    assert.equal(h.storage.db.prepare("SELECT COUNT(*) n FROM budget_attempts WHERE lane='reaction'").get().n, 0);
  });
}

test('AIT-130 voice prompt contains a long provider history only once, from the session', async t => {
  const h = await voicePromptFixture(t), history = [];
  for (let i = 0; i < 36; i++) {
    for (const role of ['user', 'assistant']) {
      const content = `${role} turn ${i}: ${'context '.repeat(130)}`;
      h.storage.postVoiceEvent(h.session.id, h.grant.callId, h.grant.providerSessionId, {
        type: 'final', callId: h.grant.callId, turnId: `${h.grant.providerSessionId}:${role}:${i}`, role, text: content });
      history.push({ role, content });
    }
  }
  const latest = { role: 'user', content: 'Newest spoken question' };
  assert.ok(Buffer.byteLength(JSON.stringify([...history, latest])) > 65_536);
  assert.deepEqual(await h.callback([...history, latest]), [...h.recorded(), latest]);
});

test('AIT-130 voice prompt never restores withdrawn history from the provider', async t => {
  const old = { role: 'user', content: 'Withdraw this private statement' };
  const h = await voicePromptFixture(t, h => {
    h.storage.postTurn(h.session.id, 'withdrawn', Buffer.from(old.content), old.content);
    h.storage.withdraw(h.session.id, 'withdrawn');
  });
  const latest = { role: 'user', content: 'Use this current statement instead' };
  const prompt = await h.callback([old, { role: 'assistant', content: 'Reply dependent on withdrawn text' }, latest]);
  assert.deepEqual(prompt, [latest]);
  assert.ok(!JSON.stringify(h.requests.at(-1)).includes(old.content));
});

for (const order of ['callback-first', 'persist-first', 'persist-during-voice-check']) {
  test(`AIT-130 voice prompt includes the newest utterance once: ${order}`, async t => {
    const h = await voicePromptFixture(t);
    await h.persist('user', 'old', 'Earlier spoken input');
    await h.persist('assistant', 'reply', 'Earlier recorded reply');
    const latest = { role: 'user', content: 'Newest not-yet-persisted utterance' }, history = [...h.recorded(), latest];
    const expected = [...h.recorded(), latest];
    const checkVoice = h.runtime.checkVoice;
    if (order === 'persist-first') await h.persist('user', 'new', latest.content);
    if (order === 'persist-during-voice-check') {
      h.runtime.checkVoice = async (...args) => {
        await checkVoice(...args);
        h.runtime.checkVoice = checkVoice;
        await h.persist('user', 'new', latest.content);
      };
    }
    assert.deepEqual(await h.callback(history), expected);
    if (order === 'callback-first') await h.persist('user', 'new', latest.content);
    h.runtime.checkVoice = checkVoice;
    assert.deepEqual(h.recorded(), expected, 'only persistEvent writes the new person turn');
  });
}

test('AIT-130 voice prompt retains typed turns and conservatively includes their provider echoes', async t => {
  const h = await voicePromptFixture(t);
  await h.persist('user', 'spoken', 'Spoken context');
  await h.persist('assistant', 'reply', 'Recorded reply');
  const typed = { role: 'user', content: 'Typed during this voice call' };
  const response = await h.route('/turns', { clientEventId: 'typed', content: typed.content,
    voiceCallId: h.grant.callId, providerSessionId: h.grant.providerSessionId });
  assert.equal(response.status, 200);
  const history = h.recorded();
  assert.deepEqual(await h.callback(history), [...history, typed], 'typed provenance cannot suppress a provider utterance');
  await h.persist('user', 'typed-echo', typed.content);
  assert.deepEqual(h.recorded(), history, 'the SDK echo also uses the saved typed turn');
  const latest = { role: 'user', content: 'Spoken after typing' };
  assert.deepEqual(await h.callback([...history, latest]), [...history, latest]);
});

test('AIT-130 voice prompt uses the recorded heard prefix and ignores provider assistant text', async t => {
  const h = await voicePromptFixture(t);
  await h.persist('user', 'spoken', 'Spoken context');
  await h.persist('assistant', 'reply', 'Heard prefix. Unheard remainder.');
  const correction = await h.route(`/voice/${h.grant.callId}/events`, { providerSessionId: h.grant.providerSessionId,
    event: { type: 'heard', callId: h.grant.callId, turnId: `${h.grant.providerSessionId}:assistant:reply`, prefix: 'Heard prefix.' } });
  assert.equal(correction.status, 200);
  const latest = { role: 'user', content: 'Barge-in question' }, recorded = h.recorded();
  const history = [recorded[0], { role: 'assistant', content: 'Heard prefix. Unheard remainder.' }, latest];
  assert.deepEqual(await h.callback(history), [...recorded, latest]);
});

test('AIT-130 voice prompt conservatively takes only the last of multiple unpersisted user messages', async t => {
  const h = await voicePromptFixture(t);
  const latest = { role: 'user', content: 'Newest person message' };
  assert.deepEqual(await h.callback([{ role: 'user', content: 'Older provider-only message' }, latest]), [latest]);
});

test('AIT-130 voice prompt does not repeat old input when provider history ends in an assistant reply', async t => {
  const h = await voicePromptFixture(t);
  await h.persist('user', 'spoken', 'Already recorded input');
  await h.persist('assistant', 'reply', 'Recorded assistant reply');
  const recorded = h.recorded();
  assert.deepEqual(await h.callback([...recorded, { role: 'assistant', content: 'Provider-only assistant text' }]), recorded);
});

test('AIT-130 voice prompt preserves a repeated answer after an intervening assistant turn', async t => {
  const h = await voicePromptFixture(t);
  await h.persist('user', 'old', 'Yes');
  await h.persist('assistant', 'reply', 'Another question');
  const latest = { role: 'user', content: 'Yes' }, recorded = h.recorded();
  assert.deepEqual(await h.callback([...recorded, latest]), [...recorded, latest]);
  await h.persist('user', 'new', latest.content);
  assert.deepEqual(await h.callback([...recorded, latest]), h.recorded());
});

test('AIT-130 voice prompt matches a persisted utterance across harmless whitespace differences', async t => {
  const h = await voicePromptFixture(t);
  await h.persist('user', 'old', 'Earlier spoken input');
  await h.persist('assistant', 'reply', 'Recorded reply');
  await h.persist('user', 'new', 'Newest   utterance\nwith spaces');
  const recorded = h.recorded();
  assert.deepEqual(await h.callback([...recorded.slice(0, -1), { role: 'user', content: ' Newest utterance with spaces ' }]), recorded);
});

test('AIT-130 voice prompt includes a repeated answer when the preceding assistant is not yet persisted', async t => {
  const h = await voicePromptFixture(t);
  await h.persist('user', 'old', 'Yes');
  const latest = { role: 'user', content: 'Yes' }, recorded = h.recorded();
  assert.deepEqual(await h.callback([...recorded, { role: 'assistant', content: 'Another question not yet recorded' }, latest]),
    [...recorded, latest]);
});

test('consent withdrawal mid-call closes provider, settles once and rejects late finals and callback auth', async t => {
  const h = voiceFixture(t), grant = await h.start(); h.advance(3000);
  assert.equal((await h.route('/consent', { granted: false })).status, 200);
  assert.equal(h.secrets.resolve(h.provisioned[0].facadeSecretRef), undefined);
  await h.handlers.idle();
  const row = h.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='voice'").get();
  assert.equal(row.state, 'settled'); assert.equal(row.outcome, 'cancelled'); assert.equal(row.settled_micro, 3000);
  const response = await h.route(`/voice/${grant.callId}/events`, { providerSessionId: grant.providerSessionId,
    event: { type: 'final', callId: grant.callId, turnId: `${grant.providerSessionId}:user:late`, role: 'user', text: 'late sensitive voice' } });
  assert.equal(response.status, 403); assert.equal(h.storage.get(h.session.id).transcript.length, 0);
});

test('withdrawing voice input removes it and its dependent replies everywhere, including receipts and export', async t => {
  const h = voiceFixture(t), grant = await h.start();
  for (const [role, id, text] of [['user', 1, 'private spoken statement'], ['assistant', 2, 'private dependent reply']]) {
    assert.equal((await h.route(`/voice/${grant.callId}/events`, { providerSessionId: grant.providerSessionId,
      event: { type: 'final', callId: grant.callId, turnId: `${grant.providerSessionId}:${role}:${id}`, role, text } })).status, 200);
  }
  const turnId = `${grant.providerSessionId}:user:1`; assert.equal((await h.route('/withdraw', { turnId })).status, 200);
  await h.handlers.idle(); assert.equal(activeTurns(h.storage.get(h.session.id)).length, 0);
  assert.ok(!JSON.stringify(h.storage.read(h.session.id)).includes('private spoken'));
  assert.ok(!h.storage.db.prepare('SELECT bytes FROM content WHERE bytes IS NOT NULL').all().some(r => r.bytes.includes('private')));
  assert.ok(!h.storage.db.prepare('SELECT result FROM receipts').all().some(r => r.result.includes('private spoken')));
});

test('all voice routes hide ownership and foreign call/provider identity with 404s', async t => {
  const h = voiceFixture(t), grant = await h.start();
  for (const action of ['pause', 'resume', 'heartbeat', 'close', 'recover', 'events']) {
    assert.equal((await h.route(`/voice/${grant.callId}/${action}`, { providerSessionId: grant.providerSessionId }, 'other-owner')).status, 404);
    assert.equal((await h.route(`/voice/${grant.callId}/${action}`, { providerSessionId: 'foreign-provider' })).status, 404);
  }
  assert.equal((await h.route('/voice', { callId: 'other' }, 'other-owner')).status, 404);
  assert.equal(h.storage.db.prepare("SELECT COUNT(*) n FROM budget_attempts WHERE lane='voice'").get().n, 1);
});

test('unknown provider closure settles at maximum and retains its uncertain terminal', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = voiceFixture(t, { unknown: true }), grant = await h.start();
  h.advance(2000); const closing = h.route(`/voice/${grant.callId}/close`, { providerSessionId: grant.providerSessionId });
  await h.waitForClosure(grant.providerSessionId); t.mock.timers.tick(10_000);
  const terminal = await closing.then(r => r.json());
  assert.equal(terminal.closureConfirmed, false); assert.equal(terminal.outcome, 'uncertain'); assert.equal(terminal.chargedMicro, 60_000);
  assert.equal(h.storage.db.prepare("SELECT settled_micro FROM budget_attempts WHERE lane='voice'").get().settled_micro, 60_000);
});

test('each reconnect admits a new duration claim, rotates facade auth and keeps call identity and absolute deadline', async t => {
  const h = voiceFixture(t), first = await h.start(), refs = [];
  let grant = first;
  for (let i = 0; i < 3; i++) {
    refs.push(h.provisioned.at(-1).facadeSecretRef);
    const response = await h.route(`/voice/${grant.callId}/recover`, { providerSessionId: grant.providerSessionId });
    assert.equal(response.status, 200); grant = await response.json();
    assert.equal(grant.callId, first.callId); assert.equal(grant.spendDeadlineAt, first.spendDeadlineAt);
    assert.equal(h.secrets.resolve(refs.at(-1)), undefined);
  }
  const nextOutage = await h.route(`/voice/${grant.callId}/recover`, { providerSessionId: grant.providerSessionId }); assert.equal(nextOutage.status, 200);
  assert.equal((await nextOutage.json()).spendDeadlineAt, first.spendDeadlineAt);
  assert.equal(h.storage.db.prepare("SELECT COUNT(*) n FROM budget_attempts WHERE lane='voice'").get().n, 5,
    'the browser controller bounds each outage; the server never imposes a lifetime reconnect quota');
});

test('voice admission fails closed on evidence, coverage, pause, and changed consent at consume without provider traffic', async t => {
  const h = voiceFixture(t);
  h.presets.best.bindings.voice.legal.evidence.model = 'other'; assert.equal((await h.route('/voice', { callId: 'bad-evidence' })).status, 403);
  h.presets.best.bindings.voice.legal.evidence.model = 'fixture-agent'; h.coverage(false);
  assert.equal((await h.route('/voice', { callId: 'bad-consent' })).status, 403); h.coverage(true);
  h.storage.pause(h.session.id, true); assert.equal((await h.route('/voice', { callId: 'paused' })).status, 403);
  h.storage.pause(h.session.id, false);
  const admitted = await h.runtime.admitVoice({ session: h.storage.get(h.session.id), request: { callId: 'consume-race' } });
  h.storage.reviseConsent(h.session.id, false);
  await assert.rejects(admitted.options.attempt.consume(), /refused/); admitted.finish();
  assert.equal(h.traffic.length, 0); assert.equal(h.storage.db.prepare("SELECT settled_micro FROM budget_attempts WHERE lane='voice'").get().settled_micro, 0);
});

test('startup recovers undispatched duration holds at zero and dispatched holds at maximum under the writer', async () => {
  const storage = new SQLiteStorage(), budget = new SQLiteBudgetLedger(storage), session = storage.create();
  try {
    const claims = [];
    for (const dispatch of [false, true]) {
      const { attemptId } = budget.admit({ sessionId: session.id, lane: 'voice', maxMicro: 50,
        requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
      const claim = budget.claim(attemptId); if (dispatch) claim.consume(); claims.push(claim);
    }
    assert.equal(budget.recover(), 2); assert.deepEqual(claims.map(c => budget.get(c.attemptId).settled_micro), [0, 50]);
    assert.equal(budget.recover(), 0);
  } finally { storage.close(); }
});

test('restart revokes callback auth, rehydrates orphan closure, reconciles costs and replays the original terminal receipt', async t => {
  const storage = new SQLiteStorage(), budget = new SQLiteBudgetLedger(storage), secrets = createFacadeSecrets();
  const session = storage.create({ ownerToken: 'restart-owner' });
  const { attemptId } = budget.admit({ sessionId: session.id, lane: 'voice', maxMicro: 100, maxVisitorMicro: 200,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const claim = budget.claim(attemptId); claim.consume(); secrets.provision('orphan-ref');
  storage.saveVoiceCall(session.id, { callId: 'orphan-call', providerSessionId: 'orphan-provider', facadeSecretRef: 'orphan-ref',
    attemptId, claimId: claim.claimId, maxMicro: 100, paused: true, pauses: [{ from: Date.now() - 2000, to: null }],
    spendDeadlineAt: Date.now() + 10_000, browserLivenessDeadlineAt: Date.now() + 5000 });
  let closed = 0;
  const runtime = createPluginRuntime({ storage, budget, consent: { coverage: () => ({ covered: false }) } });
  const handlers = createHandlers({ storage, pluginRuntime: runtime, voice: { secrets, async closeOrphan(record) {
    closed++; assert.equal(record.providerSessionId, 'orphan-provider');
    return { providerSessionId: record.providerSessionId, closureConfirmed: true,
      usage: { providerSeconds: 10, providerMinutes: 10 / 60, pausedSeconds: 2, visitorSeconds: 8, upstreamMicro: 50, visitorMicro: 80 } };
  } } });
  t.after(async () => { await handlers.close(); storage.close(); });
  await handlers.resume(); assert.equal(closed, 1); assert.equal(secrets.resolve('orphan-ref'), undefined);
  const row = budget.get(attemptId); assert.equal(row.outcome, 'uncertain'); assert.equal(row.settled_micro, 50);
  assert.equal(row.settled_visitor_micro, 80); assert.equal(JSON.parse(row.terminal_json).chargedMicro, 100);
  const saved = storage.voiceCalls()[0]; assert.equal(saved.reconciliationPending, false); assert.equal(saved.reconciliation.usage.visitorSeconds, 8);
  const response = await handlers.handle(new Request(`http://host/api/sessions/${session.id}/voice/orphan-call/close`, {
    method: 'POST', headers: { 'x-aithema-session-token': 'restart-owner' }, body: JSON.stringify({ providerSessionId: 'orphan-provider' }) }));
  assert.equal(response.status, 200); assert.equal((await response.json()).chargedMicro, 100);
  await handlers.resume(); assert.equal(closed, 1);
});

test('voice turn conflicts and invalid heard prefixes cannot replace durable content; erasure stops and fences the call', async t => {
  const h = voiceFixture(t), grant = await h.start();
  const base = { type: 'final', callId: grant.callId, turnId: `${grant.providerSessionId}:assistant:1`, role: 'assistant', text: 'Actual spoken text' };
  const send = value => h.route(`/voice/${grant.callId}/events`, { providerSessionId: grant.providerSessionId, event: value });
  assert.equal((await send(base)).status, 200); assert.equal((await send({ ...base, text: 'Different bytes' })).status, 409);
  assert.equal((await send({ type: 'heard', callId: grant.callId, turnId: base.turnId, prefix: 'Invented text' })).status, 409);
  assert.equal(h.storage.get(h.session.id).transcript[0].content, 'Actual spoken text');
  assert.equal((await h.route('/erase')).status, 200); assert.equal((await send(base)).status, 404);
  assert.equal(h.secrets.resolve(h.provisioned[0].facadeSecretRef), undefined);
  await h.handlers.idle();
  assert.equal(h.storage.db.prepare("SELECT state FROM budget_attempts WHERE lane='voice'").get().state, 'settled');
});

test('browser lease and spend expiry settle a call even while the engine is paused', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = voiceFixture(t, { leaseMs: 20 }), grant = await h.start();
  const { waitFor } = await observeVoice(h, t);
  await h.route(`/voice/${grant.callId}/pause`, { providerSessionId: grant.providerSessionId });
  h.advance(20); t.mock.timers.tick(20);
  await waitFor(e => e.type === 'voice.state' && e.data.state === 'waiting' && e.data.reason === 'browser-liveness-deadline');
  await h.handlers.idle();
  const row = h.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='voice'").get();
  assert.equal(row.state, 'settled'); assert.equal(row.outcome, 'cancelled');
  assert.equal(h.secrets.resolve(h.provisioned[0].facadeSecretRef), undefined);
});

test('visitor and provider ceilings are reserved independently and paused seconds release visitor credits', async () => {
  const storage = new SQLiteStorage(), session = storage.create(), budget = new SQLiteBudgetLedger(storage, { sessionCapMicro: 1000, visitorCapMicro: 100 });
  try {
    const { attemptId } = budget.admit({ sessionId: session.id, lane: 'voice', maxMicro: 500, maxVisitorMicro: 100,
      requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
    assert.equal(budget.canAdmit(session.id, 100, 1), false);
    const claim = budget.claim(attemptId); claim.consume();
    budget.settleVoice(claim.claimId, { attemptId, outcome: 'completed', closureConfirmed: true,
      usage: { providerSeconds: 10, providerMinutes: 10 / 60, pausedSeconds: 8, visitorSeconds: 2, upstreamMicro: 500, visitorMicro: 20 } });
    assert.equal(budget.used(session.id), 500); assert.equal(budget.visitorUsed(session.id), 20);
    assert.equal(budget.canAdmit(session.id, 100, 80), true);
  } finally { storage.close(); }
});

test('withdrawal clears a focused question and tombstones its content in replay and snapshots', () => {
  const storage = new SQLiteStorage(), session = storage.create();
  try {
    storage.postTurn(session.id, 'spoken', Buffer.from('spoken'), 'private voice input');
    storage.append(session.id, 'question.focused', { question: 'Question about private voice input?' });
    assert.equal(storage.get(session.id).focusedQuestion, 'Question about private voice input?');
    const raw = storage.db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(session.id).snapshot;
    assert.ok(!raw.includes('Question about private voice'));
    storage.withdraw(session.id, 'spoken');
    assert.equal(storage.get(session.id).focusedQuestion, null);
    assert.ok(!JSON.stringify(storage.read(session.id)).includes('Question about private voice'));
  } finally { storage.close(); }
});

// Negative assertions need one event-loop turn, never a timed delay or repeated polling.
const flush = () => new Promise(resolve => setImmediate(resolve));
async function observeVoice(h, t) {
  const controller = new AbortController(), { events: rows, record, waitFor } = eventProbe();
  const response = await h.handlers.handle(new Request(`http://host/api/sessions/${h.session.id}/events?after=${h.storage.get(h.session.id).seq}`, {
    headers: { 'x-aithema-session-token': 'voice-owner' }, signal: controller.signal }));
  const reader = response.body.getReader();
  const reading = (async () => {
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += new TextDecoder().decode(value); let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const line = block.split('\n').find(line => line.startsWith('data: '));
        if (line) record(JSON.parse(line.slice(6)));
      }
    }
  })();
  t.after(async () => { controller.abort(); await reading; });
  return { rows, waitFor };
}

for (const action of ['consent', 'host-consent', 'withdraw', 'erase', 'expiry']) {
  test(`slow closure: ${action} commits, cancels and broadcasts before the client ends`, async t => {
    const h = voiceFixture(t, { slowClosure: true }), grant = await h.start();
    h.storage.postTurn(h.session.id, 'private-turn', Buffer.from('private-turn'), 'private input');
    const { rows, waitFor } = await observeVoice(h, t), cancellations = [], cancel = h.handlers.lanes.cancel.bind(h.handlers.lanes);
    h.handlers.lanes.cancel = id => { cancellations.push(h.storage.read(id).at(-1).type); return cancel(id); };
    let response, acknowledged = false;
    const work = action === 'host-consent' ? h.handlers.withdrawConsent(h.session.id)
      : action === 'expiry' ? h.handlers.expire(Date.now() + 1000)
      : h.route('/' + action, action === 'consent' ? { granted: false } : action === 'withdraw' ? { turnId: 'private-turn' } : {});
    work.then(value => { response = value; acknowledged = true; });
    await work;
    assert.equal(acknowledged, true, 'privacy acknowledgement cannot wait for provider closure');
    if (response instanceof Response) assert.equal(response.status, 200);
    const type = action.includes('consent') ? 'consent.revised' : action === 'erase' ? 'session.erased' : 'turn.withdrawn';
    await waitFor(row => row.type === 'voice.state' && row.data.state === 'closing');
    await h.waitForClosure(grant.providerSessionId);
    assert.deepEqual(cancellations, [type], 'lane cancellation sees the committed invalidation');
    const invalidation = rows.findIndex(row => row.type === type), closing = rows.findIndex(row => row.type === 'voice.state' && row.data.state === 'closing');
    assert.ok(invalidation >= 0 && closing > invalidation, 'invalidation and closing arrive before provider closure');
    assert.equal(h.secrets.resolve(h.provisioned[0].facadeSecretRef), undefined);
    assert.equal(h.storage.db.prepare("SELECT state FROM budget_attempts WHERE lane='voice'").get().state, 'dispatched');
    assert.deepEqual(h.closeRequests, [grant.providerSessionId]);
    let idle = false; const draining = h.handlers.idle().then(() => { idle = true; }); await flush(); assert.equal(idle, false);
    h.advance(10_001); h.endClient(grant.providerSessionId); await draining; await work;
    assert.equal(h.storage.db.prepare("SELECT state FROM budget_attempts WHERE lane='voice'").get().state, 'settled');
    assert.equal(rows.filter(row => row.type === 'voice.state' && row.data.state === 'closing').length, 1);
  });
}

for (const route of ['engine', 'rail']) {
  test(`slow closure: ${route} pause needs ownership only even with lost coverage and broken provider pause`, async t => {
    const h = voiceFixture(t, { slowClosure: true }), start = h.plugin.start;
    h.plugin.start = async (...args) => { const call = await start(...args); call.pause = async () => { throw new Error('provider pause failed'); }; return call; };
    const grant = await h.start(), { rows, waitFor } = await observeVoice(h, t); h.coverage(false);
    const before = h.authChecks();
    let response;
    const work = h.route(route === 'engine' ? '/pause' : `/voice/${grant.callId}/pause`,
      route === 'engine' ? { paused: true } : { providerSessionId: grant.providerSessionId });
    work.then(value => { response = value; }); await work; assert.ok(response, 'pause acknowledgement cannot wait for closure');
    assert.equal(response.status, 200, 'pause must not fail admission');
    assert.equal(h.storage.get(h.session.id).paused, true);
    assert.equal(h.authChecks().coverageReads, before.coverageReads, 'pause must not check coverage');
    assert.equal(h.authChecks().healthReads, before.healthReads, 'pause must not check provider health');
    await waitFor(row => row.type === 'voice.state' && row.data.state === 'closing');
    assert.equal(rows.filter(row => row.type === 'session.paused' && row.data.paused).length, 1);
    assert.ok(rows.some(row => row.type === 'voice.state' && row.data.state === 'closing'));
    h.advance(10_001); h.endClient(grant.providerSessionId); await h.handlers.idle();
  });
}

test('slow closure: pause during closing records a fresh event and never re-broadcasts an old pause', async t => {
  const h = voiceFixture(t, { slowClosure: true }), grant = await h.start(), identity = { providerSessionId: grant.providerSessionId };
  await h.route('/pause', { paused: true }); await h.route('/pause', { paused: false });
  const { rows, waitFor } = await observeVoice(h, t), closing = h.route(`/voice/${grant.callId}/close`, identity);
  await waitFor(row => row.type === 'voice.state' && row.data.state === 'closing');
  const before = h.storage.get(h.session.id).seq;
  let response; const work = h.route('/pause', { paused: true }); work.then(value => { response = value; });
  await work; assert.ok(response, 'pause cannot await an already closing provider'); assert.equal(response.status, 200);
  await waitFor(row => row.type === 'session.paused' && row.seq > before);
  const pauses = rows.filter(row => row.type === 'session.paused');
  assert.equal(pauses.length, 1); assert.ok(pauses[0].seq > before); assert.equal(h.storage.get(h.session.id).paused, true);
  h.advance(10_001); h.endClient(grant.providerSessionId); await closing;
});

test('slow closure: unauthenticated facade calls never check authorization or close the call', async t => {
  const h = voiceFixture(t, { slowClosure: true }), grant = await h.start(), ref = h.provisioned[0].facadeSecretRef;
  h.coverage(false); const before = h.authChecks();
  for (const authorization of [undefined, 'Bearer wrong']) {
    let response;
    const work = h.handlers.handle(new Request(`https://facade.test/api/voice/${grant.callId}/llm/chat/completions`, {
      method: 'POST', headers: authorization ? { authorization } : {}, body: JSON.stringify({ aithema_call: grant.callId, messages: [{ role: 'user', content: 'hello' }] }) }));
    work.then(value => { response = value; }); await work;
    assert.ok(response); assert.equal(response.status, 401);
    assert.deepEqual(h.authChecks(), before); assert.ok(h.secrets.resolve(ref)); assert.equal(h.closeRequests.length, 0);
  }
  const authorized = await h.handlers.handle(new Request(`https://facade.test/api/voice/${grant.callId}/llm/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${h.secrets.resolve(ref)}` },
    body: JSON.stringify({ aithema_call: grant.callId, messages: [{ role: 'user', content: 'hello' }] }) }));
  assert.equal(authorized.status, 403);
});

test('slow closure: recovery admits immediately while the old provider needs more than ten seconds to confirm closure', async t => {
  const h = voiceFixture(t, { slowClosure: true }), first = await h.start(), ref = h.provisioned[0].facadeSecretRef;
  h.advance(5000); let response;
  const work = h.route(`/voice/${first.callId}/recover`, { providerSessionId: first.providerSessionId });
  work.then(value => { response = value; }); await work;
  assert.ok(response, 'new credential must be available before old closure'); assert.equal(response.status, 200);
  const next = await response.json(); assert.notEqual(next.providerSessionId, first.providerSessionId);
  assert.equal(next.spendDeadlineAt, first.spendDeadlineAt); assert.equal(h.secrets.resolve(ref), undefined);
  assert.deepEqual(h.closeRequests, [first.providerSessionId]);
  const claims = h.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='voice'").all();
  assert.equal(claims.length, 2); assert.ok(claims.every(row => row.state === 'dispatched'));
  assert.equal(claims[1].max_visitor_micro, 110_000, 'reserve only the remaining 55 seconds');
  await h.waitForClosure(first.providerSessionId);
  h.advance(10_001); h.endClient(first.providerSessionId); await work; await h.handlers.idle();
  assert.equal(h.storage.db.prepare("SELECT state FROM budget_attempts WHERE attempt_id=?").get(claims[0].attempt_id).state, 'settled');
  assert.equal((await h.route(`/voice/${next.callId}/heartbeat`, { providerSessionId: next.providerSessionId })).status, 200, 'old settlement cannot remove the new call');
});

test('slow closure: each typed turn absorbs one provider echo and later repeated speech stays durable', async t => {
  const h = voiceFixture(t, { slowClosure: true }), grant = await h.start();
  const response = await h.route('/turns', { clientEventId: 'typed-1', content: 'yes', voiceCallId: grant.callId, providerSessionId: grant.providerSessionId });
  assert.equal(response.status, 200); const typed = await response.json();
  const { rows, waitFor } = await observeVoice(h, t);
  const echo = { type: 'final', callId: grant.callId, turnId: `${grant.providerSessionId}:user:echo`, role: 'user', text: typed.data.content };
  const spokenId = `${grant.providerSessionId}:user:spoken-again`;
  for (const turnId of [echo.turnId, echo.turnId, spokenId]) {
    const acknowledged = await h.route(`/voice/${grant.callId}/events`, { providerSessionId: grant.providerSessionId, event: { ...echo, turnId } });
    assert.equal(acknowledged.status, 200); assert.equal((await acknowledged.json()).data.id, turnId === spokenId ? spokenId : 'typed-1');
  }
  await waitFor(e => e.type === 'turn.final' && e.data.id === spokenId);
  await h.handlers.idle();
  assert.deepEqual(h.storage.get(h.session.id).transcript.filter(t => t.role === 'user').map(t => t.content), ['yes', 'yes']);
  assert.equal(h.storage.read(h.session.id).filter(e => e.type === 'turn.final' && e.data.role === 'user').length, 2);
  assert.equal(rows.filter(e => e.type === 'turn.final' && e.data.role === 'user').length, 1, 'only the unabsorbed speech publishes');
  assert.equal(h.storage.get(h.session.id).understanding.inputRevision, inputRevision(h.storage.get(h.session.id)), 'unabsorbed speech reaches understanding');
  const exported = await h.handlers.handle(new Request(`http://host/api/sessions/${h.session.id}/export`, { headers: { 'x-aithema-session-token': 'voice-owner' } }));
  assert.equal(JSON.parse(unzip(await exported.arrayBuffer())['transcript.json']).turns.filter(t => t.role === 'user').length, 2);
});

test('typed echoes consume the oldest matching turn once, normalize whitespace and survive reopen', async () => {
  const path = await temporaryDb(); let storage = new SQLiteStorage(path);
  try {
    const session = storage.create(), guard = { voiceCallId: 'call', voiceProviderId: 'provider' };
    for (const clientId of ['oldest', 'newest']) storage.postTurn(session.id, clientId, Buffer.from(clientId), ' yes\t please ', guard);
    const event = turnId => ({ type: 'final', callId: 'call', turnId: `provider:user:${turnId}`, role: 'user', text: 'yes  please' });
    const first = storage.postVoiceEvent(session.id, 'call', 'provider', event('1'));
    assert.equal(first.event.data.id, 'oldest'); assert.equal(first.replayed, true);
    storage.close(); storage = new SQLiteStorage(path);
    assert.equal(storage.postVoiceEvent(session.id, 'call', 'provider', event('1')).event.data.id, 'oldest', 'redelivery does not consume another typed turn');
    assert.equal(storage.postVoiceEvent(session.id, 'call', 'provider', event('2')).event.data.id, 'newest');
    assert.equal(storage.postVoiceEvent(session.id, 'call', 'provider', event('3')).replayed, false);
    assert.equal(storage.get(session.id).transcript.filter(t => t.role === 'user').length, 3);
  } finally { storage.close(); }
});

test('slow closure: typing falls back to a durable plain turn while its owned call is closing', async t => {
  const h = voiceFixture(t, { slowClosure: true }), grant = await h.start();
  const closing = h.route(`/voice/${grant.callId}/close`, { providerSessionId: grant.providerSessionId });
  await h.waitForClosure(grant.providerSessionId);
  const body = { clientEventId: 'typed-closing', content: 'Continue in text', voiceCallId: grant.callId, providerSessionId: grant.providerSessionId };
  assert.equal((await h.route('/turns', { ...body, providerSessionId: 'wrong-provider' })).status, 404);
  const response = await h.route('/turns', body); assert.equal(response.status, 200);
  const turn = (await response.json()).data;
  assert.equal(turn.content, body.content); assert.equal(turn.voiceCallId, undefined);
  assert.equal(h.storage.get(h.session.id).transcript.filter(t => t.role === 'user').length, 1);
  h.endClient(grant.providerSessionId); await closing;
});

test('understanding publishes focused-question changes once, including clearing the last open question', async t => {
  let questions = ['Which systems?', 'Which data?'], calls = 0;
  const mock = createMockReasoning(), reasoning = { ...mock, async structured(...args) {
    calls++; return { ...await mock.structured(...args), openQuestions: questions };
  } };
  const h = voiceFixture(t, { reasoning }), { rows, waitFor } = await observeVoice(h, t);
  for (const [index, next] of [['first', questions], ['same', questions], ['changed', ['Which data?']], ['cleared', []]]) {
    questions = next;
    assert.equal((await h.route('/turns', { clientEventId: index, content: index })).status, 200);
    await h.handlers.idle();
    const session = h.storage.get(h.session.id);
    assert.equal(session.focusedQuestion, next[0] ?? null);
    assert.equal(session.understanding.inputRevision, inputRevision(session), 'derived focus does not invalidate its understanding');
  }
  await waitFor(e => e.type === 'question.focused' && e.data.question === null);
  assert.deepEqual(rows.filter(e => e.type === 'question.focused').map(e => e.data.question), ['Which systems?', 'Which data?', null]);
  assert.equal(calls, 4, 'focus updates do not spend on redundant understanding calls');
});

test('slow closure: concurrent closes publish each transition once and prune the active call after settlement', async t => {
  const h = voiceFixture(t, { slowClosure: true }), grant = await h.start(), { rows, waitFor } = await observeVoice(h, t);
  const identity = { providerSessionId: grant.providerSessionId };
  const closes = [h.route(`/voice/${grant.callId}/close`, identity), h.route(`/voice/${grant.callId}/close`, identity)];
  await waitFor(row => row.type === 'voice.state' && row.data.state === 'closing');
  h.advance(10_001); h.endClient(grant.providerSessionId);
  const terminals = await Promise.all(closes.map(async work => (await work).json())); assert.deepEqual(terminals[0], terminals[1]);
  await waitFor(row => row.type === 'voice.state' && row.data.state === 'ended');
  assert.equal(rows.filter(row => row.type === 'voice.state' && row.data.state === 'closing').length, 1);
  assert.equal(rows.filter(row => row.type === 'voice.state' && row.data.state === 'ended').length, 1);
  assert.equal((await h.route(`/voice/${grant.callId}/heartbeat`, identity)).status, 404, 'settled call is no longer in the active calls map');
  assert.deepEqual(await h.route(`/voice/${grant.callId}/close`, identity).then(r => r.json()), terminals[0], 'durable terminal remains replayable');
});

test('heard-prefix invalidation removes the unheard suffix from a file-backed WAL', async t => {
  const path = await temporaryDb(), h = voiceFixture(t, { path, slowClosure: true }), grant = await h.start();
  const turnId = `${grant.providerSessionId}:assistant:1`, suffix = 'unique-unheard-sensitive-suffix-ait101';
  const send = event => h.route(`/voice/${grant.callId}/events`, { providerSessionId: grant.providerSessionId, event: { callId: grant.callId, turnId, ...event } });
  assert.equal((await send({ type: 'final', role: 'assistant', text: `Heard. ${suffix}` })).status, 200);
  assert.ok((await readFile(path + '-wal')).includes(Buffer.from(suffix)));
  assert.equal((await send({ type: 'heard', prefix: 'Heard.' })).status, 200);
  assert.ok(!(await readFile(path + '-wal')).includes(Buffer.from(suffix)), 'checkpoint must truncate superseded WAL content');
});

test('assistant voice finals retain facade-produced or browser-asserted provenance in snapshots, replay and export', async t => {
  const h = voiceFixture(t, { slowClosure: true }), grant = await h.start(), secret = h.secrets.resolve(h.provisioned[0].facadeSecretRef);
  const completion = await h.handlers.handle(new Request(`https://facade.test/api/voice/${grant.callId}/llm/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ aithema_call: grant.callId, messages: [{ role: 'user', content: 'Hello' }] }) }));
  const completed = await completion.json(), produced = completed.choices[0].message.content;
  // A transcript callback must use the completion's producer, even if the
  // runtime's next reaction would use a different binding.
  h.presets.best.bindings.reaction = { ...h.presets.best.bindings.reaction, model: 'next-model' };
  for (const [index, text] of [produced, 'Browser invented assistant speech'].entries()) {
    const response = await h.route(`/voice/${grant.callId}/events`, { providerSessionId: grant.providerSessionId,
      event: { type: 'final', callId: grant.callId, turnId: `${grant.providerSessionId}:assistant:${index}`, role: 'assistant', text,
        ...(index === 0 ? { replyId: completed.id } : {}), provenance: 'facade-produced' } });
    assert.equal(response.status, 200);
  }
  const snapshot = await h.handlers.handle(new Request(`http://host/api/sessions/${h.session.id}`, { headers: { 'x-aithema-session-token': 'voice-owner' } })).then(r => r.json());
  assert.deepEqual(snapshot.transcript.map(t => t.provenance), ['facade-produced', 'browser-asserted']);
  for (const [index, turn] of snapshot.transcript.entries()) {
    assert.equal(turn.origin, 'ai-generated'); assert.equal(turn.model, index ? 'fixture-agent' : 'mock');
    assert.equal(turn.provider, index ? 'elevenlabs' : 'mock');
  }
  assert.deepEqual(h.storage.read(h.session.id).filter(e => e.type === 'turn.final').map(e => e.data.provenance), ['facade-produced', 'browser-asserted']);
  assert.deepEqual(h.storage.read(h.session.id).filter(e => e.type === 'turn.final').map(e => e.data.origin), ['ai-generated', 'ai-generated']);
  const exported = await h.handlers.handle(new Request(`http://host/api/sessions/${h.session.id}/export`, { headers: { 'x-aithema-session-token': 'voice-owner' } }));
  const files = unzip(await exported.arrayBuffer());
  assert.match(files['transcript.md'], /assistant \(browser-asserted\) \(AI-generated\)/);
  assert.deepEqual(JSON.parse(files['transcript.json']).turns.map(t => [t.origin, t.model, t.provider]),
    [['ai-generated', 'mock', 'mock'], ['ai-generated', 'fixture-agent', 'elevenlabs']]);
  const correction = await h.route(`/voice/${grant.callId}/events`, { providerSessionId: grant.providerSessionId,
    event: { type: 'heard', callId: grant.callId, turnId: `${grant.providerSessionId}:assistant:0`, prefix: produced.slice(0, 3) } });
  const corrected = (await correction.json()).data;
  assert.equal(corrected.origin, 'ai-generated'); assert.equal(corrected.model, 'mock'); assert.equal(corrected.provider, 'mock');
  const original = h.storage.read(h.session.id).find(e => e.type === 'turn.final' && e.data.id === corrected.id).data;
  assert.equal(original.erased, true);
  for (const key of ['origin', 'model', 'provider', 'engine']) assert.equal(Object.hasOwn(original, key), false);
});

test('slow closure: recovery reserves remaining visitor duration after previously settled usage', async t => {
  const h = voiceFixture(t, { slowClosure: true }), first = await h.start();
  h.runtime.budget.visitorCapMicro = 121_000;
  const closing = h.route(`/voice/${first.callId}/close`, { providerSessionId: first.providerSessionId, reason: 'transport-lost' });
  await h.waitForClosure(first.providerSessionId); h.advance(15_000); h.endClient(first.providerSessionId); await closing;
  const response = await h.route(`/voice/${first.callId}/recover`, { providerSessionId: first.providerSessionId });
  assert.equal(response.status, 200, '30k spent plus 90k remaining fits the visitor cap');
  const claims = h.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='voice'").all();
  assert.equal(claims[1].max_visitor_micro, 90_000);
});

test('slow closure: engine pause records a new event even when the provider acknowledges without an event', async t => {
  const h = voiceFixture(t, { slowClosure: true }), start = h.plugin.start;
  h.plugin.start = async (...args) => { const call = await start(...args); call.pause = async () => ({ acknowledged: true, paused: true }); return call; };
  await h.start(); h.storage.pause(h.session.id, true); h.storage.pause(h.session.id, false);
  const before = h.storage.get(h.session.id).seq, { rows, waitFor } = await observeVoice(h, t);
  const response = await h.route('/pause', { paused: true }); assert.equal(response.status, 200);
  const ack = await response.json(); assert.equal(ack.paused, true); assert.ok(ack.event.seq > before);
  await waitFor(e => e.type === 'session.paused' && e.seq === ack.event.seq);
  assert.deepEqual(rows.filter(e => e.type === 'session.paused').map(e => e.seq), [ack.event.seq]);
});

test('slow closure: browser lease expiry publishes waiting before the segment settles', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = voiceFixture(t, { slowClosure: true, leaseMs: 20 }), grant = await h.start(), { rows, waitFor } = await observeVoice(h, t);
  h.advance(20); t.mock.timers.tick(20);
  await waitFor(e => e.type === 'voice.state' && e.data.state === 'waiting' && e.data.reason === 'browser-liveness-deadline');
  assert.equal(h.secrets.resolve(h.provisioned[0].facadeSecretRef), undefined);
  assert.ok(rows.some(e => e.type === 'voice.state' && e.data.state === 'waiting' && e.data.reason === 'browser-liveness-deadline'));
  assert.equal(h.storage.db.prepare("SELECT state FROM budget_attempts WHERE lane='voice'").get().state, 'dispatched');
  h.advance(10_001); h.endClient(grant.providerSessionId); await h.handlers.idle();
});

test('public server index does not export the local voice legal-check bypass', async () => {
  const api = await import('../src/index.js'); assert.equal(api.createLocalVoiceProvider, undefined);
});

test('slow closure: invalidation during startup keeps settlement tracked until the late call closes', async t => {
  const h = voiceFixture(t, { slowClosure: true }), start = h.plugin.start;
  let call, release; const ready = new Promise(resolve => { release = resolve; }), entered = Promise.withResolvers();
  h.plugin.start = async (...args) => { call = await start(...args); entered.resolve(); await ready; return call; };
  const startup = h.route('/voice', { callId: 'late-start' }); await entered.promise; assert.ok(call);
  try {
    assert.equal((await h.route('/consent', { granted: false })).status, 200);
    assert.equal(h.secrets.resolve(h.provisioned[0].facadeSecretRef), undefined);
    let idle = false; const draining = h.handlers.idle().then(() => { idle = true; }); await flush();
    assert.equal(idle, false, 'a dispatched startup is still awaiting provider settlement');
    h.advance(10_001); h.endClient(call.providerSessionId); release(); await startup; await draining;
    assert.equal(h.storage.db.prepare("SELECT state FROM budget_attempts WHERE lane='voice'").get().state, 'settled');
    assert.equal(h.storage.db.prepare("SELECT outcome FROM budget_attempts WHERE lane='voice'").get().outcome, 'cancelled');
  } finally { h.endClient(call.providerSessionId); release(); await startup; }
});

test('slow closure: a failed recovery admission can retry before the original provider settles', async t => {
  const h = voiceFixture(t, { slowClosure: true }), first = await h.start(), start = h.plugin.start;
  let starts = 0;
  h.plugin.start = (...args) => { if (++starts === 1) throw new PluginError('unavailable'); return start(...args); };
  const identity = { providerSessionId: first.providerSessionId };
  assert.equal((await h.route(`/voice/${first.callId}/recover`, identity)).status, 502);
  await h.waitForClosure(first.providerSessionId);
  assert.equal(h.storage.voiceCalls(h.session.id)[0].terminal, undefined, 'original closure is still pending');
  const response = await h.route(`/voice/${first.callId}/recover`, identity);
  assert.equal(response.status, 200, 'retry must not depend on the pending old terminal');
  const next = await response.json(); assert.notEqual(next.providerSessionId, first.providerSessionId);
  h.advance(10_001); h.endClient(first.providerSessionId);
});

test('slow closure: recovery retries the original identity after a new SDK connection fails and closes', async t => {
  const h = voiceFixture(t, { slowClosure: true }), original = await h.start();
  const recover = () => h.route(`/voice/${original.callId}/recover`, { providerSessionId: original.providerSessionId });
  const first = await recover().then(r => r.json());
  const closing = h.route(`/voice/${first.callId}/close`, { providerSessionId: first.providerSessionId, reason: 'recovery-failed' });
  await h.waitForClosure(first.providerSessionId);
  const response = await recover(); assert.equal(response.status, 200);
  const next = await response.json(); assert.notEqual(next.providerSessionId, first.providerSessionId, 'a closing credential cannot be reused');
  assert.equal(h.storage.db.prepare("SELECT COUNT(*) n FROM budget_attempts WHERE lane='voice' AND state='dispatched'").get().n, 3);
  h.advance(10_001); h.endClient(original.providerSessionId); h.endClient(first.providerSessionId); await closing;
});


// AIT-137 probes count the actual admission, dispatch and durable cost separately.
async function turnsOnceFixture(t, { voiceOptions, path, blocked = false, blockedModel = 1, failFirst = false, lateFirst = false, sameReply = false } = {}) {
  const base = createMockReasoning(), started = Promise.withResolvers(), release = Promise.withResolvers(), modelEvents = eventProbe();
  let models = 0, admissions = 0, finalOrdinal = 0, lateReport;
  const diagnostics = [], requests = [], dispatches = [];
  t.after(() => release.resolve());
  const h = voiceFixture(t, { path, voiceOptions: { log: entry => diagnostics.push(entry), ...voiceOptions }, reasoning: { ...base, async *stream(request, options) {
    await options.attempt.consume();
    const number = ++models;
    requests.push(request);
    dispatches.push(options.attempt.attemptId);
    modelEvents.record(number);
    if (number === 1) started.resolve();
    if (number === 1 && failFirst) {
      options.report({ attemptId: options.attempt.attemptId, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 }, chargedMicro: 0 });
      throw new PluginError('provider');
    }
    yield sameReply ? 'Same reply' : `Reply ${number}`;
    if (blocked && number === blockedModel || number === 1 && lateFirst) await release.promise;
    if (number === 1 && lateFirst) lateReport = () => options.report({ attemptId: options.attempt.attemptId,
      outcome: 'completed', usage: { inputTokens: 3, outputTokens: 2 }, chargedMicro: 17 });
    else options.report({ attemptId: options.attempt.attemptId, outcome: 'completed', usage: { inputTokens: 3, outputTokens: 2 }, chargedMicro: 17 });
    yield ' finished';
  }, async structured(request, options) {
    return { ...await base.structured(request, options), openQuestions: [] };
  } } });
  const admit = h.runtime.admit;
  h.runtime.admit = async args => { if (args.lane === 'reaction') admissions++; return admit(args); };
  const grant = await h.start(), secret = h.secrets.resolve(h.provisioned[0].facadeSecretRef);
  const callback = (messages = [{ role: 'user', content: 'Ja' }], { signal, ...extra } = {}) => h.handlers.handle(new Request(
    `https://facade.test/api/voice/${grant.callId}/llm/chat/completions`, {
      method: 'POST', signal, headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ aithema_call: grant.callId, messages, ...extra }) }));
  const persist = async (role, id, text, identity = {}) => {
    const response = await h.route(`/voice/${grant.callId}/events`, { providerSessionId: grant.providerSessionId,
      event: { type: 'final', callId: grant.callId, turnId: `${grant.providerSessionId}:${role}:${id}`, role, text,
        ...(role === 'user' ? { userTurnOrdinal: ++finalOrdinal } : {}), ...identity } });
    assert.equal(response.status, 200); return response.json();
  };
  const rows = () => h.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='reaction'").all();
  return { ...h, grant, callback, persist, rows, started: started.promise, release: () => release.resolve(),
    diagnostics, requests, dispatches, waitForModel: number => modelEvents.waitFor(value => value === number),
    counts: () => ({ admissions, models, cost: rows().reduce((sum, row) => sum + (row.settled_micro ?? 0), 0) }),
    reportLate: () => lateReport?.() };
}
const completionText = async response => {
  assert.equal(response.status, 200);
  return (await response.json()).choices[0].message.content;
};
const sseReply = text => text.split('\n\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
  .map(frame => frame.choices?.[0].delta?.content ?? '').join('');

test('AIT-138: transport recovery preserves paid generation work; repeated input in the successor is a new operation', async t => {
  const h = await turnsOnceFixture(t, { blocked: true }), messages = [{ role: 'user', content: 'Accepted input' }];
  const first = await h.callback(messages, { stream: true }), oldReply = first.text();
  await h.started;
  const admitted = h.storage.voiceOperations(h.session.id)[0];
  const response = await h.route(`/voice/${h.grant.callId}/recover`, { providerSessionId: h.grant.providerSessionId });
  assert.equal(response.status, 200); const next = await response.json();
  const nextSecret = h.secrets.resolve(h.provisioned.at(-1).facadeSecretRef);
  const newer = await h.handlers.handle(new Request(`https://facade.test/api/voice/${next.callId}/llm/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${nextSecret}` },
    body: JSON.stringify({ aithema_call: next.callId, messages }),
  }));
  assert.equal(await completionText(newer), 'Reply 2 finished');
  h.release(); const text = await oldReply;
  assert.doesNotMatch(text, /"error"/u, 'transport loss must not cancel already paid work');
  assert.equal(sseReply(text), 'Reply 1 finished');
  const operations = h.storage.voiceOperations(h.session.id);
  assert.equal(operations.length, 2); assert.equal(operations[0].key, admitted.key); assert.equal(operations[0].fence, admitted.fence);
  assert.ok(operations.every(operation => operation.state === 'completed'));
  assert.notEqual(operations[0].key, operations[1].key); assert.notEqual(operations[0].providerSessionId, operations[1].providerSessionId);
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 }, 'each generation charges once; no receipt aliasing');
});

for (const order of ['callback-first', 'persist-first', 'persist-during-admission']) {
  test(`AIT-137 receipt timing leaves callback retry identity unchanged: ${order}`, async t => {
    const h = await turnsOnceFixture(t), messages = [{ role: 'user', content: 'Ja' }];
    if (order === 'persist-first') await h.persist('user', 'ja', 'Ja');
    if (order === 'persist-during-admission') {
      const check = h.runtime.checkVoice;
      h.runtime.checkVoice = async (...args) => { h.runtime.checkVoice = check; await check(...args); await h.persist('user', 'ja', 'Ja'); };
    }
    const first = await completionText(await h.callback(messages));
    if (order === 'callback-first') await h.persist('user', 'ja', 'Ja');
    assert.equal(await completionText(await h.callback(messages)), first);
    assert.deepEqual(h.counts(), { admissions: 1, models: 1, cost: 17 });
    const operations = h.storage.voiceOperations(h.session.id);
    assert.equal(operations.length, 1); assert.equal(operations[0].state, 'completed');
    assert.equal(operations[0].ordinal, 1);
    assert.equal(operations[0].turnId, undefined, 'transcript receipts do not bind operations');
  });
}

for (const count of [2, 3]) {
  test(`AIT-137 ${count} concurrent callbacks share admission, streamed reply and cost`, async t => {
    const h = await turnsOnceFixture(t, { blocked: true });
    const pending = Array.from({ length: count }, () => h.callback(undefined, { stream: true }));
    await h.started;
    const responses = await Promise.all(pending), readers = responses.map(response => response.text());
    h.release();
    const replies = await Promise.all(readers);
    assert.deepEqual(replies.map(sseReply), Array(count).fill('Reply 1 finished'));
    assert.ok(replies.every(text => text.endsWith('data: [DONE]\n\n')));
    assert.deepEqual(h.counts(), { admissions: 1, models: 1, cost: 17 });
  });
}

test('AIT-137 completion retry replays the same response identity without another paid call', async t => {
  const h = await turnsOnceFixture(t);
  const first = await (await h.callback()).json(), second = await (await h.callback()).json();
  assert.deepEqual(second, first);
  assert.deepEqual(h.counts(), { admissions: 1, models: 1, cost: 17 });
});

test('AIT-137 the configurable replay window expires without a fresh admission', async t => {
  const h = await turnsOnceFixture(t, { voiceOptions: { turnReplayWindowMs: 2000 } });
  await completionText(await h.callback()); h.advance(2001);
  const response = await h.callback();
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'not-admitted', reason: 'voice-turn-replay-expired' });
  assert.deepEqual(h.counts(), { admissions: 1, models: 1, cost: 17 });
});

test('AIT-137 failure retry needs explicit host authorization and records one concurrent replacement', async t => {
  let authorized = false, authorizations = 0;
  const h = await turnsOnceFixture(t, { failFirst: true, voiceOptions: { authorizeTurnReplacement: ({ operation }) => {
    authorizations++; assert.equal(operation.state, 'failed'); return authorized;
  } } });
  assert.equal((await h.callback()).status, 502);
  const refused = await h.callback(); assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: 'not-admitted', reason: 'voice-turn-replacement-required' });
  assert.deepEqual(h.counts(), { admissions: 1, models: 1, cost: 0 });
  authorized = true;
  assert.deepEqual(await Promise.all([h.callback(), h.callback(), h.callback()].map(async response => completionText(await response))),
    Array(3).fill('Reply 2 finished'));
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 17 });
  const [operation] = h.storage.voiceOperations(h.session.id);
  assert.equal(operation.attempts.length, 2); assert.equal(operation.attempts[1].replaces, operation.attempts[0].id);
  assert.ok(authorizations >= 2);
});

test('AIT-137 a timed-out old result and report are fenced after an authorized replacement', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const h = await turnsOnceFixture(t, { lateFirst: true, voiceOptions: { turnTimeoutMs: 40, authorizeTurnReplacement: () => true } });
  const first = await h.callback(undefined, { stream: true }), text = first.text();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(40); h.advance(40);
  assert.ok((await text).includes('"error":"deadline"'));
  const replacement = await completionText(await h.callback()); assert.equal(replacement, 'Reply 2 finished');
  h.release(); await new Promise(resolve => setImmediate(resolve));
  assert.doesNotThrow(() => h.reportLate());
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 17 });
  assert.equal(await completionText(await h.callback()), replacement);
  assert.equal(h.storage.voiceOperations(h.session.id)[0].state, 'completed');
});

test('AIT-137 repeated Ja after another question uses a new turn identity', async t => {
  const h = await turnsOnceFixture(t), first = [{ role: 'user', content: 'Ja', id: 'first-ja' }];
  await h.persist('user', 'first-ja', 'Ja'); await completionText(await h.callback(first));
  await h.persist('assistant', 'question', 'Another question'); await h.persist('user', 'second-ja', 'Ja');
  const second = [...first, { role: 'assistant', content: 'Another question' }, { role: 'user', content: 'Ja', id: 'second-ja' }];
  assert.equal(await completionText(await h.callback(second)), 'Reply 2 finished');
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
  const operations = h.storage.voiceOperations(h.session.id);
  assert.equal(operations.length, 2); assert.notEqual(operations[0].key, operations[1].key);
});

test('AIT-137 a known callback overtaken before admission is obsolete and costs nothing', async t => {
  const h = await turnsOnceFixture(t), entered = Promise.withResolvers(), resume = Promise.withResolvers();
  t.after(() => resume.resolve());
  const a = { role: 'user', content: 'Older input' }, b = { role: 'user', content: 'Newest input' };
  const check = h.runtime.checkVoice;
  h.runtime.checkVoice = async (...args) => {
    h.runtime.checkVoice = check; await check(...args); entered.resolve(); await resume.promise;
  };
  const older = h.callback([a]); await entered.promise;
  assert.equal(await completionText(await h.callback([a, b])), 'Reply 1 finished');
  resume.resolve(); const response = await older;
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'not-admitted', reason: 'voice-turn-obsolete' });
  assert.deepEqual(h.counts(), { admissions: 1, models: 1, cost: 17 });
});

test('AIT-137 an admitted completed key still replays after a newer turn', async t => {
  const h = await turnsOnceFixture(t), old = [{ role: 'user', content: 'Old input' }];
  assert.equal(await completionText(await h.callback(old)), 'Reply 1 finished');
  await h.persist('user', 'new', 'New input');
  assert.equal(await completionText(await h.callback([...old, { role: 'user', content: 'New input' }])), 'Reply 2 finished');
  assert.equal(await completionText(await h.callback(old)), 'Reply 1 finished');
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
});

test('AIT-137 a disconnected follower leaves the shared operation available to a retry', async t => {
  const h = await turnsOnceFixture(t, { blocked: true });
  const first = await h.callback(undefined, { stream: true }), second = await h.callback(undefined, { stream: true });
  await first.body.cancel(); const text = second.text(); h.release();
  assert.equal(sseReply(await text), 'Reply 1 finished');
  assert.equal(await completionText(await h.callback()), 'Reply 1 finished');
  assert.deepEqual(h.counts(), { admissions: 1, models: 1, cost: 17 });
});

test('AIT-137 restart keeps a pending operation fenced until explicit replacement authorization', async t => {
  const { createVoiceTurnOperations } = await import('../src/voice-turns.js');
  const path = await temporaryDb();
  let storage = new SQLiteStorage(path), calls = 0;
  const session = storage.create({ ownerToken: 'restart-owner' });
  const context = { sessionId: session.id, callId: 'restart-call', providerSessionId: 'restart-provider',
    messages: [{ role: 'user', content: 'Restart input' }] };
  const key = storage.claimVoiceOperation(context, { now: 1000 }).operation.key;
  storage.close(); storage = new SQLiteStorage(path); t.after(() => storage.close());
  const turns = createVoiceTurnOperations({ storage, now: () => 1001 });
  await assert.rejects(turns.run(context, () => { calls++; return Response.json({}); }),
    error => error.code === 'not-admitted' && error.message === 'voice-turn-replacement-required');
  assert.equal(calls, 0); assert.equal(storage.voiceOperations(session.id)[0].key, key);
  assert.equal(storage.voiceOperations(session.id)[0].state, 'failed');
});


test('AIT-137 changed callback turn metadata creates another operation', async t => {
  const h = await turnsOnceFixture(t), messages = [{ role: 'user', content: 'Ja', message_id: 'message-1' }];
  assert.equal(await completionText(await h.callback(messages, { turn_id: 'turn-1' })), 'Reply 1 finished');
  assert.equal(await completionText(await h.callback(messages)), 'Reply 2 finished');
  assert.equal(await completionText(await h.callback(messages)), 'Reply 2 finished');
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
});

test('AIT-137 repeated Ja bodies remain separate and the older paid answer replays', async t => {
  const h = await turnsOnceFixture(t), old = [{ role: 'user', content: 'Ja' }];
  await h.persist('user', 'first-ja', 'Ja'); await completionText(await h.callback(old));
  await h.persist('assistant', 'question', 'Another question'); await h.persist('user', 'second-ja', 'Ja');
  const current = [...old, { role: 'assistant', content: 'Another question' }, { role: 'user', content: 'Ja' }];
  assert.equal(await completionText(await h.callback(current)), 'Reply 2 finished');
  assert.equal(await completionText(await h.callback(old)), 'Reply 1 finished');
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
});

test('AIT-137 restart preserves uncertain spend and permits exactly one authorized replacement and durable replay', async t => {
  const { createVoiceTurnOperations } = await import('../src/voice-turns.js');
  const path = await temporaryDb();
  let storage = new SQLiteStorage(path), budget = new SQLiteBudgetLedger(storage), models = 1;
  const session = storage.create({ ownerToken: 'restart-owner' });
  const context = { sessionId: session.id, callId: 'restart-call', providerSessionId: 'restart-provider',
    messages: [{ role: 'user', content: 'Restart input' }] };
  const admission = () => budget.admit({ sessionId: session.id, lane: 'reaction', maxMicro: 50,
    requestSha256: '0'.repeat(64), bindingSha256: '1'.repeat(64) });
  const { operation } = storage.claimVoiceOperation(context, { now: 1000 });
  const old = budget.claim(admission().attemptId); old.consume();
  storage.voiceTurnStore.admitted(operation.key, operation.fence, old.attemptId);
  storage.close(); storage = new SQLiteStorage(path); budget = new SQLiteBudgetLedger(storage);
  assert.equal(budget.recover(), 1); assert.equal(budget.used(session.id), 50);
  const turns = createVoiceTurnOperations({ storage, now: () => 1001, authorizeReplacement: () => true });
  const execute = async worker => {
    models++; const claim = budget.claim(admission().attemptId);
    worker.admitted(claim.attemptId); claim.consume();
    budget.settle(claim.claimId, { attemptId: claim.attemptId, outcome: 'completed', usage: { inputTokens: 1, outputTokens: 1 }, chargedMicro: 17 });
    const chunk = { id: 'chatcmpl-restart', created: 1, choices: [{ delta: { content: 'Recovered reply' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  };
  const replies = await Promise.all([turns.run(context, execute), turns.run(context, execute), turns.run(context, execute)]);
  assert.deepEqual(await Promise.all(replies.map(completionText)), Array(3).fill('Recovered reply'));
  assert.equal(models, 2); assert.equal(budget.used(session.id), 67);
  assert.equal(storage.voiceOperations(session.id)[0].attempts[1].replaces, operation.fence);
  storage.close(); storage = new SQLiteStorage(path); t.after(() => storage.close());
  const resumed = createVoiceTurnOperations({ storage, now: () => 1002 });
  assert.equal(await completionText(await resumed.run(context, () => assert.fail('completed replay must not dispatch'))), 'Recovered reply');
  assert.equal(storage.db.prepare("SELECT COUNT(*) n FROM budget_attempts").get().n, 2);
});


test('AIT-137 an assistant suffix after the last user does not change the operation prefix', async t => {
  const h = await turnsOnceFixture(t), messages = [{ role: 'user', content: 'Ja' }];
  const first = await completionText(await h.callback(messages));
  assert.equal(await completionText(await h.callback([...messages, { role: 'assistant', content: 'Provider partial reply' }])), first);
  assert.deepEqual(h.counts(), { admissions: 1, models: 1, cost: 17 });
});

test('AIT-137 round 1: changed provider metadata cannot rebind a pending callback', async t => {
  const h = await turnsOnceFixture(t, { blocked: true });
  const first = await h.callback(undefined, { stream: true });
  const retry = await h.callback([{ role: 'user', content: 'Ja', message_id: 'm1', turn_id: 't1' }], { stream: true });
  const texts = [first.text(), retry.text()]; h.release();
  assert.deepEqual((await Promise.all(texts)).map(sseReply), ['Reply 1 finished', 'Reply 2 finished']);
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
});

test('AIT-137 round 1: a callback with a new provider ID has its own reply', async t => {
  const h = await turnsOnceFixture(t), first = await (await h.callback()).json();
  const retry = await (await h.callback([{ role: 'user', content: 'Ja', event_id: 'e1' }])).json();
  assert.notDeepEqual(retry, first);
  assert.equal(retry.choices[0].message.content, 'Reply 2 finished');
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
});

test('AIT-137 round 1: changed failed callback metadata is new but the identical failed body needs authorization', async t => {
  const h = await turnsOnceFixture(t, { failFirst: true });
  assert.equal((await h.callback()).status, 502);
  assert.equal(await completionText(await h.callback([{ role: 'user', content: 'Ja', message_id: 'm1' }])), 'Reply 2 finished');
  const retry = await h.callback();
  assert.equal(retry.status, 403);
  assert.deepEqual(await retry.json(), { error: 'not-admitted', reason: 'voice-turn-replacement-required' });
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 17 });
});

test('AIT-137 round 1: message 2 turn 1 and message 3 turn 2 never share an alias before receipts', async t => {
  const h = await turnsOnceFixture(t), first = { role: 'user', content: 'Ja', message_id: 2, turn_id: 1 };
  const second = { role: 'user', content: 'Ja', message_id: 3, turn_id: 2 };
  assert.equal(await completionText(await h.callback([first])), 'Reply 1 finished');
  assert.equal(await completionText(await h.callback([first, { role: 'assistant', content: 'Again?' }, second])), 'Reply 2 finished');
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
});

test('AIT-137 round 1: changed turn ID creates a new body even with the same message ID', async t => {
  const h = await turnsOnceFixture(t), message = { role: 'user', content: 'Ja', message_id: 'm1' };
  await completionText(await h.callback([message], { turn_id: 't1' }));
  assert.equal(await completionText(await h.callback([message], { turn_id: 't2' })), 'Reply 2 finished');
  assert.equal(await completionText(await h.callback([message], { turn_id: 't1' })), 'Reply 1 finished');
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
});

test('AIT-137 round 1: identical message and event values in distinct namespaces buy separate turns', async t => {
  const h = await turnsOnceFixture(t), a = { role: 'user', content: 'A', message_id: 7 };
  const b = { role: 'user', content: 'B', event_id: 7 };
  assert.equal(await completionText(await h.callback([a])), 'Reply 1 finished');
  assert.equal(await completionText(await h.callback([a, b])), 'Reply 2 finished');
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
});

test('AIT-137 round 1: reused provider ID at another position creates a new operation', async t => {
  const h = await turnsOnceFixture(t), a = { role: 'user', content: 'A', message_id: 'same' };
  await completionText(await h.callback([a]));
  const response = await h.callback([a, { role: 'user', content: 'B', message_id: 'same' }]);
  assert.equal(await completionText(response), 'Reply 2 finished');
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
});

test('AIT-137 round 1: a typed echo stays transcript-only before the next spoken final', async t => {
  const h = await turnsOnceFixture(t);
  const typed = await h.route('/turns', { clientEventId: 'typed', content: 'Typed input',
    voiceCallId: h.grant.callId, providerSessionId: h.grant.providerSessionId });
  assert.equal(typed.status, 200); await h.handlers.idle();
  const echo = { role: 'user', content: 'Typed input', event_id: 'echo' };
  assert.equal(await completionText(await h.callback([echo])), 'Reply 1 finished');
  assert.equal((await h.persist('user', 'echo', echo.content, { event_id: 'echo' })).data.id, 'typed');
  await h.persist('user', 'spoken', 'Spoken input', { event_id: 'spoken' });
  const spoken = { role: 'user', content: 'Spoken input', event_id: 'spoken' };
  assert.equal(await completionText(await h.callback([echo, spoken])), 'Reply 2 finished');
  assert.equal(await completionText(await h.callback([echo])), 'Reply 1 finished');
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
});

test('AIT-137 round 1: a contradictory receipt cannot capture a completed provider operation by predecessor', async t => {
  const h = await turnsOnceFixture(t), old = { role: 'user', content: 'Older input', event_id: 'old' };
  await completionText(await h.callback([old]));
  await h.persist('user', 'new', 'New input', { event_id: 'new', userTurnOrdinal: 2 });
  const current = { role: 'user', content: 'New input', event_id: 'new' };
  assert.equal(await completionText(await h.callback([old, current])), 'Reply 2 finished');
  assert.equal(await completionText(await h.callback([old])), 'Reply 1 finished');
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
});

for (const order of ['older-first', 'newer-first']) {
  test(`AIT-137 round 1: late receipts do not fence admitted B (${order})`, async t => {
    const h = await turnsOnceFixture(t, { blocked: true, blockedModel: 2 });
    const a = { role: 'user', content: 'Input A', event_id: 'a' }, b = { role: 'user', content: 'Input B', event_id: 'b' };
    await completionText(await h.callback([a]));
    const current = await h.callback([a, b], { stream: true }), text = current.text();
    await h.waitForModel(2);
    if (order === 'newer-first') await h.persist('user', 'b', b.content, { event_id: 'b', userTurnOrdinal: 2 });
    await h.persist('user', 'a', a.content, { event_id: 'a', userTurnOrdinal: 1 });
    h.release(); const reply = await text;
    assert.equal(sseReply(reply), 'Reply 2 finished');
    assert.ok(reply.endsWith('data: [DONE]\n\n'), reply);
    if (order === 'older-first') await h.persist('user', 'b', b.content, { event_id: 'b', userTurnOrdinal: 2 });
    assert.equal(await completionText(await h.callback([a, b])), 'Reply 2 finished');
    assert.equal(await completionText(await h.callback([a])), 'Reply 1 finished');
    assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
  });
}

for (const phase of ['streaming', 'completed']) {
  for (const order of ['older-first', 'newer-first']) {
    test(`AIT-137 round 2: ID-less receipts preserve paid B (${phase}, ${order})`, async t => {
      const h = await turnsOnceFixture(t, { blocked: phase === 'streaming', blockedModel: 2 });
      const a = { role: 'user', content: 'Input A' }, b = { role: 'user', content: 'Input B' };
      assert.equal(await completionText(await h.callback([a])), 'Reply 1 finished');
      const current = await h.callback([a, b], { stream: true }), text = current.text();
      await h.waitForModel(2);
      let replay;
      if (phase === 'completed') {
        assert.equal(sseReply(await text), 'Reply 2 finished');
        replay = await h.callback([a, b], { stream: true });
      }
      // Neither the callback nor the final supplies a matching provider ID.
      // Both receipts arrive before streaming B is allowed to finish.
      for (const [id, message] of order === 'older-first' ? [['a', a], ['b', b]] : [['b', b], ['a', a]]) {
        await h.persist('user', id, message.content, { userTurnOrdinal: id === 'a' ? 1 : 2 });
      }
      h.release();
      // An already-open completed replay must remain readable, without a new
      // receipt affecting its callback identity before publication.
      const reply = replay ? await replay.text() : await text;
      assert.equal(sseReply(reply), 'Reply 2 finished');
      assert.ok(reply.endsWith('data: [DONE]\n\n'), reply);
      assert.doesNotMatch(reply, /"error"/u, 'late receipts must not fence an admitted reply');
      assert.equal(await completionText(await h.callback([a, b])), 'Reply 2 finished');
      assert.equal(await completionText(await h.callback([a, b])), 'Reply 2 finished');
      assert.equal(await completionText(await h.callback([a])), 'Reply 1 finished');
      assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
      assert.deepEqual(h.rows().map(row => [row.state, row.settled_micro]), [['settled', 17], ['settled', 17]]);
    });
  }
}

for (const order of ['older-first', 'newer-first']) {
  test(`AIT-137 round 2: ID-less receipt order survives a restart between receipts (${order})`, async t => {
    const { createVoiceTurnOperations } = await import('../src/voice-turns.js');
    const path = await temporaryDb();
    let storage = new SQLiteStorage(path), budget = new SQLiteBudgetLedger(storage), models = 0, admissions = 0;
    t.after(() => storage.close());
    const session = storage.create(), context = { sessionId: session.id, callId: 'receipt-restart', providerSessionId: 'provider-restart' };
    const a = { role: 'user', content: 'Input A' }, b = { role: 'user', content: 'Input B' };
    let turns = createVoiceTurnOperations({ storage, now: () => 1000 });
    const execute = async worker => {
      admissions++;
      const admitted = budget.admit({ sessionId: session.id, lane: 'reaction', maxMicro: 50,
        requestSha256: '0'.repeat(64), bindingSha256: '1'.repeat(64) });
      const claim = budget.claim(admitted.attemptId);
      worker.admitted(claim.attemptId); claim.consume(); models++;
      budget.settle(claim.claimId, { attemptId: claim.attemptId, outcome: 'completed',
        usage: { inputTokens: 1, outputTokens: 1 }, chargedMicro: 17 });
      const chunk = { id: `chatcmpl-receipt-${models}`, created: 1,
        choices: [{ delta: { content: `Reply ${models} finished` }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    };
    const callback = messages => turns.run({ ...context, messages }, execute);
    const persist = ([id, message]) => storage.postVoiceEvent(session.id, context.callId, context.providerSessionId, {
      type: 'final', callId: context.callId, turnId: `${context.providerSessionId}:user:${id}`, role: 'user', text: message.content, userTurnOrdinal: id === 'a' ? 1 : 2 });
    assert.equal(await completionText(await callback([a])), 'Reply 1 finished');
    assert.equal(await completionText(await callback([a, b])), 'Reply 2 finished');
    const receipts = order === 'older-first' ? [['a', a], ['b', b]] : [['b', b], ['a', a]];
    persist(receipts[0]); await turns.idle(); storage.close();
    storage = new SQLiteStorage(path); budget = new SQLiteBudgetLedger(storage);
    turns = createVoiceTurnOperations({ storage, now: () => 1001 });
    const replay = await turns.run({ ...context, messages: [a, b], stream: true }, execute);
    persist(receipts[1]);
    const reply = await replay.text();
    assert.equal(sseReply(reply), 'Reply 2 finished');
    assert.ok(reply.endsWith('data: [DONE]\n\n'), reply);
    assert.doesNotMatch(reply, /"error"/u);
    assert.equal(await completionText(await callback([a, b])), 'Reply 2 finished');
    assert.equal(await completionText(await callback([a, b])), 'Reply 2 finished');
    assert.equal(await completionText(await callback([a])), 'Reply 1 finished');
    assert.deepEqual({ admissions, models, cost: budget.used(session.id) }, { admissions: 2, models: 2, cost: 34 });
    assert.equal(storage.db.prepare("SELECT COUNT(*) n FROM budget_attempts WHERE lane='reaction'").get().n, 2);
  });
}

test('AIT-137 round 1: repeated Ja without operation inspection still buys two distinct replies', async t => {
  const h = await turnsOnceFixture(t), first = { role: 'user', content: 'Ja', event_id: 'first-ja' };
  await h.persist('user', 'first-ja', 'Ja', { event_id: 'first-ja' });
  const reply = await completionText(await h.callback([first]));
  await h.persist('assistant', 'question', 'Again?');
  await h.persist('user', 'second-ja', 'Ja', { event_id: 'second-ja' });
  const next = await completionText(await h.callback([first, { role: 'assistant', content: 'Again?' },
    { role: 'user', content: 'Ja', event_id: 'second-ja' }]));
  assert.notEqual(next, reply);
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
});

async function fanoutFixture(t) {
  const { createVoiceTurnOperations } = await import('../src/voice-turns.js');
  const storage = new SQLiteStorage(), session = storage.create(), source = Promise.withResolvers();
  const finished = Promise.withResolvers(); let models = 0;
  const turns = createVoiceTurnOperations({ storage });
  t.after(async () => { source.resolve(); finished.resolve(); await turns.idle(); storage.close(); });
  const context = { sessionId: session.id, callId: 'fanout', providerSessionId: 'provider',
    messages: [{ role: 'user', content: 'Input' }], stream: true };
  let writer;
  const encode = (content, finish = null) => new TextEncoder().encode(`data: ${JSON.stringify({ id: 'shared-reply', created: 1,
    choices: [{ delta: content === null ? {} : { content }, finish_reason: finish }] })}\n\n`);
  const execute = async () => {
    models++;
    return new Response(new ReadableStream({ start(controller) { writer = controller; controller.enqueue(encode('first')); },
      async pull(controller) {
        await source.promise;
        if (!writer) return;
        writer = null; controller.enqueue(encode('x'.repeat(65_536)));
        await finished.promise; controller.enqueue(encode(null, 'stop'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close();
      } }, { highWaterMark: 0 }));
  };
  return { join: () => turns.run(context, execute), produce: () => source.resolve(), finish: () => finished.resolve(),
    revoke: () => storage.reviseConsent(session.id, false),
    idle: () => turns.idle(), models: () => models };
}

test('AIT-137 round 1: a slow fan-out reader gets bounded frames while a fast reader completes', async t => {
  const h = await fanoutFixture(t), slow = await h.join(), fast = await h.join();
  const fastText = fast.text(); h.produce(); h.finish();
  assert.equal(sseReply(await fastText), 'first' + 'x'.repeat(65_536));
  await h.idle();
  const reader = slow.body.getReader(); let text = '';
  for (;;) {
    const item = await reader.read(); if (item.done) break;
    const chunk = new TextDecoder().decode(item.value); text += chunk;
    for (const line of chunk.split('\n\n').filter(line => line.startsWith('data: {'))) {
      const content = JSON.parse(line.slice(6)).choices?.[0].delta?.content;
      assert.ok(!content || content.length <= 16_384, 'backpressure must bound each lagging-reader content frame');
    }
  }
  assert.equal(sseReply(text), 'first' + 'x'.repeat(65_536));
  assert.ok(text.endsWith('data: [DONE]\n\n')); assert.equal(h.models(), 1);
});

test('AIT-137 round 1: cancelling one waiter during its pending pull leaves the other reader and replay intact', async t => {
  const h = await fanoutFixture(t), cancelled = await h.join(), other = await h.join();
  const reader = cancelled.body.getReader();
  await reader.read(); await reader.read();
  let settled = false; const pending = reader.read().then(item => { settled = true; return item; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false, 'the cancelled reader has a pending pull');
  await reader.cancel(); assert.equal((await pending).done, true);
  const text = other.text(); h.produce(); h.finish();
  assert.equal(sseReply(await text), 'first' + 'x'.repeat(65_536));
  const replay = await h.join(); assert.equal(sseReply(await replay.text()), 'first' + 'x'.repeat(65_536));
  assert.equal(h.models(), 1);
});

test('AIT-137 round 1: backpressure leaves no queued reply frames on an unread subscription after revocation', async t => {
  const h = await fanoutFixture(t), unread = await h.join(), fast = await h.join();
  const text = fast.text(); h.produce(); h.finish(); await text; await h.idle();
  h.revoke();
  const reader = unread.body.getReader(), item = await reader.read();
  assert.equal(new TextDecoder().decode(item.value), 'data: {"error":"not-admitted"}\n\n');
  assert.equal((await reader.read()).done, true); assert.equal(h.models(), 1);
});

test('AIT-137 round 1: HTTP cancellation during a pending pull preserves shared execution and one settlement', async t => {
  const h = await turnsOnceFixture(t, { blocked: true });
  const cancelled = await h.callback(undefined, { stream: true }), other = await h.callback(undefined, { stream: true });
  const reader = cancelled.body.getReader(); await reader.read(); await reader.read();
  let settled = false; const pending = reader.read().then(item => { settled = true; return item; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  await reader.cancel(); assert.equal((await pending).done, true);
  const text = other.text(); h.release();
  assert.equal(sseReply(await text), 'Reply 1 finished');
  assert.equal(await completionText(await h.callback()), 'Reply 1 finished');
  assert.deepEqual(h.counts(), { admissions: 1, models: 1, cost: 17 });
});

for (const phase of ['streaming', 'completed']) {
  for (const order of ['older-first', 'newer-first']) {
    test(`AIT-137 round 3: repeated Ja ID-less receipts preserve paid B (${phase}, ${order})`, async t => {
      const h = await turnsOnceFixture(t, { blocked: phase === 'streaming', blockedModel: 2 });
      const a = { role: 'user', content: 'Ja' }, b = { role: 'user', content: 'Ja' };
      assert.equal(await completionText(await h.callback([a])), 'Reply 1 finished');
      const current = await h.callback([a, b], { stream: true }), text = current.text();
      await h.waitForModel(2);
      let replay;
      if (phase === 'completed') {
        assert.equal(sseReply(await text), 'Reply 2 finished');
        replay = await h.callback([a, b], { stream: true });
      }
      // Neither the callback nor the final supplies a matching provider ID.
      // Both receipts arrive before streaming B is allowed to finish.
      for (const [id, message] of order === 'older-first' ? [['a', a], ['b', b]] : [['b', b], ['a', a]]) {
        await h.persist('user', id, message.content, { userTurnOrdinal: id === 'a' ? 1 : 2 });
      }
      h.release();
      // An already-open completed replay must remain readable, without a new
      // receipt affecting its callback identity before publication.
      const reply = replay ? await replay.text() : await text;
      assert.equal(sseReply(reply), 'Reply 2 finished');
      assert.ok(reply.endsWith('data: [DONE]\n\n'), reply);
      assert.doesNotMatch(reply, /"error"/u, 'late receipts must not fence an admitted reply');
      assert.equal(await completionText(await h.callback([a, b])), 'Reply 2 finished');
      assert.equal(await completionText(await h.callback([a, b])), 'Reply 2 finished');
      assert.equal(await completionText(await h.callback([a])), 'Reply 1 finished');
      assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
      assert.deepEqual(h.rows().map(row => [row.state, row.settled_micro]), [['settled', 17], ['settled', 17]]);
    });
  }
}

for (const order of ['older-first', 'newer-first']) {
  test(`AIT-137 round 3: repeated Ja ID-less receipt order survives a restart between receipts (${order})`, async t => {
    const { createVoiceTurnOperations } = await import('../src/voice-turns.js');
    const path = await temporaryDb();
    let storage = new SQLiteStorage(path), budget = new SQLiteBudgetLedger(storage), models = 0, admissions = 0;
    t.after(() => storage.close());
    const session = storage.create(), context = { sessionId: session.id, callId: 'receipt-restart', providerSessionId: 'provider-restart' };
    const a = { role: 'user', content: 'Ja' }, b = { role: 'user', content: 'Ja' };
    let turns = createVoiceTurnOperations({ storage, now: () => 1000 });
    const execute = async worker => {
      admissions++;
      const admitted = budget.admit({ sessionId: session.id, lane: 'reaction', maxMicro: 50,
        requestSha256: '0'.repeat(64), bindingSha256: '1'.repeat(64) });
      const claim = budget.claim(admitted.attemptId);
      worker.admitted(claim.attemptId); claim.consume(); models++;
      budget.settle(claim.claimId, { attemptId: claim.attemptId, outcome: 'completed',
        usage: { inputTokens: 1, outputTokens: 1 }, chargedMicro: 17 });
      const chunk = { id: `chatcmpl-receipt-${models}`, created: 1,
        choices: [{ delta: { content: `Reply ${models} finished` }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    };
    const callback = messages => turns.run({ ...context, messages }, execute);
    const persist = ([id, message]) => storage.postVoiceEvent(session.id, context.callId, context.providerSessionId, {
      type: 'final', callId: context.callId, turnId: `${context.providerSessionId}:user:${id}`, role: 'user', text: message.content, userTurnOrdinal: id === 'a' ? 1 : 2 });
    assert.equal(await completionText(await callback([a])), 'Reply 1 finished');
    assert.equal(await completionText(await callback([a, b])), 'Reply 2 finished');
    const receipts = order === 'older-first' ? [['a', a], ['b', b]] : [['b', b], ['a', a]];
    persist(receipts[0]); await turns.idle(); storage.close();
    storage = new SQLiteStorage(path); budget = new SQLiteBudgetLedger(storage);
    turns = createVoiceTurnOperations({ storage, now: () => 1001 });
    const replay = await turns.run({ ...context, messages: [a, b], stream: true }, execute);
    persist(receipts[1]);
    const reply = await replay.text();
    assert.equal(sseReply(reply), 'Reply 2 finished');
    assert.ok(reply.endsWith('data: [DONE]\n\n'), reply);
    assert.doesNotMatch(reply, /"error"/u);
    assert.equal(await completionText(await callback([a, b])), 'Reply 2 finished');
    assert.equal(await completionText(await callback([a, b])), 'Reply 2 finished');
    assert.equal(await completionText(await callback([a])), 'Reply 1 finished');
    assert.deepEqual({ admissions, models, cost: budget.used(session.id) }, { admissions: 2, models: 2, cost: 34 });
    assert.equal(storage.db.prepare("SELECT COUNT(*) n FROM budget_attempts WHERE lane='reaction'").get().n, 2);
  });
}


for (const repeated of [false, true]) {
  test(`AIT-137 round 3: missing A final cannot rebind A to B before B callback (${repeated ? 'Ja then Ja' : 'distinct input'})`, async t => {
    const h = await turnsOnceFixture(t);
    const a = { role: 'user', content: repeated ? 'Ja' : 'Input A' };
    const b = { role: 'user', content: repeated ? 'Ja' : 'Input B', event_id: 'b' };
    assert.equal(await completionText(await h.callback([a])), 'Reply 1 finished');
    const originalA = h.storage.voiceOperations(h.session.id)[0];
    const aKey = originalA.key;
    // Client captured two finals; A's persistence is lost, B retains ordinal 2.
    await h.persist('user', 'b', b.content, { event_id: 'b', userTurnOrdinal: 2 });
    const savedA = h.storage.voiceTurnStore.get(aKey);
    assert.deepEqual(savedA, originalA, 'a receipt cannot change any operation field');
    assert.equal(await completionText(await h.callback([a, { role: 'assistant', content: 'Again?' }, b])), 'Reply 2 finished');
    assert.equal(await completionText(await h.callback([a, { role: 'assistant', content: 'Again?' }, b])), 'Reply 2 finished');
    assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
    assert.deepEqual(h.rows().map(row => [row.state, row.settled_micro]), [['settled', 17], ['settled', 17]]);
  });
}

test('AIT-137 round 3: identical repeated-input retry history coalesces at ordinal 2', async t => {
  const h = await turnsOnceFixture(t, { blocked: true, blockedModel: 2 });
  const a = { role: 'user', content: 'Ja' }, b = { role: 'user', content: 'Ja' };
  assert.equal(await completionText(await h.callback([a])), 'Reply 1 finished');
  const messages = [a, { role: 'assistant', content: 'Again?' }, b];
  const responses = await Promise.all([h.callback(messages, { stream: true }), h.callback(messages, { stream: true }), h.callback(messages, { stream: true })]);
  const reading = responses.map(response => response.text());
  h.release();
  const replies = await Promise.all(reading);
  assert.deepEqual(replies.map(sseReply), Array(3).fill('Reply 2 finished'));
  assert.ok(replies.every(reply => reply.endsWith('data: [DONE]\n\n') && !reply.includes('"error"')));
  assert.equal(await completionText(await h.callback(messages)), 'Reply 2 finished');
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
});

for (const kind of ['truncated', 'history-discontinuity', 'missing-history-start', 'null-user', 'no-user']) {
  test(`AIT-137 round 3: incomplete or changed callback history has a stable key and never fences streaming B (${kind})`, async t => {
    const h = await turnsOnceFixture(t, { blocked: true, blockedModel: 2 });
    const a = { role: 'user', content: 'Ja' }, b = { role: 'user', content: 'Ja' };
    assert.equal(await completionText(await h.callback([a])), 'Reply 1 finished');
    const response = await h.callback([a, b], { stream: true }), reading = response.text();
    await h.waitForModel(2);
    const messages = kind === 'missing-history-start' ? [{ role: 'assistant', content: 'Again?' }, b]
      : kind === 'no-user' ? [{ role: 'assistant', content: 'Unverifiable history' }]
      : kind === 'null-user' ? [{ role: 'user', content: null }, b]
      : [{ role: 'user', content: kind === 'history-discontinuity' ? 'Different shortened history' : 'Ja' }];
    const flags = kind === 'truncated' ? { history_truncated: true } : {};
    assert.equal(await completionText(await h.callback(messages, flags)), 'Reply 3 finished');
    assert.equal(await completionText(await h.callback(messages, flags)), 'Reply 3 finished', 'identical bodies always replay');
    h.release();
    const reply = await reading;
    assert.equal(sseReply(reply), 'Reply 2 finished');
    assert.ok(reply.endsWith('data: [DONE]\n\n')); assert.doesNotMatch(reply, /"error"/u);
    assert.equal(await completionText(await h.callback([a, b])), 'Reply 2 finished');
    assert.deepEqual(h.counts(), { admissions: 3, models: 3, cost: 51 });
  });
}

for (const repeated of [false, true]) {
  for (const kind of ['unknown-receipt', 'missing-predecessors']) {
    test(`AIT-137 round 3: ${kind} never fences streaming B (${repeated ? 'Ja then Ja' : 'distinct input'})`, async t => {
      const h = await turnsOnceFixture(t, { blocked: true, blockedModel: 2 });
      const a = { role: 'user', content: repeated ? 'Ja' : 'Input A' }, b = { role: 'user', content: repeated ? 'Ja' : 'Input B' };
      assert.equal(await completionText(await h.callback([a])), 'Reply 1 finished');
      const response = await h.callback([a, b], { stream: true }), reading = response.text();
      await h.waitForModel(2);
      const keys = h.storage.voiceOperations(h.session.id);
      await h.persist('user', 'unlocatable', repeated ? 'Ja' : 'Input C', { userTurnOrdinal: kind === 'unknown-receipt' ? null : 3 });
      assert.deepEqual(h.storage.voiceOperations(h.session.id), keys, 'ambiguous final must not rebind paid operations');
      h.release();
      const reply = await reading;
      assert.equal(sseReply(reply), 'Reply 2 finished');
      assert.ok(reply.endsWith('data: [DONE]\n\n')); assert.doesNotMatch(reply, /"error"/u);
      assert.equal(await completionText(await h.callback([a, b])), 'Reply 2 finished');
      assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
    });
  }
}

for (const phase of ['streaming', 'completed']) {
  test(`AIT-137 round 3: two finals at one ordinal leave paid B intact (${phase})`, async t => {
    const h = await turnsOnceFixture(t, { blocked: phase === 'streaming', blockedModel: 2 });
    const a = { role: 'user', content: 'Ja' }, b = { role: 'user', content: 'Ja' };
    assert.equal(await completionText(await h.callback([a])), 'Reply 1 finished');
    const response = await h.callback([a, b], { stream: true }), reading = response.text();
    await h.waitForModel(2);
    if (phase === 'completed') assert.equal(sseReply(await reading), 'Reply 2 finished');
    const replay = phase === 'completed' ? await h.callback([a, b], { stream: true }) : null;
    await h.persist('user', 'b', 'Ja', { userTurnOrdinal: 2 });
    const before = h.storage.voiceOperations(h.session.id);
    await h.persist('user', 'conflicting-b', 'Ja', { userTurnOrdinal: 2 });
    assert.deepEqual(h.storage.voiceOperations(h.session.id), before);
    const retry = h.callback([a, b]);
    h.release();
    assert.equal(await completionText(await retry), 'Reply 2 finished');
    const reply = await (replay ? replay.text() : reading);
    assert.equal(sseReply(reply), 'Reply 2 finished');
    assert.ok(reply.endsWith('data: [DONE]\n\n')); assert.doesNotMatch(reply, /"error"/u);
    assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
  });
}

test('AIT-137 round 3: two provider alias candidates cannot capture or fence paid B', async t => {
  const h = await turnsOnceFixture(t, { blocked: true, blockedModel: 2 });
  const a = { role: 'user', content: 'Ja', message_id: 'a' }, b = { role: 'user', content: 'Ja', event_id: 'b' };
  assert.equal(await completionText(await h.callback([a])), 'Reply 1 finished');
  const response = await h.callback([a, b], { stream: true }), reading = response.text();
  await h.waitForModel(2);
  const before = h.storage.voiceOperations(h.session.id);
  const ambiguous = { role: 'user', content: 'Ja', message_id: 'a', event_id: 'b' };
  assert.equal(await completionText(await h.callback([a, b, ambiguous])), 'Reply 3 finished');
  assert.deepEqual(h.storage.voiceOperations(h.session.id).slice(0, 2), before);
  h.release(); const reply = await reading;
  assert.equal(sseReply(reply), 'Reply 2 finished');
  assert.ok(reply.endsWith('data: [DONE]\n\n')); assert.doesNotMatch(reply, /"error"/u);
  assert.equal(await completionText(await h.callback([a, b])), 'Reply 2 finished');
  assert.deepEqual(h.counts(), { admissions: 3, models: 3, cost: 51 });
});


test('AIT-137 round 3: new provider metadata on regressed history has its own operation', async t => {
  const h = await turnsOnceFixture(t, { blocked: true, blockedModel: 2 });
  const a = { role: 'user', content: 'Ja', event_id: 'a' }, b = { role: 'user', content: 'Ja' };
  assert.equal(await completionText(await h.callback([a])), 'Reply 1 finished');
  const response = await h.callback([a, b], { stream: true }), reading = response.text();
  await h.waitForModel(2);
  // A truncated later repeated answer looks like slot 1, but has a new ID.
  // No shared alias proves that this is a contradictory retry of A.
  assert.equal(await completionText(await h.callback([{ role: 'user', content: 'Ja', event_id: 'c' }])), 'Reply 3 finished');
  h.release(); const reply = await reading;
  assert.equal(sseReply(reply), 'Reply 2 finished');
  assert.ok(reply.endsWith('data: [DONE]\n\n')); assert.doesNotMatch(reply, /"error"/u);
  assert.equal(await completionText(await h.callback([a, b])), 'Reply 2 finished');
  assert.deepEqual(h.counts(), { admissions: 3, models: 3, cost: 51 });
});

test('AIT-137 round 4: gate trace 1 changed receipt prefix cannot fence paid B', async t => {
  const h = await turnsOnceFixture(t, { blocked: true });
  const a = { role: 'user', content: 'Input A' }, b = { role: 'user', content: 'Input B' };
  await h.persist('user', 'a', a.content, { userTurnOrdinal: 1 });
  const response = await h.callback([a, b], { stream: true }), reading = response.text();
  await h.waitForModel(1);
  const paidB = h.storage.voiceOperations(h.session.id)[0];
  const changed = [{ role: 'user', content: 'Input X' }, b, { role: 'user', content: 'Input C' }];
  assert.equal(await completionText(await h.callback(changed)), 'Reply 2 finished');
  h.release(); const reply = await reading;
  assert.equal(sseReply(reply), 'Reply 1 finished');
  assert.ok(reply.endsWith('data: [DONE]\n\n')); assert.doesNotMatch(reply, /"error"/u);
  assert.equal(await completionText(await h.callback([a, b])), 'Reply 1 finished');
  const operations = h.storage.voiceOperations(h.session.id);
  assert.equal(operations.length, 2); assert.notEqual(operations[1].key, paidB.key);
  assert.deepEqual(operations.map(operation => [operation.state, operation.ordinal]), [['completed', 2], ['completed', 3]]);
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
});

test('AIT-137 round 4: gate trace 2 reused receipt alias cannot obsolete paid B', async t => {
  const h = await turnsOnceFixture(t, { blocked: true, blockedModel: 2 });
  const a = { role: 'user', content: 'Input A', message_id: 'a' };
  const b = { role: 'user', content: 'Input B', message_id: 'b' }, c = { role: 'user', content: 'Input C' };
  await completionText(await h.callback([a]));
  const response = await h.callback([a, b], { stream: true }), reading = response.text();
  await h.waitForModel(2);
  const before = h.storage.voiceOperations(h.session.id);
  await h.persist('user', 'c', c.content, { userTurnOrdinal: 3, message_id: 'b' });
  assert.deepEqual(h.storage.voiceOperations(h.session.id), before, 'a receipt cannot mutate any operation field');
  assert.equal(await completionText(await h.callback([a, b, c])), 'Reply 3 finished');
  h.release(); const reply = await reading;
  assert.equal(sseReply(reply), 'Reply 2 finished');
  assert.ok(reply.endsWith('data: [DONE]\n\n')); assert.doesNotMatch(reply, /"error"/u);
  assert.equal(await completionText(await h.callback([a, b])), 'Reply 2 finished');
  assert.deepEqual(h.counts(), { admissions: 3, models: 3, cost: 51 });
});

for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
  test(`AIT-137 round 4: receipt permutation ${order.join('-')} leaves admitted operations byte-for-byte intact`, async t => {
    const h = await turnsOnceFixture(t, { blocked: true, blockedModel: 2 });
    const a = { role: 'user', content: 'Ja', message_id: 'a' }, b = { role: 'user', content: 'Ja', message_id: 'b' };
    await completionText(await h.callback([a]));
    const response = await h.callback([a, b], { stream: true }), reading = response.text();
    await h.waitForModel(2);
    const before = h.storage.voiceOperations(h.session.id);
    const finals = [
      ['a', { userTurnOrdinal: 1, message_id: 'a' }],
      ['b', { userTurnOrdinal: 2, message_id: 'b' }],
      ['c', { userTurnOrdinal: 3, message_id: 'b', event_id: 'a' }],
    ];
    for (const index of order) {
      const [id, metadata] = finals[index];
      await h.persist('user', id, 'Ja', metadata);
      assert.deepEqual(h.storage.voiceOperations(h.session.id), before);
    }
    h.release(); assert.equal(sseReply(await reading), 'Reply 2 finished');
    assert.equal(await completionText(await h.callback([a])), 'Reply 1 finished');
    assert.equal(await completionText(await h.callback([a, b])), 'Reply 2 finished');
    assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
  });
}

test('AIT-137 round 4: an admitted older reply completes after a newer admission and prompt orders both', async t => {
  const h = await turnsOnceFixture(t, { blocked: true });
  const a = { role: 'user', content: 'Input A' }, b = { role: 'user', content: 'Input B' };
  await h.persist('user', 'a', a.content, { userTurnOrdinal: 1 });
  const older = await h.callback([a], { stream: true }), reading = older.text();
  await h.waitForModel(1);
  await h.persist('user', 'b', b.content, { userTurnOrdinal: 2 });
  const newer = await (await h.callback([a, b])).json();
  assert.equal(newer.choices[0].message.content, 'Reply 2 finished');
  await h.persist('assistant', 'b-reply', 'Reply 2 finished', { replyId: newer.id, userTurnOrdinal: 99 });
  h.release(); const reply = await reading;
  assert.equal(sseReply(reply), 'Reply 1 finished');
  assert.ok(reply.endsWith('data: [DONE]\n\n')); assert.doesNotMatch(reply, /"error"/u);
  const olderId = JSON.parse(reply.split('\n\n').find(frame => frame.startsWith('data: {')).slice(6)).id;
  await h.persist('assistant', 'a-reply', 'Reply 1 finished', { replyId: olderId, userTurnOrdinal: 99 });
  const transcript = h.storage.get(h.session.id).transcript;
  assert.equal(transcript.find(turn => turn.content === 'Reply 1 finished').userTurnOrdinal, 1);
  assert.equal(transcript.find(turn => turn.content === 'Reply 2 finished').userTurnOrdinal, 2);
  await completionText(await h.callback([a, b, { role: 'user', content: 'Input C' }]));
  assert.deepEqual(h.requests.at(-1).messages.slice(1).map(message => message.content),
    ['Input A', 'Reply 1 finished', 'Input B', 'Reply 2 finished', 'Input C']);
  assert.equal(await completionText(await h.callback([a])), 'Reply 1 finished');
  assert.deepEqual(h.counts(), { admissions: 3, models: 3, cost: 51 });
});

for (const changed of ['user-prefix', 'assistant-prefix', 'whitespace', 'provider-metadata', 'system-prefix']) {
  test(`AIT-137 round 4: changed ${changed} at the same ordinal creates a new callback operation`, async t => {
    const h = await turnsOnceFixture(t);
    const messages = [{ role: 'system', content: 'System A' }, { role: 'user', content: 'Input A' },
      { role: 'assistant', content: 'Question A' }, { role: 'user', content: 'Ja' }];
    assert.equal(await completionText(await h.callback(messages)), 'Reply 1 finished');
    const next = structuredClone(messages);
    if (changed === 'user-prefix') next[1].content = 'Input X';
    if (changed === 'assistant-prefix') next[2].content = 'Question X';
    if (changed === 'whitespace') next[3].content = ' Ja ';
    if (changed === 'provider-metadata') next[3].message_id = 'new-id';
    if (changed === 'system-prefix') next[0].content = 'System X';
    assert.equal(await completionText(await h.callback(next)), 'Reply 2 finished');
    assert.equal(await completionText(await h.callback(next)), 'Reply 2 finished');
    assert.equal(await completionText(await h.callback(messages)), 'Reply 1 finished');
    const operations = h.storage.voiceOperations(h.session.id);
    assert.equal(operations.length, 2); assert.notEqual(operations[0].key, operations[1].key);
    assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
  });
}

for (const flags of [{ history_truncated: true }, {}]) {
  test(`AIT-137 round 4: ${flags.history_truncated ? 'explicitly truncated' : 'regressed'} lower history is new and identical retries replay`, async t => {
    const h = await turnsOnceFixture(t, { blocked: true });
    const a = { role: 'user', content: 'Input A' }, b = { role: 'user', content: 'Input B' };
    const response = await h.callback([a, b], { stream: true }), reading = response.text();
    await h.waitForModel(1);
    const shortened = [{ role: 'user', content: 'New shortened input' }];
    assert.equal(await completionText(await h.callback(shortened, flags)), 'Reply 2 finished');
    assert.equal(await completionText(await h.callback(shortened, flags)), 'Reply 2 finished');
    h.release(); const reply = await reading;
    assert.equal(sseReply(reply), 'Reply 1 finished');
    assert.ok(reply.endsWith('data: [DONE]\n\n')); assert.doesNotMatch(reply, /"error"/u);
    assert.equal(await completionText(await h.callback([a, b])), 'Reply 1 finished');
    assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
  });
}

test('AIT-137 round 4: only a known unadmitted older operation is refused as obsolete', async t => {
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const session = storage.create(), context = { sessionId: session.id, callId: 'call', providerSessionId: 'generation' };
  const a = { role: 'user', content: 'Input A' }, b = { role: 'user', content: 'Input B' };
  const older = storage.claimVoiceOperation({ ...context, messages: [a] }).operation;
  const newer = storage.claimVoiceOperation({ ...context, messages: [a, b] }).operation;
  assert.doesNotThrow(() => storage.voiceTurnStore.pending(older.key, older.fence), 'a claim without admission does not obsolete another claim');
  storage.voiceTurnStore.admitted(newer.key, newer.fence, 'paid-newer');
  assert.throws(() => storage.voiceTurnStore.admitted(older.key, older.fence, 'unpaid-older'),
    error => error instanceof PluginError && error.code === 'not-admitted' && error.message === 'voice-turn-obsolete');
  assert.equal(storage.voiceTurnStore.get(older.key).attempts[0].attemptId, undefined);
});

function pendingReplyConsumeConsent(t, h) {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), coverage = h.runtime.consent.coverage;
  h.runtime.consent.coverage = async (...args) => {
    if (args[0].scope.purpose !== 'mock-conversation' || !h.rows().some(row => row.state === 'claimed')) return coverage(...args);
    h.runtime.consent.coverage = coverage;
    entered.resolve(); await release.promise;
    return coverage(...args);
  };
  t.after(() => { h.runtime.consent.coverage = coverage; release.resolve(); });
  return { entered: entered.promise, release: () => release.resolve() };
}

for (const role of ['user', 'assistant']) {
  test(`AIT-137 round 5: ${role} final during consume consent preserves one admission and identical retry`, async t => {
    const h = await turnsOnceFixture(t), pending = pendingReplyConsumeConsent(t, h);
    const first = h.callback();
    await pending.entered;
    const before = h.storage.voiceOperations(h.session.id);
    assert.equal(before.length, 1); assert.ok(before[0].attempts[0].attemptId, 'the operation has recorded admission');
    await h.persist(role, 'during-consume', role === 'user' ? 'Ja' : 'An ordinary assistant final');
    assert.deepEqual(h.storage.voiceOperations(h.session.id), before, 'a final only writes transcript');
    pending.release();
    const response = await first, body = await response.json();
    const retry = await h.callback(), replay = await retry.json();
    assert.equal(response.status, 200, JSON.stringify({ body, retryStatus: retry.status, replay }));
    assert.equal(retry.status, 200); assert.deepEqual(replay, body);
    assert.deepEqual(h.counts(), { admissions: 1, models: 1, cost: 17 });
    assert.equal(h.rows().length, 1); assert.equal(h.rows()[0].state, 'settled');
    const operation = h.storage.voiceOperations(h.session.id)[0];
    assert.equal(operation.state, 'completed'); assert.equal(operation.attempts.length, 1);
  });
}

test('AIT-137 round 5: identical replies with delayed finals keep each operation ordinal and canonical order', async t => {
  const h = await turnsOnceFixture(t, { sameReply: true });
  const a = { role: 'user', content: 'Input A' }, b = { role: 'user', content: 'Input B' };
  await h.persist('user', 'a', a.content, { userTurnOrdinal: 1 });
  const replyA = await (await h.callback([a])).json();
  await h.persist('user', 'b', b.content, { userTurnOrdinal: 2 });
  const replyB = await (await h.callback([a, b])).json();
  assert.notEqual(replyA.id, replyB.id); assert.deepEqual(replyA.choices, replyB.choices);
  const operations = h.storage.voiceOperations(h.session.id);
  await h.persist('assistant', 'a-reply', replyA.choices[0].message.content, { replyId: replyA.id });
  await h.persist('assistant', 'b-reply', replyB.choices[0].message.content, { replyId: replyB.id });
  assert.deepEqual(h.storage.voiceOperations(h.session.id), operations, 'reply receipts do not mutate operations');
  const transcript = h.storage.get(h.session.id).transcript;
  assert.equal(transcript.find(turn => turn.id.endsWith(':a-reply')).userTurnOrdinal, 1);
  assert.equal(transcript.find(turn => turn.id.endsWith(':b-reply')).userTurnOrdinal, 2);
  await completionText(await h.callback([a, b, { role: 'user', content: 'Input C' }]));
  assert.deepEqual(h.requests.at(-1).messages.slice(1).map(message => [message.role, message.content]),
    [['user', 'Input A'], ['assistant', 'Same reply finished'], ['user', 'Input B'], ['assistant', 'Same reply finished'], ['user', 'Input C']]);
  assert.deepEqual(h.counts(), { admissions: 3, models: 3, cost: 51 });
});

test('AIT-137/AIT-148: shared voice guidance preserves identity order for identical delayed replies', async t => {
  const h = await turnsOnceFixture(t, { sameReply: true });
  const a = { role: 'user', content: 'Input A' }, b = { role: 'user', content: 'Input B' };
  await h.persist('user', 'a', a.content, { userTurnOrdinal: 1 });
  const replyA = await (await h.callback([a])).json();
  await h.persist('user', 'b', b.content, { userTurnOrdinal: 2 });
  const replyB = await (await h.callback([a, b])).json();
  assert.notEqual(replyA.id, replyB.id); assert.deepEqual(replyA.choices, replyB.choices);
  // Both finals are delayed; B arrives first despite identical reply text.
  await h.persist('assistant', 'b-reply', replyB.choices[0].message.content, { replyId: replyB.id });
  await h.persist('assistant', 'a-reply', replyA.choices[0].message.content, { replyId: replyA.id });
  const transcript = h.storage.get(h.session.id).transcript;
  assert.equal(transcript.find(turn => turn.replyId === replyA.id).userTurnOrdinal, 1);
  assert.equal(transcript.find(turn => turn.replyId === replyB.id).userTurnOrdinal, 2);
  await completionText(await h.callback([a, b, { role: 'user', content: 'Input C' }]));
  const request = h.requests.at(-1);
  assert.equal(request.system.split(core.REPLY_POLICY).length, 2);
  assert.match(request.system, /Ask at most one question per reply/u);
  assert.match(request.system, /canonical person turns and the latest callback answer take precedence/u);
  assert.match(request.system, /two or three short sentences[^\n]*at most 60 words[^\n]*at most one question/iu);
  assert.match(request.system, /focused question is only a suggestion/iu);
  assert.deepEqual(request.messages.slice(1).map(message => [message.role, message.content]),
    [['user', 'Input A'], ['assistant', 'Same reply finished'], ['user', 'Input B'], ['assistant', 'Same reply finished'], ['user', 'Input C']]);
  assert.deepEqual(h.counts(), { admissions: 3, models: 3, cost: 51 });
});

test('AIT-137 round 5: late reply metadata orders identical finals without mutating operations', async t => {
  const h = await turnsOnceFixture(t, { sameReply: true });
  const a = { role: 'user', content: 'Input A' }, b = { role: 'user', content: 'Input B' };
  await h.persist('user', 'a', a.content, { userTurnOrdinal: 1 });
  const replyA = await (await h.callback([a])).json();
  await h.persist('user', 'b', b.content, { userTurnOrdinal: 2 });
  const replyB = await (await h.callback([a, b])).json(), operations = h.storage.voiceOperations(h.session.id);
  await h.persist('assistant', 'b-reply', replyB.choices[0].message.content);
  await h.persist('assistant', 'a-reply', replyA.choices[0].message.content);
  const identify = (id, replyId) => h.route(`/voice/${h.grant.callId}/events`, { providerSessionId: h.grant.providerSessionId,
    event: { type: 'reply', callId: h.grant.callId, turnId: `${h.grant.providerSessionId}:assistant:${id}-reply`, replyId } });
  assert.equal((await identify('a', replyA.id)).status, 200);
  assert.equal((await identify('b', replyB.id)).status, 200);
  const seq = h.storage.get(h.session.id).seq;
  assert.equal((await identify('a', replyA.id)).status, 200);
  assert.equal(h.storage.get(h.session.id).seq, seq, 'late metadata retries are transcript-idempotent');
  assert.deepEqual(h.storage.voiceOperations(h.session.id), operations);
  await completionText(await h.callback([a, b, { role: 'user', content: 'Input C' }]));
  assert.deepEqual(h.requests.at(-1).messages.slice(1).map(message => [message.role, message.content]),
    [['user', 'Input A'], ['assistant', 'Same reply finished'], ['user', 'Input B'], ['assistant', 'Same reply finished'], ['user', 'Input C']]);
});

test('AIT-137 round 5: absent or unknown reply identity never selects an ordinal by identical text', async t => {
  const h = await turnsOnceFixture(t, { sameReply: true }), a = { role: 'user', content: 'Input A' }, b = { role: 'user', content: 'Input B' };
  await completionText(await h.callback([a])); await completionText(await h.callback([a, b]));
  const operations = h.storage.voiceOperations(h.session.id);
  await h.persist('assistant', 'unknown', 'Same reply finished', { replyId: 'chatcmpl-unknown', userTurnOrdinal: 1 });
  await h.persist('assistant', 'absent', 'Same reply finished', { userTurnOrdinal: 2 });
  assert.ok(h.storage.get(h.session.id).transcript.every(turn => turn.userTurnOrdinal === undefined && turn.replyId === undefined));
  assert.deepEqual(h.storage.voiceOperations(h.session.id), operations);
});

test('AIT-137 round 5: coalesced streams and replay carry the same operation reply metadata', async t => {
  const h = await turnsOnceFixture(t, { blocked: true });
  const responses = await Promise.all([h.callback(undefined, { stream: true }), h.callback(undefined, { stream: true })]);
  const bodies = responses.map(response => response.text()); h.release();
  const frames = (await Promise.all(bodies)).map(text => JSON.parse(text.split('\n\n').find(frame => frame.startsWith('data: {')).slice(6)));
  assert.equal(frames[0].id, frames[1].id);
  assert.deepEqual(frames.map(frame => frame.metadata), [{ aithema_reply_id: frames[0].id }, { aithema_reply_id: frames[0].id }]);
  const replayed = await (await h.callback()).json();
  assert.equal(replayed.id, frames[0].id); assert.deepEqual(replayed.metadata, frames[0].metadata);
  assert.deepEqual(h.counts(), { admissions: 1, models: 1, cost: 17 });
});

test('AIT-137 round 5: reply annotations plus a user final during consume remain benign', async t => {
  const h = await turnsOnceFixture(t), a = { role: 'user', content: 'Input A' }, b = { role: 'user', content: 'Input B' };
  await h.persist('user', 'a', a.content);
  const replyA = await (await h.callback([a])).json();
  await h.persist('assistant', 'a-reply', replyA.choices[0].message.content); await h.handlers.idle();
  const pending = pendingReplyConsumeConsent(t, h), callback = h.callback([a, b]);
  await pending.entered;
  const before = h.storage.voiceOperations(h.session.id);
  assert.equal((await h.route(`/voice/${h.grant.callId}/events`, { providerSessionId: h.grant.providerSessionId,
    event: { type: 'reply', callId: h.grant.callId, turnId: `${h.grant.providerSessionId}:assistant:a-reply`, replyId: replyA.id } })).status, 200);
  await h.persist('user', 'b', b.content);
  assert.deepEqual(h.storage.voiceOperations(h.session.id), before);
  pending.release();
  const completed = await (await callback).json(), replayed = await (await h.callback([a, b])).json();
  assert.deepEqual(replayed, completed); assert.equal(completed.choices[0].message.content, 'Reply 2 finished');
  assert.deepEqual(h.counts(), { admissions: 2, models: 2, cost: 34 });
});

for (const change of ['consent-withdrawal', 'external-consent-withdrawal', 'source-withdrawal', 'erasure', 'pause', 'call-close', 'budget-revocation', 'upload-change', 'heard-correction', 'locale-change']) {
  test(`AIT-137 round 5: ${change} during consume still refuses dispatch and costs zero`, async t => {
    const h = await turnsOnceFixture(t);
    await h.persist('user', 'private', 'Private earlier input');
    await h.persist('assistant', 'heard', 'Heard. Unheard.');
    await h.handlers.idle();
    const pending = pendingReplyConsumeConsent(t, h), callback = h.callback();
    await pending.entered;
    const callbackAttemptId = h.rows().find(row => row.state === 'claimed').attempt_id;
    if (change === 'consent-withdrawal') await h.route('/consent', { granted: false });
    if (change === 'external-consent-withdrawal') h.coverage(false);
    if (change === 'source-withdrawal') await h.route('/withdraw', { turnId: `${h.grant.providerSessionId}:user:private` });
    if (change === 'erasure') await h.route('/erase');
    if (change === 'pause') await h.route('/pause', { paused: true });
    if (change === 'call-close') await h.route(`/voice/${h.grant.callId}/close`, { providerSessionId: h.grant.providerSessionId });
    if (change === 'budget-revocation') {
      const row = h.rows()[0];
      h.runtime.budget.settle(row.claim_id, { attemptId: row.attempt_id, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } });
    }
    if (change === 'upload-change') h.storage.append(h.session.id, 'upload.state', { id: 'new-upload', state: 'pending', at: new Date(h.now()).toISOString() });
    if (change === 'heard-correction') h.storage.postVoiceEvent(h.session.id, h.grant.callId, h.grant.providerSessionId,
      { type: 'heard', callId: h.grant.callId, turnId: `${h.grant.providerSessionId}:assistant:heard`, prefix: 'Heard.' });
    if (change === 'locale-change') h.storage.append(h.session.id, 'session.locale-changed', { locale: 'de' });
    pending.release();
    const response = await callback;
    await h.handlers.idle();
    assert.notEqual(response.status, 200);
    const row = h.runtime.budget.get(callbackAttemptId);
    assert.equal(row.settled_micro ?? 0, 0); assert.notEqual(row.state, 'dispatched');
    assert.ok(!h.dispatches.includes(callbackAttemptId), 'the refused callback attempt never reaches a model');
    // Closing voice can legitimately resume the ordinary text reaction lane.
    // Its independent attempt is not a dispatch of this refused voice callback.
    if (change !== 'call-close') {
      assert.equal(h.requests.length, 0); assert.deepEqual(h.counts(), { admissions: 1, models: 0, cost: 0 });
      assert.equal(h.rows().length, 1);
    }
  });
}
