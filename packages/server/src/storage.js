import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { normalizeUploadLimits } from './upload-limits.js';
import { applyEvent, createSession, inputRevision, emptyUnderstanding, isUIArtifact, isHTMLArtifact, inspectHTML, HTML_MEDIA_TYPE, imageInfo, reduceConceptIntent, createConceptIntent, MAX_IMAGE_BYTES,
  defaultSettings, normalizeSettings, sameSelection, conversationStarted, createCredits, rebindCredits, reduceCredits } from '@inspr/aithema-core';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const MAX_CONCEPT_STORAGE_BYTES = 64 * 1024 * 1024;
export const MAX_SETTINGS_REVISIONS = 1000;
const turnMetadata = ['id', 'role', 'at', 'inputRevision', 'contentRef', 'hash', 'erased', 'withdrawn', 'provenance', 'voiceCallId', 'voiceProviderId'];

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
/** A settings write based on an older revision; carries the acknowledged state. */
export class SettingsConflictError extends ConflictError {
  constructor(code, session) { super(code); this.code = code; this.session = session; }
}
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
      CREATE TABLE IF NOT EXISTS host_states (session_id TEXT PRIMARY KEY REFERENCES sessions(id), record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS owner_credit_guards (owner_hash TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        kind TEXT NOT NULL, bytes TEXT, hash TEXT NOT NULL, at TEXT NOT NULL, tombstone TEXT);
      CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(session_id,seq));
      CREATE TABLE IF NOT EXISTS receipts (session_id TEXT NOT NULL REFERENCES sessions(id),
        client_id TEXT NOT NULL, bytes BLOB NOT NULL, result TEXT NOT NULL, PRIMARY KEY(session_id,client_id));
      CREATE TABLE IF NOT EXISTS voice_calls (provider_id TEXT PRIMARY KEY, call_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id), record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS concept_artifacts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        bytes BLOB, metadata TEXT NOT NULL, dependencies TEXT NOT NULL, tombstone TEXT);
      CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        bytes BLOB, byte_count INTEGER NOT NULL, content_ref TEXT NOT NULL, tombstone TEXT);
      CREATE INDEX IF NOT EXISTS upload_session ON uploads(session_id);
      CREATE INDEX IF NOT EXISTS concept_session ON concept_artifacts(session_id);
      CREATE INDEX IF NOT EXISTS voice_session ON voice_calls(session_id);
      CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(json_extract(snapshot, '$.ownerHash'));
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
    session.settings ??= defaultSettings(); // sessions stored before visitor settings follow host defaults
    if (session.identity?.contentRef) session.identity = this.#hydrateData(id, session.identity);
    if (session.library?.contentRef) session.library = this.#hydrateData(id, session.library);
    session.uploads = (session.uploads ?? []).map(u => this.#hydrateUpload(id, u));
    session.transcript = session.transcript.map(t => this.#hydrateData(id, t));
    if (session.understanding.contentRef) {
      const data = this.#hydrateData(id, session.understanding);
      session.understanding = data.erased ? emptyUnderstanding(session) : data;
    }
    if (session.actor?.contentRef) {
      const record = this.getRecord(id, session.actor.contentRef); session.actor = record.erased ? null : record.data;
    } else if (!session.actor) session.actor = session.understanding.actor ?? null;
    if ('focusedQuestionRef' in session) session.focusedQuestion = null;
    if (session.focusedQuestionRef) {
      const record = this.getRecord(id, session.focusedQuestionRef.contentRef);
      session.focusedQuestion = record.erased ? null : record.data.question;
    }
    session.concepts = (session.concepts ?? []).filter(c => this.db.prepare('SELECT 1 FROM concept_artifacts WHERE session_id=? AND id=? AND tombstone IS NULL').get(id, c.id))
      .map(c => ({ ...c, feedback: c.feedback?.contentRef ? this.#hydrateData(id, c.feedback) : c.feedback }));
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
  ownedIds(ownerToken) {
    if (!ownerToken) return [];
    return this.db.prepare("SELECT id FROM sessions WHERE json_extract(snapshot,'$.ownerHash')=? AND json_extract(snapshot,'$.tombstone') IS NULL")
      .all(hash(ownerToken)).map(row => row.id);
  }
  hostState(id) {
    const row = this.db.prepare('SELECT record FROM host_states WHERE session_id=?').get(id);
    return row ? JSON.parse(row.record) : null;
  }
  ownerCreditState(ownerToken) {
    if (!ownerToken) return null;
    const row = this.db.prepare('SELECT record FROM owner_credit_guards WHERE owner_hash=?').get(hash(ownerToken));
    return row ? JSON.parse(row.record) : null;
  }
  /** Only trusted reducers enter here. State and its public events commit together. */
  transitionHost(id, update, guard = {}) {
    return this.transaction(() => {
      const session = this.get(id); this.#check(session, guard);
      const result = update(this.hostState(id), session);
      this.db.prepare('INSERT INTO host_states VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET record=excluded.record')
        .run(id, JSON.stringify(result.state));
      const events = (result.events ?? []).map(event => this.#append(this.get(id), event.type, event.data));
      return { ...result, events };
    });
  }
  /** One host clock guard per owner; new/reset never renew its deadline. */
  transitionCredits(id, ownerToken, event, options = {}) {
    return this.transaction(() => {
      const session = this.authorize(id, ownerToken), key = session.ownerHash;
      const row = this.db.prepare('SELECT record FROM owner_credit_guards WHERE owner_hash=?').get(key);
      const state = row ? rebindCredits(JSON.parse(row.record), id) : createCredits({ sessionId: id, ...options });
      const result = reduceCredits(state, { ...event, now: Math.max(event.now, state.lastNow) });
      this.db.prepare('INSERT INTO owner_credit_guards VALUES (?,?) ON CONFLICT(owner_hash) DO UPDATE SET record=excluded.record')
        .run(key, JSON.stringify(result.state));
      return { ...result, events: result.events.map(e => this.#append(this.get(id), e.type, e.data)) };
    });
  }
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
  #hydrateEvent(event) {
    const data = event.type === 'upload.state' ? this.#hydrateUpload(event.sessionId, event.data, true) : this.#hydrateData(event.sessionId, event.data);
    if (event.type === 'concept.state' && data.artifact && !this.db.prepare('SELECT 1 FROM concept_artifacts WHERE session_id=? AND id=? AND tombstone IS NULL').get(event.sessionId, data.artifact.id)) {
      return { ...event, data: { ...data, artifact: { id: data.artifact.id, erased: true } } };
    }
    return { ...event, data };
  }
  #metadata(id, type, data, seq) {
    if (['identity.state', 'verification.requested', 'library.state'].includes(type)) {
      const retained = type === 'identity.state' ? { identified: data.identified ?? Boolean(data.assessmentUnlocked) } : {};
      if (data.contentRef) return { contentRef: data.contentRef, hash: data.hash, ...retained };
      const bytes = JSON.stringify(data), contentRef = `${id}:host:${seq}`;
      this.db.prepare('INSERT INTO content VALUES (?,?,?,?,?,?,NULL)').run(contentRef, id, 'host', bytes, hash(bytes), new Date().toISOString());
      return { contentRef, hash: hash(bytes), ...retained };
    }
    if (type === 'upload.state') {
      if (data.state === 'withdrawn') return { id: data.id, state: 'withdrawn', at: data.at, erased: true, withdrawn: true };
      if (data.contentRef) return Object.fromEntries(['id', 'state', 'at', 'reason', 'contentRef', 'hash'].filter(k => data[k] !== undefined).map(k => [k, data[k]]));
      const bytes = JSON.stringify(Object.fromEntries(['filename', 'mediaType', 'bytes', 'text', 'truncated', 'extractor', 'deadlineAt'].filter(k => data[k] !== undefined).map(k => [k, data[k]])));
      const contentRef = `${id}:upload:${data.id}:${seq}`;
      this.db.prepare('INSERT INTO content VALUES (?,?,?,?,?,?,NULL)').run(contentRef, id, 'upload', bytes, hash(bytes), data.at);
      return { id: data.id, state: data.state, at: data.at, ...(data.reason ? { reason: data.reason } : {}), contentRef, hash: hash(bytes) };
    }
    if (type === 'concept.feedback') {
      if (data.contentRef) return { artifactId: data.artifactId, archived: data.archived, contentRef: data.contentRef, hash: data.hash };
      const bytes = JSON.stringify({ vote: data.vote, chips: data.chips }), contentRef = `${id}:concept-feedback:${seq}`;
      this.db.prepare('INSERT INTO content VALUES (?,?,?,?,?,?,NULL)').run(contentRef, id, 'concept-feedback', bytes, hash(bytes), new Date().toISOString());
      return { artifactId: data.artifactId, archived: data.archived, contentRef, hash: hash(bytes) };
    }
    if (type === 'question.focused') {
      if (data.question === null) return { question: null };
      if (data.contentRef) return { contentRef: data.contentRef, hash: data.hash };
      if (typeof data.question !== 'string' || data.question.length > 8000) throw new TypeError('Invalid focused question');
      const bytes = JSON.stringify({ question: data.question }), contentRef = `${id}:${seq}`, at = new Date().toISOString();
      this.db.prepare('INSERT INTO content VALUES (?,?,?,?,?,?,NULL)').run(contentRef, id, 'understanding', bytes, hash(bytes), at);
      return { contentRef, hash: hash(bytes) };
    }
    if (type === 'settings.changed') {
      // A visitor's choice is erasable content: the journal keeps only its reference.
      if (data.contentRef) return { contentRef: data.contentRef, hash: data.hash };
      const bytes = JSON.stringify({ processingPreset: data.processingPreset, settings: data.settings }), contentRef = `${id}:settings:${seq}`;
      this.db.prepare('INSERT INTO content VALUES (?,?,?,?,?,?,NULL)').run(contentRef, id, 'settings', bytes, hash(bytes), new Date().toISOString());
      return { contentRef, hash: hash(bytes) };
    }
    if (!['turn.final', 'turn.corrected', 'understanding.updated'].includes(type)) return data;
    if (data.contentRef) return Object.fromEntries(Object.entries(data).filter(([key]) =>
      ['turn.final', 'turn.corrected'].includes(type) ? turnMetadata.includes(key)
        : ['contentRef', 'hash', 'erased'].includes(key)));
    const contentRef = `${id}:${seq}`, at = data.at ?? new Date().toISOString();
    // A reply's engine label reveals the visitor's choice, so it is erased with the reply.
    const bytes = JSON.stringify(['turn.final', 'turn.corrected'].includes(type) ? { content: data.content, ...(data.engine ? { engine: data.engine } : {}) } : data), digest = hash(bytes);
    this.db.prepare('INSERT INTO content VALUES (?,?,?,?,?,?,NULL)').run(contentRef, id,
      ['turn.final', 'turn.corrected'].includes(type) ? data.role === 'user' ? 'person' : 'reply' : 'understanding', bytes, digest, at);
    return ['turn.final', 'turn.corrected'].includes(type) ? { id: data.id, role: data.role, at,
      ...Object.fromEntries(['inputRevision', 'provenance', 'voiceCallId', 'voiceProviderId'].filter(key => data[key] !== undefined).map(key => [key, data[key]])), contentRef, hash: digest }
      : { contentRef, hash: digest };
  }
  #save(session, understandingRef, focusedQuestionRef) {
    const metadata = { ...session, transcript: session.transcript.map(t => this.#metadata(session.id, 'turn.final', t)) };
    for (const key of ['identity', 'library']) if (session[key]) {
      const row = this.db.prepare("SELECT event FROM events WHERE session_id=? AND json_extract(event,'$.type')=? ORDER BY seq DESC LIMIT 1").get(session.id, `${key}.state`);
      metadata[key] = row ? JSON.parse(row.event).data : null;
    }
    metadata.uploads = (session.uploads ?? []).map(u => this.#metadata(session.id, 'upload.state', u));
    metadata.concepts = (session.concepts ?? []).map(c => ({ ...c, feedback: c.feedback?.contentRef
      ? { artifactId: c.id, archived: c.archived, contentRef: c.feedback.contentRef, hash: c.feedback.hash } : c.feedback }));
    if (session.focusedQuestion !== undefined) {
      metadata.focusedQuestionRef = session.focusedQuestion === null ? null : focusedQuestionRef ?? session.focusedQuestionRef;
      delete metadata.focusedQuestion;
    }
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
    this.#save(next, type === 'understanding.updated' ? event.data : undefined, type === 'question.focused' ? event.data : undefined);
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
        ...(guard.voiceCallId ? { voiceCallId: guard.voiceCallId, voiceProviderId: guard.voiceProviderId } : {}),
        at: new Date().toISOString() });
      const metadata = { ...event, data: this.#metadata(id, 'turn.final', event.data) };
      this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(id, clientId, hash(bytes), JSON.stringify(metadata));
      return { event, replayed: false };
    });
  }
  #hydrateUpload(id, metadata, historical = false) {
    const data = this.#hydrateData(id, metadata);
    // Keep the event's original transition when replaying. Turning every erased
    // pending/accepted event into another withdrawal would invent revisions.
    return data.erased || data.withdrawn ? { id: data.id, state: historical ? metadata.state : 'withdrawn', erased: true, withdrawn: true } : data;
  }
  uploadReceipt(id, clientId, digest, guard = {}) {
    const session = this.get(id); this.#check(session, { ...guard, revision: undefined });
    const receipt = this.db.prepare('SELECT * FROM receipts WHERE session_id=? AND client_id=?').get(id, `upload:${clientId}`);
    if (!receipt) return null;
    if (receipt.bytes !== digest) throw new ConflictError('Upload client id has different bytes');
    const { uploadIds } = JSON.parse(receipt.result);
    return { replayed: true, events: uploadIds.map(uploadId => this.read(id).findLast(e => e.type === 'upload.state' && e.data.id === uploadId)) };
  }
  postUploads(id, clientId, digest, files, limits, guard = {}) {
    limits = normalizeUploadLimits(limits);
    return this.transaction(() => {
      const replay = this.uploadReceipt(id, clientId, digest, guard); if (replay) return replay;
      const session = this.get(id); this.#check(session, guard);
      const current = session.uploads.filter(u => u.state !== 'withdrawn');
      if (!files.length || files.length > limits.maxFilesPerRequest || current.length + files.length > limits.maxDocumentsPerSession ||
        current.reduce((n, u) => n + u.bytes, 0) + files.reduce((n, f) => n + f.bytes.length, 0) > limits.maxSessionBytes ||
        files.some(f => f.bytes.length > limits.maxBytes)) throw new RangeError('Upload limit');
      const events = files.map(file => {
        const uploadId = randomUUID(), event = this.#append(this.get(id), 'upload.state', { id: uploadId, state: 'pending',
          filename: file.filename, mediaType: file.mediaType, bytes: file.bytes.length, deadlineAt: file.deadlineAt, at: new Date().toISOString() });
        this.db.prepare('INSERT INTO uploads VALUES (?,?,?,?,?,NULL)').run(uploadId, id, file.bytes, file.bytes.length, event.data.contentRef);
        return event;
      });
      this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(id, `upload:${clientId}`, digest, JSON.stringify({ uploadIds: events.map(e => e.data.id) }));
      return { events, replayed: false };
    });
  }
  uploadBytes(id, uploadId) {
    const row = this.db.prepare('SELECT bytes FROM uploads WHERE session_id=? AND id=? AND tombstone IS NULL').get(id, uploadId);
    return row?.bytes ? new Uint8Array(row.bytes) : null;
  }
  completeUpload(id, uploadId, result, guard = {}) {
    // Removing original bytes uses the same secure-delete and WAL acknowledgement
    // boundary as withdrawal. Metadata/text stay erasable in the content store.
    return this.#invalidationTransaction(() => {
      const session = this.get(id); this.#check(session, guard);
      const upload = session.uploads.find(u => u.id === uploadId);
      if (!upload || upload.state !== 'pending') return null;
      const event = this.#append(session, 'upload.state', { ...upload, contentRef: undefined, hash: undefined,
        state: result.status, reason: result.reason, text: result.status === 'accepted' ? result.text : undefined,
        truncated: result.truncated, extractor: result.extractor });
      this.db.prepare('UPDATE uploads SET bytes=NULL,content_ref=? WHERE session_id=? AND id=?').run(event.data.contentRef, id, uploadId);
      return event;
    });
  }
  withdrawUpload(id, uploadId, guard = {}) {
    return this.#invalidationTransaction(() => {
      const session = this.get(id); this.#check(session, { ...guard, revision: undefined });
      const upload = session.uploads.find(u => u.id === uploadId);
      if (!upload) throw new NotFoundError('Upload not found');
      if (upload.state === 'withdrawn') {
        const previous = this.read(id).findLast(e => e.type === 'upload.state' && e.data.id === uploadId && e.data.state === 'withdrawn');
        if (previous) return previous;
      }
      const at = new Date().toISOString();
      this.db.prepare('UPDATE uploads SET bytes=NULL,tombstone=? WHERE session_id=? AND id=?').run(at, id, uploadId);
      this.db.prepare("UPDATE content SET bytes=NULL,tombstone=? WHERE session_id=? AND kind='upload' AND id LIKE ?")
        .run(at, id, `${id}:upload:${uploadId}:%`);
      this.#invalidate(id);
      return this.#append(this.get(id), 'upload.state', { id: uploadId, state: 'withdrawn', at });
    });
  }
  saveVoiceCall(id, record, { paused, guard = {} } = {}) {
    return this.transaction(() => {
      const session = this.get(id);
      // Terminal reconciliation must survive withdrawal and erasure.
      if (!record.terminal) { this.#check(session, guard);
        if (session.consentWithdrawn) throw new ConflictError('Voice consent withdrawn'); }
      const existing = this.db.prepare('SELECT * FROM voice_calls WHERE provider_id=?').get(record.providerSessionId);
      if (existing && (existing.call_id !== record.callId || existing.session_id !== id)) throw new ConflictError('Voice identity mismatch');
      this.db.prepare('INSERT INTO voice_calls VALUES (?,?,?,?) ON CONFLICT(provider_id) DO UPDATE SET record=excluded.record')
        .run(record.providerSessionId, record.callId, id, JSON.stringify(record));
      const event = paused === undefined || session.paused === paused ? null : this.#append(session, 'session.paused', { paused });
      return { acknowledged: true, ...(paused === undefined ? {} : { paused }), event };
    });
  }
  voiceCalls(id) {
    return this.db.prepare('SELECT * FROM voice_calls WHERE (? IS NULL OR session_id=?)').all(id ?? null, id ?? null)
      .map(row => ({ sessionId: row.session_id, ...JSON.parse(row.record) }));
  }
  postVoiceEvent(id, callId, providerId, value, guard = {}) {
    const transaction = value?.type === 'heard' ? fn => this.#invalidationTransaction(fn) : fn => this.transaction(fn);
    return transaction(() => {
      const session = this.get(id); this.#check(session, guard);
      if (session.paused || session.consentWithdrawn) throw new ConflictError('Voice publication blocked');
      const { type, turnId } = value;
      if (!['final', 'heard'].includes(type) || typeof turnId !== 'string' || turnId.length > 256 ||
        !turnId.startsWith(providerId + ':') || value.callId !== callId ||
        (type === 'final' && (!['user', 'assistant'].includes(value.role) || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 16000)) ||
        (type === 'heard' && (typeof value.prefix !== 'string' || value.prefix.length > 16000))) throw new TypeError('Invalid voice event');
      const clientId = 'voice:' + hash(JSON.stringify({ callId, turnId, type, ...(type === 'heard' ? { prefix: value.prefix } : {}) }));
      const bytes = hash(JSON.stringify(value));
      const receipt = this.db.prepare('SELECT bytes,result FROM receipts WHERE session_id=? AND client_id=?').get(id, clientId);
      if (receipt) {
        if (receipt.bytes !== bytes) throw new ConflictError('Voice event id has different bytes');
        return { event: this.#hydrateEvent(JSON.parse(receipt.result)), replayed: true };
      }
      const turn = session.transcript.find(t => t.id === turnId);
      let event;
      if (type === 'final') {
        if (turn) throw new ConflictError('Voice turn already exists');
        // Echo receipts consume typed turns durably, including across recovery
        // and process restart. Redelivery was handled above and consumes nothing.
        const consumed = value.role === 'user' ? new Set(this.db.prepare(
          "SELECT json_extract(result,'$.data.id') AS turn_id FROM receipts WHERE session_id=? AND client_id LIKE 'voice:%'"
        ).all(id).map(row => row.turn_id)) : null;
        const normalize = text => text.trim().replace(/\s+/gu, ' ');
        const typed = value.role === 'user' && session.transcript.find(t => t.voiceCallId === callId && !t.erased && !t.withdrawn &&
          !consumed.has(t.id) && normalize(t.content) === normalize(value.text));
        event = typed ? this.read(id).find(e => e.type === 'turn.final' && e.data.id === typed.id)
          : this.#append(session, 'turn.final', { id: turnId, role: value.role, content: value.text,
            at: new Date().toISOString(), ...(value.role === 'assistant' ? { inputRevision: inputRevision(session), provenance: guard.provenance === 'facade-produced' ? 'facade-produced' : 'browser-asserted' } : {}) });
        if (typed) {
          const metadata = { ...event, data: this.#metadata(id, event.type, event.data) };
          this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(id, clientId, bytes, JSON.stringify(metadata));
          return { event, replayed: true };
        }
      } else {
        if (!turn || turn.role !== 'assistant' || turn.erased || turn.withdrawn || !turn.content.startsWith(value.prefix)) throw new ConflictError('Invalid heard prefix');
        // Remove superseded assistant content and dependent projections from replay/export too.
        this.db.prepare("UPDATE content SET bytes=NULL,tombstone=? WHERE session_id=? AND (id=? OR kind IN ('understanding','actor'))")
          .run(new Date().toISOString(), id, turn.contentRef);
        event = this.#append(session, 'turn.corrected', { id: turnId, role: turn.role, content: value.prefix,
          at: turn.at, inputRevision: inputRevision(session), provenance: turn.provenance });
      }
      const metadata = { ...event, data: this.#metadata(id, event.type, event.data) };
      this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(id, clientId, bytes, JSON.stringify(metadata));
      return { event, replayed: false };
    });
  }
  #invalidate(id, turnId, all = false, concepts = true) {
    const at = new Date().toISOString(), target = this.get(id).transcript.find(t => t.id === turnId && t.role === 'user');
    // Erase only artifacts whose frozen dependency set contains this source.
    // Metadata and archived history unrelated to the source remain available.
    if (concepts) for (const row of this.db.prepare('SELECT * FROM concept_artifacts WHERE session_id=? AND tombstone IS NULL').all(id)) {
      const dependencies = JSON.parse(row.dependencies);
      if (all || turnId === undefined || dependencies.turnIds.includes(turnId)) {
        this.db.prepare('UPDATE concept_artifacts SET bytes=NULL,tombstone=? WHERE id=?').run(at, row.id);
        this.db.prepare("UPDATE content SET bytes=NULL,tombstone=? WHERE session_id=? AND kind='concept-feedback' AND id IN (SELECT json_extract(event,'$.data.contentRef') FROM events WHERE session_id=? AND json_extract(event,'$.data.artifactId')=?)")
          .run(at, id, id, row.id);
      }
    }
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
      this.db.prepare('DELETE FROM host_states WHERE session_id=?').run(id);
      this.db.prepare('UPDATE uploads SET bytes=NULL,tombstone=? WHERE session_id=?').run(new Date().toISOString(), id);
      return this.#append(session, 'session.erased', { at: new Date().toISOString() });
    });
  }
  reviseConsent(id, granted, guard = {}) {
    return this.#invalidationTransaction(() => {
      const session = this.get(id); this.#check(session, guard); this.#invalidate(id, undefined, false, !granted);
      return this.#append(session, 'consent.revised', { granted, at: new Date().toISOString() });
    });
  }
  pause(id, paused, guard = {}) {
    return this.transaction(() => { const session = this.get(id); this.#check(session, guard);
      return this.#append(session, 'session.paused', { paused }); });
  }
  conceptArtifactIndex(id) {
    // Tombstones remain accountable in exports without recovering erased metadata.
    return this.db.prepare('SELECT id,tombstone IS NOT NULL AS erased FROM concept_artifacts WHERE session_id=? ORDER BY rowid')
      .all(id).map(row => ({ id: row.id, erased: Boolean(row.erased) }));
  }
  conceptArtifact(id, artifactId) {
    const row = this.db.prepare('SELECT * FROM concept_artifacts WHERE session_id=? AND id=?').get(id, artifactId);
    if (!row || row.tombstone) return { id: artifactId, erased: true, tombstone: row?.tombstone ?? 'missing' };
    const metadata = JSON.parse(row.metadata);
    return { ...metadata, bytes: new Uint8Array(row.bytes), dependencies: JSON.parse(row.dependencies) };
  }
  canStoreConcept(id, bytes = MAX_IMAGE_BYTES) {
    return this.db.prepare('SELECT COALESCE(SUM(length(bytes)),0) AS n FROM concept_artifacts WHERE session_id=?').get(id).n + bytes <= MAX_CONCEPT_STORAGE_BYTES;
  }
  completeConcept(id, artifact, metadata, state) {
    const html = artifact.mediaType === HTML_MEDIA_TYPE;
    if (!(html ? isHTMLArtifact(artifact) : isUIArtifact(artifact))) throw new TypeError('Invalid concept artifact');
    const info = html ? null : imageInfo(artifact.bytes);
    if (html ? !inspectHTML(artifact.bytes).ok : info.mediaType !== artifact.mediaType || info.width !== artifact.width || info.height !== artifact.height) throw new TypeError('Invalid concept bytes');
    if (artifact.provenance.subject.contentDigest !== `sha-256=:${createHash('sha256').update(artifact.bytes).digest('base64')}:`) throw new TypeError('Invalid concept bytes');
    return this.transaction(() => {
      const session = this.get(id); this.#check(session);
      if (!this.canStoreConcept(id, artifact.bytes.length)) throw new RangeError('Concept storage limit');
      if (session.consentWithdrawn || session.conceptIntent?.pending?.id !== metadata.requestId ||
        metadata.turnIds.some(turnId => !session.transcript.some(t => t.id === turnId && !t.erased && !t.withdrawn))) throw new ConflictError('Concept invalidated');
      const dependencies = { turnIds: [...metadata.turnIds], referenceIds: [...metadata.referenceIds] };
      for (const referenceId of metadata.referenceIds) {
        const previous = this.conceptArtifact(id, referenceId);
        if (!previous.erased) {
          dependencies.turnIds.push(...previous.dependencies.turnIds); dependencies.referenceIds.push(...previous.dependencies.referenceIds);
        }
      }
      dependencies.turnIds = [...new Set(dependencies.turnIds)]; dependencies.referenceIds = [...new Set(dependencies.referenceIds)];
      const publicArtifact = { ...metadata, ...dependencies, mediaType: artifact.mediaType, width: artifact.width, height: artifact.height,
        promptDigest: artifact.promptDigest, provenance: artifact.provenance, feedback: { vote: 'clear', chips: [] } };
      this.db.prepare('INSERT INTO concept_artifacts VALUES (?,?,?,?,?,NULL)').run(metadata.id, id, artifact.bytes,
        JSON.stringify(publicArtifact), JSON.stringify(dependencies));
      return this.#append(session, 'concept.state', { ...state, artifact: publicArtifact });
    });
  }
  conceptAction(id, clientId, bytes, fn, guard = {}) {
    return this.transaction(() => {
      const session = this.get(id); this.#check(session, { ...guard, revision: undefined });
      const key = `concept:${clientId}`, receipt = this.db.prepare('SELECT * FROM receipts WHERE session_id=? AND client_id=?').get(id, key);
      if (receipt) {
        if (receipt.bytes !== hash(bytes)) throw new ConflictError('Concept request bytes changed');
        return { event: this.#hydrateEvent(JSON.parse(receipt.result)), replayed: true };
      }
      this.#check(session, guard);
      const { type, data } = fn(session);
      const event = this.#append(session, type, data);
      const row = this.db.prepare('SELECT event FROM events WHERE session_id=? AND seq=?').get(id, event.seq);
      this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(id, key, hash(bytes), row.event);
      return { event, replayed: false };
    });
  }
  // Upload integrations call this after persisting their source tombstone. This
  // transaction erases dependent bytes/feedback and invalidates pending work.
  removeConceptReference(id, referenceId, guard = {}) {
    return this.#invalidationTransaction(() => {
      const session = this.get(id); this.#check(session, guard); const at = new Date().toISOString();
      for (const row of this.db.prepare('SELECT * FROM concept_artifacts WHERE session_id=? AND tombstone IS NULL').all(id)) {
        if (JSON.parse(row.dependencies).referenceIds.includes(referenceId)) {
          this.db.prepare('UPDATE concept_artifacts SET bytes=NULL,tombstone=? WHERE id=?').run(at, row.id);
          this.db.prepare("UPDATE content SET bytes=NULL,tombstone=? WHERE session_id=? AND kind='concept-feedback' AND id IN (SELECT json_extract(event,'$.data.contentRef') FROM events WHERE session_id=? AND json_extract(event,'$.data.artifactId')=?)").run(at, id, id, row.id);
        }
      }
      const intent = reduceConceptIntent(session.conceptIntent ?? createConceptIntent(), { type: 'source-removed', source: 'reference', id: referenceId, now: Date.now() });
      const affected = intent.pending?.referenceIds.includes(referenceId);
      return this.#append(this.get(id), 'concept.state', { intent: affected ? { ...intent, pending: null } : intent,
        status: affected ? { phase: 'failed', error: 'source-removed', retryable: false } : session.conceptStatus });
    });
  }
  /**
   * Durable visitor choice. A write based on any revision but the current one conflicts;
   * resending the current choice on the current revision is idempotent. Device
   * conversations stay in their tab, so a started conversation (even with every turn
   * withdrawn) cannot switch into or out of device processing.
   */
  changeSettings(id, { processingPreset, settings }, { ownerToken, baseRevision, at = new Date().toISOString() } = {}) {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new TypeError('Settings base revision required');
    return this.transaction(() => {
      const session = this.get(id); this.#check(session, { ownerToken });
      const current = session.settings, preset = session.processingPreset ?? 'best';
      // Every write names the revision it was based on, so a stale write or a replay never lands.
      if (baseRevision !== current.revision) throw new SettingsConflictError('settings-conflict', session);
      if (preset === processingPreset && sameSelection(current, settings) && current.origin === 'chosen') return { event: null, session };
      // Each change is a durable event; a conversation's history of choices stays bounded.
      if (current.revision >= MAX_SETTINGS_REVISIONS) throw new RangeError('Settings limit');
      if ((preset === 'device') !== (processingPreset === 'device') && conversationStarted(session)) {
        throw new SettingsConflictError('new-conversation-required', session);
      }
      const next = normalizeSettings({ ...settings, revision: current.revision + 1, origin: 'chosen', at });
      const event = this.#append(session, 'settings.changed', { processingPreset, settings: next });
      return { event, session: this.get(id) };
    });
  }
  /** The owner's most recent confirmed choice in a conversation that still exists. */
  lastSettings(ownerToken) {
    if (!ownerToken) return null;
    const row = this.db.prepare(`SELECT snapshot FROM sessions WHERE json_extract(snapshot, '$.ownerHash')=?
      AND json_extract(snapshot, '$.tombstone') IS NULL AND json_extract(snapshot, '$.settings.origin')='chosen'
      ORDER BY json_extract(snapshot, '$.settings.at') DESC LIMIT 1`).get(hash(ownerToken));
    if (!row) return null;
    const { processingPreset, settings } = JSON.parse(row.snapshot);
    return { processingPreset: processingPreset ?? 'best', settings: normalizeSettings(settings) };
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
