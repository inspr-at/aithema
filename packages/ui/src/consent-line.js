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
    line.parentElement?.querySelector(':scope > .consent-description')?.remove();
    setText(line, text ?? ''); delete line.dataset.consentFeature; return false;
  }
  consentOpeners.set(line, open);
  if (!line.querySelector('.consent-line-copy')) {
    const label = node('span', 'consent-line-copy'), action = reasonAction('', opener => consentOpeners.get(line)?.(opener));
    line.replaceChildren(label, action); line.tabIndex = -1;
    line.dataset.focusKey = action.dataset.focusKey = `consent-${feature}`;
  }
  const action = line.querySelector('.consent-action'), label = line.querySelector('.consent-line-copy');
  label.id = `consent-${feature}-sentence`;
  if (feature !== 'text' || !line.classList.contains('composer-reason')) {
    // Another feature on a reused line: its sentence is the painted, exposed label again.
    action.setAttribute('aria-describedby', label.id); label.removeAttribute('aria-hidden');
    for (const variant of label.querySelectorAll('[data-action]')) delete variant.dataset.action;
  }
  if (feature === 'text' && line.classList.contains('composer-reason')) {
    // CSS paints the wide or the narrow label and action at each width.
    // AIT-603 r5 (Codex gate4c M3): one accessible text at every width. The
    // visible action alone names the button; the host's full sentence (host
    // overrides included) is its description, read from one hidden node that
    // no width or clamp changes.
    if (!label.querySelector('.consent-wide')) {
      label.replaceChildren(node('span', 'consent-wide'), node('span', 'consent-narrow'));
      action.replaceChildren(node('span', 'consent-wide'), node('span', 'consent-narrow'));
      label.querySelector('.consent-narrow').setAttribute('aria-hidden', 'true');
    }
    // r6 (Codex gate5c M3): the line is the composer's polite status region
    // (and the text box's description), so the sentence stays out of it: the
    // hidden description node sits next to the line, not inside it, and the
    // painted copy (wide and narrow) is aria-hidden. The host
    // sentence is exposed once, as the action's description.
    const holder = line.parentElement ?? line;
    let description = holder.querySelector(':scope > .consent-description');
    if (!description) { description = node('span', 'consent-description'); description.hidden = true; if (holder === line) line.append(description); else line.after(description); }
    description.id = `consent-${feature}-description`; action.setAttribute('aria-describedby', description.id);
    setText(description, featureConsentText(copy, feature));
    label.setAttribute('aria-hidden', 'true');
    setText(label.querySelector('.consent-wide'), `${featureConsentText(copy, feature)}${separator}`);
    setText(label.querySelector('.consent-narrow'), `${copy.featureConsent.textNarrow}${separator}`);
    setText(action.querySelector('.consent-wide'), copy.featureConsent.action);
    setText(action.querySelector('.consent-narrow'), copy.featureConsent.actionNarrow);
    // AIT-603 PR-A: on phones the sentence clamps in its own box by CSS alone;
    // a hidden float of the action's words keeps the action's room on the last
    // line, so each painted variant carries its action's words (copy, never a
    // measurement).
    label.querySelector('.consent-wide').dataset.action = copy.featureConsent.action;
    label.querySelector('.consent-narrow').dataset.action = copy.featureConsent.actionNarrow;
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
