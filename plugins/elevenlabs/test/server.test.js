import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintConversationCredential, reconcileUsage, createVoiceBinding } from '../src/server.js';
import { validateManifest, PluginRegistry } from '../../../packages/core/src/plugins.js';
import { manifest } from '../src/manifest.js';
import { fixture, binding, invocationOptions } from './fixtures.js';

test('token and signed URL minting use configured agent, runtime secret and a fake API', async () => {
  const local = fixture();
  for (const transport of ['webrtc', 'websocket']) {
    const credential = await mintConversationCredential(binding, { transport }, { deadlineAt: Date.now() + 1000 },
      { fetchImpl: local.fetchImpl, resolveSecret: ref => { assert.equal(ref, binding.secretRef); return 'fake-runtime-key'; } });
    const request = local.requests.at(-1);
    assert.equal(request.url.searchParams.get('agent_id'), binding.agentId);
    assert.equal(request.options.headers['xi-api-key'], 'fake-runtime-key');
    assert.equal(request.options.redirect, 'error');
    assert.equal(credential.connectionType, transport); assert.ok(credential.providerSessionId); assert.ok(credential.expiresAt > Date.now());
    assert.equal(JSON.stringify(credential).includes('fake-runtime-key'), false);
    if (transport === 'websocket') assert.equal(request.url.searchParams.get('include_conversation_id'), 'true');
  }
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
  options.attempt.consume = () => { assert.equal(local.requests.length, 0); consumed = true; consume(); };
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
test('in-flight pause cannot hold terminal settlement past the spend deadline', async () => {
  const local = fixture({ saveCall: (call, opts) => opts?.paused === true ? new Promise(() => {}) : { acknowledged: true, paused: call.paused } });
  const options = invocationOptions({ spendDeadlineAt: Date.now() + 45 });
  const session = await local.server.start({ callId: 'call_pause_stall', facadeSecretRef: 'fixture-ref' }, options);
  await assert.rejects(session.pause(), { code: 'deadline' });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(options.reports.length, 1);
  assert.equal(options.reports[0].outcome, 'uncertain'); await session.close();
});
test('server cancellation invalidates the call signal immediately and settles once without a browser', async () => {
  const local = fixture(), controller = new AbortController(), options = invocationOptions({ signal: controller.signal });
  const session = await local.server.start({ callId: 'call_server_cancel', facadeSecretRef: 'fixture-ref' }, options);
  controller.abort(); assert.equal(session.signal.aborted, true); assert.equal(session.snapshot().closing, true);
  await session.close(); assert.equal(options.reports.length, 1); assert.equal(options.reports[0].outcome, 'uncertain');
});
