import { randomBytes, randomUUID } from 'node:crypto';
import { PluginError, inputRevision, reasoningRequest, aiTextOrigin } from '@inspr/aithema-core';
import { createCompletionsHandler } from '../../../plugins/elevenlabs/src/facade.js';
import { voiceOperation } from '../../core/src/live-voice.js';
import { ConflictError, NotFoundError } from './storage.js';
import { VOICE_CAP_REASONS } from './voice-cap.js';
import { CUSTOM_LLM_BASE_PATH } from '../../../plugins/elevenlabs/src/ensure-agent.js';
import { createVoiceTurnOperations } from './voice-turns.js';

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const idPattern = '[a-zA-Z0-9_-]{1,128}';
const routes = new RegExp(`^/api/sessions/(${idPattern})/voice(?:/(${idPattern})/(pause|resume|heartbeat|close|recover|events))?$`, 'u');
const facadeRoute = new RegExp(`^/api/voice/(${idPattern})/llm/chat/completions$`, 'u');
const staticFacadeRoute = '/api/voice/llm/chat/completions';

// Voice-only guidance composes with core's shared policies via reasoningRequest.
const VOICE_REPLY_POLICY = `Voice reply guidance:
A focused question is only a suggestion: check the conversation before asking it, even when understanding is current.
When understanding is stale or draft, ignore its open questions as next-question candidates. If the latest answer resolves the preceding question, acknowledge it briefly and let the assessment catch up; do not repeat the question or claim the assessment is complete.
Use two or three short sentences, usually at most 60 words, and at most one question about a genuinely unresolved point. A question is optional; answer the person's immediate request first.
Do not read back the running summary or recap the whole answer. Speak naturally without lists or reasoning aloud.`;

function unrecordedVoiceInput(session, messages, { callId, providerSessionId }) {
  const latest = messages.at(-1);
  // Only a trailing person utterance can be new input. Never replay provider history.
  if (latest?.role !== 'user' || !latest.content.trim()) return [];
  const normalize = text => text.trim().replace(/\s+/gu, ' ');
  const last = session.transcript.at(-1);
  // Only server-persisted speech from this call AND provider generation can
  // suppress input. Legacy turns have unknown provenance; typed turns carry
  // voiceCallId/voiceProviderId instead, even when an SDK echo is absorbed.
  const sameGeneration = turn => turn.callId === callId && turn.providerSessionId === providerSessionId;
  const sameTurn = last?.role === 'user' && !last.erased && !last.withdrawn && sameGeneration(last) && typeof last.content === 'string' &&
    normalize(last.content) === normalize(latest.content);
  // Provenance does not identify individual repeated utterances (AIT-137).
  // Extra provider turns can only veto suppression, never establish identity:
  // a delayed or entirely unheard assistant reply leaves the newest input new.
  const recorded = session.transcript.filter(turn => sameGeneration(turn) && !turn.erased && !turn.withdrawn &&
    typeof turn.content === 'string' && Boolean(turn.content.trim()));
  const providerAhead = ['user', 'assistant'].some(role =>
    messages.filter(message => message.role === role).length > recorded.filter(turn => turn.role === role).length);
  return sameTurn && !providerAhead ? [] : [{ role: 'user', content: latest.content }];
}

export function createFacadeSecrets() {
  const values = new Map();
  return { provision(ref) { values.set(ref, randomBytes(32).toString('base64url')); },
    resolve: ref => values.get(ref), revoke: ref => { values.delete(ref); } };
}

export function createVoiceHandlers({ storage, runtime, ownership, readBody, secrets,
  publish, onTurn, onClose, hostPrompt = '', now = Date.now, browserLeaseMs = 30_000, deadlineMs = 30_000,
  closeOrphan, staticSecretRef, presentation, reconcileIntervalMs = 30_000, reconcileBatchSize = 10,
  reconcileLookupTimeoutMs = 5000, log,
  turnReplayWindowMs, turnTimeoutMs = 30_000, authorizeTurnReplacement } = {}) {
  if (!secrets?.provision || !secrets.resolve || !secrets.revoke) throw new TypeError('Private facade secret store required');
  if (presentation !== undefined && typeof presentation !== 'function') throw new TypeError('Voice presentation must be a function of the session locale');
  if (![reconcileIntervalMs, reconcileBatchSize, reconcileLookupTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0) ||
    log !== undefined && typeof log !== 'function') throw new TypeError('Invalid voice reconciliation retry bounds');
  const calls = new Map(), sessions = new Map(), settlements = new Set();
  if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs <= 0) throw new TypeError('Invalid voice turn timeout');
  const turns = createVoiceTurnOperations({ storage, now, replayWindowMs: turnReplayWindowMs,
    authorizeReplacement: authorizeTurnReplacement && (args => {
      const entry = calls.get(args.operation.callId);
      return authorizeTurnReplacement({ ...args, session: sessionFor(entry) });
    }) });
  let reconcileTimer, reconcileJob, retryOffset = 0, stopping = false;
  const pendingReconciliations = () => storage.voiceCalls().filter(record => record.reconciliationPending);
  const diagnostic = (record, event, fields) => {
    try { log?.({ event, callId: record.callId, providerSessionId: record.providerSessionId, ...fields }); }
    catch { /* Operator diagnostics must never interrupt accounting. */ }
  };
  async function reconcile(record) {
    try {
      // The budget marker survives a crash before cap settlement or journal acknowledgement.
      // Replay that value rather than fetching a potentially changed provider duration.
      const row = runtime.budget.get(record.attemptId);
      const savedReconciliation = row?.voice_reconciliation_json ? JSON.parse(row.voice_reconciliation_json) : null;
      const result = savedReconciliation && !savedReconciliation.usage?.costEstimated ? savedReconciliation
        : closeOrphan ? await voiceOperation({ deadlineAt: Date.now() + reconcileLookupTimeoutMs }, opts => closeOrphan(record, opts)) : null;
      if (result?.closureConfirmed === true && result.providerSessionId === record.providerSessionId) {
        runtime.reconcileVoice(record.attemptId, result);
        const saved = storage.voiceCalls(record.sessionId).find(c => c.providerSessionId === record.providerSessionId);
        storage.saveVoiceCall(record.sessionId, { ...saved, reconciliation: result, reconciliationPending: result.usage?.costEstimated === true });
        publish(record.sessionId, { type: 'voice.state', data: { callId: record.callId, providerSessionId: record.providerSessionId,
          state: 'ended', reason: record.reason, reconciliationPending: result.usage?.costEstimated === true,
          terminal: { outcome: result.outcome, closureConfirmed: true, usage: result.usage } } });
        diagnostic(record, 'voice.cost-reconciled', { chargedMicro: result.usage.upstreamMicro, costEstimated: result.usage.costEstimated === true });
      }
    } catch (error) {
      diagnostic(record, 'voice.reconciliation-retry', { code: error instanceof PluginError ? error.code : 'provider' });
      // Durable pending reconciliation remains visible and retryable.
    }
  }
  function reconcileLater() {
    if (stopping || !closeOrphan || reconcileTimer || reconcileJob) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = undefined;
      reconcileJob = (async () => {
        const records = pendingReconciliations(), count = Math.min(records.length, reconcileBatchSize);
        for (let i = 0; i < count && !stopping; i++) await reconcile(records[(retryOffset + i) % records.length]);
        retryOffset = records.length ? (retryOffset + count) % records.length : 0;
      })().finally(() => {
        reconcileJob = undefined;
        if (!stopping && pendingReconciliations().length) reconcileLater();
      });
    }, reconcileIntervalMs);
    reconcileTimer.unref?.();
  }
  const sessionFor = entry => {
    const session = storage.authorize(entry.sessionId, entry.ownerToken);
    if ((session.conversationConsentRevision ?? session.consentRevision) !== entry.conversationConsentRevision ||
      session.withdrawalRevision !== entry.withdrawalRevision) throw new PluginError('not-admitted', 'Call context revoked');
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
          reconciliationPending: terminal.outcome === 'uncertain' || terminal.usage?.costEstimated === true,
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
      conversationConsentRevision: session.conversationConsentRevision ?? session.consentRevision, withdrawalRevision: session.withdrawalRevision,
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
      // Trusted presentation from the conversation's locale, including its AI notice (AIT-127).
      const overrides = presentation?.(session.locale);
      entry.call = await admitted.plugin.start({ callId, sessionId, ownerToken, facadeSecretRef: entry.facadeSecretRef,
        facadeUrl: `${admitted.binding.publicFacadeBaseUrl}${staticSecretRef ? CUSTOM_LLM_BASE_PATH : `/api/voice/${callId}/llm`}`,
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
  function buildVoiceRequest(session, messages, call) {
    const latestInput = unrecordedVoiceInput(session, messages, call);
    const trusted = reasoningRequest(session, 'reaction', false, hostPrompt, { pendingInput: latestInput.length > 0 });
    // Focus is derived by the asynchronous understanding lane. It is usable
    // only once that final assessment covers every input in this reply request.
    const currentFocus = !latestInput.length && !session.understanding.draft &&
      session.understanding.inputRevision === inputRevision(session) &&
      session.understanding.openQuestions?.includes(session.focusedQuestion);
    // The session owns history, including typed turns, withdrawals and heard
    // prefixes. Provider text supplies only the newest unrecorded person input.
    return { ...trusted, system: `${trusted.system}\n${VOICE_REPLY_POLICY}`, messages: [...trusted.messages,
      ...(currentFocus && session.focusedQuestion ? [{ role: 'user', content: JSON.stringify({ kind: 'untrusted-focused-question', question: session.focusedQuestion }) }] : []),
      ...latestInput] };
  }
  const facade = createCompletionsHandler({ resolveSecret: secrets.resolve, staticSecretRef, timeoutMs: turnTimeoutMs,
    turnOperations: {
      run(context, execute, options) {
        const entry = calls.get(context.callId);
        sessionFor(entry);
        return turns.run({ ...context, sessionId: entry.sessionId }, execute, options);
      },
    },
    getCall(request, options, identity) {
      const entry = staticSecretRef ? [...calls.values()].find(entry => entry.facadeCallId === identity)
        : calls.get(facadeRoute.exec(new URL(request.url).pathname)?.[1]);
      if (!entry?.call || entry.closing || sessions.get(entry.sessionId) !== entry) return null;
      try { sessionFor(entry); } catch { throw new PluginError('not-admitted', 'Call ownership or context revoked'); }
      return { ...entry.call.snapshot(), facadeSecretRef: entry.facadeSecretRef, facadeCallId: entry.facadeCallId, signal: entry.call.signal };
    },
    buildRequest({ callId, messages }) {
      const entry = calls.get(callId);
      return buildVoiceRequest(sessionFor(entry), messages, entry.call);
    },
    async admitReasoning({ callId, messages, options, beforeAdmission }) {
      const entry = calls.get(callId);
      let session = sessionFor(entry);
      for (let retry = 0; ; retry++) {
        try {
          await runtime.checkVoice(session, { ...options, existingCall: true });
          // Build and admit from one snapshot, including input saved while the
          // voice check awaited. The facade must dispatch this admitted request.
          session = sessionFor(entry);
          const request = buildVoiceRequest(session, messages, entry.call);
          beforeAdmission?.();
          return { ...await runtime.admit({ session, lane: 'reaction', operation: 'stream', request,
            options: { ...options, voiceReply: true } }), request };
        } catch (error) {
          // sessionFor strictly fences ownership, consent and withdrawal before
          // considering a retry. Only append-only finals are benign at dispatch.
          const fresh = sessionFor(entry);
          if (retry || !(error instanceof PluginError) || error.code !== 'not-admitted' ||
            !['Session changed', 'Session changed during admission'].includes(error.message) ||
            inputRevision(fresh) === inputRevision(session) || fresh.paused || fresh.locale !== session.locale ||
            fresh.settings?.revision !== session.settings?.revision ||
            runtime.selectionKey(fresh, 'voice') !== runtime.selectionKey(session, 'voice')) throw error;
          options.signal?.throwIfAborted();
          session = fresh;
        }
      }
    },
    onCompletion({ callId, providerSessionId, replyId, content, textOrigin, engine, userTurnOrdinal }) {
      const entry = calls.get(callId);
      if (!entry?.call || entry.closing || entry.call.providerSessionId !== providerSessionId) return;
      entry.produced ??= [];
      entry.produced.push({ replyId, content, textOrigin, engine, userTurnOrdinal });
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
        if (action === 'close') {
          const pending = close(entry, typeof body.reason === 'string' ? body.reason.slice(0, 128) : 'closed');
          // Billing confirmation outlives the browser command. Exposure has already
          // been retained synchronously; idle/shutdown still await this settlement.
          if (body.background === true) return json({ closureConfirmed: false, reconciliationPending: true }, 202);
          return json(await pending);
        }
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
          // The completion ID belongs to one operation. Text only attests that
          // receipt's bytes; it never selects a reply or supplies an ordinal.
          const prior = body.event?.type === 'reply' && fresh.transcript.find(turn => turn.id === body.event.turnId && turn.role === 'assistant');
          const produced = (body.event?.role === 'assistant' || prior) && typeof body.event.replyId === 'string' &&
            entry.produced?.find(reply => reply.replyId === body.event.replyId &&
              (prior ? Boolean(prior.content) && reply.content.startsWith(prior.content) : reply.content === body.event.text));
          const provenance = produced ? 'facade-produced' : 'browser-asserted';
          const result = storage.postVoiceEvent(sessionId, callId, entry.call.providerSessionId, body.event,
            { ownerToken, revision: inputRevision(fresh), provenance,
              ...(produced ? { ...produced.textOrigin, engine: produced.engine, replyId: produced.replyId,
                userTurnOrdinal: produced.userTurnOrdinal } : aiTextOrigin(entry.admission.binding)) });
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
        if (error instanceof PluginError) return json({ error: error.code,
          ...(VOICE_CAP_REASONS.has(error.message) ? { reason: error.message } : {}) }, error.code === 'not-admitted' ? 403 : error.code === 'deadline' ? 504 : 502);
        return json({ error: 'voice-unavailable' }, 503);
      }
    },
    async resume() {
      turns.recover();
      runtime.recoverVoiceCap?.();
      // The exclusive writer has already conservatively recovered all open claims.
      for (let record of storage.voiceCalls()) {
        if (!staticSecretRef) await secrets.revoke(record.facadeSecretRef);
        const row = runtime.budget.get(record.attemptId);
        // A final receipt can be journalled immediately before a crash in budget
        // settlement. Replay its actual cost rather than abandoning that receipt.
        if (record.terminal?.closureConfirmed === true && record.terminal.usage &&
          !record.terminal.usage.costEstimated && row?.state === 'settled') {
          try { runtime.reconcileVoice(record.attemptId, { ...record.terminal, providerSessionId: record.providerSessionId }); }
          catch { record = { ...record, reconciliationPending: true }; }
        }
        if (record.terminal && !record.reconciliationPending) continue;
        storage.saveVoiceCall(record.sessionId, { ...record, closing: true, endedAt: record.endedAt ?? now(), reason: record.reason ?? 'server-restart',
          terminal: record.terminal ?? { attemptId: record.attemptId, outcome: row?.outcome ?? 'uncertain', closureConfirmed: false,
            chargedMicro: row?.settled_micro ?? record.maxMicro }, reconciliationPending: true });
        await reconcile(record);
      }
      if (pendingReconciliations().length) reconcileLater();
    },
    reconcileLater,
    async idle() { while (settlements.size) await Promise.allSettled([...settlements]); await turns.idle(); },
    async close() {
      stopping = true; clearTimeout(reconcileTimer);
      for (const id of sessions.keys()) this.stopSession(id, 'server-stopping');
      await this.idle(); await reconcileJob;
    },
  };
}
