import { PluginError } from '../../../packages/core/src/invocation.js';
import { operationScope } from '../../../packages/core/src/reasoning.js';
import { voiceOperation, assertComponentUsage } from '../../../packages/core/src/live-voice.js';

/** Component accounting has its own admission, independent of the call claim. */
export async function componentInvocation(options, { role, unit, model }) {
  if (!options?.attempt?.attemptId || !options.attempt.claimId || typeof options.attempt.consume !== 'function' ||
    !Number.isSafeInteger(options.attempt.maxMicro) || options.attempt.maxMicro < 0 || typeof options.report !== 'function') {
    throw new PluginError('not-admitted', 'A separately admitted component claim is required');
  }
  const scope = operationScope(options);
  let dispatched = false, terminal, usage;
  const finish = completed => {
    if (terminal) return terminal;
    const zero = { attemptId: options.attempt.attemptId, role, unit, quantity: 0, upstreamMicro: 0,
      source: 'undispatched', estimated: false };
    const report = !dispatched ? { outcome: 'cancelled', usage: zero, chargedMicro: 0 }
      : completed && usage ? { outcome: 'completed', usage, chargedMicro: usage.upstreamMicro }
        : { outcome: 'uncertain' };
    scope.signal.removeEventListener('abort', abort);
    scope.dispose();
    // Install the once-only fence before invoking a host which may synchronously abort.
    terminal = Promise.resolve().then(() => options.report({ attemptId: options.attempt.attemptId, servedModel: model, ...report }));
    return terminal;
  };
  const abort = () => { void finish(false).catch(() => {}); };
  scope.signal.addEventListener('abort', abort, { once: true });
  try {
    await voiceOperation({ ...options, signal: scope.signal }, () => options.attempt.consume());
    scope.signal.throwIfAborted();
  } catch (error) { await finish(false); throw error; }
  return {
    signal: scope.signal,
    dispatch() {
      scope.signal.throwIfAborted();
      if (terminal || dispatched) throw new PluginError('already-claimed');
      dispatched = true;
    },
    usage(quantity, upstreamMicro, source, estimated = true) {
      usage = assertComponentUsage({ attemptId: options.attempt.attemptId, role, unit, quantity, upstreamMicro, source, estimated });
      if (usage.upstreamMicro > options.attempt.maxMicro) throw new PluginError('limit', 'Component exceeded its admitted ceiling');
    },
    finish,
  };
}

export async function* boundedEvents(source, options) {
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const item = await voiceOperation(options, () => iterator.next());
      if (item.done) return;
      yield item.value;
    }
  } finally {
    if (iterator.return) await voiceOperation({ deadlineAt: Date.now() + 1000 }, () => iterator.return()).catch(() => {});
  }
}

/** Byte-bounded producer queue; ingress cannot hide unbounded audio in promises. */
export function audioQueue(limit = 960_000) {
  let bytes = 0, ended = false, waiter;
  const queue = [];
  return {
    push(value) {
      if (ended) throw new PluginError('unavailable');
      if (bytes + value.byteLength > limit) throw new PluginError('limit', 'Audio relay buffer full');
      if (waiter) { const resolve = waiter; waiter = undefined; resolve({ value, done: false }); }
      else { bytes += value.byteLength; queue.push(value); }
    },
    end() { ended = true; waiter?.({ done: true }); waiter = undefined; },
    clear() { queue.length = 0; bytes = 0; this.end(); },
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (queue.length) { const value = queue.shift(); bytes -= value.byteLength; return Promise.resolve({ value, done: false }); }
      if (ended) return Promise.resolve({ done: true });
      if (waiter) throw new TypeError('One audio consumer required');
      return new Promise(resolve => { waiter = resolve; });
    },
    return() { this.clear(); return Promise.resolve({ done: true }); },
  };
}
