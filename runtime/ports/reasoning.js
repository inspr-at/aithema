/**
 * Text reasoning port. Successful exhaustion of streamChat means the adapter
 * saw its explicit protocol terminator. A throw (including AbortError) means
 * partial output is evidence only and must never be stored as a complete turn.
 * Adapters own transport cancellation; the port never persists output.
 *
 * @typedef {import('../provider.js').LlmChatRequest} ReasoningRequest
 * @typedef {{
 *   streamChat(request: ReasoningRequest): AsyncIterable<string>,
 *   understand(request: ReasoningRequest): Promise<unknown>,
 * }} ReasoningPort
 */

export { OpenAICompatibleProvider, LocalOpenAIProvider } from '../provider.js';
export { PaimosHarnessProvider } from '../paimos-provider.js';

/** @param {ReasoningPort} adapter @returns {ReasoningPort} */
export function createReasoningPort(adapter) {
  if (typeof adapter?.streamChat !== 'function' || typeof adapter?.understand !== 'function') {
    throw new TypeError('reasoning adapter must implement streamChat and understand');
  }
  return Object.freeze({
    streamChat: (request) => adapter.streamChat(request),
    understand: (request) => adapter.understand(request),
  });
}
