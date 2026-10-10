import { mockManifest } from './plugins.js';
import { beginInvocation, normalizedError } from './invocation.js';
export { mockManifest } from './plugins.js';
const canonicalMocks = new WeakSet();
const MOCK_GERMAN_MARKERS = Object.freeze({ operations: 'betrieb', data: 'daten', systems: 'systeme', reach: 'reichweite', requirements: 'auflagen' });
export function isCanonicalMockReasoning(plugin) { return canonicalMocks.has(plugin); }
export function assertReasoning(plugin) {
  if (!plugin || typeof plugin.stream !== 'function' || typeof plugin.structured !== 'function') {
    throw new TypeError('Reasoning requires stream and structured');
  }
  return plugin;
}
// The port accepts the JSON Schema subset produced by understandingSchema.
export function matchesSchema(value, schema) {
  if (schema.anyOf) return schema.anyOf.some(s => matchesSchema(value, s));
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value) &&
    (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === 'array') return Array.isArray(value) && value.every(v => matchesSchema(v, schema.items));
  if (schema.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (schema.required ?? []).every(k => Object.hasOwn(value, k)) &&
    Object.entries(value).every(([k, v]) => schema.properties[k]
      ? matchesSchema(v, schema.properties[k]) : schema.additionalProperties !== false);
  return false;
}
// Both operations accept {signal, deadlineAt}; disposal prevents retained timers/listeners.
export function operationScope({ signal, deadlineAt = Date.now() + 30_000 } = {}) {
  if (!Number.isFinite(deadlineAt)) throw new TypeError('Invalid deadline');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Deadline exceeded', 'TimeoutError')),
    Math.max(0, deadlineAt - Date.now()));
  if (deadlineAt <= Date.now()) controller.abort(new DOMException('Deadline exceeded', 'TimeoutError'));
  return { signal: controller.signal, dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}
// Each demo model answers with its own deterministic wording, so a changed
// selection is observable in the transcript without any provider network.
function mockReply(model, effort, locale) {
  const de = locale === 'de';
  if (model === 'mock/swift') return de ? 'Kurz gefragt: Was sollte sich als Erstes verbessern?' : 'Briefly: what should improve first?';
  if (model === 'mock/deep') return de ? `Gründlich betrachtet (${effort}): Welches Ergebnis zählt am meisten, und was sollte sich als Erstes verbessern?`
    : `Thinking it through (${effort} effort): which outcome matters most, and what should improve first?`;
  return de ? 'Was sollte sich als Erstes verbessern?' : 'What should improve first?';
}
function mockInputs({ messages, documentMessageIndex }) {
  const turns = [], documents = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'user') continue;
    if (index === documentMessageIndex) {
      for (const line of message.content.split('\n').slice(1)) {
        // The context budget can append a non-JSON truncation notice.
        if (!line.startsWith('{"kind":"untrusted-upload",')) continue;
        const document = JSON.parse(line);
        if (document.state === 'accepted') documents.push(document);
      }
    } else if (!message.content.startsWith('{"kind":')) turns.push(message);
  }
  return { turns, documents };
}
export function createMockReasoning({ model = 'mock', effort = 'none' } = {}) {
  const plugin = Object.freeze({
    id: 'mock', billable: false, label: 'Mock reasoning — deterministic demo', manifest: mockManifest, model, effort,
    // A bound instance is again canonical; registry trust still starts at the registered entry.
    bind: binding => createMockReasoning({ model: binding.model, effort: binding.effort }),
    async health(options) { const scope = operationScope(options); try { scope.signal.throwIfAborted(); return { available: true }; }
      catch (error) { throw normalizedError(error, scope.signal); } finally { scope.dispose(); } },
    async *stream(request, options) {
      const invocation = await beginInvocation(options, { billable: false });
      const scope = operationScope(options); let completed = false;
      try {
        scope.signal.throwIfAborted();
        invocation.dispatch(); invocation.usage({ inputTokens: 0, outputTokens: 0 });
        const content = mockReply(model, effort, request.locale);
        for (const chunk of content.match(/\S+\s*/gu)) { scope.signal.throwIfAborted(); yield chunk; }
        completed = true;
      } catch (error) { throw normalizedError(error, scope.signal); }
      finally { scope.dispose(); await invocation.finish(completed); }
    },
    async structured(request, options) {
      const invocation = await beginInvocation(options, { billable: false });
      const scope = operationScope(options); let completed = false;
      try {
        scope.signal.throwIfAborted();
        invocation.dispatch(); invocation.usage({ inputTokens: 0, outputTokens: 0 });
        const { turns, documents } = mockInputs(request);
        const fileMentions = documents.map(d => `${request.locale === 'de' ? 'Datei' : 'File'}: ${d.name}`);
        const constraints = Object.fromEntries(request.preset.slots.map(slot => {
          // English slot names always; START's German slot labels in German sessions only.
          const markers = [slot, ...(request.locale === 'de' && MOCK_GERMAN_MARKERS[slot] ? [MOCK_GERMAN_MARKERS[slot]] : [])].map(name => `${name}:`);
          let turn, marker;
          for (const candidate of turns.toReversed()) {
            marker = markers.find(m => candidate.content.toLowerCase().includes(m));
            if (marker) { turn = candidate; break; }
          }
          if (!turn) return [slot, null];
          const start = turn.content.toLowerCase().indexOf(marker) + marker.length;
          const value = turn.content.slice(start).split(/[;\n]/u)[0].trim();
          return [slot, value ? { value, evidence: turn.content.slice(0, 500) } : null];
        }));
        completed = true;
        return { summary: [turns.map(t => t.content).join(' ').slice(0, 500), ...fileMentions].filter(Boolean).join(' '),
          signals: [...turns.slice(-3).map(t => t.content), ...fileMentions],
          openQuestions: turns.length < 3 ? [request.locale === 'de' ? 'Welches Ergebnis wäre für Sie nützlich?' : 'What outcome would make this useful?'] : [], constraints,
          progress: { talk: { value: Math.min(1, turns.length / 4), reasoning: 'Mock turn count' },
            build: { value: 1, reasoning: 'Capped by supported slots' } }, actor: null, engagement: null, conceptIntent: null };
      } catch (error) { throw normalizedError(error, scope.signal); }
      finally { scope.dispose(); await invocation.finish(completed); }
    },
  });
  canonicalMocks.add(plugin); return plugin;
}
