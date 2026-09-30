import { EngineError, exactKeys, json, ref, runtimeCall } from './common.js';

const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

/** Heuristic only: it misses indirect questions and can flag quoted questions. */
export function likelyExtraQuestion(say) {
  return runtimeCall(() => {
    if (typeof say !== 'string') throw new EngineError('invalid_output', 'say must be a string');
    return /[?？]|(?:^|[.!]\s+)(?:who|what|when|where|why|how|can you|could you|would you|do you|wer|was|wann|wo|warum|wie|kannst du|können sie)\b/iu.test(say.trim());
  });
}

/** Never accept free text or silently strip an invalid tool/question. */
export function validateReaction(input, questions) {
  return runtimeCall(() => {
    questions = json(questions);
    const output = json(input);
    exactKeys(output, ['say', 'question_id', 'tools']);
    if (typeof output.say !== 'string' || output.say.length > 240
        || [...sentenceSegmenter.segment(output.say)].filter((s) => s.segment.trim()).length > 2
        || !(output.question_id === null || ref(output.question_id))
        || !Array.isArray(output.tools) || output.tools.length > 12) {
      throw new EngineError('invalid_output', 'Reaction must have say <=2 sentences/240 characters, question_id and tools', { status: 422 });
    }
    // The only v1 model tool requests design scheduling; no executable code,
    // confirmation, host mutation or arbitrary provider tools are accepted.
    for (const tool of output.tools) {
      exactKeys(tool, ['name']);
      if (tool.name !== 'design_intent') throw new EngineError('invalid_output', 'Unsupported reaction tool', { status: 422 });
    }
    if (output.question_id !== null && !questions.some((q) => q.question_id === output.question_id && ['open', 'asked'].includes(q.state))) {
      throw new EngineError('invalid_output', 'Selected question is not in the stored open-question list', { status: 422 });
    }
    return output;
  });
}

/** Offsets are UTF-16 string offsets, matching text.slice and the text UI. */
export function renderReaction(output, questions, corrections = []) {
  return runtimeCall(() => {
    questions = json(questions);
    corrections = json(corrections);
    output = validateReaction(output, questions);
    let text = '';
    const segments = [];
    function append(kind, body, fields = {}) {
      if (!body) return;
      if (text) text += '\n';
      const start = text.length;
      text += body;
      segments.push({ kind, start, end: text.length, ...fields });
    }
    for (const correction of corrections) {
      if (!ref(correction.correction_id) || typeof correction.text !== 'string' || !correction.text.length || correction.text.length > 1000) {
        throw new EngineError('invalid_correction', 'Rendered corrections require bounded stored text');
      }
      append('correction', correction.text, { correction_id: correction.correction_id });
    }
    append('say', output.say);
    if (output.question_id !== null) {
      const question = questions.find((q) => q.question_id === output.question_id);
      append('question', question.text, { question_id: question.question_id });
    }
    if (text.length > 4000) throw new EngineError('invalid_output', 'Rendered reaction exceeds the journal bound', { status: 413 });
    return { text, segments };
  });
}
