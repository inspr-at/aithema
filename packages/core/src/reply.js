// The conversation stays in content; answer choices are optional, erasable reply data.
// This schema is also described in the prompt, so streaming providers need no new capability.
export const replySchema = {
  type: 'object', additionalProperties: false, required: ['content', 'question_short', 'options'],
  properties: {
    content: { type: 'string' },
    question_short: { anyOf: [{ type: 'string', minLength: 1, maxLength: 500 }, { type: 'null' }] },
    options: { type: 'array', maxItems: 4, minContains: 0, maxContains: 1,
      contains: { type: 'object', required: ['likely'], properties: { likely: { type: 'boolean', enum: [true] } } }, items: {
      type: 'object', additionalProperties: false, required: ['text'],
      properties: { text: { type: 'string', minLength: 1, maxLength: 8000 }, likely: { type: 'boolean' } },
    } },
  },
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const shortQuestion = value => typeof value === 'string' && value.trim() && value.length <= 500 ? value : null;

/** Strictly drop malformed choices, cap valid ones, preserve the exact sendable text. */
export function normalizeQuestionCard(value) {
  if (!object(value) || !shortQuestion(value.question_short) || !Array.isArray(value.options)) return null;
  const options = []; let likely = false;
  for (const option of value.options) {
    if (!object(option) || typeof option.text !== 'string' || !option.text.trim() || option.text.length > 8000 ||
      Object.keys(option).some(key => !['text', 'likely'].includes(key)) ||
      Object.hasOwn(option, 'likely') && typeof option.likely !== 'boolean') continue;
    const answer = { text: option.text };
    if (Object.hasOwn(option, 'likely') && !(likely && option.likely)) answer.likely = option.likely;
    likely ||= option.likely === true;
    options.push(answer);
    if (options.length === 4) break;
  }
  return options.length ? { question_short: value.question_short, options } : null;
}

const unfence = text => text.replace(/^\s*```(?:json)?\s*\n?/iu, '').replace(/\s*```\s*$/u, '');
// Only a top-level content-first JSON string may be shown before the envelope is complete.
// Stop before an incomplete escape; a later chunk resumes it without leaking JSON syntax.
function streamedContent(wire) {
  const match = /^\s*\{\s*"content"\s*:\s*"/u.exec(wire);
  if (!match) return '';
  const start = match[0].length; let end = start;
  while (end < wire.length) {
    if (wire[end] === '"') break;
    if (wire[end] === '\\') {
      const size = wire[end + 1] === 'u' ? 6 : 2;
      if (end + size > wire.length) break;
      end += size;
    } else end++;
  }
  try { return JSON.parse(`"${wire.slice(start, end)}"`); } catch { return ''; }
}

/** Invalid card metadata never fails a valid conversational reply; old plain replies still work. */
export function parseReply(raw) {
  if (typeof raw === 'string') {
    if (!/^\s*(?:\{|\[|```)/u.test(raw)) return { content: raw, question_short: null, options: [] };
    const wire = unfence(raw);
    try { raw = JSON.parse(wire); }
    catch { return { content: streamedContent(wire), question_short: null, options: [] }; }
  }
  if (!object(raw)) return { content: '', question_short: null, options: [] };
  const question_short = shortQuestion(raw.question_short), card = normalizeQuestionCard(raw);
  return { content: typeof raw.content === 'string' ? raw.content : '', question_short, options: card?.options ?? [] };
}

/** Decode just reply text while streaming; the final envelope alone can open a card. */
export class ReplyStream {
  #wire = ''; #shown = ''; #structured = null;
  push(delta) {
    if (typeof delta !== 'string' || this.#wire.length + delta.length > 16_000) throw new TypeError('Invalid reasoning stream');
    this.#wire += delta;
    if (this.#structured === null && this.#wire.trim()) this.#structured = /^[{\[`]/u.test(this.#wire.trimStart());
    if (this.#structured === null) return '';
    const text = this.#structured ? streamedContent(unfence(this.#wire)) : this.#wire;
    if (!text.startsWith(this.#shown)) return '';
    const next = text.slice(this.#shown.length); this.#shown = text; return next;
  }
  finish() { return parseReply(this.#wire); }
}
