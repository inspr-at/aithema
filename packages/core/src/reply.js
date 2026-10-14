// The conversation stays in content; answer choices are optional, erasable reply data.
// This schema is also described in the prompt, so streaming providers need no new capability.
export const replySchema = {
  type: 'object', additionalProperties: false, required: ['content', 'question_short', 'options'],
  properties: {
    content: { type: 'string', maxLength: 16000 },
    question_short: { anyOf: [{ type: 'string', minLength: 1, maxLength: 500 }, { type: 'null' }] },
    options: { type: 'array', maxItems: 4, minContains: 0, maxContains: 1,
      contains: { type: 'object', required: ['likely'], properties: { likely: { type: 'boolean', enum: [true] } } }, items: {
      type: 'object', additionalProperties: false, required: ['text'],
      properties: { text: { type: 'string', minLength: 1, maxLength: 8000 }, likely: { type: 'boolean' } },
    } },
  },
};
const MAX_CONTENT = replySchema.properties.content.maxLength;
// JSON may encode each character as six wire characters (\uXXXX). Leave room
// for keys, punctuation, optional flags, whitespace and a markdown fence.
const MAX_ENVELOPE = 6 * (MAX_CONTENT + replySchema.properties.question_short.anyOf[0].maxLength +
  replySchema.properties.options.maxItems * replySchema.properties.options.items.properties.text.maxLength) + 1024;
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

export const unfenceReply = text => text.replace(/^\s*```(?:json)?\s*\n?/iu, '').replace(/\s*```\s*$/u, '');
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
    if (!/^\s*(?:\{|```(?:json)?\s*\{)/iu.test(raw)) return { content: raw, question_short: null, options: [] };
    const wire = unfenceReply(raw);
    try { raw = JSON.parse(wire); }
    catch { return { content: streamedContent(wire), question_short: null, options: [] }; }
  }
  if (!object(raw)) return { content: '', question_short: null, options: [] };
  const question_short = shortQuestion(raw.question_short), card = normalizeQuestionCard(raw);
  return { content: typeof raw.content === 'string' ? raw.content : '', question_short, options: card?.options ?? [] };
}

// Once metadata exceeds the envelope budget, retain only the top-level content
// string. Scan discarded metadata without buffering it, including content-last
// replies; quoted/nested "content" fields must never become conversational text.
class ContentRecovery {
  #depth = 0; #key = null; #quoted = false; #escaped = false; #capture = null; #token = ''; #content = '';
  push(delta) {
    for (const char of delta) {
      if (this.#quoted) {
        if (char === '"' && !this.#escaped) {
          if (this.#capture) {
            let value = '';
            try { value = JSON.parse(`"${this.#token}"`); } catch { /* malformed metadata is disposable */ }
            if (this.#capture === 'key') this.#key = value;
            else {
              if (value.length > MAX_CONTENT) throw new TypeError('Invalid reasoning stream');
              this.#content = value;
            }
          }
          this.#quoted = false; this.#capture = null; this.#token = ''; continue;
        }
        if (this.#capture) {
          this.#token += char;
          if (this.#token.length > (this.#capture === 'key' ? 6 * 'content'.length : 6 * MAX_CONTENT)) {
            if (this.#capture === 'content') throw new TypeError('Invalid reasoning stream');
            this.#key = ''; this.#capture = null; this.#token = '';
          }
        }
        this.#escaped = char === '\\' && !this.#escaped;
      } else if (char === '"') {
        this.#quoted = true; this.#escaped = false;
        this.#capture = this.#depth === 1 ? (this.#key === null ? 'key' : this.#key === 'content' ? 'content' : null) : null;
      } else if (char === '{' || char === '[') this.#depth++;
      else if (char === '}' || char === ']') this.#depth--;
      else if (char === ',' && this.#depth === 1) this.#key = null;
    }
  }
  get content() {
    const text = this.#capture === 'content' ? streamedContent(`{"content":"${this.#token}`) : this.#content;
    if (text.length > MAX_CONTENT) throw new TypeError('Invalid reasoning stream');
    return text;
  }
}

/** Decode just reply text while streaming; the final envelope alone can open a card. */
export class ReplyStream {
  #wire = ''; #shown = ''; #structured = null; #recovery = null;
  push(delta) {
    if (typeof delta !== 'string') throw new TypeError('Invalid reasoning stream');
    const available = MAX_ENVELOPE - this.#wire.length;
    if (this.#recovery) this.#recovery.push(delta);
    else this.#wire += delta.slice(0, available);
    if (this.#structured === null && this.#wire.trim()) this.#structured = /^[{\[`]/u.test(this.#wire.trimStart());
    if (this.#structured === null) return '';
    if (this.#structured && !this.#recovery && delta.length > available) {
      this.#recovery = new ContentRecovery();
      this.#recovery.push(unfenceReply(this.#wire)); this.#recovery.push(delta.slice(available)); this.#wire = '';
    }
    const text = this.#structured ? (this.#recovery?.content ?? streamedContent(unfenceReply(this.#wire))) : this.#wire;
    if (text.length > MAX_CONTENT) throw new TypeError('Invalid reasoning stream');
    if (!text.startsWith(this.#shown)) return '';
    const next = text.slice(this.#shown.length); this.#shown = text; return next;
  }
  finish() {
    const reply = this.#recovery ? { content: this.#recovery.content, question_short: null, options: [] } : parseReply(this.#wire);
    if (this.#structured && !reply.content) {
      const recovery = new ContentRecovery(); recovery.push(unfenceReply(this.#wire)); reply.content = recovery.content;
    }
    if (reply.content.length > MAX_CONTENT) throw new TypeError('Invalid reasoning stream');
    return reply;
  }
}
