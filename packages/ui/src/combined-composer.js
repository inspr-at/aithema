import { node, setText } from './dom.js';
import { reasonSeparator } from './consent-line.js';
import { paintFailureLine } from './concept-view.js';
import { resolveCopy } from './copy-resolve.js';

// Intrinsic, hidden state strings reserve the rows at the current width/font.
// They never join a live region, tab order, or accessible control description.
export function reserveCombinedComposer(root, copy, locale) {
  const feedback = root.querySelector('.composer-feedback-reserve');
  const status = root.querySelector('.composer-status-reserve');
  const statusMessages = [resolveCopy(copy, 'voiceMessagesNarrow.voiceMicDenied', 'voiceMicDenied', locale), copy.voiceEnded];
  const key = JSON.stringify([copy.featureConsent, copy.failed, copy.failedShort, copy.shortcut, copy.shortcutKeys, copy.saved, statusMessages]);
  if (feedback.dataset.measureKey === key) return;
  feedback.dataset.measureKey = key;
  const line = (words, className = '') => node('small', `composer-reason composer-reserve-line ${className}`, words);
  const consent = (narrow) => {
    const row=line(`${copy.featureConsent[narrow ? 'textNarrow' : 'text']}${reasonSeparator}`, narrow ? 'composer-reserve-phone' : 'composer-reserve-wide');
    row.append(node('span', 'composer-reserve-action', copy.featureConsent[narrow ? 'actionNarrow' : 'action']));
    return row;
  };
  const failure=line('', 'composer-reserve-wide'), shortFailure=line('', 'composer-reserve-phone');
  paintFailureLine(failure, copy.failed); paintFailureLine(shortFailure, copy.failedShort ?? copy.failed);
  const shortcut=line(''), parts=copy.shortcut.split('{key}'), suffix=(parts[1] ?? '').split('Enter');
  shortcut.append(parts[0] ?? '', node('kbd', '', copy.shortcutKeys?.other ?? ''), suffix[0], node('kbd', '', 'Enter'), suffix.slice(1).join('Enter'));
  feedback.replaceChildren(consent(false), consent(true), failure, shortFailure, shortcut, line(copy.saved));
  status.replaceChildren(...statusMessages.filter(Boolean).map(words => node('span', '', words)));
}

export function paintCombinedNotice(root, copy, { processing, words, firstSentence, locale }) {
  const notice=root.querySelector('.composer-notice');
  if (!notice) return;
  const full=[words, processing].filter(Boolean).join(' ');
  setText(notice.querySelector('.composer-notice__wide'), full);
  setText(notice.querySelector('.composer-notice__first'), firstSentence);
  setText(notice.querySelector('.composer-notice__more'), resolveCopy(copy, 'composerNoticeMore', null, locale));
  const dialog=root.querySelector('.composer-notice-dialog');
  setText(dialog.querySelector('p'), full);
  setText(dialog.querySelector('h2'), copy.settings.providers);
  dialog.querySelector('button').setAttribute('aria-label', copy.voiceReplayClose);
  reserveCombinedComposer(root, copy, locale);
}

export const combinedNoticeMarkup = `<div class="composer-notice" id="composer-notice"><span class="composer-notice__wide"></span><span class="composer-notice__phone"><span class="composer-notice__first"></span> <button class="composer-notice__more" type="button" aria-haspopup="dialog" aria-controls="composer-notice-dialog"></button></span></div>`;
