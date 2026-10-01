import { canonicalJson, sha256Hex } from '../../../contracts/validate.js';
import { decodeDocument, submissionBytes } from '../../journal/port.js';
import { checkedRecord, hydrateSnapshot } from '../../journal/hydrate.js';
import { journalChunkBytes } from '../../journal/pending-content.js';
import { AeonError, checkDocument } from './http.js';

/**
 * JournalPort over the plugin HTTP routes. In stored mode the transport returns
 * {document, bytes: <original UTF-8 JSON string>}. The AIT-44 mock exposes only
 * document projections; projection mode is an explicit integration choice and
 * marks reconstructed read bytes. Append acknowledgements always retain the
 * submitted bytes. Projection reads cannot prove original wire-byte identity.
 * The explicit chunked format uses ?upload=<wire digest>, ?ack=seq,
 * ?snapshot=seq and byte ranges on the existing journal routes. Hosts commit
 * an upload only after its full digest and contract validate. Neither HTTP
 * request nor response limits increase. Hosts must implement this protocol.
 */
export class AeonJournal {
  #http;
  #format;
  #takeoverAuthority;

  constructor({ http, recordFormat = 'stored', takeoverAuthority }) {
    if (!http || typeof http.request !== 'function' || !['stored', 'projection', 'chunked'].includes(recordFormat) ||
        takeoverAuthority !== undefined && typeof takeoverAuthority !== 'function') throw new TypeError('Invalid Aeon JournalPort configuration');
    this.#http = http;
    this.#format = recordFormat;
    this.#takeoverAuthority = takeoverAuthority;
  }

  /** Explicit plugin support for resolving large intake documents on the host. */
  get intakeReferences() { return this.#format === 'chunked'; }

  #record(value, sid, original, stored = this.#format !== 'projection') {
    const document = stored ? value?.document : value;
    checkDocument(document);
    if (!['aithema.journal.record', 'aithema.spec.snapshot'].includes(document.contract) || !Number.isSafeInteger(document.seq) || document.seq < 1) {
      throw new AeonError(502, 'Invalid journal record acknowledgement');
    }
    let bytes;
    if (stored) {
      if (typeof value.bytes !== 'string') throw new AeonError(502, 'Journal response omitted original bytes');
      bytes = Buffer.from(value.bytes, 'utf8');
      if (original && !bytes.equals(original) && !(document.kind === 'pending_op.content' &&
          canonicalJson(document.data) === canonicalJson(decodeDocument(original).data))) {
        throw new AeonError(502, 'Journal acknowledgement changed original bytes');
      }
    } else {
      const { seq, ...submission } = document;
      const duplicateContent = original && document.kind === 'pending_op.content' &&
        canonicalJson(submission) !== canonicalJson(decodeDocument(original));
      if (duplicateContent && canonicalJson(document.data) !== canonicalJson(decodeDocument(original).data)) {
        throw new AeonError(502, 'Content acknowledgement changed immutable bytes');
      }
      bytes = duplicateContent ? Buffer.from(canonicalJson(submission), 'utf8')
        : original ?? Buffer.from(canonicalJson(submission), 'utf8');
      if (duplicateContent) original = undefined;
    }
    const checked = checkedRecord({ document, bytes }, sid);
    return { ...checked, bytes_origin: original || stored ? 'original' : 'projection' };
  }

  /** Bounded transport chunks preserve original UTF-8 bytes at any content size. */
  async #chunkedRecord(seq, authority, original) {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new AeonError(502, 'Invalid journal sequence');
    const chunks = [];
    let offset = 0;
    let total;
    do {
      const body = await this.#http.request({ area: 'journal', action: 'records', capability: 'aithema.journal.read', authority,
        query: { ids: seq, offset, length: journalChunkBytes } });
      if (body?.seq !== seq || body.offset !== offset || !Number.isSafeInteger(body.total) || body.total < 1 ||
          total !== undefined && body.total !== total || typeof body.chunk !== 'string' || body.chunk.length > 4 * Math.ceil(journalChunkBytes / 3)) {
        throw new AeonError(502, 'Invalid immutable journal chunk');
      }
      const chunk = Buffer.from(body.chunk, 'base64');
      total ??= body.total;
      if (chunk.toString('base64') !== body.chunk || chunk.length !== Math.min(journalChunkBytes, total - offset)) {
        throw new AeonError(502, 'Incomplete or noncanonical journal chunk');
      }
      chunks.push(chunk);
      offset += chunk.length;
    } while (offset < total);
    const bytes = Buffer.concat(chunks);
    const doc = decodeDocument(bytes, { submission: true });
    return this.#record({ document: { ...doc, seq }, bytes: bytes.toString('utf8') }, authority.sid, original, true);
  }

  async append(bytes, authority) {
    const original = submissionBytes(bytes);
    const doc = decodeDocument(original, { submission: true });
    if (doc.sid !== authority.sid || doc.contract === 'aithema.session.create') throw new AeonError(400, 'Wrong journal submission');
    if (doc.contract === 'aithema.journal.record' && doc.writer.kind !== 'worker') {
      throw new AeonError(403, 'Delegated journal writes require worker-authored records');
    }
    const action = doc.contract === 'aithema.spec.snapshot' ? 'snapshots' : doc.kind === 'op.result' ? 'op.result' : 'records';
    if (this.#format === 'chunked' && original.length > 1024 * 1024) {
      const upload = sha256Hex(original.toString('utf8'));
      let response;
      for (let offset = 0; offset < original.length; offset += journalChunkBytes) {
        const end = Math.min(offset + journalChunkBytes, original.length);
        response = await this.#http.request({ area: 'journal', action, method: 'POST',
          capability: 'aithema.journal.write', authority, query: { upload, ack: 'seq' },
          bytes: Buffer.from(canonicalJson({ offset, total: original.length, chunk: original.subarray(offset, end).toString('base64') })) });
        if (end < original.length && (response?.offset !== end || response.total !== original.length || Object.hasOwn(response, 'seq'))) {
          throw new AeonError(502, 'Host did not acknowledge the upload range');
        }
      }
      return this.#chunkedRecord(response?.seq, authority, original);
    }
    const response = await this.#http.request({ area: 'journal', action, method: 'POST',
      capability: 'aithema.journal.write', authority, bytes: original,
      query: this.#format === 'chunked' ? { ack: 'seq' } : {} });
    if (this.#format === 'chunked') return this.#chunkedRecord(response?.seq, authority, original);
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
    if (this.#format === 'chunked') {
      for (const seq of ids) records.push(await this.#chunkedRecord(seq, authority));
      return records.sort((a, b) => a.document.seq - b.document.seq);
    }
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

  async recordsByDigests(digests, authority) {
    this.#http.checkAuthority(authority, 'aithema.journal.read');
    if (!Array.isArray(digests) || digests.some((digest) => typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) ||
        new Set(digests).size !== digests.length) throw new AeonError(400, 'Invalid content digests');
    const records = [];
    for (const digest of digests) {
      const found = await this.#http.request({ area: 'journal', action: 'records', capability: 'aithema.journal.read', authority,
        query: { digests: digest } });
      if (!Array.isArray(found) || found.length > 1) throw new AeonError(502, 'Invalid content address lookup');
      if (!found.length) continue;
      // Content lookup uses byte chunks even when ordinary reads use projections.
      const record = await this.#chunkedRecord(found[0].seq, authority);
      if (record.document.kind !== 'pending_op.content' || record.document.data.sha256 !== digest) {
        throw new AeonError(422, 'Content address does not match record', 'citation_invalid');
      }
      records.push(record);
    }
    return records;
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
    const body = await this.#http.request({ area: 'journal', action: 'cursor', capability: 'aithema.journal.read', authority,
      query: this.#format === 'chunked' ? { snapshot: 'seq' } : {} });
    const state = await this.authority(authority);
    if (!Number.isSafeInteger(body?.seq) || body.seq < 0 || !Number.isSafeInteger(body.working_rev) || body.working_rev < 0 || body.snapshot === undefined) {
      throw new AeonError(502, 'Invalid journal cursor');
    }
    const snapshot = body.snapshot === null ? null : this.#format === 'chunked'
      ? await this.#chunkedRecord(body.snapshot?.seq, authority) : this.#record(body.snapshot, authority.sid);
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
