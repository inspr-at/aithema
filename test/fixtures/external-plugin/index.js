// A standalone, offline adapter. No host, workspace or shipped-plugin imports.
import { beginInvocation, createBinding, deepFreeze, matchesSchema, normalizedError,
  operationScope, PluginError, publicReasoningManifest } from '@inspr/aithema-core';

export const consentItem = deepFreeze({ id: 'external-model', version: 1,
  title: 'External model proof', recipients: 'Local external-plugin fixture only; no network recipient.',
  text: 'Allow this local fake model to read messages and produce replies and an overview. No provider is contacted.' });
export const reply = 'External model reply: what should your project improve first?';
export const summary = 'External model overview: a project described by the visitor.';
export const usage = deepFreeze({ inputTokens: 13, outputTokens: 7 });
export const chargedMicro = 37; // Deliberately different from the token-rate cost (27).
const base = publicReasoningManifest('external-model', 'External model fixture', 'https://example.test');
export const manifest = deepFreeze({ ...base, entrypoints: { server: './index.js' },
  presentation: { label: 'External model fixture', translations: [{ locale: 'en', label: 'External model fixture', consentItem }] },
  models: [{ ...base.models[0], id: 'external/proof-v1', languages: ['en'],
    cost: { unit: 'token', inputMicro: 1, outputMicro: 2, reviewedAt: '2026-10-15T00:00:00Z' } }] });

// Missing cost is a deliberate failure mode for conservative-settlement tests.
export function createExternalReasoning({ binding, reportCost = true, available = true } = {}) {
  binding = createBinding(binding);
  if (binding.plugin !== manifest.id || binding.model !== manifest.models[0].id) throw new TypeError('Unsupported external model binding');
  async function run(request, options, output) {
    const scope = operationScope(options); let invocation, completed = false;
    try {
      scope.signal.throwIfAborted();
      invocation = await beginInvocation({ ...options, signal: scope.signal }, { authoritativeCost: true });
      invocation.dispatch();
      // Only answer content is returned. Provider thinking never becomes a reply.
      const result = output();
      invocation.usage(usage); if (reportCost) invocation.cost(chargedMicro);
      invocation.servedModel(binding.model); completed = true;
      return result;
    } catch (error) { throw normalizedError(error, scope.signal); }
    finally { scope.dispose(); await invocation?.finish(completed); }
  }
  return { manifest, binding,
    bind: binding => createExternalReasoning({ binding, reportCost, available }),
    async health(options) {
      const scope = operationScope(options);
      try { scope.signal.throwIfAborted(); return { available, ...(available ? {} : { reason: 'fixture unavailable' }) }; }
      finally { scope.dispose(); }
    },
    async *stream(request, options) {
      yield await run(request, options, () => request.schema
        ? JSON.stringify({ content: reply, question_short: null, options: [], ...(request.purposePolicy ? { scope: 'in' } : {}) }) : reply);
    },
    async structured(request, options) {
      return run(request, options, () => {
        const result = { summary, signals: [], openQuestions: ['What outcome matters most?'],
          constraints: Object.fromEntries(Object.keys(request.schema.properties.constraints.properties).map(slot => [slot, null])),
          progress: { talk: { value: 0.25, reasoning: 'External fixture assessment' },
            build: { value: 0, reasoning: 'No requirements confirmed' } }, actor: null, engagement: null, conceptIntent: null };
        if (!matchesSchema(result, request.schema)) throw new PluginError('invalid-output');
        return result;
      });
    },
  };
}
