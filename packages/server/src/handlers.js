import { consentSaveEndsConversation } from '../../core/src/settings.js';
import { validateConsentDocument, ConsentDocumentError } from '../../core/src/consent-document.js';
import { createConceptHandlers } from './concept-handlers.js';
import { createVoiceHandlers, buildVoiceReplyRequest } from './voice-handlers.js';
import { createUploadHandlers } from './upload-handlers.js';
import { createHostHandlers, PrivacyDocumentRequiredError } from './host-handlers.js';
import { createPluginRuntime } from './plugin-runtime.js';
import { randomUUID } from 'node:crypto';
import { SessionLanes, createMockReasoning, createSession, inputRevision, activeTurns, hasConversationInput, understandingDeferred, PluginError, FEATURES, isConsentReason, normalizePurposePolicy, openQuestionItems, pendingQuestionFocus, focusQuestion } from '@inspr/aithema-core';
import { ConflictError, NotFoundError, SettingsConflictError, ConsentConflictError } from './storage.js';
import { exportSession } from './export.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const encoder = new TextEncoder();
const REQUEST_LIMIT = 32_768;
class RetirementHookTimeoutError extends Error {}
function sse(event) {
  return encoder.encode(`${event.seq ? `id: ${event.seq}\n` : ''}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
export async function readBody(request, limit = REQUEST_LIMIT) {
  if (!request.body) return new Uint8Array();
  const length = request.headers.get('content-length');
  const declared = length && /^\d+$/u.test(length) ? Number(length) : null;
  if (declared !== null && (!Number.isSafeInteger(declared) || declared > limit)) throw new RangeError('Request limit');
  // Fill one buffer for declared lengths. Node 24's resizable backing store
  // grows undeclared bodies without retaining chunks or copying a full body
  // on resize/concat; a single-chunk body can be returned directly.
  const body = declared === null ? null : Buffer.allocUnsafe(declared);
  const reader = request.body.getReader();
  let first, growing, size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new RangeError('Request limit'); }
      if (!value.length) continue;
      if (body) {
        if (size > body.length) { await reader.cancel(); throw new TypeError('Request length mismatch'); }
        body.set(value, size - value.length);
      } else if (!first && !growing) first = value;
      else {
        if (!growing) {
          growing = new ArrayBuffer(size, { maxByteLength: limit });
          new Uint8Array(growing).set(first); first = null;
        } else growing.resize(size);
        new Uint8Array(growing, size - value.length, value.length).set(value);
      }
    }
    if (body) {
      if (size !== body.length) throw new TypeError('Request length mismatch');
      return body;
    }
    if (growing) return Buffer.from(growing, 0, size);
    return first ? Buffer.from(first.buffer, first.byteOffset, first.byteLength) : Buffer.alloc(0);
  } finally { reader.releaseLock(); }
}

export function createHandlers({ storage, reasoning = createMockReasoning(), sessionOptions = { demo: true },
  deadlineMs = 30_000, retiredHookTimeoutMs = 30_000, hostPrompt = '', purposePolicy, pluginRuntime, consent = pluginRuntime?.consent,
  ownership = { token: request => request.headers.get('x-aithema-session-token') }, voice, concepts = {}, uploads = {}, host, log = console.log }) {
  if (!Number.isSafeInteger(retiredHookTimeoutMs) || retiredHookTimeoutMs < 1) throw new TypeError('Invalid retired hook timeout');
  purposePolicy = normalizePurposePolicy(purposePolicy);
  pluginRuntime ??= createPluginRuntime({ storage, reasoning, consent: consent ?? { coverage: () => ({ covered: false }) } });
  if (typeof host?.now === 'function') pluginRuntime.setHostClock?.(() => host.now());
  pluginRuntime.setLaneDiagnostic?.(log);
  consent ??= pluginRuntime.consent;
  if (typeof consent?.coverage !== 'function' || consent !== pluginRuntime.consent) {
    throw new TypeError('Admission and revocation require the same consent port');
  }
  const consentDecisions = new Map();
  const listeners = new Map(), jobs = new Map(), focusRequests = new Set(), stop = new AbortController();
  if (host?.walletForSession) pluginRuntime.setOwnerWallet?.(session => host.walletForSession(session));
  let recovery = null, costTimer, costRecovery;
  const reconcileCostsLater = () => {
    if (stop.signal.aborted || costTimer || !pluginRuntime.reconcileCosts) return;
    costTimer = setTimeout(() => {
      costTimer = undefined;
      costRecovery = pluginRuntime.reconcileCosts({ signal: stop.signal }).finally(() => { costRecovery = null; reconcileCostsLater(); });
      costRecovery.catch(() => {});
    }, 30_000);
    costTimer.unref?.();
  };
  const broadcast = (id, event) => {
    for (const listener of listeners.get(id) ?? []) listener(event);
    if (event.type === 'session.paused' && event.data.reason === 'purpose') voiceHandlers?.stopSession(id, 'purpose');
    if (event.type === 'conversation.end-requested') voiceHandlers?.stopSession(id, event.data.reason);
    // Voice Resume publishes the same durable pause event as text Resume.
    // Work that deferred while paused needs a wake-up even without a new turn.
    if (event.type === 'session.paused' && event.data.paused === false) schedule(id, { wake: true });
  };
  const clearFailures = id => storage.clearLaneFailures(id);
  const currentFailures = session => storage.laneFailures(session.id).filter(failure => {
    if (failure.inputRevision === inputRevision(session)) return true;
    storage.clearLaneFailures(session.id, failure.lane);
    return false;
  });
  const operations = session => ({ inputRevision: inputRevision(session),
    running: [...jobs.values()].filter(job => job.id === session.id).map(job => job.lane),
    // Expose every current failure so each lane can explain its own failure.
    failures: currentFailures(session),
    lastFailure: currentFailures(session).at(-1) ?? null });
  const snapshot = async id => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const session = storage.get(id), featureMatrix = await pluginRuntime.matrix(session);
      const current = storage.get(id), { ownerHash, ...publicSession } = current;
      if (current.tombstone || current.ownerHash !== session.ownerHash) throw new NotFoundError('Session not found');
      if (current.seq === session.seq) return { ...publicSession, ...(voiceHandlers ? { voiceLifecycle: voiceHandlers.snapshot(id) } : {}),
        ...(host?.identity?.chooseRole === true ? { roleChoice: hostHandlers.roleChoice(id) } : {}),
        operations: operations(current), openQuestionItems: openQuestionItems(current), featureMatrix, conceptVisualKind: pluginRuntime.visualKind(current),
        ...(pluginRuntime.visualsBound ? { visualsBound: pluginRuntime.visualsBound() } : {}),
        conceptCost: pluginRuntime.imageQuote(current), ...(pluginRuntime.describe ? { engine: pluginRuntime.describe(current) } : {}) };
    }
    throw new ConflictError('Session changed during snapshot');
  };
  const status = id => broadcast(id, { sessionId: id, type: 'lane.status', data: operations(storage.get(id)) });
  // A lane's work identity: its input revision plus the processing choice it runs with.
  const selection = (session, lane) => pluginRuntime.selectionKey?.(session, lane) ?? '';
  const laneKey = (session, lane) => `${inputRevision(session)}|${selection(session, lane)}|${lane === 'reaction' ? session.questionFocus?.requestId ?? '' : ''}`;
  // New turns may obsolete a paid assessment but must let it collect its receipt.
  // Consent, locale, correction, upload and identity revisions remain strict.
  const keepUnderstanding = (source, current) => {
    if (!purposePolicy || current.consentWithdrawn || current.tombstone) return false;
    const suffix = inputRevision(source).split(':').slice(1).join(':');
    if (inputRevision(current).split(':').slice(1).join(':') !== suffix) return false;
    const before = source.transcript.filter(turn => turn.role === 'user').length;
    const added = current.transcript.filter(turn => turn.role === 'user').slice(before);
    if (current.inputRevision - source.inputRevision !== added.length || !added.length) return false;
    const original = storage.safeguards(source.id, inputRevision(source));
    // AIT-197 may recover older project input from an off-topic snapshot.
    // That admitted project work owns the same receipt protection as direct input.
    if (!original.assessed || original.offTopic && !storage.purposeAssessmentInput(source)) return false;
    return true;
  };
  // Publishing an older result additionally requires every new turn to be off-topic.
  const retainUnderstanding = (source, current, pending = false) => {
    if (!keepUnderstanding(source, current)) return false;
    const suffix = inputRevision(source).split(':').slice(1).join(':');
    const before = source.transcript.filter(turn => turn.role === 'user').length;
    const added = current.transcript.filter(turn => turn.role === 'user').slice(before);
    return added.every((_, index) => {
      const state = storage.safeguards(source.id, `${source.inputRevision + index + 1}:${suffix}`);
      return state.assessed ? state.offTopic : pending;
    });
  };
  const settleUnderstanding = (source, { signal }) => {
    const ready = () => {
      const current = storage.get(source.id);
      return inputRevision(current) === inputRevision(source) ||
        !retainUnderstanding(source, current, true) || retainUnderstanding(source, current);
    };
    if (ready() || signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const set = listeners.get(source.id) ?? new Set(); listeners.set(source.id, set);
      const done = () => { set.delete(check); if (!set.size) listeners.delete(source.id); signal.removeEventListener('abort', done); resolve(); };
      const check = () => { if (ready()) done(); };
      set.add(check); signal.addEventListener('abort', done, { once: true }); check();
    });
  };
  const lanes = new SessionLanes({ reasoning, getSession: id => storage.get(id), deadlineMs, hostPrompt, purposePolicy, selection, retainUnderstanding, keepUnderstanding, settleUnderstanding,
    offTopicTurns: id => storage.safeguards(id).offTopicTurns,
    guardDirection: (id, reply) => storage.guardPurposeDirection(id, reply, purposePolicy),
    canUnderstand: id => Boolean(storage.purposeAssessmentInput(storage.get(id))),
    understandingInput: session => purposePolicy ? storage.purposeAssessmentInput(session) : session,
    scopeKnown: (id, revision) => storage.safeguards(id, revision).assessed,
    replyVisible: session => !voiceHandlers?.active(session.id),
    focusReplyAvailable: id => !voiceHandlers?.replyInFlight(id),
    onScope(id, scope, revision, { reply = true } = {}) {
      if (!reply) for (const event of storage.appendPurposeReply(id, null, revision, false, purposePolicy.offTopicLimit)) broadcast(id, event);
      lanes.supersede(id);
      if (scope !== 'off') scheduleLane(id, 'understanding');
    },
    admit: args => pluginRuntime.admit(args),
    onOpenerStripped() {
      try { log({ event: 'reply.opener-stripped', count: 1, lane: 'reaction' }); }
      catch { /* Diagnostics cannot interrupt a reply. */ }
    },
    onReplyDiagnostic({ lane, kind, reason, attemptCount }) {
      const event = { fallback: 'reply.fallback', 'schema-retry': 'reply.schema-retry', 'missing-scope': 'reply.scope-missing' }[kind];
      if (!event) return;
      try { Promise.resolve(log({ event, count: 1, lane, reason, attemptCount })).catch(() => {}); }
      catch { /* Diagnostics cannot interrupt a reply. */ }
    },
    publish(id, type, data, revision, scope, source) {
      if (stop.signal.aborted) return false;
      // Focus is a host command over already assessed input, not another scope
      // observation. Keep its reply without mutating purpose counters or gates.
      if (purposePolicy && type === 'turn.final' && !data.focusRequestId && ['in', 'unclear', 'off'].includes(scope)) {
        const events = storage.appendPurposeReply(id, data, revision, scope === 'off', purposePolicy.offTopicLimit);
        for (const event of events) broadcast(id, event);
        return events.length > 0;
      }
      const current = storage.get(id);
      const acceptedRevision = type === 'understanding.updated' && source && retainUnderstanding(source, current)
        ? inputRevision(current) : revision;
      const event = storage.append(id, type, data, acceptedRevision);
      if (event) broadcast(id, event);
      if (event && type === 'understanding.updated') {
        conceptHandlers.onUnderstanding(id);
        const session = storage.get(id), pending = pendingQuestionFocus(session);
        const question = pending
          ? session.understanding.openQuestions.includes(session.focusedQuestion) ? session.focusedQuestion : null
          : session.understanding.openQuestions[0] ?? null;
        if ((session.focusedQuestion ?? null) !== question) {
          // Clearing the command makes its reaction stale before the lane can
          // detect removal. Send the documented failure while it still owns it.
          if (pending && question === null) {
            const failure = { inputRevision: acceptedRevision, lane: 'reaction', error: 'reasoning-unavailable',
              reason: 'focused-question-removed', retryable: false };
            storage.setLaneFailure(id, failure);
            broadcast(id, { sessionId: id, type: 'lane.failed', data: failure });
          }
          const focused = storage.append(id, 'question.focused', { question }, acceptedRevision);
          if (focused) broadcast(id, focused);
        }
      }
      return Boolean(event);
    }, transient: (id, event) => broadcast(id, { sessionId: id, ...event }),
  });
  const conceptHandlers = createConceptHandlers({ storage, runtime: pluginRuntime, ownership, readBody, publish: broadcast, signal: stop.signal, ...concepts });
  const touchVisitor = session => {
    const failed = () => {
      try { Promise.resolve(log({ event: 'host.touch-visitor.failed', sessionId: session.id })).catch(() => {}); }
      catch { /* Diagnostics cannot interrupt a turn or call. */ }
    };
    // Activity is best effort: accepted input and call controls must continue.
    try { Promise.resolve(host?.touchVisitor?.(session)).catch(failed); }
    catch { failed(); }
  };
  // Idle image generation is disabled: server elapsed time proves no client
  // presence. There is no periodic session scan or reference-byte polling.
  const voiceHandlers = voice ? createVoiceHandlers({ storage, runtime: pluginRuntime, ownership, readBody, hostPrompt, purposePolicy,
    ...voice, onScopeRecorded: status, onAssessment: id => scheduleLane(id, 'understanding'), publish: broadcast, onClose: id => conceptHandlers.ended(id), onActivity: touchVisitor, onTurn(id, event) {
      lanes.supersede(id);
      if (event?.data.role === 'user') {
        touchVisitor(storage.get(id));
        conceptHandlers.onTurn(id, event.data.id);
      }
      if (purposePolicy && !voiceHandlers.delegatesReply(id)) schedule(id);
      else if (!purposePolicy || storage.safeguards(id, inputRevision(storage.get(id))).assessed) scheduleLane(id, 'understanding');
      status(id);
    } }) : null;
  const uploadHandlers = createUploadHandlers({ storage, runtime: pluginRuntime, ownership, readBody, publish: broadcast, signal: stop.signal,
    ...uploads, onInput(id, { pending = false } = {}) { lanes.supersede(id); if (!pending) schedule(id); },
    async onWithdraw(id, event) {
      await Promise.all([invalidate(id, event, 'upload-withdrawn'), conceptHandlers.lane.supersede(id)]); schedule(id);
    } });
  const hostHandlers = createHostHandlers({ storage, host, ownership, readBody, publish: broadcast, snapshot,
    budget: pluginRuntime.budget, conversationLimits: pluginRuntime.conversationLimits, signal: stop.signal, now: host?.now, deadlineMs,
    async createConversation(ownerToken, options = {}) {
      const initial = await initialSettings(ownerToken, options);
      if (initial.error) throw new TypeError(initial.error);
      const session = storage.create({ ...sessionOptions, locale: options.locale ?? 'en', ownerToken, ...initial });
      hostHandlers.initialize(session.id, ownerToken, { newSession: true });
      return session;
    },
    async eraseConversation(id, ownerToken) {
      storage.authorize(id, ownerToken);
      await eraseConversation(id, { ownerToken }, ownerToken);
      return { id, erased: true };
    },
    unlocked(id) { lanes.supersede(id); schedule(id); conceptHandlers.schedule(id); },
  });
  pluginRuntime.conversationLimits.configure({ publish: broadcast, now: voice?.now ?? host?.now,
    durationMs: host?.credits?.durationMs });
  async function eraseConversation(id, guard, ownerToken) {
    const release = guard.retire ? null : storage.holdErasedRetirement(id);
    try {
      const event = storage.erase(id, guard);
      if (!event) return null;
      await invalidate(id, event, 'session-erased');
      if (!guard.retire) await host?.erased?.({ sessionId: id, ownerToken });
      return event;
    } finally { release?.(); }
  }
  // Serialize grants and document reads across async host ports. Withdrawal
  // bypasses this queue; storage compares the revision atomically at commit.
  async function withConsent(id, work) {
    const pending = (consentDecisions.get(id) ?? Promise.resolve()).then(work);
    const settled = pending.then(() => {}, () => {});
    consentDecisions.set(id, settled);
    try { return await pending; }
    finally { if (consentDecisions.get(id) === settled) consentDecisions.delete(id); }
  }
  async function consentDocument(session, options) {
    const document = validateConsentDocument(await consent.describe(session.id, options));
    const ids = new Set(document.items?.map(item => item.id) ?? ['mock-processing']);
    const features = Object.fromEntries(FEATURES.map(feature => [feature, [...new Set(
      pluginRuntime.scopes(session, { feature, delivered: true }).map(scope => ids.has(scope.purpose) ? scope.purpose
        : scope.purpose === 'mock-conversation' ? 'mock-processing' : scope.purpose).filter(id => ids.has(id)))]]));
    const unavailableFeatures = [];
    for (const feature of ['html', 'images']) {
      const artifacts = (session.concepts ?? []).filter(item => !item.archived && !item.erased && !item.withdrawn &&
        (item.mediaType === 'text/html' ? 'html' : 'images') === feature);
      for (const artifact of artifacts) {
        const status = await pluginRuntime.publicationStatus(session, { artifactId: artifact.id, visualKind: feature,
          operation: artifact.operation ?? (artifact.referenceIds?.length ? 'edit' : 'generate') });
        if (!features[feature].length || status === 'unavailable') { unavailableFeatures.push(feature); break; }
      }
    }
    return { ...document, features, unavailableFeatures, consentRevision: session.consentRevision };
  }
  async function consentEnrichment(session, options) {
    // Enrichment must not hold a grant behind an unavailable host describe.
    // A timed-out read cannot alter the event after the journal has committed.
    let timer;
    try {
      return await Promise.race([consentDocument(session, options), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Consent enrichment timed out')), 250);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function invalidate(id, event, reason) {
    const cancelled = Promise.allSettled([lanes.cancel(id), conceptHandlers.lane.invalidate(id),
      ...(['consent-withdrawn', 'consent-revised', 'session-erased'].includes(reason) ? [uploadHandlers.cancelSession(id)] : [])]);
    clearFailures(id); broadcast(id, event);
    voiceHandlers?.stopSession(id, reason);
    await cancelled;
  }
  function schedule(id, { wake = false, reconnect = false, retry = false } = {}) {
    let requested;
    if (purposePolicy) {
      const session = storage.get(id), scoped = storage.safeguards(id, inputRevision(session));
      requested = storage.purposeAssessmentInput(session) ? ['understanding'] : [];
      if (!scoped.assessed && session.pauseReason !== 'purpose' && !(voiceHandlers?.active(id) && voiceHandlers.delegatesReply(id))) requested.unshift('reaction');
    } else requested = voiceHandlers?.active(id) ? ['understanding'] : ['reaction', 'understanding'];
    // An explicit Retry can recover a recorded lane even when ordinary
    // scheduling currently requests only understanding (for example active voice).
    if (pendingQuestionFocus(storage.get(id)) && !voiceHandlers?.active(id) && !requested.includes('reaction')) requested.unshift('reaction');
    if (retry) requested = ['reaction', 'understanding'].filter(lane =>
      requested.includes(lane) || currentFailures(storage.get(id)).some(failure => failure.lane === lane));
    let previous;
    for (const lane of requested) {
      // Opening a stream is not consent to another paid attempt. Keep each
      // recorded current-revision lane failure until the existing Retry path.
      if (reconnect && currentFailures(storage.get(id)).some(failure => failure.lane === lane)) continue;
      scheduleLane(id, lane, { wake, after: retry ? previous : undefined });
      if (retry) previous = jobs.get(`${id}:${lane}`)?.promise;
    }
    status(id);
  }
  function scheduleLane(id, lane, { wake = false, after } = {}) {
    const key = `${id}:${lane}`;
    if (stop.signal.aborted) return;
    if (lane === 'reaction' && pendingQuestionFocus(storage.get(id)) && voiceHandlers?.replyInFlight(id)) return;
    const running = jobs.get(key);
    if (running) { if (wake) running.reschedule = true; return; }
    const job = { id, lane, promise: null, reschedule: false };
    jobs.set(key, job);
    const release = storage.hold(id);
    job.promise = Promise.resolve(after).catch(() => {}).then(async () => {
      try {
        while (!stop.signal.aborted) {
          job.reschedule = false;
          const started = storage.get(id), revision = inputRevision(started), work = laneKey(started, lane);
          // A removed focus needs new input or a new selection before work resumes.
          if (currentFailures(started).some(failure => failure.lane === lane && !failure.retryable)) return;
          try {
            await lanes.run(id, lane, { signal: stop.signal });
            // A stale completion cannot resolve a failure for replacement work.
            if (laneKey(storage.get(id), lane) === work) storage.clearLaneFailures(id, lane);
          } catch (error) {
            // Work superseded by new input or a changed processing choice reruns instead of failing.
            if (!stop.signal.aborted && laneKey(storage.get(id), lane) === work) {
              const removedFocus = error?.code === 'not-admitted' && error.message === 'focused-question-removed';
              const busyReply = error?.code === 'not-admitted' && error.message === 'reply-in-flight';
              const failure = { inputRevision: revision, lane, error: 'reasoning-unavailable', retryable: !removedFocus,
                ...(removedFocus ? { reason: 'focused-question-removed' } : {}),
                ...(busyReply ? { reason: 'reply-in-flight' } : {}),
                ...(error?.code === 'not-admitted' && error.message === 'budget reconciling' ? { reason: 'budget reconciling' } : {}) };
              storage.setLaneFailure(id, failure);
              broadcast(id, { sessionId: id, type: 'lane.failed', data: failure });
            }
          }
          if (stop.signal.aborted || laneKey(storage.get(id), lane) === work && !job.reschedule) {
            // Remove synchronously with the last revision check: a subsequent
            // schedule can start work even before this promise settles.
            jobs.delete(key); status(id); return;
          }
        }
      } finally {
        release();
        if (jobs.get(key) === job) { jobs.delete(key); status(id); }
      }
    });
    // Failures never include provider text or request content in logs or responses.
    job.promise.catch(() => {});
  }
  // New conversations pin concrete settings: an explicit visitor choice, else the owner's
  // last confirmed choice while the host still offers it, else the host defaults.
  async function initialSettings(ownerToken, options) {
    if (options.confirm !== undefined && typeof options.confirm !== 'boolean') return { status: 400, error: 'invalid-session' };
    const provenance = origin => options.confirm === true ? { origin: 'chosen', at: new Date().toISOString() } : { origin };
    const requested = options.processingPreset ?? sessionOptions.processingPreset;
    const probe = createSession({ ...sessionOptions, processingPreset: requested ?? 'best' });
    if (pluginRuntime.offered?.(probe.processingPreset) === false && probe.processingPreset === 'device') {
      return { status: 409, error: 'setting-not-allowed', field: 'processingPreset', reason: 'preset not configured' };
    }
    if (options.settings !== undefined) {
      if (!options.settings || typeof options.settings !== 'object' || Array.isArray(options.settings)) return { status: 400, error: 'invalid-session' };
      const chosen = await pluginRuntime.validate(probe, { ...options.settings, processingPreset: probe.processingPreset });
      if (chosen.error) return chosen;
      return { processingPreset: chosen.processingPreset, settings: { ...chosen.settings, ...provenance('default') } };
    }
    const last = storage.lastSettings?.(ownerToken);
    if (last && pluginRuntime.validate && (requested === undefined || last.processingPreset === requested)) {
      const { model, effort, voice, visuals } = last.settings;
      const offered = await pluginRuntime.validate({ ...probe, processingPreset: last.processingPreset },
        { processingPreset: last.processingPreset, model, effort, voice, visuals });
      if (!offered.error) return { processingPreset: offered.processingPreset, settings: { ...offered.settings, ...provenance('last') } };
    }
    if (!pluginRuntime.validate) return { processingPreset: probe.processingPreset, settings: { ...pluginRuntime.defaults?.(probe.processingPreset), ...provenance('default') } };
    // The host defaults pass the same static validation as a save; an unoffered preset is refused.
    const defaults = await pluginRuntime.validate(probe, { processingPreset: probe.processingPreset });
    if (defaults.error) return defaults;
    return { processingPreset: defaults.processingPreset, settings: { ...defaults.settings, ...provenance('default') } };
  }
  function unfinished(session) {
    const revision = inputRevision(session);
    const scoped = purposePolicy ? storage.safeguards(session.id, revision) : null;
    const replyMissing = pendingQuestionFocus(session) || (scoped ? !scoped.assessed : !activeTurns(session).some(t => t.role === 'assistant' && t.inputRevision === revision));
    return !session.tombstone && hasConversationInput(session) &&
      (replyMissing || purposePolicy && storage.purposeAssessmentInput(session) || !scoped?.offTopic && !understandingDeferred(session) &&
        (session.understanding.inputRevision !== revision || session.understanding.draft));
  }
  function events(request, id) {
    const session = storage.get(id);
    const raw = request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('after') ?? '0';
    if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > session.seq) return json({ error: 'invalid-cursor' }, 400);
    let cleanup;
    const stream = new ReadableStream({
      start(controller) {
        const release = storage.hold(id);
        let closed = false, count = 0;
        const send = event => {
          if (closed) return;
          if (controller.desiredSize < -256 || ++count > 10_000) { cleanup(); controller.close(); return; }
          controller.enqueue(sse(event));
          // Preserve the synchronous voice-closing notification that follows
          // erasure in invalidate(), then close the revoked subscription.
          if (event.type === 'session.erased') queueMicrotask(() => { if (!closed) { cleanup(); controller.close(); } });
        };
        const set = listeners.get(id) ?? new Set();
        listeners.set(id, set);
        const heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(': heartbeat\n\n')); }, 15_000);
        const abort = () => { cleanup(); try { controller.close(); } catch {} };
        cleanup = () => {
          if (closed) return;
          closed = true; release(); clearInterval(heartbeat); set.delete(send);
          if (!set.size) listeners.delete(id);
          request.signal.removeEventListener('abort', abort); stop.signal.removeEventListener('abort', abort);
        };
        request.signal.addEventListener('abort', abort, { once: true });
        stop.signal.addEventListener('abort', abort, { once: true });
        // Synchronous replay + subscription cannot interleave with a publication.
        for (const event of storage.read(id, Number(raw))) send(event);
        if (!closed) set.add(send);
        if (request.signal.aborted || stop.signal.aborted) abort();
        else if (!closed) {
          if (unfinished(session)) schedule(id, { reconnect: true });
          status(id);
        }
      },
      cancel() { cleanup?.(); },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive', 'x-accel-buffering': 'no' } });
  }
  async function handle(request, context) {
    try {
      const previewResponse = await conceptHandlers.handlePreview(request);
      if (previewResponse) return previewResponse;
      if (stop.signal.aborted) return json({ error: 'server-stopping' }, 503);
      const hostResponse = await hostHandlers.handle(request, context);
      if (hostResponse) return hostResponse;
      if (host) {
        const ownedPath = /^\/api\/sessions\/([a-zA-Z0-9_-]{1,128})(?:\/|$)/u.exec(new URL(request.url).pathname);
        if (ownedPath) {
          const ownerToken = ownership.token(request);
          storage.authorize(ownedPath[1], ownerToken);
          if (!(request.method === 'GET' && /\/(?:identity|credits)$/u.test(new URL(request.url).pathname))) {
            hostHandlers.initialize(ownedPath[1], ownerToken);
          }
        }
      }
      const conceptResponse = await conceptHandlers.handle(request);
      if (conceptResponse) return conceptResponse;
      const voiceResponse = await voiceHandlers?.handle(request);
      if (voiceResponse) return voiceResponse;
      const uploadResponse = await uploadHandlers.handle(request);
      if (uploadResponse) return uploadResponse;
      const url = new URL(request.url);
      if (url.pathname === '/api/sessions' && request.method === 'POST') {
        const bytes = await readBody(request);
        const options = bytes.length ? JSON.parse(Buffer.from(bytes).toString('utf8')) : {};
        if (!options || typeof options !== 'object' || Array.isArray(options)) return json({ error: 'invalid-session' }, 400);
        const presented = ownership.token(request), ownerToken = presented || randomUUID();
        const initial = await initialSettings(presented, options);
        if (initial.error) return json({ error: initial.error, field: initial.field, reason: initial.reason }, initial.status);
        const session = storage.create({ ...sessionOptions, locale: options.locale ?? 'en', ownerToken, ...initial });
        hostHandlers.initialize(session.id, ownerToken, { newSession: true });
        const response = json(await snapshot(session.id), 201);
        if (ownership.created) ownership.created(response, ownerToken, request);
        else response.headers.set('x-aithema-session-token', ownerToken);
        return response;
      }
      const match = /^\/api\/sessions\/([a-zA-Z0-9_-]{1,128})(?:\/(turns|events|export|retry|pause|withdraw|consent|erase|settings|locale|focus-question))?$/u.exec(url.pathname);
      if (!match) return json({ error: 'not-found' }, 404);
      const [, id, action] = match;
      const ownerToken = ownership.token(request), authorized = storage.authorize(id, ownerToken);
      hostHandlers.initialize(id, ownerToken);
      const guard = { ownerToken, revision: inputRevision(authorized) };
      if (!action && request.method === 'GET') {
        host?.touchVisitor?.(authorized);
        return json(await snapshot(id));
      }
      if (action === 'events' && request.method === 'GET') return events(request, id);
      if (action === 'focus-question' && request.method === 'POST') {
        const body = JSON.parse(Buffer.from(await readBody(request)).toString('utf8'));
        const refused = result => json(result, result.reason === 'invalid-request' ? 400 :
          ['consent-required', 'not-admitted'].includes(result.reason) ? 403 : 409);
        const replyInFlight = () => jobs.has(`${id}:reaction`) || voiceHandlers?.replyInFlight(id);
        const inFlight = () => focusRequests.has(id) || replyInFlight();
        const decision = focusQuestion(storage.get(id), body, { inFlight: inFlight() });
        if (decision.error) return refused(decision);
        focusRequests.add(id);
        try {
          const reason = await pluginRuntime.checkReply(storage.get(id), { signal: request.signal,
            deadlineAt: Date.now() + deadlineMs });
          if (reason) return refused({ error: 'focus-refused', reason: isConsentReason(reason) ? 'consent-required' : 'not-admitted', admissionReason: reason });
          // Recheck assessment, input and pause after asynchronous availability work.
          const result = storage.focusQuestion(id, body, { ownerToken, inFlight: replyInFlight() });
          if (result.error) return refused(result);
          storage.clearLaneFailures(id, 'reaction');
          broadcast(id, result.event);
          scheduleLane(id, 'reaction'); status(id);
          return json({ accepted: true, event: result.event }, 202);
        } finally { focusRequests.delete(id); }
      }
      if (action === 'locale' && request.method === 'POST') {
        const body = JSON.parse(Buffer.from(await readBody(request)).toString('utf8'));
        if (!body || !['en', 'de'].includes(body.locale)) return json({ error: 'invalid-locale' }, 400);
        // No await between the connecting-call check and the transactional turn/call check.
        if (voiceHandlers?.active(id)) return json({ error: 'locale-conflict' }, 409);
        let event;
        try { event = storage.changeLocale(id, body.locale, { ownerToken }); }
        catch (error) { if (error instanceof ConflictError) return json({ error: 'locale-conflict' }, 409); throw error; }
        if (event) broadcast(id, event);
        return json({ event, session: await snapshot(id) });
      }
      if (action === 'turns' && request.method === 'POST') {
        if (purposePolicy && authorized.pauseReason === 'purpose') return json({ error: 'conversation-paused', reason: 'purpose' }, 409);
        // Bound the wire separately so JSON escapes do not consume the content budget.
        const bytes = await readBody(request, REQUEST_LIMIT * 2);
        let body;
        try { body = JSON.parse(Buffer.from(bytes).toString('utf8')); }
        catch (error) { if (bytes.length > REQUEST_LIMIT) throw new RangeError('Request limit'); throw error; }
        if (!body || typeof body.clientEventId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(body.clientEventId) ||
          typeof body.content !== 'string' || !body.content.trim() || body.content.length > 8000) return json({ error: 'invalid-turn' }, 400);
        const decodedBytes = Buffer.byteLength(body.content) + Buffer.byteLength(JSON.stringify({ ...body, content: '' }));
        if (decodedBytes > REQUEST_LIMIT) throw new RangeError('Request limit');
        pluginRuntime.conversationLimits.assertOpen(id);
        const voiceContext = body.voiceCallId === undefined ? {} : voiceHandlers?.typedContext(id, ownerToken, body.voiceCallId, body.providerSessionId);
        if (body.voiceCallId !== undefined && !voiceContext) return json({ error: 'voice-unavailable' }, 403);
        let initialBalance;
        const { event, replayed } = storage.postTurn(id, body.clientEventId, bytes, body.content,
          { ...guard, ...voiceContext, revision: body.inputRevision ?? guard.revision,
            ...(body.inputRevision === undefined && authorized.transcript.length === 0 ? { initialLocaleSeq: authorized.seq } : {}) },
          () => {
            try { initialBalance = hostHandlers.initialCreditBalance(id, ownerToken); }
            // Host failures must not inherit request-validation or plugin status codes.
            catch (cause) { throw new Error('Host credit preflight failed', { cause }); }
          });
        if (!replayed) lanes.supersede(id);
        if (!replayed) broadcast(id, event);
        if (!replayed) conceptHandlers.onTurn(id, event.data.id);
        if (!replayed) touchVisitor(storage.get(id));
        if (!replayed) hostHandlers.startCredits(id, ownerToken, initialBalance);
        schedule(id);
        return json(event, 200);
      }
      if (action === 'retry' && request.method === 'POST') {
        schedule(id, { retry: true }); return json({ accepted: true }, 202);
      }
      if (action === 'pause' && request.method === 'POST') {
        const body = JSON.parse(Buffer.from(await readBody(request)).toString('utf8'));
        if (purposePolicy && authorized.pauseReason === 'purpose') return json({ error: 'conversation-paused', reason: 'purpose' }, 409);
        if (typeof body?.paused !== 'boolean') return json({ error: 'invalid-pause' }, 400);
        let event;
        if (body.paused) {
          event = storage.pause(id, true, { ownerToken }); broadcast(id, event);
          await voiceHandlers?.pauseSession(id, true, { deadlineAt: Date.now() + deadlineMs });
        } else {
          const before = storage.get(id).seq;
          const voiceAck = await voiceHandlers?.pauseSession(id, false, { deadlineAt: Date.now() + deadlineMs });
          event = voiceAck ? storage.read(id, before).find(e => e.type === 'session.paused') : storage.pause(id, false, guard);
          if (event) broadcast(id, event);
        }
        if (!body.paused) { schedule(id); conceptHandlers.schedule(id); }
        hostHandlers.syncPause(id, ownerToken);
        return json({ paused: storage.get(id).paused, event });
      }
      if (action === 'withdraw' && request.method === 'POST') {
        const body = JSON.parse(Buffer.from(await readBody(request)).toString('utf8'));
        if (typeof body?.turnId !== 'string') return json({ error: 'invalid-withdrawal' }, 400);
        const event = storage.withdraw(id, body.turnId, 'withdrawal', guard);
        await invalidate(id, event, 'turn-withdrawn'); schedule(id);
        return json({ withdrawn: body.turnId, event });
      }
      if (action === 'settings' && request.method === 'GET') {
        return json({ ...await pluginRuntime.catalog(authorized), voiceCallActive: Boolean(voiceHandlers?.active(id)) });
      }
      if (action === 'settings' && request.method === 'POST') {
        const body = JSON.parse(Buffer.from(await readBody(request)).toString('utf8'));
        const acknowledged = { processingPreset: authorized.processingPreset, settings: authorized.settings };
        // Every save names its base revision; a stale base or a replay gets the current one back.
        if (!Number.isSafeInteger(body?.baseRevision) || body.baseRevision < 0) return json({ error: 'base-revision-required', ...acknowledged }, 400);
        if (body.baseRevision !== authorized.settings.revision) return json({ error: 'settings-conflict', ...acknowledged }, 409);
        // A running call keeps its choice; the visitor ends it explicitly to apply a change.
        if (voiceHandlers?.active(id)) return json({ error: 'voice-call-active' }, 409);
        const next = await pluginRuntime.validate(authorized, body);
        if (next.error) return json({ error: next.error, field: next.field, reason: next.reason }, next.status);
        if (voiceHandlers?.active(id)) return json({ error: 'voice-call-active' }, 409);
        let change; const before = storage.get(id);
        try { change = storage.changeSettings(id, next, { ownerToken, baseRevision: body.baseRevision, confirm: body.confirm === true }); }
        catch (error) {
          if (!(error instanceof SettingsConflictError)) throw error;
          return json({ error: error.code, processingPreset: error.session.processingPreset, settings: error.session.settings }, 409);
        }
        if (change.event) {
          broadcast(id, change.event);
          // Like new input: in-flight work on the previous choice is superseded and
          // unanswered input reruns with the new bindings; completed work stays cached.
          lanes.supersede(id); clearFailures(id);
          await uploadHandlers.cancelSession(id);
          if (selection(before, 'concept') !== selection(storage.get(id), 'concept')) void conceptHandlers.lane.supersede(id);
          if (unfinished(storage.get(id))) schedule(id); else status(id);
        }
        const current = storage.get(id), featureMatrix = await pluginRuntime.matrix(current);
        const features = FEATURES.filter(feature => isConsentReason(featureMatrix[current.processingPreset]?.[feature]?.reason));
        return json({ processingPreset: current.processingPreset, settings: current.settings, engine: pluginRuntime.describe(current),
          event: change.event, unchanged: !change.event, featureMatrix, consent: { required: features.some(feature => feature !== 'html'), features } });
      }
      if (action === 'consent' && request.method === 'POST') {
        const body = JSON.parse(Buffer.from(await readBody(request)).toString('utf8'));
        if (typeof body?.granted !== 'boolean') return json({ error: 'invalid-consent' }, 400);
        const expected = body.processing?.revision;
        if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) return json({ error: 'invalid-consent-revision' }, 400);
        const decide = async () => {
          const current = storage.authorize(id, ownerToken);
          // Refusal precedes every host port, mutation, invalidation and broadcast.
          // Omission is deprecated, retained for existing host integrations only.
          if (expected !== undefined && expected !== current.consentRevision) {
            return json({ error: 'consent-stale', consentRevision: current.consentRevision }, 409);
          }
          const checkCurrent = () => {
            const revision = storage.authorize(id, ownerToken).consentRevision;
            if (revision !== current.consentRevision) throw new ConsentConflictError(revision);
          };
          // Compare authoritative documents, never the caller's claimed changed scopes.
          let previousDocument;
          if (body.granted && consent.describe) {
            try { previousDocument = await (body.intent === 'settings-save' && body.processing
              ? consentDocument(current) : consentEnrichment(current)); }
            catch (error) {
              // Legacy grant-only hosts may expose an older describe shape.
              // Preserve their POST contract; Settings still requires a valid editor document.
              if (body.intent === 'settings-save' && body.processing) throw error;
            }
          }
          checkCurrent();
          // The editor names withdrawal explicitly; existing host ledger updates keep their cascade.
          if (body.intent === 'settings-save' && body.granted && body.processing && consent.describe) {
            const document = previousDocument;
            if (document.contract === body.processing.contract && Array.isArray(body.processing.items) &&
              consentSaveEndsConversation(document, body.processing.items)) return json({ error: 'withdrawal-required' }, 409);
          }
          const conversationUnchanged = body.granted && await consent.conversationUnchanged?.({ sessionId: id, decision: body.processing }) === true;
          checkCurrent();
          if (body.granted) {
            if (!consent?.grant) return json({ error: 'host-consent-required' }, 409);
            // decision.revision also lets an authoritative host ledger compare its base.
            const granted = await consent.grant({ sessionId: id, consentRevision: current.consentRevision + 1, decision: body.processing,
              scopes: pluginRuntime.scopes?.(current) ?? [] });
            if (granted === false) return json({ error: 'host-consent-required' }, 409);
            checkCurrent();
          }
          // Full withdrawal revokes every scope without waiting on host reads.
          let changed = body.granted ? undefined : FEATURES.map(feature => feature === 'html' ? 'html-drafts' : feature);
          let removed = body.granted ? undefined : [...changed];
          if (previousDocument) {
            // Revision-bound host ledgers have staged the accepted grant at the next
            // revision; this read precedes the atomic journal commit.
            const nextRevision = current.consentRevision + 1;
            try {
              const nextDocument = await consentEnrichment({ ...current, consentRevision: nextRevision }, { consentRevision: nextRevision, granted: true });
              const covered = (doc, feature) => (doc.features[feature] ?? []).every(id => doc.selected.includes(id));
              changed = FEATURES.filter(feature => covered(previousDocument, feature) !== covered(nextDocument, feature))
                .map(feature => feature === 'html' ? 'html-drafts' : feature);
              removed = FEATURES.filter(feature => covered(previousDocument, feature) && !covered(nextDocument, feature))
                .map(feature => feature === 'html' ? 'html-drafts' : feature);
            } catch { /* An unavailable enrichment read retains the legacy event/refresh path. */ }
            checkCurrent();
          }
          const event = storage.reviseConsent(id, body.granted, { ownerToken, revision: inputRevision(current), consentRevision: current.consentRevision }, { conversationUnchanged, changed, removed });
          if (event.data.conversationUnchanged) {
            broadcast(id, event); await conceptHandlers.lane.invalidate(id);
          } else await invalidate(id, event, 'consent-revised');
          if (body.granted) { schedule(id); conceptHandlers.schedule(id); }
          else await consent?.withdraw?.({ sessionId: id });
          return json({ granted: body.granted, consentRevision: storage.get(id).consentRevision, event });
        };
        return await (body.granted ? withConsent(id, decide) : decide());
      }
      if (action === 'consent' && request.method === 'GET' && consent.describe) {
        return await withConsent(id, async () => json(await consentDocument(storage.authorize(id, ownerToken))));
      }
      if (action === 'erase' && request.method === 'POST') {
        const event = await eraseConversation(id, guard, ownerToken);
        return json({ erased: true, event, providerDeletion: 'not-confirmed' });
      }
      if (action === 'export' && request.method === 'GET') {
        const session = storage.get(id);
        // Each artifact is published under the coverage of the visuals option that produced it.
        const allowed = new Map();
        const key = c => `${c.mediaType === 'text/html' ? 'html' : 'images'}|${c.operation ?? (c.referenceIds.length ? 'edit' : 'generate')}|${c.visuals ?? ''}|${c.id}`;
        for (const concept of session.concepts ?? []) if (!allowed.has(key(concept))) {
          const [visualKind, operation, visuals] = key(concept).split('|');
          allowed.set(key(concept), await pluginRuntime.publicationAllowed(session, { operation, visualKind, artifactId: concept.id, ...(visuals ? { visuals } : {}) }));
        }
        const current = storage.authorize(id, ownerToken);
        if (current.seq !== session.seq) throw new ConflictError('Export changed');
        const concepts = new Map((current.concepts ?? []).map(c => [c.id, c]));
        const artifacts = [], withheld = [];
        for (const { id: artifactId, erased } of storage.conceptArtifactIndex(id)) {
          const concept = concepts.get(artifactId);
          if (erased) withheld.push({ id: artifactId, reason: 'erased' });
          else if (!concept || !allowed.get(key(concept))) withheld.push({ id: artifactId,
            reason: current.consentWithdrawn ? 'consent-withdrawn' : 'publication-not-allowed' });
          else artifacts.push(storage.conceptArtifact(id, artifactId));
        }
        return new Response(exportSession(current, artifacts, withheld), {
        headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="aithema-session.zip"', 'cache-control': 'no-store' },
      });
      }
      return json({ error: 'method-not-allowed' }, 405);
    } catch (error) {
      if (error instanceof ConsentDocumentError) {
        try { await log({ event: 'consent.document.invalid', reason: error.message }); } catch { /* Host logging cannot expose the diagnostic to visitors. */ }
        return json({ error: 'consent-document-unavailable' }, 500);
      }
      if (error instanceof PrivacyDocumentRequiredError) return json({ error: error.code }, 403);
      if (error instanceof NotFoundError) return json({ error: 'session-not-found' }, 404);
      if (error instanceof ConsentConflictError) return json({ error: 'consent-stale', consentRevision: error.consentRevision }, 409);
      if (error instanceof ConflictError) return json({ error: 'idempotency-conflict' }, 409);
      if (error instanceof SyntaxError || error instanceof TypeError) return json({ error: 'invalid-request' }, 400);
      if (error instanceof RangeError) return json({ error: 'size-limit' }, 413);
      if (error instanceof PluginError) return json({ error: error.code,
        ...(['OpenRouter spend cap exhausted', 'OpenRouter request exceeds spend reservation', 'UI render limit reached for this session',
          'UI render limit reached for this UTC day',
          'current processing consent required', 'one-hour', 'session', 'voiceVisitor', 'host-limit'].includes(error.message) ? { reason: error.message } : {}) }, error.code === 'not-admitted' ? 403 : error.code === 'rate-limit' ? 429 : 502);
      return json({ error: 'server-error' }, 500);
    }
  }
  const retiring = new Set();
  async function retainedHandle(request, context) {
    const path = new URL(request.url).pathname;
    const match = /^\/api\/(?:sessions|library)\/([a-zA-Z0-9_-]{1,128})(?:\/|$)/u.exec(path);
    const erasureReleases = [];
    let release;
    if (match) {
      try {
        storage.authorize(match[1], ownership.token(request)); storage.touch(match[1]); release = storage.hold(match[1]);
        // A library port may perform more host cleanup after its erase callback.
        if (request.method === 'POST' && /\/(erase|delete|reset)$/u.test(path)) erasureReleases.push(storage.holdErasedRetirement(match[1]));
      } catch (error) { if (!(error instanceof NotFoundError)) throw error; }
    } else if (request.method === 'POST' && path === '/api/visitor/erase') {
      const ownerToken = ownership.token(request);
      if (ownerToken) for (const id of storage.ownedIds(ownerToken)) erasureReleases.push(storage.holdErasedRetirement(id));
    }
    try { return await handle(request, context); }
    finally { for (const finish of erasureReleases) finish(); release?.(); }
  }
  return { handle: retainedHandle,
    buildVoiceReplyRequest: (session, messages, call) => buildVoiceReplyRequest({ session, messages, call, hostPrompt, purposePolicy,
      offTopicTurns: storage.safeguards(session.id).offTopicTurns }),
    lanes, conceptLane: conceptHandlers.lane, removeConceptReference: conceptHandlers.removeReference,
    async withdrawConsent(id) {
      const event = storage.reviseConsent(id, false);
      await invalidate(id, event, 'consent-withdrawn');
      return event;
    },
    async expire(before) {
      return storage.systemWork(async () => {
        let after = '';
        while (true) {
          const ids = storage.liveIds(after);
          if (!ids.length) break;
          for (const id of ids) {
            after = id;
            let session;
            try { session = storage.get(id); } catch (error) { if (error instanceof NotFoundError) continue; throw error; }
            if (session.tombstone) continue;
            for (const turn of activeTurns(session).filter(t => t.role === 'user' && Date.parse(t.at) < before)) {
              const event = storage.expire(id, turn.id); await invalidate(id, event, 'turn-expired'); schedule(id);
              conceptHandlers.ended(id);
            }
            for (const upload of storage.get(id).uploads.filter(u => u.state !== 'withdrawn' && Date.parse(u.at) < before)) {
              const event = storage.withdrawUpload(id, upload.id);
              await Promise.all([uploadHandlers.cancelUpload(id, upload.id), invalidate(id, event, 'upload-expired'), conceptHandlers.lane.supersede(id)]);
              schedule(id); conceptHandlers.ended(id);
            }
            // Finish maintenance rebuilds before the host's next retirement sweep.
            await Promise.allSettled([...jobs.values()].filter(job => job.id === id).map(job => job.promise));
          }
        }
      });
    },
    async retire({ before, limit = 100 } = {}) {
      if (!Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid retention request');
      storage.queueErasedRetirements(limit);
      const pending = storage.pendingRetirements(limit);
      const candidates = [...pending, ...storage.retirementCandidates(before, limit - pending.length)];
      let retired = 0, failed = 0;
      for (const id of candidates) {
        if (retiring.has(id)) continue;
        retiring.add(id);
        try {
          if (pending.includes(id)) {
            const event = storage.read(id).findLast(event => event.type === 'session.erased');
            await invalidate(id, event, 'session-erased');
          } else {
            if (voiceHandlers?.retentionActive(id) || hostHandlers.retentionActive(id)) { storage.touch(id); continue; }
            if (!await eraseConversation(id, { retire: true, before })) continue;
          }
          storage.assertRetirementSettled(id);
          await consent?.withdraw?.({ sessionId: id });
          if (host?.retired) {
            let timer;
            try {
              await Promise.race([
                Promise.resolve().then(() => host.retired({ sessionId: id, ownerHash: storage.retirementOwnerHash(id) })),
                new Promise((_, reject) => { timer = setTimeout(() => {
                  reject(new RetirementHookTimeoutError('Retirement hook deadline'));
                }, retiredHookTimeoutMs); }),
              ]);
            } finally { clearTimeout(timer); }
          }
          storage.purgeRetired(id); retired++;
        } catch (error) {
          // A durable tombstone is retried independently; other sessions keep moving.
          log({ event: 'session.retirement.failed', sessionId: id, error: error instanceof Error ? error.constructor.name : 'UnknownError' });
          storage.failRetirement(id); failed++;
        } finally { retiring.delete(id); }
      }
      storage.checkpointErasure();
      return { retired, failed, more: storage.pendingRetirements(1).length > 0 || storage.retirementCandidates(before, 1).length > 0 || storage.hasErasedRetirementBacklog() };
    },
    /** Privileged in-process operator port. The public HTTP erase keeps its cancellation semantics. */
    async eraseSession({ sessionId, visitor = false }) {
      if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(sessionId) || typeof visitor !== 'boolean') throw new TypeError('Invalid erase request');
      let session;
      try { session = storage.get(sessionId); }
      catch (error) { if (error instanceof NotFoundError) error.status = 404; throw error; }
      if (visitor && !host?.eraseVisitorForOwnerHash) throw Object.assign(new Error('visitor-unavailable'), { status: 503 });
      const scope = visitor ? storage.ownedIdsForHash(session.ownerHash, { includeErased: true }) : [sessionId];
      const ids = scope.filter(id => !storage.get(id).tombstone);
      // Preflight the entire visitor before changing anything. There is no await
      // between these checks and every storage.erase, so new dispatch cannot race in.
      for (const id of ids) {
        const current = storage.get(id);
        if (voiceHandlers?.retentionActive(id) || storage.voiceCalls(id).some(call => !call.terminal)) {
          throw Object.assign(new Error('voice-call-active'), { status: 409 });
        }
        if ([...jobs.values()].some(job => job.id === id) || pluginRuntime.budget.hasPendingDispatch(id) ||
          hostHandlers.retentionActive(id) || host?.pendingDispatchForSession?.(id) || current.conceptIntent?.pending || current.uploads.some(upload => upload.state === 'pending')) {
          throw Object.assign(new Error('pending-dispatch'), { status: 409 });
        }
      }
      // Retry host cleanup for tombstones too: a previous call may have failed
      // after the durable erase but before the host acknowledged its cleanup.
      const releases = scope.map(id => storage.holdErasedRetirement(id));
      try {
        const live = new Set(ids);
        const cleanups = await Promise.allSettled(scope.map(async id => {
          if (live.has(id)) return eraseConversation(id, {});
          // storage.erase commits before truncating the WAL. If that checkpoint
          // failed, retry it and the event/cancellation cascade before acknowledging.
          storage.checkpointErasure();
          const event = storage.read(id).findLast(event => event.type === 'session.erased');
          await invalidate(id, event, 'session-erased');
          await host?.erased?.({ sessionId: id });
        }));
        const failure = cleanups.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
        if (visitor) await host.eraseVisitorForOwnerHash(session.ownerHash);
        return { id: sessionId, visitor, erased: true, result: ids.length ? 'erased' : 'already-erased',
          erasedSessions: ids.length, providerDeletion: 'not-confirmed' };
      } finally { for (const release of releases) release(); }
    },
    async reconcileUncertain({ apply = false, limit = 10 } = {}) {
      if (typeof apply !== 'boolean' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid repair request');
      const options = { dryRun: !apply, limit, signal: stop.signal, deadlineAt: Date.now() + 60_000 };
      const reasoning = await pluginRuntime.reconcileCosts(options);
      const voice = await voiceHandlers?.reconcileUncertain(options) ?? { candidates: 0, beforeMicro: 0, afterMicro: 0, corrected: 0, pending: 0 };
      return { dryRun: !apply, reasoning, voice };
    },
    reconcileVoiceLater() { voiceHandlers?.reconcileLater(); },
    async resume() {
      await storage.systemWork(async () => {
        pluginRuntime.conversationLimits.resume((id, reason) => voiceHandlers?.stopSession(id, reason));
        hostHandlers.resume();
        pluginRuntime.budget.recover();
        host?.recoverWallets?.();
        await pluginRuntime.recoverCosts?.();
        await pluginRuntime.reconcileCosts?.({ signal: stop.signal });
        reconcileCostsLater();
        uploadHandlers.resume();
        await conceptHandlers.resume();
        await voiceHandlers?.resume();
      });
      // Recover one session (at most two reasoning lanes) at a time. Live visitor
      // work remains independent; idle/close also wait for this boot backlog.
      if (!recovery && !stop.signal.aborted) {
        recovery = (async () => {
          for (const id of storage.list()) {
            if (stop.signal.aborted) break;
            if (!unfinished(storage.get(id))) continue;
            schedule(id, { reconnect: true });
            await Promise.allSettled([...jobs.values()].filter(job => job.id === id).map(job => job.promise));
          }
        })().finally(() => { recovery = null; });
        recovery.catch(() => {});
      }
    },
    async idle() {
      do {
        await uploadHandlers.idle();
        await recovery;
        await costRecovery;
        while (jobs.size) await Promise.allSettled([...jobs.values()].map(job => job.promise));
        await conceptHandlers.lane.idle();
        await voiceHandlers?.idle();
        await hostHandlers.idle();
      } while (jobs.size);
    },
    async close() { stop.abort(); conceptHandlers.closePreviews(); pluginRuntime.conversationLimits.close(); clearTimeout(costTimer); await uploadHandlers.close(); await conceptHandlers.lane.close(); await voiceHandlers?.close(); await hostHandlers.idle(); await Promise.allSettled([recovery, costRecovery, ...[...jobs.values()].map(job => job.promise)]); },
  };
}
