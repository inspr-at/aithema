import { createChatCompletions, createBinding, publicReasoningManifest, deepFreeze } from '@inspr/aithema-core';
export const manifest = deepFreeze(publicReasoningManifest('openrouter', 'OpenRouter', 'https://openrouter.ai'));
export function createOpenRouterReasoning({ binding, resolveSecret = ref => process.env[ref], fetchImpl,
  model, endpoint = 'https://openrouter.ai/api/v1/chat/completions' } = {}) {
  // Legacy model/endpoint convenience stays unqualified; a private binding is required by server admission.
  binding = createBinding(binding ?? { plugin: 'openrouter', model, endpoint, effort: 'none', accountRef: 'unverified',
    secretRef: 'OPENROUTER_API_KEY', maxMicro: 1_000_000, maxTokens: 4096, rates: { inputMicro: 0, outputMicro: 0 } });
  if (binding.plugin !== 'openrouter' || !binding.model.includes('/')) throw new TypeError('OpenRouter binding requires model id');
  return { bind: binding => createOpenRouterReasoning({ binding, resolveSecret, fetchImpl }), ...createChatCompletions({ manifest, binding, resolveSecret, fetchImpl,
    providerOptions: stream => ({ ...(binding.effort === 'none' ? {} : { reasoning: { effort: binding.effort } }),
      provider: { ...binding.routing, require_parameters: true, allow_fallbacks: false },
      ...(stream ? { stream_options: { include_usage: true } } : {}) }) }) };
}
