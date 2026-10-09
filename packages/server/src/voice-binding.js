import { createBinding } from '@inspr/aithema-core';

// Keep duration selection private; token and minute ceilings are different units.
export function createDurationBinding(raw) {
  const { agentId, maxDurationSeconds, upstreamMicroPerMinute, visitorMicroPerMinute,
    publicFacadeBaseUrl, ...common } = raw;
  const binding = createBinding(common);
  if (binding.model !== agentId || !/^[a-zA-Z0-9_-]{1,128}$/u.test(agentId) ||
    !Number.isInteger(maxDurationSeconds) || maxDurationSeconds < 1 || maxDurationSeconds > 3600 ||
    ![upstreamMicroPerMinute, visitorMicroPerMinute].every(n => Number.isSafeInteger(n) && n >= 0) ||
    !Number.isSafeInteger(Math.ceil(maxDurationSeconds / 60 * visitorMicroPerMinute)) ||
    Math.ceil(maxDurationSeconds / 60 * upstreamMicroPerMinute) > binding.maxMicro) throw new TypeError('Invalid duration binding');
  const url = new URL(publicFacadeBaseUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
    url.username || url.password || url.search || url.hash) throw new TypeError('Invalid public facade URL');
  return Object.freeze({ ...binding, agentId, maxDurationSeconds, upstreamMicroPerMinute, visitorMicroPerMinute,
    publicFacadeBaseUrl: url.href.replace(/\/$/u, '') });
}

export function durationPluginMatches(plugin, binding) {
  const privateBinding = plugin.binding;
  return privateBinding?.agentId === binding.agentId && privateBinding.secretRef === binding.secretRef &&
    privateBinding.apiBaseUrl === binding.endpoint.replace(/\/$/u, '') &&
    privateBinding.upstreamMicroPerMinute === binding.upstreamMicroPerMinute &&
    privateBinding.visitorMicroPerMinute === binding.visitorMicroPerMinute;
}
