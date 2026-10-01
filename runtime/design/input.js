import { canonicalJson, sha256Hex } from '../../contracts/validate.js';
import { checkedRecord } from '../journal/hydrate.js';
import { decodeDocument } from '../journal/port.js';
import { checkGenerator, checkRenderer, renderScreen } from './renderer.js';
import { DesignError, validateScreen, validateTokens } from './validate.js';

/** Pure submission builder. The caller owns ids/time; neither enters HTML. */
export function designInputRecord({ screen_ir, tokens, renderer_version, generator_id,
  sid, generation, client_event_id, recorded_at }) {
  validateScreen(screen_ir);
  validateTokens(tokens);
  checkRenderer(renderer_version);
  checkGenerator(generator_id);
  if (screen_ir.renderer_version !== renderer_version || canonicalJson(screen_ir.generator_id) !== canonicalJson(generator_id)) {
    throw new DesignError('design_input_invalid', 'Rendering identity must match the persisted IR metadata');
  }
  const doc = { contract: 'aithema.journal.record', major: 1, minor: 0, min_reader: 0,
    sid, client_event_id, recorded_at, writer: { kind: 'worker', generation }, kind: 'design.input',
    data: { screen_ir, screen_ir_sha256: sha256Hex(canonicalJson(screen_ir)),
      tokens, tokens_sha256: sha256Hex(canonicalJson(tokens)) } };
  const bytes = Buffer.from(canonicalJson(doc), 'utf8');
  decodeInput(bytes);
  return bytes;
}

export function decodeInput(bytes) {
  let doc;
  try { doc = decodeDocument(bytes, { submission: true }); }
  catch (error) { throw new DesignError(error.code === 'contract_too_new' ? error.code : 'design_input_invalid', 'Invalid immutable design input submission'); }
  if (doc.kind !== 'design.input') throw new DesignError('design_input_invalid', 'Expected design.input');
  validateScreen(doc.data.screen_ir);
  validateTokens(doc.data.tokens);
  checkRenderer(doc.data.screen_ir.renderer_version);
  checkGenerator(doc.data.screen_ir.generator_id);
  return doc;
}

/** A record's original bytes and host-assigned projection must agree. */
export function storedDesignInput(record) {
  const original = decodeInput(record?.bytes);
  let checked;
  try { checked = checkedRecord(record, original.sid); }
  catch { throw new DesignError('design_input_invalid', 'Host design input bytes and projection disagree'); }
  return { ...checked.document.data, renderer_version: original.data.screen_ir.renderer_version,
    generator_id: original.data.screen_ir.generator_id, design_input_seq: checked.document.seq };
}

export function renderStoredDesign(record) {
  return renderScreen(storedDesignInput(record));
}

/** Compatible with journal/hydrate.js reopenDesign renderer callback. */
export function renderHydratedDesign({ screen_ir_bytes, tokens_bytes, record_bytes, design_input_seq }) {
  const document = decodeInput(record_bytes);
  if (!(screen_ir_bytes instanceof Uint8Array) || !(tokens_bytes instanceof Uint8Array)
      || !Buffer.from(screen_ir_bytes).equals(Buffer.from(canonicalJson(document.data.screen_ir)))
      || !Buffer.from(tokens_bytes).equals(Buffer.from(canonicalJson(document.data.tokens)))) {
    throw new DesignError('design_input_invalid', 'Hydrated IR or tokens differ from the immutable input');
  }
  return renderStoredDesign({ bytes: record_bytes, document: { ...document, seq: design_input_seq } });
}
