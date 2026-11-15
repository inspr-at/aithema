import { activeTurns } from './session.js';
import * as documentContext from './document-context.js';

// AIT-505 supplies hasVisitorInput at integration. The current predicate has
// the same active user/document semantics and keeps this opt-in independent.
export const hasOfferVisitorInput = session => (documentContext.hasVisitorInput ?? documentContext.hasConversationInput)(session);
export const visitorMessageCount = session => new Set(activeTurns(session)
  .filter(turn => turn.role === 'user' && hasOfferVisitorInput({ ...session, transcript: [turn], uploads: [] }))
  .map(turn => turn.id)).size;

export function emailOfferPolicy(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'afterMessages')) throw new TypeError('Invalid emailOffer');
  const afterMessages = value.afterMessages === undefined ? 2 : value.afterMessages;
  if (![1, 2].includes(afterMessages)) throw new TypeError('Invalid emailOffer.afterMessages');
  return { afterMessages };
}

/** Shared server/UI eligibility; the host's next-tier receipt owns the promise. */
export function emailOfferEligibility({ privacyCapability, delivery, lock = false, tiers, scope, canConfirm = tiers?.canConfirm }) {
  let nextTier = tiers?.next ?? null;
  const allowances = tiers?.allowancesMicro, current = tiers?.current;
  if (scope === 'session' && current === 'anonymous' && allowances?.anonymous === allowances?.emailGiven) {
    nextTier = tiers.canConfirm && allowances?.emailConfirmed > allowances?.anonymous ? 'emailConfirmed' : null;
  }
  const delta = nextTier ? scope === 'session' && allowances
    ? allowances[nextTier] - allowances[current] : tiers?.delta ?? 0 : 0;
  return { eligible: privacyCapability === true && delivery === true && (lock && canConfirm === true || delta > 0),
    nextTier, delta: Number.isFinite(delta) && delta > 0 ? delta : 0 };
}
