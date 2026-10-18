import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceLifecycle, reduceVoiceLifecycle, voiceAuthorizationRevision } from '../src/voice-lifecycle.js';
import { createSession, applyEvent } from '../src/session.js';
import { createVoiceLifecycleController } from '../src/voice-lifecycle-controller.js';
import { PluginError } from '../src/invocation.js';

const step = (state, type, data = {}) => reduceVoiceLifecycle(state, { type, ...data });
const connected = () => step(step(createVoiceLifecycle('logical-call'), 'start'), 'connected', {
  providerSessionId: 'generation-1', authorizationRevision: 'auth-1', spendDeadlineAt: 5000, browserLivenessDeadlineAt: 3000,
});

for (const response of ['deferred', 'limit', 'http-429']) test(`AIT-346: ${response} heartbeat preserves the lease and does not recover`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
  let renewals = 0, replacements = 0, stops = 0, terminals = 0;
  const controller = createVoiceLifecycleController({ callId: 'busy-call',
    stopMedia() { stops++; }, terminal() { terminals++; },
    replace() { replacements++; throw new Error('Unexpected replacement'); },
    async renew() {
      if (++renewals > 1) return { acknowledged: true, browserLivenessDeadlineAt: 140_000 };
      if (response === 'limit') throw new PluginError('limit');
      if (response === 'http-429') throw Object.assign(new Error('Too many requests'), { status: 429 });
      return { acknowledged: true, deferred: true };
    } });
  t.after(() => controller.end('closed'));
  controller.connected({ providerSessionId: 'old', spendDeadlineAt: 160_000, browserLivenessDeadlineAt: 130_000 });
  const ack = await controller.heartbeat();
  assert.equal(ack.acknowledged, true); assert.equal(ack.deferred, true);
  assert.equal(controller.state.state, 'active'); assert.equal(controller.state.needsRecovery, false);
  assert.equal(controller.state.browserLivenessDeadlineAt, 130_000, 'deferral cannot extend the unrenewed lease');
  assert.equal(replacements, 0); assert.equal(stops, 0); assert.equal(terminals, 0);
  await controller.heartbeat(); assert.equal(controller.state.browserLivenessDeadlineAt, 140_000);
  for (let i = 0; i < 4; i++) t.mock.timers.tick(10_000);
  assert.equal(controller.state.needsRecovery, true, 'the actual lease deadline still stops media');
  assert.equal(stops, 1); assert.equal(replacements, 0); assert.equal(terminals, 0);
});

test('AIT-138 d: clock gap holds media synchronously and wake waits for explicit Resume', async t => {
  let clock = 100_000, stops = 0, replacements = 0;
  const controller = createVoiceLifecycleController({ callId: 'sleep-call', now: () => clock,
    stopMedia() { stops++; }, async replace() { replacements++; return { providerSessionId: 'new', browserLivenessDeadlineAt: clock + 30_000 }; } });
  t.after(() => controller.end('closed'));
  controller.connected({ providerSessionId: 'old', spendDeadlineAt: 200_000, browserLivenessDeadlineAt: 130_000 });
  clock += 20_000; controller.checkClock();
  assert.equal(stops, 1); assert.equal(controller.state.state, 'waiting');
  assert.equal(controller.state.needsRecovery, true); assert.equal(await controller.recover(), false);
  assert.equal(replacements, 0); assert.equal(await controller.recover({ explicit: true }), true);
  assert.equal(controller.state.state, 'paused', 'a replacement still inherits the sleep hold');
  controller.resumed(); assert.equal(controller.state.state, 'active');
});

test('AIT-138 d: ownership notification during replacement fences its late success', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let stops = 0;
  const controller = createVoiceLifecycleController({ callId: 'tabs', stopMedia() { stops++; },
    async replace() { entered.resolve(); return release.promise; } });
  t.after(() => { release.resolve(); controller.end('closed'); });
  controller.connected({ providerSessionId: 'old', epoch: 1, spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 30_000 });
  const recovering = controller.recover(); await entered.promise; controller.ownershipLost(2);
  assert.equal(controller.state.state, 'waiting'); assert.equal(stops, 2);
  release.resolve({ providerSessionId: 'stale', epoch: 1 });
  assert.equal(await recovering, false); assert.equal(controller.state.state, 'waiting');
  assert.equal(controller.state.providerSessionId, 'old');
});

test('AIT-138 d: lease expiry holds media synchronously without ending the logical call', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 }); let stops = 0;
  const controller = createVoiceLifecycleController({ callId: 'lease', stopMedia() { stops++; } });
  t.after(() => controller.end('closed'));
  controller.connected({ providerSessionId: 'old', spendDeadlineAt: 160_000, browserLivenessDeadlineAt: 105_000 });
  t.mock.timers.tick(5000);
  assert.equal(stops, 1); assert.equal(controller.state.state, 'waiting'); assert.equal(controller.state.callId, 'lease');
});

for (const timing of ['before recovery', 'during recovery']) test(`AIT-138 fix 1: heartbeat scheduled ${timing} cannot cut off a restored transport after its deadline`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let replacements = 0, renewals = 0, mediaStops = 0;
  const controller = createVoiceLifecycleController({ callId: 'logical-call',
    stopMedia() { mediaStops++; },
    async replace() { replacements++; entered.resolve(); return release.promise; },
    async renew(options) {
      renewals++;
      if (options.deadlineAt <= Date.now()) throw new PluginError('deadline');
      return { acknowledged: true, browserLivenessDeadlineAt: Date.now() + 30_000 };
    },
  });
  t.after(() => { release.resolve(); controller.end('closed'); });
  controller.connected({ providerSessionId: 'generation-1', spendDeadlineAt: 160_000, browserLivenessDeadlineAt: 130_000 });
  let beat;
  if (timing === 'before recovery') beat = controller.heartbeat({ deadlineAt: Date.now() + 5000 });
  const recovering = controller.recover(); await entered.promise;
  if (timing === 'during recovery') {
    controller.startHeartbeat(10_000); t.mock.timers.tick(10_000);
    await new Promise(resolve => setImmediate(resolve));
  }
  t.mock.timers.tick(6000);
  release.resolve({ providerSessionId: 'generation-2', browserLivenessDeadlineAt: Date.now() + 30_000 });
  assert.equal(await recovering, true); await beat; await new Promise(resolve => setImmediate(resolve));
  assert.equal(renewals, 0, 'the heartbeat from the retired transport is discarded before renewal');
  assert.equal(replacements, 1, 'the expired heartbeat must not initiate another cutover');
  assert.equal(mediaStops, 1); assert.equal(controller.state.state, 'active');
  assert.equal(controller.state.providerSessionId, 'generation-2');
  await controller.heartbeat({ deadlineAt: Date.now() + 5000 });
  assert.equal(renewals, 1, 'a fresh heartbeat renews the replacement normally');
});

test('AIT-138: start and replacements retain logical identity, deadlines and independent generation keys', () => {
  const idle = createVoiceLifecycle('logical-call'), connecting = step(idle, 'start');
  assert.equal(idle.state, 'idle'); assert.equal(connecting.state, 'connecting');
  let state = connected(); assert.equal(state.state, 'active');
  state = step(state, 'transport-lost'); assert.equal(state.state, 'recovering');
  state = step(state, 'recovery-attempt');
  state = step(state, 'connected', { providerSessionId: 'generation-2', spendDeadlineAt: 9999, browserLivenessDeadlineAt: 4000 });
  assert.equal(state.state, 'active'); assert.equal(state.callId, 'logical-call');
  assert.equal(state.providerGeneration, 2); assert.equal(state.spendDeadlineAt, 5000);
  assert.equal(state.attempts, 0, 'attempt allowance resets after each successful outage');
  assert.deepEqual(state.segments['generation-1'], { closureConfirmed: false });
});

for (const hold of ['pause', 'hide', 'freeze', 'pagehide']) {
  for (const phase of ['connecting', 'active', 'recovering']) test(`AIT-138: ${hold} during ${phase} is retained by a replacement`, () => {
    let state = phase === 'connecting' ? step(createVoiceLifecycle('logical-call'), 'start') : connected();
    if (phase === 'recovering') state = step(state, 'transport-lost');
    state = step(state, 'pause', { reason: hold }); assert.equal(state.state, 'paused');
    state = step(state, 'connected', { providerSessionId: 'generation-2' });
    assert.equal(state.state, 'paused'); assert.deepEqual(state.holds, [hold]);
    assert.equal(step(state, 'resume-requested').state, 'paused', 'request alone never unlocks capture');
    assert.equal(step(state, 'resume-acknowledged').state, 'active');
  });
}

test('AIT-138: loss while paused waits for Resume; liveness expiry and three failures wait without ending', () => {
  let state = step(connected(), 'pause'); state = step(state, 'transport-lost');
  assert.equal(state.state, 'paused'); assert.equal(state.needsRecovery, true);
  state = step(state, 'resume-acknowledged'); assert.equal(state.state, 'recovering');
  for (let i = 0; i < 3; i++) state = step(step(state, 'recovery-attempt'), 'recovery-failed');
  assert.equal(state.state, 'waiting'); assert.equal(state.attempts, 3);
  state = step(state, 'resume-acknowledged'); assert.equal(state.state, 'recovering'); assert.equal(state.attempts, 0);
  state = step(state, 'connected', { providerSessionId: 'generation-2' });
  assert.equal(step(state, 'lease-expired').state, 'waiting');
  assert.equal(step(state, 'budget-end').state, 'ended');
});

test('AIT-138: wake, takeover, lost ownership and restart require acknowledged Resume', () => {
  let state = step(connected(), 'sleep'); assert.equal(state.state, 'paused');
  state = step(state, 'wake'); assert.equal(state.state, 'waiting');
  state = step(state, 'takeover', { epoch: 2 }); assert.equal(state.epoch, 2); assert.equal(state.state, 'waiting');
  assert.equal(step(state, 'connected', { epoch: 1, providerSessionId: 'old' }), state);
  state = step(state, 'ownership-lost'); assert.equal(state.state, 'waiting');
  state = step(state, 'server-restart'); assert.equal(state.callId, 'logical-call'); assert.equal(state.needsRecovery, true);
});

for (const event of ['end', 'withdraw', 'budget-end', 'provider-end']) test(`AIT-138: ${event} is terminal across all late events`, () => {
  const ended = step(step(connected(), 'transport-lost'), event);
  assert.equal(ended.state, 'ended');
  for (const type of ['start', 'connected', 'resume-acknowledged', 'transport-lost', 'heartbeat', 'wake', 'takeover']) {
    assert.equal(step(ended, type, { providerSessionId: 'late' }), ended);
  }
});

test('AIT-138: cutover retains accepted input/operation and correction evidence, never fabricates heard text', () => {
  let state = step(connected(), 'partial');
  state = step(state, 'accepted', { turnId: 'accepted', operationId: 'callback-operation' });
  state = step(state, 'partial');
  state = step(state, 'reply', { replyId: 'reply-1' });
  state = step(state, 'heard', { prefix: 'Evidenced prefix' });
  const prior = structuredClone(state);
  state = step(state, 'transport-lost');
  assert.deepEqual(state.checkpoint.acceptedTurnIds, ['accepted']);
  assert.equal(state.checkpoint.operationId, 'callback-operation');
  assert.equal(state.checkpoint.userUnconfirmed, true); assert.equal(state.checkpoint.deliveryUncertain, true);
  assert.equal(state.checkpoint.heardPrefix, 'Evidenced prefix');
  assert.deepEqual(prior.checkpoint.acceptedTurnIds, ['accepted'], 'reduction is pure');
  state = step(state, 'connected', { providerSessionId: 'generation-2' });
  assert.equal(state.checkpoint.operationId, 'callback-operation', 'checkpoint is bookkeeping, never a cross-generation alias');
});

test('AIT-138: transcript/assessment revisions do not revoke voice, ownership/consent/settings/withdrawal do', () => {
  const session = createSession(), revision = voiceAuthorizationRevision(session);
  const appended = applyEvent(session, { type: 'turn.final', seq: 1, data: { id: 'turn', role: 'user', content: 'Hello' } });
  assert.equal(voiceAuthorizationRevision(appended), revision);
  assert.equal(voiceAuthorizationRevision({ ...appended, sessionRevision: 99, understanding: {} }), revision);
  for (const data of [{ ownerHash: 'other' }, { consentWithdrawn: true }, { withdrawalRevision: 1 }, { consentRevision: 1 },
    { settings: { ...session.settings, revision: 1 } }, { processingPreset: 'device' }, { tombstone: 'erased' }, { locale: 'de' }]) {
    assert.notEqual(voiceAuthorizationRevision({ ...session, ...data }), revision);
  }
});

test('AIT-138: late segment reconciliation cannot overwrite a successor or resurrect terminal intent', () => {
  let state = step(step(connected(), 'transport-lost'), 'connected', { providerSessionId: 'generation-2' });
  state = step(state, 'segment-closed', { providerSessionId: 'generation-1', closureConfirmed: true });
  assert.equal(state.state, 'active'); assert.equal(state.providerSessionId, 'generation-2');
  assert.deepEqual(state.segments['generation-1'], { closureConfirmed: true });
  state = step(state, 'end');
  state = step(state, 'segment-closed', { providerSessionId: 'generation-2', closureConfirmed: true });
  assert.equal(state.state, 'ended'); assert.equal(state.segments['generation-2'].closureConfirmed, true);
});
