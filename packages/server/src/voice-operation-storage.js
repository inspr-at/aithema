import { createHash, randomUUID } from 'node:crypto';
import { PluginError } from '@inspr/aithema-core';
import { voiceTurnIdentities } from '../../core/src/live-voice.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refused = reason => { throw new PluginError('not-admitted', reason); };
const latestUser = session => session.transcript.findLast(turn => turn.role === 'user');
const namespace = identity => identity.slice(0, identity.indexOf(':'));
const overlaps = (a, b) => a?.some(identity => b?.includes(identity));
const consistent = (a = [], b = []) => [...a, ...b].every(identity => /^(?:message|event|turn):.+$/su.test(identity)) &&
  a.every(identity => !b.some(other => namespace(identity) === namespace(other) && identity !== other));
const providerAlias = identity => `provider:${JSON.stringify(identity)}`;
// Receipt correlation is confined to a call's admitted sequence. This digest
// never supplies an operation key or deduplicates equal text in another slot.
const inputDigest = (context, content) => hash([context.sessionId, context.callId, context.providerSessionId,
  content.trim().replace(/\s+/gu, ' ')]);

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
    CREATE INDEX IF NOT EXISTS voice_turn_generation ON voice_turn_operations(session_id, call_id, provider_id);
    CREATE TABLE IF NOT EXISTS voice_turn_receipts (
    session_id TEXT NOT NULL REFERENCES sessions(id), call_id TEXT NOT NULL, provider_id TEXT NOT NULL,
    receipt_id TEXT NOT NULL, record TEXT NOT NULL,
    PRIMARY KEY(session_id, call_id, provider_id, receipt_id));`);
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
  const link = (context, identity, key) => {
    const existing = alias(context, identity);
    if (existing && existing !== key) refused('voice-turn-fenced');
    db.prepare('INSERT INTO voice_turn_aliases VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(context.sessionId, context.callId, context.providerSessionId, identity, key);
  };
  const receipts = context => db.prepare(`SELECT record FROM voice_turn_receipts
    WHERE session_id=? AND call_id=? AND provider_id=? ORDER BY rowid`)
    .all(context.sessionId, context.callId, context.providerSessionId).map(row => JSON.parse(row.record));
  const saveReceipt = (context, receipt) => db.prepare(`INSERT INTO voice_turn_receipts VALUES (?,?,?,?,?)
    ON CONFLICT(session_id,call_id,provider_id,receipt_id) DO UPDATE SET record=excluded.record`)
    .run(context.sessionId, context.callId, context.providerSessionId, receipt.id, JSON.stringify(receipt));
  const predecessorTurnId = operation => {
    const predecessor = get(operation.afterOperationKey);
    return predecessor?.canonical ? predecessor.turnId : operation.afterTurnId;
  };
  function bind(operation, receipt) {
    if (!consistent(operation.providerIdentity, receipt.providerIdentity) ||
      operation.canonical && operation.turnId !== receipt.turnId) refused('voice-turn-fenced');
    Object.assign(operation, { turnId: receipt.turnId, canonical: true,
      providerIdentity: [...new Set([...(operation.providerIdentity ?? []), ...(receipt.providerIdentity ?? [])])] });
    save(operation);
    link(operation, `canonical:${receipt.turnId}`, operation.key);
    for (const identity of operation.providerIdentity) link(operation, providerAlias(identity), operation.key);
    saveReceipt(operation, { ...receipt, ordinal: operation.ordinal, operationKey: operation.key });
  }

  function assertCurrent(operation) {
    // Publication checks need identities/revisions, never a hydrated prompt per token.
    const session = JSON.parse(db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(operation.sessionId).snapshot);
    if (session.tombstone || session.consentWithdrawn || session.paused ||
      (session.conversationConsentRevision ?? session.consentRevision) !== operation.consentRevision ||
      session.withdrawalRevision !== operation.withdrawalRevision) refused('voice-turn-revoked');
    const turn = session.transcript.find(t => t.id === operation.turnId);
    if (turn?.erased || turn?.withdrawn) refused('voice-turn-obsolete');
    if (db.prepare(`SELECT 1 FROM voice_turn_operations WHERE session_id=? AND call_id=? AND provider_id=?
      AND json_extract(record,'$.ordinal')>? LIMIT 1`).get(operation.sessionId, operation.callId, operation.providerSessionId, operation.ordinal)) refused('voice-turn-obsolete');
    if (operation.canonical || operation.attempts.at(-1).attemptId) {
      const users = session.transcript.filter(t => t.role === 'user');
      const anchor = operation.canonical ? operation.turnId : operation.afterTurnId;
      const position = anchor === null ? -1 : users.findIndex(t => t.id === anchor);
      if (anchor !== null && position < 0) refused('voice-turn-obsolete');
      for (const later of users.slice(position + 1)) {
        // A receipt for a known predecessor can arrive after paid work starts,
        // or even after this operation's receipt. Its arrival is not a new turn.
        const predecessor = get(alias(operation, `canonical:${later.id}`));
        if (!predecessor || predecessor.ordinal >= operation.ordinal) refused('voice-turn-obsolete');
      }
    }
    return operation;
  }
  function claim(context, { now = Date.now() } = {}) {
    return storage.transaction(() => {
      const session = storage.get(context.sessionId);
      const users = context.messages.filter(message => message.role === 'user');
      const ordinal = users.length;
      // Full provider user history supplies position until its canonical final
      // arrives. Assistant text/counts never create another user operation.
      const slot = `slot:${ordinal}`;
      const providerIdentity = context.turnIdentity;
      if (!consistent(providerIdentity, providerIdentity)) refused('voice-turn-fenced');
      const records = receipts(context);
      const matching = records.filter(receipt => overlaps(providerIdentity, receipt.providerIdentity));
      if (matching.length > 1) refused('voice-turn-fenced');
      const recorded = records.find(receipt => receipt.turnId === context.recordedTurnId);
      const positional = records.find(receipt => receipt.ordinal === ordinal);
      const digest = users.length ? inputDigest(context, users.at(-1).content) : undefined;
      const unbound = records.filter(receipt => digest !== undefined && !receipt.operationKey && receipt.inputDigest === digest &&
        consistent(providerIdentity, receipt.providerIdentity));
      // A bound receipt's ordinal is admission order, never receipt-arrival
      // position. An unbound final can be located within the callback's slot.
      const receipt = matching[0] ?? (positional && consistent(providerIdentity, positional.providerIdentity) ? positional : undefined)
        ?? (recorded && (recorded.ordinal === undefined || recorded.ordinal === ordinal) &&
          consistent(providerIdentity, recorded.providerIdentity) ? recorded : undefined)
        ?? (unbound.length === 1 ? unbound[0] : undefined);
      if (receipt && !consistent(providerIdentity, receipt.providerIdentity)) refused('voice-turn-fenced');
      const turnId = receipt?.turnId ?? (!recorded ? context.recordedTurnId : undefined);
      const identities = providerIdentity?.map(providerAlias);
      const reservedTurnId = `${context.providerSessionId}:user:operation-${hash([context.sessionId, context.callId, context.providerSessionId, slot])}`;
      const identity = identities?.[0] ?? `canonical:${turnId ?? reservedTurnId}`;
      // Optional provider metadata can appear/disappear on retry. Each stable id
      // is an alias, rather than a different combination defining a new turn.
      const keys = new Set((identities ?? [identity]).map(identity => alias(context, identity)).filter(Boolean));
      if (keys.size > 1) refused('voice-turn-fenced');
      let key = [...keys][0];
      const candidate = get(alias(context, slot));
      if (candidate?.canonical && turnId && candidate.turnId !== turnId) refused('voice-turn-obsolete');
      // A provisional slot and its canonical transcript receipt identify the same operation.
      if (!key && turnId) key = alias(context, `canonical:${turnId}`);
      if (!key && candidate) key = candidate.key;
      if (key && candidate && candidate.key !== key) refused('voice-turn-fenced');
      let operation = key && get(key);
      if (operation) {
        if (operation.ordinal !== ordinal || !consistent(operation.providerIdentity, providerIdentity)) refused('voice-turn-fenced');
        if (operation.canonical && turnId && operation.turnId !== turnId) refused('voice-turn-obsolete');
        if (providerIdentity) {
          operation.providerIdentity = [...new Set([...(operation.providerIdentity ?? []), ...providerIdentity])]; save(operation);
        }
        if (receipt) bind(operation, receipt);
        else if (turnId && !operation.canonical) { operation = { ...operation, turnId, canonical: true }; save(operation); }
        assertCurrent(operation);
        for (const aliasIdentity of identities ?? [identity]) link(context, aliasIdentity, operation.key);
        if (turnId) link(context, `canonical:${turnId}`, operation.key);
        return { operation, claimed: false };
      }
      const id = randomUUID();
      key = hash([context.sessionId, context.callId, context.providerSessionId, identity]);
      operation = { key, sessionId: context.sessionId, callId: context.callId, providerSessionId: context.providerSessionId,
        turnId: turnId ?? reservedTurnId,
        canonical: Boolean(turnId), ordinal, providerIdentity, inputDigest: digest,
        afterTurnId: latestUser(session)?.id ?? null,
        afterOperationKey: list(context.sessionId).filter(op => op.callId === context.callId &&
          op.providerSessionId === context.providerSessionId && op.ordinal < ordinal).at(-1)?.key ?? null,
        consentRevision: session.conversationConsentRevision ?? session.consentRevision, withdrawalRevision: session.withdrawalRevision,
        state: 'pending', fence: id, createdAt: now, attempts: [{ id, startedAt: now, state: 'pending' }] };
      assertCurrent(operation);
      if (list(context.sessionId).length >= 1000) refused('voice-turn-limit');
      db.prepare('INSERT INTO voice_turn_operations VALUES (?,?,?,?,?)').run(key, context.sessionId, context.callId, context.providerSessionId, JSON.stringify(operation));
      for (const aliasIdentity of identities ?? [identity]) link(context, aliasIdentity, key);
      link(context, slot, key);
      if (turnId) link(context, `canonical:${turnId}`, key);
      if (receipt) bind(operation, receipt);
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
    const session = storage.get(context.sessionId);
    const previous = session.transcript.filter(t => t.role === 'user' && t.id !== turn.id).at(-1)?.id ?? null;
    const receiptId = context.event.turnId;
    const providerIdentity = voiceTurnIdentities(context.event) ?? [`event:${receiptId.slice(`${context.providerSessionId}:user:`.length)}`];
    const receipt = { id: receiptId, turnId: turn.id, providerIdentity,
      inputDigest: inputDigest(context, turn.content) };
    const candidates = list(context.sessionId).filter(op => op.callId === context.callId && op.providerSessionId === context.providerSessionId &&
      consistent(op.providerIdentity, providerIdentity) && (!op.canonical || op.turnId === turn.id));
    const exact = candidates.filter(op => overlaps(op.providerIdentity, providerIdentity));
    const byInput = candidates.filter(op => op.inputDigest === receipt.inputDigest);
    // Typed echoes point at the original typed turn, not its predecessor.
    // Receipts may arrive in either order. Locate an admitted slot by its input,
    // then resolve its predecessor through the durable operation chain. Binding
    // A later changes B's predecessor's canonical ID, never B's admitted order.
    const anchored = (byInput.length ? byInput : candidates.filter(op => op.inputDigest === undefined)).filter(op =>
      !op.canonical && predecessorTurnId(op) === (context.typedEcho ? turn.id : previous));
    const operation = exact.length === 1 ? exact[0] : exact.length ? undefined
      : byInput.length === 1 ? byInput[0] : anchored.length === 1 ? anchored[0] : undefined;
    if (operation) bind(operation, receipt);
    else saveReceipt(context, receipt);
  }
  return { get, list, claim, pending, admitted, fail, replace, complete, readReply, assertCurrent, bindTurn };
}
