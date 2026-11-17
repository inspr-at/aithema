import { resolveCopy } from './copy-resolve.js';
import { isConsentReason } from '../../core/src/settings.js';
import { node, setText } from './dom.js';
import { reasonSeparator } from './reason-separator.js';

export { reasonSeparator } from './reason-separator.js';
const consentOpeners = new WeakMap();

/** One native, underlined action for every reason line, including its first paint. */
export function reasonAction(label, activate) {
  const action = node('button', 'consent-action', label); action.type = 'button';
  action.addEventListener('click', () => activate(action));
  return action;
}

/** The C1 sentence shared by visible statuses, AT descriptions and hover/focus help. */
export const featureConsentText = (copy, feature) => feature === 'imageInput'
  ? resolveCopy(copy, 'featureConsent.imageInput', 'imageConsentJit', copy.display?.locale)
  : copy.featureConsent[feature === 'transcription' ? 'voice' : feature];

/** Visual narrow copy stays out of the live text; wide remains the full AT sentence. */
export function paintNarrowText(label, text, textNarrow) {
  if (!label.querySelector('.consent-wide')) {
    const wide = label.ownerDocument.createElement('span'), narrow = label.ownerDocument.createElement('span');
    wide.className = 'consent-wide'; narrow.className = 'consent-narrow'; narrow.setAttribute('aria-hidden', 'true');
    label.replaceChildren(wide, narrow);
  }
  setText(label.querySelector('.consent-wide'), text);
  label.querySelector('.consent-narrow').dataset.copy = textNarrow;
}

/** Stable status node and quiet action; its surrounding slot owns the geometry. */
export function paintConsentLine(line, { copy, feature, verdict, text, open, separator = reasonSeparator }) {
  const blocked = !verdict.available && isConsentReason(verdict.rawReason ?? verdict.reason);
  if (!blocked) {
    consentOpeners.delete(line);
    setText(line, text ?? ''); delete line.dataset.consentFeature; return false;
  }
  consentOpeners.set(line, open);
  if (!line.querySelector('.consent-line-copy')) {
    const label = node('span', 'consent-line-copy'), action = reasonAction('', opener => consentOpeners.get(line)?.(opener));
    line.replaceChildren(label, action); line.tabIndex = -1;
    line.dataset.focusKey = action.dataset.focusKey = `consent-${feature}`;
  }
  const action = line.querySelector('.consent-action'), label = line.querySelector('.consent-line-copy');
  label.id = `consent-${feature}-sentence`; action.setAttribute('aria-describedby', label.id);
  if (feature === 'text' && line.classList.contains('composer-reason')) {
    // CSS selects a label-first name together with its visible action at each width.
    if (!label.querySelector('.consent-wide')) {
      label.replaceChildren(node('span', 'consent-wide'), node('span', 'consent-narrow'));
      action.replaceChildren(node('span', 'consent-wide'), node('span', 'consent-narrow'));
      // These responsive labels carry the button's full name. Generic spans
      // prohibit aria-label; nameable groups preserve the same label at each width.
      for (const variant of action.children) variant.setAttribute('role', 'group');
      label.querySelector('.consent-narrow').setAttribute('aria-hidden', 'true');
    }
    setText(label.querySelector('.consent-wide'), `${featureConsentText(copy, feature)}${separator}`);
    setText(label.querySelector('.consent-narrow'), `${copy.featureConsent.textNarrow}${separator}`);
    setText(action.querySelector('.consent-wide'), copy.featureConsent.action);
    setText(action.querySelector('.consent-narrow'), copy.featureConsent.actionNarrow);
    const requirement = copy.featureConsent.textActionReason ?? featureConsentText(copy, feature);
    action.querySelector('.consent-wide').setAttribute('aria-label', `${copy.featureConsent.action}: ${requirement}`);
    action.querySelector('.consent-narrow').setAttribute('aria-label', `${copy.featureConsent.actionNarrow}: ${requirement}`);
  } else if (feature === 'voice' && line.classList.contains('voice-state')) {
    paintNarrowText(label, `${featureConsentText(copy, feature)}${separator}`, copy.featureConsent.textNarrow);
    setText(action, copy.featureConsent.action);
  } else {
    setText(label, `${featureConsentText(copy, feature)}${separator}`);
    setText(action, copy.featureConsent.action);
  }
  line.dataset.consentFeature = feature;
  return blocked;
}
