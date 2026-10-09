import { hostPortKit } from './host-port-kit.js';
export const HANDOVER_REVISION_LIMIT = 100;
const textId = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
export function handoverKey(sessionId, revision) {
  if (!textId(sessionId) || !textId(revision)) throw new TypeError('Invalid handover identity');
  return JSON.stringify([sessionId, revision]);
}
export function assertHandoverPort(port) {
  if (typeof port?.deliver !== 'function') throw new TypeError('Handover delivery missing');
  return port;
}
export function createHandover({ sessionId } = {}) {
  if (!textId(sessionId)) throw new TypeError('Handover session required');
  return { sessionId, status: 'idle', revision: null, attempts: [] };
}
export function handoverView(state) {
  const attempt = state.attempts.find(a => a.revision === state.revision);
  return { sessionId: state.sessionId, status: state.status, revision: state.revision,
    attempt: attempt?.attempt ?? 0, idempotencyKey: attempt?.idempotencyKey ?? null,
    receiptId: attempt?.receiptId ?? null, error: attempt?.error ?? null, canRetry: state.status === 'failed' };
}

/** Returns {state, events, delivery}. Persist preparing before invoking the
 * host; feed the host's result back with the exact revision and attempt.
 * Delivery payloads/offer policy never enter the state or its public events. */
export function reduceHandover(state, event) {
  if (!event) throw new TypeError('Handover event required');
  const next = structuredClone(state);
  let delivery = null;
  switch (event.type) {
    case 'request':
    case 'retry': {
      const key = handoverKey(state.sessionId, event.revision);
      let attempt = next.attempts.find(a => a.revision === event.revision);
      if (next.status === 'preparing' || attempt?.status === 'sent' ||
          event.type === 'request' && attempt ||
          event.type === 'retry' && (attempt?.status !== 'failed' || event.revision !== next.revision)) {
        return { state, events: [], delivery: null };
      }
      if (!attempt) {
        // Keep all retained keys: evicting an old receipt would make its next
        // request look new and permit stale delivery. Hosts own archival policy.
        if (next.attempts.length >= HANDOVER_REVISION_LIMIT) {
          return { state, events: [{ type: 'handover.limit-reached', data: {
            reason: 'revision-limit', limit: HANDOVER_REVISION_LIMIT } }], delivery: null };
        }
        attempt = { revision: event.revision, idempotencyKey: key, attempt: 0, status: 'idle', receiptId: null, error: null };
        next.attempts.push(attempt);
      }
      attempt.attempt += 1; attempt.status = 'preparing'; attempt.error = null;
      next.revision = event.revision; next.status = 'preparing';
      delivery = { sessionId: next.sessionId, revision: event.revision, idempotencyKey: key, attempt: attempt.attempt };
      break;
    }
    case 'result': {
      if (!['sent', 'failed'].includes(event.status)) throw new TypeError('Invalid handover result');
      const attempt = next.attempts.find(a => a.revision === event.revision);
      if (!attempt || attempt.status !== 'preparing' || event.attempt !== attempt.attempt || next.revision !== event.revision) {
        return { state, events: [], delivery: null };
      }
      if (event.status === 'sent' && !textId(event.receiptId)) throw new TypeError('Handover receipt required');
      attempt.status = event.status; next.status = event.status;
      attempt.receiptId = event.status === 'sent' ? event.receiptId : null;
      attempt.error = event.status === 'failed' ? 'delivery-failed' : null;
      break;
    }
    case 'recover':
      // A restarted host retries an interrupted delivery with the SAME key.
      // The destination may have accepted it before the process stopped.
      if (next.status !== 'preparing') return { state, events: [], delivery: null };
      next.status = 'failed';
      Object.assign(next.attempts.find(a => a.revision === next.revision), { status: 'failed', error: 'delivery-interrupted' });
      break;
    default: throw new TypeError('Unknown handover event');
  }
  return { state: next, events: [{ type: 'handover.state', data: handoverView(next) }], delivery };
}

/** Host deliver({sessionId,revision,idempotencyKey,attempt}) ->
 * {status:'sent',receiptId}. Resolve only after confirmed host-owned delivery;
 * reject on failure. Persist idempotency receipts across restarts in real hosts.
 * A host must reject a key reused for another session/revision. */
export function createFakeHandoverHost() {
  const receipts = new Map();
  let failures = 0, count = 0;
  return { failNext() { failures += 1; }, deliveryCount: () => count,
    port: { async deliver(request) {
      if (!request || request.idempotencyKey !== handoverKey(request.sessionId, request.revision)) throw new TypeError('Handover key conflict');
      const previous = receipts.get(request.idempotencyKey);
      if (previous) return structuredClone(previous);
      count += 1;
      if (failures > 0) { failures -= 1; throw new Error('Fake delivery failed'); }
      const receipt = { status: 'sent', receiptId: `delivery-${count}` };
      receipts.set(request.idempotencyKey, receipt);
      return structuredClone(receipt);
    } }
  };
}

/** Local fixture only. failNext must cause one actual delivery failure and
 * deliveryCount must independently count actual delivery attempts (not reads). */
export async function handoverConformance(port, { failNext, deliveryCount, timeoutMs = 1000 } = {}) {
  const kit = hostPortKit(timeoutMs), { check, run } = kit;
  try { assertHandoverPort(port); } catch { check(false, 'handover delivery missing'); return kit.result(); }
  if (typeof failNext !== 'function' || typeof deliveryCount !== 'function') {
    check(false, 'handover fixture controls missing'); return kit.result();
  }
  const request = { sessionId: 'kit-session', revision: 'r1', idempotencyKey: handoverKey('kit-session', 'r1'), attempt: 1 };
  const before = await run('delivery counter failed', () => deliveryCount());
  const sent = await run('delivery failed', () => port.deliver(request));
  check(sent?.status === 'sent' && textId(sent.receiptId), 'confirmed delivery receipt');
  const duplicates = await run('duplicate delivery failed', () => Promise.all([port.deliver(request), port.deliver(request)]));
  check(duplicates?.every(r => r?.status === 'sent' && r.receiptId === sent?.receiptId), 'stable duplicate receipts');
  check(await run('dedup counter failed', () => deliveryCount()) === before + 1, 'one delivery per revision');
  await run('key conflict check failed', async () => {
    try { await port.deliver({ ...request, revision: 'different' }); check(false, 'conflicting key accepted'); } catch { /* required rejection */ }
  });
  check(await run('conflict counter failed', () => deliveryCount()) === before + 1, 'conflicting key delivered');
  const retry = { ...request, revision: 'r2', idempotencyKey: handoverKey(request.sessionId, 'r2') };
  await run('failure injection failed', () => failNext());
  await run('failure check failed', async () => {
    try { await port.deliver(retry); check(false, 'failed delivery claimed sent'); } catch { /* failure must remain retryable */ }
  });
  const recovered = await run('delivery retry failed', () => port.deliver({ ...retry, attempt: 2 }));
  check(recovered?.status === 'sent' && textId(recovered.receiptId) && recovered.receiptId !== sent?.receiptId, 'retry confirmed with a new revision receipt');
  const final = await run('retry duplicate failed', () => port.deliver({ ...retry, attempt: 3 }));
  check(final?.receiptId === recovered?.receiptId && await run('retry counter failed', () => deliveryCount()) === before + 3, 'retry keeps idempotency');
  const concurrent = { ...request, revision: 'r3', idempotencyKey: handoverKey(request.sessionId, 'r3') };
  const parallel = await run('concurrent delivery failed', () => Promise.all([port.deliver(concurrent), port.deliver(concurrent)]));
  check(parallel?.length === 2 && parallel.every(r => r?.status === 'sent' && textId(r.receiptId)) &&
    parallel[0].receiptId === parallel[1].receiptId && await run('concurrent counter failed', () => deliveryCount()) === before + 4,
  'concurrent delivery deduplication');
  return kit.result();
}
