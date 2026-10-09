import { inputRevision } from './session.js';
import { reduceUnderstanding, understandingSchema } from './understanding.js';
import { reasoningRequest } from './prompts.js';
import { assertReasoning, operationScope, matchesSchema } from './reasoning.js';

export class SessionLanes {
  #flights = new Map();
  constructor({ reasoning, getSession, publish, transient = () => {}, deadlineMs = 30_000, hostPrompt = '' }) {
    this.reasoning = assertReasoning(reasoning);
    Object.assign(this, { getSession, publish, transient, deadlineMs, hostPrompt });
  }
  run(id, lane, { signal } = {}) {
    if (!['understanding', 'reaction'].includes(lane)) throw new TypeError('Unknown lane');
    const key = `${id}:${lane}`;
    if (this.#flights.has(key)) return this.#flights.get(key).promise;
    const session = this.getSession(id);
    const revision = inputRevision(session);
    const scope = operationScope({ signal, deadlineAt: Date.now() + this.deadlineMs });
    const current = () => !scope.signal.aborted && inputRevision(this.getSession(id)) === revision;
    const options = { signal: scope.signal, deadlineAt: Date.now() + this.deadlineMs };
    const work = async () => {
      scope.signal.throwIfAborted();
      if (lane === 'understanding') {
        const humanTurns = session.transcript.filter(t => t.role === 'user').length;
        if (!humanTurns || (!session.demo && !session.identified && humanTurns < session.preset.anonymousTurns)) return 'deferred';
        if (session.understanding.inputRevision === revision && !session.understanding.draft) return 'cached';
        for (const draft of [true, false]) {
          if (!current()) return 'stale';
          const latest = this.getSession(id);
          if (draft && latest.understanding.inputRevision === revision && latest.understanding.draft) continue;
          const raw = await this.reasoning.structured({ ...reasoningRequest(latest, lane, draft, this.hostPrompt),
            schema: understandingSchema(session.preset) }, options);
          if (!current()) return 'stale';
          if (!matchesSchema(raw, understandingSchema(session.preset))) throw new TypeError('Invalid understanding output');
          const data = reduceUnderstanding(this.getSession(id).understanding, raw, {
            transcript: this.getSession(id).transcript, inputRevision: revision, locale: session.locale,
            draft, actor: this.getSession(id).actor, preset: session.preset,
          });
          if (!this.publish(id, 'understanding.updated', data, revision)) return 'stale';
          // Verify persisted state before a final result is reported.
          if (!current() || this.getSession(id).understanding.inputRevision !== revision) return 'stale';
        }
      } else {
        if (!session.transcript.some(t => t.role === 'user')) return 'deferred';
        if (session.transcript.some(t => t.role === 'assistant' && t.inputRevision === revision)) return 'cached';
        const turnId = crypto.randomUUID();
        let content = '';
        for await (const delta of this.reasoning.stream(reasoningRequest(session, lane, false, this.hostPrompt), options)) {
          if (!current()) return 'stale';
          if (typeof delta !== 'string' || content.length + delta.length > 16_000) throw new TypeError('Invalid reasoning stream');
          content += delta;
          this.transient(id, { type: 'turn.partial', data: { id: turnId, delta, inputRevision: revision } });
        }
        if (!current()) return 'stale';
        if (!content.trim()) throw new TypeError('Empty reasoning stream');
        if (!this.publish(id, 'turn.final', { id: turnId, role: 'assistant', content,
          at: new Date().toISOString(), inputRevision: revision }, revision)) return 'stale';
      }
      return 'completed';
    };
    const promise = Promise.resolve().then(work).finally(() => { scope.dispose(); this.#flights.delete(key); });
    this.#flights.set(key, { promise, scope });
    return promise;
  }
}
