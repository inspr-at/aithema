import { randomBytes, randomUUID } from 'node:crypto';
import { PluginError, inputRevision, reasoningRequest } from '@inspr/aithema-core';
import { createCompletionsHandler } from '../../../plugins/elevenlabs/src/facade.js';
import { voiceOperation } from '../../core/src/live-voice.js';
import { ConflictError, NotFoundError } from './storage.js';

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const idPattern = '[a-zA-Z0-9_-]{1,128}';
const routes = new RegExp(`^/api/sessions/(${idPattern})/voice(?:/(${idPattern})/(pause|resume|heartbeat|close|recover|events))?$`, 'u');
const facadeRoute = new RegExp(`^/api/voice/(${idPattern})/llm/chat/completions$`, 'u');

export function createFacadeSecrets() {
  const values = new Map();
  return { provision(ref) { values.set(ref, randomBytes(32).toString('base64url')); },
    resolve: ref => values.get(ref), revoke: ref => { values.delete(ref); } };
}

export function createVoiceHandlers({ storage, runtime, ownership, readBody, secrets,
  publish, onTurn, hostPrompt = '', now = Date.now, browserLeaseMs = 30_000, deadlineMs = 30_000,
  closeOrphan } = {}) {
  if (!secrets?.provision || !secrets.resolve || !secrets.revoke) throw new TypeError('Private facade secret store required');
  const calls = new Map(), sessions = new Map(), receipts = new Map();
  const sessionFor = entry => {
    const session = storage.authorize(entry.sessionId, entry.ownerToken);
    if (session.consentRevision !== entry.consentRevision || session.withdrawalRevision !== entry.withdrawalRevision) throw new PluginError('not-admitted', 'Call context revoked');
    return session;
  };
  const receipt = call => ({ callId: call.callId, providerSessionId: call.providerSessionId, credential: call.credential,
    spendDeadlineAt: call.spendDeadlineAt, browserLivenessDeadlineAt: call.browserLivenessDeadlineAt,
    ...(call.overrides ? { overrides: call.overrides } : {}) });
  const options = request => ({ signal: request.signal, deadlineAt: Date.now() + deadlineMs });
  function revoke(entry) { secrets.revoke(entry.facadeSecretRef); }
  async function close(entry, reason = 'closed', outcome = 'completed') {
    revoke(entry);
    if (!entry.call) { entry.controller.abort(); entry.admission?.finish();
      if (sessions.get(entry.sessionId) === entry.callId) sessions.delete(entry.sessionId); return; }
    const closing = entry.call.close(reason, outcome); entry.controller.abort();
    const terminal = await closing;
    entry.admission?.finish();
    receipts.set(entry.call.providerSessionId, terminal);
    if (sessions.get(entry.sessionId) === entry.callId) sessions.delete(entry.sessionId);
    publish(entry.sessionId, { type: 'voice.state', data: { callId: entry.callId, state: reason === 'transport-lost' ? 'recovering' : 'ended', reason,
      terminal: { outcome: terminal.outcome, closureConfirmed: terminal.closureConfirmed, usage: terminal.usage ?? null } } });
    return terminal;
  }
  async function start(request, sessionId, ownerToken, callId, spendDeadlineAt) {
    const session = storage.authorize(sessionId, ownerToken);
    if (sessions.has(sessionId)) throw new ConflictError('Voice call already active');
    const controller = new AbortController(), entry = { callId, sessionId, ownerToken, controller,
      consentRevision: session.consentRevision, withdrawalRevision: session.withdrawalRevision,
      facadeSecretRef: 'voice-' + randomUUID() };
    sessions.set(sessionId, callId); calls.set(callId, entry);
    const abortStartup = () => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', abortStartup, { once: true });
    if (request.signal.aborted) abortStartup();
    try {
      const opts = { ...options(request), signal: controller.signal };
      const admitted = await runtime.admitVoice({ session, request: { callId }, options: opts }); entry.admission = admitted;
      const end = spendDeadlineAt ?? now() + admitted.binding.maxDurationSeconds * 1000;
      if (end <= now()) throw new PluginError('deadline');
      await secrets.provision(entry.facadeSecretRef);
      entry.call = await admitted.plugin.start({ callId, sessionId, ownerToken, facadeSecretRef: entry.facadeSecretRef,
        facadeUrl: `${admitted.binding.publicFacadeBaseUrl}/api/voice/${callId}/llm/chat/completions` },
        { ...admitted.options, spendDeadlineAt: end, browserLivenessDeadlineAt: Math.min(end, now() + browserLeaseMs) });
      entry.call.signal.addEventListener('abort', () => {
        revoke(entry);
        if (sessions.get(sessionId) === callId) sessions.delete(sessionId);
      }, { once: true });
      if (entry.call.signal.aborted) { await close(entry, 'start-cancelled', 'cancelled'); throw new PluginError('cancelled'); }
      return receipt(entry.call);
    } catch (error) {
      revoke(entry); controller.abort(); entry.admission?.finish();
      if (sessions.get(sessionId) === callId) sessions.delete(sessionId);
      throw error;
    } finally { request.signal.removeEventListener('abort', abortStartup); }
  }
  const facade = createCompletionsHandler({ resolveSecret: secrets.resolve,
    async getCall(request) {
      const callId = facadeRoute.exec(new URL(request.url).pathname)?.[1], entry = calls.get(callId);
      if (!entry?.call) return null;
      try {
        const session = sessionFor(entry);
        await runtime.checkVoice(session, { ...options(request), allowPaused: true, existingCall: true });
        return { ...entry.call.snapshot(), signal: entry.call.signal };
      } catch { void close(entry, 'call-authorization-lost', 'cancelled').catch(() => {}); return null; }
    },
    buildRequest({ callId, messages }) {
      const session = sessionFor(calls.get(callId)), trusted = reasoningRequest(session, 'reaction', false, hostPrompt);
      // Provider text is untrusted conversational input, never system/model selection.
      return { ...trusted, messages: [...trusted.messages,
        ...(session.focusedQuestion ? [{ role: 'user', content: JSON.stringify({ kind: 'untrusted-focused-question', question: session.focusedQuestion }) }] : []),
        ...messages] };
    },
    admitReasoning({ callId, request, options }) {
      const session = sessionFor(calls.get(callId));
      return runtime.admit({ session, lane: 'reaction', operation: 'stream', request, options });
    },
  });
  return {
    active: id => sessions.has(id),
    async stopSession(id, reason = 'session-revoked') {
      const entry = calls.get(sessions.get(id));
      if (entry) await close(entry, reason, 'cancelled');
    },
    async pauseSession(id, paused, opts = {}) {
      const entry = calls.get(sessions.get(id));
      if (!entry?.call) return null;
      const session = sessionFor(entry);
      await runtime.checkVoice(session, { ...opts, allowPaused: true, existingCall: true });
      return entry.call[paused ? 'pause' : 'resume']({ ...opts, guard: { revision: inputRevision(session) } });
    },
    async handle(request) {
      const path = new URL(request.url).pathname;
      if (facadeRoute.test(path)) return facade(request);
      const match = routes.exec(path); if (!match) return null;
      try {
        const [, sessionId, callId, action] = match, ownerToken = ownership.token(request);
        storage.authorize(sessionId, ownerToken);
        if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
        const bytes = await readBody(request, 65_536), body = bytes.length ? JSON.parse(Buffer.from(bytes).toString('utf8')) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Invalid body');
        if (!action) {
          if (typeof body.callId !== 'string' || !new RegExp(`^${idPattern}$`, 'u').test(body.callId) || calls.has(body.callId)) throw new ConflictError('Call identity reused');
          return json(await start(request, sessionId, ownerToken, body.callId), 201);
        }
        const previous = storage.voiceCalls(sessionId).find(c => c.callId === callId && c.providerSessionId === body.providerSessionId);
        if (action === 'close' && previous?.terminal) return json(receipts.get(body.providerSessionId) ?? previous.terminal);
        const entry = calls.get(callId);
        if (!entry || entry.sessionId !== sessionId || entry.ownerToken !== ownerToken || !entry.call) throw new NotFoundError('Call not found');
        const bound = entry.call.providerSessionId === body.providerSessionId;
        if (!bound && !(action === 'recover' && previous?.terminal)) throw new NotFoundError('Provider identity not found');
        if (action === 'close') return json(await close(entry, typeof body.reason === 'string' ? body.reason.slice(0, 128) : 'closed'));
        let session = sessionFor(entry);
        // Cleanup is always permitted. Every other command needs current binding coverage.
        try {
          await runtime.checkVoice(session, { ...options(request), allowPaused: ['pause', 'resume', 'heartbeat'].includes(action), existingCall: true });
        } catch (error) {
          if (error.message !== 'session paused') await close(entry, 'call-authorization-lost', 'cancelled');
          throw error;
        }
        if (action === 'recover') {
          if (entry.recovering) throw new ConflictError('Recovery in progress');
          entry.recovering = true;
          try {
            if ((entry.recoveryCount ?? 0) >= 3) throw new PluginError('unavailable', 'Recovery exhausted');
            const count = (entry.recoveryCount ?? 0) + 1, end = entry.call.spendDeadlineAt;
            await close(entry, 'transport-lost', 'cancelled');
            entry.recoveryCount = count;
            try {
              const next = await start(request, sessionId, ownerToken, callId, end);
              calls.get(callId).recoveryCount = count; return json(next);
            } catch (error) { calls.set(callId, entry); throw error; }
          } finally { entry.recovering = false; }
        }
        if (entry.call.signal.aborted) throw new PluginError('unavailable');
        if (action === 'events') {
          const fresh = sessionFor(entry);
          const result = storage.postVoiceEvent(sessionId, callId, entry.call.providerSessionId, body.event,
            { ownerToken, revision: inputRevision(fresh) });
          if (!result.replayed) {
            publish(sessionId, result.event); onTurn(sessionId, result.event);
          }
          return json(result.event);
        }
        const before = storage.get(sessionId).seq;
        const ack = await entry.call[action]({ ...options(request), guard: { revision: inputRevision(session) } });
        for (const event of storage.read(sessionId, before)) publish(sessionId, event);
        if (action === 'resume') onTurn(sessionId);
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
        await secrets.revoke(record.facadeSecretRef);
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
    async close() { await Promise.allSettled([...sessions.keys()].map(id => this.stopSession(id, 'server-stopping'))); },
  };
}
