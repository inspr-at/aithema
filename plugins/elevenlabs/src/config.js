/** Adapter-owned private configuration. Legacy aliases are a PR 1 bridge only. */
export function createElevenLabsConfig(value) {
  if (!value || typeof value.agentId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.agentId) ||
    value.usdPerCredit !== undefined && (typeof value.usdPerCredit !== 'number' || !Number.isFinite(value.usdPerCredit) || value.usdPerCredit < 0)) throw new TypeError('Invalid private ElevenLabs config');
  let publicFacadeBaseUrl;
  if (value.publicFacadeBaseUrl !== undefined) {
    const url = new URL(value.publicFacadeBaseUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
      url.username || url.password || url.search || url.hash) throw new TypeError('Invalid public facade URL');
    publicFacadeBaseUrl = url.href.replace(/\/$/u, '');
  }
  return Object.freeze({ agentId: value.agentId,
    ...(value.usdPerCredit === undefined ? {} : { usdPerCredit: value.usdPerCredit }),
    ...(publicFacadeBaseUrl === undefined ? {} : { publicFacadeBaseUrl }) });
}

export function elevenLabsConfig(value) { return value?.adapterConfig ?? value; }

/** Accept the historical host shape only at the adapter boundary. */
export function normalizeElevenLabsDurationBinding(value) {
  const { agentId, usdPerCredit, publicFacadeBaseUrl, adapterConfig, ...binding } = value;
  const config = createElevenLabsConfig(adapterConfig ?? { agentId, usdPerCredit, publicFacadeBaseUrl });
  if (!config.publicFacadeBaseUrl) throw new TypeError('Invalid public facade URL');
  return { ...binding, adapterConfig: config };
}

/** Keep legacy enumeration/JSON/hashes byte-compatible, with one private source. */
export function bridgeElevenLabsConfig(legacy, config) {
  for (const key of ['agentId', 'usdPerCredit', 'publicFacadeBaseUrl']) {
    if (Object.hasOwn(legacy, key)) Object.defineProperty(legacy, key, { enumerable: true, configurable: false, get: () => config[key] });
  }
  Object.defineProperty(legacy, 'adapterConfig', { value: config, enumerable: false });
  return Object.freeze(legacy);
}
