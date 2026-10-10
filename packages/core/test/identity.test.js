import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTOR_ROLES, createIdentity, identityView, reduceIdentity, createSession, applyEvent } from '../src/index.js';
const createLockedIdentity = options => createIdentity({ verificationRequired: true, ...options });
const email = 'visitor@example.test';
const step = (state, type, data = {}, now = state.lastNow) => reduceIdentity(state, { type, now, ...data });
const request = (s = createLockedIdentity(), now = 0) => step(s, 'request-verification', { address: email }, now);
const confirm = (s, now = s.lastNow, data = {}) => step(s, 'verification', {
  address: s.address, revision: s.verificationRevision, verified: true, ...data }, now);
const delivery = (s, status = 'sent', now = s.lastNow) => step(s, 'delivery', {
  address: s.address, revision: s.verificationRevision, status }, now).state;

test('host policy defaults off; an explicit lock requires verification without claiming guests are verified', () => {
  const guest = createIdentity(), view = identityView(guest, 0);
  assert.equal(view.verificationRequired, false);
  assert.equal(view.status, 'guest'); assert.equal(view.address, null); assert.equal(view.demoBypass, false);
  assert.equal(view.assessmentUnlocked, true); assert.equal(view.conceptsUnlocked, true);
  const pending = request(guest).state;
  assert.equal(identityView(pending, 0).assessmentUnlocked, true);
  assert.equal(identityView(pending, 0).conceptsUnlocked, true);
  assert.equal(identityView(createLockedIdentity(), 0).assessmentUnlocked, false);
});

test('session identification follows verified status rather than unlocked surfaces or demo bypass', () => {
  for (const demoBypass of [false, true]) {
    let session = createSession(), identity = createIdentity({ demoBypass });
    const project = () => {
      session = applyEvent(session, { seq: session.seq + 1, type: 'identity.state', data: identityView(identity, identity.lastNow) });
    };
    project();
    assert.equal(session.identity.assessmentUnlocked, true); assert.equal(session.identified, false);
    assert.equal(session.sessionRevision, 0);
    identity = request(identity).state; project();
    assert.equal(session.identified, false); assert.equal(session.sessionRevision, 0);
    identity = confirm(identity).state; project();
    assert.equal(session.identified, true); assert.equal(session.sessionRevision, 1);
    identity = step(identity, 'change-address', { address: 'changed@example.test' }).state; project();
    assert.equal(session.identity.assessmentUnlocked, true); assert.equal(session.identified, false);
    assert.equal(session.sessionRevision, 2);
  }
});

test('host policy removal unlocks without verification, preserves identity facts and emits once', () => {
  let s = request().state;
  s = step(s, 'confirmation-attempt').state;
  s = step(s, 'pause', { origin: 'manual', paused: true }).state;
  const result = step(s, 'policy', { origin: 'host', verificationRequired: false }, 1);
  assert.deepEqual(result.state, { ...s, verificationRequired: false, lastNow: 1 });
  assert.deepEqual(result.events[0], { type: 'identity.policy-changed',
    data: { verificationRequired: false, reason: 'host-policy-disabled' } });
  assert.equal(result.events[1].type, 'identity.state');
  assert.equal(result.events[1].data.status, 'verification-pending');
  assert.equal(result.events[1].data.assessmentUnlocked, true);
  assert.equal(result.events[1].data.canRunAssessment, false);
  assert.deepEqual(step(result.state, 'policy', { origin: 'host', verificationRequired: false }, 2).events, []);
  for (const data of [{ verificationRequired: false }, { origin: 'visitor', verificationRequired: false },
    { origin: 'host', verificationRequired: true }]) assert.throws(() => step(s, 'policy', data));
});

test('explicit policy locks guests; verification emits unlock and renderable actor state', () => {
  const guest = createLockedIdentity();
  assert.equal(identityView(guest, 0).assessmentUnlocked, false);
  assert.deepEqual(guest.roles, ACTOR_ROLES);
  const pending = request(guest);
  assert.equal(pending.state.status, 'verification-pending');
  assert.equal(pending.events[0].type, 'verification.requested');
  assert.equal(pending.events.at(-1).data.pollVerification, true);
  assert.equal(pending.events.at(-1).data.conceptsUnlocked, false);
  const verified = confirm(delivery(pending.state));
  assert.equal(verified.state.status, 'verified');
  assert.equal(verified.events[0].type, 'identity.unlocked');
  assert.equal(verified.events.at(-1).data.canRunAssessment, true);
  assert.equal(verified.events.at(-1).data.canRunConcepts, true);
  assert.deepEqual(guest, createLockedIdentity());
});

test('roles are selected independently of verification and use the configured taxonomy', () => {
  let s = createLockedIdentity({ roles: ['person', 'team'] });
  s = step(s, 'role', { role: 'team' }).state;
  s = confirm(request(s).state).state;
  assert.equal(s.role, 'team');
  assert.throws(() => step(s, 'role', { role: 'agency' }), /Unknown actor role/);
  assert.equal(step(s, 'role', { role: null }).state.role, null);
});

test('resend observes exact cooldown boundary and binds a new verification revision', () => {
  let s = delivery(request().state);
  const old = structuredClone(s);
  const blocked = step(s, 'resend', {}, 59_999);
  assert.equal(blocked.state.verificationRevision, s.verificationRevision);
  assert.equal(blocked.resendBlocked, true);
  assert.deepEqual(blocked.events, []);
  assert.equal(identityView(blocked.state, 59_999).resendAfterMs, 1);
  s = step(blocked.state, 'resend', {}, 60_000).state;
  assert.equal(s.verificationRevision, old.verificationRevision + 1);
  assert.equal(s.expiresAt, 60_000 + s.policy.verificationTtlMs);
  assert.equal(confirm(s, 60_000, { revision: old.verificationRevision }).state.status, 'verification-pending');
  assert.equal(confirm(s, 60_000).state.status, 'verified');
});

test('single-flight delivery and failure feedback never claim a mail was sent', () => {
  let s = request().state;
  assert.equal(s.delivery, 'requested');
  const blocked = step(s, 'resend', {}, 59_999);
  assert.equal(blocked.resendBlocked, true);
  assert.deepEqual(blocked.events, []);
  s = delivery(blocked.state, 'failed', 60_000);
  assert.equal(identityView(s, 60_000).canResend, true);
  assert.equal(s.status, 'verification-pending');
  s = step(s, 'resend', {}, 60_000).state;
  assert.equal(s.delivery, 'requested');
});

test('a lost delivery result permits resend at resendAt and stale delivery results stay inert', () => {
  const original = request().state;
  assert.equal(identityView(original, original.resendAt - 1).canResend, false);
  assert.equal(identityView(original, original.resendAt).canResend, true);
  const resent = step(original, 'resend', {}, original.resendAt);
  assert.equal(resent.events[0].type, 'verification.requested');
  assert.equal(resent.state.verificationRevision, original.verificationRevision + 1);
  assert.equal(resent.state.delivery, 'requested');
  for (const status of ['sent', 'failed']) {
    const stale = step(resent.state, 'delivery', { address: original.address,
      revision: original.verificationRevision, status });
    assert.equal(stale.state.delivery, 'requested');
  }
  assert.equal(delivery(resent.state).delivery, 'sent');
});

test('changing an address revokes verification, preserves role/pause and invalidates old responses', () => {
  let s = step(createLockedIdentity(), 'role', { role: 'company' }).state;
  s = confirm(request(s).state).state;
  const old = structuredClone(s);
  s = step(s, 'pause', { origin: 'manual', paused: true }).state;
  s = step(s, 'change-address', { address: 'new@example.test' }).state;
  assert.equal(s.status, 'verification-pending');
  assert.equal(s.role, 'company');
  assert.equal(s.manualPaused, true);
  assert.equal(identityView(s, 0).assessmentUnlocked, false);
  assert.equal(confirm(s, 0, { address: old.address, revision: old.verificationRevision }).state.status, 'verification-pending');
  assert.equal(step(s, 'delivery', { address: old.address, revision: old.verificationRevision, status: 'sent' }).state.delivery, 'idle');
  assert.equal(step(s, 'resend', {}, 1).resendBlocked, true);
  assert.deepEqual(step(s, 'resend', {}, 1).events, []);
  s = step(s, 'resend', {}, 60_000).state;
  assert.equal(confirm(s, 60_000).state.status, 'verified');
});

test('inline submission of a different address relocks immediately during cooldown', () => {
  const s = confirm(request().state).state;
  const result = step(s, 'request-verification', { address: 'other@example.test' }, 1);
  assert.equal(result.state.status, 'verification-pending');
  assert.equal(result.state.expiresAt, null);
  assert.equal(result.events[0].type, 'identity.resend-blocked');
});

test('expiry rejects an exact-boundary confirmation; resend renews without reviving old evidence', () => {
  let s = request().state;
  const oldRevision = s.verificationRevision;
  s = confirm(s, s.expiresAt).state;
  assert.equal(s.expired, true);
  assert.equal(s.delivery, 'failed');
  assert.equal(identityView(s, s.lastNow).pollVerification, false);
  assert.equal(identityView(s, s.lastNow).canResend, true);
  s = step(s, 'resend').state;
  assert.equal(s.expired, false);
  assert.equal(confirm(s, s.lastNow, { revision: oldRevision }).state.status, 'verification-pending');
  assert.equal(confirm(s).state.status, 'verified');
});

test('polling confirmation unlocks both surfaces while retaining manual pause', () => {
  let s = request().state;
  s = step(s, 'pause', { origin: 'manual', paused: true }).state;
  s = confirm(s).state;
  const view = identityView(s, 0);
  assert.equal(view.assessmentUnlocked, true);
  assert.equal(view.conceptsUnlocked, true);
  assert.equal(view.canRunAssessment, false);
  assert.equal(view.canRunConcepts, false);
  s = step(s, 'pause', { origin: 'manual', paused: false }).state;
  assert.equal(identityView(s, 0).canRunAssessment, true);
});

test('hidden confirmation keeps visibility pause until return and never clears manual pause', () => {
  let s = request().state;
  s = step(s, 'pause', { origin: 'visibility', paused: true }).state;
  s = step(s, 'pause', { origin: 'manual', paused: true }).state;
  s = step(s, 'visibility', { visible: false }).state;
  s = confirm(s).state;
  assert.equal(s.visibilityPaused, true);
  s = step(s, 'visibility', { visible: true }).state;
  assert.equal(s.visibilityPaused, false);
  assert.equal(s.manualPaused, true);
});

test('visible confirmation may release an automatic pause', () => {
  let s = request().state;
  s = step(s, 'pause', { origin: 'visibility', paused: true }).state;
  assert.equal(confirm(s).state.visibilityPaused, false);
});

test('an ordinary blur after verification remains paused on return', () => {
  let s = confirm(request().state).state;
  s = step(s, 'pause', { origin: 'visibility', paused: true }).state;
  s = step(s, 'visibility', { visible: false }).state;
  s = step(s, 'visibility', { visible: true }).state;
  assert.equal(s.visibilityPaused, true);
  assert.equal(identityView(s, 0).canRunAssessment, false);
  assert.equal(identityView(s, 0).canRunConcepts, false);
});

test('the verification detour releases visibility only once', () => {
  let s = step(request().state, 'visibility', { visible: false }).state;
  s = step(s, 'pause', { origin: 'visibility', paused: true }).state;
  s = confirm(s).state;
  assert.equal(s.releaseVisibilityOnReturn, true);
  s = step(s, 'visibility', { visible: true }).state;
  assert.equal(s.releaseVisibilityOnReturn, false);
  assert.equal(s.visibilityPaused, false);
  s = step(s, 'pause', { origin: 'visibility', paused: true }).state;
  s = step(s, 'visibility', { visible: false }).state;
  assert.equal(step(s, 'visibility', { visible: true }).state.visibilityPaused, true);
});

test('new visibility pauses and address changes cancel a pending detour release', () => {
  const hidden = step(request().state, 'visibility', { visible: false }).state;
  const verified = confirm(hidden).state;
  for (const s of [step(verified, 'pause', { origin: 'visibility', paused: true }).state,
    step(step(verified, 'pause', { origin: 'visibility', paused: true }).state,
      'change-address', { address: 'changed@example.test' }).state]) {
    assert.equal(step(s, 'visibility', { visible: true }).state.visibilityPaused, true);
    assert.equal(s.releaseVisibilityOnReturn, false);
  }
});

test('demo bypass opens surfaces without asserting a verified address', () => {
  const s = createLockedIdentity({ demoBypass: true });
  const view = identityView(s, 0);
  assert.equal(view.status, 'guest');
  assert.equal(view.assessmentUnlocked, true);
  assert.equal(view.conceptsUnlocked, true);
  assert.equal(view.address, null);
});

test('only a host demo revocation event can remove bypass; events cannot grant it', () => {
  const demo = createLockedIdentity({ demoBypass: true });
  const revoked = step(demo, 'demo', { origin: 'host', enabled: false }).state;
  assert.equal(identityView(revoked, 0).assessmentUnlocked, false);
  assert.equal(identityView(revoked, 0).conceptsUnlocked, false);
  assert.equal(revoked.status, 'guest');
  for (const data of [{ enabled: false }, { origin: 'visitor', enabled: false },
    { origin: 'host', enabled: true }]) assert.throws(() => step(demo, 'demo', data));
  const verified = confirm(request(demo).state).state;
  assert.equal(identityView(step(verified, 'demo', { origin: 'host', enabled: false }).state, 0).assessmentUnlocked, true);
});

test('false or stale polling replies are inert and repeated confirmations emit no second unlock', () => {
  const s = request().state;
  for (const change of [{ verified: false }, { revision: 99 }, { address: 'wrong@example.test' }]) {
    assert.equal(confirm(s, 0, change).state.status, 'verification-pending');
    assert.deepEqual(confirm(s, 1, change).events, []);
  }
  const verified = confirm(s).state;
  assert.deepEqual(confirm(verified, 1).events, []);
});

test('confirmation attempts are bounded per request, survive expiry and reset only on a new request', () => {
  let s = request().state;
  for (let i = 0; i < 5; i++) {
    const attempt = step(s, 'confirmation-attempt', {}, i);
    assert.equal(attempt.confirmationAllowed, true); assert.equal(attempt.confirmationBlocked, false);
    s = attempt.state;
    assert.equal(s.confirmationAttempts, i + 1);
    assert.equal(attempt.events.at(-1).data.confirmationAttemptsRemaining, 4 - i);
  }
  const blocked = step(s, 'confirmation-attempt', {}, 5);
  assert.equal(blocked.confirmationAllowed, false); assert.equal(blocked.confirmationBlocked, true);
  assert.deepEqual(blocked.events, []);
  s = step(blocked.state, 'tick', {}, s.expiresAt).state;
  assert.equal(step(s, 'confirmation-attempt').confirmationBlocked, true);
  s = step(s, 'change-address', { address: 'other@example.test' }).state;
  assert.equal(step(s, 'confirmation-attempt').confirmationBlocked, true);
  s = step(s, 'resend').state;
  assert.equal(s.confirmationAttempts, 0);
  assert.equal(step(s, 'confirmation-attempt').confirmationAllowed, true);
});

test('confirmation attempt configuration accepts and enforces both bounds', () => {
  for (const maxConfirmationAttempts of [1, 10]) {
    let s = request(createLockedIdentity({ policy: { maxConfirmationAttempts } })).state;
    for (let i = 0; i < maxConfirmationAttempts; i++) {
      const result = step(s, 'confirmation-attempt');
      assert.equal(result.confirmationAllowed, true);
      s = result.state;
    }
    assert.equal(identityView(s, 0).confirmationAttemptsRemaining, 0);
    assert.equal(step(s, 'confirmation-attempt').confirmationBlocked, true);
  }
});

test('identity emits no state event for a clock tick, unchanged role or pause, or duplicate expiry', () => {
  const s = delivery(request().state);
  for (const result of [step(s, 'tick', {}, 1), step(s, 'role', { role: null }, 2),
    step(s, 'pause', { origin: 'manual', paused: false }, 3)]) assert.deepEqual(result.events, []);
  const expired = step(s, 'tick', {}, s.expiresAt);
  assert.equal(expired.events.length, 1); assert.equal(expired.events[0].data.expired, true);
  assert.deepEqual(step(expired.state, 'tick', {}, s.expiresAt + 1).events, []);
});

test('identity rejects malformed configuration, addresses, events and time', () => {
  for (const options of [{ roles: [] }, { roles: ['x', 'x'] }, { role: 'other' }, { demoBypass: 'yes' },
    { verificationRequired: 'yes' }, { policy: { maxConfirmationAttempts: 0 } }, { policy: { maxConfirmationAttempts: 1.5 } },
    { policy: { maxConfirmationAttempts: 11 } }, { policy: { maxConfirmationAttempts: Number.MAX_SAFE_INTEGER } },
    { policy: { verificationTtlMs: 0 } }, { policy: { resendCooldownMs: -1 } }]) assert.throws(() => createLockedIdentity(options));
  const s = createLockedIdentity();
  for (const value of ['', 'missing-at', 'a@b', 'a b@example.test', 'x'.repeat(255)]) {
    assert.throws(() => step(s, 'request-verification', { address: value }));
  }
  for (const e of [{ type: 'unknown', now: 0 }, { type: 'tick', now: NaN }, { type: 'pause', now: 0, origin: 'auto', paused: true },
    { type: 'delivery', now: 0, status: 'queued' }, { type: 'visibility', now: 0, visible: 'yes' }]) assert.throws(() => reduceIdentity(s, e));
  assert.throws(() => step(step(s, 'tick', {}, 10).state, 'tick', {}, 9));
  assert.throws(() => identityView(s, -1));
});
