import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { normalizeUploadLimits } from './upload-limits.js';
import { createVoiceOperationStore } from './voice-operation-storage.js';
import { applyEvent, createSession, inputRevision, emptyUnderstanding, isUIArtifact, isHTMLArtifact, inspectHTML, HTML_MEDIA_TYPE, imageInfo, reduceConceptIntent, createConceptIntent, MAX_IMAGE_BYTES,
  defaultSettings, normalizeSettings, sameSelection, conversationStarted, createCredits, reduceCredits, aiTextOrigin, withAITextOrigin,
  voiceAuthorizationRevision, createVoiceLifecycle, reduceVoiceLifecycle, parseReply } from '@inspr/aithema-core';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const MAX_CONCEPT_STORAGE_BYTES = 64 * 1024 * 1024;
export const MAX_SETTINGS_REVISIONS = 1000;
const turnMetadata = ['id', 'role', 'at', 'inputRevision', 'contentRef', 'hash', 'erased', 'withdrawn', 'provenance', 'voiceCallId', 'voiceProviderId', 'callId', 'providerSessionId', 'userTurnOrdinal', 'replyId'];

// Only core-owned session rows belong here. Host extensions are cleaned by retired.
export const CORE_RETIREMENT_TABLES = Object.freeze([
  'safeguard_inputs', 'safeguard_direction', 'host_states', 'conversation_credit_guards', 'content', 'events',
  'receipts', 'voice_calls', 'voice_lifecycle_calls', 'concept_artifacts', 'uploads',
  'voice_turn_operations', 'session_retention', 'retirement_pending', 'lane_failures',
  'ui_render_claims', 'voice_cap_reservations', 'budget_attempts',
]);
const quoteIdentifier = name => '"' + name.replaceAll('"', '""') + '"';

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
    this.activityOrigin = new AsyncLocalStorage();
    this.db = new DatabaseSync(path);
    this.db.function('retention_activity', () => this.countsAsActivity() ? 1 : 0);
    this.db.exec(`PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS safeguard_inputs (session_id TEXT NOT NULL REFERENCES sessions(id),
        input_key TEXT NOT NULL, revision TEXT, off_topic INTEGER NOT NULL, analysis_off INTEGER NOT NULL, PRIMARY KEY(session_id,input_key));
      CREATE TABLE IF NOT EXISTS safeguard_direction (session_id TEXT PRIMARY KEY REFERENCES sessions(id), record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lane_failures (session_id TEXT NOT NULL REFERENCES sessions(id),
        lane TEXT NOT NULL CHECK(lane IN ('reaction','understanding')), failure TEXT NOT NULL,
        PRIMARY KEY(session_id,lane));
      CREATE TABLE IF NOT EXISTS host_states (session_id TEXT PRIMARY KEY REFERENCES sessions(id), record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS owner_credit_guards (owner_hash TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_credit_guards (session_id TEXT PRIMARY KEY REFERENCES sessions(id), record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        kind TEXT NOT NULL, bytes TEXT, hash TEXT NOT NULL, at TEXT NOT NULL, tombstone TEXT);
      CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(session_id,seq));
      CREATE TABLE IF NOT EXISTS receipts (session_id TEXT NOT NULL REFERENCES sessions(id),
        client_id TEXT NOT NULL, bytes BLOB NOT NULL, result TEXT NOT NULL, PRIMARY KEY(session_id,client_id));
      CREATE TABLE IF NOT EXISTS voice_calls (provider_id TEXT PRIMARY KEY, call_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id), record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS voice_lifecycle_calls (session_id TEXT NOT NULL REFERENCES sessions(id), call_id TEXT NOT NULL,
        record TEXT NOT NULL, PRIMARY KEY(session_id,call_id));
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
    if (!this.db.prepare('PRAGMA table_info(safeguard_inputs)').all().some(column => column.name === 'analysis_off')) {
      this.db.exec('ALTER TABLE safeguard_inputs ADD COLUMN analysis_off INTEGER NOT NULL DEFAULT 0; UPDATE safeguard_inputs SET analysis_off=off_topic;');
    }
    if (!this.db.prepare('PRAGMA table_info(safeguard_inputs)').all().some(column => column.name === 'assessment_revision')) {
      this.db.exec('ALTER TABLE safeguard_inputs ADD COLUMN assessment_revision TEXT; UPDATE safeguard_inputs SET assessment_revision=revision;');
    }
    this.#migrate();
    // Preserve the original deadline of legacy guards, only on the conversation
    // they actually belong to. Never rebind one owner's deadline to New/reset.
    const erasedGuards = this.transaction(() => {
      this.db.exec(`INSERT OR IGNORE INTO conversation_credit_guards
        SELECT s.id,g.record FROM owner_credit_guards g JOIN sessions s ON s.id=json_extract(g.record,'$.sessionId')
        WHERE json_extract(s.snapshot,'$.tombstone') IS NULL AND json_extract(g.record,'$.status') IS NOT NULL;
        UPDATE owner_credit_guards SET record=json_set(record,'$.sessionId',
          (SELECT id FROM sessions WHERE json_extract(snapshot,'$.ownerHash')=owner_hash
            AND json_extract(snapshot,'$.tombstone') IS NULL ORDER BY rowid DESC LIMIT 1))
          WHERE json_extract(record,'$.sessionId') IS NULL;`);
      // Repair AIT-261's unbound pause rows at startup, never in a retention sweep.
      const owners = this.db.prepare(`DELETE FROM owner_credit_guards WHERE NOT EXISTS
        (SELECT 1 FROM sessions WHERE id=json_extract(record,'$.sessionId')
          AND json_extract(snapshot,'$.ownerHash')=owner_hash AND json_extract(snapshot,'$.tombstone') IS NULL)`).run().changes;
      const conversations = this.db.prepare(`DELETE FROM conversation_credit_guards WHERE session_id IN
        (SELECT id FROM sessions WHERE json_extract(snapshot,'$.tombstone') IS NOT NULL)`).run().changes;
      return owners + conversations;
    });
    this.voiceTurnStore = createVoiceOperationStore(this);
    this.#retention();
    if (erasedGuards) this.checkpointErasure();
    } catch (error) { this.db?.close(); this.writer?.close(); throw error; }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  #retention() {
    this.transaction(() => {
      const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='session_retention'").get();
      this.db.exec(`CREATE TABLE IF NOT EXISTS session_retention (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id), last_activity INTEGER NOT NULL, busy INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS retention_idle ON session_retention(last_activity,session_id) WHERE busy=0;
        CREATE TABLE IF NOT EXISTS retirement_pending (session_id TEXT PRIMARY KEY REFERENCES sessions(id));
        CREATE TABLE IF NOT EXISTS retired_ui_renders (day TEXT PRIMARY KEY, count INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS retired_voice_usage (day TEXT PRIMARY KEY, spent_ms INTEGER NOT NULL, reserved_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS retired_spend (account TEXT PRIMARY KEY, spent_micro INTEGER NOT NULL,
          reserved_micro INTEGER NOT NULL, uncertain_micro INTEGER NOT NULL, breached INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS credit_guard_session ON owner_credit_guards(json_extract(record,'$.sessionId'));
        CREATE INDEX IF NOT EXISTS content_session ON content(session_id);
        CREATE INDEX IF NOT EXISTS lifecycle_session ON voice_lifecycle_calls(session_id);`);
      const pendingColumns = this.db.prepare('PRAGMA table_info(retirement_pending)').all();
      for (const [name, type] of [['owner_hash', 'TEXT'], ['attempts', 'INTEGER NOT NULL DEFAULT 0'], ['retry_at', 'INTEGER NOT NULL DEFAULT 0']]) {
        if (!pendingColumns.some(column => column.name === name)) this.db.exec(`ALTER TABLE retirement_pending ADD COLUMN ${name} ${type}`);
      }
      this.db.exec(`UPDATE retirement_pending SET owner_hash=(SELECT json_extract(snapshot,'$.ownerHash') FROM sessions WHERE id=session_id) WHERE owner_hash IS NULL;
        CREATE INDEX IF NOT EXISTS retirement_retry ON retirement_pending(retry_at,session_id);`);
      // Only the migration visits historical snapshots. Sweeps never read tombstones.
      if (!exists) this.db.exec(`INSERT INTO session_retention(session_id,last_activity)
        SELECT id, COALESCE((SELECT MAX(CAST((julianday(json_extract(event,'$.at'))-2440587.5)*86400000 AS INTEGER))
          FROM events WHERE session_id=sessions.id), CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
        FROM sessions WHERE json_extract(snapshot,'$.tombstone') IS NULL;`);
      // The exclusive writer lock makes process-local leases safe to reset at boot.
      this.db.exec(`DROP TRIGGER IF EXISTS retention_event;
        UPDATE session_retention SET busy=0;
        CREATE TRIGGER IF NOT EXISTS retention_create AFTER INSERT ON sessions WHEN json_extract(NEW.snapshot,'$.tombstone') IS NULL BEGIN
          INSERT INTO session_retention(session_id,last_activity) VALUES (NEW.id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)); END;
        CREATE TRIGGER retention_event AFTER INSERT ON events WHEN retention_activity()=1 BEGIN
          UPDATE session_retention SET last_activity=MAX(last_activity,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) WHERE session_id=NEW.session_id; END;
        CREATE TRIGGER IF NOT EXISTS retention_erase AFTER UPDATE ON sessions WHEN json_extract(NEW.snapshot,'$.tombstone') IS NOT NULL BEGIN
          DELETE FROM session_retention WHERE session_id=NEW.id; END;`);
    });
  }
  /** Activity rule: direct storage calls are host activity; system scopes never
   * renew retention, including events and async work spawned inside that scope.
   * AsyncLocalStorage keeps concurrent person/host requests independent. */
  countsAsActivity() { return this.activityOrigin.getStore() !== 'system'; }
  systemWork(fn) { return this.activityOrigin.run('system', fn); }
  touch(id) {
    if (!this.countsAsActivity()) return;
    this.db.prepare('UPDATE session_retention SET last_activity=MAX(last_activity,?) WHERE session_id=?').run(Date.now(), id);
  }
  /** Leases exclude in-flight requests, open event streams and reasoning jobs. */
  hold(id) {
    this.db.prepare('UPDATE session_retention SET busy=busy+1 WHERE session_id=?').run(id);
    const activity = this.countsAsActivity();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.db.prepare('UPDATE session_retention SET busy=MAX(0,busy-1),last_activity=MAX(last_activity,?) WHERE session_id=?').run(activity ? Date.now() : 0, id);
    };
  }
  liveIds(after = '', limit = 100) {
    return this.db.prepare('SELECT session_id FROM session_retention WHERE session_id>? ORDER BY session_id LIMIT ?')
      .all(after, limit).map(row => row.session_id);
  }
  retirementCandidates(before, limit) {
    return this.db.prepare('SELECT session_id FROM session_retention WHERE busy=0 AND last_activity<? ORDER BY last_activity,session_id LIMIT ?')
      .all(before, limit).map(row => row.session_id);
  }
  pendingRetirements(limit, now = Date.now()) {
    return this.db.prepare('SELECT session_id FROM retirement_pending WHERE retry_at<=? ORDER BY retry_at,session_id LIMIT ?').all(now, limit).map(row => row.session_id);
  }
  retirementOwnerHash(id) {
    return this.db.prepare('SELECT owner_hash FROM retirement_pending WHERE session_id=?').get(id)?.owner_hash;
  }
  failRetirement(id) {
    const pending = this.db.prepare('SELECT attempts FROM retirement_pending WHERE session_id=?').get(id);
    if (pending) this.db.prepare('UPDATE retirement_pending SET attempts=attempts+1,retry_at=? WHERE session_id=?')
      .run(Date.now() + Math.min(3_600_000, 1000 * 2 ** Math.min(pending.attempts, 12)), id);
  }
  /** Topological order over the explicit core list; host tables never enter it. */
  retirementDeleteOrder() {
    const present = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const tables = CORE_RETIREMENT_TABLES.filter(name => present.has(name));
    const order = [], visiting = new Set(), visited = new Set();
    const visit = name => {
      if (visited.has(name)) return;
      if (visiting.has(name)) throw new Error('Cyclic core retirement foreign key');
      visiting.add(name);
      for (const child of tables) {
        if (child !== name && this.db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(child)})`).all().some(fk => fk.table === name)) visit(child);
      }
      visiting.delete(name); visited.add(name); order.push(name);
    };
    for (const name of tables) visit(name);
    return order;
  }
  /** Only a tombstone claimed by retire can lose its append-only journal. */
  purgeRetired(id) {
    this.#invalidationTransaction(() => {
      if (!this.get(id).tombstone || !this.db.prepare('SELECT 1 FROM retirement_pending WHERE session_id=?').get(id)) throw new ConflictError('Retirement not claimed');
      const tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
      const has = name => tables.has(name);
      if (has('ui_render_claims')) this.db.prepare(`INSERT INTO retired_ui_renders
        SELECT day,COUNT(*) FROM ui_render_claims WHERE session_id=? GROUP BY day
        ON CONFLICT(day) DO UPDATE SET count=count+excluded.count`).run(id);
      if (has('voice_cap_reservations')) this.db.prepare(`INSERT INTO retired_voice_usage
        SELECT day,COALESCE(SUM(actual_ms),0),COALESCE(SUM(CASE WHEN actual_ms IS NULL THEN reserved_ms ELSE 0 END),0)
        FROM voice_cap_reservations WHERE session_id=? GROUP BY day ON CONFLICT(day) DO UPDATE SET
        spent_ms=spent_ms+excluded.spent_ms,reserved_ms=reserved_ms+excluded.reserved_ms`).run(id);
      if (has('budget_attempts')) {
        if (has('budget_corrections')) this.db.prepare('DELETE FROM budget_corrections WHERE attempt_id IN (SELECT attempt_id FROM budget_attempts WHERE session_id=?)').run(id);
        if (has('spend_reservations')) {
          this.db.prepare(`INSERT INTO retired_spend
            SELECT account,COALESCE(SUM(actual_micro),0),
              COALESCE(SUM(CASE WHEN actual_micro IS NULL AND state!='uncertain' THEN reserved_micro ELSE 0 END),0),
              COALESCE(SUM(CASE WHEN actual_micro IS NULL AND state='uncertain' THEN reserved_micro ELSE 0 END),0),
              MAX(CASE WHEN actual_micro > COALESCE(ceiling_micro,reserved_micro) THEN 1 ELSE 0 END)
            FROM spend_reservations WHERE attempt_id IN (SELECT attempt_id FROM budget_attempts WHERE session_id=?) GROUP BY account
            ON CONFLICT(account) DO UPDATE SET spent_micro=spent_micro+excluded.spent_micro,
              reserved_micro=reserved_micro+excluded.reserved_micro,uncertain_micro=uncertain_micro+excluded.uncertain_micro,
              breached=MAX(breached,excluded.breached)`).run(id);
          this.db.prepare('DELETE FROM spend_reservations WHERE attempt_id IN (SELECT attempt_id FROM budget_attempts WHERE session_id=?)').run(id);
        }
      }
      this.db.exec('DROP TRIGGER events_no_delete');
      for (const name of this.retirementDeleteOrder()) {
        this.db.prepare(`DELETE FROM ${quoteIdentifier(name)} WHERE session_id=?`).run(id);
      }
      this.db.exec("CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;");
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
      this.db.prepare("DELETE FROM owner_credit_guards WHERE json_extract(record,'$.sessionId')=?").run(id);
    });
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
      session.understanding = data.erased ? emptyUnderstanding(session) : withAITextOrigin(data);
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
  // Private, value-free operation state survives handler/process restarts.
  laneFailures(id) {
    return this.db.prepare('SELECT failure FROM lane_failures WHERE session_id=? ORDER BY rowid')
      .all(id).map(row => JSON.parse(row.failure));
  }
  setLaneFailure(id, failure) {
    return this.transaction(() => {
      const session = this.get(id);
      if (session.tombstone || inputRevision(session) !== failure.inputRevision) return false;
      // Do not persist provider diagnostics or request content.
      const record = { inputRevision: failure.inputRevision, lane: failure.lane,
        error: 'reasoning-unavailable', retryable: true,
        ...(failure.reason === 'budget reconciling' ? { reason: failure.reason } : {}) };
      this.db.prepare('INSERT INTO lane_failures VALUES (?,?,?) ON CONFLICT(session_id,lane) DO UPDATE SET failure=excluded.failure')
        .run(id, record.lane, JSON.stringify(record));
      return true;
    });
  }
  clearLaneFailures(id, lane) {
    if (lane) this.db.prepare('DELETE FROM lane_failures WHERE session_id=? AND lane=?').run(id, lane);
    else this.db.prepare('DELETE FROM lane_failures WHERE session_id=?').run(id);
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
    if (guard.authorizationRevision !== undefined && voiceAuthorizationRevision(session) !== guard.authorizationRevision) throw new ConflictError('Stale voice authorization');
  }
  list() { return this.db.prepare('SELECT id FROM sessions').all().map(r => r.id); }
  ownedIds(ownerToken) {
    if (!ownerToken) return [];
    return this.ownedIdsForHash(hash(ownerToken));
  }
  /** Trusted host/operator use; never accept an owner hash from a public request. */
  ownedIdsForHash(ownerHash, { includeErased = false } = {}) {
    return this.db.prepare("SELECT id FROM sessions WHERE json_extract(snapshot,'$.ownerHash')=? AND (? OR json_extract(snapshot,'$.tombstone') IS NULL)")
      .all(ownerHash, Number(includeErased)).map(row => row.id);
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
  // Legacy deadlines migrate to conversation_credit_guards at startup. Only
  // the owner's manual pause preference carries across New/reset afterwards,
  // until the session that recorded it is erased or retired.
  setOwnerPaused(ownerToken, paused, sessionId) {
    if (!ownerToken || typeof paused !== 'boolean' || typeof sessionId !== 'string') throw new TypeError('Invalid owner pause');
    return this.transaction(() => {
      const session = this.get(sessionId); this.#check(session, { ownerToken });
      this.db.prepare('INSERT INTO owner_credit_guards VALUES (?,?) ON CONFLICT(owner_hash) DO UPDATE SET record=excluded.record')
        .run(session.ownerHash, JSON.stringify({ sessionId, paused }));
    });
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
  creditState(id) {
    const row = this.db.prepare('SELECT record FROM conversation_credit_guards WHERE session_id=?').get(id);
    return row ? JSON.parse(row.record) : null;
  }
  /** Per-conversation clock and terminal notifications commit atomically.
   * An omitted owner token is for trusted server admission/timer/recovery only. */
  transitionCredits(id, ownerToken, event, options = {}) {
    return this.transaction(() => {
      const session = this.get(id); this.#check(session, { ownerToken });
      const state = this.creditState(id) ?? createCredits({ ...options, sessionId: id });
      const result = reduceCredits(state, { ...event, now: Math.max(event.now, state.lastNow) });
      this.db.prepare('INSERT INTO conversation_credit_guards VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET record=excluded.record')
        .run(id, JSON.stringify(result.state));
      return { ...result, events: result.events.map(e => this.#append(this.get(id), e.type, e.data)) };
    });
  }
  // Claim the fixed direction question before text or TTS output. Private memory
  // survives locale changes, transcript withdrawal and server restart.
  guardPurposeDirection(id, reply, policy, inputKey) {
    if (!policy.directionQuestion) return reply;
    return this.transaction(() => {
      const session = this.get(id); this.#check(session);
      const row = this.db.prepare('SELECT record FROM safeguard_direction WHERE session_id=?').get(id);
      const state = row ? JSON.parse(row.record) : { asked: false, unclear: [], lastInput: null };
      const key = inputKey ?? session.transcript.findLast(turn => turn.role === 'user' && !turn.erased && !turn.withdrawn)?.id;
      if (key && state.lastInput !== key) {
        state.lastInput = key;
        state.unclear = reply.scope === 'unclear' ? [...state.unclear, key].slice(-3) : [];
      }
      const copies = Object.values(policy.directionQuestion);
      const directionCard = copies.some(copy => reply.question_short?.includes(copy) || reply.options.some(option => option.text.includes(copy)));
      let content = reply.content;
      for (const copy of copies) content = content.replaceAll(copy, '').trim();
      const ask = !state.asked && reply.scope === 'unclear' && state.unclear.length >= 3 && session.pauseReason !== 'purpose';
      if (ask) { content = policy.directionQuestion[session.locale]; state.asked = true; }
      this.db.prepare('INSERT INTO safeguard_direction VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET record=excluded.record')
        .run(id, JSON.stringify(state));
      return { ...reply, content: content || (session.locale === 'de' ? 'Woran arbeiten Sie gerade?' : 'What are you working on?'),
        ...(reply.scope === 'unclear' || directionCard ? { question_short: null, options: [] } : {}) };
    });
  }
  // Scope is consumed internally; retain only the counter contribution and assessment gate.
  safeguards(id, revision) {
    const rows = this.db.prepare('SELECT revision,off_topic,analysis_off FROM safeguard_inputs WHERE session_id=?').all(id);
    return { offTopicTurns: rows.reduce((n, row) => n + row.off_topic, 0),
      assessed: rows.some(row => row.revision === revision),
      offTopic: rows.some(row => row.revision === revision && row.analysis_off === 1) };
  }
  // Recover project input only across a suffix of classified off-topic person
  // turns. Consent grants can carry this assessment gate without caching an
  // erased reply; corrections, withdrawals, uploads and locale changes cannot.
  purposeAssessmentInput(session) {
    const revision = inputRevision(session), suffix = revision.slice(revision.indexOf(':'));
    const rows = this.db.prepare('SELECT assessment_revision AS revision,analysis_off FROM safeguard_inputs WHERE session_id=?').all(session.id)
      .filter(row => row.revision?.slice(row.revision.indexOf(':')) === suffix);
    const latest = rows.find(row => row.revision === revision);
    if (!latest) return null;
    if (!latest.analysis_off) return session;
    const source = rows.filter(row => !row.analysis_off).sort((a, b) => Number(b.revision.split(':')[0]) - Number(a.revision.split(':')[0]))[0];
    if (!source) return null;
    // A retained assessment only covers project input at or before its own
    // revision. Later classified project input still needs normal admission.
    if (session.understanding.readinessAssessed &&
      Number(session.understanding.inputRevision?.split(':')[0]) >= Number(source.revision.split(':')[0])) return null;
    const first = Number(source.revision.split(':')[0]), count = session.inputRevision - first;
    const persons = session.transcript.filter(turn => turn.role === 'user');
    if (count <= 0 || count >= persons.length) return null;
    for (let input = first + 1; input <= session.inputRevision; input++) {
      if (!rows.some(row => row.revision === `${input}${suffix}` && row.analysis_off)) return null;
    }
    const boundary = session.transcript.indexOf(persons[persons.length - count]);
    return { ...session, transcript: session.transcript.slice(0, boundary) };
  }
  recordSafeguard(id, key, revision, offTopic, limit, { pause = true } = {}) {
    return this.transaction(() => {
      const session = this.get(id); this.#check(session);
      this.db.prepare('INSERT INTO safeguard_inputs(session_id,input_key,revision,off_topic,analysis_off,assessment_revision) VALUES (?,?,?,?,?,?) ON CONFLICT(session_id,input_key) DO UPDATE SET revision=excluded.revision,assessment_revision=excluded.assessment_revision,analysis_off=excluded.analysis_off,off_topic=MAX(safeguard_inputs.off_topic,excluded.off_topic)').run(id, key, revision ?? null, Number(offTopic), Number(offTopic), revision ?? null);
      const state = this.safeguards(id, revision);
      const event = pause && state.offTopicTurns >= limit && session.pauseReason !== 'purpose'
        ? this.#append(session, 'session.paused', { paused: true, reason: 'purpose' }) : null;
      return { ...state, event };
    });
  }
  appendPurposeReply(id, data, revision, offTopic, limit) {
    return this.transaction(() => {
      const session = this.get(id); this.#check(session);
      if (inputRevision(session) !== revision || session.pauseReason === 'purpose') return [];
      const person = session.transcript.findLast(turn => turn.role === 'user' && !turn.erased && !turn.withdrawn);
      const documents = (session.uploads ?? []).filter(upload => !upload.erased && !upload.withdrawn).map(upload => upload.id);
      const key = JSON.stringify(['text', person?.id ?? null, documents]);
      this.db.prepare('INSERT INTO safeguard_inputs(session_id,input_key,revision,off_topic,analysis_off,assessment_revision) VALUES (?,?,?,?,?,?) ON CONFLICT(session_id,input_key) DO UPDATE SET revision=excluded.revision,assessment_revision=excluded.assessment_revision,analysis_off=excluded.analysis_off,off_topic=MAX(safeguard_inputs.off_topic,excluded.off_topic)')
        .run(id, key, revision, Number(offTopic), Number(offTopic), revision ?? null);
      const events = data ? [this.#append(session, 'turn.final', data)] : [];
      if (this.safeguards(id).offTopicTurns >= limit && session.pauseReason !== 'purpose') {
        events.push(this.#append(this.get(id), 'session.paused', { paused: true, reason: 'purpose' }));
      }
      return events;
    });
  }
  carrySafeguardRevision(id, previousRevision, revision) {
    // An assistant heard-prefix correction changes no person/document input.
    // Retain its assessed purpose without creating another counter contribution.
    this.db.prepare('UPDATE safeguard_inputs SET revision=?,assessment_revision=? WHERE session_id=? AND revision=?').run(revision, revision, id, previousRevision);
  }
  bindSafeguard(id, key, revision) {
    this.db.prepare('UPDATE safeguard_inputs SET revision=?,assessment_revision=? WHERE session_id=? AND input_key=?').run(revision, revision, id, key);
  }
  pauseForPurpose(id, limit) {
    if (this.safeguards(id).offTopicTurns < limit || this.get(id).pauseReason === 'purpose') return null;
    return this.append(id, 'session.paused', { paused: true, reason: 'purpose' });
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
    const record = data.contentRef ? this.getRecord(id, data.contentRef) : null;
    const hydrated = !record ? data : record.erased ? { ...data, erased: true, withdrawn: true } : { ...data, ...record.data };
    return hydrated.role ? withAITextOrigin(hydrated) : hydrated;
  }
  #hydrateEvent(event) {
    let data = event.type === 'upload.state' ? this.#hydrateUpload(event.sessionId, event.data, true) : this.#hydrateData(event.sessionId, event.data);
    if (event.type === 'understanding.updated') data = withAITextOrigin(data);
    if (event.type === 'concept.state' && data.artifact && !this.db.prepare('SELECT 1 FROM concept_artifacts WHERE session_id=? AND id=? AND tombstone IS NULL').get(event.sessionId, data.artifact.id)) {
      return { ...event, data: { ...data, artifact: { id: data.artifact.id, erased: true } } };
    }
    return { ...event, data };
  }
  #metadata(id, type, data, seq) {
    if (['identity.state', 'verification.requested', 'library.state'].includes(type)) {
      const retained = type === 'identity.state' ? { identified: data.identified ?? (data.status === 'verified') } : {};
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
    // Reply choices and the engine label are content: erase them with the reply, never retain them in metadata.
    const origin = aiTextOrigin({ model: data.model, plugin: data.provider });
    const { scope, ...visibleData } = data;
    data = visibleData;
    const bytes = JSON.stringify(['turn.final', 'turn.corrected'].includes(type)
      ? { content: data.content, ...(data.role === 'assistant' ? { ...origin, ...(data.engine ? { engine: data.engine } : {}),
        ...('question_short' in data || 'options' in data ? parseReply(data) : {}) } : {}) }
      : { ...data, ...origin }), digest = hash(bytes);
    this.db.prepare('INSERT INTO content VALUES (?,?,?,?,?,?,NULL)').run(contentRef, id,
      ['turn.final', 'turn.corrected'].includes(type) ? data.role === 'user' ? 'person' : 'reply' : 'understanding', bytes, digest, at);
    return ['turn.final', 'turn.corrected'].includes(type) ? { id: data.id, role: data.role, at,
      ...Object.fromEntries(['inputRevision', 'provenance', 'voiceCallId', 'voiceProviderId', 'callId', 'providerSessionId', 'userTurnOrdinal', 'replyId'].filter(key => data[key] !== undefined).map(key => [key, data[key]])), contentRef, hash: digest }
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
      metadata.understanding = session.understanding.inputRevision === null
        ? { ...emptyUnderstanding(session), ...(session.understanding.origin === 'ai-generated' ? { origin: 'ai-generated' } : {}) }
        : old.understanding;
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
    if (type === 'session.paused' && session.pauseReason === 'purpose' && !data.paused) throw new ConflictError('Purpose pause is locked');
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
      if (session.pauseReason === 'purpose') throw new ConflictError('Purpose pause is locked');
      const receipt = this.db.prepare('SELECT bytes,result FROM receipts WHERE session_id=? AND client_id=?').get(id, clientId);
      if (receipt) {
        if (Buffer.from(receipt.bytes).toString() !== hash(bytes)) throw new ConflictError('Client event id has different bytes');
        return { event: this.#hydrateEvent(JSON.parse(receipt.result)), replayed: true };
      }
      // A first message whose body arrived across an empty conversation's locale change still
      // belongs here. Only locale events may relax the server's earlier revision, never consent,
      // withdrawal or another input, and never an explicit revision supplied by a client.
      const localeOnly = guard.initialLocaleSeq !== undefined && !conversationStarted(session) &&
        this.read(id, guard.initialLocaleSeq).every(event => event.type === 'session.locale-changed');
      this.#check(session, localeOnly ? { ...guard, revision: undefined } : guard);
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
    // SQLite returns an owned Uint8Array, independent of its stored blob. A view
    // preserves that ownership without copying another whole document.
    return row?.bytes ? new Uint8Array(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength) : null;
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
      const event = paused === undefined || session.paused === paused ? null : this.#append(session, 'session.paused', { paused,
        ...(!paused && guard.resumeRequestId !== undefined ? { resumeRequestId: guard.resumeRequestId } : {}) });
      return { acknowledged: true, ...(paused === undefined ? {} : { paused }), event };
    });
  }
  voiceLifecycle(id, callId) {
    const row = this.db.prepare('SELECT record FROM voice_lifecycle_calls WHERE session_id=? AND (? IS NULL OR call_id=?) ORDER BY rowid DESC LIMIT 1')
      .get(id, callId ?? null, callId ?? null);
    return row ? JSON.parse(row.record) : null;
  }
  transitionVoiceLifecycle(id, callId, event) {
    return this.transaction(() => {
      const prior = this.voiceLifecycle(id, callId) ?? createVoiceLifecycle(callId);
      const next = reduceVoiceLifecycle(prior, event);
      this.db.prepare('INSERT INTO voice_lifecycle_calls VALUES (?,?,?) ON CONFLICT(session_id,call_id) DO UPDATE SET record=excluded.record')
        .run(id, callId, JSON.stringify(next));
      return next;
    });
  }
  takeOverVoiceCall(id, callId, { tabId, epoch }) {
    return this.transaction(() => {
      const prior = this.voiceLifecycle(id, callId);
      if (!prior || prior.state === 'ended') throw new ConflictError('Logical call ended');
      if (prior.epoch !== epoch) throw new ConflictError('Voice ownership lost');
      const next = reduceVoiceLifecycle(prior, { type: 'takeover', epoch: epoch + 1, tabId });
      this.db.prepare('UPDATE voice_lifecycle_calls SET record=? WHERE session_id=? AND call_id=?')
        .run(JSON.stringify(next), id, callId);
      return next;
    });
  }
  voiceCalls(id) {
    return this.db.prepare('SELECT * FROM voice_calls WHERE (? IS NULL OR session_id=?)').all(id ?? null, id ?? null)
      .map(row => ({ sessionId: row.session_id, ...JSON.parse(row.record) }));
  }
  voiceOperations(id) { return this.voiceTurnStore.list(id); }
  claimVoiceOperation(context, options) { return this.voiceTurnStore.claim(context, options); }
  postVoiceEvent(id, callId, providerId, value, guard = {}) {
    const transaction = value?.type === 'heard' ? fn => this.#invalidationTransaction(fn) : fn => this.transaction(fn);
    return transaction(() => {
      const session = this.get(id); this.#check(session, guard);
      if (session.paused || session.consentWithdrawn) throw new ConflictError('Voice publication blocked');
      const { type, turnId } = value;
      if (!['final', 'heard', 'reply'].includes(type) || typeof turnId !== 'string' || turnId.length > 256 ||
        !turnId.startsWith(providerId + ':') || value.callId !== callId ||
        (type === 'final' && (!['user', 'assistant'].includes(value.role) || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 16000)) ||
        (type === 'heard' && (typeof value.prefix !== 'string' || value.prefix.length > 16000)) ||
        (type === 'reply' && (typeof value.replyId !== 'string' || !/^chatcmpl-[a-zA-Z0-9_-]{1,100}$/u.test(value.replyId)))) throw new TypeError('Invalid voice event');
      const clientId = 'voice:' + hash(JSON.stringify({ callId, turnId, type, ...(type === 'heard' ? { prefix: value.prefix } : {}) }));
      const bytes = hash(JSON.stringify(value));
      const receipt = this.db.prepare('SELECT bytes,result FROM receipts WHERE session_id=? AND client_id=?').get(id, clientId);
      if (receipt) {
        if (receipt.bytes !== bytes) throw new ConflictError('Voice event id has different bytes');
        return { event: this.#hydrateEvent(JSON.parse(receipt.result)), replayed: true };
      }
      const turn = session.transcript.find(t => t.id === turnId);
      let event;
      if (type === 'reply') {
        if (!turn || turn.role !== 'assistant' || turn.erased || turn.withdrawn) throw new ConflictError('Reply transcript missing');
        if (!guard.replyId || turn.replyId === guard.replyId) return { event: this.read(id).findLast(event =>
          ['turn.final', 'turn.corrected', 'turn.annotated'].includes(event.type) && event.data.id === turnId), replayed: true };
        if (turn.replyId) throw new ConflictError('Reply identity already recorded');
        event = this.#append(session, 'turn.annotated', { id: turnId, replyId: guard.replyId,
          ...(Number.isSafeInteger(guard.userTurnOrdinal) && guard.userTurnOrdinal > 0 ? { userTurnOrdinal: guard.userTurnOrdinal } : {}) });
      } else if (type === 'final') {
        if (turn) throw new ConflictError('Voice turn already exists');
        const userTurnOrdinal = value.role === 'user' ? value.userTurnOrdinal : guard.userTurnOrdinal;
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
            // Speech provenance comes from the authenticated server call, never
            // client fields. Typed echo receipts keep their original typed turn.
            callId, providerSessionId: providerId,
            ...(Number.isSafeInteger(userTurnOrdinal) && userTurnOrdinal > 0 ? { userTurnOrdinal } : {}),
            ...(value.role === 'assistant' && guard.replyId ? { replyId: guard.replyId } : {}),
            at: new Date().toISOString(), ...(value.role === 'assistant' ? { ...aiTextOrigin({ model: guard.model, plugin: guard.provider }),
              ...(guard.engine ? { engine: guard.engine } : {}), inputRevision: inputRevision(session),
              provenance: guard.provenance === 'facade-produced' ? 'facade-produced' : 'browser-asserted' } : {}) });
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
          at: turn.at, inputRevision: inputRevision(session), provenance: turn.provenance,
          callId: turn.callId, providerSessionId: turn.providerSessionId,
          ...(turn.userTurnOrdinal ? { userTurnOrdinal: turn.userTurnOrdinal } : {}),
          ...(turn.replyId ? { replyId: turn.replyId } : {}),
          ...aiTextOrigin({ model: turn.model, plugin: turn.provider }), ...(turn.engine ? { engine: turn.engine } : {}) });
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
    this.checkpointErasure();
    return result;
  }
  checkpointErasure() {
    // secure_delete clears pages in the database; truncate also removes earlier
    // committed content from the WAL before an erasure acknowledgement.
    const checkpoint = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint.busy) throw new Error('Erasure checkpoint unavailable');
  }
  /** Bounded removal of identity projections, including deleted conversations.
   * The host retains its cleanup queue until all batches have completed. */
  eraseIdentityProjections(ownerHash, { limit = 100, at = new Date().toISOString() } = {}) {
    if (typeof ownerHash !== 'string' || !/^[a-f0-9]{64}$/u.test(ownerHash) || !Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Invalid identity erasure');
    const owned = "SELECT id FROM sessions WHERE json_extract(snapshot,'$.ownerHash')=?";
    const contentFilter = `session_id IN (${owned}) AND tombstone IS NULL AND id IN
      (SELECT json_extract(event,'$.data.contentRef') FROM events WHERE json_extract(event,'$.type') IN ('identity.state','verification.requested'))`;
    let count = this.db.prepare(`UPDATE content SET bytes=NULL,tombstone=? WHERE id IN (SELECT id FROM content WHERE ${contentFilter} LIMIT ?)`)
      .run(at, ownerHash, limit).changes;
    for (const row of this.db.prepare(`SELECT session_id,record FROM host_states WHERE session_id IN (${owned})
      AND json_extract(record,'$.identity.address') IS NOT NULL LIMIT ?`).all(ownerHash, limit - count)) {
      const record = JSON.parse(row.record), state = record.identity;
      record.identity = { ...state, status: 'guest', address: null, verificationRevision: (state.verificationRevision ?? 0) + 1,
        expiresAt: null, resendAt: 0, expired: false, delivery: 'idle', confirmationAttempts: 0 };
      this.db.prepare('UPDATE host_states SET record=? WHERE session_id=?').run(JSON.stringify(record), row.session_id); count++;
    }
    // Keep the value-free identified flag: its transitions determine replay's
    // input revision. The host publishes a new anonymous state on next use.
    count += this.db.prepare(`UPDATE sessions SET snapshot=json_set(snapshot,'$.identity',NULL)
      WHERE id IN (SELECT id FROM sessions WHERE json_extract(snapshot,'$.ownerHash')=?
      AND json_extract(snapshot,'$.identity') IS NOT NULL LIMIT ?)`).run(ownerHash, limit - count).changes;
    const more = this.db.prepare(`SELECT 1 FROM content WHERE ${contentFilter} LIMIT 1`).get(ownerHash) ||
      this.db.prepare(`SELECT 1 FROM host_states WHERE session_id IN (${owned}) AND json_extract(record,'$.identity.address') IS NOT NULL LIMIT 1`).get(ownerHash) ||
      this.db.prepare("SELECT 1 FROM sessions WHERE json_extract(snapshot,'$.ownerHash')=? AND json_extract(snapshot,'$.identity') IS NOT NULL LIMIT 1").get(ownerHash);
    return { count, done: !more };
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
  expire(id, turnId) { return this.systemWork(() => this.withdraw(id, turnId, 'expiry')); }
  erase(id, guard = {}) {
    return this.#invalidationTransaction(() => {
      if (guard.retire) {
        const eligible = this.db.prepare('SELECT 1 FROM session_retention WHERE session_id=? AND busy=0 AND last_activity<?').get(id, guard.before);
        if (!eligible) return null;
        this.db.prepare(`INSERT INTO retirement_pending(session_id,owner_hash)
          SELECT id,json_extract(snapshot,'$.ownerHash') FROM sessions WHERE id=?`).run(id);
      }
      const session = this.get(id); this.#check(session, guard); this.#invalidate(id, undefined, true);
      this.clearLaneFailures(id);
      this.db.prepare("DELETE FROM owner_credit_guards WHERE json_extract(record,'$.sessionId')=?").run(id);
      this.db.prepare('DELETE FROM conversation_credit_guards WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM host_states WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM safeguard_inputs WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM safeguard_direction WHERE session_id=?').run(id);
      this.db.prepare('UPDATE uploads SET bytes=NULL,tombstone=? WHERE session_id=?').run(new Date().toISOString(), id);
      return this.#append(session, 'session.erased', { at: new Date().toISOString() });
    });
  }
  reviseConsent(id, granted, guard = {}, { conversationUnchanged = false } = {}) {
    return this.#invalidationTransaction(() => {
      const session = this.get(id); this.#check(session, guard);
      conversationUnchanged = conversationUnchanged === true && granted && !session.consentWithdrawn;
      if (!conversationUnchanged) this.#invalidate(id, undefined, false, !granted);
      const event = this.#append(session, 'consent.revised', { granted, at: new Date().toISOString(),
        ...(conversationUnchanged ? { conversationUnchanged: true } : {}) });
      if (granted) {
        const suffix = inputRevision(session).split(':').slice(1).join(':');
        const nextSuffix = inputRevision(this.get(id)).split(':').slice(1).join(':');
        for (const row of this.db.prepare('SELECT input_key,assessment_revision FROM safeguard_inputs WHERE session_id=?').all(id)) {
          if (row.assessment_revision?.split(':').slice(1).join(':') === suffix) {
            this.db.prepare('UPDATE safeguard_inputs SET assessment_revision=? WHERE session_id=? AND input_key=?')
              .run(`${row.assessment_revision.split(':')[0]}:${nextSuffix}`, id, row.input_key);
          }
        }
      }
      return event;
    });
  }
  pause(id, paused, guard = {}) {
    return this.transaction(() => { const session = this.get(id); this.#check(session, guard);
      return this.#append(session, 'session.paused', { paused,
        ...(guard.pauseRequestId === undefined ? {} : { pauseRequestId: guard.pauseRequestId }) }); });
  }
  changeLocale(id, locale, guard = {}) {
    if (!['en', 'de'].includes(locale)) throw new TypeError('Unsupported locale');
    return this.transaction(() => {
      const session = this.get(id); this.#check(session, { ...guard, revision: undefined });
      // The handler also checks its connecting-call reservation synchronously. Persisted open
      // calls protect another handler instance and the interval before restart reconciliation.
      if (conversationStarted(session) || this.voiceCalls(id).some(call => !call.terminal)) throw new ConflictError('locale-conflict');
      if (session.locale === locale) return null;
      return this.#append(session, 'session.locale-changed', { locale });
    });
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
   * Durable settings. Only an explicit confirmation records a visitor choice.
   * A write based on any revision but the current one conflicts;
   * resending the current choice on the current revision is idempotent. Device
   * conversations stay in their tab, so a started conversation (even with every turn
   * withdrawn) cannot switch into or out of device processing.
   */
  changeSettings(id, { processingPreset, settings }, { ownerToken, baseRevision, confirm = false, at = new Date().toISOString() } = {}) {
    if (typeof confirm !== 'boolean') throw new TypeError('Invalid settings confirmation');
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new TypeError('Settings base revision required');
    return this.transaction(() => {
      const session = this.get(id); this.#check(session, { ownerToken });
      const current = session.settings, preset = session.processingPreset ?? 'best';
      // Every write names the revision it was based on, so a stale write or a replay never lands.
      if (baseRevision !== current.revision) throw new SettingsConflictError('settings-conflict', session);
      // Equal values can still be the person's first confirmation of defaults or a last choice.
      if (preset === processingPreset && sameSelection(current, settings) && (!confirm || current.origin === 'chosen')) return { event: null, session };
      // Each change is a durable event; a conversation's history of choices stays bounded.
      if (current.revision >= MAX_SETTINGS_REVISIONS) throw new RangeError('Settings limit');
      if ((preset === 'device') !== (processingPreset === 'device') && conversationStarted(session)) {
        throw new SettingsConflictError('new-conversation-required', session);
      }
      const next = normalizeSettings({ ...settings, revision: current.revision + 1,
        origin: confirm ? 'chosen' : current.origin, at: confirm ? at : current.at });
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
