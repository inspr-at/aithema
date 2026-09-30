import { canonicalJson } from '../../../contracts/validate.js';
import { decodeDocument, submissionBytes } from '../../journal/port.js';
import { checkedRecord, hydrateSnapshot } from '../../journal/hydrate.js';
import { AeonError, checkDocument } from './http.js';

/**
 * JournalPort over the plugin HTTP routes. In stored mode the transport returns
 * {document, bytes: <original UTF-8 JSON string>}. The AIT-44 mock exposes only
 * document projections; projection mode is an explicit integration choice and
 * marks reconstructed read bytes. Append acknowledgements always retain the
 * submitted bytes. Projection reads cannot prove original wire-byte identity.
 */
export class AeonJournal {
  #http;
  #format;
  #takeoverAuthority;

  constructor({ http, recordFormat = 'stored', takeoverAuthority }) {
    if (!http || typeof http.request !== 'function' || !['stored', 'projection'].includes(recordFormat) ||
        takeoverAuthority !== undefined && typeof takeoverAuthority !== 'function') throw new TypeError('Invalid Aeon JournalPort configuration');
    this.#http = http;
    this.#format = recordFormat;
    this.#takeoverAuthority = takeoverAuthority;
  }

  #record(value, sid, original) {
    const document = this.#format === 'stored' ? value?.document : value;
    checkDocument(document);
    if (!['aithema.journal.record', 'aithema.spec.snapshot'].includes(document.contract) || !Number.isSafeInteger(document.seq) || document.seq < 1) {
      throw new AeonError(502, 'Invalid journal record acknowledgement');
    }
    let bytes;
    if (this.#format === 'stored') {
      if (typeof value.bytes !== 'string') throw new AeonError(502, 'Journal response omitted original bytes');
      bytes = Buffer.from(value.bytes, 'utf8');
      if (original && !bytes.equals(original)) throw new AeonError(502, 'Journal acknowledgement changed original bytes');
    } else {
      const { seq, ...submission } = document;
      bytes = original ?? Buffer.from(canonicalJson(submission), 'utf8');
    }
    const checked = checkedRecord({ document, bytes }, sid);
    return { ...checked, bytes_origin: original || this.#format === 'stored' ? 'original' : 'projection' };
  }

  async append(bytes, authority) {
    const original = submissionBytes(bytes);
    const doc = decodeDocument(original, { submission: true });
    if (doc.sid !== authority.sid || doc.contract === 'aithema.session.create') throw new AeonError(400, 'Wrong journal submission');
    if (doc.contract === 'aithema.journal.record' && doc.writer.kind !== 'worker') {
      throw new AeonError(403, 'Delegated journal writes require worker-authored records');
    }
    const action = doc.contract === 'aithema.spec.snapshot' ? 'snapshots' : doc.kind === 'op.result' ? 'op.result' : 'records';
    const response = await this.#http.request({ area: 'journal', action, method: 'POST',
      capability: 'aithema.journal.write', authority, bytes: original });
    return this.#record(response, authority.sid, original);
  }

  async authority(authority, { signal } = {}) {
    const body = await this.#http.request({ area: 'journal', action: 'authority', capability: 'aithema.authority.read', authority, signal });
    checkDocument(body?.authorization, 'aithema.authz');
    if (['sid', 'tid', 'pid'].some((key) => body.authorization[key] !== authority[key]) ||
        !Number.isSafeInteger(body.worker_generation) || body.worker_generation < 1 || body.auth_epoch !== body.authorization.epoch ||
        typeof body.tombstone !== 'boolean' || typeof body.issued_at !== 'string' || !Number.isFinite(Date.parse(body.issued_at))) {
      throw new AeonError(502, 'Invalid host authority response');
    }
    return body;
  }

  async recordsByIds(ids, authority) {
    this.#http.checkAuthority(authority, 'aithema.journal.read');
    if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
      throw new AeonError(400, 'Invalid journal record ids');
    }
    const records = [];
    // A record is at most 1 MiB. Stored envelopes also contain the original
    // JSON as an escaped string, so fetch those singly under the 4 MiB cap.
    const pageSize = this.#format === 'stored' ? 1 : 3;
    for (let start = 0; start < ids.length; start += pageSize) {
      const page = ids.slice(start, start + pageSize);
      const body = await this.#http.request({ area: 'journal', action: 'records', capability: 'aithema.journal.read', authority,
        query: { ids: page.join(',') } });
      if (!Array.isArray(body)) throw new AeonError(502, 'Host returned no journal records');
      const found = new Set();
      for (const value of body) {
        const record = this.#record(value, authority.sid);
        if (!page.includes(record.document.seq) || found.has(record.document.seq)) throw new AeonError(422, 'Unexpected dependency record', 'citation_invalid');
        found.add(record.document.seq);
        records.push(record);
      }
      if (found.size !== page.length) throw new AeonError(422, 'Missing dependency record', 'citation_invalid');
    }
    return records.sort((a, b) => a.document.seq - b.document.seq);
  }

  async recordsAfter(after, authority, through) {
    this.#http.checkAuthority(authority, 'aithema.journal.read');
    if (!Number.isSafeInteger(after) || after < 0 || through !== undefined && (!Number.isSafeInteger(through) || through < after)) {
      throw new AeonError(400, 'Invalid replay cursor');
    }
    if (through === undefined) {
      const cursor = await this.#http.request({ area: 'journal', action: 'cursor', capability: 'aithema.journal.read', authority });
      if (!Number.isSafeInteger(cursor?.seq) || cursor.seq < 0) throw new AeonError(502, 'Invalid journal replay bound');
      through = cursor.seq;
    }
    // The host's ?after= route returns the entire tail. Pin the replay bound
    // once, then require every seq via the same bounded hydration path.
    const records = [];
    for (let last = after; last < through;) {
      const ids = Array.from({ length: Math.min(3, through - last) }, (_, i) => last + i + 1);
      records.push(...await this.recordsByIds(ids, authority));
      last = ids.at(-1);
    }
    return records;
  }

  async cursor(authority) {
    const body = await this.#http.request({ area: 'journal', action: 'cursor', capability: 'aithema.journal.read', authority });
    const state = await this.authority(authority);
    if (!Number.isSafeInteger(body?.seq) || body.seq < 0 || !Number.isSafeInteger(body.working_rev) || body.working_rev < 0 || body.snapshot === undefined) {
      throw new AeonError(502, 'Invalid journal cursor');
    }
    const snapshot = body.snapshot === null ? null : this.#record(body.snapshot, authority.sid);
    if (snapshot ? snapshot.document.contract !== 'aithema.spec.snapshot' || snapshot.document.working_rev !== body.working_rev || snapshot.document.seq > body.seq : body.working_rev !== 0) {
      throw new AeonError(502, 'Journal cursor and snapshot disagree');
    }
    const records = await this.recordsAfter(0, authority, body.seq);
    if ((records.at(-1)?.document.seq ?? 0) !== body.seq) throw new AeonError(502, 'Journal cursor has an incomplete record tail');
    const audit_seq = records.reduce((max, { document }) => Math.max(max,
      document.kind === 'audit.event' ? document.data.audit_seq : document.kind === 'audit.restart' ? document.data.last_acked_audit_seq : 0), 0);
    return { worker_generation: state.worker_generation, auth_epoch: state.auth_epoch,
      working_rev: body.working_rev, last_seq: body.seq, audit_seq, snapshot };
  }

  /** No takeover route exists in the merged matrix. The host integration owns
   * the atomic bump + delegated token refresh; never fake a local generation. */
  async takeover(authority) {
    this.#http.checkAuthority(authority, 'aithema.journal.write');
    if (!this.#takeoverAuthority) throw new AeonError(501, 'Host takeover and token refresh integration is required');
    const next = await this.#takeoverAuthority(structuredClone(authority));
    this.#http.checkAuthority(next, 'aithema.journal.write');
    if (next.auth_epoch !== authority.auth_epoch) throw new AeonError(409, 'Authorization changed during takeover', 'revoked');
    if (next.gen <= authority.gen) throw new AeonError(409, 'Invalid takeover authority', 'fenced_generation');
    const cursor = await this.cursor(next);
    if (cursor.worker_generation !== next.gen) throw new AeonError(409, 'Worker superseded during takeover', 'fenced_generation');
    return cursor;
  }

  async hydrate(authority) {
    const cursor = await this.cursor(authority);
    const closure = await hydrateSnapshot(this, cursor.snapshot, authority);
    return { cursor, closure };
  }
}
