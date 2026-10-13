// Both languages are checked regardless of session locale: models can switch languages.
const FORM = '(?:dankeschön|danke(?:\\s+(?:schön|sehr|vielmals))?|vielen(?:\\s+(?:herzlichen|lieben))?\\s+dank|herzlichen\\s+dank|besten\\s+dank|thank\\s+you(?:\\s+(?:very\\s+much|so\\s+much))?|many\\s+thanks|thanks(?:\\s+a\\s+lot)?)';
const THANKS = new RegExp(`^\\s*(?:\\*\\*${FORM}\\*\\*|${FORM})(?=$|[\\s,;.!?…–—]|-)`, 'iu');
const BOUNDARY = /[,;.!?…–—]|\s-\s/u;
const FORMS = ['danke', 'danke schön', 'danke sehr', 'vielen dank', 'vielen herzlichen dank',
  'herzlichen dank', 'besten dank', 'thanks', 'thank you', 'thank you very much', 'many thanks',
  'thank you so much', 'thanks a lot', 'dankeschön', 'vielen lieben dank', 'danke vielmals'];
const PREFIXES = [...FORMS, ...FORMS.map(form => `**${form}**`)];
const MAX_BUFFER = 160;
// Conservative finite-verb evidence, rather than mistaking a noun phrase for a reply.
// Unknown constructions are kept; this guard must never create a broken fragment.
const VERB = /^(?:ist|sind|war|waren|hat|haben|wird|werden|kann|können|könnte|könnten|soll|sollen|sollte|sollten|möchte|möchten|muss|müssen|darf|dürfen|klingt|klingen|hilft|helfen|passt|passen|ergibt|ergeben|macht|machen|zeigt|zeigen|fehlt|fehlen|braucht|brauchen|benötigt|benötigen|geht|gehen|lässt|lassen|steht|stehen|beginnt|beginnen|startet|starten|beschreiben|beschreibt|planen|plant|reicht|stimmt|is|are|was|were|has|have|can|could|should|would|will|must|do|does|sounds|sound|seems|seem|helps|help|works|work|means|mean|makes|make|needs|need|lets|let|matters|agree|start|starts)$/iu;
const COMPLETE_VERB = /^(?:hilft|passt|reicht|stimmt|beginnt|beginnen|startet|starten|helps|works|matters|agree|start|starts)$/iu;
const DANGLING = /^(?:für|for|mit|with|to|of|in|an|auf|nach|ein|eine|einen|einem|einer|der|die|das|the|a|an|and|und|or|oder)$/iu;
const SUBJECT = /^(?:das|es|ich|wir|sie|du|ihr|er|it|i|we|you|he|she|they|this|that)$/iu;
const POSSESSIVE = /^(?:ihr|ihre|unser|unsere|your|our|my|their)$/iu;
const RELATIVE = /^(?:der|die|das|den|dem|deren|dessen|welche\p{L}*|which|that)$/iu;
const SUBORDINATE = /^(?:dass|daß|wenn|weil|ob|wie|als|damit|sodass|which|who|whom|whose|where|when|if|because|how)$/iu;
const INTERJECTION = /^(?:gut|okay|ok|äh|well)$/iu;

function possibleThanks(text) {
  const prefix = text.trimStart().toLocaleLowerCase('en').replace(/\s+/gu, ' ');
  return PREFIXES.some(form => form.startsWith(prefix));
}

function opener(text) {
  const match = THANKS.exec(text);
  if (!match) return null;
  const tail = text.slice(match[0].length), boundary = BOUNDARY.exec(tail);
  if (!boundary) return { cut: null };
  const complement = tail.slice(0, boundary.index).trim();
  if (complement && !/^(?:für|for)\s+\S/iu.test(complement)) return null;
  return { cut: match[0].length + boundary.index + boundary[0].length,
    complement: Boolean(complement) };
}
function fullClause(text, opening) {
  // Exact conservative rule: inspect only the first remainder clause. Strip
  // only a subject pronoun immediately followed by a listed finite verb, a
  // possessive + one noun + listed finite verb, a complete "What <modal>
  // <subject> ...?" question, or a short interjection (optionally followed by
  // one of those starts). Never search later words/clauses for a verb. After a
  // für/for complement, relative-pronoun starts are kept ("Das <finite verb>"
  // is already a grammatical main-clause start); subordinate and preposition-
  // led starts are kept too. "That <subject> ..." is subordinate;
  // only "That <finite verb> ..." without a complement is demonstrative.
  // Missing finite-verb/completion evidence means keep the whole reply.
  const boundary = BOUNDARY.exec(text), clause = boundary ? text.slice(0, boundary.index) : text;
  const words = clause.match(/[\p{L}]+(?:['’][\p{L}]+)?/gu) ?? [];
  if (!words.length || SUBORDINATE.test(words[0])) return false;
  if (opening.complement && RELATIVE.test(words[0]) && !(/^das$/iu.test(words[0]) && VERB.test(words[1]))) return false;
  if (INTERJECTION.test(words[0])) {
    if (words.length === 1) return Boolean(boundary);
    words.shift();
  }
  const englishQuestion = boundary?.[0] === '?' && /^what$/iu.test(words[0]) &&
    /^(?:can|could|should|would|will|must|do|does)$/iu.test(words[1]) && SUBJECT.test(words[2]);
  if (DANGLING.test(words.at(-1)) && !englishQuestion) return false;
  const verb = englishQuestion ? 1 : SUBJECT.test(words[0]) && VERB.test(words[1]) ? 1
    : POSSESSIVE.test(words[0]) && words.length >= 3 && VERB.test(words[2]) ? 2 : -1;
  if (verb < 0 || words.length < 2) return false;
  // A trailing copula/modal or unfinished complement is not a complete reaction.
  if (verb === words.length - 1) return COMPLETE_VERB.test(words[verb]);
  return words.length >= 3 && words.at(-1).length >= 2;
}

/** Strip only a complete DE/EN thanks opener; preserve ambiguous fragments verbatim. */
function guard(text, locale) {
  const opening = opener(text);
  if (!opening) return { text, stripped: false };
  if (opening.cut === null) return { text, stripped: false, kept: true };
  const rest = text.slice(opening.cut).trimStart();
  const boundary = BOUNDARY.exec(rest);
  const decisionEnd = text.length - rest.length + (boundary ? boundary.index + boundary[0].length : rest.length);
  // Keep pure/non-streaming decisions identical to the bounded stream, even
  // when the provider supplies the entire reply in one chunk.
  if (decisionEnd >= MAX_BUFFER) return { text, stripped: false, kept: true };
  if (!fullClause(rest, opening)) return { text, stripped: false, kept: true };
  return { text: rest.replace(/\p{L}/u, letter => letter.toLocaleUpperCase(locale === 'de' ? 'de' : 'en')), stripped: true };
}
export function stripThanksOpener(text, locale) {
  return guard(text, locale);
}

/** Buffer just the opener; once decided, pass all later bytes through unchanged. */
export class ReplyOpenerStream {
  #buffer = ''; #decided = false;
  constructor(locale, { bufferNormal = true } = {}) {
    this.locale = locale; this.bufferNormal = bufferNormal; this.stripped = false;
  }
  push(delta) {
    if (this.#decided) return delta;
    // Examine at most 160 characters, even if the provider supplies one huge
    // chunk. Decide at the first remainder-clause boundary or flush unchanged
    // at the cap. This also makes the decision independent of chunk sizes.
    for (let index = 0; index < delta.length; index++) {
      this.#buffer += delta[index];
      if (this.#buffer.length >= MAX_BUFFER) return this.flush() + delta.slice(index + 1);
      const opening = opener(this.#buffer);
      const candidate = opening?.cut != null ? this.#buffer.slice(opening.cut).trimStart() : this.#buffer;
      // Voice forwards an unambiguously ordinary or quoted opener immediately.
      if (!this.bufferNormal && !opening && !possibleThanks(this.#buffer)) return this.#decide() + delta.slice(index + 1);
      if (opening?.cut === null || opening && !candidate) continue;
      if (BOUNDARY.test(candidate) || !opening && candidate.length >= 80) return this.#decide() + delta.slice(index + 1);
    }
    return '';
  }
  #decide() {
    const result = guard(this.#buffer, this.locale);
    this.stripped = result.stripped; this.#decided = true; this.#buffer = '';
    return result.text;
  }
  /** Preserve undecided provider bytes when the buffering bound is reached. */
  flush() {
    if (this.#decided) return '';
    const text = this.#buffer;
    this.#decided = true; this.#buffer = '';
    return text;
  }
  finish() {
    if (this.#decided) return '';
    return this.#decide();
  }
}
