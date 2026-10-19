import { PluginError } from './invocation.js';
import { createVoiceLifecycle, reduceVoiceLifecycle } from './voice-lifecycle.js';

// Retry-after is a bounded absolute deadline, shared by startup and recovery.
export const voiceRetryAt = (error, now = Date.now()) =>
  (error?.status === 429 || error?.code === 'voice-conflict') && error.retryAfterMs > 0
    ? now + Math.min(error.retryAfterMs, 60_000) : 0;

export const voiceAuthorityLost = error => error?.status === 403 || error?.code === 'not-admitted' || error?.code === 'auth';
const continuityLoss = error => error?.code === 'voice-ownership-lost' ? 'ownership-lost'
  : error?.code === 'voice-restart-required' ? 'server-restart' : null;

/** Scheduling lives with transport recovery, never in the view. */
export function watchVoiceHeartbeat({ heartbeat, current = () => true, onFailure = () => {}, heartbeatMs = 10_000 }) {
  let pending = false, stopped = false;
  const timer = setInterval(() => {
    if (stopped || !current() || pending) return;
    pending = true;
    Promise.resolve().then(() => heartbeat({ deadlineAt: Date.now() + 5000 })).catch(error => {
      if (!stopped && current()) onFailure(error);
    }).finally(() => { pending = false; });
  }, heartbeatMs);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}

/** Transport ports own SDK effects; this controller owns outage policy, holds and deadlines. */
export function createVoiceLifecycleController({ callId, renew, replace, beforeRecovery = async () => {},
  failedReplacement = async () => {}, persistWaiting = async () => {}, stopMedia = () => {}, terminal = () => {}, onEvent = () => {}, now = Date.now } = {}) {
  let state = createVoiceLifecycle(callId), recovery, renewal, timer, clockTimer, stopHeartbeat, continuityRevision = 0, lastClock = now();
  const dispatch = event => { state = reduceVoiceLifecycle(state, event); return state; };
  const ended = () => state.state === 'ended';
  const hold = reason => {
    if (ended()) return;
    continuityRevision++;
    dispatch({ type: reason }); stopMedia(reason);
    onEvent({ type: 'waiting', reason }); schedule();
  };
  const checkClock = () => {
    const current = now(), gap = current - lastClock; lastClock = current;
    if (!ended() && state.state !== 'idle' && !state.needsRecovery && (gap > 15_000 || gap < -15_000)) {
      dispatch({ type: 'sleep' }); hold('wake');
    }
  };
  const exhausted = async (retryAt = 0) => {
    dispatch({ type: 'recovery-exhausted' }); stopMedia();
    try { await persistWaiting({ reason: 'recovery-failed', attempts: state.attempts }); }
    catch { /* Local media stays stopped if the server is temporarily unreachable. */ }
    if (!ended()) onEvent({ type: 'waiting', reason: 'recovery-failed', ...(retryAt ? { retryAt } : {}) });
  };
  const schedule = () => {
    clearTimeout(timer);
    if (ended() || !Number.isFinite(state.spendDeadlineAt)) return;
    const deadline = recovery || state.state === 'waiting' ? state.spendDeadlineAt
      : Math.min(state.spendDeadlineAt, state.browserLivenessDeadlineAt);
    timer = setTimeout(() => {
      if (ended()) return;
      checkClock();
      if (now() >= state.spendDeadlineAt) { dispatch({ type: 'budget-end' }); terminal('spend-deadline'); }
      else if (!state.needsRecovery) {
        dispatch({ type: 'lease-expired' }); stopMedia('browser-liveness-deadline');
        onEvent({ type: 'waiting', reason: 'browser-liveness-deadline' }); schedule();
      }
    }, Math.max(0, Math.min(2_147_483_647, deadline - now())));
    timer.unref?.();
  };
  const recover = ({ explicit = false } = {}) => {
    if (ended()) return Promise.resolve(false);
    if (recovery) return recovery;
    if (state.state === 'waiting' && !explicit) return Promise.resolve(false);
    if (explicit) dispatch({ type: 'retry-requested' });
    dispatch({ type: 'transport-lost' }); stopMedia();
    if (state.holds.length && !explicit) return Promise.resolve(false);
    onEvent({ type: 'recovering' });
    const revision = continuityRevision;
    // Install the flight before invoking a port that can synchronously report another drop.
    recovery = Promise.resolve().then(async () => {
      await beforeRecovery();
      for (let attempt = 0; attempt < 3 && !ended() && revision === continuityRevision; attempt++) {
        dispatch({ type: 'recovery-attempt' });
        try {
          const receipt = await replace({ explicit });
          if (ended() || revision !== continuityRevision) return false;
          dispatch({ type: 'connected', ...receipt });
          onEvent({ type: 'recovered' }); return true;
        } catch (error) {
          await failedReplacement();
          if (ended() || revision !== continuityRevision) return false;
          if (continuityLoss(error)) { hold(continuityLoss(error)); return false; }
          const retryAt = voiceRetryAt(error, now());
          // An advertised rate-limit wait needs explicit visitor intent; do not
          // spend the remaining automatic attempts inside the refused window.
          if (error?.status === 429 && retryAt) { await exhausted(retryAt); return false; }
          if (voiceAuthorityLost(error)) { dispatch({ type: 'withdraw' }); terminal('call-authorization-lost'); return false; }
          dispatch({ type: 'recovery-failed' });
        }
      }
      if (!ended() && revision === continuityRevision) await exhausted();
      return false;
    }).catch(async () => {
      if (!ended() && revision === continuityRevision) await exhausted();
      return false;
    }).finally(() => { recovery = undefined; schedule(); });
    schedule(); return recovery;
  };
  const heartbeat = options => {
    if (ended()) return Promise.reject(new PluginError('unavailable'));
    if (options?.signal?.aborted) return Promise.reject(new PluginError('cancelled'));
    if (options?.deadlineAt <= now()) return Promise.reject(new PluginError('deadline'));
    if (renewal) return renewal;
    // Fence at scheduling time: waiting for recovery must not make an old
    // heartbeat (and its original deadline) belong to the replacement transport.
    const generation = state.providerGeneration, epoch = state.epoch;
    renewal = Promise.resolve().then(async () => {
      if (recovery) await recovery;
      if (ended()) throw new PluginError('unavailable');
      if (state.providerGeneration !== generation || state.epoch !== epoch) return { acknowledged: true, stale: true };
      if (state.needsRecovery) return { acknowledged: true, waiting: true };
      try {
        const ack = await renew(options);
        if (ended() || state.providerGeneration !== generation || state.epoch !== epoch || state.needsRecovery) return { acknowledged: true, stale: true };
        // Backpressure is not transport loss and cannot renew the existing lease.
        if (ack?.acknowledged === true && ack.deferred === true) return ack;
        if (ack?.acknowledged !== true || !Number.isFinite(ack.browserLivenessDeadlineAt)) throw new PluginError('invalid-output');
        dispatch({ type: 'heartbeat', ...ack }); schedule(); return ack;
      } catch (error) {
        if (ended() || state.providerGeneration !== generation || state.epoch !== epoch || state.needsRecovery) return { acknowledged: true, stale: true };
        if (continuityLoss(error)) { hold(continuityLoss(error)); return { acknowledged: true, waiting: true }; }
        if (voiceAuthorityLost(error)) { dispatch({ type: 'withdraw' }); terminal('call-authorization-lost'); throw error; }
        if (error?.code === 'limit' || error?.status === 429) return { acknowledged: true, deferred: true };
        await recover(); return { acknowledged: true, waiting: state.state === 'waiting' };
      }
    }).finally(() => { renewal = undefined; });
    return renewal;
  };
  return {
    get state() { return state; }, get recovering() { return recovery; }, dispatch, recover, heartbeat, checkClock,
    connected(receipt) {
      if (!state.providerSessionId) state = { ...state, epoch: receipt.epoch ?? 0, controllingTabId: receipt.controllingTabId ?? null };
      dispatch({ type: 'connected', ...receipt }); lastClock = now();
      if (!clockTimer) { clockTimer = setInterval(checkClock, 1000); clockTimer.unref?.(); }
      schedule();
    },
    ownershipLost() { hold('ownership-lost'); },
    restart() { hold('server-restart'); },
    sleep() { if (!ended()) { continuityRevision++; dispatch({ type: 'sleep' }); stopMedia('sleep'); onEvent({ type: 'waiting', reason: 'sleep' }); } },
    wake() { if (state.holds.includes('sleep')) hold('wake'); },
    wait(reason = 'browser-liveness-deadline') {
      if (ended() || recovery || state.state === 'waiting') return;
      dispatch({ type: 'lease-expired' }); stopMedia(reason); onEvent({ type: 'waiting', reason }); schedule();
    },
    pause(reason = 'pause') { dispatch({ type: 'pause', reason }); },
    resumed() { dispatch({ type: 'resume-acknowledged' }); lastClock = now(); schedule(); },
    startHeartbeat(heartbeatMs = 10_000) {
      stopHeartbeat?.(); stopHeartbeat = watchVoiceHeartbeat({ heartbeat, current: () => !ended(), heartbeatMs });
      return () => { stopHeartbeat?.(); stopHeartbeat = undefined; };
    },
    end(reason) { dispatch({ type: 'end', reason }); clearTimeout(timer); clearInterval(clockTimer); stopHeartbeat?.(); },
  };
}
