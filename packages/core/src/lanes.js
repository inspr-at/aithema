import { inputRevision, activeTurns } from './session.js';
import { reduceUnderstanding, understandingSchema } from './understanding.js';
import { reasoningRequest } from './prompts.js';
import { assertReasoning, operationScope, matchesSchema } from './reasoning.js';
import { untilCancelled, cancellableStream } from './cancellation.js';
import { documentInputs, hasConversationInput } from './document-context.js';

export class SessionLanes {
  #flights = new Map();
  constructor({ reasoning, draftReasoning = reasoning, getSession, publish, transient = () => {}, deadlineMs = 30_000,
    hostPrompt = '', admit, beforeDispatch = admit ? undefined : async () => false, selection = () => '' }) {
    this.reasoning = assertReasoning(reasoning);
    this.draftReasoning = assertReasoning(draftReasoning);
    Object.assign(this, { getSession, publish, transient, deadlineMs, hostPrompt, admit, beforeDispatch, selection });
  }
  // A changed processing selection supersedes in-flight work exactly like new input:
  // its late result is stale and the host reruns the lane with the new binding.
  supersede(id) {
    const session = this.getSession(id), revision = inputRevision(session);
    for (const flight of this.#flights.values()) if (flight.id === id &&
      (flight.revision !== revision || flight.selection !== this.selection(session, flight.lane))) {
      flight.controller.abort(new DOMException('Input superseded', 'AbortError'));
    }
  }
  cancel(id) {
    const pending = [];
    for (const flight of this.#flights.values()) if (flight.id === id) {
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
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const deadlineAt = Date.now() + this.deadlineMs;
    const scope = operationScope({ signal: controller.signal, deadlineAt });
    const current = () => {
      const latest = this.getSession(id);
      return !scope.signal.aborted && !latest.tombstone && latest.ownerHash === session.ownerHash && inputRevision(latest) === revision &&
        this.selection(latest, lane) === selection;
    };
    const options = { signal: scope.signal, deadlineAt };
    const work = async () => {
      scope.signal.throwIfAborted();
      if (session.tombstone || session.consentWithdrawn) return 'blocked';
      if (lane === 'understanding') {
        if (session.identity?.verificationRequired === true && !session.identity.assessmentUnlocked) return 'verification-required';
        const humanTurns = activeTurns(session).filter(t => t.role === 'user').length + documentInputs(session).length;
        if (!humanTurns || (!session.demo && !session.identified && humanTurns < session.preset.anonymousTurns)) return 'deferred';
        if (session.understanding.inputRevision === revision && !session.understanding.draft) return 'cached';
        // A distinct draft binding can retain the incremental path without paying
        // twice for the same model in the slice-1 host.
        for (const draft of this.draftReasoning === this.reasoning ? [false] : [true, false]) {
          if (!current()) return 'stale';
          const latest = this.getSession(id);
          if (draft && latest.understanding.inputRevision === revision && latest.understanding.draft) continue;
          const binding = draft ? this.draftReasoning : this.reasoning;
          if (this.getSession(id).paused) return 'paused';
          if (this.beforeDispatch && !await untilCancelled(this.beforeDispatch(id, lane, binding, revision, options), scope.signal)) return 'blocked';
          if (!current()) return 'stale';
          const request = { ...reasoningRequest(latest, lane, draft, this.hostPrompt), schema: understandingSchema(session.preset) };
          const admitted = await this.admit?.({ session: this.getSession(id), lane, operation: 'structured', request, options });
          let raw, failed = false;
          try { raw = await untilCancelled((admitted?.plugin ?? binding).structured(request, admitted?.options ?? options), scope.signal); }
          catch (error) { failed = true; throw error; }
          finally { admitted?.finish({ failed }); }
          if (!current()) return 'stale';
          if (!matchesSchema(raw, understandingSchema(session.preset))) throw new TypeError('Invalid understanding output');
          const data = reduceUnderstanding(this.getSession(id).understanding, raw, {
            transcript: activeTurns(this.getSession(id)), inputRevision: revision, locale: session.locale,
            draft, actor: this.getSession(id).actor, preset: session.preset,
          });
          if (!this.publish(id, 'understanding.updated', data, revision)) return 'stale';
          // Verify persisted state before a final result is reported.
          if (!current() || this.getSession(id).understanding.inputRevision !== revision) return 'stale';
        }
      } else {
        if (!hasConversationInput(session)) return 'deferred';
        if (activeTurns(session).some(t => t.role === 'assistant' && t.inputRevision === revision)) return 'cached';
        if (this.getSession(id).paused) return 'paused';
        if (this.beforeDispatch && !await untilCancelled(this.beforeDispatch(id, lane, this.reasoning, revision, options), scope.signal)) return 'blocked';
        if (!current() || this.getSession(id).paused) return 'stale';
        const turnId = crypto.randomUUID();
        let content = '';
        const request = reasoningRequest(session, lane, false, this.hostPrompt);
        const admitted = await this.admit?.({ session: this.getSession(id), lane, operation: 'stream', request, options });
        let failed = false;
        try { for await (const delta of cancellableStream((admitted?.plugin ?? this.reasoning).stream(request, admitted?.options ?? options), scope.signal)) {
          if (!current()) return 'stale';
          if (typeof delta !== 'string' || content.length + delta.length > 16_000) throw new TypeError('Invalid reasoning stream');
          content += delta;
          // Tagged with the settings revision it started under, so a client never shows a
          // superseded stream beside its replacement.
          this.transient(id, { type: 'turn.partial', data: { id: turnId, delta, inputRevision: revision, settingsRevision: session.settings?.revision ?? 0 } });
        } } catch (error) { failed = true; throw error; }
        finally { admitted?.finish({ failed }); }
        if (!current()) return 'stale';
        if (!content.trim()) throw new TypeError('Empty reasoning stream');
        // The admitted public choice labels which model and effort produced this reply.
        if (!this.publish(id, 'turn.final', { id: turnId, role: 'assistant', content,
          at: new Date().toISOString(), inputRevision: revision, ...(admitted?.engine ? { engine: admitted.engine } : {}) }, revision)) return 'stale';
      }
      return 'completed';
    };
    const flight = { id, lane, revision, selection, controller, promise: null };
    const promise = Promise.resolve().then(work).finally(() => {
      scope.dispose(); signal?.removeEventListener('abort', abort);
      if (this.#flights.get(key) === flight) this.#flights.delete(key);
    });
    flight.promise = promise; this.#flights.set(key, flight);
    return promise;
  }
}
