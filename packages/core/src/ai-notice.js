// EU AI Act Art. 50(1) (AIT-119): people learn that they talk to an AI system, clearly and at the
// latest at the first interaction. The second sentence applies only where replies can be spoken.
export const AI_NOTICE = Object.freeze({
  en: Object.freeze({ text: 'You are talking to an AI assistant.', voice: 'Spoken replies use a synthetic voice.' }),
  de: Object.freeze({ text: 'Sie sprechen mit einer KI-Assistenz.', voice: 'Gesprochene Antworten nutzen eine synthetische Stimme.' }),
});
const filled = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const SPOKEN_OPENER = Object.freeze({
  en: 'Hello, this is an AI assistant. How can I help you?',
  de: 'Hallo, hier ist die KI-Assistenz. Wie kann ich Ihnen helfen?',
});

/** A host may reword the notice, never remove it: an empty or missing part falls back to the default. */
export function aiNotice(locale, override) {
  const base = AI_NOTICE[Object.hasOwn(AI_NOTICE, locale ?? '') ? locale : 'en'];
  return { text: filled(override?.text) ?? base.text, voice: filled(override?.voice) ?? base.voice };
}

/** Spoken first contact uses a host's opener or a neutral AI disclosure; visual copy stays separate. */
export function aiNoticeText(locale, override, { voice = true } = {}) {
  if (!voice) return aiNotice(locale, override).text;
  return filled(override?.opener) ?? SPOKEN_OPENER[Object.hasOwn(SPOKEN_OPENER, locale ?? '') ? locale : 'en'];
}
