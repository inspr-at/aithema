import { isConsentReason } from '../../core/src/settings.js';
import { setText } from './dom.js';

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
  }
  const action = line.querySelector('.consent-action');
  setText(line.querySelector('.consent-line-copy'), blocked ? `${copy.featureConsent[feature]} · ` : text ?? '');
  setText(action, blocked ? copy.featureConsent.action : ''); action.hidden = !blocked;
  if (blocked) line.dataset.consentFeature = feature; else delete line.dataset.consentFeature;
  return blocked;
}
