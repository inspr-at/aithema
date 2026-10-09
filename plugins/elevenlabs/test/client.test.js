import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveVoiceConformance } from '../../../packages/core/src/live-voice-conformance.js';
import { unavailableVoiceCommand } from '../../../packages/core/src/live-voice.js';
import { fixture, invocationOptions, flush, fakeSdk } from './fixtures.js';

async function drain(session) { const events = []; for await (const event of session.events) events.push(event); return events; }
test('relative credential TTL accepts a receipt even when the server clock is behind the browser', async () => {
  const local = fixture({ now: () => Date.now() - 120_000 });
  try {
    const session = await local.client.start({ callId: 'call_clock_skew' }, invocationOptions());
    assert.equal(local.sdk.starts.length, 1); await session.close();
  } finally { for (const session of local.sessions.values()) await session.close(); }
});
test('close without options has a configurable default timeout for a stalled control port', async () => {
  const local = fixture({ closeTimeoutMs: 40 }), originalClose = local.control.close;
  const options = invocationOptions(), session = await local.client.start({ callId: 'call_close_timeout' }, options);
  let release; local.control.close = () => new Promise(resolve => { release = resolve; });
  const pending = session.close().then(() => 'resolved', error => error.code);
  try {
    assert.equal(await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('stalled'), 100))]), 'deadline');
    assert.equal((await drain(session)).at(-1).reason, 'closure-uncertain');
  } finally {
    release?.(await originalClose({ providerSessionId: session.providerSessionId, reason: 'closed' })); await pending;
  }
});
test('SDK 1.17.0 onError contexts preserve the active call; onDisconnect drives recovery', async () => {
  const local = fixture(); let recoveries = 0;
  local.control.recover = async () => { recoveries++; throw new Error('fixture transport unavailable'); };
  const options = invocationOptions(), session = await local.client.start({ callId: 'call_error_scope' }, options);
  const callbacks = local.sdk.starts[0];
  callbacks.onError('Client tool failed', { clientToolName: 'fixture_tool', toolCallId: 'fixture_tool_call' });
  callbacks.onError('Server error', { errorType: 'agent_error' });
  callbacks.onError('Failed to end session after agent end_call', new Error('fixture endSession failure'));
  await flush(); assert.equal(recoveries, 0); assert.equal(local.sdk.closed, false); assert.equal(options.reports.length, 0);
  await session.sendText('still active');
  const reader = drain(session); callbacks.onDisconnect({ reason: 'error' });
  const events = await reader; assert.equal(recoveries, 3); assert.equal(events[0].type, 'recovering');
  assert.equal(events.at(-1).type, 'ended');
});
test('SDK commands preserve independent channels; pause/resume change them only after server acknowledgement', async () => {
  let release; const local = fixture();
  const pause = local.control.pause;
  local.control.pause = async (...args) => { await new Promise(resolve => { release = resolve; }); return pause(...args); };
  const session = await local.client.start({ callId: 'call_commands' }, invocationOptions());
  await session.setInput(false); await session.setOutput(false);
  await session.sendText('typed input'); await session.updateContext({ focus: 'next' });
  await session.setInput(true);
  const interrupt = session.interrupt(); await flush(); local.sdk.interrupt(); await interrupt; await session.setInput(false);
  assert.ok(local.sdk.effects.some(([name, value]) => name === 'sendUserMessage' && value === 'typed input'));
  assert.ok(local.sdk.effects.some(([name, value]) => name === 'sendContextualUpdate' && JSON.parse(value).focus === 'next'));
  assert.ok(local.sdk.effects.some(([name]) => name === 'nativeInterruption'));
  const before = local.sdk.effects.length, pending = session.pause(); await flush();
  assert.equal(local.sdk.effects.length, before); release(); assert.deepEqual(await pending, { acknowledged: true, paused: true });
  assert.deepEqual(local.sdk.effects.slice(-2), [['setMicMuted', true], ['setVolume', 0]]);
  await assert.rejects(session.sendText('while paused'), { code: 'not-admitted' });
  await session.resume(); assert.deepEqual(local.sdk.effects.slice(-2), [['setMicMuted', true], ['setVolume', 0]]);
  await session.setInput(true); assert.deepEqual(local.sdk.effects.slice(-2), [['setMicMuted', false], ['setVolume', 0]]);
  await session.setOutput(true); assert.deepEqual(local.sdk.effects.slice(-2), [['setMicMuted', false], ['setVolume', 1]]);
  const reader = drain(session); const terminal = await session.close(); assert.equal(terminal.closureConfirmed, true);
  assert.equal((await reader).at(-1).type, 'ended');
  await assert.rejects(session.sendText('ended'), { code: 'unavailable' });
});
test('final turns are persisted once; tentative captions and genuine heard corrections retain provider identity', async () => {
  const local = fixture(), session = await local.client.start({ callId: 'call_transcript' }, invocationOptions());
  const sdk = local.sdk.starts[0], events = drain(session);
  sdk.onModeChange({ mode: 'listening' });
  sdk.onDebug({ type: 'tentative_user_transcript', tentative_user_transcription_event: { user_transcript: 'hel' } });
  sdk.onMessage({ role: 'user', message: 'hello', event_id: 1 });
  sdk.onMessage({ role: 'user', message: 'hello', event_id: 1 });
  sdk.onModeChange({ mode: 'speaking' });
  sdk.onMessage({ role: 'agent', message: 'Hello there, how are you?', event_id: 2 });
  sdk.onAgentResponseCorrection({ event_id: 2, original_agent_response: 'Hello there, how are you?', corrected_agent_response: 'Hello there,' });
  sdk.onAgentResponseCorrection({ event_id: 999, original_agent_response: 'Hello there, how are you?', corrected_agent_response: 'Hello' });
  sdk.onAgentResponseCorrection({ event_id: 2, original_agent_response: 'Hello there, how are you?', corrected_agent_response: 'fabricated words' });
  await session.close(); const observed = await events;
  assert.deepEqual(observed.map(event => event.type), ['listening', 'partial', 'final', 'speaking', 'final', 'heard', 'ended']);
  assert.equal(observed[5].turnId, observed[4].turnId); assert.equal(observed[5].prefix, 'Hello there,');
  assert.deepEqual(local.persisted.map(event => event.type), ['final', 'final', 'heard']);
  assert.equal(local.sdk.starts[0].customLlmExtraBody.aithema_call, session.callId);
  assert.equal(JSON.stringify(local.sdk.starts[0]).includes('fixture-api-key'), false);
  assert.equal(JSON.stringify(local.sdk.starts[0]).includes('fixture-facade-ref'), false);
});
test('typed and context commands never invent final turns or heard text', async () => {
  const local = fixture(), session = await local.client.start({ callId: 'call_no_fabrication' }, invocationOptions()), reader = drain(session);
  await session.sendText('hello'); await session.updateContext('context');
  const interrupt = session.interrupt(); await flush(); local.sdk.interrupt(); await interrupt;
  await session.close(); assert.deepEqual((await reader).map(event => event.type), ['ended']); assert.deepEqual(local.persisted, []);
});
test('browser heartbeat extends its server lease, while spend deadline stays fixed', async () => {
  const local = fixture(), options = invocationOptions({ browserLivenessDeadlineAt: Date.now() + 200 });
  const session = await local.client.start({ callId: 'call_heartbeat' }, options), initial = [...local.sessions.values()][0].snapshot();
  await new Promise(resolve => setTimeout(resolve, 20)); const ack = await session.heartbeat();
  assert.ok(ack.browserLivenessDeadlineAt > initial.browserLivenessDeadlineAt);
  assert.equal([...local.sessions.values()][0].snapshot().spendDeadlineAt, initial.spendDeadlineAt); await session.close();
});
test('pre-cancelled and expired commands reject without touching SDK state', async () => {
  const local = fixture(), session = await local.client.start({ callId: 'call_cancel' }, invocationOptions());
  const count = local.sdk.effects.length, controller = new AbortController(); controller.abort();
  await assert.rejects(session.setInput(false, { signal: controller.signal }), { code: 'cancelled' });
  await assert.rejects(session.sendText('no', { deadlineAt: Date.now() - 1 }), { code: 'deadline' });
  assert.equal(local.sdk.effects.length, count); await session.close();
});
test('native interrupt waits for real acknowledgement; deadline/cancel/mute never manufacture it', async () => {
  const local = fixture(), session = await local.client.start({ callId: 'call_native_interrupt' }, invocationOptions()), reader = drain(session);
  await assert.rejects(session.interrupt({ deadlineAt: Date.now() + 25 }), { code: 'deadline' });
  const controller = new AbortController(), pending = session.interrupt({ signal: controller.signal });
  await flush(); controller.abort(); await assert.rejects(pending, { code: 'cancelled' });
  await session.setInput(false); await assert.rejects(session.interrupt(), { code: 'unavailable' });
  await session.close(); assert.deepEqual((await reader).map(event => event.type), ['ended']);
  assert.equal(local.sdk.effects.some(([method]) => method === 'nativeInterruption'), false);
});
test('three failed fresh recovery admissions return ended control; stale callbacks are ignored', async () => {
  const local = fixture(); let attempts = 0;
  local.control.recover = async () => { attempts++; throw new Error('fake unavailable'); };
  const session = await local.client.start({ callId: 'call_recover_fail' }, invocationOptions()), reader = drain(session);
  local.sdk.starts[0].onDisconnect({ reason: 'error' }); await flush();
  local.sdk.starts[0].onMessage({ role: 'agent', message: 'stale words', event_id: 22 });
  const events = await reader; assert.equal(attempts, 3); assert.equal(events[0].type, 'recovering');
  assert.equal(events.at(-1).reason, 'recovery-failed'); assert.equal(events.some(event => event.type === 'final'), false);
});
test('successful reconnect uses a new admitted attempt, keeps call identity and ignores old generation', async () => {
  const local = fixture(), initial = invocationOptions(), recoverOptions = invocationOptions();
  local.control.recover = ({ callId }, options) => local.control.start({ callId }, { ...recoverOptions, ...options });
  const session = await local.client.start({ callId: 'call_recovered' }, initial), original = session.providerSessionId, reader = drain(session);
  local.sdk.starts[0].onDisconnect({ reason: 'error' }); await flush(); await flush();
  assert.notEqual(session.providerSessionId, original); assert.equal(session.callId, 'call_recovered');
  local.sdk.starts[0].onMessage({ role: 'agent', message: 'old', event_id: 1 });
  local.sdk.starts[1].onMessage({ role: 'user', message: 'new', event_id: 1 });
  await session.close(); const events = await reader;
  assert.deepEqual(events.map(event => event.type), ['recovering', 'recovered', 'final', 'ended']);
  assert.equal(initial.reports.length, 1); assert.equal(recoverOptions.reports.length, 1);
  assert.notEqual(initial.reports[0].attemptId, recoverOptions.reports[0].attemptId);
});
test('late SDK success after cancellation is closed and the server attempt is settled', async () => {
  const real = fakeSdk(); let resolve, pendingOptions;
  const sdk = { startSession: options => { pendingOptions = options; return new Promise(r => { resolve = r; }); } };
  const local = fixture({ sdk: { ...sdk, get closed() { return real.closed; } } });
  const controller = new AbortController(), options = invocationOptions({ signal: controller.signal });
  const pending = local.client.start({ callId: 'call_late' }, options); await flush(); controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  const late = await real.startSession(pendingOptions); resolve(late); await flush();
  assert.equal(real.closed, true); assert.equal(options.reports.length, 1);
});
function conformanceFixture(local) {
  return {
    requestCount: () => local.requests.length + local.sdk.starts.length,
    persistedEvents: () => local.persisted,
    probe(command, session, { phase, before } = {}) {
      if (command === 'close') return { providerOpen: !local.sdk.closed };
      if (phase === 'before') return { effects: local.sdk.effects.length, saved: local.saved.length };
      const sdkMethod = { sendText: 'sendUserMessage', updateContext: 'sendContextualUpdate', setInput: 'setMicMuted',
        setOutput: 'setVolume', interrupt: 'nativeInterruption' }[command];
      return { capability: ['pause', 'resume', 'setOutput'].includes(command) ? 'emulated' : 'native',
        applied: sdkMethod ? local.sdk.effects.slice(before.effects).some(([method]) => method === sdkMethod)
          : local.saved.slice(before.saved).some(record => record.paused === (command === 'pause')) };
    },
    async drive(session, stimulus) {
      if (stimulus?.command === 'interrupt') { await flush(); local.sdk.interrupt(); return; }
      const callbacks = local.sdk.starts.at(-1), provider = session.providerSessionId, callId = session.callId;
      callbacks.onDebug({ type: 'tentative_user_transcript', tentative_user_transcription_event: { user_transcript: 'hel' } });
      callbacks.onMessage({ role: 'user', message: 'hello', event_id: 10 });
      callbacks.onMessage({ role: 'agent', message: 'Hello there', event_id: 11 });
      callbacks.onAgentResponseCorrection({ event_id: 11, original_agent_response: 'Hello there', corrected_agent_response: 'Hello' });
      return [
        { type: 'partial', turnId: `${provider}:user:pending`, role: 'user', text: 'hel', callId },
        { type: 'final', turnId: `${provider}:user:10`, role: 'user', text: 'hello', callId },
        { type: 'final', turnId: `${provider}:assistant:11`, role: 'assistant', text: 'Hello there', callId },
        { type: 'heard', turnId: `${provider}:assistant:11`, prefix: 'Hello', callId },
      ];
    },
  };
}
test('live-voice conformance rejects a plugin that lies about closure in every dispatched mode', async () => {
  const realSdk = fakeSdk(), sdk = { ...realSdk, get closed() { return realSdk.closed; },
    async startSession(options) { const session = await realSdk.startSession(options); return { ...session, endSession: async () => {} }; } };
  const local = fixture({ sdk, providerDetails: id => ({ conversation_id: id, status: 'done', metadata: { call_duration_secs: 1 } }) });
  const result = await liveVoiceConformance(local.plugin, { callId: 'call_lying' }, conformanceFixture(local));
  assert.equal(result.ok, false);
  for (const mode of ['completed', 'active-cancelled', 'spend-deadline', 'browser-liveness-deadline']) {
    assert.ok(result.failures.includes(`${mode} provider still open or closure observation missing`), `${mode}: ${result.failures}`);
  }
});
test('live-voice conformance requires true closure confirmation for every non-uncertain terminal', async () => {
  const local = fixture(), kit = conformanceFixture(local);
  const plugin = { ...local.plugin, start: (request, options) => local.plugin.start(request, {
    ...options, report: terminal => options.report({ ...terminal, closureConfirmed: false }),
  }) };
  const result = await liveVoiceConformance(plugin, { callId: 'call_unconfirmed' }, kit);
  for (const mode of ['completed', 'cancelled', 'deadline', 'active-cancelled', 'spend-deadline', 'browser-liveness-deadline']) {
    assert.ok(result.failures.includes(`${mode} terminal did not confirm provider closure`), `${mode}: ${result.failures}`);
  }
});
test('live-voice conformance fails closed without an independent closure observation', async () => {
  const local = fixture(), kit = conformanceFixture(local), probe = kit.probe;
  kit.probe = (...args) => args[0] === 'close' ? {} : probe(...args);
  const result = await liveVoiceConformance(local.plugin, { callId: 'call_unobserved' }, kit);
  assert.equal(result.ok, false); assert.ok(result.failures.includes('completed provider still open or closure observation missing'));
});
test('live-voice conformance passes joined ElevenLabs halves and rejects broken behaviour and capability claims', async () => {
  const local = fixture(), kit = conformanceFixture(local);
  assert.deepEqual(await liveVoiceConformance(local.plugin, { callId: 'call_conformance' }, kit), { ok: true, failures: [] });
  assert.deepEqual(await liveVoiceConformance({ ...local.plugin, manifest: {} }, { callId: 'call_invalid' }, kit),
    { ok: false, failures: ['manifest validity'] });
  const broken = { ...local.plugin, async start(request, options) {
    const session = await local.plugin.start(request, { ...options, report() {} });
    session.sendText = async () => {}; return session;
  } };
  const result = await liveVoiceConformance(broken, { callId: 'call_broken' }, kit);
  assert.equal(result.ok, false); assert.ok(result.failures.some(message => message.includes('terminal count')));
  assert.ok(result.failures.includes('sendText capability differs from behaviour'));
  const fabricated = { ...local.plugin, async start(request, options) {
    const session = await local.plugin.start(request, options);
    local.sdk.starts.at(-1).onMessage({ role: 'agent', message: 'fabricated extra turn', event_id: 777 });
    return session;
  } };
  assert.ok((await liveVoiceConformance(fabricated, { callId: 'call_fabricated' }, kit)).failures.includes('fabricated or missing transcript/heard event'));
  const unavailable = unavailableVoiceCommand('sendText'); await assert.rejects(unavailable(), { code: 'unavailable', message: 'Live voice sendText is unavailable' });
  const mismatched = { ...local.plugin, manifest: { ...local.plugin.manifest, liveVoice: {
    ...local.plugin.manifest.liveVoice, capabilities: { ...local.plugin.manifest.liveVoice.capabilities, setOutput: 'native' } } } };
  assert.ok((await liveVoiceConformance(mismatched, { callId: 'call_mismatch' }, kit)).failures.includes('setOutput capability differs from behaviour'));
});
