import { PluginError } from './invocation.js';
import { operationScope } from './reasoning.js';

export const LIVE_VOICE_COMMANDS = Object.freeze(['close', 'pause', 'resume', 'setInput', 'setOutput', 'sendText', 'updateContext', 'interrupt']);
export const LIVE_VOICE_EVENTS = Object.freeze(['listening', 'speaking', 'partial', 'final', 'heard', 'recovering', 'recovered', 'ended']);
export const LIVE_VOICE_CAPABILITIES = Object.freeze([...LIVE_VOICE_COMMANDS.filter(command => command !== 'close'), 'heard']);

export function assertLiveVoice(plugin) {
  if (!plugin?.manifest?.kinds?.includes('live-voice') || !plugin.manifest.liveVoice ||
    typeof plugin.start !== 'function' || typeof plugin.health !== 'function') throw new TypeError('Live voice requires manifest, start and health');
  return plugin;
}
export function assertVoiceSession(session) {
  if (!session?.callId || !session.providerSessionId || !session.events?.[Symbol.asyncIterator] ||
    LIVE_VOICE_COMMANDS.some(command => typeof session[command] !== 'function')) throw new TypeError('Invalid live voice session');
  return session;
}
export function assertVoiceEvent(event) {
  if (!LIVE_VOICE_EVENTS.includes(event?.type) || typeof event.callId !== 'string' || !event.callId ||
    (['partial', 'final', 'heard'].includes(event.type) && (typeof event.turnId !== 'string' || !event.turnId)) ||
    (['partial', 'final'].includes(event.type) && (!['user', 'assistant'].includes(event.role) || typeof event.text !== 'string')) ||
    (event.type === 'heard' && typeof event.prefix !== 'string') ||
    (event.type === 'ended' && (typeof event.reason !== 'string' || !event.reason))) throw new PluginError('invalid-output', 'Invalid live voice event');
  return event;
}
export function unavailableVoiceCommand(command) {
  return async () => { throw new PluginError('unavailable', `Live voice ${command} is unavailable`); };
}

// Timers and caller cancellation also bound injected ports which ignore AbortSignal.
export async function voiceOperation(options, operation) {
  const scope = operationScope(options); let listener;
  try {
    scope.signal.throwIfAborted();
    const cancelled = new Promise((_, reject) => {
      listener = () => reject(new PluginError(scope.signal.reason?.name === 'TimeoutError' ? 'deadline' : 'cancelled'));
      scope.signal.addEventListener('abort', listener, { once: true });
    });
    return await Promise.race([operation({ ...options, signal: scope.signal }), cancelled]);
  } catch (error) {
    if (scope.signal.aborted) throw new PluginError(scope.signal.reason?.name === 'TimeoutError' ? 'deadline' : 'cancelled');
    throw error;
  } finally { scope.signal.removeEventListener('abort', listener); scope.dispose(); }
}

// Voice has duration usage, separate from a delegated reasoning attempt's token usage.
export async function beginVoiceInvocation(options, callId) {
  if (!options?.attempt?.attemptId || !options.attempt.claimId || typeof options.attempt.consume !== 'function' ||
    !Number.isSafeInteger(options.attempt.maxMicro) || options.attempt.maxMicro < 0 || typeof options.report !== 'function') {
    throw new PluginError('not-admitted', 'Live voice requires a server-admitted duration claim');
  }
  await options.attempt.consume(); // Await the host's fresh consent/ownership check before outbound work.
  let dispatched = false, finished = false;
  return {
    dispatch() { options.signal?.throwIfAborted(); if (finished || dispatched) throw new PluginError('already-claimed'); dispatched = true; },
    async finish(terminal) {
      if (finished) throw new PluginError('already-claimed');
      finished = true;
      const usage = terminal?.usage;
      const known = terminal?.closureConfirmed === true && ['completed', 'cancelled'].includes(terminal.outcome) &&
        ['providerSeconds', 'providerMinutes', 'pausedSeconds', 'visitorSeconds'].every(key => typeof usage?.[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0) &&
        ['upstreamMicro', 'visitorMicro'].every(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0);
      const report = !dispatched ? { outcome: 'cancelled', closureConfirmed: true, chargedMicro: 0,
        usage: { providerSeconds: 0, providerMinutes: 0, pausedSeconds: 0, visitorSeconds: 0, upstreamMicro: 0, visitorMicro: 0 } }
        : known ? { outcome: terminal.outcome, closureConfirmed: true, usage, chargedMicro: usage.upstreamMicro,
          overrun: usage.upstreamMicro > options.attempt.maxMicro, providerSessionId: terminal.providerSessionId }
          : { outcome: 'uncertain', closureConfirmed: false, usage: usage ?? null,
            providerSessionId: terminal?.providerSessionId, chargedMicro: options.attempt.maxMicro };
      return options.report({ ...report, attemptId: options.attempt.attemptId, callId });
    },
  };
}

/** Absolute spend and browser leases are independent; pausing extends neither. */
export function voiceLifetime({ spendDeadlineAt, browserLivenessDeadlineAt, now = Date.now, onExpire }) {
  if (![spendDeadlineAt, browserLivenessDeadlineAt].every(Number.isFinite) || typeof onExpire !== 'function') throw new TypeError('Voice deadlines required');
  let lease = browserLivenessDeadlineAt, timer, stopped = false;
  const schedule = () => {
    clearTimeout(timer);
    if (stopped) return;
    const reason = spendDeadlineAt <= lease ? 'spend-deadline' : 'browser-liveness-deadline';
    timer = setTimeout(() => { stopped = true; Promise.resolve(onExpire(reason)).catch(() => {}); },
      Math.max(0, Math.min(2_147_483_647, Math.min(spendDeadlineAt, lease) - now())));
  };
  schedule();
  return {
    heartbeat(deadlineAt) {
      if (stopped || now() >= Math.min(spendDeadlineAt, lease)) throw new PluginError('deadline', 'Voice lease expired');
      if (!Number.isFinite(deadlineAt) || deadlineAt <= now()) throw new TypeError('Invalid browser lease');
      lease = Math.min(deadlineAt, spendDeadlineAt); schedule(); return lease;
    },
    dispose() { stopped = true; clearTimeout(timer); },
  };
}

// A bounded single-consumer stream; durable history belongs to the host journal.
export function voiceEvents({ limit = 512 } = {}) {
  const queued = []; let reader, ended = false;
  return {
    push(event) {
      if (ended) return;
      assertVoiceEvent(event);
      if (reader) { const resolve = reader; reader = null; resolve({ value: event, done: false }); }
      else { if (queued.length >= limit && event.type !== 'ended') throw new PluginError('limit', 'Voice event consumer fell behind'); queued.push(event); }
    },
    end() { ended = true; if (reader) { reader({ done: true }); reader = null; } },
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (queued.length) return Promise.resolve({ value: queued.shift(), done: false });
      if (ended) return Promise.resolve({ done: true });
      if (reader) throw new TypeError('Voice events support one consumer');
      return new Promise(resolve => { reader = resolve; });
    },
    return() { this.end(); queued.length = 0; return Promise.resolve({ done: true }); },
  };
}
