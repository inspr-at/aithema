import { createChatCompletions, createBinding, publicReasoningManifest, deepFreeze, PluginError } from '@inspr/aithema-core';
import { modelPrice, providerMaxPrice, requestCeilingMicro } from './pricing.js';
const base = publicReasoningManifest('openrouter', 'OpenRouter', 'https://openrouter.ai');
// The adapter forwards reasoning.effort; values follow START's 2026-09-13 check of
// OpenRouter reasoning.supported_efforts. Which model supports which value is the
// host's allowlist decision, and require_parameters forbids a silent fallback.
export const manifest = deepFreeze({ ...base, models: [{ ...base.models[0], efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }] });
export function createOpenRouterReasoning({ binding, resolveSecret = ref => process.env[ref], fetchImpl, spendCap, prices,
  model, endpoint = 'https://openrouter.ai/api/v1/chat/completions' } = {}) {
  // Legacy model/endpoint convenience stays unqualified; a private binding is required by server admission.
  binding = createBinding(binding ?? { plugin: 'openrouter', model, endpoint, effort: 'none', accountRef: 'unverified',
    secretRef: 'OPENROUTER_API_KEY', maxMicro: 1_000_000, maxTokens: 8000, rates: { inputMicro: 0, outputMicro: 0 } });
  if (binding.plugin !== 'openrouter' || !binding.model.includes('/')) throw new TypeError('OpenRouter binding requires model id');
  const price = modelPrice(prices, binding.model);
  return { bind: binding => createOpenRouterReasoning({ binding, resolveSecret, fetchImpl, spendCap, prices }), ...createChatCompletions({ manifest, binding, resolveSecret, fetchImpl, spendCap,
    spendCeiling(body) {
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
