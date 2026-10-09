export const PLUGIN_ERROR_CODES = Object.freeze(['cancelled', 'deadline', 'not-admitted', 'already-claimed',
  'unavailable', 'auth', 'rate-limit', 'provider', 'invalid-output', 'limit']);
export class PluginError extends Error {
  constructor(code, message = code) { super(message); this.name = 'PluginError'; this.code = code; }
}
// A refused authority claim permits only an exact replay of its zero-cost cancellation.
export function isCancelledZeroReport(terminal, attemptId) {
  return terminal?.attemptId === attemptId && terminal.outcome === 'cancelled' &&
    Object.keys(terminal).length === 3 && ['attemptId', 'outcome', 'usage'].every(key => Object.hasOwn(terminal, key)) &&
    terminal.usage?.inputTokens === 0 && terminal.usage.outputTokens === 0 && Object.keys(terminal.usage).length === 2 &&
    ['inputTokens', 'outputTokens'].every(key => Object.hasOwn(terminal.usage, key));
}
export function normalizedError(error, signal) {
  if (signal?.aborted) return new PluginError(signal.reason?.name === 'TimeoutError' ? 'deadline' : 'cancelled', signal.reason?.message ?? 'Cancelled');
  return error instanceof PluginError ? error : new PluginError('provider', 'Provider request failed');
}
// The claim authority is an in-process closure, never a browser-supplied id.
export async function beginInvocation(options, { billable = true } = {}) {
  let terminal = false, dispatched = false, usage = null, cancelled = false;
  if (billable && (!options?.attempt?.attemptId || !options.attempt.claimId || typeof options.attempt.consume !== 'function' || typeof options.report !== 'function')) {
    throw new PluginError('not-admitted');
  }
  await options?.attempt?.consume(); // fresh host coverage before outbound work; a retry requires another admission
  const invocation = {
    dispatch() {
      options?.signal?.throwIfAborted();
      if (terminal) throw new PluginError('already-claimed');
      dispatched = true;
    },
    usage(value) {
      if (value && Number.isSafeInteger(value.inputTokens) && value.inputTokens >= 0 && Number.isSafeInteger(value.outputTokens) && value.outputTokens >= 0) usage = value;
    },
    async finish(completed = false) {
      if (terminal) { if (cancelled) return; throw new PluginError('already-claimed'); }
      terminal = true;
      options?.signal?.removeEventListener('abort', abort);
      const report = !dispatched ? { outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } }
        : usage ? { outcome: completed ? 'completed' : 'cancelled', usage } : { outcome: 'uncertain' };
      await options?.report?.({ attemptId: options.attempt?.attemptId, ...report });
    },
  };
  // Settle on the operation lifetime even when a transport ignores cancellation.
  // Usage received before abort remains billable; unknown dispatch retains its ceiling.
  const abort = () => { cancelled = true; void invocation.finish(false).catch(() => {}); };
  options?.signal?.addEventListener('abort', abort, { once: true });
  if (options?.signal?.aborted) abort();
  return invocation;
}
