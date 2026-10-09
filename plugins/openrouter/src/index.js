import { createChatCompletions, createBinding, publicReasoningManifest, deepFreeze, PluginError } from '@inspr/aithema-core';
export const manifest = deepFreeze(publicReasoningManifest('openrouter', 'OpenRouter', 'https://openrouter.ai'));
export function createOpenRouterReasoning({ binding, resolveSecret = ref => process.env[ref], fetchImpl, spendCap,
  model, endpoint = 'https://openrouter.ai/api/v1/chat/completions' } = {}) {
  // Legacy model/endpoint convenience stays unqualified; a private binding is required by server admission.
  binding = createBinding(binding ?? { plugin: 'openrouter', model, endpoint, effort: 'none', accountRef: 'unverified',
    secretRef: 'OPENROUTER_API_KEY', maxMicro: 1_000_000, maxTokens: 4096, rates: { inputMicro: 0, outputMicro: 0 } });
  if (binding.plugin !== 'openrouter' || !binding.model.includes('/')) throw new TypeError('OpenRouter binding requires model id');
  return { bind: binding => createOpenRouterReasoning({ binding, resolveSecret, fetchImpl, spendCap }), ...createChatCompletions({ manifest, binding, resolveSecret, fetchImpl, spendCap,
    prepareBody(body) {
      if (!spendCap) return body;
      // START src/lib/providers/openrouter.ts assertSelectedRequestBudget/post:
      // UTF-8 byte upper bound + 1024 framing tokens; provider.max_price is USD/million.
      // START src/lib/model-catalog-store.ts catalogRoutingCeiling: conservative caps,
      // not advertised prices. No unbounded-price dispatch may consume a fixed hold.
      const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength + 1024;
      const seeds = { 'openai/gpt-5.6-sol': [2, 10], 'openai/gpt-6-astra': [10, 50],
        'anthropic/claude-opus-5': [5, 25], 'anthropic/claude-fable-5': [10, 50], 'anthropic/claude-fable-5.1': [10, 50] };
      let rates = seeds[binding.model] ?? [10, 50];
      if (bytes >= 272_000 && binding.model === 'openai/gpt-5.6-sol') rates = [4, 15];
      if (bytes >= 272_000 && binding.model === 'openai/gpt-6-astra') rates = [20, 75];
      const price = binding.routing?.max_price ?? { prompt: rates[0], completion: rates[1] };
      if (![price.prompt, price.completion].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) ||
        Math.ceil(bytes * price.prompt + body.max_tokens * price.completion) > binding.maxMicro) {
        throw new PluginError('not-admitted', 'OpenRouter request exceeds spend reservation');
      }
      body.provider.max_price = price;
      return body;
    },
    providerOptions: stream => ({ ...(binding.effort === 'none' ? {} : { reasoning: { effort: binding.effort } }),
      usage: { include: true },
      provider: { ...binding.routing, require_parameters: true, allow_fallbacks: false },
      ...(stream ? { stream_options: { include_usage: true } } : {}) }) }) };
}
