import { canonicalJson, sha256Hex, validate } from '../../../contracts/validate.js';
import { decodeDocument, submissionBytes } from '../../journal/port.js';
import { validateItemProvenance } from '../../provenance.js';
import { AeonError, checkDocument, UUID } from './http.js';

const operations = {
  post_source: { action: 'sources', verb: 'source', kind: 'source', id: 'source_id' },
  post_turn: { action: 'transcript-turns', verb: 'turn', kind: 'turn', id: 'turn_id' },
  submit: { action: 'drafts', verb: 'submit', id: 'draft_id' },
  replace: { action: 'replace', verb: 'replace', id: 'draft_id' },
};

function invalid(message) { return new AeonError(422, message, 'citation_invalid'); }

function candidate(doc, op, supersedes) {
  if (doc.contract !== 'aithema.spec.snapshot' || doc.host_mode !== 'review') throw new AeonError(400, 'Draft operations require a review snapshot');
  const candidates = doc.spec.items.filter((item) => item.state === 'confirmed' && item.host === null);
  if (candidates.length !== 1) throw new AeonError(400, 'Submit one complete confirmed version per operation');
  const item = candidates[0];
  if (op === 'replace') {
    const old = doc.spec.items.find((entry) => entry.host?.draft_id === supersedes);
    if (!UUID.test(supersedes) || !old || old.state !== 'superseded' || old.item_ref !== item.item_ref || old.kind !== item.kind ||
        old.version + 1 !== item.version || item.supersedes_item_version?.item_ref !== old.item_ref ||
        item.supersedes_item_version?.version !== old.version) throw new AeonError(400, 'Replacement must name the superseded draft and next item version');
  } else if (supersedes !== null || item.supersedes_item_version !== null) throw new AeonError(400, 'New drafts cannot supersede an existing item');
  return item;
}

function manifest(op, sid) {
  // Reuse the merged pending_op schema through its real snapshot root.
  const shell = { contract: 'aithema.spec.snapshot', major: 1, minor: 0, min_reader: 0,
    sid, client_event_id: sid, working_rev: 1, expected_prev_rev: 0, consumed_seq: 0,
    worker_generation: 1, host_mode: 'review', spec: { items: [], questions: [], brief: null, screens: [] },
    pending_ops: [op], corrections: [], patch: { canonical: '{}', sha256: sha256Hex('{}') } };
  if (!validate(shell.contract, shell).ok || !operations[op.op] ||
      !new RegExp(`^${sid}:${operations[op.op].verb}:[0-9]+$`).test(op.op_key)) throw new AeonError(400, 'Invalid intake operation manifest');
}

/**
 * The mock/plugin protocol accepts unchanged contract documents. Host-only
 * projection metadata travels in X-Aithema-Intake (base64url canonical JSON),
 * with X-Supersedes-Draft-Id also naming the replacement predecessor. Keeping
 * both metadata and document_bytes in pending_op.payload makes restart retries
 * independent of current source mappings, generations, clocks or serialisers.
 * The real Aeon plugin must consume this metadata when creating native drafts.
 * Typed working-item extensions stay inside document_bytes, byte-exact across
 * submission, replacement and retries; native rendering belongs to Aeon.
 */
export class AeonIntake {
  #http;
  #bindings = new Map();
  #supportsReplace;

  constructor({ http, supportsReplace = false }) {
    if (!http || typeof http.request !== 'function' || typeof supportsReplace !== 'boolean') throw new TypeError('AeonIntake requires AeonHttp and declared host features');
    this.#http = http;
    // intake.write alone does not prove that AEON-P02 is installed (§13).
    this.#supportsReplace = supportsReplace;
  }

  /** Restore host-owned IDs from acknowledged receipts, never from lane B. */
  bindHostSource(record, hostIds, { conversationSourceId } = {}) {
    checkDocument(record, 'aithema.journal.record');
    if (record.sid !== this.#http.scope.sid || !Number.isSafeInteger(record.seq) || record.seq < 1) throw invalid('Foreign or unacknowledged host source');
    let binding;
    if (record.kind === 'source' && UUID.test(hostIds?.source_id)) binding = { source_id: hostIds.source_id };
    else if (record.kind === 'turn' && record.data.speaker === 'person' && UUID.test(hostIds?.turn_id) && UUID.test(conversationSourceId)) {
      binding = { source_id: conversationSourceId, turn_id: hostIds.turn_id };
    } else throw invalid('Missing host source identity or non-evidence record');
    const prior = this.#bindings.get(record.seq);
    if (prior && canonicalJson(prior) !== canonicalJson(binding)) throw new AeonError(409, 'Host source identity changed', 'idempotency_conflict');
    this.#bindings.set(record.seq, binding);
    return { ...binding };
  }

  /** Caller owns durable counters. No counter is guessed from a volatile cache. */
  prepare({ op, n, bytes, supersedes_draft_id = null, conversation_source_id = null, context }) {
    if (!operations[op] || !Number.isSafeInteger(n) || n < 0) throw new AeonError(400, 'Invalid intake operation or counter');
    if (op === 'replace' && !this.#supportsReplace) throw new AeonError(501, 'Host atomic replacement support is required');
    const original = submissionBytes(bytes);
    const doc = decodeDocument(original, { submission: true });
    const sid = this.#http.scope.sid;
    if (doc.sid !== sid) throw new AeonError(403, 'Foreign intake document');
    let metadata;
    if (operations[op].kind) {
      if (doc.contract !== 'aithema.journal.record' || doc.kind !== operations[op].kind || doc.writer.kind !== 'worker') throw new AeonError(400, 'Wrong intake source or turn document');
      if (supersedes_draft_id !== null || op === 'post_source' && conversation_source_id !== null ||
          op === 'post_turn' && !UUID.test(conversation_source_id)) throw new AeonError(400, 'Turn requires a host conversation source id');
      if (op === 'post_turn' && ![...this.#bindings.values()].some((binding) => binding.source_id === conversation_source_id)) {
        throw invalid('Turn conversation source is not an acknowledged host source');
      }
      metadata = { conversation_source_id };
    } else {
      const item = candidate(doc, op, supersedes_draft_id);
      let leaves = [];
      if (item.citations.length || item.provenance.derived_from.length) {
        if (context?.sid !== sid) throw invalid('Submission requires the hydrated citation context');
        try { leaves = validateItemProvenance(item, context).leaf_refs; }
        catch (error) {
          if (error.code === 'contract_too_new') throw new AeonError(422, 'Unsupported evidence contract', error.code);
          throw invalid('Submission citations do not resolve to person turns or document segments');
        }
      }
      const citations = leaves.map((leaf) => {
        const binding = this.#bindings.get(leaf.record_seq);
        if (!binding) throw invalid('Citation has no acknowledged host source id');
        const quote = item.citations.find((c) => c.record_seq === leaf.record_seq && c.locator === leaf.locator)?.quote;
        return { ...binding, locator: leaf.locator, ...(quote === undefined ? {} : { quote }) };
      });
      metadata = { kind: item.kind === 'requirement' ? 'requirement' : 'brief', citations, supersedes_draft_id };
    }
    const payload = canonicalJson({ document_bytes: original.toString('utf8'), metadata });
    const result = { op_key: `${sid}:${operations[op].verb}:${n}`, op, payload_sha256: sha256Hex(payload), payload };
    manifest(result, sid);
    return result;
  }

  #decode(request) {
    const { payload_bytes, ...op } = request;
    manifest(op, this.#http.scope.sid);
    if (payload_bytes !== undefined && !submissionBytes(payload_bytes).equals(Buffer.from(op.payload, 'utf8'))) throw new AeonError(409, 'Retry payload bytes changed', 'idempotency_conflict');
    let payload;
    try { payload = JSON.parse(op.payload); } catch { throw new AeonError(400, 'Malformed intake payload'); }
    if (!payload || typeof payload.document_bytes !== 'string' || !payload.metadata || Object.keys(payload).some((key) => !['document_bytes', 'metadata'].includes(key))) {
      throw new AeonError(400, 'Invalid persisted intake envelope');
    }
    const doc = decodeDocument(Buffer.from(payload.document_bytes), { submission: true });
    if (doc.sid !== this.#http.scope.sid) throw new AeonError(403, 'Foreign persisted intake document');
    const metadata = payload.metadata;
    if (operations[op.op].kind) {
      if (doc.contract !== 'aithema.journal.record' || doc.kind !== operations[op.op].kind || doc.writer.kind !== 'worker' ||
          Object.keys(metadata).some((key) => key !== 'conversation_source_id') ||
          (op.op === 'post_turn' ? !UUID.test(metadata.conversation_source_id) : metadata.conversation_source_id !== null)) throw new AeonError(400, 'Invalid persisted source operation');
    } else {
      const item = candidate(doc, op.op, metadata.supersedes_draft_id);
      if (Object.keys(metadata).some((key) => !['kind', 'citations', 'supersedes_draft_id'].includes(key)) ||
          metadata.kind !== (item.kind === 'requirement' ? 'requirement' : 'brief') || !Array.isArray(metadata.citations) ||
          metadata.citations.some((c) => !UUID.test(c.source_id) || c.turn_id !== undefined && !UUID.test(c.turn_id) ||
            typeof c.locator !== 'string' || !/^(turn:[0-9]+|seg:[A-Za-z0-9_-]{1,64})$/.test(c.locator) ||
            c.locator.startsWith('turn:') !== Object.hasOwn(c, 'turn_id') ||
            c.quote !== undefined && (typeof c.quote !== 'string' || c.quote.length === 0) ||
            Object.keys(c).some((key) => !['source_id', 'turn_id', 'locator', 'quote'].includes(key)))) throw new AeonError(400, 'Invalid persisted draft projection');
      if ((item.citations.length || item.provenance.derived_from.length) && metadata.citations.length === 0) throw invalid('Persisted operation omitted host citations');
    }
    return { op, payload, doc };
  }

  /** Execute/retry once. Arbitration codes remain visible to the engine. */
  async execute(request, authority) {
    const { op, payload, doc } = this.#decode(request);
    if (op.op === 'replace' && !this.#supportsReplace) throw new AeonError(501, 'Host atomic replacement support is required');
    const metadata = payload.metadata;
    const response = await this.#http.request({ area: 'intake', action: operations[op.op].action,
      id: metadata.supersedes_draft_id ?? null, method: 'POST', capability: 'intake.write', authority,
      bytes: Buffer.from(payload.document_bytes, 'utf8'), headers: {
        'idempotency-key': op.op_key,
        'x-aithema-intake': Buffer.from(canonicalJson(metadata)).toString('base64url'),
        ...(metadata.supersedes_draft_id ? { 'x-supersedes-draft-id': metadata.supersedes_draft_id } : {}),
      } });
    const result = checkDocument(response?.result, 'aithema.journal.record');
    const field = operations[op.op].id;
    if (result.sid !== authority.sid || result.kind !== 'op.result' || result.data.op_key !== op.op_key ||
        Object.keys(result.data.host_ids).length !== 1 || !UUID.test(result.data.host_ids[field])) throw new AeonError(502, 'Intake acknowledgement does not match its operation');
    if (operations[op.op].kind) {
      const stored = checkDocument(response.record, 'aithema.journal.record');
      const { seq, ...submission } = stored;
      if (!Number.isSafeInteger(seq) || seq < 1 || canonicalJson(submission) !== canonicalJson(doc)) throw new AeonError(502, 'Intake source acknowledgement changed the document');
      if (stored.kind === 'source' || stored.data.speaker === 'person') {
        this.bindHostSource(stored, result.data.host_ids, { conversationSourceId: metadata.conversation_source_id });
      }
    } else {
      const projected = checkDocument(response.snapshot, 'aithema.spec.snapshot');
      const item = candidate(doc, op.op, metadata.supersedes_draft_id);
      const hostItem = projected.spec.items.find((entry) => entry.host?.draft_id === result.data.host_ids.draft_id);
      if (projected.sid !== authority.sid || !hostItem || hostItem.item_ref !== item.item_ref || hostItem.version !== item.version ||
          hostItem.state !== 'proposed' || hostItem.host.op_key !== op.op_key ||
          canonicalJson({ ...hostItem, host: null, state: 'confirmed' }) !== canonicalJson(item) ||
          response.supersedes_draft_id !== metadata.supersedes_draft_id || metadata.supersedes_draft_id &&
          !projected.spec.items.some((entry) => entry.host?.draft_id === metadata.supersedes_draft_id && entry.state === 'superseded')) {
        throw new AeonError(502, 'Intake draft acknowledgement changed its identity or content');
      }
    }
    return response;
  }

  /** Directly usable as JournalClient.resume({retryOp}). */
  async retryOp(request, authority) { return (await this.execute(request, authority)).result.data.host_ids; }

  async snapshot(authority, { signal } = {}) {
    const response = await this.#http.request({ area: 'intake', capability: 'intake.read', authority, signal });
    if (!response || !Array.isArray(response.sources) || !Array.isArray(response.turns) || response.snapshot === undefined) throw new AeonError(502, 'Invalid intake snapshot response');
    const ids = new Set();
    for (const [records, kind] of [[response.sources, 'source'], [response.turns, 'turn']]) {
      for (const record of records) {
        checkDocument(record, 'aithema.journal.record');
        if (record.sid !== authority.sid || record.kind !== kind || !Number.isSafeInteger(record.seq) || record.seq < 1 || ids.has(record.seq)) throw new AeonError(502, 'Foreign or duplicate intake evidence');
        ids.add(record.seq);
      }
    }
    if (response.snapshot !== null) {
      checkDocument(response.snapshot, 'aithema.spec.snapshot');
      if (response.snapshot.sid !== authority.sid) throw new AeonError(502, 'Foreign intake snapshot');
    }
    return response;
  }
}
