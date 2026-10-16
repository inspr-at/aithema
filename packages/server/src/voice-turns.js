import { PluginError, PLUGIN_ERROR_CODES } from '@inspr/aithema-core/invocation';
import { voiceOperation } from '@inspr/aithema-core/live-voice';
import { createVoiceDiagnostics, voiceReconciliationAge } from './voice-observability.js';

export const DEFAULT_VOICE_TURN_REPLAY_MS = 120_000;
const MAX_CLOSURE_DIAGNOSTICS = 4096;
const codeFor = error => error instanceof PluginError && PLUGIN_ERROR_CODES.includes(error.code) ? error.code : 'provider';
const identity = operation => ({ key: operation.key, callId: operation.callId,
  providerSessionId: operation.providerSessionId, ordinal: operation.ordinal });
const completion = flight => ({ replyId: flight.id, created: flight.created, text: flight.content });

/** Trusted in-process port over admitted, server-owned text events. */
export function createVoiceReplyExecutor({ execute } = {}) {
  if (typeof execute !== 'function') throw new TypeError('Admitted reply execution required');
  return Object.freeze({
    async *execute(envelope, options) {
      if (!['authenticated-provider', 'server-coordinator'].includes(envelope?.source)) throw new PluginError('not-admitted', 'Trusted voice reply envelope required');
      const reply = await voiceOperation(options, opts => execute(envelope, opts));
      const operation = reply?.operation;
      if (typeof operation?.key !== 'string' || !operation.key || typeof operation.callId !== 'string' || !operation.callId ||
        typeof operation.providerSessionId !== 'string' || !operation.providerSessionId ||
        operation.ordinal !== null && (!Number.isSafeInteger(operation.ordinal) || operation.ordinal < 1) ||
        !reply.events?.getReader) throw new PluginError('invalid-output', 'Server operation identity required');
      const reader = reply.events.getReader();
      try {
        for (;;) {
          const item = await voiceOperation(options, () => reader.read());
          if (item.done) break;
          yield item.value;
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    },
  });
}

/** One writer owns execution; HTTP readers own only their subscriptions. */
export function createVoiceTurnOperations({ storage, now = Date.now, replayWindowMs = DEFAULT_VOICE_TURN_REPLAY_MS,
  authorizeReplacement, log } = {}) {
  if (!Number.isSafeInteger(replayWindowMs) || replayWindowMs <= 0 ||
    authorizeReplacement !== undefined && typeof authorizeReplacement !== 'function') throw new TypeError('Invalid voice turn policy');
  const store = storage.voiceTurnStore, flights = new Map();
  const diagnostic = createVoiceDiagnostics({ log }), closures = new Map(), reportedClosures = new Set();
  const generationKey = record => JSON.stringify([record.sessionId, record.callId, record.providerSessionId]);
  function reportClosure(operation) {
    try {
      const evidence = closures.get(generationKey(operation));
      if (!evidence || operation.state === 'pending') return;
      const { record, terminal } = evidence;
      const key = JSON.stringify([operation.key, operation.fence]);
      if (reportedClosures.has(key)) return;
      reportedClosures.add(key);
      if (reportedClosures.size > MAX_CLOSURE_DIAGNOSTICS) reportedClosures.delete(reportedClosures.values().next().value);
      diagnostic('voice.turn.closure', operation, { closureConfirmed: terminal.closureConfirmed === true,
        costEstimated: terminal.usage?.costEstimated === true, reconciliationAgeMs: voiceReconciliationAge(record, now()) });
    } catch { /* An observation cannot affect the operation writer. */ }
  }
  function abandon(operation) {
    if (!store.fail(operation.key, operation.fence, 'server-restart', now())) return;
    diagnostic('voice.turn.completion', operation, { outcome: 'failed', cause: 'server-restart',
      totalMs: Math.max(0, now() - operation.attempts.at(-1).startedAt) });
    reportClosure({ ...operation, state: 'failed' });
  }
  function wake(flight) { for (const resolve of flight.waiters) resolve(); flight.waiters.clear(); }
  function start(operation, execute, writeStoredReply) {
    const ready = Promise.withResolvers(), done = Promise.withResolvers(), controller = new AbortController();
    const flight = { operation, controller, ready: ready.promise, done: done.promise, waiters: new Set(),
      content: '', finished: false, startedAt: now(), elapsedMs: 0, admitted: false, firstToken: false };
    // Clamp elapsed observations per writer: wall-clock corrections must not
    // drop a timing field or make first-token/completion precede admission.
    const elapsed = () => (flight.elapsedMs = Math.max(flight.elapsedMs, now() - flight.startedAt));
    flights.set(operation.key, flight);
    const assertCurrent = () => store.pending(operation.key, operation.fence);
    flight.job = (async () => {
      try {
        const reply = await execute({ operation: identity(operation), signal: controller.signal, assertCurrent,
          ordinal: operation.ordinal, beforeAdmission: () => store.beforeAdmission(operation.key, operation.fence),
          admitted: attemptId => {
            store.admitted(operation.key, operation.fence, attemptId);
            if (!flight.admitted) {
              flight.admitted = true;
              diagnostic('voice.turn.admission', operation, { admissionMs: elapsed() });
            }
          },
          retry: cause => diagnostic('voice.turn.retry', operation, { cause }),
          reportAllowed: () => {
            const current = store.get(operation.key);
            return current?.fence === operation.fence && current.state === 'pending';
          } });
        if (typeof reply?.replyId !== 'string' || !reply.replyId || !Number.isSafeInteger(reply.created) || !reply.events?.[Symbol.asyncIterator]) {
          throw new PluginError('invalid-output');
        }
        flight.id = reply.replyId; flight.created = reply.created;
        assertCurrent(); ready.resolve();
        let completed = false;
        for await (const event of reply.events) {
          assertCurrent();
          if (Number.isSafeInteger(event.created)) flight.created = event.created;
          if (completed) throw new PluginError('invalid-output');
          if (event.type === 'delta' && typeof event.text === 'string') {
            flight.content += event.text;
            if (flight.content.length > 1_048_576) throw new PluginError('limit');
            if (event.text && !flight.firstToken) {
              flight.firstToken = true;
              diagnostic('voice.turn.first-token', operation, { firstTokenMs: elapsed() });
            }
            wake(flight);
          } else if (event.type === 'completion' && event.text === flight.content) completed = true;
          else throw new PluginError('invalid-output');
        }
        if (!completed) throw new PluginError('invalid-output');
        // Completion reaches readers only after the reply and terminal state commit.
        const receipt = completion(flight);
        store.complete(operation.key, operation.fence, writeStoredReply ? writeStoredReply(receipt) : receipt, now(), replayWindowMs);
        diagnostic('voice.turn.completion', operation, { totalMs: elapsed(), outcome: 'completed' });
        reportClosure({ ...operation, state: 'completed' });
      } catch (error) {
        if (!flight.id) flight.initialError = error;
        flight.error = codeFor(error);
        controller.abort();
        store.fail(operation.key, operation.fence, flight.error, now());
        diagnostic('voice.turn.completion', operation, { totalMs: elapsed(), outcome: 'failed', cause: flight.error });
        reportClosure({ ...operation, state: 'failed' });
      } finally {
        flight.finished = true; ready.resolve(); done.resolve(); wake(flight);
        if (flights.get(operation.key) === flight) flights.delete(operation.key);
      }
    })();
    flight.job.catch(() => {});
    return flight;
  }
  function stream(flight, signal, assertCurrent, ownsEpoch) {
    let offset = 0, role = false, ended = false, cancelled = false, waiting;
    const cancel = () => { ended = true; waiting?.(); };
    const detach = () => { signal?.removeEventListener('abort', cancel); if (waiting) flight.waiters.delete(waiting); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    return new ReadableStream({
      async pull(controller) {
        for (;;) {
          if (ended || !ownsEpoch()) { ended = true; detach(); if (!cancelled) controller.close(); return; }
          try { assertCurrent(); } catch (error) {
            ended = true; detach(); controller.error(error); return;
          }
          if (!role) { role = true; controller.enqueue({ type: 'operation', operation: identity(flight.operation), replyId: flight.id }); return; }
          if (flight.error) {
            ended = true; detach(); controller.error(new PluginError(flight.error)); return;
          }
          if (offset < flight.content.length) {
            // Shared content is bounded once; a stalled reader queues no frames
            // and catches up in bounded pieces only when it asks for another.
            let end = Math.min(offset + 16_384, flight.content.length);
            if (end < flight.content.length && /[\uD800-\uDBFF]/u.test(flight.content[end - 1])) end--;
            const text = flight.content.slice(offset, end); offset = end;
            controller.enqueue({ type: 'delta', text }); return;
          }
          if (flight.finished) {
            ended = true; detach(); controller.enqueue({ type: 'completion', replyId: flight.id, text: flight.content }); controller.close(); return;
          }
          await new Promise(resolve => { waiting = resolve; flight.waiters.add(resolve); });
          flight.waiters.delete(waiting); waiting = undefined;
        }
      },
      cancel() { cancelled = true; cancel(); detach(); },
    }, { highWaterMark: 0 });
  }
  function result(operation, flight, options) {
    return { operation: identity(operation), replyId: flight.id, get created() { return flight.created; },
      events: stream(flight, options.signal, () => {
        const current = store.get(operation.key);
        if (current.fence !== operation.fence) throw new PluginError('not-admitted', 'voice-turn-fenced');
        return store.assertCurrent(current);
      }, () => store.ownsEpoch(operation)) };
  }
  async function respond(operation, flight, context, options) {
    await voiceOperation(options, () => flight.ready);
    if (flight.initialError) throw flight.initialError;
    if (context.stream !== true) {
      await voiceOperation(options, () => flight.done);
      if (flight.error) throw new PluginError(flight.error);
      store.readReply(store.get(operation.key), now());
    }
    return result(operation, flight, options);
  }
  return {
    async run(context, execute, options = {}) {
      let { operation, claimed } = store.claim(context, { now: now() });
      if (operation.state === 'completed') {
        // An adapter may translate records persisted by an older wire codec.
        const stored = store.readReply(operation, now());
        const reply = options.readStoredReply ? options.readStoredReply(stored) : stored;
        if (typeof reply.replyId !== 'string' || !Number.isSafeInteger(reply.created) || typeof reply.text !== 'string') throw new PluginError('invalid-output');
        diagnostic('voice.turn.retry', operation, { cause: 'replay' });
        return result(operation, { operation, id: reply.replyId, created: reply.created, content: reply.text,
          finished: true, waiters: new Set() }, options);
      }
      let flight = flights.get(operation.key);
      if (flight?.operation.fence === operation.fence) {
        diagnostic('voice.turn.retry', operation, { cause: 'duplicate-callback' });
        return respond(operation, flight, context, options);
      }
      if (!claimed && operation.state === 'pending') {
        // No worker owns this durable claim after a crash. Never dispatch implicitly.
        abandon(operation); operation = store.get(operation.key);
      }
      if (operation.state === 'failed') {
        const authorized = authorizeReplacement && await voiceOperation(options,
          bounded => authorizeReplacement({ operation: structuredClone(operation), context, options: bounded }));
        if (authorized !== true) throw new PluginError('not-admitted', 'voice-turn-replacement-required');
        const cause = operation.error;
        ({ operation, claimed } = store.replace(operation.key, operation.fence, now()));
        if (claimed) diagnostic('voice.turn.retry', operation, { cause });
        flight = flights.get(operation.key);
        if (!claimed && flight?.operation.fence === operation.fence) return respond(operation, flight, context, options);
        if (!claimed && operation.state === 'completed') return this.run(context, execute, options);
        if (!claimed) throw new PluginError('not-admitted', 'voice-turn-fenced');
      }
      flight = start(operation, execute, options.writeStoredReply);
      return respond(operation, flight, context, options);
    },
    observeClosure(record, terminal) {
      try {
        // Uncertain lookups are reconciliation evidence, not a second closure.
        // Report exactly one confirmed closure per settled writer attempt.
        if (!log || terminal?.closureConfirmed !== true) return;
        const key = generationKey(record);
        // Retain only timing/evidence; no callback content or private call fields.
        closures.set(key, { record: { endedAt: record.endedAt, startedAt: record.startedAt },
          terminal: { closureConfirmed: terminal.closureConfirmed, usage: { costEstimated: terminal.usage?.costEstimated === true } } });
        if (closures.size > MAX_CLOSURE_DIAGNOSTICS) closures.delete(closures.keys().next().value);
        for (const operation of store.list(record.sessionId)) if (generationKey(operation) === key) reportClosure(operation);
      } catch { /* Lifecycle evidence remains authoritative if diagnostics fail. */ }
    },
    retireEpoch(sessionId, callId) {
      // Wake subscribers so retirement closes their pending reads immediately.
      // The worker and its paid claim retain their independent lifetime.
      for (const flight of flights.values()) if (flight.operation.sessionId === sessionId && flight.operation.callId === callId &&
        !store.ownsEpoch(flight.operation)) wake(flight);
    },
    recover() {
      for (const operation of store.list()) if (operation.state === 'pending' && !flights.has(operation.key))
        abandon(operation);
    },
    async idle() { await Promise.allSettled([...flights.values()].map(flight => flight.job)); },
  };
}
