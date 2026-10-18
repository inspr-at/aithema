import { bindingReason } from '@inspr/aithema-core';

/** Public, binding-backed facts. A recipient's seat is never a processing promise.
 * Admission checks evidence identity and expiry; endpoint spelling adds no facts.
 * Legal entity names stay private consistently across all providers. */
export function providerProcessingFacts(binding, { plugin, preset, policy, now }) {
  const current = bindingReason({ binding, plugin, preset, policy, now }) === null;
  return { vendor: plugin?.manifest.vendor.name ?? null,
    recipientCountries: current ? [...binding.legal.countries] : [],
    processingCountries: current && binding.legal.processingCountries ? [...binding.legal.processingCountries] : null,
    verification: current ? 'current' : 'unverified' };
}
