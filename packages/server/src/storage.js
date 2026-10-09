import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { applyEvent, createSession, inputRevision, emptyUnderstanding } from '@inspr/aithema-core';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class SQLiteStorage {
  constructor(path = ':memory:') {
    // An OS-backed SQLite lock also releases on process death. It is separate
    // from the WAL journal so the writer can commit without releasing ownership.
    if (path !== ':memory:') {
      const canonical = (() => { try { return realpathSync(path); }
        catch { return join(realpathSync(dirname(resolve(path))), basename(path)); } })();
      this.writer = new DatabaseSync(canonical + '.writer.sqlite');
      try { this.writer.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
      catch { this.writer.close(); throw new Error('another-session-writer'); }
    }
    try {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        kind TEXT NOT NULL, bytes TEXT, hash TEXT NOT NULL, at TEXT NOT NULL, tombstone TEXT);
      CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(session_id,seq));
      CREATE TABLE IF NOT EXISTS receipts (session_id TEXT NOT NULL REFERENCES sessions(id),
        client_id TEXT NOT NULL, bytes BLOB NOT NULL, result TEXT NOT NULL, PRIMARY KEY(session_id,client_id));
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;`);
    this.#migrate();
    } catch (error) { this.db?.close(); this.writer?.close(); throw error; }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  create(options = {}) {
    return this.transaction(() => {
      const session = createSession(options);
      session.ownerHash = hash(options.ownerToken ?? randomUUID());
      this.db.prepare('INSERT INTO sessions VALUES (?,?)').run(session.id, JSON.stringify(session));
      this.#append(session, 'session.created', { id: session.id });
      return this.get(session.id);
    });
  }
  get(id) {
    const row = this.db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(id);
    if (!row) throw new NotFoundError('Session not found');
    const session = JSON.parse(row.snapshot);
    session.transcript = session.transcript.map(t => this.#hydrateData(id, t));
    if (session.understanding.contentRef) {
      const data = this.#hydrateData(id, session.understanding);
      session.understanding = data.erased ? emptyUnderstanding(session) : data;
    }
    if (session.actor?.contentRef) {
      const record = this.getRecord(id, session.actor.contentRef); session.actor = record.erased ? null : record.data;
    } else if (!session.actor) session.actor = session.understanding.actor ?? null;
    return session;
  }
  authorize(id, ownerToken) {
    const session = this.get(id);
    if (!ownerToken || session.ownerHash !== hash(ownerToken) || session.tombstone) throw new NotFoundError('Session not found');
    return session;
  }
  #check(session, guard = {}) {
    // Ownership and tombstone checks also apply to identical-byte retries.
    if (session.tombstone) throw new NotFoundError('Session erased');
    if (guard.ownerToken !== undefined && session.ownerHash !== hash(guard.ownerToken)) throw new NotFoundError('Session not found');
    if (guard.revision !== undefined && inputRevision(session) !== guard.revision) throw new ConflictError('Stale session revision');
  }
  list() { return this.db.prepare('SELECT id FROM sessions').all().map(r => r.id); }
  read(id, after = 0) {
    return this.db.prepare('SELECT event FROM events WHERE session_id=? AND seq>? ORDER BY seq').all(id, after)
      .map(row => this.#hydrateEvent(JSON.parse(row.event)));
  }
  getRecord(id, recordId) {
    const record = this.db.prepare('SELECT * FROM content WHERE session_id=? AND id=?').get(id, recordId);
    return !record || record.tombstone ? { id: recordId, erased: true, tombstone: record?.tombstone ?? 'missing' }
      : { id: record.id, data: JSON.parse(record.bytes), hash: record.hash, at: record.at };
  }
  #hydrateData(id, data) {
    if (!data.contentRef) return data;
    const record = this.getRecord(id, data.contentRef);
    return record.erased ? { ...data, erased: true, withdrawn: true } : { ...data, ...record.data };
  }
  #hydrateEvent(event) { return { ...event, data: this.#hydrateData(event.sessionId, event.data) }; }
  #metadata(id, type, data, seq) {
    if (!['turn.final', 'understanding.updated'].includes(type)) return data;
    if (data.contentRef) return Object.fromEntries(Object.entries(data).filter(([key]) =>
      type === 'turn.final' ? ['id', 'role', 'at', 'inputRevision', 'contentRef', 'hash', 'erased', 'withdrawn'].includes(key)
        : ['contentRef', 'hash', 'erased'].includes(key)));
    const contentRef = `${id}:${seq}`, at = data.at ?? new Date().toISOString();
    const bytes = JSON.stringify(type === 'turn.final' ? { content: data.content } : data), digest = hash(bytes);
    this.db.prepare('INSERT INTO content VALUES (?,?,?,?,?,?,NULL)').run(contentRef, id,
      type === 'turn.final' ? data.role === 'user' ? 'person' : 'reply' : 'understanding', bytes, digest, at);
    return type === 'turn.final' ? { id: data.id, role: data.role, at,
      ...(data.inputRevision === undefined ? {} : { inputRevision: data.inputRevision }), contentRef, hash: digest }
      : { contentRef, hash: digest };
  }
  #save(session, understandingRef) {
    const metadata = { ...session, transcript: session.transcript.map(t => this.#metadata(session.id, 'turn.final', t)) };
    if (understandingRef) metadata.understanding = understandingRef;
    else {
      const old = JSON.parse(this.db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(session.id).snapshot);
      metadata.understanding = session.understanding.inputRevision === null ? emptyUnderstanding(session) : old.understanding;
    }
    // Selected actor reasoning is content too; inferred actor lives with understanding.
    if (session.actor?.evidence === 'selected') {
      const old = JSON.parse(this.db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(session.id).snapshot);
      if (old.actor?.contentRef) metadata.actor = old.actor;
      else {
        const bytes = JSON.stringify(session.actor), contentRef = `${session.id}:actor:${session.seq}`;
        this.db.prepare('INSERT INTO content VALUES (?,?,?,?,?,?,NULL)').run(contentRef, session.id, 'actor', bytes,
          hash(bytes), new Date().toISOString()); metadata.actor = { contentRef };
      }
    } else metadata.actor = null;
    this.db.prepare('UPDATE sessions SET snapshot=? WHERE id=?').run(JSON.stringify(metadata), session.id);
  }
  #append(session, type, data) {
    if (type === 'turn.final' && (session.transcript.length >= 500 ||
      session.transcript.reduce((n, t) => n + (t.content?.length ?? 0), 0) + data.content.length > 250_000)) {
      throw new RangeError('Transcript limit');
    }
    const event = { sessionId: session.id, seq: session.seq + 1, generation: 0, type,
      at: new Date().toISOString(), data: this.#metadata(session.id, type, data, session.seq + 1) };
    this.db.prepare('INSERT INTO events VALUES (?,?,?)').run(session.id, event.seq, JSON.stringify(event));
    const hydrated = this.#hydrateEvent(event), next = applyEvent(session, hydrated);
    this.#save(next, type === 'understanding.updated' ? event.data : undefined);
    return hydrated;
  }
  append(id, type, data, expectedRevision) {
    return this.transaction(() => {
      const session = this.get(id);
      if (session.tombstone) return null;
      if (expectedRevision !== undefined && inputRevision(session) !== expectedRevision) return null;
      return this.#append(session, type, data);
    });
  }
  postTurn(id, clientId, bytes, content, guard = {}) {
    return this.transaction(() => {
      const session = this.get(id);
      this.#check(session, { ...guard, revision: undefined });
      const receipt = this.db.prepare('SELECT bytes,result FROM receipts WHERE session_id=? AND client_id=?').get(id, clientId);
      if (receipt) {
        if (Buffer.from(receipt.bytes).toString() !== hash(bytes)) throw new ConflictError('Client event id has different bytes');
        return { event: this.#hydrateEvent(JSON.parse(receipt.result)), replayed: true };
      }
      this.#check(session, guard);
      if (session.transcript.some(turn => turn.id === clientId)) throw new ConflictError('Turn id already exists');
      const event = this.#append(session, 'turn.final', { id: clientId, role: 'user', content,
        at: new Date().toISOString() });
      const metadata = { ...event, data: this.#metadata(id, 'turn.final', event.data) };
      this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(id, clientId, hash(bytes), JSON.stringify(metadata));
      return { event, replayed: false };
    });
  }
  #invalidate(id, turnId, all = false) {
    const at = new Date().toISOString(), target = this.get(id).transcript.find(t => t.id === turnId && t.role === 'user');
    this.db.prepare(`UPDATE content SET bytes=NULL,tombstone=? WHERE session_id=? AND tombstone IS NULL
      AND (? OR id=? OR kind IN ('reply','understanding','actor'))`).run(at, id, all ? 1 : 0, target?.contentRef ?? '');
  }
  #invalidationTransaction(fn) {
    const result = this.transaction(fn);
    // secure_delete clears pages in the database; truncate also removes earlier
    // committed content from the WAL before an erasure acknowledgement.
    const checkpoint = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint.busy) throw new Error('Erasure checkpoint unavailable');
    return result;
  }
  withdraw(id, turnId, reason = 'withdrawal', guard = {}) {
    return this.#invalidationTransaction(() => {
      const session = this.get(id); this.#check(session, guard);
      const turn = session.transcript.find(t => t.id === turnId && t.role === 'user');
      if (!turn) throw new NotFoundError('Turn not found');
      if (turn.erased) {
        const previous = this.read(id).find(e => e.type === 'turn.withdrawn' && e.data.turnId === turnId);
        if (previous) return previous;
      }
      this.#invalidate(id, turnId);
      return this.#append(session, 'turn.withdrawn', { turnId, reason, at: new Date().toISOString() });
    });
  }
  expire(id, turnId) { return this.withdraw(id, turnId, 'expiry'); }
  erase(id, guard = {}) {
    return this.#invalidationTransaction(() => {
      const session = this.get(id); this.#check(session, guard); this.#invalidate(id, undefined, true);
      return this.#append(session, 'session.erased', { at: new Date().toISOString() });
    });
  }
  reviseConsent(id, granted, guard = {}) {
    return this.#invalidationTransaction(() => {
      const session = this.get(id); this.#check(session, guard); this.#invalidate(id);
      return this.#append(session, 'consent.revised', { granted, at: new Date().toISOString() });
    });
  }
  pause(id, paused, guard = {}) {
    return this.transaction(() => { const session = this.get(id); this.#check(session, guard);
      return this.#append(session, 'session.paused', { paused }); });
  }
  #migrate() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 1) return;
    // One-time upgrade of the old content-bearing journal under the writer lock.
    this.transaction(() => {
      this.db.exec('DROP TRIGGER events_no_update');
      for (const id of this.list()) {
        const old = this.get(id);
        let session = createSession({ ...old, id });
        session.ownerHash = old.ownerHash ?? hash(randomUUID());
        let understandingRef;
        for (const row of this.db.prepare('SELECT seq,event FROM events WHERE session_id=? ORDER BY seq').all(id)) {
          const event = JSON.parse(row.event);
          event.generation = 0; event.at ??= event.data.at ?? new Date().toISOString();
          event.data = this.#metadata(id, event.type, event.data, event.seq);
          this.db.prepare('UPDATE events SET event=? WHERE session_id=? AND seq=?').run(JSON.stringify(event), id, row.seq);
          session = applyEvent(session, this.#hydrateEvent(event));
          if (event.type === 'understanding.updated') understandingRef = event.data;
        }
        this.#save(session, understandingRef);
        for (const receipt of this.db.prepare('SELECT client_id,bytes,result FROM receipts WHERE session_id=?').all(id)) {
          const event = JSON.parse(receipt.result), metadata = this.db.prepare('SELECT event FROM events WHERE session_id=? AND seq=?').get(id, event.seq);
          this.db.prepare('UPDATE receipts SET bytes=?,result=? WHERE session_id=? AND client_id=?').run(hash(receipt.bytes), metadata.event, id, receipt.client_id);
        }
      }
      this.db.exec("CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'append only'); END; PRAGMA user_version=1;");
    });
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  close() { this.db.close(); this.writer?.close(); }
}
