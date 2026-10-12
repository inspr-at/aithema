import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceLifecycle, reduceVoiceLifecycle, voiceAuthorizationRevision } from '../src/voice-lifecycle.js';
import { createSession, applyEvent } from '../src/session.js';

const step = (state, type, data = {}) => reduceVoiceLifecycle(state, { type, ...data });
const connected = () => step(step(createVoiceLifecycle('logical-call'), 'start'), 'connected', {
  providerSessionId: 'generation-1', authorizationRevision: 'auth-1', spendDeadlineAt: 5000, browserLivenessDeadlineAt: 3000,
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
