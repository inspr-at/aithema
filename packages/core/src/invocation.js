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
export function beginInvocation(options, { billable = true } = {}) {
  let terminal = false, dispatched = false, usage = null;
  if (billable && (!options?.attempt?.attemptId || !options.attempt.claimId || typeof options.attempt.consume !== 'function' || typeof options.report !== 'function')) {
    throw new PluginError('not-admitted');
  }
  options?.attempt?.consume(); // burn before any outbound work; a retry requires another admission
  return {
    dispatch() { dispatched = true; },
    usage(value) {
      if (value && Number.isSafeInteger(value.inputTokens) && value.inputTokens >= 0 && Number.isSafeInteger(value.outputTokens) && value.outputTokens >= 0) usage = value;
    },
    async finish(completed = false) {
      if (terminal) throw new PluginError('already-claimed');
      terminal = true;
      const report = !dispatched ? { outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } }
        : usage ? { outcome: completed ? 'completed' : 'cancelled', usage } : { outcome: 'uncertain' };
      await options?.report?.({ attemptId: options.attempt?.attemptId, ...report });
    },
  };
}
