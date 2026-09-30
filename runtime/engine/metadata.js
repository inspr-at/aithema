import { validate } from '../../contracts/validate.js';
import { EngineError, exactKeys, ref, runtimeCall } from './common.js';

/** Durable terminal states use revisions, never a prior process's clock origin. */
export function validateDesignResults(results, workingRev = Infinity) {
  return runtimeCall(() => {
    const ids = new Set();
    if (!Array.isArray(results) || results.length > 400) throw new EngineError('invalid_resume', 'Invalid design completions', { status: 422 });
    for (const result of results) {
      exactKeys(result, ['intent_id', 'state', 'working_rev', 'rendered_rev', 'attempts']);
      if (!ref(result.intent_id) || ids.has(result.intent_id) || !['rendered', 'render_failed', 'blocked'].includes(result.state)
          || !Number.isSafeInteger(result.working_rev) || result.working_rev < 1
          || !Number.isSafeInteger(result.rendered_rev) || result.rendered_rev < result.working_rev
          || result.rendered_rev > workingRev || ![1, 2].includes(result.attempts)
          || result.state === 'render_failed' && result.attempts !== 2) {
        throw new EngineError('invalid_resume', 'Invalid design completion identity or revision', { status: 422 });
      }
      ids.add(result.intent_id);
    }
    return true;
  });
}

/**
 * Foundation patch bytes are opaque JSON. Validate our own versioned subformat
 * too: an invalid receipt must never suppress an acknowledged person's turn.
 */
export function validateEngineMetadata(state, meta, events) {
  return runtimeCall(() => {
    const fail = () => { throw new EngineError('invalid_resume', 'Malformed engine delivery metadata', { status: 422 }); };
    exactKeys(meta, ['version', 'claims', 'receipts', 'outbox', 'last_activity_at', 'design_results'],
      ['version', 'claims', 'receipts', 'outbox', 'last_activity_at']);
    if (meta.version !== 1 || !Number.isFinite(meta.last_activity_at) || !meta.claims || Array.isArray(meta.claims)
        || !Array.isArray(meta.receipts) || meta.receipts.length > 432) fail();
    validateDesignResults(Object.hasOwn(meta, 'design_results') ? meta.design_results : [], state.working_rev);
    const corrections = new Map(state.corrections.map((c) => [c.correction_id, c]));
    for (const [id, claim] of Object.entries(meta.claims)) if (!corrections.has(id) || !ref(claim)) fail();
    for (const correction of state.corrections) {
      if (correction.state === 'pending' && !Object.hasOwn(meta.claims, correction.correction_id)) fail();
    }
    const records = new Map(events.map((r) => [r.seq, r]));
    const ids = new Set();
    function segments(list, text, tools) {
      if (!Array.isArray(list) || list.length > 34 || !Array.isArray(tools) || tools.length > 12) fail();
      let end = 0;
      let question = false;
      for (const segment of list) {
        exactKeys(segment, ['kind', 'start', 'end', 'question_id', 'correction_id'], ['kind', 'start', 'end']);
        if (!['say', 'question', 'correction'].includes(segment.kind) || question
            || !Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end)
            || segment.start !== (end ? end + 1 : 0) || segment.end <= segment.start || segment.end > text.length
            || end && text[end] !== '\n') fail();
        if (segment.kind === 'question') {
          if (!ref(segment.question_id) || Object.hasOwn(segment, 'correction_id')) fail();
          question = true;
        } else if (segment.kind === 'correction') {
          if (!corrections.has(segment.correction_id) || Object.hasOwn(segment, 'question_id')) fail();
        } else if (Object.hasOwn(segment, 'question_id') || Object.hasOwn(segment, 'correction_id')) fail();
        end = segment.end;
      }
      if (end !== text.length) fail();
      for (const tool of tools) { exactKeys(tool, ['name']); if (tool.name !== 'design_intent') fail(); }
    }
    for (const receipt of meta.receipts) {
      exactKeys(receipt, ['client_event_id', 'turn_seq', 'reaction_seq', 'segments', 'tools', 'working_rev']);
      const reaction = records.get(receipt.reaction_seq);
      if (!reaction || reaction.kind !== 'reaction' || reaction.client_event_id !== receipt.client_event_id
          || reaction.data.turn_seq !== receipt.turn_seq || !reaction.data.complete || reaction.data.certainty !== 'delivered'
          || ids.has(receipt.client_event_id) || !Number.isSafeInteger(receipt.working_rev)
          || receipt.working_rev < 1 || receipt.working_rev > state.working_rev) fail();
      ids.add(receipt.client_event_id);
      segments(receipt.segments, reaction.data.text, receipt.tools);
    }
    for (const result of meta.design_results ?? []) {
      if (!result.intent_id.startsWith('reaction:')) continue;
      const receipt = meta.receipts.find((row) => `reaction:${row.reaction_seq}` === result.intent_id);
      if (!receipt || receipt.working_rev !== result.working_rev || !receipt.tools.some((tool) => tool.name === 'design_intent')) fail();
    }
    if (meta.outbox !== null) {
      const outbox = meta.outbox;
      exactKeys(outbox, ['client_event_id', 'recorded_at', 'turn_seq', 'text', 'segments', 'tools']);
      if (ids.has(outbox.client_event_id)) fail();
      const record = { contract: 'aithema.journal.record', major: 1, minor: 0, min_reader: 0,
        sid: state.sid, writer: { kind: 'worker', generation: 1 }, client_event_id: outbox.client_event_id,
        recorded_at: outbox.recorded_at, kind: 'reaction', data: { turn_seq: outbox.turn_seq, text: outbox.text,
          delivered_prefix: outbox.text, certainty: 'delivered', complete: true } };
      if (!validate(record.contract, record).ok) fail();
      if (outbox.turn_seq && (records.get(outbox.turn_seq)?.kind !== 'turn' || records.get(outbox.turn_seq).data.speaker !== 'person')) fail();
      segments(outbox.segments, outbox.text, outbox.tools);
    }
    return true;
  });
}
