import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { JournalError, decodeDocument, submissionBytes } from './port.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS journal_sessions (
  sid TEXT PRIMARY KEY, tid TEXT NOT NULL, pid TEXT NOT NULL,
  host_mode TEXT NOT NULL, original_bytes BLOB NOT NULL,
  worker_generation INTEGER NOT NULL DEFAULT 1,
  auth_epoch INTEGER NOT NULL, tombstone INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0, working_rev INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0, consumed_seq INTEGER NOT NULL DEFAULT 0,
  audit_seq INTEGER NOT NULL DEFAULT 0, snapshot_seq INTEGER
);
CREATE TABLE IF NOT EXISTS journal_records (
  sid TEXT NOT NULL REFERENCES journal_sessions(sid), seq INTEGER NOT NULL,
  client_event_id TEXT NOT NULL, kind TEXT NOT NULL, original_bytes BLOB NOT NULL,
  PRIMARY KEY(sid, seq), UNIQUE(sid, client_event_id)
);
CREATE TRIGGER IF NOT EXISTS journal_no_update BEFORE UPDATE ON journal_records
BEGIN SELECT RAISE(ABORT, 'journal records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS journal_no_delete BEFORE DELETE ON journal_records
BEGIN SELECT RAISE(ABORT, 'journal records are immutable'); END;
`;

function count(value, name, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new JournalError(400, `${name} must be a safe ${positive ? 'positive' : 'nonnegative'} integer`);
  }
}

function increment(value, name) {
  if (value === Number.MAX_SAFE_INTEGER) throw new JournalError(409, `${name} exhausted`);
  return value + 1;
}

/** A standalone, in-process host implementation of JournalPort. */
export class SqliteJournal {
  #db;
  #now;

  constructor(filePath, { now = () => Date.now() } = {}) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.#db = new DatabaseSync(filePath);
    this.#now = now;
    this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.#db.exec(SCHEMA);
  }

  close() { this.#db.close(); }

  /** Host setup, not a delegated route; the creation document is stored verbatim. */
  createSession(bytes) {
    const original = submissionBytes(bytes);
    const doc = decodeDocument(original);
    if (doc.contract !== 'aithema.session.create') throw new JournalError(400, 'Expected a session creation document');
    return this.#transaction(() => {
      if (this.#db.prepare('SELECT sid FROM journal_sessions WHERE sid = ?').get(doc.sid)) {
        throw new JournalError(409, 'Session already exists');
      }
      this.#db.prepare(`INSERT INTO journal_sessions(sid,tid,pid,host_mode,original_bytes,auth_epoch)
        VALUES(?,?,?,?,?,?)`).run(doc.sid, doc.tid, doc.pid, doc.host_mode, original, doc.authz_epoch);
      return { sid: doc.sid, worker_generation: 1, auth_epoch: doc.authz_epoch };
    });
  }

  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #authorize(authority, write = false) {
    if (!authority || !Number.isFinite(authority.exp) || authority.exp <= Math.floor(this.#now() / 1000)) {
      throw new JournalError(401, 'Missing or expired authority');
    }
    const session = this.#db.prepare('SELECT * FROM journal_sessions WHERE sid = ?').get(authority.sid);
    if (!session) throw new JournalError(404, 'Journal session not found');
    if (session.tid !== authority.tid || session.pid !== authority.pid) throw new JournalError(403, 'Journal scope mismatch');
    const capability = write ? 'aithema.journal.write' : 'aithema.journal.read';
    if (!Array.isArray(authority.capabilities) || !authority.capabilities.includes(capability)) {
      throw new JournalError(403, `Missing ${capability}`);
    }
    if (session.tombstone || session.auth_epoch !== authority.auth_epoch || (session.suspended && authority.writer_kind !== 'host')) {
      throw new JournalError(409, 'Session authority revoked', 'revoked');
    }
    if (write && session.worker_generation !== authority.gen) {
      throw new JournalError(409, 'Worker generation is fenced', 'fenced_generation');
    }
    return session;
  }

  #stored(row) {
    const bytes = Buffer.from(row.original_bytes);
    return { bytes, document: { ...decodeDocument(bytes), seq: row.seq } };
  }

  #cursor(session) {
    const row = session.snapshot_seq === null ? null : this.#db.prepare(
      'SELECT * FROM journal_records WHERE sid = ? AND seq = ?').get(session.sid, session.snapshot_seq);
    return {
      worker_generation: session.worker_generation, auth_epoch: session.auth_epoch,
      working_rev: session.working_rev, last_seq: session.last_seq, audit_seq: session.audit_seq,
      snapshot: row ? this.#stored(row) : null,
    };
  }

  cursor(authority) { return this.#transaction(() => this.#cursor(this.#authorize(authority))); }

  /** A host-coordinated takeover grant must name the current generation. */
  takeover(authority) {
    return this.#transaction(() => {
      const session = this.#authorize(authority, true);
      this.#authorize(authority); // resume needs both read and write capabilities
      if (authority.writer_kind !== 'worker') throw new JournalError(403, 'Only a worker can take over');
      const gen = increment(session.worker_generation, 'worker_generation');
      this.#db.prepare('UPDATE journal_sessions SET worker_generation = ? WHERE sid = ?').run(gen, session.sid);
      return this.#cursor({ ...session, worker_generation: gen });
    });
  }

  append(bytes, authority) {
    const original = submissionBytes(bytes);
    return this.#transaction(() => {
      // Fence even exact retries: an old worker cannot write after takeover.
      const session = this.#authorize(authority, true);
      const doc = decodeDocument(original, { submission: true });
      if (doc.sid !== session.sid) throw new JournalError(403, 'Document session mismatch');
      const snapshot = doc.contract === 'aithema.spec.snapshot';
      if (!snapshot && doc.contract !== 'aithema.journal.record') throw new JournalError(400, 'Expected a journal record or snapshot');
      const writer = snapshot ? 'worker' : doc.writer.kind;
      if (writer !== authority.writer_kind) throw new JournalError(403, 'Record writer does not match authenticated writer');
      const generation = snapshot ? doc.worker_generation : doc.writer.generation;
      if ((writer === 'worker' || generation !== undefined) && generation !== session.worker_generation) {
        throw new JournalError(409, 'Record generation is fenced', 'fenced_generation');
      }
      const existing = this.#db.prepare('SELECT * FROM journal_records WHERE sid = ? AND client_event_id = ?')
        .get(doc.sid, doc.client_event_id);
      if (existing) {
        if (!Buffer.from(existing.original_bytes).equals(original)) {
          throw new JournalError(409, 'Same client_event_id with different bytes', 'idempotency_conflict');
        }
        return this.#stored(existing);
      }
      if (snapshot) {
        if (doc.expected_prev_rev !== session.working_rev) throw new JournalError(409, 'Snapshot revision CAS conflict');
        if (doc.host_mode !== session.host_mode) throw new JournalError(400, 'Snapshot host_mode does not match session');
        if (doc.consumed_seq > session.last_seq || doc.consumed_seq < session.consumed_seq) {
          throw new JournalError(400, 'Snapshot consumed_seq is ahead of the journal or moves backwards');
        }
      }
      if (!snapshot && doc.kind === 'authz.epoch' && doc.data.epoch <= session.auth_epoch) {
        throw new JournalError(409, 'Authorization epoch must advance');
      }
      if (!snapshot && doc.kind === 'audit.event' && doc.data.audit_seq <= session.audit_seq) {
        throw new JournalError(409, 'audit_seq must advance');
      }
      if (!snapshot && doc.kind === 'audit.restart' &&
          (doc.data.generation !== session.worker_generation || doc.data.last_acked_audit_seq > session.audit_seq)) {
        throw new JournalError(400, 'Invalid audit restart cursor');
      }
      if (!snapshot && doc.kind === 'op.result' && !doc.data.op_key.startsWith(`${doc.sid}:`)) {
        throw new JournalError(400, 'op_key belongs to another session');
      }
      if (!snapshot && doc.kind === 'session.end' && doc.data.host_mode !== session.host_mode) {
        throw new JournalError(400, 'session.end host_mode does not match session');
      }
      const seq = increment(session.last_seq, 'seq');
      this.#db.prepare('INSERT INTO journal_records(sid,seq,client_event_id,kind,original_bytes) VALUES(?,?,?,?,?)')
        .run(doc.sid, seq, doc.client_event_id, snapshot ? 'spec.snapshot' : doc.kind, original);
      this.#db.prepare('UPDATE journal_sessions SET last_seq = ? WHERE sid = ?').run(seq, doc.sid);
      if (snapshot) {
        this.#db.prepare('UPDATE journal_sessions SET working_rev = ?, consumed_seq = ?, snapshot_seq = ? WHERE sid = ?')
          .run(doc.working_rev, doc.consumed_seq, seq, doc.sid);
      } else if (doc.kind === 'authz.epoch') {
        this.#db.prepare('UPDATE journal_sessions SET auth_epoch = ? WHERE sid = ?').run(doc.data.epoch, doc.sid);
      } else if (doc.kind === 'session.control') {
        this.#db.prepare('UPDATE journal_sessions SET suspended = ?, tombstone = ? WHERE sid = ?')
          .run(doc.data.action === 'suspend' ? 1 : 0, doc.data.action === 'purge' ? 1 : 0, doc.sid);
      } else if (doc.kind === 'audit.event') {
        this.#db.prepare('UPDATE journal_sessions SET audit_seq = ? WHERE sid = ?').run(doc.data.audit_seq, doc.sid);
      }
      return { bytes: Buffer.from(original), document: { ...doc, seq } };
    });
  }

  recordsByIds(ids, authority) {
    if (!Array.isArray(ids)) throw new JournalError(400, 'ids must be an array');
    for (const id of ids) count(id, 'record id', true);
    return this.#transaction(() => {
      this.#authorize(authority); // reads deliberately do not fence generation
      const query = this.#db.prepare('SELECT * FROM journal_records WHERE sid = ? AND seq = ?');
      return [...new Set(ids)].map((id) => {
        const row = query.get(authority.sid, id);
        if (!row) throw new JournalError(404, `Journal record ${id} not found`);
        return this.#stored(row);
      });
    });
  }

  recordsAfter(after, authority, through = Number.MAX_SAFE_INTEGER) {
    count(after, 'after');
    count(through, 'through');
    return this.#transaction(() => {
      this.#authorize(authority);
      return this.#db.prepare('SELECT * FROM journal_records WHERE sid = ? AND seq > ? AND seq <= ? ORDER BY seq')
        .all(authority.sid, after, through).map((row) => this.#stored(row));
    });
  }

  /** SQLite's online backup includes committed WAL data without closing the host. */
  async backup(filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
    // Reserve a new destination exclusively; never replace somebody's backup.
    closeSync(openSync(filePath, 'wx', 0o600));
    return backup(this.#db, filePath);
  }
}
