import { randomBytes, randomUUID } from 'node:crypto';
import { PluginError, inputRevision, reasoningRequest, aiTextOrigin } from '@inspr/aithema-core';
import { createCompletionsHandler } from '../../../plugins/elevenlabs/src/facade.js';
import { voiceOperation } from '../../core/src/live-voice.js';
import { ConflictError, NotFoundError } from './storage.js';

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const idPattern = '[a-zA-Z0-9_-]{1,128}';
const routes = new RegExp(`^/api/sessions/(${idPattern})/voice(?:/(${idPattern})/(pause|resume|heartbeat|close|recover|events))?$`, 'u');
const facadeRoute = new RegExp(`^/api/voice/(${idPattern})/llm/chat/completions$`, 'u');
const staticFacadeRoute = '/api/voice/llm/chat/completions';

export function createFacadeSecrets() {
  const values = new Map();
  return { provision(ref) { values.set(ref, randomBytes(32).toString('base64url')); },
    resolve: ref => values.get(ref), revoke: ref => { values.delete(ref); } };
}

export function createVoiceHandlers({ storage, runtime, ownership, readBody, secrets,
  publish, onTurn, onClose, hostPrompt = '', now = Date.now, browserLeaseMs = 30_000, deadlineMs = 30_000,
  closeOrphan, staticSecretRef, presentation } = {}) {
  if (!secrets?.provision || !secrets.resolve || !secrets.revoke) throw new TypeError('Private facade secret store required');
  if (presentation !== undefined && typeof presentation !== 'function') throw new TypeError('Voice presentation must be a function of the session locale');
  const calls = new Map(), sessions = new Map(), settlements = new Set();
  const sessionFor = entry => {
    const session = storage.authorize(entry.sessionId, entry.ownerToken);
    if (session.consentRevision !== entry.consentRevision || session.withdrawalRevision !== entry.withdrawalRevision) throw new PluginError('not-admitted', 'Call context revoked');
    return session;
  };
  const receipt = call => ({ callId: call.callId, providerSessionId: call.providerSessionId, credential: call.credential,
    ...(staticSecretRef ? { facadeCallId: calls.get(call.callId)?.facadeCallId } : {}),
    spendDeadlineAt: call.spendDeadlineAt, browserLivenessDeadlineAt: call.browserLivenessDeadlineAt,
    ...(call.overrides ? { overrides: call.overrides } : {}) });
  const options = request => ({ signal: request.signal, deadlineAt: Date.now() + deadlineMs });
  function revoke(entry) { if (!staticSecretRef) secrets.revoke(entry.facadeSecretRef); }
  function close(entry, reason = 'closed', outcome = 'completed') {
    if (entry.closing) return entry.closing;
    // Install the promise before close() aborts the provider signal synchronously.
    let resolve, reject;
    const closing = new Promise((yes, no) => { resolve = yes; reject = no; });
    entry.closing = closing; settlements.add(closing);
    closing.catch(() => {}).finally(() => settlements.delete(closing));
    revoke(entry);
    onClose?.(entry.sessionId);
    if (sessions.get(entry.sessionId) === entry) sessions.delete(entry.sessionId);
    publish(entry.sessionId, { type: 'voice.state', data: { callId: entry.callId,
      providerSessionId: entry.call?.providerSessionId,
      state: reason === 'transport-lost' ? 'recovering' : 'closing', reason } });
    const settle = async () => {
      try {
        let pending;
        if (entry.call) { pending = entry.call.close(reason, outcome); entry.controller.abort(); }
        else {
          entry.controller.abort();
          await entry.started;
          pending = entry.call?.close(reason, outcome);
        }
        const terminal = await pending;
        entry.admission?.finish();
        // An old recovery's settlement cannot publish over or remove its successor.
        if (terminal && calls.get(entry.callId) === entry) publish(entry.sessionId, { type: 'voice.state', data: {
          callId: entry.callId, providerSessionId: entry.call.providerSessionId, state: reason === 'transport-lost' ? 'recovering' : 'ended', reason,
          terminal: { outcome: terminal.outcome, closureConfirmed: terminal.closureConfirmed, usage: terminal.usage ?? null } } });
        resolve(terminal);
      } catch (error) { reject(error); }
      finally { if (calls.get(entry.callId) === entry) calls.delete(entry.callId); }
    };
    void settle(); return closing;
  }
  async function start(request, sessionId, ownerToken, callId, spendDeadlineAt) {
    const session = storage.authorize(sessionId, ownerToken);
    if (sessions.has(sessionId)) throw new ConflictError('Voice call already active');
    const controller = new AbortController(), started = Promise.withResolvers(), entry = { callId, sessionId, ownerToken, controller, started: started.promise,
      consentRevision: session.consentRevision, withdrawalRevision: session.withdrawalRevision,
      settingsRevision: session.settings?.revision ?? 0,
      facadeSecretRef: staticSecretRef ?? 'voice-' + randomUUID(), ...(staticSecretRef ? { facadeCallId: randomUUID() } : {}) };
    sessions.set(sessionId, entry); calls.set(callId, entry);
    const abortStartup = () => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', abortStartup, { once: true });
    if (request.signal.aborted) abortStartup();
    try {
      const opts = { ...options(request), signal: controller.signal };
      const admitted = await runtime.admitVoice({ session, request: { callId }, options: { ...opts, spendDeadlineAt } }); entry.admission = admitted;
      const end = spendDeadlineAt ?? now() + admitted.binding.maxDurationSeconds * 1000;
      if (end <= now()) throw new PluginError('deadline');
      if (!staticSecretRef) await secrets.provision(entry.facadeSecretRef);
      controller.signal.throwIfAborted();
      // The host's per-conversation language, if its agent allows it; never the greeting (AIT-119).
      const overrides = presentation?.(session.locale);
      entry.call = await admitted.plugin.start({ callId, sessionId, ownerToken, facadeSecretRef: entry.facadeSecretRef,
        facadeUrl: `${admitted.binding.publicFacadeBaseUrl}${staticSecretRef ? staticFacadeRoute : `/api/voice/${callId}/llm/chat/completions`}`,
        settingsRevision: session.settings?.revision ?? 0, ...(overrides ? { overrides } : {}) },
        { ...admitted.options, spendDeadlineAt: end, browserLivenessDeadlineAt: Math.min(end, now() + browserLeaseMs) });
      entry.call.signal.addEventListener('abort', () => {
        void close(entry, entry.call.snapshot().reason ?? 'cancelled', 'cancelled');
      }, { once: true });
      if (entry.call.signal.aborted) { void close(entry, 'start-cancelled', 'cancelled'); throw new PluginError('cancelled'); }
      return receipt(entry.call);
    } catch (error) {
      revoke(entry); controller.abort(); if (!entry.call) entry.admission?.finish();
      if (sessions.get(sessionId) === entry) sessions.delete(sessionId);
      if (calls.get(callId) === entry) calls.delete(callId);
      throw error;
    } finally { started.resolve(); request.signal.removeEventListener('abort', abortStartup); }
  }
  const facade = createCompletionsHandler({ resolveSecret: secrets.resolve, staticSecretRef,
    getCall(request, options, identity) {
      const entry = staticSecretRef ? [...calls.values()].find(entry => entry.facadeCallId === identity)
        : calls.get(facadeRoute.exec(new URL(request.url).pathname)?.[1]);
      if (!entry?.call || entry.closing || sessions.get(entry.sessionId) !== entry) return null;
      try { sessionFor(entry); } catch { throw new PluginError('not-admitted', 'Call ownership or context revoked'); }
      return { ...entry.call.snapshot(), facadeSecretRef: entry.facadeSecretRef, facadeCallId: entry.facadeCallId, signal: entry.call.signal };
    },
    buildRequest({ callId, messages }) {
      const session = sessionFor(calls.get(callId)), trusted = reasoningRequest(session, 'reaction', false, hostPrompt);
      // Provider text is untrusted conversational input, never system/model selection.
      return { ...trusted, messages: [...trusted.messages,
        ...(session.focusedQuestion ? [{ role: 'user', content: JSON.stringify({ kind: 'untrusted-focused-question', question: session.focusedQuestion }) }] : []),
        ...messages] };
    },
    async admitReasoning({ callId, request, options }) {
      const session = sessionFor(calls.get(callId));
      await runtime.checkVoice(session, { ...options, existingCall: true });
      return runtime.admit({ session, lane: 'reaction', operation: 'stream', request, options });
    },
    onCompletion({ callId, providerSessionId, content, textOrigin, engine }) {
      const entry = calls.get(callId);
      if (!entry?.call || entry.closing || entry.call.providerSessionId !== providerSessionId) return;
      entry.produced ??= [];
      entry.produced.push({ content, textOrigin, engine });
      while (entry.produced.length > 256 || entry.produced.reduce((n, reply) => n + reply.content.length, 0) > 1_048_576) entry.produced.shift();
    },
  });
  async function changePause(entry, paused, opts = {}) {
    if (paused) {
      try {
        if (entry.closing || !entry.call) throw new PluginError('unavailable');
        await voiceOperation({ ...opts, deadlineAt: Math.min(opts.deadlineAt ?? Infinity, Date.now() + 1000) }, bounded =>
          entry.call.pause({ ...bounded, guard: { ownerToken: entry.ownerToken } }));
      } catch { void close(entry, 'pause-failed', 'cancelled'); }
      return { acknowledged: true, paused: true };
    }
    const session = sessionFor(entry);
    await runtime.checkVoice(session, { ...opts, allowPaused: true, existingCall: true });
    return entry.call.resume({ ...opts, guard: { revision: inputRevision(session) } });
  }
  return {
    active: id => sessions.has(id),
    typedContext(id, ownerToken, callId, providerSessionId) {
      const entry = calls.get(callId);
      if (!entry?.call || entry.sessionId !== id || entry.ownerToken !== ownerToken || entry.call.providerSessionId !== providerSessionId) throw new NotFoundError('Call not found');
      const session = sessionFor(entry);
      if (session.paused || session.consentWithdrawn) throw new PluginError('not-admitted');
      if (entry.closing || entry.call.signal.aborted) return {};
      return { voiceCallId: callId, voiceProviderId: providerSessionId };
    },
    stopSession(id, reason = 'session-revoked') {
      const entry = sessions.get(id);
      if (entry) void close(entry, reason, 'cancelled');
    },
    async pauseSession(id, paused, opts = {}) {
      const entry = sessions.get(id);
      if (!entry?.call) return null;
      return changePause(entry, paused, opts);
    },
    async handle(request) {
      const path = new URL(request.url).pathname;
      if (staticSecretRef ? path === staticFacadeRoute : facadeRoute.test(path)) return facade(request);
      if (staticSecretRef && facadeRoute.test(path)) return json({ error: 'not-found' }, 404);
      const match = routes.exec(path); if (!match) return null;
      try {
        const [, sessionId, callId, action] = match, ownerToken = ownership.token(request);
        storage.authorize(sessionId, ownerToken);
        if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
        const bytes = await readBody(request, 65_536), body = bytes.length ? JSON.parse(Buffer.from(bytes).toString('utf8')) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Invalid body');
        if (!action) {
          if (typeof body.callId !== 'string' || !new RegExp(`^${idPattern}$`, 'u').test(body.callId) || calls.has(body.callId) || storage.voiceCalls(sessionId).some(c => c.callId === body.callId)) throw new ConflictError('Call identity reused');
          return json(await start(request, sessionId, ownerToken, body.callId), 201);
        }
        const previous = storage.voiceCalls(sessionId).find(c => c.callId === callId && c.providerSessionId === body.providerSessionId);
        if (action === 'close' && previous?.terminal) return json(previous.terminal);
        const entry = calls.get(callId);
        if (!entry && action === 'recover' && previous) {
          const count = storage.voiceCalls(sessionId).filter(c => c.callId === callId).length;
          if (count > 3) throw new PluginError('unavailable', 'Recovery exhausted');
          // A choice saved while the call was down applies only to an explicitly started call.
          if (Number.isSafeInteger(previous.settingsRevision) && previous.settingsRevision !== storage.get(sessionId).settings?.revision) {
            throw new PluginError('not-admitted', 'Processing settings changed');
          }
          const next = await start(request, sessionId, ownerToken, callId, previous.spendDeadlineAt);
          calls.get(callId).recoveryCount = count; return json(next);
        }
        if (!entry && previous && storage.get(sessionId).consentWithdrawn) throw new PluginError('not-admitted');
        if (!entry || entry.sessionId !== sessionId || entry.ownerToken !== ownerToken || !entry.call) throw new NotFoundError('Call not found');
        const bound = entry.call.providerSessionId === body.providerSessionId;
        if (!bound && !(action === 'recover' && previous)) throw new NotFoundError('Provider identity not found');
        if (action === 'close') return json(await close(entry, typeof body.reason === 'string' ? body.reason.slice(0, 128) : 'closed'));
        if (action === 'pause') {
          const event = storage.pause(sessionId, true, { ownerToken }); publish(sessionId, event);
          return json(await changePause(entry, true, options(request)));
        }
        let session = sessionFor(entry);
        // Cleanup is always permitted. Every other command needs current binding coverage.
        try {
          await runtime.checkVoice(session, { ...options(request), allowPaused: ['resume', 'heartbeat'].includes(action), existingCall: true });
        } catch (error) {
          if (error.message !== 'session paused') void close(entry, 'call-authorization-lost', 'cancelled');
          throw error;
        }
        if (action === 'recover') {
          if (!bound && !entry.closing && !entry.call.signal.aborted) return json(receipt(entry.call));
          if (entry.recovering) throw new ConflictError('Recovery in progress');
          if (entry.settingsRevision !== session.settings?.revision) throw new PluginError('not-admitted', 'Processing settings changed');
          entry.recovering = true;
          try {
            if ((entry.recoveryCount ?? 0) >= 3) throw new PluginError('unavailable', 'Recovery exhausted');
            const count = (entry.recoveryCount ?? 0) + 1, end = entry.call.spendDeadlineAt;
            void close(entry, 'transport-lost', 'cancelled');
            entry.recoveryCount = count;
            const next = await start(request, sessionId, ownerToken, callId, end);
            calls.get(callId).recoveryCount = count; return json(next);
          } finally { entry.recovering = false; }
        }
        if (entry.call.signal.aborted) throw new PluginError('unavailable');
        if (action === 'events') {
          const fresh = sessionFor(entry);
          const produced = body.event?.role === 'assistant' && entry.produced?.findLast(reply => reply.content === body.event.text);
          const provenance = produced ? 'facade-produced' : 'browser-asserted';
          const result = storage.postVoiceEvent(sessionId, callId, entry.call.providerSessionId, body.event,
            { ownerToken, revision: inputRevision(fresh), provenance,
              ...(produced ? { ...produced.textOrigin, engine: produced.engine } : aiTextOrigin(entry.admission.binding)) });
          if (!result.replayed) {
            publish(sessionId, result.event); onTurn(sessionId, result.event);
          }
          return json(result.event);
        }
        const before = storage.get(sessionId).seq;
        const ack = await entry.call[action]({ ...options(request), guard: { revision: inputRevision(session) } });
        for (const event of storage.read(sessionId, before)) publish(sessionId, event);
        return json(ack);
      } catch (error) {
        if (error instanceof NotFoundError) return json({ error: 'session-not-found' }, 404);
        if (error instanceof ConflictError) return json({ error: 'voice-conflict' }, 409);
        if (error instanceof SyntaxError || error instanceof TypeError) return json({ error: 'invalid-request' }, 400);
        if (error instanceof RangeError) return json({ error: 'size-limit' }, 413);
        if (error instanceof PluginError) return json({ error: error.code }, error.code === 'not-admitted' ? 403 : error.code === 'deadline' ? 504 : 502);
        return json({ error: 'voice-unavailable' }, 503);
      }
    },
    async resume() {
      // The exclusive writer has already conservatively recovered all open claims.
      for (const record of storage.voiceCalls()) {
        if (!staticSecretRef) await secrets.revoke(record.facadeSecretRef);
        if (record.terminal && !record.reconciliationPending) continue;
        const row = runtime.budget.get(record.attemptId);
        storage.saveVoiceCall(record.sessionId, { ...record, closing: true, endedAt: record.endedAt ?? now(), reason: record.reason ?? 'server-restart',
          terminal: record.terminal ?? { attemptId: record.attemptId, outcome: row?.outcome ?? 'uncertain', closureConfirmed: false,
            chargedMicro: row?.settled_micro ?? record.maxMicro }, reconciliationPending: true });
        if (closeOrphan) {
          try {
            const result = await voiceOperation({ deadlineAt: Date.now() + 1000 }, opts => closeOrphan(record, opts));
            if (result?.closureConfirmed === true && result.providerSessionId === record.providerSessionId) {
              runtime.budget.reconcileVoice(record.attemptId, result);
              const saved = storage.voiceCalls(record.sessionId).find(c => c.providerSessionId === record.providerSessionId);
              storage.saveVoiceCall(record.sessionId, { ...saved, reconciliation: result, reconciliationPending: false });
            }
          }
          catch { /* Durable pending reconciliation remains visible to the host. */ }
        }
      }
    },
    async idle() { while (settlements.size) await Promise.allSettled([...settlements]); },
    async close() { for (const id of sessions.keys()) this.stopSession(id, 'server-stopping'); await this.idle(); },
  };
}
