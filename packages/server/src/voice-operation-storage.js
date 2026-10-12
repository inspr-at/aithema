import { createHash, randomUUID } from 'node:crypto';
import { PluginError } from '@inspr/aithema-core';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refused = reason => { throw new PluginError('not-admitted', reason); };
const latestUser = session => session.transcript.findLast(turn => turn.role === 'user');

/** Private durable operations. Reply bytes use the ordinary erasable content store. */
export function createVoiceOperationStore(storage) {
  const db = storage.db;
  db.exec(`CREATE TABLE IF NOT EXISTS voice_turn_operations (
    operation_key TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    call_id TEXT NOT NULL, provider_id TEXT NOT NULL, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS voice_turn_aliases (
    session_id TEXT NOT NULL REFERENCES sessions(id), call_id TEXT NOT NULL, provider_id TEXT NOT NULL,
    identity TEXT NOT NULL, operation_key TEXT NOT NULL REFERENCES voice_turn_operations(operation_key),
    PRIMARY KEY(session_id, call_id, provider_id, identity));
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
  const alias = (context, identity) => db.prepare(`SELECT operation_key FROM voice_turn_aliases
    WHERE session_id=? AND call_id=? AND provider_id=? AND identity=?`)
    .get(context.sessionId, context.callId, context.providerSessionId, identity)?.operation_key;
  const link = (context, identity, key) => db.prepare('INSERT INTO voice_turn_aliases VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING')
    .run(context.sessionId, context.callId, context.providerSessionId, identity, key);

  function assertCurrent(operation) {
    // Publication checks need identities/revisions, never a hydrated prompt per token.
    const session = JSON.parse(db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(operation.sessionId).snapshot);
    if (session.tombstone || session.consentWithdrawn || session.paused ||
      (session.conversationConsentRevision ?? session.consentRevision) !== operation.consentRevision ||
      session.withdrawalRevision !== operation.withdrawalRevision) refused('voice-turn-revoked');
    const turn = session.transcript.find(t => t.id === operation.turnId);
    if (turn?.erased || turn?.withdrawn) refused('voice-turn-obsolete');
    if (operation.canonical && latestUser(session)?.id !== operation.turnId) refused('voice-turn-obsolete');
    if (!operation.canonical && operation.attempts.at(-1).attemptId && (latestUser(session)?.id ?? null) !== operation.afterTurnId) refused('voice-turn-obsolete');
    if (db.prepare(`SELECT 1 FROM voice_turn_operations WHERE session_id=? AND call_id=? AND provider_id=?
      AND json_extract(record,'$.ordinal')>? LIMIT 1`).get(operation.sessionId, operation.callId, operation.providerSessionId, operation.ordinal)) refused('voice-turn-obsolete');
    return operation;
  }
  function claim(context, { now = Date.now() } = {}) {
    return storage.transaction(() => {
      const session = storage.get(context.sessionId);
      const users = context.messages.filter(message => message.role === 'user');
      const ordinal = users.length;
      const slot = `slot:${ordinal}:${context.messages.filter(message => message.role === 'assistant').length}`;
      const providerIdentity = context.turnIdentity;
      const providerTurn = providerIdentity && session.transcript.find(t => t.role === 'user' &&
        t.callId === context.callId && t.providerSessionId === context.providerSessionId &&
        providerIdentity.some(identity => t.id === identity || t.id === `${context.providerSessionId}:user:${identity}`));
      const turnId = providerTurn?.id ?? context.recordedTurnId;
      const identities = providerIdentity?.map(identity => `provider:${JSON.stringify(identity)}`);
      const identity = identities?.[0] ?? (turnId ? `canonical:${turnId}` : slot);
      // Optional provider metadata can appear/disappear on retry. Each stable id
      // is an alias, rather than a different combination defining a new turn.
      const keys = new Set((identities ?? [identity]).map(identity => alias(context, identity)).filter(Boolean));
      if (keys.size > 1) refused('voice-turn-fenced');
      let key = [...keys][0];
      const candidate = !providerIdentity && get(alias(context, slot));
      if (candidate?.canonical && turnId && candidate.turnId !== turnId) refused('voice-turn-obsolete');
      const speech = session.transcript.filter(t => t.role === 'user' && t.callId === context.callId && t.providerSessionId === context.providerSessionId);
      if (!providerIdentity && ordinal && ordinal < speech.length) refused('voice-turn-obsolete');
      // A provisional slot and its canonical transcript receipt identify the same operation.
      if (!key && turnId) key = alias(context, `canonical:${turnId}`);
      if (!key && !providerIdentity) {
        if (candidate && (!turnId || !candidate.canonical || candidate.turnId === turnId)) key = candidate.key;
      }
      let operation = key && get(key);
      if (operation) {
        if (turnId && !operation.canonical) { operation = { ...operation, turnId, canonical: true }; save(operation); }
        if (providerIdentity) {
          operation.providerIdentity = [...new Set([...(operation.providerIdentity ?? []), ...providerIdentity])]; save(operation);
        }
        assertCurrent(operation);
        for (const aliasIdentity of identities ?? [identity]) link(context, aliasIdentity, operation.key);
        if (turnId) link(context, `canonical:${turnId}`, operation.key);
        return { operation, claimed: false };
      }
      const id = randomUUID();
      key = hash([context.sessionId, context.callId, context.providerSessionId, identity]);
      operation = { key, sessionId: context.sessionId, callId: context.callId, providerSessionId: context.providerSessionId,
        turnId: turnId ?? (providerIdentity ? `${context.providerSessionId}:user:${providerIdentity[0]}` : `${context.providerSessionId}:user:operation-${key}`),
        canonical: Boolean(turnId), ordinal, providerIdentity, afterTurnId: latestUser(session)?.id ?? null,
        consentRevision: session.conversationConsentRevision ?? session.consentRevision, withdrawalRevision: session.withdrawalRevision,
        state: 'pending', fence: id, createdAt: now, attempts: [{ id, startedAt: now, state: 'pending' }] };
      assertCurrent(operation);
      if (list(context.sessionId).length >= 1000) refused('voice-turn-limit');
      db.prepare('INSERT INTO voice_turn_operations VALUES (?,?,?,?,?)').run(key, context.sessionId, context.callId, context.providerSessionId, JSON.stringify(operation));
      for (const aliasIdentity of identities ?? [identity]) link(context, aliasIdentity, key);
      link(context, slot, key);
      if (turnId) link(context, `canonical:${turnId}`, key);
      return { operation, claimed: true };
    });
  }
  function pending(key, fence) {
    const operation = get(key);
    if (!operation || operation.fence !== fence || operation.state !== 'pending') refused('voice-turn-fenced');
    return assertCurrent(operation);
  }
  function admitted(key, fence, attemptId) {
    return storage.transaction(() => {
      const operation = pending(key, fence), session = storage.get(operation.sessionId);
      const attempt = operation.attempts.at(-1);
      if (attempt.attemptId && attempt.attemptId !== attemptId) refused('voice-turn-fenced');
      attempt.attemptId = attemptId;
      // An unpersisted voice turn may incorporate typed input arriving during admission.
      if (!operation.canonical) operation.afterTurnId = latestUser(session)?.id ?? null;
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
    assertCurrent(operation);
    if (now >= operation.replayUntil) refused('voice-turn-replay-expired');
    const record = storage.getRecord(operation.sessionId, operation.replyRef);
    if (record.erased) refused('voice-turn-revoked');
    return record.data;
  }
  // Called inside the final-event transaction, including a typed echo receipt.
  function bindTurn(context, turn) {
    if (turn.role !== 'user') return;
    const session = storage.get(context.sessionId), previous = session.transcript.filter(t => t.role === 'user' && t.id !== turn.id).at(-1)?.id ?? null;
    const speech = session.transcript.filter(t => t.role === 'user' && t.callId === context.callId && t.providerSessionId === context.providerSessionId);
    const candidates = list(context.sessionId).filter(op => op.callId === context.callId && op.providerSessionId === context.providerSessionId && !op.canonical);
    const operation = candidates.find(op => op.providerIdentity?.some(identity => turn.id === identity || turn.id === `${context.providerSessionId}:user:${identity}`))
      ?? candidates.find(op => op.ordinal === speech.length && op.afterTurnId === previous)
      ?? candidates.findLast(op => op.afterTurnId === previous);
    if (!operation) return;
    operation.turnId = turn.id; operation.canonical = true; save(operation);
    link(context, `canonical:${turn.id}`, operation.key);
  }
  return { get, list, claim, pending, admitted, fail, replace, complete, readReply, assertCurrent, bindTurn };
}
