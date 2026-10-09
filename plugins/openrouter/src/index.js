import { createChatCompletions, createBinding, publicReasoningManifest, deepFreeze, PluginError } from '@inspr/aithema-core';
import { modelPrice, requestCeilingMicro } from './pricing.js';
export const manifest = deepFreeze(publicReasoningManifest('openrouter', 'OpenRouter', 'https://openrouter.ai'));
export function createOpenRouterReasoning({ binding, resolveSecret = ref => process.env[ref], fetchImpl, spendCap, prices,
  model, endpoint = 'https://openrouter.ai/api/v1/chat/completions' } = {}) {
  // Legacy model/endpoint convenience stays unqualified; a private binding is required by server admission.
  binding = createBinding(binding ?? { plugin: 'openrouter', model, endpoint, effort: 'none', accountRef: 'unverified',
    secretRef: 'OPENROUTER_API_KEY', maxMicro: 1_000_000, maxTokens: 4096, rates: { inputMicro: 0, outputMicro: 0 } });
  if (binding.plugin !== 'openrouter' || !binding.model.includes('/')) throw new TypeError('OpenRouter binding requires model id');
  const price = modelPrice(prices, binding.model);
  return { bind: binding => createOpenRouterReasoning({ binding, resolveSecret, fetchImpl, spendCap, prices }), ...createChatCompletions({ manifest, binding, resolveSecret, fetchImpl, spendCap,
    spendCeiling(body) {
      const ceiling = requestCeilingMicro(body, price);
      if (ceiling > binding.maxMicro) throw new PluginError('not-admitted', 'OpenRouter request exceeds spend reservation');
      return ceiling;
    },
    providerOptions: stream => ({ ...(binding.effort === 'none' ? {} : { reasoning: { effort: binding.effort } }),
      usage: { include: true },
      provider: { ...binding.routing, require_parameters: true, allow_fallbacks: false,
        // UNVERIFIED API SHAPE: provider.max_price uses USD per million tokens.
        // The coordinator must verify these units live before deployment.
        max_price: { prompt: price.prompt * 1_000_000, completion: price.completion * 1_000_000 } },
      ...(stream ? { stream_options: { include_usage: true } } : {}) }) }) };
}
