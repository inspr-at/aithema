import { createBinding, deepFreeze } from '@inspr/aithema-core';
import { perMinuteCostMicro } from '@inspr/aithema-core/cost';

// Keep duration selection private; token and minute ceilings are different units.
export function createDurationBinding(raw) {
  const { maxDurationSeconds, upstreamMicroPerMinute, visitorMicroPerMinute,
    reservationSeconds, minRunwaySeconds, adapterConfig, ...common } = raw;
  const binding = createBinding(common);
  if (!Number.isInteger(maxDurationSeconds) || maxDurationSeconds < 1 || maxDurationSeconds > 86400 ||
    reservationSeconds !== undefined && (!Number.isSafeInteger(reservationSeconds) || reservationSeconds < 1 || reservationSeconds > maxDurationSeconds) ||
    minRunwaySeconds !== undefined && (!Number.isSafeInteger(minRunwaySeconds) || minRunwaySeconds < 1 || minRunwaySeconds > 86400) ||
    ![upstreamMicroPerMinute, visitorMicroPerMinute].every(n => Number.isSafeInteger(n) && n >= 0) ||
    !Number.isSafeInteger(perMinuteCostMicro(maxDurationSeconds, upstreamMicroPerMinute)) ||
    !Number.isSafeInteger(perMinuteCostMicro(maxDurationSeconds, visitorMicroPerMinute)) ||
    perMinuteCostMicro(reservationSeconds ?? maxDurationSeconds, upstreamMicroPerMinute) > binding.maxMicro) throw new TypeError('Invalid duration binding');
  return Object.freeze({ ...binding, maxDurationSeconds, upstreamMicroPerMinute, visitorMicroPerMinute,
    ...(reservationSeconds === undefined ? {} : { reservationSeconds }), minRunwaySeconds: minRunwaySeconds ?? 120,
    ...(adapterConfig === undefined ? {} : { adapterConfig: deepFreeze(structuredClone(adapterConfig)) }) });
}

export function durationPluginMatches(plugin, binding) {
  const adapter = plugin.ports?.serverAdapter, privateBinding = adapter?.binding ?? plugin.binding;
  return Boolean(privateBinding) && privateBinding.secretRef === binding.secretRef &&
    privateBinding.endpoint === binding.endpoint.replace(/\/$/u, '') &&
    privateBinding.upstreamMicroPerMinute === binding.upstreamMicroPerMinute &&
    privateBinding.visitorMicroPerMinute === binding.visitorMicroPerMinute &&
    privateBinding.reservationSeconds === binding.reservationSeconds &&
    (adapter?.matchesConfig ? adapter.matchesConfig(binding.adapterConfig) === true
      : JSON.stringify(privateBinding.adapterConfig) === JSON.stringify(binding.adapterConfig));
}
