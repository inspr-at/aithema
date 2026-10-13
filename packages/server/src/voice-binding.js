import { createBinding } from '@inspr/aithema-core';
import { createElevenLabsConfig, elevenLabsConfig, bridgeElevenLabsConfig } from '../../../plugins/elevenlabs/src/config.js';

// Keep duration selection private; token and minute ceilings are different units.
export function createDurationBinding(raw) {
  const { agentId, maxDurationSeconds, upstreamMicroPerMinute, visitorMicroPerMinute,
    publicFacadeBaseUrl, reservationSeconds, minRunwaySeconds, usdPerCredit, adapterConfig, ...common } = raw;
  const config = adapterConfig ?? { agentId, publicFacadeBaseUrl, usdPerCredit };
  const binding = createBinding(common);
  if (binding.model !== config.agentId || !/^[a-zA-Z0-9_-]{1,128}$/u.test(config.agentId) ||
    !Number.isInteger(maxDurationSeconds) || maxDurationSeconds < 1 || maxDurationSeconds > 86400 ||
    reservationSeconds !== undefined && (!Number.isSafeInteger(reservationSeconds) || reservationSeconds < 1 || reservationSeconds > maxDurationSeconds) ||
    minRunwaySeconds !== undefined && (!Number.isSafeInteger(minRunwaySeconds) || minRunwaySeconds < 1 || minRunwaySeconds > 86400) ||
    config.usdPerCredit !== undefined && (typeof config.usdPerCredit !== 'number' || !Number.isFinite(config.usdPerCredit) || config.usdPerCredit < 0) ||
    ![upstreamMicroPerMinute, visitorMicroPerMinute].every(n => Number.isSafeInteger(n) && n >= 0) ||
    !Number.isSafeInteger(Math.ceil(maxDurationSeconds / 60 * upstreamMicroPerMinute)) ||
    !Number.isSafeInteger(Math.ceil(maxDurationSeconds / 60 * visitorMicroPerMinute)) ||
    Math.ceil((reservationSeconds ?? maxDurationSeconds) / 60 * upstreamMicroPerMinute) > binding.maxMicro) throw new TypeError('Invalid duration binding');
  const url = new URL(config.publicFacadeBaseUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
    url.username || url.password || url.search || url.hash) throw new TypeError('Invalid public facade URL');
  return bridgeElevenLabsConfig({ ...binding, agentId: config.agentId, maxDurationSeconds, upstreamMicroPerMinute, visitorMicroPerMinute,
    ...(reservationSeconds === undefined ? {} : { reservationSeconds }), minRunwaySeconds: minRunwaySeconds ?? 120, ...(config.usdPerCredit === undefined ? {} : { usdPerCredit: config.usdPerCredit }),
    publicFacadeBaseUrl: url.href.replace(/\/$/u, '') }, createElevenLabsConfig(config));
}

export function durationPluginMatches(plugin, binding) {
  const privateBinding = plugin.binding;
  const privateConfig = elevenLabsConfig(privateBinding), config = elevenLabsConfig(binding);
  return privateConfig?.agentId === config.agentId && privateBinding.secretRef === binding.secretRef &&
    privateBinding.apiBaseUrl === binding.endpoint.replace(/\/$/u, '') &&
    privateBinding.upstreamMicroPerMinute === binding.upstreamMicroPerMinute &&
    privateBinding.visitorMicroPerMinute === binding.visitorMicroPerMinute &&
    privateBinding.reservationSeconds === binding.reservationSeconds && privateConfig.usdPerCredit === config.usdPerCredit;
}
