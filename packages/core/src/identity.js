// Generic START verification/recovery behaviour. The host owns email delivery,
// token redemption and polling; only authoritative host facts enter this reducer.
export const ACTOR_ROLES = Object.freeze(['private', 'company', 'representative', 'agency']);
export const IDENTITY_POLICY = Object.freeze({ resendCooldownMs: 60_000, verificationTtlMs: 30 * 60_000, maxConfirmationAttempts: 5 });
const time = n => Number.isSafeInteger(n) && n >= 0;
const address = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);

export function createIdentity({ roles = ACTOR_ROLES, role = null, demoBypass = false, verificationRequired = false, policy = {} } = {}) {
  const limits = { ...IDENTITY_POLICY, ...policy };
  if (!Array.isArray(roles) || !roles.length || new Set(roles).size !== roles.length ||
      roles.some(r => typeof r !== 'string' || !r || r.length > 64) || role !== null && !roles.includes(role) ||
      typeof demoBypass !== 'boolean' || typeof verificationRequired !== 'boolean' ||
      !time(limits.resendCooldownMs) || !time(limits.verificationTtlMs) || !limits.verificationTtlMs ||
      !time(limits.maxConfirmationAttempts) || !limits.maxConfirmationAttempts || limits.maxConfirmationAttempts > 10) {
    throw new TypeError('Invalid identity configuration');
  }
  return { status: 'guest', roles: [...roles], role, address: null, verificationRevision: 0,
    expiresAt: null, resendAt: 0, expired: false, delivery: 'idle', demoBypass, verificationRequired, confirmationAttempts: 0,
    manualPaused: false, visibilityPaused: false, visible: true, releaseVisibilityOnReturn: false,
    lastNow: 0, policy: limits };
}

export function identityView(state, now) {
  if (!time(now)) throw new TypeError('Identity view requires host time');
  const unlocked = state.verificationRequired !== true || state.demoBypass || state.status === 'verified';
  const paused = state.manualPaused || state.visibilityPaused;
  const expired = state.expired || state.expiresAt !== null && now >= state.expiresAt;
  return { status: state.status, role: state.role, roles: [...state.roles], address: state.address,
    verificationRevision: state.verificationRevision, delivery: state.delivery, expired,
    verificationRequired: state.verificationRequired === true,
    confirmationAttemptsRemaining: Math.max(0, (state.policy.maxConfirmationAttempts ?? IDENTITY_POLICY.maxConfirmationAttempts) - (state.confirmationAttempts ?? 0)),
    resendAfterMs: Math.max(0, state.resendAt - now),
    canResend: state.status === 'verification-pending' && now >= state.resendAt,
    pollVerification: state.status === 'verification-pending' && !expired && state.expiresAt !== null,
    assessmentUnlocked: unlocked, conceptsUnlocked: unlocked, canRunAssessment: unlocked && !paused,
    canRunConcepts: unlocked && !paused, paused, manualPaused: state.manualPaused, demoBypass: state.demoBypass };
}

/** Returns {state, events}. verification.requested is a host effect, not a claim
 * of delivery. revision + address bind all delivery and verification replies.
 * The demo revocation event is host-only; never forward visitor-supplied events
 * to this reducer. Only trusted construction can grant demo bypass. */
export function reduceIdentity(state, event) {
  if (!event || !time(event.now) || event.now < state.lastNow) throw new TypeError('Identity events require monotonic host time');
  let next = structuredClone(state);
  next.lastNow = event.now;
  if (next.status === 'verification-pending' && next.expiresAt !== null && event.now >= next.expiresAt) {
    next.expired = true;
    if (next.delivery === 'requested') next.delivery = 'failed';
  }
  const events = [];
  let resendBlocked = false, confirmationAllowed = false, confirmationBlocked = false;
  const request = () => {
    if (event.now < next.resendAt) {
      resendBlocked = true;
      events.push({ type: 'identity.resend-blocked', data: { resendAfterMs: Math.max(0, next.resendAt - event.now) } });
      return;
    }
    next.status = 'verification-pending'; next.verificationRevision += 1;
    next.expiresAt = event.now + next.policy.verificationTtlMs;
    next.resendAt = event.now + next.policy.resendCooldownMs;
    if (!time(next.expiresAt) || !time(next.resendAt)) throw new TypeError('Identity deadline overflow');
    next.expired = false; next.delivery = 'requested'; next.confirmationAttempts = 0;
    events.push({ type: 'verification.requested', data: { address: next.address,
      revision: next.verificationRevision, expiresAt: next.expiresAt } });
  };
  switch (event.type) {
    case 'request-verification':
      if (!address(event.address)) throw new TypeError('Invalid verification address');
      if (next.address !== event.address) {
        // Changing the address always revokes old evidence, including while
        // cooling down. It does not evade the host's resend cooldown.
        next.address = event.address; next.status = 'verification-pending';
        next.releaseVisibilityOnReturn = false;
        next.verificationRevision += 1; next.expiresAt = null; next.expired = false; next.delivery = 'idle';
      }
      if (next.status !== 'verified') request();
      break;
    case 'change-address':
      if (!address(event.address)) throw new TypeError('Invalid verification address');
      if (next.address !== event.address) {
        next.address = event.address; next.status = 'verification-pending';
        next.releaseVisibilityOnReturn = false;
        next.verificationRevision += 1; next.expiresAt = null; next.expired = false; next.delivery = 'idle';
      }
      break;
    case 'resend':
      if (next.status === 'verification-pending') request();
      break;
    case 'delivery':
      if (!['sent', 'failed'].includes(event.status)) throw new TypeError('Invalid verification delivery');
      if (next.status === 'verification-pending' && event.revision === next.verificationRevision &&
          event.address === next.address && next.delivery === 'requested') next.delivery = event.status;
      break;
    case 'confirmation-attempt':
      // Reserve durably before the host sees a token. An interrupted or failed
      // host call still consumes the attempt; only a new request renews it.
      confirmationBlocked = (next.confirmationAttempts ?? 0) >= (next.policy.maxConfirmationAttempts ?? IDENTITY_POLICY.maxConfirmationAttempts);
      if (!confirmationBlocked && next.status === 'verification-pending' && !next.expired && next.expiresAt !== null) {
        next.confirmationAttempts = (next.confirmationAttempts ?? 0) + 1;
        confirmationAllowed = true;
      }
      break;
    case 'verification':
      if (event.verified === true && next.status === 'verification-pending' && !next.expired && next.expiresAt !== null &&
          event.revision === next.verificationRevision && event.address === next.address) {
        next.status = 'verified'; next.expiresAt = null;
        if (next.visible) next.visibilityPaused = false;
        next.releaseVisibilityOnReturn = !next.visible;
        events.push({ type: 'identity.unlocked', data: { assessment: true, concepts: true, manualPaused: next.manualPaused } });
      }
      break;
    case 'role':
      if (event.role !== null && !next.roles.includes(event.role)) throw new TypeError('Unknown actor role');
      next.role = event.role;
      break;
    case 'pause':
      if (!['manual', 'visibility'].includes(event.origin) || typeof event.paused !== 'boolean') throw new TypeError('Invalid identity pause');
      next[event.origin === 'manual' ? 'manualPaused' : 'visibilityPaused'] = event.paused;
      if (event.origin === 'visibility') next.releaseVisibilityOnReturn = false;
      break;
    case 'visibility':
      if (typeof event.visible !== 'boolean') throw new TypeError('Invalid identity visibility');
      next.visible = event.visible;
      if (next.visible && next.releaseVisibilityOnReturn) {
        next.visibilityPaused = false; next.releaseVisibilityOnReturn = false;
      }
      break;
    case 'demo':
      if (event.origin !== 'host' || event.enabled !== false) throw new TypeError('Host demo revocation required');
      next.demoBypass = false;
      break;
    case 'policy':
      if (event.origin !== 'host' || event.verificationRequired !== false) throw new TypeError('Host verification policy removal required');
      if (next.verificationRequired === true) {
        next.verificationRequired = false;
        events.push({ type: 'identity.policy-changed', data: { verificationRequired: false, reason: 'host-policy-disabled' } });
      }
      break;
    case 'tick': break;
    default: throw new TypeError('Unknown identity event');
  }
  // Host time advances without journalling countdowns or unchanged polling.
  const { lastNow: _beforeNow, ...before } = state;
  const { lastNow: _afterNow, ...after } = next;
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    events.push({ type: 'identity.state', data: identityView(next, event.now) });
  } else events.length = 0;
  return { state: next, events, resendBlocked, confirmationAllowed, confirmationBlocked };
}
