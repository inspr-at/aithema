import { isConsentReason } from '../../core/src/settings.js';
import { node, setText } from './dom.js';

// Keep each separator with the preceding copy or action when a reason wraps.
export const reasonSeparator = '\u00a0· ';

/** One native, underlined action for every reason line, including its first paint. */
export function reasonAction(label, activate) {
  const action = node('button', 'consent-action', label); action.type = 'button';
  action.addEventListener('click', () => activate(action));
  return action;
}

/** The C1 sentence shared by visible statuses, AT descriptions and hover/focus help. */
export const featureConsentText = (copy, feature) => copy.featureConsent[feature === 'transcription' ? 'voice' : feature];

/** Stable status node and quiet action; its surrounding slot owns the geometry. */
export function paintConsentLine(line, { copy, feature, verdict, text, open }) {
  const blocked = !verdict.available && isConsentReason(verdict.rawReason ?? verdict.reason);
  if (!blocked) {
    setText(line, text ?? ''); delete line.dataset.consentFeature; return false;
  }
  if (!line.querySelector('.consent-line-copy')) {
    const label = node('span', 'consent-line-copy'), action = reasonAction('', open);
    line.replaceChildren(label, action); line.tabIndex = -1;
    line.dataset.focusKey = action.dataset.focusKey = `consent-${feature}`;
  }
  const action = line.querySelector('.consent-action'), label = line.querySelector('.consent-line-copy');
  label.id = `consent-${feature}-sentence`; action.setAttribute('aria-describedby', label.id);
  if (feature === 'text' && line.classList.contains('composer-reason')) {
    // CSS chooses visible copy; the action keeps the complete sentence at every width.
    if (!label.querySelector('.consent-wide')) {
      label.replaceChildren(node('span', 'consent-wide'), node('span', 'consent-narrow'));
      action.replaceChildren(node('span', 'consent-wide'), node('span', 'consent-narrow'));
      label.querySelector('.consent-narrow').setAttribute('aria-hidden', 'true');
    }
    setText(label.querySelector('.consent-wide'), `${featureConsentText(copy, feature)}${reasonSeparator}`);
    setText(label.querySelector('.consent-narrow'), `${copy.featureConsent.textNarrow}${reasonSeparator}`);
    setText(action.querySelector('.consent-wide'), copy.featureConsent.action);
    setText(action.querySelector('.consent-narrow'), copy.featureConsent.actionNarrow);
    action.setAttribute('aria-label', `${featureConsentText(copy, feature)}. ${copy.featureConsent.action} (${copy.featureConsent.textReview})`);
  } else {
    setText(label, `${featureConsentText(copy, feature)}${reasonSeparator}`);
    setText(action, copy.featureConsent.action);
  }
  line.dataset.consentFeature = feature;
  return blocked;
}
