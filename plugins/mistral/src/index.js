import { createChatCompletions, createBinding, publicReasoningManifest, deepFreeze } from '@inspr/aithema-core';
export const manifest = deepFreeze(publicReasoningManifest('mistral', 'Mistral', 'https://mistral.ai'));
export function createMistralReasoning({ binding, resolveSecret = ref => process.env[ref], fetchImpl } = {}) {
  binding = createBinding(binding);
  if (binding.plugin !== 'mistral' || Object.keys(binding.routing ?? {}).length) throw new TypeError('Invalid Mistral binding');
  return { bind: binding => createMistralReasoning({ binding, resolveSecret, fetchImpl }), ...createChatCompletions({ manifest, binding, resolveSecret, fetchImpl,
    providerOptions: () => binding.effort === 'none' ? {} : { reasoning_effort: binding.effort } }) };
}
