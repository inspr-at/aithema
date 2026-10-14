import { PluginError, inputRevision, reasoningRequest, aiTextOrigin, voiceAuthorizationRevision, recoverableVoiceEnd } from '@inspr/aithema-core';
import { voiceOperation } from '../../core/src/live-voice.js';
import { ConflictError, NotFoundError } from './storage.js';
import { VOICE_CAP_REASONS } from './voice-cap.js';
import { createVoiceTurnOperations } from './voice-turns.js';
import { createVoiceDiagnostics, voiceReconciliationAge } from './voice-observability.js';

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const idPattern = '[a-zA-Z0-9_-]{1,128}';
const routes = new RegExp(`^/api/sessions/(${idPattern})/voice(?:/(${idPattern})/(pause|resume|heartbeat|close|recover|events|takeover|replay)|/(replay))?$`, 'u');
// Route declarations are adapter-owned; parameter syntax is shared by the mount.
const matchesCallback = (route, path) => {
  const declared = route.path.split('/'), actual = path.split('/');
  return declared.length === actual.length && declared.every((part, i) => part.startsWith(':')
    ? new RegExp(`^${idPattern}$`, 'u').test(actual[i]) : part === actual[i]);
};
const reservedCallbackPrefixes = ['/api/sessions', '/api/library', '/api/visitor', '/api/operator', '/privacy', '/confirm-email', '/healthz'];
function registerCallbacks(callbacks) {
  for (const route of callbacks?.callbackRoutes ?? []) {
    const declared = route.path.split('/');
    if (reservedCallbackPrefixes.some(prefix => prefix.split('/').every((part, i) =>
      declared[i] === part || declared[i]?.startsWith(':')))) throw new TypeError('Reserved core route prefix');
  }
  return callbacks;
}

// Voice-only guidance composes with core's shared policies via reasoningRequest.
const VOICE_REPLY_POLICY = `Voice reply guidance:
A focused question is only a suggestion: check the conversation before asking it, even when understanding is current.
When understanding is stale or draft, ignore its open questions as next-question candidates. If the latest answer resolves the preceding question, acknowledge it briefly and let the assessment catch up; do not repeat the question or claim the assessment is complete.
Use two or three short sentences, usually at most 60 words, and at most one question about a genuinely unresolved point. A question is optional; answer the person's immediate request first.
Do not read back the running summary or recap the whole answer. Speak naturally without lists or reasoning aloud.
Start with the substance: react to the specific content or answer the request directly, without any opening thanks formula.`;

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

export { createFacadeSecrets } from '../elevenlabs-compat.js';

export function createVoiceHandlers({ storage, runtime, ownership, readBody, secrets,
  publish, onTurn, onClose, onActivity, onAssessment, purposePolicy, hostPrompt = '', now = Date.now, browserLeaseMs = 30_000, deadlineMs = 30_000,
  closeOrphan, staticSecretRef, presentation, callbackAdapter, reconcileIntervalMs = 30_000, reconcileBatchSize = 10,
  reconcileLookupTimeoutMs = 5000, log,
  turnReplayWindowMs, turnTimeoutMs = 30_000, authorizeTurnReplacement } = {}) {
  if (![reconcileIntervalMs, reconcileBatchSize, reconcileLookupTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0) ||
    log !== undefined && typeof log !== 'function') throw new TypeError('Invalid voice reconciliation retry bounds');
  const calls = new Map(), sessions = new Map(), settlements = new Set(), authorities = new Map();
  const tabAuthority = (sessionId, callId) => {
    const logical = storage.voiceLifecycle(sessionId, callId);
    return { epoch: logical?.epoch ?? 0, controllingTabId: logical?.controllingTabId ?? null };
  };
  const endAuthority = (sessionId, callId) => {
    const key = `${sessionId}:${callId}`; authorities.get(key)?.controller.abort(); authorities.delete(key);
  };
  if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs <= 0) throw new TypeError('Invalid voice turn timeout');
  const turns = createVoiceTurnOperations({ storage, now, log, replayWindowMs: turnReplayWindowMs,
    authorizeReplacement: authorizeTurnReplacement && (args => {
      const entry = calls.get(args.operation.callId);
      return authorizeTurnReplacement({ ...args, session: sessionFor(entry) });
    }) });
  let reconcileTimer, reconcileJob, retryOffset = 0, repairOffset = 0, stopping = false;
  const pendingReconciliations = () => storage.voiceCalls().filter(record => {
    const terminal = record.reconciliation ?? record.terminal;
    return record.reconciliationPending || terminal?.closureConfirmed === false || terminal?.usage?.costEstimated === true;
  });
  const emitDiagnostic = createVoiceDiagnostics({ log });
  const diagnostic = (record, event, fields) => emitDiagnostic(event, record,
    { ...fields, reconciliationAgeMs: voiceReconciliationAge(record, now()) });
  async function reconcile(record) {
    try {
      // The budget marker survives a crash before cap settlement or journal acknowledgement.
      // Replay that value rather than fetching a potentially changed provider duration.
      const row = runtime.budget.get(record.attemptId);
      const savedReconciliation = row?.voice_reconciliation_json ? JSON.parse(row.voice_reconciliation_json) : null;
      const result = savedReconciliation && !savedReconciliation.usage?.costEstimated ? savedReconciliation
        : closeOrphan ? await voiceOperation({ deadlineAt: Date.now() + reconcileLookupTimeoutMs }, opts => closeOrphan(record, opts)) : null;
      if (result?.closureConfirmed === true && result.providerSessionId === record.providerSessionId) {
        storage.transitionVoiceLifecycle(record.sessionId, record.callId,
          { type: 'segment-closed', providerSessionId: record.providerSessionId, closureConfirmed: true });
        runtime.reconcileVoice(record.attemptId, result);
        const saved = storage.voiceCalls(record.sessionId).find(c => c.providerSessionId === record.providerSessionId);
        storage.saveVoiceCall(record.sessionId, { ...saved, reconciliation: result, reconciliationPending: result.usage?.costEstimated === true });
        const logical = storage.voiceLifecycle(record.sessionId, record.callId);
        publish(record.sessionId, { type: 'voice.state', data: { callId: record.callId, providerSessionId: record.providerSessionId,
          ...tabAuthority(record.sessionId, record.callId),
          state: logical && logical.state !== 'idle' ? logical.state : recoverableVoiceEnd(record.reason)
            ? record.reason === 'browser-liveness-deadline' ? 'waiting' : 'recovering' : 'ended',
          reason: logical?.terminalReason ?? record.reason, reconciliationPending: result.usage?.costEstimated === true,
          terminal: { outcome: result.outcome, closureConfirmed: true, usage: result.usage } } });
        turns.observeClosure(record, result);
        diagnostic(record, 'voice.cost-reconciled', { chargedMicro: result.usage.upstreamMicro, costEstimated: result.usage.costEstimated === true, closureConfirmed: true });
      }
    } catch (error) {
      diagnostic(record, 'voice.reconciliation-retry', { code: error instanceof PluginError ? error.code : 'provider', cause: error instanceof PluginError ? error.code : 'provider' });
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
  const controlsEpoch = entry => {
    const logical = storage.voiceLifecycle(entry.sessionId, entry.callId);
    return logical?.epoch === entry.epoch && logical?.controllingTabId === entry.tabId;
  };
  const sessionFor = entry => {
    if (!controlsEpoch(entry)) throw new ConflictError('Voice ownership lost');
    const session = storage.authorize(entry.sessionId, entry.ownerToken);
    if ((session.conversationConsentRevision ?? session.consentRevision) !== entry.conversationConsentRevision ||
      session.withdrawalRevision !== entry.withdrawalRevision) throw new PluginError('not-admitted', 'Call context revoked');
    return session;
  };
  const receipt = call => ({ callId: call.callId, providerSessionId: call.providerSessionId, credential: call.credential,
    epoch: calls.get(call.callId)?.epoch, controllingTabId: calls.get(call.callId)?.tabId,
    ...calls.get(call.callId)?.callbackContext?.receipt,
    spendDeadlineAt: call.spendDeadlineAt, browserLivenessDeadlineAt: call.browserLivenessDeadlineAt,
    presentation: calls.get(call.callId)?.presentation ?? 'opening',
    ...(call.overrides ? { overrides: call.overrides } : {}) });
  const options = request => ({ signal: request.signal, deadlineAt: Date.now() + deadlineMs });
  function revoke(entry) { entry.callbackContext?.revoke(); }
  function close(entry, reason = 'closed', outcome = 'completed') {
    if (entry.closing) return entry.closing;
    runtime.stopReplyReplay?.(entry.sessionId);
    const resumable = recoverableVoiceEnd(reason);
    // Logical terminal intent commits before abort/settlement. A provider terminal
    // receipt only closes its own segment and cannot reopen the logical call.
    if (!resumable || storage.voiceLifecycle(entry.sessionId, entry.callId)?.state !== 'waiting') {
      storage.transitionVoiceLifecycle(entry.sessionId, entry.callId, { type: resumable
        ? reason === 'browser-liveness-deadline' ? 'lease-expired' : 'transport-lost' : 'end', reason });
    }
    // Transport replacement ends readers/media, not already admitted reasoning.
    // Terminal intent and revocation still stop every generation of logical work.
    if (!resumable || reason === 'server-stopping') endAuthority(entry.sessionId, entry.callId);
    // Install the promise before close() aborts the provider signal synchronously.
    let resolve, reject;
    const closing = new Promise((yes, no) => { resolve = yes; reject = no; });
    entry.closing = closing; settlements.add(closing);
    closing.catch(() => {}).finally(() => settlements.delete(closing));
    revoke(entry);
    onClose?.(entry.sessionId);
    if (sessions.get(entry.sessionId) === entry) sessions.delete(entry.sessionId);
    publish(entry.sessionId, { type: 'voice.state', data: { callId: entry.callId,
      ...tabAuthority(entry.sessionId, entry.callId),
      providerSessionId: entry.call?.providerSessionId,
      state: resumable ? storage.voiceLifecycle(entry.sessionId, entry.callId).state : 'closing', reason } });
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
        if (terminal?.closureConfirmed === true) storage.transitionVoiceLifecycle(entry.sessionId, entry.callId,
          { type: 'segment-closed', providerSessionId: entry.call.providerSessionId, closureConfirmed: true });
        try {
          if (terminal) {
            const record = storage.voiceCalls(entry.sessionId).find(call => call.callId === entry.callId && call.providerSessionId === entry.call?.providerSessionId);
            turns.observeClosure(record ?? { sessionId: entry.sessionId, callId: entry.callId,
              providerSessionId: entry.call?.providerSessionId, endedAt: now() }, terminal);
          }
        } catch { /* Diagnostics cannot interrupt settlement. */ }
        entry.admission?.finish();
        // An old recovery's settlement cannot publish over or remove its successor.
        const logical = storage.voiceLifecycle(entry.sessionId, entry.callId);
        if (terminal && calls.get(entry.callId) === entry) publish(entry.sessionId, { type: 'voice.state', data: {
          ...tabAuthority(entry.sessionId, entry.callId),
          callId: entry.callId, providerSessionId: entry.call.providerSessionId, state: logical?.state ?? (resumable ? 'recovering' : 'ended'),
          reason: logical?.terminalReason ?? reason,
          reconciliationPending: terminal.outcome === 'uncertain' || terminal.usage?.costEstimated === true,
          terminal: { outcome: terminal.outcome, closureConfirmed: terminal.closureConfirmed, usage: terminal.usage ?? null } } });
        resolve(terminal);
      } catch (error) { reject(error); }
      finally { if (calls.get(entry.callId) === entry) calls.delete(entry.callId); }
    };
    void settle(); return closing;
  }
  async function start(request, sessionId, ownerToken, callId, spendDeadlineAt, continuation = false, tabId = null) {
    const session = storage.authorize(sessionId, ownerToken);
    if (sessions.has(sessionId)) throw new ConflictError('Voice call already active');
    const authorityKey = `${sessionId}:${callId}`;
    if (!authorities.has(authorityKey)) authorities.set(authorityKey, { sessionId, callId, controller: new AbortController() });
    const authority = authorities.get(authorityKey).controller;
    if (!continuation) storage.transitionVoiceLifecycle(sessionId, callId, { type: 'start', tabId });
    const logical = storage.voiceLifecycle(sessionId, callId);
    const controller = new AbortController(), started = Promise.withResolvers(), entry = { callId, sessionId, ownerToken, controller, started: started.promise,
      tabId: logical.controllingTabId, epoch: logical.epoch,
      conversationConsentRevision: session.conversationConsentRevision ?? session.consentRevision, withdrawalRevision: session.withdrawalRevision,
      settingsRevision: session.settings?.revision ?? 0, presentation: continuation ? 'continuation' : 'opening', authority };
    sessions.set(sessionId, entry); calls.set(callId, entry);
    const abortStartup = () => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', abortStartup, { once: true });
    if (request.signal.aborted) abortStartup();
    try {
      const opts = { ...options(request), signal: controller.signal };
      const admitted = await runtime.admitVoice({ session, request: { callId }, options: {
        ...opts, spendDeadlineAt, allowPaused: continuation, voiceContinuation: continuation,
      } }); entry.admission = admitted;
      const end = spendDeadlineAt ?? now() + admitted.binding.maxDurationSeconds * 1000;
      if (end <= now()) throw new PluginError('deadline');
      const callbacks = adapterCallbacks(admitted.plugin.ports?.serverAdapter);
      entry.callbackContext = callbacks?.prepareCallback?.({ callId, binding: admitted.binding, locale: session.locale, continuation });
      await entry.callbackContext?.prepare();
      controller.signal.throwIfAborted();
      const callbackRequest = entry.callbackContext?.request ?? {}, { overrides, ...startRequest } = callbackRequest;
      entry.call = await admitted.plugin.start({ callId, sessionId, ownerToken, ...startRequest,
        settingsRevision: session.settings?.revision ?? 0, ...(Object.hasOwn(callbackRequest, 'overrides') ? { overrides } : {}) },
        { ...admitted.options, spendDeadlineAt: end, browserLivenessDeadlineAt: Math.min(end, now() + browserLeaseMs) });
      entry.call.signal.addEventListener('abort', () => {
        void close(entry, entry.call.snapshot().reason ?? 'cancelled', 'cancelled');
      }, { once: true });
      if (entry.call.signal.aborted) { void close(entry, 'start-cancelled', 'cancelled'); throw new PluginError('cancelled'); }
      const fresh = sessionFor(entry);
      if (storage.voiceLifecycle(sessionId, callId)?.state === 'ended' || voiceAuthorizationRevision(fresh) !== voiceAuthorizationRevision(session)) {
        void close(entry, 'call-authorization-lost', 'cancelled'); throw new PluginError('not-admitted');
      }
      storage.transitionVoiceLifecycle(sessionId, callId, { type: 'connected', epoch: entry.epoch, providerSessionId: entry.call.providerSessionId,
        authorizationRevision: voiceAuthorizationRevision(fresh), spendDeadlineAt: end,
        browserLivenessDeadlineAt: entry.call.browserLivenessDeadlineAt });
      if (fresh.paused) storage.transitionVoiceLifecycle(sessionId, callId, { type: 'pause' });
      const state = storage.voiceLifecycle(sessionId, callId);
      if (continuation) {
        try {
          const previous = storage.voiceCalls(sessionId).findLast(record => record.callId === callId && record.providerSessionId !== state.providerSessionId);
          emitDiagnostic('voice.segment.reconnect', { callId, providerSessionId: state.providerSessionId }, { cause: previous?.reason ?? 'transport-lost' });
        } catch { /* Diagnostics cannot interrupt recovery. */ }
      }
      publish(sessionId, { type: 'voice.state', data: { callId, providerSessionId: state.providerSessionId,
        epoch: state.epoch, controllingTabId: state.controllingTabId, state: state.state } });
      return receipt(entry.call);
    } catch (error) {
      revoke(entry); controller.abort(); if (!entry.call) entry.admission?.finish();
      if (!continuation && !entry.call) endAuthority(sessionId, callId);
      if (sessions.get(sessionId) === entry) sessions.delete(sessionId);
      if (calls.get(callId) === entry) calls.delete(callId);
      throw error;
    } finally { started.resolve(); request.signal.removeEventListener('abort', abortStartup); }
  }
  function buildVoiceRequest(session, messages, call) {
    const latestInput = unrecordedVoiceInput(session, messages, call);
    const person = session.transcript.findLast(turn => turn.role === 'user' && !turn.erased && !turn.withdrawn);
    const normalize = text => text?.trim().replace(/\s+/gu, ' ');
    // This recognizes prompt input covered by the canonical typed revision.
    // It never supplies an operation key, ordinal, claim or paid state (Rule C).
    const typedEcho = person?.voiceCallId === call.callId && person.voiceProviderId === call.providerSessionId &&
      latestInput.length > 0 && normalize(person.content) === normalize(latestInput.at(-1).content);
    const trusted = reasoningRequest(session, 'reaction', false, hostPrompt, { pendingInput: latestInput.length > 0, voiceReply: true, purposePolicy,
      offTopicTurns: storage.safeguards(session.id).offTopicTurns });
    // Focus is derived by the asynchronous understanding lane. It is usable
    // only once that final assessment covers every input in this reply request.
    const currentFocus = !latestInput.length && !session.understanding.draft &&
      session.understanding.inputRevision === inputRevision(session) &&
      session.understanding.openQuestions?.includes(session.focusedQuestion);
    // The session owns history, including typed turns, withdrawals and heard
    // prefixes. Provider text supplies only the newest unrecorded person input.
    return { ...trusted, ...(purposePolicy && (!latestInput.length || typedEcho) ? { safeguardRevision: inputRevision(session) } : {}), system: `${trusted.system}\n${VOICE_REPLY_POLICY}`, messages: [...trusted.messages,
      ...(currentFocus && session.focusedQuestion ? [{ role: 'user', content: JSON.stringify({ kind: 'untrusted-focused-question', question: session.focusedQuestion }) }] : []),
      ...latestInput] };
  }
  const callbackOperations = { secrets, staticSecretRef, presentation, timeoutMs: turnTimeoutMs, log,
    turnOperations: {
      run(context, execute, options) {
        const entry = calls.get(context.callId);
        sessionFor(entry);
        return turns.run({ ...context, sessionId: entry.sessionId }, execute, options);
      },
    },
    getCall(identity, { callbackIdentity = false } = {}) {
      const entry = callbackIdentity ? [...calls.values()].find(entry => entry.callbackContext?.identity === identity)
        : calls.get(identity);
      if (!entry?.call || entry.closing || sessions.get(entry.sessionId) !== entry) return null;
      try { sessionFor(entry); } catch { throw new PluginError('not-admitted', 'Call ownership or context revoked'); }
      return { ...entry.call.snapshot(), ...entry.callbackContext?.details,
        ...(purposePolicy && storage.safeguards(entry.sessionId).offTopicTurns >= purposePolicy.offTopicLimit ? { paused: true } : {}),
        signal: entry.authority.signal, readerCurrent: () => controlsEpoch(entry) };
    },
    buildRequest({ callId, messages }) {
      const entry = calls.get(callId);
      return buildVoiceRequest(sessionFor(entry), messages, entry.call);
    },
    async admitReasoning({ callId, messages, options, beforeAdmission, onRetry, safeguardRetry }) {
      const entry = calls.get(callId);
      let session = sessionFor(entry);
      for (let retry = 0; ; retry++) {
        try {
          await runtime.checkVoice(session, { ...options, existingCall: true });
          // Build and admit from one snapshot, including input saved while the
          // voice check awaited. The facade must dispatch this admitted request.
          session = sessionFor(entry);
          const request = buildVoiceRequest(session, messages, entry.call);
          if (safeguardRetry) request.system += '\nThe previous output was rejected. Return only safe reply JSON following the purpose policy; never echo rejected text.';
          beforeAdmission?.();
          const beforeDispatch = () => {
            try {
              const fresh = sessionFor(entry);
              return !fresh.paused && voiceAuthorizationRevision(fresh) === voiceAuthorizationRevision(session);
            } catch { return false; }
          };
          const admission = await runtime.admit({ session, lane: 'reaction', operation: 'stream', request,
            options: { ...options, voiceReply: true, beforeDispatch } });
          // A reservation is still undispatched. Takeover during admission must
          // release it, while a dispatched claim retains its original lifetime.
          if (!beforeDispatch()) {
            await admission.finish({ failed: true });
            throw new PluginError('not-admitted', 'Call ownership or context revoked');
          }
          return { ...admission, request, guardDirection: reply => {
            sessionFor(entry);
            return storage.guardPurposeDirection(entry.sessionId, reply, purposePolicy,
              // This counts unclear inputs only; Rule C still owns paid identity.
              request.safeguardRevision ? undefined : JSON.stringify(['voice', callId, messages.filter(message => message.role === 'user').length]));
          } };
        } catch (error) {
          // sessionFor strictly fences ownership, consent and withdrawal before
          // considering a retry. Only append-only finals are benign at dispatch.
          let fresh;
          try { fresh = sessionFor(entry); }
          catch { throw new PluginError('not-admitted', 'Call ownership or context revoked'); }
          if (retry || !(error instanceof PluginError) || error.code !== 'not-admitted' ||
            !['Session changed', 'Session changed during admission'].includes(error.message) ||
            inputRevision(fresh) === inputRevision(session) || fresh.paused || fresh.locale !== session.locale ||
            fresh.settings?.revision !== session.settings?.revision ||
            runtime.selectionKey(fresh, 'voice') !== runtime.selectionKey(session, 'voice')) throw error;
          options.signal?.throwIfAborted();
          onRetry?.('session-changed');
          session = fresh;
        }
      }
    },
    onCompletion({ callId, providerSessionId, replyId, content, textOrigin, engine, userTurnOrdinal, scope, safeguardRevision }) {
      const entry = calls.get(callId);
      if (!entry?.call || entry.closing || entry.call.providerSessionId !== providerSessionId) return;
      entry.produced ??= [];
      entry.produced.push({ replyId, content, textOrigin, engine, userTurnOrdinal });
      if (purposePolicy) {
        const session = sessionFor(entry);
        const person = session.transcript.findLast(turn => turn.role === 'user' && !turn.erased && !turn.withdrawn);
        const revision = person?.callId === callId && person.providerSessionId === providerSessionId &&
          person.userTurnOrdinal === userTurnOrdinal && Number.isSafeInteger(userTurnOrdinal) ? inputRevision(session) : safeguardRevision;
        storage.recordSafeguard(entry.sessionId, `voice:${callId}:${providerSessionId}:${userTurnOrdinal ?? replyId}`,
          revision, scope === 'off', purposePolicy.offTopicLimit, { pause: false });
        if (scope !== 'off' && revision) onAssessment?.(entry.sessionId);
      }
      while (entry.produced.length > 256 || entry.produced.reduce((n, reply) => n + reply.content.length, 0) > 1_048_576) entry.produced.shift();
    },
    onDelivered({ callId }) {
      const entry = calls.get(callId);
      if (!purposePolicy || !entry) return;
      const event = storage.pauseForPurpose(entry.sessionId, purposePolicy.offTopicLimit);
      if (event) {
        publish(entry.sessionId, event);
        void close(entry, 'purpose', 'cancelled');
      }
    },
  };
  const boundCallbacks = new WeakMap();
  function adapterCallbacks(adapter = callbackAdapter ?? secrets?.serverAdapter) {
    if (!adapter) return;
    if (!boundCallbacks.has(adapter)) boundCallbacks.set(adapter,
      registerCallbacks(adapter.bindCallbacks ? adapter.bindCallbacks(callbackOperations) : adapter));
    return boundCallbacks.get(adapter);
  }
  const callbackAdapters = () => [...new Set([...(runtime?.voiceServerAdapters?.() ?? []),
    callbackAdapter ?? secrets?.serverAdapter])].filter(Boolean).map(adapter => adapterCallbacks(adapter));
  // Validate configured adapters and register their routes before accepting traffic.
  callbackAdapters();
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
    const ack = await entry.call.resume({ ...opts, guard: { authorizationRevision: voiceAuthorizationRevision(session) } });
    storage.transitionVoiceLifecycle(entry.sessionId, entry.callId, { type: 'resume-acknowledged' });
    return ack;
  }
  return {
    active: id => sessions.has(id),
    delegatesReply: id => Boolean(sessions.get(id)?.callbackContext?.request),
    snapshot(id) {
      const logical = storage.voiceLifecycle(id);
      if (!logical || logical.state === 'idle') return null;
      // Authority revisions and checkpoints remain private; the UI needs only
      // public identity and state to offer an explicitly requested continuation.
      const { callId, providerSessionId, providerGeneration, state, attempts, needsRecovery,
        spendDeadlineAt, browserLivenessDeadlineAt, epoch, controllingTabId } = logical;
      return { callId, providerSessionId, providerGeneration, state, attempts, needsRecovery,
        spendDeadlineAt, browserLivenessDeadlineAt, epoch, controllingTabId,
        ...(logical.holds.includes('server-restart') ? { reason: 'server-restart' } : {}) };
    },
    typedContext(id, ownerToken, callId, providerSessionId) {
      const entry = calls.get(callId);
      if (!entry?.call || entry.sessionId !== id || entry.ownerToken !== ownerToken || entry.call.providerSessionId !== providerSessionId) throw new NotFoundError('Call not found');
      const session = sessionFor(entry);
      if (session.paused || session.consentWithdrawn) throw new PluginError('not-admitted');
      if (entry.closing || entry.call.signal.aborted) return {};
      return { voiceCallId: callId, voiceProviderId: providerSessionId };
    },
    stopSession(id, reason = 'session-revoked') {
      runtime.stopReplyReplay?.(id);
      const entry = sessions.get(id);
      if (entry) void close(entry, reason, 'cancelled');
      for (const authority of authorities.values()) if (authority.sessionId === id) {
        storage.transitionVoiceLifecycle(id, authority.callId, { type: 'end', reason }); endAuthority(id, authority.callId);
      }
    },
    async pauseSession(id, paused, opts = {}) {
      if (paused) runtime.stopReplyReplay?.(id);
      const entry = sessions.get(id);
      if (!entry?.call) return null;
      const ack = await changePause(entry, paused, opts);
      if (!paused) onActivity?.(sessionFor(entry));
      return ack;
    },
    async handle(request) {
      const path = new URL(request.url).pathname;
      let methodNotAllowedStatus;
      for (const callbacks of callbackAdapters()) {
        for (const route of callbacks?.callbackRoutes ?? []) {
          if (!matchesCallback(route, path)) continue;
          if (route.method === request.method) return route.handle(request);
          methodNotAllowedStatus ??= route.methodNotAllowedStatus ?? 405;
        }
      }
      if (methodNotAllowedStatus) return json({ error: methodNotAllowedStatus === 404 ? 'not-found' : 'method-not-allowed' }, methodNotAllowedStatus);
      const match = routes.exec(path); if (!match) return null;
      try {
        const [, sessionId, callId, callAction, pageAction] = match, action = callAction ?? pageAction, ownerToken = ownership.token(request);
        storage.authorize(sessionId, ownerToken);
        if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
        const bytes = await readBody(request, 65_536), body = bytes.length ? JSON.parse(Buffer.from(bytes).toString('utf8')) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Invalid body');
        if (body.tabId !== undefined && (typeof body.tabId !== 'string' || !new RegExp(`^${idPattern}$`, 'u').test(body.tabId)) ||
          body.epoch !== undefined && (!Number.isSafeInteger(body.epoch) || body.epoch < 0)) throw new TypeError('Invalid tab authority');
        if (action === 'recover' && body.explicit !== undefined && typeof body.explicit !== 'boolean') throw new TypeError('Invalid recovery intent');
        // Purpose pause is terminal for paid voice, including recovery paths that
        // deliberately allow a manually paused conversation to reconnect.
        if (purposePolicy && storage.get(sessionId).pauseReason === 'purpose' && action !== 'close') {
          return json({ error: 'conversation-paused', reason: 'purpose' }, 409);
        }
        if (action === 'replay') {
          if (body.replayId !== undefined && (typeof body.replayId !== 'string' || !new RegExp(`^${idPattern}$`, 'u').test(body.replayId))) throw new TypeError('Invalid replay identity');
          if (body.stop === true) {
            if (!body.replayId) throw new TypeError('Replay identity required');
            runtime.stopReplyReplay(sessionId, body.replayId);
            return json({ stopped: true });
          }
          if (typeof body.turnId !== 'string' || !body.turnId || body.turnId.length > 256) throw new TypeError('Reply identity required');
          const entry = callId && calls.get(callId);
          const current = () => {
            const logical = storage.voiceLifecycle(sessionId);
            if (!callId) return !logical || ['idle', 'ended'].includes(logical.state);
            return entry?.sessionId === sessionId && entry.ownerToken === ownerToken && !entry.closing && !entry.call?.signal.aborted &&
              logical?.callId === callId && logical.state === 'active' && !logical.holds.length && !logical.needsRecovery &&
              logical.providerSessionId === body.providerSessionId && logical.epoch === entry.epoch &&
              (!logical.controllingTabId || logical.controllingTabId === body.tabId && logical.epoch === body.epoch);
          };
          if (!current()) throw new PluginError('unavailable');
          const playbackSignal = entry && AbortSignal.any([entry.controller.signal, entry.authority.signal]);
          const signal = playbackSignal ? AbortSignal.any([request.signal, playbackSignal]) : request.signal;
          return json(await runtime.speakText({ session: storage.get(sessionId), turnId: body.turnId,
            options: { ...options(request), signal, playbackSignal, current, replayId: body.replayId } }));
        }
        if (!action) {
          const current = storage.voiceLifecycle(sessionId);
          if (current?.state !== 'ended' && current?.controllingTabId && current.controllingTabId !== body.tabId) {
            throw new ConflictError('Voice ownership lost');
          }
          if (typeof body.callId !== 'string' || !new RegExp(`^${idPattern}$`, 'u').test(body.callId) || calls.has(body.callId) || storage.voiceCalls(sessionId).some(c => c.callId === body.callId)) throw new ConflictError('Call identity reused');
          onActivity?.(storage.get(sessionId));
          return json(await start(request, sessionId, ownerToken, body.callId, undefined, false, body.tabId), 201);
        }
        let logical = storage.voiceLifecycle(sessionId, callId);
        if (action === 'takeover') {
          if (body.explicit !== true || !body.tabId || !Number.isSafeInteger(body.epoch)) throw new TypeError('Explicit tab takeover required');
          if (!logical || logical.state === 'ended') throw new PluginError('not-admitted', 'Logical call ended');
          logical = storage.takeOverVoiceCall(sessionId, callId, body);
          turns.retireEpoch(sessionId, callId);
          const entry = calls.get(callId);
          // The epoch commits before revoking the old transport. In-flight old
          // commands recheck it after every authorization await.
          publish(sessionId, { type: 'voice.state', data: { ...this.snapshot(sessionId), reason: 'tab-takeover' } });
          if (entry) void close(entry, 'tab-takeover', 'cancelled');
          return json(this.snapshot(sessionId));
        }
        if (logical?.controllingTabId && (body.tabId !== logical.controllingTabId || body.epoch !== logical.epoch)) {
          throw new ConflictError('Voice ownership lost');
        }
        if (action === 'recover' && logical?.holds.some(reason => ['takeover', 'wake', 'sleep', 'server-restart'].includes(reason)) && body.explicit !== true) {
          throw new PluginError('not-admitted', 'Explicit Resume required');
        }
        const previous = storage.voiceCalls(sessionId).find(c => c.callId === callId && c.providerSessionId === body.providerSessionId);
        if (action === 'close' && previous && !recoverableVoiceEnd(body.reason ?? 'closed')) {
          storage.transitionVoiceLifecycle(sessionId, callId, { type: 'end', reason: body.reason ?? 'closed' });
          endAuthority(sessionId, callId);
          const active = calls.get(callId);
          if (active?.sessionId === sessionId && active.ownerToken === ownerToken) void close(active, body.reason ?? 'closed');
        }
        if (action === 'recover' && (storage.voiceLifecycle(sessionId, callId)?.state === 'ended' ||
          !storage.voiceLifecycle(sessionId, callId) && previous?.reason && !recoverableVoiceEnd(previous.reason))) {
          throw new PluginError('not-admitted', 'Logical call ended');
        }
        if (action === 'close' && body.recoveryAttempts !== undefined &&
          (body.reason !== 'recovery-failed' || !Number.isSafeInteger(body.recoveryAttempts) || body.recoveryAttempts < 1 || body.recoveryAttempts > 3)) {
          throw new TypeError('Invalid recovery attempt count');
        }
        if (action === 'close' && previous && body.reason === 'recovery-failed' && body.recoveryAttempts === 3 &&
          logical?.state !== 'ended' && logical?.providerSessionId === body.providerSessionId) {
          const waiting = storage.transitionVoiceLifecycle(sessionId, callId, { type: 'recovery-exhausted' });
          publish(sessionId, { type: 'voice.state', data: { callId, providerSessionId: body.providerSessionId,
            ...tabAuthority(sessionId, callId),
            state: waiting.state, attempts: waiting.attempts, reason: body.reason } });
        }
        if (action === 'recover' && logical?.authorizationRevision && logical.authorizationRevision !== voiceAuthorizationRevision(storage.get(sessionId))) {
          throw new PluginError('not-admitted', 'Call authorization changed');
        }
        if (action === 'close' && previous?.terminal) return json(previous.terminal);
        const currentEntry = calls.get(callId);
        const entry = currentEntry?.epoch === logical?.epoch ? currentEntry : undefined;
        if (!entry && action === 'recover' && previous) {
          // A choice saved while the call was down applies only to an explicitly started call.
          if (Number.isSafeInteger(previous.settingsRevision) && previous.settingsRevision !== storage.get(sessionId).settings?.revision) {
            throw new PluginError('not-admitted', 'Processing settings changed');
          }
          if (body.explicit === true) onActivity?.(storage.get(sessionId));
          return json(await start(request, sessionId, ownerToken, callId, previous.spendDeadlineAt, true));
        }
        if (!entry && previous && storage.get(sessionId).consentWithdrawn) throw new PluginError('not-admitted');
        if (!entry && logical?.holds.includes('server-restart') && ['heartbeat', 'resume', 'events'].includes(action)) {
          return json({ error: 'voice-restart-required' }, 409);
        }
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
          runtime.stopReplyReplay?.(sessionId);
          if (body.pauseRequestId !== undefined && (typeof body.pauseRequestId !== 'string' ||
            !new RegExp(`^${idPattern}$`, 'u').test(body.pauseRequestId))) throw new TypeError('Invalid pause request identity');
          const event = storage.pause(sessionId, true, { ownerToken, pauseRequestId: body.pauseRequestId }); publish(sessionId, event);
          storage.transitionVoiceLifecycle(sessionId, callId, { type: 'pause' });
          return json(await changePause(entry, true, options(request)));
        }
        let session = sessionFor(entry);
        // Cleanup is always permitted. Every other command needs current binding coverage.
        try {
          await runtime.checkVoice(session, { ...options(request), allowPaused: ['resume', 'heartbeat', 'recover'].includes(action), existingCall: true });
          session = sessionFor(entry);
        } catch (error) {
          if (!(error instanceof ConflictError) && error.message !== 'session paused') void close(entry, 'call-authorization-lost', 'cancelled');
          throw error;
        }
        if (action === 'recover') {
          // A visitor's Resume is activity; automatic transport repair is not.
          if (body.explicit === true) onActivity?.(session);
          if (!bound && !entry.closing && !entry.call.signal.aborted) return json(receipt(entry.call));
          if (entry.recovering) throw new ConflictError('Recovery in progress');
          if (entry.settingsRevision !== session.settings?.revision) throw new PluginError('not-admitted', 'Processing settings changed');
          entry.recovering = true;
          try {
            const end = entry.call.spendDeadlineAt;
            void close(entry, 'transport-lost', 'cancelled');
            return json(await start(request, sessionId, ownerToken, callId, end, true));
          } finally { entry.recovering = false; }
        }
        if (entry.call.signal.aborted) throw new PluginError('unavailable');
        if (action === 'events') {
          if (['partial', 'final'].includes(body.event?.type)) runtime.stopReplyReplay?.(sessionId);
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
            if (purposePolicy && result.event.type === 'turn.corrected' && result.event.data.role === 'assistant') {
              storage.carrySafeguardRevision(sessionId, inputRevision(fresh), inputRevision(storage.get(sessionId)));
            }
            if (purposePolicy && body.event.role === 'user' && Number.isSafeInteger(result.event?.data.userTurnOrdinal)) {
              storage.bindSafeguard(sessionId, `voice:${callId}:${entry.call.providerSessionId}:${result.event.data.userTurnOrdinal}`, inputRevision(storage.get(sessionId)));
            }
            publish(sessionId, result.event); onTurn(sessionId, result.event);
            if (body.event.type === 'final' && body.event.role === 'user') storage.transitionVoiceLifecycle(sessionId, callId,
              { type: 'accepted', turnId: body.event.turnId });
          }
          return json(result.event);
        }
        const before = storage.get(sessionId).seq;
        if (action === 'resume') {
          if (body.resumeRequestId !== undefined && (typeof body.resumeRequestId !== 'string' ||
            !new RegExp(`^${idPattern}$`, 'u').test(body.resumeRequestId))) throw new TypeError('Invalid resume request identity');
          onActivity?.(session);
        }
        const ack = await entry.call[action]({ ...options(request), guard: { authorizationRevision: voiceAuthorizationRevision(session),
          ...(action === 'resume' && body.resumeRequestId !== undefined ? { resumeRequestId: body.resumeRequestId } : {}) } });
        sessionFor(entry);
        if (action === 'resume') storage.transitionVoiceLifecycle(sessionId, callId, { type: 'resume-acknowledged' });
        if (action === 'heartbeat') storage.transitionVoiceLifecycle(sessionId, callId, { type: 'heartbeat', ...ack });
        for (const event of storage.read(sessionId, before)) publish(sessionId, event);
        return json(ack);
      } catch (error) {
        if (error instanceof NotFoundError) return json({ error: 'session-not-found' }, 404);
        if (error instanceof ConflictError) return json({ error: error.message === 'Voice ownership lost' ? 'voice-ownership-lost' : 'voice-conflict' }, 409);
        if (error instanceof SyntaxError || error instanceof TypeError) return json({ error: 'invalid-request' }, 400);
        if (error instanceof RangeError) return json({ error: 'size-limit' }, 413);
        if (error instanceof PluginError) return json({ error: error.code,
          ...(VOICE_CAP_REASONS.has(error.message) || error.message === 'host-limit' ? { reason: error.message } : {}) }, error.code === 'not-admitted' ? 403 : error.code === 'deadline' ? 504 : 502);
        return json({ error: 'voice-unavailable' }, 503);
      }
    },
    async resume() {
      turns.recover();
      runtime.recoverVoiceCap?.();
      // Startup has exclusive durable storage. Fence each logical call once,
      // before segment reconciliation, without replacing its identity/epoch.
      const restarted = new Set();
      for (const record of storage.voiceCalls()) {
        const key = `${record.sessionId}:${record.callId}`;
        if (restarted.has(key)) continue;
        restarted.add(key);
        const logical = storage.voiceLifecycle(record.sessionId, record.callId);
        if (logical?.state === 'ended') continue;
        storage.transitionVoiceLifecycle(record.sessionId, record.callId, { type: 'server-restart' });
        endAuthority(record.sessionId, record.callId);
        publish(record.sessionId, { type: 'voice.state', data: { ...this.snapshot(record.sessionId), reason: 'server-restart' } });
      }
      // The exclusive writer has already conservatively recovered all open claims.
      for (let record of storage.voiceCalls()) {
        for (const callbacks of callbackAdapters()) await callbacks?.revokeRecord?.(record);
        const row = runtime.budget.get(record.attemptId);
        // A final receipt can be journalled immediately before a crash in budget
        // settlement. Replay its actual cost rather than abandoning that receipt.
        if (record.terminal?.closureConfirmed === true && record.terminal.usage &&
          !record.terminal.usage.costEstimated && row?.state === 'settled') {
          try { runtime.reconcileVoice(record.attemptId, { ...record.terminal, providerSessionId: record.providerSessionId }); }
          catch { record = { ...record, reconciliationPending: true }; }
        }
        if (record.terminal?.closureConfirmed === true && !record.terminal.usage?.costEstimated && !record.reconciliationPending) continue;
        storage.saveVoiceCall(record.sessionId, { ...record, closing: true, endedAt: record.endedAt ?? now(), reason: record.reason ?? 'server-restart',
          terminal: record.terminal ?? { attemptId: record.attemptId, outcome: row?.outcome ?? 'uncertain', closureConfirmed: false,
            chargedMicro: row?.settled_micro ?? record.maxMicro }, reconciliationPending: true });
        await reconcile(record);
      }
      if (pendingReconciliations().length) reconcileLater();
    },
    async reconcileUncertain({ dryRun = true, limit = reconcileBatchSize, deadlineAt = Date.now() + 60_000 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid repair batch');
      const pending = pendingReconciliations(), count = Math.min(pending.length, limit);
      const records = Array.from({ length: count }, (_, i) => pending[(repairOffset + i) % pending.length]);
      const summary = { candidates: records.length, beforeMicro: 0, afterMicro: 0, corrected: 0, pending: 0 };
      for (const record of records) {
        if (Date.now() >= deadlineAt) { summary.pending++; continue; }
        const row = runtime.budget.get(record.attemptId);
        summary.beforeMicro += row?.settled_micro ?? 0;
        if (dryRun) {
          let result;
          try { if (closeOrphan) result = await voiceOperation({ deadlineAt: Math.min(deadlineAt, Date.now() + reconcileLookupTimeoutMs) }, opts => closeOrphan(record, opts)); } catch { /* Counts only. */ }
          summary.afterMicro += result?.closureConfirmed ? result.usage.upstreamMicro : row?.settled_micro ?? 0;
          if (!result?.closureConfirmed) summary.pending++;
        } else {
          const before = row?.voice_reconciliation_json;
          await reconcile(record);
          const after = runtime.budget.get(record.attemptId);
          summary.afterMicro += after?.settled_micro ?? 0;
          if (before !== after?.voice_reconciliation_json) summary.corrected++;
          else summary.pending++;
        }
      }
      // Advancing an in-memory preview cursor does not write either ledger.
      repairOffset = pending.length ? (repairOffset + count) % pending.length : 0;
      if (!dryRun && pendingReconciliations().length) reconcileLater();
      return summary;
    },
    reconcileLater,
    async idle() { while (settlements.size) await Promise.allSettled([...settlements]); await turns.idle(); },
    async close() {
      runtime.stopReplyReplays?.();
      stopping = true; clearTimeout(reconcileTimer);
      for (const id of sessions.keys()) this.stopSession(id, 'server-stopping');
      for (const authority of authorities.values()) endAuthority(authority.sessionId, authority.callId);
      await this.idle(); await reconcileJob;
    },
  };
}
