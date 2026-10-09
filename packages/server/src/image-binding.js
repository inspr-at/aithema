import { createBinding } from '@inspr/aithema-core';

// Conservative common input rate covers both text and image-input tokens. The
// host supplies ceilings for the chosen size/quality, never a public price table.
export function createImageBinding(raw) {
  const { imageCost, ...common } = raw;
  const binding = createBinding(common);
  if (!imageCost || Object.keys(imageCost).some(k => !['inputMicro', 'outputMicro', 'maxInputTokens', 'maxOutputTokens'].includes(k)) ||
    !['inputMicro', 'outputMicro', 'maxInputTokens', 'maxOutputTokens'].every(k => Number.isSafeInteger(imageCost[k]) && imageCost[k] >= 0) ||
    imageCost.maxInputTokens < 1 || imageCost.maxOutputTokens < 1 ||
    !Number.isSafeInteger(imageCost.maxInputTokens * imageCost.inputMicro + imageCost.maxOutputTokens * imageCost.outputMicro) ||
    imageCost.maxInputTokens * imageCost.inputMicro + imageCost.maxOutputTokens * imageCost.outputMicro > binding.maxMicro) {
    throw new TypeError('Invalid private image cost binding');
  }
  return Object.freeze({ ...binding, imageCost: Object.freeze({ ...imageCost }) });
}
export function imagePluginBinding(binding) { const { imageCost, ...common } = binding; return common; }
