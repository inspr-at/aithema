import { createChatCompletions, createBinding, publicReasoningManifest, deepFreeze, PluginError } from '@inspr/aithema-core';
import { modelPrice, providerMaxPrice, requestCeilingMicro, requestInputTokens, tokenCeilingMicro } from './pricing.js';
import { reconcileGeneration } from './reconcile.js';
const base = publicReasoningManifest('openrouter', 'OpenRouter', 'https://openrouter.ai');
// The adapter forwards reasoning.effort; values follow START's 2026-09-13 check of
// OpenRouter reasoning.supported_efforts. Which model supports which value is the
// host's allowlist decision, and require_parameters forbids a silent fallback.
export const manifest = deepFreeze({ ...base, models: [{ ...base.models[0], efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }] });
export function createOpenRouterReasoning({ binding, resolveSecret = ref => process.env[ref], fetchImpl, spendCap, prices,
  uncertainEstimateMicro = 10_000, model, endpoint = 'https://openrouter.ai/api/v1/chat/completions' } = {}) {
  // Legacy model/endpoint convenience stays unqualified; a private binding is required by server admission.
  binding = createBinding(binding ?? { plugin: 'openrouter', model, endpoint, effort: 'none', accountRef: 'unverified',
    secretRef: 'OPENROUTER_API_KEY', maxMicro: 1_000_000, maxTokens: 8000, rates: { inputMicro: 0, outputMicro: 0 } });
  if (binding.plugin !== 'openrouter' || !binding.model.includes('/')) throw new TypeError('OpenRouter binding requires model id');
  if (!Number.isSafeInteger(uncertainEstimateMicro) || uncertainEstimateMicro < 1) throw new TypeError('Invalid uncertain cost estimate');
  const price = modelPrice(prices, binding.model);
  return { bind: binding => createOpenRouterReasoning({ binding, resolveSecret, fetchImpl, spendCap, prices, uncertainEstimateMicro }),
    // Compatibility fallback for callers without a private lane binding. New
    // requests use the full lane price bound below, never this flat USD amount.
    uncertainEstimateMicro,
    usageCost: (usage, model = binding.model) => tokenCeilingMicro(usage.inputTokens, Math.max(1, usage.outputTokens), modelPrice(prices, model)),
    recoverCosts: () => spendCap?.recover?.(),
    costEvidence: attemptId => spendCap?.evidence?.(attemptId),
    reconcileSpend: (attemptId, cost) => spendCap?.reconcileAttempt?.(attemptId, cost),
    reconcileCost: (record, options) => reconcileGeneration(record, { resolveSecret, fetchImpl, ...options }),
    ...createChatCompletions({ manifest, binding, resolveSecret, fetchImpl, spendCap, authoritativeCost: true, streamSchema: true,
    // Fallback = min(per-call maximum, ceil((input token bound * input price +
    // configured max output tokens * output price) * 1e6)). max_tokens includes
    // reasoning as well as visible output. Byte estimates stay within the
    // reservation; real usage floors remain uncapped. Only an authoritative
    // receipt can release the provider cap.
    uncertainCeiling: body => Math.min(binding.maxMicro, requestCeilingMicro(body, price)),
    observedCost: usage => tokenCeilingMicro(usage.inputTokens, Math.max(1, usage.outputTokens), price),
    spendCeiling(body) {
      // Used both by admission estimates and immediately before account reserve /
      // provider dispatch. Free prompt pricing cannot relax the technical bound.
      if (binding.maxInputTokens !== undefined && requestInputTokens(body) > binding.maxInputTokens) {
        throw new PluginError('not-admitted', 'OpenRouter input token ceiling exceeded');
      }
      const ceiling = requestCeilingMicro(body, price);
      if (ceiling > binding.maxMicro) throw new PluginError('not-admitted', 'OpenRouter request exceeds spend reservation');
      return ceiling;
    },
    // Mandatory-reasoning models require a supported effort instead of none.
    providerOptions: stream => ({ reasoning: binding.effort === 'none' ? { enabled: false } : { effort: binding.effort },
      usage: { include: true },
      provider: { ...binding.routing, require_parameters: true, allow_fallbacks: false,
        // verified live 2026-10-09: USD per MILLION tokens; enforced before dispatch.
        max_price: providerMaxPrice(price) },
      ...(stream ? { stream_options: { include_usage: true } } : {}) }) }) };
}
