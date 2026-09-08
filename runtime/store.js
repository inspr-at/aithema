/**
 * Durable SQLite project/conversation store with atomic revision updates,
 * idempotent turns, and membership isolation.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

import { assertRehydratedBaseline } from '../lib/validate.js';
import { createStream } from '../lib/stream.js';

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS projects (
  project_ref TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_kinds TEXT NOT NULL,
  stream_json TEXT NOT NULL,
  transcript_json TEXT NOT NULL,
  understanding_json TEXT,
  conversation_ref TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  project_ref TEXT NOT NULL,
  subject TEXT NOT NULL,
  party_ref TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  grant_kind TEXT NOT NULL,
  PRIMARY KEY (project_ref, subject),
  FOREIGN KEY (project_ref) REFERENCES projects(project_ref)
);
CREATE TABLE IF NOT EXISTS turn_idempotency (
  project_ref TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (project_ref, turn_id),
  FOREIGN KEY (project_ref) REFERENCES projects(project_ref)
);
CREATE TABLE IF NOT EXISTS documents (
  document_ref TEXT PRIMARY KEY,
  project_ref TEXT NOT NULL,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  extraction_reason TEXT NOT NULL,
  truncated INTEGER NOT NULL,
  extracted_text TEXT,
  source_kind TEXT NOT NULL,
  uncertainty TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_ref) REFERENCES projects(project_ref)
);
CREATE TABLE IF NOT EXISTS provider_spend (
  project_ref TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_ref, epoch, call_id),
  FOREIGN KEY (project_ref) REFERENCES projects(project_ref)
);
`

/**
 * @param {unknown} stream
 */
export function rehydrateStoredStream(stream) {
  if (stream === null || typeof stream !== 'object' || Array.isArray(stream)) {
    throw new Error('stored stream is invalid');
  }
  for (const baseline of stream.baselines ?? []) {
    assertRehydratedBaseline(baseline);
  }
  return stream;
}

export class SqliteProjectStore {
  /**
   * @param {string} filePath
   */
  constructor(filePath) {
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
    migrateMembersSchema(this.db);
  }

  close() {
    this.db.close();
  }

  /**
   * @param {{
   *   projectRef?: string,
   *   title: string,
   *   projectKinds: readonly string[],
   *   actor: import('./identity.js').VerifiedActor,
   * }} input
   */
  createProject(input) {
    const projectRef = input.projectRef || `project:${randomUUID()}`;
    const conversationRef = `conversation:${randomUUID()}`;
    const now = new Date().toISOString();
    const stream = createStream(projectRef, input.projectKinds);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO projects (
          project_ref, title, project_kinds, stream_json, transcript_json,
          understanding_json, conversation_ref, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)
      `).run(
        projectRef,
        input.title,
        JSON.stringify(input.projectKinds),
        JSON.stringify(stream),
        JSON.stringify([]),
        conversationRef,
        now,
        now,
      );
      this.#upsertMember(projectRef, input.actor);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getProject(projectRef, input.actor);
  }

  /**
   * @param {string} projectRef
   * @param {import('./identity.js').VerifiedActor} actor
   */
  getProject(projectRef, actor) {
    this.#assertMember(projectRef, actor);
    const row = this.db.prepare('SELECT * FROM projects WHERE project_ref = ?').get(projectRef);
    if (!row) throw new Error('project not found');
    return this.#hydrate(row);
  }

  /**
   * @param {import('./identity.js').VerifiedActor} actor
   */
  listProjects(actor) {
    const byRef = new Map();
    const created = this.db.prepare(`
      SELECT p.* FROM projects p
      INNER JOIN members m ON m.project_ref = p.project_ref
      WHERE m.subject = ? AND m.grant_kind = 'creator'
    `).all(actor.subject);
    for (const row of created) byRef.set(row.project_ref, row);
    if (actor.projects.includes('*')) {
      for (const row of this.db.prepare('SELECT * FROM projects').all()) {
        byRef.set(row.project_ref, row);
      }
    } else {
      for (const projectRef of actor.projects) {
        const row = this.db.prepare('SELECT * FROM projects WHERE project_ref = ?').get(projectRef);
        if (row) byRef.set(row.project_ref, row);
      }
    }
    return [...byRef.values()]
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
      .map((row) => this.#hydrate(row));
  }

  /**
   * @param {string} projectRef
   * @param {string} turnId
   */
  getTurnResult(projectRef, turnId) {
    const row = this.db.prepare(
      'SELECT result_json FROM turn_idempotency WHERE project_ref = ? AND turn_id = ?',
    ).get(projectRef, turnId);
    return row ? JSON.parse(row.result_json) : null;
  }

  /**
   * Atomic apply: caller mutates a clone; we write only if expectedRevision matches.
   * Incomplete assistant streams must not be included in `transcript` or `stream`.
   *
   * @param {{
   *   projectRef: string,
   *   actor: import('./identity.js').VerifiedActor,
   *   expectedRevision: number,
   *   turnId?: string,
   *   mutate: (current: ReturnType<SqliteProjectStore['#hydrate']>) => {
   *     stream: unknown,
   *     transcript: unknown,
   *     understanding: unknown,
   *     turnResult?: unknown,
   *   },
   * }} input
   */
  apply(input) {
    this.#assertMember(input.projectRef, input.actor);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM projects WHERE project_ref = ?').get(input.projectRef);
      if (!row) throw new Error('project not found');
      if (row.revision !== input.expectedRevision) {
        throw Object.assign(new Error('project revision conflict'), { code: 'revision_conflict' });
      }
      if (input.turnId) {
        const existing = this.db.prepare(
          'SELECT result_json FROM turn_idempotency WHERE project_ref = ? AND turn_id = ?',
        ).get(input.projectRef, input.turnId);
        if (existing) {
          this.db.exec('ROLLBACK');
          return {
            deduped: true,
            project: this.#hydrate(row),
            turnResult: JSON.parse(existing.result_json),
          };
        }
      }
      const current = this.#hydrate(row);
      const next = input.mutate(current);
      rehydrateStoredStream(next.stream);
      const now = new Date().toISOString();
      const result = this.db.prepare(`
        UPDATE projects
        SET stream_json = ?, transcript_json = ?, understanding_json = ?, revision = ?, updated_at = ?
        WHERE project_ref = ? AND revision = ?
      `).run(
        JSON.stringify(next.stream),
        JSON.stringify(next.transcript),
        next.understanding == null ? null : JSON.stringify(next.understanding),
        row.revision + 1,
        now,
        input.projectRef,
        input.expectedRevision,
      );
      if (result.changes !== 1) {
        throw Object.assign(new Error('project revision conflict'), { code: 'revision_conflict' });
      }
      if (input.turnId && next.turnResult) {
        this.db.prepare(
          'INSERT INTO turn_idempotency (project_ref, turn_id, result_json) VALUES (?, ?, ?)',
        ).run(input.projectRef, input.turnId, JSON.stringify(next.turnResult));
      }
      let committedDocumentRefs = [];
      if (next.documentsToAdd?.length) {
        committedDocumentRefs = this.#insertDocumentRows(
          input.projectRef,
          next.documentsToAdd,
          next.maxDocuments,
        );
      }
      this.db.exec('COMMIT');
      return {
        deduped: false,
        project: this.getProject(input.projectRef, input.actor),
        turnResult: next.turnResult,
        committedDocumentRefs,
      };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
  }

  /**
   * Persist only the user turn (before provider streaming). Assistant content is
   * written later only when the stream completes.
   */
  applyUserTurn(input) {
    return this.apply(input);
  }

  /**
   * Insert extracted-text records only. Re-checks membership and slot count
   * inside the transaction so concurrent uploads cannot exceed the project cap.
   * Raw upload bytes are never written.
   *
   * @param {{
   *   projectRef: string,
   *   actor: import('./identity.js').VerifiedActor,
   *   records: readonly object[],
   *   maxDocuments: number,
   * }} input
   */
  insertDocuments(input) {
    this.#assertMember(input.projectRef, input.actor);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const committed = this.#insertDocumentRows(input.projectRef, input.records, input.maxDocuments);
      this.db.exec('COMMIT');
      return { committed };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
  }

  /**
   * Atomically reserve one outbound provider call against a project epoch
   * ceiling. Reserved and committed rows both count. A reserved row is never
   * deleted after a possibly-sent request; retries must not reissue the same id.
   *
   * @param {{
   *   projectRef: string,
   *   epoch: number,
   *   callId: string,
   *   ceiling: number,
   * }} input
   * @returns {{ reserved: true } | { uncertain: true } | { alreadyCommitted: true } | { denied: true }}
   */
  reserveOutboundCall(input) {
    const { projectRef, epoch, callId, ceiling } = input;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare(
        'SELECT status FROM provider_spend WHERE project_ref = ? AND epoch = ? AND call_id = ?',
      ).get(projectRef, epoch, callId);
      if (existing?.status === 'reserved') {
        this.db.exec('ROLLBACK');
        return { uncertain: true };
      }
      if (existing?.status === 'committed') {
        this.db.exec('ROLLBACK');
        return { alreadyCommitted: true };
      }
      const used = this.db.prepare(
        'SELECT COUNT(*) AS n FROM provider_spend WHERE project_ref = ? AND epoch = ?',
      ).get(projectRef, epoch).n;
      if (used >= ceiling) {
        this.db.exec('ROLLBACK');
        return { denied: true };
      }
      this.db.prepare(`
        INSERT INTO provider_spend (project_ref, epoch, call_id, status, created_at)
        VALUES (?, ?, ?, 'reserved', ?)
      `).run(projectRef, epoch, callId, new Date().toISOString());
      this.db.exec('COMMIT');
      return { reserved: true };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
  }

  /**
   * Mark a reserved call committed after the adapter was invoked.
   * Missing or already-committed rows stay as-is; reserved cannot be refunded.
   *
   * @param {{ projectRef: string, epoch: number, callId: string }} input
   */
  commitOutboundCall(input) {
    this.db.prepare(`
      UPDATE provider_spend
      SET status = 'committed'
      WHERE project_ref = ? AND epoch = ? AND call_id = ? AND status = 'reserved'
    `).run(input.projectRef, input.epoch, input.callId);
  }

  /**
   * @param {string} projectRef
   * @param {number} epoch
   * @param {string} callId
   * @returns {'reserved' | 'committed' | null}
   */
  getOutboundCall(projectRef, epoch, callId) {
    const row = this.db.prepare(
      'SELECT status FROM provider_spend WHERE project_ref = ? AND epoch = ? AND call_id = ?',
    ).get(projectRef, epoch, callId);
    return row?.status ?? null;
  }

  /**
   * @param {string} projectRef
   * @param {number} epoch
   */
  countOutboundCalls(projectRef, epoch) {
    return this.db.prepare(
      'SELECT COUNT(*) AS n FROM provider_spend WHERE project_ref = ? AND epoch = ?',
    ).get(projectRef, epoch).n;
  }

  getDocument(projectRef, actor, documentRef) {
    this.#assertMember(projectRef, actor);
    const row = this.db.prepare(
      'SELECT * FROM documents WHERE project_ref = ? AND document_ref = ?',
    ).get(projectRef, documentRef);
    if (!row) {
      throw Object.assign(new Error('document not found'), { code: 'not_found' });
    }
    return hydrateDocument(row, true);
  }

  #insertDocumentRows(projectRef, records, maxDocuments) {
    const have = this.db.prepare(
      'SELECT COUNT(*) AS n FROM documents WHERE project_ref = ?',
    ).get(projectRef).n;
    const limit = Number.isInteger(maxDocuments) ? maxDocuments : 8;
    const slots = Math.max(0, limit - have);
    const insert = this.db.prepare(`
      INSERT INTO documents (
        document_ref, project_ref, filename, media_type, byte_size,
        extraction_reason, truncated, extracted_text, source_kind, uncertainty, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const committed = [];
    for (const record of records.slice(0, slots)) {
      insert.run(
        record.document_ref,
        projectRef,
        record.filename,
        record.media_type,
        record.byte_size,
        record.extraction_reason,
        record.truncated ? 1 : 0,
        record.extracted_text ?? null,
        record.source_kind,
        record.uncertainty ?? null,
        record.created_at,
      );
      committed.push(record.document_ref);
    }
    return committed;
  }

  #upsertMember(projectRef, actor) {
    this.db.prepare(`
      INSERT INTO members (project_ref, subject, party_ref, actor_kind, roles_json, grant_kind)
      VALUES (?, ?, ?, ?, ?, 'creator')
      ON CONFLICT(project_ref, subject) DO UPDATE SET
        party_ref = excluded.party_ref,
        actor_kind = excluded.actor_kind,
        roles_json = excluded.roles_json,
        grant_kind = 'creator'
    `).run(projectRef, actor.subject, actor.party_ref, actor.actor_kind, JSON.stringify(actor.roles));
  }

  #assertMember(projectRef, actor) {
    const grant = this.db.prepare(
      `SELECT subject FROM members WHERE project_ref = ? AND subject = ? AND grant_kind = 'creator'`,
    ).get(projectRef, actor.subject);
    if (grant) return;
    if (actor.projects.includes(projectRef) || actor.projects.includes('*')) return;
    throw Object.assign(new Error('not a member of this project'), { code: 'forbidden' });
  }

  #hydrate(row) {
    const stream = rehydrateStoredStream(JSON.parse(row.stream_json));
    const documents = this.db.prepare(`
      SELECT document_ref, filename, media_type, byte_size, extraction_reason,
             truncated, source_kind, uncertainty, created_at,
             CASE WHEN extracted_text IS NULL THEN 0 ELSE length(extracted_text) END AS text_chars
      FROM documents WHERE project_ref = ? ORDER BY created_at ASC
    `).all(row.project_ref).map((item) => hydrateDocument(item, false));
    return Object.freeze({
      project_ref: row.project_ref,
      title: row.title,
      project_kinds: Object.freeze(JSON.parse(row.project_kinds)),
      stream,
      transcript: Object.freeze(JSON.parse(row.transcript_json)),
      understanding: row.understanding_json ? Object.freeze(JSON.parse(row.understanding_json)) : null,
      conversation_ref: row.conversation_ref,
      revision: row.revision,
      created_at: row.created_at,
      updated_at: row.updated_at,
      documents: Object.freeze(documents),
    });
  }
}

/**
 * @param {object} row
 * @param {boolean} withText
 */
function hydrateDocument(row, withText) {
  const record = {
    document_ref: row.document_ref,
    filename: row.filename,
    media_type: row.media_type,
    byte_size: row.byte_size,
    extraction_reason: row.extraction_reason,
    truncated: Boolean(row.truncated),
    source_kind: row.source_kind,
    uncertainty: row.uncertainty ?? null,
    created_at: row.created_at,
    text_chars: row.text_chars ?? (row.extracted_text == null ? 0 : String(row.extracted_text).length),
  };
  if (withText) record.extracted_text = row.extracted_text ?? null;
  return Object.freeze(record);
}

/**
 * Membership is a subject-level creator grant, not a party_ref cache.
 * Legacy party-keyed rows cannot authorize a different subject who happens to
 * share party_ref, and mapped-access cache rows are not treated as grants.
 * @param {import('node:sqlite').DatabaseSync} db
 */
function migrateMembersSchema(db) {
  const columns = db.prepare('PRAGMA table_info(members)').all();
  const names = new Set(columns.map((column) => column.name));
  if (names.has('subject') && names.has('grant_kind')) return;
  db.exec('ALTER TABLE members RENAME TO members_legacy_party');
  db.exec(`
    CREATE TABLE members (
      project_ref TEXT NOT NULL,
      subject TEXT NOT NULL,
      party_ref TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      roles_json TEXT NOT NULL,
      grant_kind TEXT NOT NULL,
      PRIMARY KEY (project_ref, subject),
      FOREIGN KEY (project_ref) REFERENCES projects(project_ref)
    );
  `);
}
