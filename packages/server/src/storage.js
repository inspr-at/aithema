import { DatabaseSync } from 'node:sqlite';
import { applyEvent, createSession, inputRevision } from '@inspr/aithema-core';

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class SQLiteStorage {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(session_id,seq));
      CREATE TABLE IF NOT EXISTS receipts (session_id TEXT NOT NULL REFERENCES sessions(id),
        client_id TEXT NOT NULL, bytes BLOB NOT NULL, result TEXT NOT NULL, PRIMARY KEY(session_id,client_id));
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  create(options = {}) {
    return this.transaction(() => {
      const session = createSession(options);
      this.db.prepare('INSERT INTO sessions VALUES (?,?)').run(session.id, JSON.stringify(session));
      this.#append(session, 'session.created', { id: session.id });
      return this.get(session.id);
    });
  }
  get(id) {
    const row = this.db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(id);
    if (!row) throw new NotFoundError('Session not found');
    return JSON.parse(row.snapshot);
  }
  list() { return this.db.prepare('SELECT id FROM sessions').all().map(r => r.id); }
  read(id, after = 0) {
    return this.db.prepare('SELECT event FROM events WHERE session_id=? AND seq>? ORDER BY seq').all(id, after)
      .map(row => JSON.parse(row.event));
  }
  #append(session, type, data) {
    if (type === 'turn.final' && (session.transcript.length >= 500 ||
      session.transcript.reduce((n, t) => n + t.content.length, 0) + data.content.length > 250_000)) {
      throw new RangeError('Transcript limit');
    }
    const event = { sessionId: session.id, seq: session.seq + 1, type, data };
    this.db.prepare('INSERT INTO events VALUES (?,?,?)').run(session.id, event.seq, JSON.stringify(event));
    const next = applyEvent(session, event);
    this.db.prepare('UPDATE sessions SET snapshot=? WHERE id=?').run(JSON.stringify(next), session.id);
    return event;
  }
  append(id, type, data, expectedRevision) {
    return this.transaction(() => {
      const session = this.get(id);
      if (expectedRevision !== undefined && inputRevision(session) !== expectedRevision) return null;
      return this.#append(session, type, data);
    });
  }
  postTurn(id, clientId, bytes, content) {
    return this.transaction(() => {
      const session = this.get(id);
      const receipt = this.db.prepare('SELECT bytes,result FROM receipts WHERE session_id=? AND client_id=?').get(id, clientId);
      if (receipt) {
        if (!Buffer.from(receipt.bytes).equals(Buffer.from(bytes))) throw new ConflictError('Client event id has different bytes');
        return { event: JSON.parse(receipt.result), replayed: true };
      }
      const event = this.#append(session, 'turn.final', { id: clientId, role: 'user', content,
        at: new Date().toISOString() });
      this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(id, clientId, bytes, JSON.stringify(event));
      return { event, replayed: false };
    });
  }
  close() { this.db.close(); }
}
