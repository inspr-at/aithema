import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintConversationCredential, reconcileUsage, createVoiceBinding } from '../src/server.js';
import { validateManifest, PluginRegistry } from '../../../packages/core/src/plugins.js';
import { manifest } from '../src/manifest.js';
import { PluginError } from '../../../packages/core/src/invocation.js';
import { fixture, binding, invocationOptions, flush } from './fixtures.js';

test('token and signed URL minting use configured agent, runtime secret and a fake API', async () => {
  const local = fixture();
  for (const transport of ['webrtc', 'websocket']) {
    const credential = await mintConversationCredential(binding, { transport }, { deadlineAt: Date.now() + 1000 },
      { fetchImpl: local.fetchImpl, resolveSecret: ref => { assert.equal(ref, binding.secretRef); return 'fake-runtime-key'; } });
    const request = local.requests.at(-1);
    assert.equal(request.url.searchParams.get('agent_id'), binding.agentId);
    assert.equal(request.options.headers['xi-api-key'], 'fake-runtime-key');
    assert.equal(request.options.redirect, 'error');
    assert.equal(credential.connectionType, transport); assert.ok(credential.providerSessionId);
    assert.equal(credential.ttlMs, 60_000); assert.equal(Object.hasOwn(credential, 'expiresAt'), false);
    assert.equal(JSON.stringify(credential).includes('fake-runtime-key'), false);
    if (transport === 'websocket') assert.equal(request.url.searchParams.get('include_conversation_id'), 'true');
  }
});
test('API binding requires HTTPS except literal loopback HTTP test endpoints', () => {
  for (const apiBaseUrl of ['http://api.example.test', 'http://127.0.0.1.example.test', 'http://192.168.1.1', 'http://0.0.0.0']) {
    assert.throws(() => createVoiceBinding({ ...binding, apiBaseUrl }), /Invalid ElevenLabs API base URL/);
  }
  for (const apiBaseUrl of ['https://api.example.test', 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    assert.equal(createVoiceBinding({ ...binding, apiBaseUrl }).apiBaseUrl, apiBaseUrl);
  }
});
test('closure polls processing with backoff until done and excludes acknowledged pauses from visitor usage', async () => {
  const startedAt = Date.now(); let clock = startedAt, observations = 0; const observedAt = [];
  const local = fixture({ now: () => clock, closureTimeoutMs: 200, closurePollIntervalMs: 5,
    providerDetails: id => {
      observations++; observedAt.push(Date.now());
      return { conversation_id: id, status: observations < 3 ? 'processing' : 'done',
        metadata: { call_duration_secs: 120, start_time_unix_secs: startedAt / 1000, cost: 17 } };
    } });
  const options = invocationOptions({ spendDeadlineAt: startedAt + 180_000, browserLivenessDeadlineAt: startedAt + 180_000 });
  const session = await local.server.start({ callId: 'call_poll', facadeSecretRef: 'fixture-ref' }, options);
  clock = startedAt + 10_000; await session.pause(); clock = startedAt + 50_000; await session.resume();
  const terminal = await session.close();
  assert.equal(observations, 3); assert.ok(observedAt[2] - observedAt[1] >= 8);
  assert.equal(terminal.outcome, 'completed'); assert.equal(terminal.closureConfirmed, true);
  assert.deepEqual(terminal.usage, { providerSeconds: 120, providerMinutes: 2, pausedSeconds: 40, visitorSeconds: 80,
    upstreamMicro: 1200, visitorMicro: 400, providerCredits: 17 });
  assert.equal(options.reports.length, 1); assert.equal(options.reports[0].chargedMicro, 1200);
  assert.equal(await session.close(), terminal); assert.equal(observations, 3);
});
test('only exhaustion of the closure window reports uncertain and schedules optional host reconciliation once', async () => {
  const later = [], observedAt = [], windowMs = 40;
  const local = fixture({ closureTimeoutMs: windowMs, closurePollIntervalMs: 3,
    providerDetails: id => { observedAt.push(Date.now()); return { conversation_id: id, status: 'processing' }; },
    reconcileLater: call => { later.push(call); } });
  const options = invocationOptions(), session = await local.server.start({ callId: 'call_later', facadeSecretRef: 'fixture-ref' }, options);
  const started = Date.now(), terminal = await session.close();
  assert.equal(terminal.outcome, 'uncertain'); assert.ok(Date.now() - started >= windowMs - 2);
  assert.ok(observedAt.length > 1); assert.equal(options.reports.length, 1); assert.equal(later.length, 1);
  assert.equal(later[0].terminal.outcome, 'uncertain'); assert.equal(later[0].providerSessionId, session.providerSessionId);
  assert.equal(JSON.stringify(later).includes('fixture-token'), false);
  await session.close(); assert.equal(later.length, 1); assert.equal(options.reports.length, 1);
});
test('requestProviderClose failure still polls authenticated details and settles exactly once', async () => {
  let shutdowns = 0;
  const local = fixture({ requestProviderClose: () => { shutdowns++; throw new Error('fixture shutdown failure'); },
    providerDetails: id => ({ conversation_id: id, status: 'failed', metadata: { call_duration_secs: 12 } }) });
  const options = invocationOptions(), session = await local.server.start({ callId: 'call_close_failure', facadeSecretRef: 'fixture-ref' }, options);
  const terminal = await session.close('cancelled', 'cancelled');
  assert.equal(terminal.outcome, 'cancelled'); assert.equal(terminal.closureConfirmed, true); assert.equal(terminal.chargedMicro, 120);
  await session.close(); assert.equal(shutdowns, 1); assert.equal(options.reports.length, 1);
});
for (const windowMs of [10_000, 3000]) {
  test(`stalled closure GET is bounded to min(window ${windowMs}ms, five seconds)`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    let observations = 0, firstSignal; const entered = Promise.withResolvers();
    const local = fixture({ closureTimeoutMs: windowMs, closurePollIntervalMs: 10,
      providerDetails: (id, call, { signal }) => {
        observations++;
        if (observations === 1) { firstSignal = signal; entered.resolve(); return new Promise(() => {}); }
        return { conversation_id: id, status: 'done', metadata: { call_duration_secs: 1 } };
      } });
    const options = invocationOptions(), session = await local.server.start({ callId: 'call_hung_get', facadeSecretRef: 'fixture-ref' }, options);
    const pending = session.close(); await entered.promise;
    const requestMs = Math.min(windowMs, 5000);
    t.mock.timers.tick(requestMs - 1); await flush(); assert.equal(firstSignal.aborted, false); assert.equal(observations, 1);
    t.mock.timers.tick(1); await flush(); assert.equal(firstSignal.aborted, true);
    assert.equal(firstSignal.reason.name, 'TimeoutError');
    if (windowMs > requestMs) { t.mock.timers.tick(10); await flush(); }
    const terminal = await pending;
    assert.equal(observations, windowMs > requestMs ? 2 : 1);
    assert.equal(terminal.outcome, windowMs > requestMs ? 'completed' : 'uncertain');
    assert.equal(terminal.closureConfirmed, windowMs > requestMs); assert.equal(options.reports.length, 1);
  });
}
test('uncertain closure schedules reconciliation once even when terminal reporting fails', async () => {
  const later = [], failure = new Error('fixture ledger unavailable');
  const local = fixture({ providerDetails: id => ({ conversation_id: id, status: 'processing' }),
    reconcileLater: call => { later.push(call); } });
  const options = invocationOptions(); options.report = terminal => { options.reports.push(terminal); throw failure; };
  const session = await local.server.start({ callId: 'call_report_failure', facadeSecretRef: 'fixture-ref' }, options);
  await assert.rejects(session.close(), error => error === failure);
  assert.equal(options.reports.length, 1); assert.equal(options.reports[0].outcome, 'uncertain'); assert.equal(later.length, 1);
  assert.equal(later[0].providerSessionId, session.providerSessionId); assert.equal(JSON.stringify(later).includes('fixture-token'), false);
  await assert.rejects(session.close(), error => error === failure); assert.equal(later.length, 1); assert.equal(options.reports.length, 1);
});
test('invalid close outcome rejects before changing call state or looking up closure', async () => {
  const local = fixture({ providerDetails: id => ({ conversation_id: id, status: 'done', metadata: { call_duration_secs: 1 } }) });
  const options = invocationOptions(), session = await local.server.start({ callId: 'call_invalid_close', facadeSecretRef: 'fixture-ref' }, options);
  const before = session.snapshot(), requestsBefore = local.requests.length;
  for (const outcome of ['uncertain', 'invalid', null]) {
    await assert.rejects(session.close('closed', outcome), /Invalid voice settlement/);
    assert.deepEqual(session.snapshot(), before); assert.equal(session.signal.aborted, false);
    assert.equal(local.requests.length, requestsBefore); assert.equal(options.reports.length, 0);
  }
  const terminal = await session.close(); assert.equal(terminal.outcome, 'completed'); assert.equal(options.reports.length, 1);
  await assert.rejects(session.close('closed', 'invalid'), /Invalid voice settlement/);
  assert.equal(await session.close(), terminal); assert.equal(options.reports.length, 1);
});
test('close aborts stalled pause and heartbeat operations before serialized closure', async () => {
  for (const command of ['pause', 'heartbeat']) {
    let commandSignal, commandStarted;
    const started = new Promise(resolve => { commandStarted = resolve; });
    const local = fixture({ saveCall: (call, opts) => {
      if (!call.closing && (opts?.paused === true || call.browserLivenessDeadlineAt !== options.browserLivenessDeadlineAt)) {
        commandSignal = opts.signal; commandStarted(); return new Promise(() => {});
      }
      return { acknowledged: true, paused: call.paused };
    }, providerDetails: id => ({ conversation_id: id, status: 'done', metadata: { call_duration_secs: 1 } }) });
    const options = invocationOptions(), session = await local.server.start({ callId: `call_stall_${command}`, facadeSecretRef: 'fixture-ref' }, options);
    await new Promise(resolve => setTimeout(resolve, 5));
    const pending = session[command](), rejected = assert.rejects(pending, { code: 'cancelled' }); await started;
    const terminal = await session.close(); await rejected;
    assert.equal(commandSignal.aborted, true); assert.equal(terminal.closureConfirmed, true); assert.equal(options.reports.length, 1);
  }
});
test('heartbeat after the spend deadline cannot write or extend the lease', async () => {
  let clock = Date.now(); const local = fixture({ now: () => clock });
  const options = invocationOptions(), session = await local.server.start({ callId: 'call_late_heartbeat', facadeSecretRef: 'fixture-ref' }, options);
  const savedBefore = local.saved.length, leaseBefore = session.snapshot().browserLivenessDeadlineAt;
  clock = options.spendDeadlineAt + 1;
  await assert.rejects(session.heartbeat(), { code: 'deadline' });
  assert.equal(local.saved.length, savedBefore); assert.equal(session.snapshot().browserLivenessDeadlineAt, leaseBefore);
  await session.close();
});
test('minting rejects missing identity, malformed credentials, denied API and cancellation', async () => {
  for (const payload of [{ token: 'fake' }, { conversation_id: 'conv_valid' }, { token: 'fake', conversation_id: '../bad' }]) {
    await assert.rejects(mintConversationCredential(binding, {}, {}, { resolveSecret: () => 'fixture', fetchImpl: async () => Response.json(payload) }), { code: 'invalid-output' });
  }
  await assert.rejects(mintConversationCredential(binding, { transport: 'websocket' }, {}, {
    resolveSecret: () => 'fixture', fetchImpl: async () => Response.json({ signed_url: 'https://wrong.test', conversation_id: 'conv_valid' }) }), { code: 'invalid-output' });
  await assert.rejects(mintConversationCredential(binding, {}, {}, { resolveSecret: () => 'fixture', fetchImpl: async () => new Response('', { status: 401 }) }), { code: 'auth' });
  let requests = 0; const controller = new AbortController(); controller.abort();
  await assert.rejects(mintConversationCredential(binding, {}, { signal: controller.signal }, { fetchImpl: async () => { requests++; }, resolveSecret: () => 'fixture' }), { code: 'cancelled' });
  assert.equal(requests, 0);
  assert.throws(() => createVoiceBinding({ ...binding, apiBaseUrl: 'https://user:pass@example.test' }), /Invalid/);
});
test('public D4 manifest is valid, immutable, has two halves and only public source URLs', () => {
  assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] }); assert.ok(Object.isFrozen(manifest.liveVoice.capabilities));
  assert.ok(manifest.models[0].evidence.every(url => url.startsWith('https://elevenlabs.io/docs/')));
  const invalid = structuredClone(manifest); delete invalid.entrypoints.browser;
  assert.equal(validateManifest(invalid).ok, false);
  assert.ok(new PluginRegistry().register(fixture().server).get('elevenlabs'));
  for (const field of ['secretRef', 'accountRef', 'legal']) assert.equal(Object.hasOwn(manifest, field), false);
});
test('reconciliation clips and unions acknowledged pause intervals; records full upstream minutes and credits', () => {
  const call = { providerSessionId: 'conv_math', startedAt: 100_000,
    pauses: [{ from: 110_000, to: 140_000 }, { from: 130_000, to: 150_000 }, { from: 180_000, to: null }] };
  const terminal = reconcileUsage({ call, binding, maxMicro: 2000,
    details: { conversation_id: 'conv_math', status: 'done', metadata: { call_duration_secs: 120, start_time_unix_secs: 100, cost: 15 } } });
  assert.equal(terminal.closureConfirmed, true); assert.equal(terminal.outcome, 'completed');
  assert.deepEqual(terminal.usage, { providerSeconds: 120, providerMinutes: 2, pausedSeconds: 80, visitorSeconds: 40,
    upstreamMicro: 1200, visitorMicro: 200, providerCredits: 15 }); assert.equal(terminal.chargedMicro, 1200);
  const allPaused = reconcileUsage({ call: { ...call, pauses: [{ from: 0, to: null }] }, binding, maxMicro: 2000,
    details: { conversation_id: 'conv_math', status: 'failed', metadata: { call_duration_secs: 120 } } });
  assert.equal(allPaused.usage.visitorMicro, 0); assert.equal(allPaused.usage.upstreamMicro, 1200);
});
test('uncertain closure uses claim maximum, never browser elapsed time; known overrun remains visible', () => {
  const call = { providerSessionId: 'conv_math', startedAt: 0, pauses: [] };
  for (const details of [null, { conversation_id: 'foreign', status: 'done', metadata: { call_duration_secs: 1 } },
    { conversation_id: 'conv_math', status: 'done', metadata: { call_duration_secs: '1' } },
    { conversation_id: 'conv_math', status: 'processing', metadata: { call_duration_secs: 30 } }]) {
    const report = reconcileUsage({ call, binding, details, maxMicro: 999 });
    assert.equal(report.outcome, 'uncertain'); assert.equal(report.chargedMicro, 999); assert.equal(report.closureConfirmed, false);
  }
  const overrun = reconcileUsage({ call, binding, maxMicro: 100,
    details: { conversation_id: 'conv_math', status: 'done', metadata: { call_duration_secs: 120 } } });
  assert.equal(overrun.chargedMicro, 1200); assert.equal(overrun.overrun, true);
});
test('start consumes before mint, persists identity before receipt, closes once and never journals credentials', async () => {
  const local = fixture(), options = invocationOptions(); let consumed = false;
  const consume = options.attempt.consume;
  options.attempt.consume = async () => { assert.equal(local.requests.length, 0); await consume(); consumed = true; };
  const session = await local.control.start({ callId: 'call_fixture' }, options);
  assert.equal(consumed, true); assert.equal(local.saved[0].providerSessionId, session.providerSessionId);
  assert.equal(JSON.stringify(local.saved).includes('fixture-token'), false); assert.equal(options.reports.length, 0);
  const terminal = await local.control.close({ providerSessionId: session.providerSessionId, reason: 'closed' });
  assert.equal(terminal.outcome, 'uncertain'); assert.equal(options.reports.length, 1);
  await local.control.close({ providerSessionId: session.providerSessionId, reason: 'closed' }); assert.equal(options.reports.length, 1);
});
test('authority refusal, preflight cancel and expired spend prevent outbound work', async () => {
  for (const mode of ['refused', 'cancelled', 'deadline', 'over-budget']) {
    const local = fixture(), options = invocationOptions(), controller = new AbortController();
    if (mode === 'refused') options.attempt.consume = () => { throw Object.assign(new Error('refused'), { code: 'not-admitted' }); };
    if (mode === 'cancelled') { controller.abort(); options.signal = controller.signal; }
    if (mode === 'deadline') options.spendDeadlineAt = Date.now() - 1;
    if (mode === 'over-budget') options.attempt.maxMicro = 0;
    await assert.rejects(local.server.start({ callId: 'call_fixture', facadeSecretRef: 'fixture-ref' }, options),
      { code: mode === 'refused' || mode === 'over-budget' ? 'not-admitted' : mode });
    assert.equal(local.requests.length, 0);
    if (mode !== 'refused') { assert.equal(options.reports.length, 1); assert.equal(options.reports[0].chargedMicro, 0); }
  }
});
test('start waits for async authority before callback provisioning, minting or journal writes', async () => {
  let preparations = 0; const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const local = fixture({ prepareCall: async () => { preparations++; } }), options = invocationOptions();
  const consume = options.attempt.consume;
  options.attempt.consume = async () => { entered.resolve(); await gate.promise; await consume(); };
  const pending = local.server.start({ callId: 'call_async_consume', facadeSecretRef: 'fixture-ref' }, options);
  await entered.promise; assert.equal(preparations, 0); assert.equal(local.requests.length, 0); assert.equal(local.saved.length, 0);
  gate.resolve(); const session = await pending;
  assert.equal(preparations, 1); assert.equal(local.requests.length, 1); assert.equal(local.saved.length, 1);
  await session.close(); assert.equal(options.reports.length, 1);
});
test('async authority refusal retains host zero-cost settlement without provisioning, minting or a second report', async () => {
  let preparations = 0; const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const local = fixture({ prepareCall: async () => { preparations++; } }), options = invocationOptions();
  options.attempt.consume = async () => {
    entered.resolve(); await gate.promise;
    options.report({ attemptId: options.attempt.attemptId, outcome: 'cancelled', closureConfirmed: true, chargedMicro: 0 });
    throw new PluginError('not-admitted', 'Session changed before dispatch');
  };
  const rejected = assert.rejects(local.server.start({ callId: 'call_async_refusal', facadeSecretRef: 'fixture-ref' }, options),
    { code: 'not-admitted', message: 'Session changed before dispatch' });
  await entered.promise; assert.equal(local.requests.length, 0); gate.resolve(); await rejected;
  assert.equal(preparations, 0); assert.equal(local.requests.length, 0); assert.equal(local.saved.length, 0);
  assert.equal(options.reports.length, 1); assert.equal(options.reports[0].chargedMicro, 0);
});
test('cancellation while async authority is pending prevents callback provisioning and settles zero once', async () => {
  let preparations = 0; const entered = Promise.withResolvers(), gate = Promise.withResolvers(), controller = new AbortController();
  const local = fixture({ prepareCall: async () => { preparations++; } }), options = invocationOptions({ signal: controller.signal });
  const consume = options.attempt.consume;
  options.attempt.consume = async () => { entered.resolve(); await gate.promise; await consume(); };
  const rejected = assert.rejects(local.server.start({ callId: 'call_cancel_consume', facadeSecretRef: 'fixture-ref' }, options), { code: 'cancelled' });
  await entered.promise; controller.abort(); gate.resolve(); await rejected;
  assert.equal(preparations, 0); assert.equal(local.requests.length, 0); assert.equal(options.reports.length, 1);
  assert.equal(options.reports[0].outcome, 'cancelled'); assert.equal(options.reports[0].chargedMicro, 0);
});
test('pause persists an engine-wide acknowledgement; failed acknowledgement stays closed', async () => {
  let acknowledge = false;
  const local = fixture({ saveCall: call => ({ acknowledged: acknowledge, paused: call.paused }) });
  const options = invocationOptions(); const call = await local.server.start({ callId: 'call_pause', facadeSecretRef: 'fixture-ref' }, options);
  await assert.rejects(call.pause(), { code: 'invalid-output' }); assert.equal(call.snapshot().paused, false);
  acknowledge = true; assert.deepEqual(await call.pause(), { acknowledged: true, paused: true });
  assert.equal(call.snapshot().pauses.length, 1); await call.pause(); assert.equal(call.snapshot().pauses.length, 1);
  await call.resume(); assert.ok(call.snapshot().pauses[0].to !== null); await call.close();
});
test('spend and browser-liveness expiry each settle one terminal even while paused', async () => {
  for (const mode of ['spendDeadlineAt', 'browserLivenessDeadlineAt']) {
    const local = fixture(), options = invocationOptions({ [mode]: Date.now() + 35 });
    const call = await local.server.start({ callId: 'call_expire', facadeSecretRef: 'fixture-ref' }, options);
    await call.pause(); await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(options.reports.length, 1); assert.equal(options.reports[0].outcome, 'uncertain');
    assert.equal(options.reports[0].chargedMicro, options.attempt.maxMicro); await call.close(); assert.equal(options.reports.length, 1);
  }
});
test('post-mint journal failure withholds credential and settles conservatively', async () => {
  const local = fixture({ saveCall: () => { throw new Error('journal failed'); } }), options = invocationOptions();
  await assert.rejects(local.server.start({ callId: 'call_failure', facadeSecretRef: 'fixture-ref' }, options));
  assert.equal(options.reports.length, 1); assert.equal(options.reports[0].outcome, 'uncertain');
});
test('START presentation overrides stay allowlisted and never carry provider configuration', async () => {
  const local = fixture(), options = invocationOptions();
  const session = await local.server.start({ callId: 'call_overrides', facadeSecretRef: 'fixture-ref',
    overrides: { agent: { language: 'de', firstMessage: '' } } }, options);
  assert.deepEqual(session.overrides, { agent: { language: 'de', firstMessage: '' } }); await session.close();
  const denied = invocationOptions();
  await assert.rejects(local.server.start({ callId: 'call_overrides_bad', facadeSecretRef: 'fixture-ref',
    overrides: { agent: { prompt: { customLlm: { apiKey: 'fake-not-allowed' } } } } }, denied), { code: 'provider' });
  assert.equal(denied.reports.length, 1); assert.equal(denied.reports[0].chargedMicro, 0);
});
test('spend expiry aborts an in-flight pause and closure polling settles exactly once', async () => {
  const local = fixture({ saveCall: (call, opts) => opts?.paused === true ? new Promise(() => {}) : { acknowledged: true, paused: call.paused } });
  const options = invocationOptions({ spendDeadlineAt: Date.now() + 45 });
  const session = await local.server.start({ callId: 'call_pause_stall', facadeSecretRef: 'fixture-ref' }, options);
  await assert.rejects(session.pause(), { code: 'deadline' });
  await session.close('spend-deadline', 'cancelled'); assert.equal(options.reports.length, 1);
  assert.equal(options.reports[0].outcome, 'uncertain'); await session.close();
});
test('server cancellation invalidates the call signal immediately and settles once without a browser', async () => {
  const local = fixture(), controller = new AbortController(), options = invocationOptions({ signal: controller.signal });
  const session = await local.server.start({ callId: 'call_server_cancel', facadeSecretRef: 'fixture-ref' }, options);
  controller.abort(); assert.equal(session.signal.aborted, true); assert.equal(session.snapshot().closing, true);
  await session.close(); assert.equal(options.reports.length, 1); assert.equal(options.reports[0].outcome, 'uncertain');
});
