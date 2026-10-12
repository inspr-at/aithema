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
const knownOrdinal = value => Number.isSafeInteger(value) && value > 0;
const independent = record => record.correlationVersion === 3 && knownOrdinal(record.ordinal);
const deduplicated = operation => independent(operation) && operation.deduplicate;
// Position is established before content is checked. Equal text at another
// position can never select an operation or acquire any of its aliases.
const inputDigest = (context, ordinal, content) => hash([context.sessionId, context.callId, context.providerSessionId,
  ordinal, content.trim().replace(/\s+/gu, ' ')]);

/** Private durable operations. Reply bytes use the ordinary erasable content store. */
export function createVoiceOperationStore(storage) {
  const db = storage.db;
  let log = entry => console.log(JSON.stringify(entry));
  const diagnostic = (context, reason, fields = {}, event = 'voice.turn.correlation_ambiguous') => {
    const entry = { event, reason, callIdHash: hash([context.callId]).slice(0, 16),
      providerIdHash: hash([context.providerSessionId]).slice(0, 16), ...fields };
    try { Promise.resolve(log(entry)).catch(() => {}); } catch { /* Diagnostics cannot interrupt a paid reply. */ }
  };
  const contradiction = (context, reason) => {
    diagnostic(context, reason, {}, 'voice.turn.identity_contradiction');
    refused('voice-turn-fenced');
  };
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
  const generationOperations = context => list(context.sessionId).filter(operation =>
    operation.callId === context.callId && operation.providerSessionId === context.providerSessionId);
  const usableReceipt = receipt => independent(receipt) && !receipt.ambiguous;
  const receiptsThrough = records => {
    const positions = new Set(records.filter(usableReceipt).map(receipt => receipt.ordinal));
    let ordinal = 0;
    while (positions.has(ordinal + 1)) ordinal++;
    return ordinal;
  };
  function bind(operation, receipt) {
    // All checks precede all writes. A collision leaves the paid operation intact.
    if (!deduplicated(operation) || !usableReceipt(receipt) || operation.ordinal !== receipt.ordinal ||
      operation.inputDigest !== receipt.inputDigest || !consistent(operation.providerIdentity, receipt.providerIdentity) ||
      operation.canonical && operation.turnId !== receipt.turnId || receipt.operationKey && receipt.operationKey !== operation.key) {
      saveReceipt(operation, { ...receipt, ambiguous: true });
      diagnostic(operation, 'receipt-conflict', { ordinal: receipt.ordinal }); return false;
    }
    const identities = [...new Set([...(operation.providerIdentity ?? []), ...(receipt.providerIdentity ?? [])])];
    const aliases = [`canonical:${receipt.turnId}`, ...identities.map(providerAlias)];
    if (aliases.some(identity => alias(operation, identity) && alias(operation, identity) !== operation.key)) {
      saveReceipt(operation, { ...receipt, ambiguous: true });
      diagnostic(operation, 'multiple-candidates', { ordinal: receipt.ordinal }); return false;
    }
    Object.assign(operation, { turnId: receipt.turnId, canonical: true, providerIdentity: identities });
    save(operation);
    for (const identity of aliases) link(operation, identity, operation.key);
    saveReceipt(operation, { ...receipt, operationKey: operation.key });
    return true;
  }

  function assertCurrent(operation) {
    // Publication checks need identities/revisions, never a hydrated prompt per token.
    const session = JSON.parse(db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(operation.sessionId).snapshot);
    if (session.tombstone || session.consentWithdrawn || session.paused ||
      (session.conversationConsentRevision ?? session.consentRevision) !== operation.consentRevision ||
      session.withdrawalRevision !== operation.withdrawalRevision) refused('voice-turn-revoked');
    const turn = session.transcript.find(t => t.id === operation.turnId);
    if (turn?.erased || turn?.withdrawn) refused('voice-turn-obsolete');
    if (deduplicated(operation) && db.prepare(`SELECT 1 FROM voice_turn_operations WHERE session_id=? AND call_id=? AND provider_id=?
      AND json_extract(record,'$.correlationVersion')=3 AND json_extract(record,'$.deduplicate')=1
      AND json_extract(record,'$.ordinal')>? LIMIT 1`).get(operation.sessionId, operation.callId, operation.providerSessionId, operation.ordinal)) refused('voice-turn-obsolete');
    const records = receipts(operation);
    if (deduplicated(operation) && receiptsThrough(records) > operation.ordinal) refused('voice-turn-obsolete');
    if (operation.canonical || operation.attempts.at(-1).attemptId) {
      const users = session.transcript.filter(t => t.role === 'user');
      const position = operation.afterTurnId === null ? -1 : users.findIndex(t => t.id === operation.afterTurnId);
      if (operation.afterTurnId !== null && position < 0) refused('voice-turn-obsolete');
      for (const later of users.slice(position + 1)) {
        // Final delivery order has no bearing on user order. Unknown or gapped
        // voice receipts never invalidate admitted work. Typed input retains
        // its ordinary revision protection, including explicit typed echoes.
        if (records.some(receipt => receipt.turnId === later.id) ||
          later.callId === operation.callId && later.providerSessionId === operation.providerSessionId) continue;
        if (later.id !== operation.turnId) refused('voice-turn-obsolete');
      }
    }
    return operation;
  }
  function claim(context, { now = Date.now() } = {}) {
    return storage.transaction(() => {
      const session = storage.get(context.sessionId), candidates = generationOperations(context), records = receipts(context);
      const users = context.messages.filter(message => message.role === 'user');
      let reason = context.historyUnknownReason ?? (users.some(message => typeof message.content !== 'string') ? 'null-user'
        : users.some(message => !message.content.trim()) ? 'empty-user' : !users.length ? 'no-user' : undefined);
      const ordinal = reason ? null : users.length;
      const historyDigests = reason ? [] : users.map((message, index) => inputDigest(context, index + 1, message.content));
      const firstUser = context.messages.findIndex(message => message.role === 'user');
      const historyStartDigest = hash(context.messages.slice(0, Math.max(0, firstUser)));
      // Persisted prefix evidence detects shortened/replaced histories across
      // restart. Assistant corrections and optional IDs do not change position.
      if (!reason && candidates.some(operation => deduplicated(operation) &&
        (operation.historyStartDigest !== historyStartDigest || operation.ordinal <= ordinal &&
          operation.inputDigest !== historyDigests[operation.ordinal - 1]))) reason = 'history-discontinuity';
      if (!reason) {
        const predecessors = new Set([...candidates.filter(deduplicated).map(operation => operation.ordinal),
          ...records.filter(usableReceipt).map(receipt => receipt.ordinal)]);
        if (historyDigests.slice(0, -1).some((_, index) => !predecessors.has(index + 1))) reason = 'missing-predecessors';
      }
      const providerIdentity = context.turnIdentity;
      if (!consistent(providerIdentity, providerIdentity)) contradiction(context, 'invalid-provider-identity');
      const identities = (providerIdentity ?? []).map(providerAlias);
      const keys = new Set(identities.map(identity => alias(context, identity)).filter(Boolean));
      let operation, receipt;
      if (!reason) {
        const slots = candidates.filter(operation => deduplicated(operation) && operation.ordinal === ordinal);
        const positional = records.filter(receipt => independent(receipt) && receipt.ordinal === ordinal);
        if (keys.size > 1 || slots.length > 1) reason = 'multiple-candidates';
        else if ([...keys].some(key => !deduplicated(get(key)))) reason = 'legacy-operation';
        else if ([...keys].some(key => get(key).ordinal !== ordinal)) contradiction(context, 'provider-ordinal-conflict');
        else if (slots[0] && !consistent(slots[0].providerIdentity, providerIdentity)) contradiction(context, 'provider-namespace-conflict');
        else if (positional.length > 1 || positional.some(receipt => receipt.ambiguous)) reason = 'multiple-receipts';
        else if (positional[0] && positional[0].inputDigest !== historyDigests.at(-1)) reason = 'ordinal-input-mismatch';
        else if (positional[0] && !consistent(positional[0].providerIdentity, providerIdentity)) {
          // Shared provider metadata proves a contradiction; otherwise the
          // unmatched final cannot capture or fence a paid slot.
          if (overlaps(providerIdentity, positional[0].providerIdentity)) contradiction(context, 'receipt-namespace-conflict');
          reason = 'receipt-conflict';
        } else receipt = positional[0];
        if (!reason) operation = slots[0];
        if (!reason && alias(context, `slot:${ordinal}`) && !operation) reason = 'legacy-operation';
      }
      const verifiedOrdinal = ['history-discontinuity', 'missing-predecessors'].includes(reason) ? null : ordinal;
      if (reason) { diagnostic(context, reason, { ordinal: verifiedOrdinal }); operation = undefined; receipt = undefined; }
      if (operation) {
        assertCurrent(operation);
        // Namespace conflicts were checked above, before any alias is attached.
        operation.providerIdentity = [...new Set([...(operation.providerIdentity ?? []), ...(providerIdentity ?? [])])];
        save(operation);
        for (const identity of identities) link(context, identity, operation.key);
        if (receipt) bind(operation, receipt);
        return { operation, claimed: false };
      }
      const id = randomUUID(), deduplicate = !reason;
      const key = hash([context.sessionId, context.callId, context.providerSessionId, deduplicate ? ['ordinal', ordinal] : ['independent', id]]);
      operation = { key, sessionId: context.sessionId, callId: context.callId, providerSessionId: context.providerSessionId,
        turnId: `${context.providerSessionId}:user:operation-${key}`, canonical: false,
        correlationVersion: 3, deduplicate, ordinal: verifiedOrdinal,
        providerIdentity, historyStartDigest: deduplicate ? historyStartDigest : null,
        inputDigest: deduplicate ? historyDigests.at(-1) : null, ...(reason ? { correlationReason: reason } : {}),
        afterTurnId: latestUser(session)?.id ?? null,
        consentRevision: session.conversationConsentRevision ?? session.consentRevision, withdrawalRevision: session.withdrawalRevision,
        state: 'pending', fence: id, createdAt: now, attempts: [{ id, startedAt: now, state: 'pending' }] };
      assertCurrent(operation);
      if (list(context.sessionId).length >= 1000) refused('voice-turn-limit');
      db.prepare('INSERT INTO voice_turn_operations VALUES (?,?,?,?,?)').run(key, context.sessionId, context.callId, context.providerSessionId, JSON.stringify(operation));
      if (deduplicate) {
        link(context, `slot:${ordinal}`, key);
        for (const identity of identities) link(context, identity, key);
        if (receipt) bind(operation, receipt);
      }
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
    const ordinal = knownOrdinal(context.event.userTurnOrdinal) ? context.event.userTurnOrdinal : null;
    const providerIdentity = voiceTurnIdentities(context.event);
    const receipt = { id: context.event.turnId, turnId: turn.id, ordinal, correlationVersion: 3, providerIdentity,
      inputDigest: ordinal === null ? null : inputDigest(context, ordinal, turn.content) };
    const records = receipts(context), slots = generationOperations(context).filter(operation => deduplicated(operation) && operation.ordinal === ordinal);
    if (ordinal === null) {
      receipt.ambiguous = true;
      diagnostic(context, 'unknown-receipt', { ordinal });
    } else if (records.some(record => independent(record) && record.ordinal === ordinal && record.id !== receipt.id) || slots.length > 1) {
      receipt.ambiguous = true;
      // Do not remove or reassign an earlier operation's canonical identity.
      for (const record of records.filter(record => independent(record) && record.ordinal === ordinal)) saveReceipt(context, { ...record, ambiguous: true });
      diagnostic(context, slots.length > 1 ? 'multiple-candidates' : 'multiple-receipts', { ordinal });
    } else if (slots[0] && (slots[0].inputDigest !== receipt.inputDigest || !consistent(slots[0].providerIdentity, providerIdentity))) {
      receipt.ambiguous = true;
      diagnostic(context, 'receipt-conflict', { ordinal });
    }
    saveReceipt(context, receipt);
    if (usableReceipt(receipt) && receiptsThrough([...records, receipt]) < ordinal) diagnostic(context, 'missing-predecessors', { ordinal });
    if (slots.length === 1 && usableReceipt(receipt)) bind(slots[0], receipt);
  }
  return { get, list, claim, pending, admitted, fail, replace, complete, readReply, assertCurrent, bindTurn,
    setLogger(logger) { if (logger !== undefined) log = logger; } };
}
