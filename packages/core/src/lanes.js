import { inputRevision, activeTurns, openQuestionItems } from './session.js';
import { PluginError } from './invocation.js';
import { pendingQuestionFocus } from './question-focus.js';
import { reduceUnderstanding, understandingSchema } from './understanding.js';
import { reasoningRequest } from './prompts.js';
import { assertReasoning, operationScope, matchesSchema } from './reasoning.js';
import { untilCancelled, cancellableStream } from './cancellation.js';
import { hasConversationInput, understandingDeferred } from './document-context.js';
import { aiTextOrigin } from './text-origin.js';
import { ReplyStream } from './reply.js';
import { collectPurposeReply } from './safeguards.js';
import { stripThanksOpener } from './reply-opener.js';
import { ReplyOpenerStream } from './reply-opener.js';

const producer = (admitted, plugin) => aiTextOrigin(admitted?.producer ?? plugin.binding ??
  { model: plugin.model, plugin: plugin.manifest?.id ?? plugin.id });

export class SessionLanes {
  #flights = new Map();
  constructor({ reasoning, draftReasoning = reasoning, getSession, publish, transient = () => {}, deadlineMs = 30_000, now = () => Date.now(),
    hostPrompt = '', purposePolicy, offTopicTurns = () => 0, guardDirection = (_, reply) => reply, onScope = () => {}, canUnderstand = () => true, understandingInput = session => session, scopeKnown, retainUnderstanding = () => false, keepUnderstanding = () => false, settleUnderstanding, replyVisible = () => true, focusReplyAvailable = () => true, admit, beforeDispatch = admit ? undefined : async () => false, selection = () => '', onOpenerStripped = () => {}, onReplyDiagnostic = () => {} }) {
    this.reasoning = assertReasoning(reasoning);
    this.draftReasoning = assertReasoning(draftReasoning);
    Object.assign(this, { getSession, publish, transient, deadlineMs, now, hostPrompt, purposePolicy, offTopicTurns, guardDirection, onScope, canUnderstand, understandingInput, scopeKnown, retainUnderstanding, keepUnderstanding, settleUnderstanding, replyVisible, focusReplyAvailable, admit, beforeDispatch, selection, onOpenerStripped, onReplyDiagnostic });
  }
  // A changed processing selection supersedes in-flight work exactly like new input:
  // its late result is stale and the host reruns the lane with the new binding.
  supersede(id) {
    const session = this.getSession(id), revision = inputRevision(session);
    for (const flight of this.#flights.values()) if (flight.id === id &&
      (flight.revision !== revision && !(flight.lane === 'understanding' && this.retainUnderstanding(flight.session, session, true)) || flight.selection !== this.selection(session, flight.lane))) {
      // A paid project analysis owns its original input. New turns can make its
      // result stale, but must not discard the provider receipt by aborting it.
      // Consent, withdrawal, locale and processing-choice fences still cancel.
      if (flight.lane === 'understanding' && flight.admitted &&
        flight.selection === this.selection(session, flight.lane) && this.keepUnderstanding(flight.session, session)) continue;
      flight.controller.abort(new DOMException('Input superseded', 'AbortError'));
    }
  }
  cancel(id) {
    const pending = [];
    for (const flight of this.#flights.values()) if (flight.id === id) {
      flight.revoked = true;
      flight.controller.abort(new DOMException('Session revoked', 'AbortError'));
      pending.push(flight.promise);
    }
    return Promise.allSettled(pending);
  }
  run(id, lane, { signal } = {}) {
    if (!['understanding', 'reaction'].includes(lane)) throw new TypeError('Unknown lane');
    const key = `${id}:${lane}`;
    const session = this.getSession(id), selection = this.selection(session, lane);
    const running = this.#flights.get(key);
    if (running && !running.controller.signal.aborted) {
      if (running.selection === selection) return running.promise;
      running.controller.abort(new DOMException('Selection superseded', 'AbortError'));
    }
    const revision = inputRevision(session);
    const focus = lane === 'reaction' ? pendingQuestionFocus(session) : null;
    const focusData = focus ? { focusRequestId: focus.requestId } : {};
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const deadlineAt = this.now() + this.deadlineMs;
    const scope = operationScope({ signal: controller.signal, deadlineAt, now: this.now });
    const current = () => {
      const latest = this.getSession(id);
      const valid = !scope.signal.aborted && !latest.tombstone && latest.ownerHash === session.ownerHash && (inputRevision(latest) === revision || lane === 'understanding' && this.retainUnderstanding(session, latest, false)) &&
        this.selection(latest, lane) === selection && (!focus ||
          !latest.paused && pendingQuestionFocus(latest)?.requestId === focus.requestId);
      // Accepted focus owns the question text, while assessment IDs are ephemeral.
      // A replacement may reorder that question; removing it must fail visibly.
      if (valid && focus && !openQuestionItems(latest).some(item => item.question === session.focusedQuestion)) {
        throw new PluginError('not-admitted', 'focused-question-removed');
      }
      if (valid && focus && !this.focusReplyAvailable(id)) throw new PluginError('not-admitted', 'reply-in-flight');
      return valid;
    };
    const options = { signal: scope.signal, deadlineAt, now: this.now };

    const work = async () => {
      scope.signal.throwIfAborted();
      if (session.tombstone || session.consentWithdrawn) return 'blocked';
      if (lane === 'understanding') {
        if (this.purposePolicy && !this.canUnderstand(id, revision)) return 'deferred';
        if (session.identity?.verificationRequired === true && !session.identity.assessmentUnlocked) return 'verification-required';
        const assessmentInput = this.understandingInput(session);
        if (!assessmentInput || understandingDeferred(assessmentInput)) return 'deferred';
        if (session.understanding.inputRevision === revision && !session.understanding.draft) return 'cached';
        // A distinct draft binding can retain the incremental path without paying
        // twice for the same model in the slice-1 host.
        for (const draft of this.draftReasoning === this.reasoning ? [false] : [true, false]) {
          if (!current()) return 'stale';
          const latest = this.getSession(id);
          if (draft && latest.understanding.inputRevision === revision && latest.understanding.draft) continue;
          const binding = draft ? this.draftReasoning : this.reasoning;
          if (this.getSession(id).paused && !(this.purposePolicy && session.pauseReason === 'purpose')) return 'paused';
          if (this.beforeDispatch && !await untilCancelled(this.beforeDispatch(id, lane, binding, revision, options), scope.signal)) return 'blocked';
          if (!current()) return 'stale';
          const request = { ...reasoningRequest({ ...latest, transcript: assessmentInput.transcript }, lane, draft, this.hostPrompt, { purposePolicy: this.purposePolicy }), schema: understandingSchema(session.preset) };
          let raw, admitted;
          for (let attempt = 0; attempt < 2; attempt++) {
            const input = attempt ? { ...request, understandingSchemaConstrained: false,
              system: `${request.system}\nReturn only JSON matching this schema: ${JSON.stringify(request.schema)}` } : request;
            // Compatibility consumes one attempt and needs fresh admission,
            // current consent, price checks and its own terminal settlement.
            admitted = await this.admit?.({ session: this.getSession(id), lane, operation: 'structured', request: input, options: { ...options, purposeAssessment: Boolean(this.purposePolicy) } });
            flight.admitted = Boolean(admitted);
            let failed = false, retry = false, failureError;
            try {
              raw = await untilCancelled((admitted?.plugin ?? binding).structured(input, admitted?.options ?? options), scope.signal);
              if (!matchesSchema(raw, request.schema)) throw new TypeError('Invalid understanding output');
            } catch (error) {
              failed = true; failureError = error;
              if (attempt === 0 && error.responseFormatUnsupported === true && !scope.signal.aborted && current()) retry = true;
              else throw error;
            } finally { await admitted?.finish({ failed, error: failureError }); }
            if (!retry) break;
            scope.signal.throwIfAborted();
            if (!current()) return 'stale';
          }
          // An already admitted project assessment may outlive off-topic redirects.
          // Wait for their classification before accepting its original input.
          if (this.settleUnderstanding) await untilCancelled(this.settleUnderstanding(session, options), scope.signal);
          if (!current()) return 'stale';
          if (!matchesSchema(raw, understandingSchema(session.preset))) throw new TypeError('Invalid understanding output');
          const data = { ...reduceUnderstanding(this.getSession(id).understanding, raw, {
            transcript: activeTurns(assessmentInput), inputRevision: revision, locale: session.locale,
            draft, actor: this.getSession(id).actor, preset: session.preset,
          }), ...producer(admitted, admitted?.plugin ?? binding) };
          if (!this.publish(id, 'understanding.updated', data, revision, undefined, session)) return 'stale';
          // Verify persisted state before a final result is reported.
          if (!current() || this.getSession(id).understanding.inputRevision !== revision) return 'stale';
        }
      } else {
        if (!hasConversationInput(session)) return 'deferred';
        if (!focus && (this.purposePolicy && this.scopeKnown ? this.scopeKnown(id, revision) :
          activeTurns(session).some(t => t.role === 'assistant' && t.inputRevision === revision))) return 'cached';
        if (this.getSession(id).paused) return 'paused';
        if (this.beforeDispatch && !await untilCancelled(this.beforeDispatch(id, lane, this.reasoning, revision, options), scope.signal)) return 'blocked';
        if (!current() || this.getSession(id).paused) return 'stale';
        if (this.purposePolicy) {
          const request = reasoningRequest(session, lane, false, this.hostPrompt, { purposePolicy: this.purposePolicy, offTopicTurns: this.offTopicTurns(id), focusQuestion: focus ? session.focusedQuestion : undefined });
          let admitted;
          const self = this;
          // Supersession is a lane outcome, never an empty provider reply.
          const superseded = new Error('Reply superseded');
          const reply = await collectPurposeReply(request, async function* (input) {
            if (!current()) throw superseded;
            admitted = await self.admit?.({ session: self.getSession(id), lane, operation: 'stream', request: input, options });
            let failed = false;
            try {
              if (!current()) throw superseded;
              for await (const delta of cancellableStream((admitted?.plugin ?? self.reasoning).stream(input, admitted?.options ?? options), scope.signal)) {
                if (!current()) throw superseded;
                yield delta;
              }
            }
            catch (error) { failed = true; throw error; }
            finally {
              await admitted?.finish({ failed });
              scope.signal.throwIfAborted();
              if (!current()) throw superseded;
            }
          }, { guardDirection: reply => current() && !focus ? this.guardDirection(id, reply) : reply,
            onDiagnostic: event => { if (current()) this.onReplyDiagnostic({ lane, ...event }); } }).catch(error => {
            const latest = this.getSession(id);
            if (flight.revoked || error === superseded || inputRevision(latest) !== revision || this.selection(latest, lane) !== selection) return null;
            throw error;
          });
          if (!current()) return 'stale';
          const guarded = stripThanksOpener(reply.content, session.locale);
          if (guarded.stripped) this.onOpenerStripped();
          const { scope: classification, ...visible } = reply;
          // A non-delegating simulator already owns its normal spoken reply.
          // Classify privately without adding a duplicate assistant turn.
          if (!focus && !this.replyVisible(session) && classification !== 'off') {
            this.onScope(id, classification, revision, { reply: false });
            return 'completed';
          }
          if (!this.publish(id, 'turn.final', { id: crypto.randomUUID(), role: 'assistant', ...visible, ...focusData, content: guarded.text,
            ...producer(admitted, admitted?.plugin ?? this.reasoning), at: new Date().toISOString(), inputRevision: revision,
            ...(admitted?.engine ? { engine: admitted.engine } : {}) }, revision, classification)) return 'stale';
          if (!focus) this.onScope(id, classification, revision);
          return 'completed';
        }
        const turnId = crypto.randomUUID();
        const reply = new ReplyStream(), opener = new ReplyOpenerStream(session.locale); let decoded = '', shown = '', draftProducer;
        const request = reasoningRequest(session, lane, false, this.hostPrompt, { focusQuestion: focus ? session.focusedQuestion : undefined });
        const admitted = await this.admit?.({ session: this.getSession(id), lane, operation: 'stream', request, options });
        let failed = false;
        try { for await (const delta of cancellableStream((admitted?.plugin ?? this.reasoning).stream(request, admitted?.options ?? options), scope.signal)) {
          if (!current()) return 'stale';
          const chunk = reply.push(delta); decoded += chunk;
          if (chunk) draftProducer = producer(admitted, admitted?.plugin ?? this.reasoning);
          const text = opener.push(chunk);
          if (!text) continue;
          shown += text;
          // Tagged with the settings revision it started under, so a client never shows a
          // superseded stream beside its replacement.
          this.transient(id, { type: 'turn.partial', data: { id: turnId, delta: text, ...draftProducer,
            inputRevision: revision, settingsRevision: session.settings?.revision ?? 0 } });
        } } catch (error) { failed = true; throw error; }
        finally { await admitted?.finish({ failed }); }
        if (!current()) return 'stale';
        const { content: rawContent, question_short, options: answers } = reply.finish();
        if (!rawContent.trim()) throw new TypeError('Empty reasoning stream');
        // A provider may reorder JSON properties; reveal its remaining text only after parsing.
        const tail = (rawContent.startsWith(decoded) ? opener.push(rawContent.slice(decoded.length)) : '') + opener.finish();
        if (tail) this.transient(id, { type: 'turn.partial', data: {
          id: turnId, delta: tail, ...(draftProducer ?? producer(admitted, admitted?.plugin ?? this.reasoning)),
          inputRevision: revision, settingsRevision: session.settings?.revision ?? 0 } });
        const content = shown + tail;
        if (opener.stripped) this.onOpenerStripped();
        // The admitted public choice labels which model and effort produced this reply.
        if (!this.publish(id, 'turn.final', { id: turnId, role: 'assistant', content, question_short, options: answers, ...focusData,
          ...producer(admitted, admitted?.plugin ?? this.reasoning),
          at: new Date().toISOString(), inputRevision: revision, ...(admitted?.engine ? { engine: admitted.engine } : {}) }, revision)) return 'stale';
      }
      return 'completed';
    };
    const flight = { id, lane, session, revision, selection, controller, revoked: false, admitted: false, promise: null };
    const promise = Promise.resolve().then(work).finally(() => {
      scope.dispose(); signal?.removeEventListener('abort', abort);
      if (this.#flights.get(key) === flight) this.#flights.delete(key);
    });
    flight.promise = promise; this.#flights.set(key, flight);
    return promise;
  }
}
