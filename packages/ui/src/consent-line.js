import { isConsentReason } from '../../core/src/settings.js';
import { setText } from './dom.js';

/** The C1 sentence shared by visible statuses, AT descriptions and hover/focus help. */
export const featureConsentText = (copy, feature) => copy.featureConsent[feature === 'transcription' ? 'voice' : feature];

/** Stable status node and quiet action; its surrounding slot owns the geometry. */
export function paintConsentLine(line, { copy, feature, verdict, text, open }) {
  const blocked = !verdict.available && isConsentReason(verdict.rawReason ?? verdict.reason);
  if (!blocked) {
    setText(line, text ?? ''); delete line.dataset.consentFeature; return false;
  }
  if (!line.querySelector('.consent-line-copy')) {
    const label = document.createElement('span'), action = document.createElement('button');
    label.className = 'consent-line-copy'; action.className = 'consent-action'; action.type = 'button';
    action.addEventListener('click', () => open(action));
    line.replaceChildren(label, action); line.tabIndex = -1;
    line.dataset.focusKey = action.dataset.focusKey = `consent-${feature}`;
  }
  const action = line.querySelector('.consent-action'), label = line.querySelector('.consent-line-copy');
  label.id = `consent-${feature}-sentence`; action.setAttribute('aria-describedby', label.id);
  setText(line.querySelector('.consent-line-copy'), `${featureConsentText(copy, feature)} · `);
  setText(action, copy.featureConsent.action);
  line.dataset.consentFeature = feature;
  return blocked;
}
