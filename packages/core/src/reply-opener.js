// Both languages are checked regardless of session locale: models can switch languages.
const THANKS = /^[\s"'“”„«»‘’]*(?:danke(?:\s+(?:schön|sehr))?|vielen(?:\s+herzlichen)?\s+dank|herzlichen\s+dank|besten\s+dank|thank\s+you(?:\s+very\s+much)?|many\s+thanks|thanks)(?=$|[\s,;.!?…–—"'“”«»‘’]|-)/iu;
const BOUNDARY = /[,;.!?…–—]|\s-\s/u;
const QUOTE_PAIRS = { '"': '"', "'": "'", '„': '“', '“': '”', '«': '»', '‘': '’' };
const FORMS = ['danke', 'danke schön', 'danke sehr', 'vielen dank', 'vielen herzlichen dank',
  'herzlichen dank', 'besten dank', 'thanks', 'thank you', 'thank you very much', 'many thanks'];
// Conservative finite-verb evidence, rather than mistaking a noun phrase for a reply.
// Unknown constructions are kept; this guard must never create a broken fragment.
const VERB = /^(?:ist|sind|war|waren|hat|haben|wird|werden|kann|können|könnte|könnten|soll|sollen|sollte|sollten|möchte|möchten|muss|müssen|darf|dürfen|klingt|klingen|hilft|helfen|passt|passen|ergibt|ergeben|macht|machen|zeigt|zeigen|fehlt|fehlen|braucht|brauchen|benötigt|benötigen|geht|gehen|lässt|lassen|steht|stehen|beginnt|beginnen|startet|starten|beschreiben|beschreibt|planen|plant|reicht|stimmt|is|are|was|were|has|have|can|could|should|would|will|must|do|does|sounds|sound|seems|seem|helps|help|works|work|means|mean|makes|make|needs|need|lets|let|matters|agree|start|starts|describe|describes|plan|plans)$/iu;
const COMPLETE_VERB = /^(?:hilft|passt|reicht|stimmt|beginnt|beginnen|startet|starten|helps|works|matters|agree|start|starts)$/iu;
const DANGLING = /^(?:für|for|mit|with|to|of|in|an|auf|nach|ein|eine|einen|einem|einer|der|die|das|the|a|an|and|und|or|oder)$/iu;

function possibleThanks(text) {
  const prefix = text.replace(/^[\s"'“”„«»‘’]+/u, '').toLocaleLowerCase('en').replace(/\s+/gu, ' ');
  return FORMS.some(form => form.startsWith(prefix));
}

function opener(text) {
  const match = THANKS.exec(text);
  if (!match) return null;
  const tail = text.slice(match[0].length), boundary = BOUNDARY.exec(tail);
  if (!boundary) return { cut: null };
  const rawComplement = tail.slice(0, boundary.index);
  const complement = rawComplement.replace(/["'“”»’]+\s*$/u, '').trim();
  if (complement && !/^(?:für|for)\s+\S/iu.test(complement)) return null;
  const closingQuote = QUOTE_PAIRS[text.trimStart()[0]];
  return { cut: match[0].length + boundary.index + boundary[0].length,
    closingQuote: closingQuote && !rawComplement.includes(closingQuote) ? closingQuote : null };
}
function remainder(text, opening) {
  let rest = text.slice(opening.cut).trimStart(), closingQuote = opening.closingQuote;
  if (closingQuote && rest.startsWith(closingQuote)) { rest = rest.slice(1).trimStart(); closingQuote = null; }
  return { rest, closingQuote };
}
function fullClause(text) {
  const boundary = BOUNDARY.exec(text), clause = boundary ? text.slice(0, boundary.index) : text;
  const words = clause.match(/[\p{L}]+(?:['’][\p{L}]+)?/gu) ?? [];
  if (words.length < 2 || /^(?:für|for|with|mit|to|of|um|wegen|ohne)$/iu.test(words[0])) return false;
  const englishQuestion = boundary?.[0] === '?' && /^(?:what|which|who|where|when|how)$/iu.test(words[0]);
  if (DANGLING.test(words.at(-1)) && !englishQuestion) return false;
  const verb = words.findIndex(word => VERB.test(word));
  if (verb < 0) return false;
  // A trailing copula/modal or unfinished complement is not a complete reaction.
  if (verb === words.length - 1) return COMPLETE_VERB.test(words[verb]);
  return words.length >= 3 && words.at(-1).length >= 2;
}

/** Strip only a complete DE/EN thanks opener; preserve ambiguous fragments verbatim. */
function guard(text, locale) {
  const opening = opener(text);
  if (!opening) return { text, stripped: false };
  if (opening.cut === null) return { text, stripped: false, kept: true };
  const { rest, closingQuote } = remainder(text, opening);
  if (!fullClause(rest)) return { text, stripped: false, kept: true };
  return { text: rest.replace(/\p{L}/u, letter => letter.toLocaleUpperCase(locale === 'de' ? 'de' : 'en')), stripped: true, closingQuote };
}
function dropClosingQuote(text, closingQuote) {
  const index = closingQuote ? text.lastIndexOf(closingQuote) : -1;
  return index >= 0 && /^\s*$/u.test(text.slice(index + 1)) ? text.slice(0, index) : text;
}
export function stripThanksOpener(text, locale) {
  const { closingQuote, ...result } = guard(text, locale);
  if (result.stripped) result.text = dropClosingQuote(result.text, closingQuote);
  return result;
}

/** Buffer just the opener; once decided, pass all later bytes through unchanged. */
export class ReplyOpenerStream {
  #buffer = ''; #decided = false; #closingQuote = null; #quoteTail = '';
  constructor(locale, { bufferNormal = true } = {}) {
    this.locale = locale; this.bufferNormal = bufferNormal; this.stripped = false;
  }
  push(delta) {
    if (this.#decided) return this.#output(delta);
    this.#buffer += delta;
    const opening = opener(this.#buffer);
    const candidate = opening?.cut != null ? remainder(this.#buffer, opening).rest : this.#buffer;
    // Voice can forward an unambiguously ordinary opener without delaying TTS.
    if (!this.bufferNormal && !opening && !possibleThanks(this.#buffer)) return this.#decide();
    // A recognised formula stays private until a safe remainder exists. A long
    // complement cannot be forwarded at 80 characters without flashing thanks.
    if (opening?.cut === null || opening && !candidate.trim()) return '';
    if (!BOUNDARY.test(candidate) && candidate.trimStart().length < 80) return '';
    // Do not leak a long but unfinished remainder at the soft 80-character cap.
    if (opening && !BOUNDARY.test(candidate) && !fullClause(candidate)) return '';
    return this.#decide();
  }
  #decide() {
    const result = guard(this.#buffer, this.locale);
    this.stripped = result.stripped; this.#closingQuote = result.closingQuote;
    this.#decided = true; this.#buffer = '';
    return this.#output(result.text);
  }
  #output(delta) {
    if (!this.#closingQuote) return delta;
    // A closing outer quote can arrive after the clause in its own chunk.
    const text = this.#quoteTail + delta, withoutQuote = dropClosingQuote(text, this.#closingQuote);
    this.#quoteTail = text.slice(withoutQuote.length);
    return withoutQuote;
  }
  finish() {
    if (this.#decided) { this.#quoteTail = ''; return ''; }
    const result = stripThanksOpener(this.#buffer, this.locale);
    this.stripped = result.stripped; this.#decided = true; this.#buffer = '';
    return result.text;
  }
}
