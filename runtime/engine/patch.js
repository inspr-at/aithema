import { addWorkingItem, confirmWorkingItem, createWorkingSpec, reviseWorkingItem } from '../../lib/working-spec.js';
import { validateItemProvenance } from '../provenance.js';
import { EngineError, exactKeys, json, ref, runtimeCall } from './common.js';

/**
 * Lane B can add/revise drafts, change the brief/questions, and queue corrections.
 * Confirmation, host submission/decisions and screen bindings are trusted paths,
 * never model tools. claim_ref is engine patch metadata, not a contract field.
 */
export function applySpecPatch(state, metadata, input, context) {
  return runtimeCall(() => {
    const patch = json(input);
    exactKeys(patch, ['base_rev', 'items', 'questions', 'brief', 'corrections'], ['base_rev', 'items']);
    if (patch.base_rev !== state.working_rev || !Array.isArray(patch.items) || patch.items.length > 200) {
      throw new EngineError('stale_patch', 'Spec patch must bind the current working revision', { status: 409 });
    }
    let domain = createWorkingSpec(state.host_mode, state.spec.items);
    for (const change of patch.items) {
      if (change.op === 'add') {
        exactKeys(change, ['op', 'item']);
        domain = addWorkingItem(domain, change.item);
      } else if (change.op === 'revise') {
        exactKeys(change, ['op', 'identity', 'revision']);
        domain = reviseWorkingItem(domain, change.identity, change.revision);
      } else throw new EngineError('invalid_output', 'Unsupported spec patch operation', { status: 422 });
    }
    // Check all evidence, including earlier turns/summary leaves, with the real
    // host ordinal index. A model's advisory intent never grants confirmation.
    for (const item of domain.items) validateItemProvenance(item, context);
    const next = structuredClone(state);
    const meta = structuredClone(metadata);
    next.spec.items = structuredClone(domain.items);
    if (Object.hasOwn(patch, 'brief')) next.spec.brief = patch.brief;
    if (Object.hasOwn(patch, 'questions')) {
      if (!Array.isArray(patch.questions) || patch.questions.length > 50) throw new EngineError('invalid_output', 'Invalid questions');
      const ids = new Set();
      next.spec.questions = patch.questions.map((question) => {
        exactKeys(question, ['question_id', 'text', 'state', 'asked_in_reaction_seq'], ['question_id', 'text', 'state']);
        const prior = state.spec.questions.find((q) => q.question_id === question.question_id && q.text === question.text);
        if (!ref(question.question_id) || ids.has(question.question_id)
            || !['open', 'asked', 'answered', 'dropped'].includes(question.state)
            || question.state === 'asked' && prior?.state !== 'asked'
            || Object.hasOwn(question, 'asked_in_reaction_seq') && question.asked_in_reaction_seq !== prior?.asked_in_reaction_seq) {
          throw new EngineError('invalid_output', 'Questions must be unique; asked state belongs to the engine');
        }
        ids.add(question.question_id);
        if (question.state === 'asked') return structuredClone(prior);
        return { ...question, ...(prior?.asked_in_reaction_seq !== undefined
          ? { asked_in_reaction_seq: prior.asked_in_reaction_seq } : {}) };
      });
    }
    if (Object.hasOwn(patch, 'corrections')) {
      if (!Array.isArray(patch.corrections) || patch.corrections.length > 32) throw new EngineError('invalid_output', 'Invalid corrections');
      for (const correction of patch.corrections) queueCorrection(next, meta, correction, context.records);
    }
    return { state: next, metadata: meta, patch };
  });
}

/** Include old confirmations dropped by an earlier worker's consumed watermark. */
export function pendingConfirmations(state, events) {
  return runtimeCall(() => events.filter((record) => record.kind === 'ui.confirm'
    && (record.seq > state.consumed_seq || state.spec.items.some((item) => item.state === 'draft'
      && item.item_ref === record.data.item_ref && item.version === record.data.version))));
}

/** The same trusted transition governs live UI actions, lane B and recovery. */
export function applyConfirmations(state, records) {
  return runtimeCall(() => {
    let domain = createWorkingSpec(state.host_mode, state.spec.items);
    for (const record of records) {
      if (record.kind !== 'ui.confirm' || record.writer.kind !== 'worker') {
        throw new EngineError('invalid_confirmation', 'Confirmation requires a trusted worker UI record', { status: 409 });
      }
      try { domain = confirmWorkingItem(domain, record.data); }
      catch (cause) {
        throw new EngineError('invalid_confirmation', 'Confirmation must bind the current complete item version and hash', { cause, status: 409 });
      }
    }
    state.spec.items = structuredClone(domain.items);
    return state;
  });
}

/** Durable identity: an immutable correction id, supersession only on claim_ref. */
export function queueCorrection(state, metadata, input, records) {
  return runtimeCall(() => {
    const correction = json(input);
    exactKeys(correction, ['correction_id', 'claim_ref', 'about_reaction_seq', 'text']);
    if (!ref(correction.correction_id) || !ref(correction.claim_ref)
        || !records.some((r) => r.kind === 'reaction' && r.seq === correction.about_reaction_seq)) {
      throw new EngineError('invalid_correction', 'Correction requires an existing reaction and a claim identity');
    }
    const { claim_ref, ...document } = correction;
    const prior = state.corrections.find((c) => c.correction_id === document.correction_id);
    if (prior) {
      if (prior.text !== document.text || prior.about_reaction_seq !== document.about_reaction_seq
          || metadata.claims[document.correction_id] !== claim_ref) {
        throw new EngineError('invalid_correction', 'Correction ids are immutable', { code: 'idempotency_conflict', status: 409 });
      }
      return false;
    }
    for (const old of state.corrections) {
      if (old.state === 'pending' && metadata.claims[old.correction_id] === claim_ref) old.state = 'superseded';
    }
    state.corrections.push({ ...document, state: 'pending' });
    metadata.claims[document.correction_id] = claim_ref;
    return true;
  });
}
