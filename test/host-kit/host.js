import { randomUUID } from 'node:crypto';
import { canonicalJson, pendingContentReference, sha256Hex, validateExtensions } from '../../contracts/validate.js';
import { registerExtension } from '../../lib/extensions.js';
import { validateItemProvenance } from '../../runtime/provenance.js';
import { journalChunkBytes, verifyPendingContent } from '../../runtime/journal/pending-content.js';
import {
  budget, capabilities, document, envelope, errorResponse, fail, HostError, input, intakeMetadata, transitions,
} from './protocol.js';

/** Concrete host-side routes. /v1/* callbacks belong to the service, not this host. */
export const routes = [
  { area: 'intake', action: 'sources', method: 'POST', capability: 'intake.write' },
  { area: 'intake', action: 'transcript-turns', method: 'POST', capability: 'intake.write' },
  { area: 'intake', action: 'drafts', method: 'POST', capability: 'intake.write' },
  { area: 'intake', action: 'replace', method: 'POST', capability: 'intake.write' },
  { area: 'intake', action: '', method: 'GET', capability: 'intake.read' },
  { area: 'intake', action: 'accept', method: 'POST', capability: 'intake.decide' },
  { area: 'journal', action: 'records', method: 'POST', capability: 'aithema.journal.write' },
  { area: 'journal', action: 'snapshots', method: 'POST', capability: 'aithema.journal.write' },
  { area: 'journal', action: 'op.result', method: 'POST', capability: 'aithema.journal.write' },
  { area: 'journal', action: 'records', method: 'GET', capability: 'aithema.journal.read' },
  { area: 'journal', action: 'cursor', method: 'GET', capability: 'aithema.journal.read' },
  { area: 'journal', action: 'authority', method: 'GET', capability: 'aithema.authority.read' },
  { area: 'ledger', action: 'admit', method: 'POST', capability: 'aithema.ledger' },
  { area: 'ledger', action: 'claim', method: 'POST', capability: 'aithema.ledger' },
  { area: 'ledger', action: 'settle', method: 'POST', capability: 'aithema.ledger' },
  { area: 'ledger', action: 'recover', method: 'POST', capability: 'aithema.ledger' },
  { area: 'ledger', action: 'holds', method: 'GET', capability: 'aithema.ledger' },
].map((route) => {
  // Ledger shares a capability across reads, ordinary controls and recovery.
  const matches = capabilities.routes.filter((entry) => entry.capability === route.capability &&
    (entry.class === 'read') === (route.method === 'GET') &&
    entry.checks.includes('gen = current only') === (route.action === 'recover'));
  if (matches.length !== 1) throw new Error(`Ambiguous or missing capability binding: ${route.method} ${route.area}/${route.action}`);
  return Object.freeze({ ...route, ...matches[0], route: undefined });
});

export function routePath(area, sid, action = '', draftId = null) {
  return `/${area}/sessions/${sid}${draftId ? `/drafts/${draftId}` : ''}${action ? `/${action}` : ''}`;
}

function matchRoute(method, path) {
  const url = new URL(path, 'http://127.0.0.1');
  const match = /^\/(journal|ledger|intake)\/sessions\/([0-9a-f-]{36})(?:\/([^/]+)(?:\/([0-9a-f-]{36})\/(replace|accept))?)?$/.exec(url.pathname);
  if (!match) throw new HostError(404, 'Unknown host route');
  const [, area, sid, suffix = '', draftId, op] = match;
  if (draftId && suffix !== 'drafts') throw new HostError(404, 'Unknown draft route');
  const action = op ?? suffix;
  const route = routes.find((entry) => entry.area === area && entry.action === action && entry.method === method);
  if (!route) throw new HostError(404, 'Unknown host route');
  return { ...route, sid, draftId, query: url.searchParams };
}

function count(value, defaultValue) {
  if (value === null) return defaultValue;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new HostError(400, 'Invalid cursor or limit');
  return Number(value);
}

function success(body, headers = {}) {
  return { status: 200, headers: { 'cache-control': 'no-store', ...headers }, body: structuredClone(body) };
}

/**
 * In-memory P13 host. request() and the HTTP facade share one synchronous
 * transaction path, so neither can yield between fencing, replay and effects.
 * Fixture controls are intentionally in-process only, never exposed as routes.
 *
 * Intake sources/turns use journal records; draft submissions use a complete
 * spec.snapshot containing exactly one confirmed candidate. Replacements carry
 * the previous version as superseded in that input snapshot. Op keys travel as
 * request metadata (HTTP Idempotency-Key), not new contract fields. Results are
 * op.result records plus the authoritative intake snapshot. No schema is added.
 */
export class MockHost {
  #sessions = new Map();
  #persons = new Map();
  #grants = new Map();

  constructor({ verifier, now = () => Math.floor(Date.now() / 1000), caps = {} }) {
    this.verifier = verifier;
    this.now = now;
    this.caps = { session: 1_000_000, principalDay: 10_000_000, tenantDay: 100_000_000, ...caps };
    for (const cap of Object.values(this.caps)) {
      if (!Number.isSafeInteger(cap) || cap < 0) throw new TypeError('Caps must be nonnegative safe integers');
    }
  }

  /** Authorization is a real contract document; options are fixture controls. */
  createSession(authz, { generation = 1, principal = 'plugin-aithema', hostMode = 'review', evidence = true, currency = 'EUR' } = {}) {
    document(authz, 'aithema.authz');
    if (this.#sessions.has(authz.sid)) throw new HostError(409, 'Session exists');
    if (!Number.isSafeInteger(generation) || generation < 1 || !['review', 'working_spec_only'].includes(hostMode) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(principal) || !/^[A-Z]{3}$/.test(currency) || typeof evidence !== 'boolean') {
      throw new TypeError('Invalid session options');
    }
    this.#sessions.set(authz.sid, {
      authz: structuredClone(authz), generation, principal, hostMode, evidence, currency,
      tombstone: authz.withdrawn_at !== null, seq: 0, workingRev: 0, snapshot: null,
      records: [], events: new Map(), content: new Map(), uploads: new Map(), operations: new Map(), imports: new Map(), drafts: new Map(),
      intakeRev: 0, intakeSnapshot: null, extensionRegistry: [], attempts: new Map(), holds: new Map(), claims: new Map(), holdSequence: 0,
    });
    return structuredClone(authz);
  }

  #session(sid) {
    const session = this.#sessions.get(sid);
    if (!session) throw new HostError(404, 'Unknown session');
    return session;
  }

  takeover(sid) {
    const session = this.#session(sid);
    if (session.generation === Number.MAX_SAFE_INTEGER) throw new Error('Generation exhausted');
    session.uploads.clear();
    return ++session.generation;
  }

  setEvidence(sid, present) {
    if (typeof present !== 'boolean') throw new TypeError('Evidence must be boolean');
    this.#session(sid).evidence = present;
  }

  /** In-process fixture control; no registration route is exposed over HTTP. */
  registerExtension(sid, descriptor) {
    const session = this.#session(sid);
    session.extensionRegistry = registerExtension(session.extensionRegistry, descriptor);
  }

  /** Host writes control records before changing the authoritative projection. */
  revoke(sid, { tombstone = true } = {}) {
    const session = this.#session(sid);
    const epoch = session.authz.epoch + 1;
    const record = this.#hostRecord(session, 'authz.epoch', { epoch, reason: 'withdrawal' });
    const control = tombstone ? this.#hostRecord(session, 'session.control', { action: 'suspend' }) : null;
    session.authz.epoch = epoch;
    session.authz.withdrawn_at = new Date(this.now() * 1000).toISOString();
    session.tombstone = tombstone;
    session.uploads.clear();
    return { record, control };
  }

  /** A distinct opaque person session, never a JWT, is required for acceptance. */
  personSession(sid, participantRef, permissions = ['intake.decide']) {
    const session = this.#session(sid);
    if (!session.authz.participants.some((p) => p.participant_ref === participantRef)) throw new HostError(403, 'Unknown person');
    const handle = randomUUID();
    this.#persons.set(handle, { sid, participantRef, permissions: [...permissions], epoch: session.authz.epoch });
    return handle;
  }

  /** Ephemeral grant is bound to session, generation, epoch and expiration. */
  liveGrant(sid, lifetime = 900) {
    const session = this.#session(sid);
    if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 900) throw new TypeError('Invalid grant lifetime');
    const handle = randomUUID();
    this.#grants.set(handle, { sid, gen: session.generation, epoch: session.authz.epoch, exp: this.now() + lifetime });
    return handle;
  }

  #authorize(route, session, request) {
    if (route.class === 'person-only') {
      if (request.token !== undefined) throw new HostError(403, 'Acceptance is person-only');
      const person = this.#persons.get(request.person);
      if (!person || person.sid !== route.sid || !person.permissions.includes(route.capability)) throw new HostError(403, 'Person decision permission required');
      if (session.tombstone || session.authz.withdrawn_at !== null || person.epoch !== session.authz.epoch) fail('revoked');
      return person;
    }
    const claims = this.verifier.verify(request.token, 'delegated').claims;
    if (!claims.capabilities.includes(route.capability)) throw new HostError(403, 'Exact capability required');
    if (claims.sid !== route.sid || claims.tid !== session.authz.tid ||
        (route.checks.includes('pid') && claims.pid !== session.authz.pid)) throw new HostError(403, 'Foreign token scope');
    if (claims.sub !== session.principal || !session.authz.participants.some((p) => p.participant_ref === claims.act.sub)) throw new HostError(403, 'Foreign principal');
    if (route.checks.includes('epoch') && (session.tombstone || session.authz.withdrawn_at !== null || claims.auth_epoch !== session.authz.epoch)) fail('revoked');
    if (route.class === 'write' || route.class === 'control') {
      if (claims.gen !== session.generation) fail('fenced_generation');
    }
    if (route.checks.includes('ephemeral LiveGrant')) {
      const grant = this.#grants.get(request.liveGrant);
      if (!grant || grant.sid !== route.sid || grant.gen !== session.generation || grant.epoch !== session.authz.epoch || grant.exp <= this.now()) {
        throw new HostError(403, 'Current ephemeral LiveGrant required');
      }
    }
    return claims;
  }

  request(request) {
    try {
      const route = matchRoute(request.method, request.path);
      const session = this.#session(route.sid);
      const actor = this.#authorize(route, session, request);
      if (route.method === 'GET') return this.#read(route, session);
      if (route.action === 'accept') return this.#accept(route, session, request);
      const payload = input(request.body);
      if (route.area === 'journal' && route.query.has('upload')) return this.#journalUpload(route, session, actor, payload);
      if (route.area === 'intake' && route.query.get('content') === 'reference') {
        const op = { payload: payload.bytes };
        let canonical;
        try {
          const ref = pendingContentReference(op.payload);
          const record = session.records.find((entry) => entry.seq === ref.record_seq);
          canonical = verifyPendingContent(op, record ? { document: record } : null, route.sid);
        } catch { fail('citation_invalid'); }
        const content = JSON.parse(canonical);
        if (request.intakeMetadata !== undefined && canonicalJson(intakeMetadata(request.intakeMetadata)) !== canonicalJson(content.metadata)) {
          fail('idempotency_conflict');
        }
        const metadataHeader = Buffer.from(canonicalJson(content.metadata)).toString('base64url');
        return this.#intake(route, session, actor, input(content.document_bytes), request.opKey, metadataHeader);
      }
      if (route.area === 'journal') return this.#journal(route, session, actor, payload);
      if (route.area === 'intake') return this.#intake(route, session, actor, payload, request.opKey, request.intakeMetadata);
      return this.#ledger(route, session, actor, payload);
    } catch (error) {
      return errorResponse(error);
    }
  }

  #read(route, session) {
    if (route.area === 'intake') {
      return success({
        sources: [...session.imports.values()].filter((entry) => entry.record.kind === 'source').map((entry) => entry.record),
        turns: [...session.imports.values()].filter((entry) => entry.record.kind === 'turn').map((entry) => entry.record),
        snapshot: session.intakeSnapshot,
      });
    }
    if (route.action === 'authority') {
      return success({ authorization: document(session.authz, 'aithema.authz'), worker_generation: session.generation,
        auth_epoch: session.authz.epoch, tombstone: session.tombstone, issued_at: new Date(this.now() * 1000).toISOString() });
    }
    if (route.action === 'cursor') return success({ seq: session.seq, working_rev: session.workingRev,
      snapshot: route.query.get('snapshot') === 'seq' && session.snapshot ? { seq: session.snapshot.seq } : session.snapshot });
    if (route.action === 'records') {
      if (route.query.has('digests')) {
        const digests = route.query.get('digests').split(',');
        if (digests.some((digest) => !/^[0-9a-f]{64}$/.test(digest))) throw new HostError(400, 'Invalid content digests');
        return success([...new Set(digests)].flatMap((digest) => {
          const record = session.content.get(digest);
          return record ? [{ seq: record.seq }] : [];
        }));
      }
      if (route.query.has('offset')) {
        const seq = count(route.query.get('ids'), null);
        const record = session.records.find((entry) => entry.seq === seq);
        if (!record) throw new HostError(404, 'Missing journal record');
        const offset = count(route.query.get('offset'), 0);
        const length = count(route.query.get('length'), journalChunkBytes);
        const bytes = Buffer.from(session.events.get(record.client_event_id).bytes, 'utf8');
        if (length < 1 || length > journalChunkBytes || offset >= bytes.length) throw new HostError(400, 'Invalid chunk range');
        return success({ seq, offset, total: bytes.length, chunk: bytes.subarray(offset, offset + length).toString('base64') });
      }
      const after = count(route.query.get('after'), 0);
      let ids = null;
      if (route.query.has('ids')) ids = new Set(route.query.get('ids').split(',').map((id) => count(id, null)));
      return success(session.records.filter((record) => ids ? ids.has(record.seq) : record.seq > after));
    }
    if (route.query.get('state') !== 'open') throw new HostError(400, 'Only authoritative open holds are supported');
    const limit = count(route.query.get('limit'), 1000);
    if (limit < 1 || limit > 1000) throw new HostError(400, 'Limit must be 1..1000');
    let cursor = 0;
    if (route.query.has('cursor')) {
      const parts = route.query.get('cursor').split(':');
      if (parts.length !== 2 || parts[0] !== route.sid) throw new HostError(400, 'Foreign hold cursor');
      cursor = count(parts[1], 0);
    }
    // Keyset pagination survives recovering/deleting earlier pages (no offsets).
    const open = [...session.holds.values()].filter((hold) => !hold.closed && hold.order > cursor);
    const page = open.slice(0, limit);
    return success(budget('holds_list', { sid: route.sid, state: 'open',
      holds: page.map((h) => ({ hold_id: h.id, attempt_id: h.request.attempt_id, claimed: h.claim !== null })),
      next_cursor: open.length > limit ? `${route.sid}:${page.at(-1).order}` : null,
    }));
  }

  #append(session, payload) {
    const previous = session.events.get(payload.doc.client_event_id);
    if (previous) {
      if (previous.bytes !== payload.bytes) fail('idempotency_conflict');
      return previous.record;
    }
    if (payload.doc.kind === 'pending_op.content') {
      const prior = session.content.get(payload.doc.data.sha256);
      if (prior) {
        if (canonicalJson(prior.data) !== canonicalJson(payload.doc.data)) fail('idempotency_conflict');
        session.events.set(payload.doc.client_event_id, { bytes: payload.bytes, record: prior });
        return prior;
      }
    }
    const record = document({ ...structuredClone(payload.doc), seq: session.seq + 1 }, payload.doc.contract);
    session.seq = record.seq;
    session.records.push(record);
    session.events.set(record.client_event_id, { bytes: payload.bytes, record });
    if (record.kind === 'pending_op.content') session.content.set(record.data.sha256, record);
    return record;
  }

  #hostRecord(session, kind, data) {
    const doc = document(envelope('aithema.journal.record', { sid: session.authz.sid, client_event_id: randomUUID(),
      writer: { kind: 'host' }, recorded_at: new Date(this.now() * 1000).toISOString(), kind, data }), 'aithema.journal.record');
    return structuredClone(this.#append(session, { doc, bytes: JSON.stringify(doc) }));
  }

  #workerDocument(session, kind, data) {
    return document(envelope('aithema.journal.record', { sid: session.authz.sid, client_event_id: randomUUID(),
      writer: { kind: 'worker', generation: session.generation }, recorded_at: new Date(this.now() * 1000).toISOString(), kind, data }), 'aithema.journal.record');
  }

  #journal(route, session, actor, payload) {
    const acknowledgement = (record) => success(route.query.get('ack') === 'seq' ? { seq: record.seq } : record);
    const contract = route.action === 'snapshots' ? 'aithema.spec.snapshot' : 'aithema.journal.record';
    if (!payload.doc || payload.doc.contract !== contract) throw new HostError(400, `Expected ${contract}`);
    if (route.action === 'op.result' && payload.doc.kind !== 'op.result') throw new HostError(400, 'Expected op.result record');
    const previous = session.events.get(payload.doc.client_event_id);
    if (previous) return acknowledgement(this.#append(session, payload));
    // Token fencing already passed. Exact retries retain their original generation.
    this.#bound(session, actor, payload.doc);
    const doc = document(payload.doc, contract);
    if (doc.seq !== undefined) throw new HostError(400, 'Sequence is host-assigned');
    if (contract === 'aithema.spec.snapshot') {
      if (doc.host_mode !== session.hostMode || doc.consumed_seq > session.seq) throw new HostError(400, 'Invalid snapshot context');
      if (doc.expected_prev_rev !== session.workingRev) throw new HostError(409, 'Snapshot compare-and-swap failed');
      for (const op of doc.pending_ops) {
        if (op.payload_kind !== 'pending_op.content') continue;
        const ref = pendingContentReference(op.payload);
        const record = session.records.find((entry) => entry.seq === ref.record_seq);
        try { verifyPendingContent(op, record ? { document: record } : null, route.sid, session.seq + 1); }
        catch (error) { if (error.code === 'citation_invalid') fail(error.code); throw error; }
      }
      const record = this.#append(session, payload);
      session.workingRev = record.working_rev;
      session.snapshot = record;
      return acknowledgement(record);
    }
    if (doc.writer.kind === 'host') throw new HostError(403, 'Delegated tokens cannot impersonate the host');
    return acknowledgement(this.#append(session, payload));
  }

  /** Transport staging is never a journal record; only a complete upload commits. */
  #journalUpload(route, session, actor, payload) {
    const digest = route.query.get('upload');
    const { offset, total, chunk } = payload.doc ?? {};
    if (!['records', 'snapshots'].includes(route.action) || !/^[0-9a-f]{64}$/.test(digest) ||
        route.query.get('ack') !== 'seq' || !payload.doc || typeof payload.doc !== 'object' || Array.isArray(payload.doc) ||
        Object.keys(payload.doc).some((key) => !['offset', 'total', 'chunk'].includes(key)) ||
        !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(total) || total <= 1024 * 1024 || offset >= total ||
        typeof chunk !== 'string' || chunk.length > 4 * Math.ceil(journalChunkBytes / 3)) throw new HostError(400, 'Invalid journal upload');
    const part = Buffer.from(chunk, 'base64');
    if (part.toString('base64') !== chunk || part.length !== Math.min(journalChunkBytes, total - offset)) {
      throw new HostError(400, 'Invalid journal upload chunk');
    }
    const key = `${actor.gen}:${route.action}:${digest}`;
    if (offset === 0) {
      if (!session.uploads.has(key) && session.uploads.size >= 64) throw new HostError(413, 'Too many unfinished uploads');
      session.uploads.set(key, { total, offset: 0, chunks: [] });
    }
    const staged = session.uploads.get(key);
    if (!staged || staged.total !== total || staged.offset !== offset) throw new HostError(400, 'Out-of-order journal upload');
    staged.chunks.push(part);
    staged.offset += part.length;
    if (staged.offset < total) return success({ offset: staged.offset, total });
    session.uploads.delete(key);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(staged.chunks)); }
    catch { throw new HostError(400, 'Invalid UTF-8 journal upload'); }
    if (sha256Hex(text) !== digest) fail('idempotency_conflict');
    const complete = input(text);
    if (complete.doc.contract !== 'aithema.spec.snapshot' && complete.doc.kind !== 'pending_op.content') {
      throw new HostError(413, 'Ordinary journal events retain their 1 MiB limit');
    }
    return this.#journal(route, session, actor, complete);
  }

  #bound(session, actor, doc, { generation = true } = {}) {
    if (doc.sid !== session.authz.sid) throw new HostError(403, 'Foreign document session');
    if (generation && doc.worker_generation !== undefined && doc.worker_generation !== actor.gen) fail('fenced_generation');
    if (generation && doc.writer?.kind === 'worker' && doc.writer.generation !== actor.gen) fail('fenced_generation');
  }

  #opKey(sid, opKey, action) {
    const verb = { sources: 'source', 'transcript-turns': 'turn', drafts: 'submit', replace: 'replace' }[action];
    if (typeof opKey !== 'string' || !new RegExp(`^${sid}:${verb}:[0-9]+$`).test(opKey)) throw new HostError(400, 'Invalid operation key');
  }

  #intake(route, session, actor, payload, opKey, metadataHeader) {
    this.#opKey(route.sid, opKey, route.action);
    const prior = session.operations.get(opKey);
    const identity = canonicalJson([route.action, route.draftId ?? null, payload.bytes, metadataHeader ?? null]);
    if (prior) {
      if (prior.identity !== identity) fail('idempotency_conflict');
      return structuredClone(prior.response);
    }
    // Intake is fenced solely by the delegated token in #authorize. A durable
    // pending operation keeps its original document generation after takeover.
    const sourceOperation = ['sources', 'transcript-turns'].includes(route.action);
    const doc = document(payload.doc, sourceOperation ? 'aithema.journal.record' : 'aithema.spec.snapshot');
    this.#bound(session, actor, doc, { generation: false });
    const metadata = intakeMetadata(metadataHeader);
    let response;
    if (sourceOperation) {
      if (doc.kind !== (route.action === 'sources' ? 'source' : 'turn') || doc.seq !== undefined) throw new HostError(400, 'Wrong intake record kind or sequence');
      this.#projectionMetadata(route, session, metadata);
      const previous = session.imports.get(doc.client_event_id);
      const conversationSourceId = metadata?.conversation_source_id ?? null;
      if (previous && previous.conversationSourceId !== conversationSourceId) fail('idempotency_conflict');
      const record = this.#append(session, payload);
      const hostIds = session.imports.get(doc.client_event_id)?.hostIds ?? { [route.action === 'sources' ? 'source_id' : 'turn_id']: randomUUID() };
      session.imports.set(doc.client_event_id, { record, hostIds, conversationSourceId });
      response = success({ record, result: this.#workerDocument(session, 'op.result', { op_key: opKey, host_ids: hostIds }) });
    } else {
      if (session.hostMode !== 'review') throw new HostError(403, 'This session never submits proposals');
      const old = route.action === 'replace' ? session.drafts.get(route.draftId) : null;
      if (route.action === 'replace') {
        if (!old) throw new HostError(404, 'Unknown draft');
        this.#arbitrate(old.item.state, 'replace');
      }
      if (doc.host_mode !== session.hostMode) throw new HostError(400, 'Wrong intake mode');
      for (const candidate of doc.spec.items) {
        const result = validateExtensions(candidate.extensions, session.extensionRegistry);
        if (!result.ok) fail(result.code);
      }
      const candidates = doc.spec.items.filter((item) => item.state === 'confirmed' && item.host === null);
      if (candidates.length !== 1) throw new HostError(400, 'Submit exactly one confirmed candidate');
      const item = structuredClone(candidates[0]);
      if (old && (item.item_ref !== old.item.item_ref || item.version !== old.item.version + 1 ||
          item.supersedes_item_version?.item_ref !== old.item.item_ref || item.supersedes_item_version?.version !== old.item.version)) {
        throw new HostError(400, 'Replacement must link the previous item version');
      }
      if (!old && (item.supersedes_item_version !== null || [...session.drafts.values()].some((d) => d.item.item_ref === item.item_ref))) {
        if ([...session.drafts.values()].some((d) => d.item.item_ref === item.item_ref && d.item.state === 'accepted')) fail('already_accepted');
        throw new HostError(409, 'Item already submitted; use atomic replace');
      }
      this.#citations(session, item);
      const confirmed = session.records.some((r) => r.kind === 'ui.confirm' && r.data.item_ref === item.item_ref &&
        r.data.version === item.version && r.data.content_sha256 === item.content_sha256 && r.data.principal_ref === actor.act.sub);
      if (!confirmed) throw new HostError(403, 'Complete item version confirmation required');
      this.#projectionMetadata(route, session, metadata, item);
      const id = randomUUID();
      item.state = 'proposed';
      item.host = { op_key: opKey, draft_id: id };
      // Validate the prospective complete projection before either side mutates.
      const items = [...session.drafts.values()].map((d) => d === old ? { ...d.item, state: 'superseded' } : d.item);
      items.push(item);
      const projection = this.#intakeSnapshot(session, items);
      if (old) old.item.state = 'superseded';
      session.drafts.set(id, { item, supersedesDraftId: route.draftId ?? null, acceptance: null });
      session.intakeRev = projection.working_rev;
      session.intakeSnapshot = projection;
      response = success({ result: this.#workerDocument(session, 'op.result', { op_key: opKey, host_ids: { draft_id: id } }),
        snapshot: projection, supersedes_draft_id: route.draftId ?? null });
    }
    session.operations.set(opKey, { identity, response: structuredClone(response), action: route.action });
    return response;
  }

  /** Compare native host identities with the same hydrated leaves as the engine.
   * No host IDs or replacement fields are inserted into contract documents. */
  #projectionMetadata(route, session, metadata, item) {
    if (metadata === null) return; // raw contract-only host-kit callers
    if (['sources', 'transcript-turns'].includes(route.action)) {
      if (Object.keys(metadata).length !== 1 || !Object.hasOwn(metadata, 'conversation_source_id') ||
          (route.action === 'sources' ? metadata.conversation_source_id !== null :
            ![...session.imports.values()].some((entry) => entry.record.kind === 'source' &&
              entry.hostIds.source_id === metadata.conversation_source_id))) {
        throw new HostError(400, 'Invalid intake conversation source metadata');
      }
      return;
    }
    if (Object.keys(metadata).length !== 3 || metadata.kind !== (item.kind === 'requirement' ? 'requirement' : 'brief') ||
        metadata.supersedes_draft_id !== (route.draftId ?? null) || !Array.isArray(metadata.citations)) {
      throw new HostError(400, 'Invalid intake draft metadata');
    }
    const turns = session.records.filter((r) => r.kind === 'turn');
    let leaves;
    try {
      leaves = validateItemProvenance(item, { sid: route.sid,
        records: session.records.filter((r) => r.contract === 'aithema.journal.record'),
        turnOrdinals: new Map(turns.map((r, ordinal) => [r.seq, ordinal])) }).leaf_refs;
    } catch { fail('citation_invalid'); }
    const expected = leaves.map((leaf) => {
      const imported = [...session.imports.values()].find((entry) => entry.record.seq === leaf.record_seq);
      if (!imported) fail('citation_invalid');
      const binding = imported.record.kind === 'source' ? { source_id: imported.hostIds.source_id } :
        { source_id: imported.conversationSourceId, turn_id: imported.hostIds.turn_id };
      const quote = item.citations.find((c) => c.record_seq === leaf.record_seq && c.locator === leaf.locator)?.quote;
      return { ...binding, locator: leaf.locator, ...(quote === undefined ? {} : { quote }) };
    });
    if (canonicalJson(metadata.citations) !== canonicalJson(expected)) fail('citation_invalid');
  }

  #citations(session, item) {
    const turns = session.records.filter((r) => r.kind === 'turn');
    const evidence = (seq) => {
      const record = session.records.find((r) => r.seq === seq);
      if (!record || !(record.kind === 'source' || (record.kind === 'turn' && record.data.speaker === 'person'))) fail('citation_invalid');
      return record;
    };
    for (const citation of item.citations) {
      const record = evidence(citation.record_seq);
      let text;
      if (record.kind === 'source') {
        const segment = record.data.segments.find((s) => citation.locator === `seg:${s.id}`);
        if (!segment) fail('citation_invalid');
        text = [...record.data.text].slice(segment.start, segment.end).join('');
      } else {
        if (citation.locator !== `turn:${turns.indexOf(record)}`) fail('citation_invalid');
        text = record.data.body;
      }
      if (citation.quote !== undefined && !text.includes(citation.quote)) fail('citation_invalid');
    }
    for (const seq of item.provenance.derived_from) evidence(seq);
  }

  /** Build once per commit; polling and retries return the stored revision. */
  #intakeSnapshot(session, items) {
    const canonical = canonicalJson({ op: 'intake-projection' });
    const minor = items.some((item) => Object.hasOwn(item, 'extensions')) ? 1 : 0;
    return document(envelope('aithema.spec.snapshot', {
      minor, min_reader: 0,
      sid: session.authz.sid, client_event_id: randomUUID(),
      working_rev: session.intakeRev + 1, expected_prev_rev: session.intakeRev,
      consumed_seq: session.seq, worker_generation: session.generation, host_mode: session.hostMode,
      spec: { items: structuredClone(items), questions: [], brief: null, screens: [] },
      pending_ops: [], corrections: [], patch: { canonical, sha256: sha256Hex(canonical) },
    }), 'aithema.spec.snapshot');
  }

  #arbitrate(state, op) {
    const row = transitions.arbitration.find((r) => r.old === state && r.op === op);
    if (!row) throw new HostError(409, 'Unsupported lifecycle operation');
    if (!['ok', 'original result'].includes(row.result)) fail(row.result);
  }

  #accept(route, session, request) {
    if (request.body !== undefined && request.body !== '') throw new HostError(400, 'Acceptance has no token or proposal body');
    if (session.hostMode !== 'review') throw new HostError(403, 'This session never accepts proposals');
    const draft = session.drafts.get(route.draftId);
    if (!draft) throw new HostError(404, 'Unknown draft');
    this.#arbitrate(draft.item.state, 'accept');
    if (draft.acceptance) return structuredClone(draft.acceptance);
    const items = [...session.drafts.values()].map((d) => d === draft ? { ...d.item, state: 'accepted' } : d.item);
    const projection = this.#intakeSnapshot(session, items);
    draft.item.state = 'accepted';
    session.intakeRev = projection.working_rev;
    session.intakeSnapshot = projection;
    draft.acceptance = success({ draft_id: route.draftId, origin_draft_id: route.draftId,
      node_id: randomUUID(), snapshot: projection });
    return structuredClone(draft.acceptance);
  }

  #usage(session, scope, person) {
    const day = Math.floor(this.now() / 86400);
    let total = 0n;
    for (const other of this.#sessions.values()) {
      if (other.currency !== session.currency) continue;
      if (scope === 'session' && other !== session) continue;
      if (scope === 'principalDay' && other.authz.tid !== session.authz.tid) continue;
      if (scope === 'tenantDay' && other.authz.tid !== session.authz.tid) continue;
      for (const hold of other.holds.values()) {
        if (scope !== 'session' && hold.day !== day) continue;
        if (scope === 'principalDay' && hold.person !== person) continue;
        total += BigInt(hold.closed ? hold.closed.body.charged_micro : hold.request.max_micro);
      }
    }
    return total;
  }

  #hold(session, id) {
    const hold = session.holds.get(id);
    if (!hold) throw new HostError(404, 'Unknown hold in this session');
    return hold;
  }

  #ledger(route, session, actor, payload) {
    const candidate = payload.doc;
    if (!candidate || candidate.contract !== 'aithema.budget.message' || candidate.type !== `${route.action}_request` || !candidate.body) throw new HostError(400, 'Wrong budget request type');
    const body = candidate.body;
    if (body.sid !== undefined && body.sid !== route.sid) throw new HostError(403, 'Foreign budget session');
    if (Number.isSafeInteger(body.auth_epoch) && body.auth_epoch !== session.authz.epoch) fail('revoked');
    const prior = route.action === 'admit' ? session.attempts.get(body.attempt_id) : null;
    if (prior) {
      if (prior.bytes !== payload.bytes) fail('idempotency_conflict');
      return structuredClone(prior.response);
    }
    if (Number.isSafeInteger(body.worker_generation) && body.worker_generation !== actor.gen) fail('fenced_generation');
    document(candidate, 'aithema.budget.message');
    if (route.action === 'admit') {
      if (body.currency !== session.currency) throw new HostError(400, 'Budget currency mismatch');
      let denied = session.evidence ? null : 'no_evidence';
      let remaining = BigInt(Number.MAX_SAFE_INTEGER);
      for (const [scope, reason] of [['session', 'session_cap'], ['principalDay', 'principal_day_cap'], ['tenantDay', 'tenant_day_cap']]) {
        const available = BigInt(this.caps[scope]) - this.#usage(session, scope, actor.act.sub);
        if (!denied && BigInt(body.max_micro) > available) denied = reason;
        if (available < remaining) remaining = available;
      }
      if (denied) {
        const response = errorResponse(new HostError(402, 'budget_denied', 'budget_denied', budget('admit_response', { denied })));
        session.attempts.set(body.attempt_id, { bytes: payload.bytes, response });
        return structuredClone(response);
      }
      const id = randomUUID();
      const response = success(budget('admit_response', { hold_id: id, remaining_micro: Number(remaining - BigInt(body.max_micro)) }));
      session.holds.set(id, { id, request: structuredClone(body), person: actor.act.sub, day: Math.floor(this.now() / 86400),
        order: ++session.holdSequence, claim: null, closed: null, settleBytes: null });
      session.attempts.set(body.attempt_id, { bytes: payload.bytes, response });
      return response;
    }
    if (route.action === 'claim') {
      const hold = this.#hold(session, body.hold_id);
      if (hold.closed) fail('hold_closed', budget('claim_response', { error: 'hold_closed' }));
      if (hold.claim) fail('already_claimed', budget('claim_response', { error: 'already_claimed' }));
      if (hold.request.auth_epoch !== session.authz.epoch) fail('revoked');
      if (hold.request.worker_generation !== actor.gen) fail('fenced_generation');
      hold.claim = { id: randomUUID(), request_sha256: body.request_sha256 };
      session.claims.set(hold.claim.id, hold);
      return success(budget('claim_response', { claim_id: hold.claim.id }));
    }
    if (route.action === 'recover') {
      const hold = this.#hold(session, body.hold_id);
      if (hold.closed) return success(hold.closed);
      return this.#close(hold, hold.claim ? 'unknown' : 'void', hold.claim ? hold.request.max_micro : 0);
    }
    const hold = session.claims.get(body.claim_id);
    if (!hold) throw new HostError(404, 'Unknown claim in this session');
    if (hold.settleBytes !== null) {
      if (hold.settleBytes !== payload.bytes) fail('idempotency_conflict');
      return success(hold.closed);
    }
    if (hold.closed) fail('hold_closed');
    if (body.outcome === 'settled' && body.actual_micro > hold.request.max_micro) throw new HostError(400, 'Settlement exceeds admission bound');
    const response = this.#close(hold, body.outcome, body.outcome === 'unknown' ? hold.request.max_micro : body.actual_micro);
    hold.settleBytes = payload.bytes;
    return response;
  }

  #close(hold, reason, charged) {
    hold.closed = budget('recover_response', { hold_id: hold.id, closed_reason: reason, charged_micro: charged });
    return success(hold.closed);
  }

  /** Inspect original stored wire bytes without exposing mutable projections. */
  storedBytes(sid, clientEventId) {
    return this.#session(sid).events.get(clientEventId)?.bytes ?? null;
  }
}
