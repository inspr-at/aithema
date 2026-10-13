import { createHash, randomUUID } from 'node:crypto';
import { PluginError } from '@inspr/aithema-core';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refused = reason => { throw new PluginError('not-admitted', reason); };
const paid = operation => operation.attempts.some(attempt => attempt.attemptId);

/** Private durable operations. Reply bytes use the ordinary erasable content store. */
export function createVoiceOperationStore(storage) {
  const db = storage.db;
  db.exec(`CREATE TABLE IF NOT EXISTS voice_turn_operations (
    operation_key TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    call_id TEXT NOT NULL, provider_id TEXT NOT NULL, record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS voice_turn_session ON voice_turn_operations(session_id);
    CREATE INDEX IF NOT EXISTS voice_turn_generation ON voice_turn_operations(session_id, call_id, provider_id);`);
  const get = key => {
    if (!key) return null;
    const row = db.prepare('SELECT record FROM voice_turn_operations WHERE operation_key=?').get(key);
    return row ? JSON.parse(row.record) : null;
  };
  const list = id => db.prepare('SELECT record FROM voice_turn_operations WHERE (? IS NULL OR session_id=?) ORDER BY rowid')
    .all(id ?? null, id ?? null).map(row => JSON.parse(row.record));
  const save = operation => db.prepare('UPDATE voice_turn_operations SET record=? WHERE operation_key=?')
    .run(JSON.stringify(operation), operation.key);
  const generationOperations = context => list(context.sessionId).filter(operation =>
    operation.callId === context.callId && operation.providerSessionId === context.providerSessionId);
  const ownsEpoch = operation => {
    const logical = storage.voiceLifecycle(operation.sessionId, operation.callId);
    return logical ? logical.epoch === operation.epoch && logical.controllingTabId === operation.controllingTabId : operation.epoch === undefined;
  };
  // Epoch retirement fences admissions and readers, never paid completion.
  const assertEpoch = operation => { if (!ownsEpoch(operation)) refused('voice-turn-revoked'); };

  function assertCurrent(operation) {
    // Consent/erasure still revoke access. Transcript events and newer operations
    // have no bearing on publication of admitted work.
    const session = JSON.parse(db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(operation.sessionId).snapshot);
    if (session.tombstone || session.consentWithdrawn || session.paused ||
      (session.conversationConsentRevision ?? session.consentRevision) !== operation.consentRevision ||
      session.withdrawalRevision !== operation.withdrawalRevision) refused('voice-turn-revoked');
    return operation;
  }
  function claim(context, { now = Date.now() } = {}) {
    return storage.transaction(() => {
      const session = storage.get(context.sessionId);
      const messages = context.callbackBody?.messages ?? context.messages;
      const users = messages.filter(message => message.role === 'user');
      const ordinal = context.historyUnknownReason || !users.length ||
        users.some(message => typeof message.content !== 'string' || !message.content.trim()) ? null : users.length;
      const lastUser = messages.findLastIndex(message => message.role === 'user');
      const history = lastUser < 0 ? messages : messages.slice(0, lastUser + 1);
      // Identity is only the callback body through its last user message. Keep
      // exact text, system/assistant history and provider metadata in the digest.
      // stream selects a reader representation, not another paid operation.
      const historyDigest = hash(context.callbackBody
        ? { ...context.callbackBody, messages: history, stream: undefined }
        : [history, context.historyUnknownReason ?? null]);
      const key = hash([context.sessionId, context.callId, context.providerSessionId, ordinal, historyDigest]);
      const existing = get(key);
      if (existing) {
        assertEpoch(existing);
        assertCurrent(existing);
        if (existing.state === 'pending') beforeAdmission(existing.key, existing.fence);
        return { operation: existing, claimed: false };
      }
      const id = randomUUID();
      const logical = storage.voiceLifecycle(context.sessionId, context.callId);
      const operation = { key, sessionId: context.sessionId, callId: context.callId, providerSessionId: context.providerSessionId,
        ...(logical ? { epoch: logical.epoch, controllingTabId: logical.controllingTabId } : {}),
        ordinal, historyDigest,
        // A previously unseen regressed body may be truncated. It starts its own
        // operation; only a known, unadmitted key can be refused as obsolete.
        orderingKnown: ordinal !== null && !generationOperations(context).some(other => paid(other) && other.ordinal > ordinal),
        consentRevision: session.conversationConsentRevision ?? session.consentRevision, withdrawalRevision: session.withdrawalRevision,
        state: 'pending', fence: id, createdAt: now, attempts: [{ id, startedAt: now, state: 'pending' }] };
      assertCurrent(operation);
      if (list(context.sessionId).length >= 1000) refused('voice-turn-limit');
      db.prepare('INSERT INTO voice_turn_operations VALUES (?,?,?,?,?)').run(key, context.sessionId, context.callId, context.providerSessionId, JSON.stringify(operation));
      return { operation, claimed: true };
    });
  }
  function pending(key, fence) {
    const operation = get(key);
    if (!operation || operation.fence !== fence || operation.state !== 'pending') refused('voice-turn-fenced');
    return assertCurrent(operation);
  }
  function beforeAdmission(key, fence) {
    const operation = pending(key, fence);
    assertEpoch(operation);
    if (!operation.attempts.at(-1).attemptId && operation.orderingKnown &&
      generationOperations(operation).some(other => paid(other) && other.ordinal > operation.ordinal)) refused('voice-turn-obsolete');
    return operation;
  }
  function admitted(key, fence, attemptId) {
    return storage.transaction(() => {
      const operation = beforeAdmission(key, fence), attempt = operation.attempts.at(-1);
      if (attempt.attemptId && attempt.attemptId !== attemptId) refused('voice-turn-fenced');
      attempt.attemptId = attemptId;
      save(operation);
    });
  }
  function fail(key, fence, error, now = Date.now()) {
    return storage.transaction(() => {
      const operation = get(key);
      if (!operation || operation.fence !== fence || operation.state !== 'pending') return false;
      operation.state = 'failed'; operation.error = error; operation.failedAt = now;
      Object.assign(operation.attempts.at(-1), { state: 'failed', error, endedAt: now }); save(operation);
      return true;
    });
  }
  function replace(key, fence, now) {
    return storage.transaction(() => {
      const operation = get(key);
      assertEpoch(operation);
      assertCurrent(operation);
      if (operation.fence !== fence || operation.state !== 'failed') return { operation, claimed: false };
      if (operation.attempts.length >= 8) refused('voice-turn-limit');
      const id = randomUUID();
      operation.attempts.push({ id, replaces: fence, state: 'pending', startedAt: now, authorizedAt: now });
      Object.assign(operation, { state: 'pending', fence: id }); delete operation.error;
      save(operation); return { operation, claimed: true };
    });
  }
  function complete(key, fence, reply, now, replayWindowMs) {
    return storage.transaction(() => {
      const operation = pending(key, fence), bytes = JSON.stringify(reply), contentRef = `voice-operation:${key}:${fence}`;
      db.prepare('INSERT INTO content VALUES (?,?,?,?,?,?,NULL)').run(contentRef, operation.sessionId, 'reply', bytes, hash(reply), new Date(now).toISOString());
      Object.assign(operation, { state: 'completed', completedAt: now, replayUntil: now + replayWindowMs, replyRef: contentRef });
      Object.assign(operation.attempts.at(-1), { state: 'completed', endedAt: now }); save(operation);
    });
  }
  function readReply(operation, now) {
    assertEpoch(operation);
    assertCurrent(operation);
    if (now >= operation.replayUntil) refused('voice-turn-replay-expired');
    const record = storage.getRecord(operation.sessionId, operation.replyRef);
    if (record.erased) refused('voice-turn-revoked');
    return record.data;
  }
  return { get, list, claim, pending, beforeAdmission, admitted, fail, replace, complete, readReply, assertCurrent, ownsEpoch };
}
