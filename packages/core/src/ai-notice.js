// EU AI Act Art. 50(1) (AIT-119): people learn that they talk to an AI system, clearly and at the
// latest at the first interaction. The second sentence applies only where replies can be spoken.
export const AI_NOTICE = Object.freeze({
  en: Object.freeze({ text: 'You are talking to an AI assistant.', voice: 'Spoken replies use a synthetic voice.' }),
  de: Object.freeze({ text: 'Sie sprechen mit einem KI-Assistenten.', voice: 'Gesprochene Antworten verwenden eine synthetische Stimme.' }),
});
const filled = value => typeof value === 'string' && value.trim() ? value.trim() : null;

/** A host may reword the notice, never remove it: an empty or missing part falls back to the default. */
export function aiNotice(locale, override) {
  const base = AI_NOTICE[Object.hasOwn(AI_NOTICE, locale ?? '') ? locale : 'en'];
  return { text: filled(override?.text) ?? base.text, voice: filled(override?.voice) ?? base.voice };
}

/** The notice as one line: both sentences with voice, else only the first. */
export function aiNoticeText(locale, override, { voice = true } = {}) {
  const notice = aiNotice(locale, override);
  return voice ? `${notice.text} ${notice.voice}` : notice.text;
}

/**
 * What the voice agent says first, server-side and fixed: German, then English, because a call's language
 * may differ from the agent's and no browser may choose or replace the greeting.
 */
export const SPOKEN_AI_NOTICE = 'Sie sprechen mit einem KI-Assistenten; Antworten sind synthetisch gesprochen. You are talking to an AI assistant with a synthetic voice.';
