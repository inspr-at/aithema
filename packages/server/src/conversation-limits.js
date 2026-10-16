import { CONVERSATION_LIMIT_MS, PluginError } from '@inspr/aithema-core';

/** The durable guard is authoritative; timers only wake it. Admission rechecks
 * the clock independently, so a delayed event loop cannot authorize late spend.
 * Expiry never cancels text jobs or mutates their budget reservations. */
export function createConversationLimits({ storage, now = Date.now, durationMs = CONVERSATION_LIMIT_MS, publish = () => {} }) {
  const timers = new Map();
  function cancel(id) { clearTimeout(timers.get(id)?.timer); timers.delete(id); }
  function arm(id, state) {
    if (state?.status !== 'active') { cancel(id); return; }
    if (timers.get(id)?.endsAt === state.endsAt) return;
    cancel(id);
    const timer = setTimeout(() => {
      timers.delete(id);
      storage.systemWork(() => {
        if (!storage.creditState(id) || storage.get(id).tombstone) return;
        transition(id, { type: 'tick' });
      });
    }, Math.max(0, state.endsAt - now()));
    timer.unref?.(); timers.set(id, { timer, endsAt: state.endsAt });
  }
  function transition(id, event, ownerToken) {
    const result = storage.transitionCredits(id, ownerToken, { ...event, now: now() }, { durationMs });
    arm(id, result.state);
    for (const e of result.events) publish(id, e);
    return result.state;
  }
  function check(id) {
    let state = storage.creditState(id);
    if (state?.status === 'active' && Math.max(now(), state.lastNow) >= state.endsAt) state = transition(id, { type: 'tick' });
    return ['ending', 'ended'].includes(state?.status) ? state.endReason ?? 'session' : null;
  }
  return {
    configure(options) {
      now = options.now ?? now; publish = options.publish ?? publish;
      durationMs = options.durationMs ?? durationMs;
      if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > CONVERSATION_LIMIT_MS) throw new TypeError('Invalid conversation deadline');
    },
    transition,
    assertOpen(id) { const reason = check(id); if (reason) throw new PluginError('not-admitted', reason); },
    start(id) {
      this.assertOpen(id);
      const state = storage.creditState(id);
      if (!state || state.status === 'ready') return transition(id, { type: 'start' });
      arm(id, state); return state;
    },
    deadline(id) { return storage.creditState(id)?.endsAt ?? Infinity; },
    resume(onEnd = () => {}) {
      for (const id of storage.list()) {
        if (storage.get(id).tombstone) continue;
        const reason = check(id);
        if (reason) onEnd(id, reason);
        arm(id, storage.creditState(id));
      }
    },
    close() { for (const id of timers.keys()) cancel(id); },
  };
}
