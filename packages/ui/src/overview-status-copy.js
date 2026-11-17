import { resolveCopy } from './copy-resolve.js';
import { reasonText } from './settings-dialog.js';

// Local feature verdicts use this catalog too, so their resolved copy is
// reserved before pause, host-limit or consent state changes.
const featureReasonCatalog = {
  erased: copy => copy.conversationUnavailable,
  timeExpired: copy => copy.voiceStates.timeExpired,
  usedUp: copy => copy.voiceStates.usedUp,
  paused: copy => copy.paused,
  consent: copy => copy.consentRequired,
  notConfigured: copy => copy.notConfigured,
  voiceBudgetDenied: copy => copy.voiceBudgetDenied,
};
export const featureReasonText = (copy, state) => featureReasonCatalog[state](copy);

// The renderer and the size reservation consume this same ordered catalog.
// Every render path supplies its complete set of text/action variants.
export const overviewStatusCatalog = [
  { id: 'empty', when: c => !c.hasPersonTurn, variants: copy => [{ text: copy.empty }] },
  { id: 'updating', when: c => c.updatingOverview && c.readinessAssessed, variants: copy => [{ text: copy.stale }] },
  { id: 'preparing', when: c => c.preparing, variants: copy => [{ text: copy.preparingOverview }] },
  { id: 'failed', when: c => c.failedOverview, variants: copy => [
    { text: copy.understandingFailed, retry: true }, { text: `${copy.understandingFailed}.` }], pick: c => c.replyFailed ? 1 : 0 },
  { id: 'reasoning-failed', when: c => c.failure && !c.replyFailed && !c.reconciling,
    variants: (copy, locale) => [{ text: resolveCopy(copy, 'reasoningFailed', null, locale) }] },
  { id: 'unavailable', when: c => !c.analysis.available && !c.cached && !c.purposePaused && !c.reconciling,
    variants: copy => [...Object.values(featureReasonCatalog).map(resolve => ({ text: resolve(copy) })),
      ...Object.keys(copy.reasons ?? {}).filter(reason => reason !== 'delegated').flatMap(reason =>
        [reason, `delegated reasoning: ${reason}`].map(rawReason => ({ rawReason, text: reasonText(copy, rawReason, 'analysis') })))],
    render: c => c.analysis.reason },
  { id: 'reply-pending', when: c => !c.readinessAssessed && c.replyFailed && c.missingReply && !c.purposePaused,
    variants: copy => [{ text: copy.overviewPendingReply }] },
  { id: 'no-details', when: c => !c.readinessAssessed, variants: copy => [{ text: copy.noProjectDetails }] },
  { id: 'idle', when: c => c.stale && !c.purposePaused,
    variants: (copy, locale) => [{ text: resolveCopy(copy, 'staleIdle', null, locale), retry: true }] },
  { id: 'draft', when: c => c.draft, variants: copy => [{ text: copy.draft }] },
  { id: 'current', when: () => true, variants: (copy, locale) => [{ text: resolveCopy(copy, 'overviewCurrent', 'final', locale) }] },
];

export function overviewStatusText(copy, locale, context) {
  const state = overviewStatusCatalog.find(state => state.when(context));
  return state.render ? state.render(context) : state.variants(copy, locale)[state.pick?.(context) ?? 0].text;
}

export function overviewStatusCandidates(copy, locale) {
  return [...overviewStatusCatalog.flatMap(state => state.variants(copy, locale).map(variant => ({ state: state.id, ...variant }))),
    { state: 'consent', consent: true }];
}
