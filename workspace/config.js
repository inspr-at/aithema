import { isLoopbackHost } from '../runtime/identity.js';
import { normalizeBrowserLoginConfig } from '../runtime/oidc-login.js';
import { normalizeProviderLimits } from '../runtime/provider.js';
import { normalizeOrgPolicy } from '../runtime/policy.js';
import { normalizeUploadLimits } from '../lib/extract-limits.js';

export { escapeHtml } from '../lib/text.js';

/**
 * @param {unknown} config
 */
export function normalizeWorkspaceConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('workspace config must be an object');
  }
  const mode = config.mode ?? 'production';
  if (mode !== 'production' && mode !== 'demo' && mode !== 'test') {
    throw new Error('workspace mode must be production, demo, or test');
  }
  if (mode === 'production' && config.identity?.kind !== 'jwt-jwks') {
    throw new Error('production identity is unconfigured; refusing to start');
  }
  if ((mode === 'demo' || mode === 'test') && config.identity?.browser_login) {
    throw new Error('browser login is production-only');
  }
  if ((mode === 'demo' || mode === 'test') && config.provider?.kind === undefined) {
    if (!config.providers) throw new Error('provider registry is required');
  }
  const listenHost = config.listenHost ?? (mode === 'production' ? '127.0.0.1' : '127.0.0.1');
  if ((mode === 'demo' || mode === 'test') && !isLoopbackHost(listenHost)) {
    throw new Error('demo/test mode may bind loopback only');
  }
  const dataDir = typeof config.dataDir === 'string' && config.dataDir.trim()
    ? config.dataDir
    : undefined;
  if (mode === 'production' && !dataDir) {
    throw new Error('production workspace requires dataDir');
  }
  const policy = normalizeOrgPolicy(config.policy, {
    providers: config.providers,
    defaultProvider: config.defaultProvider,
  });
  const publicOrigin = normalizePublicOrigin(config.publicOrigin);
  const identity = normalizeIdentityConfig(config.identity, { mode, publicOrigin, listenHost });
  return Object.freeze({
    mode,
    listenHost,
    listenPort: Number.isInteger(config.listenPort) ? config.listenPort : 0,
    dataDir: dataDir ?? ':memory:',
    databaseFile: config.databaseFile,
    identity,
    providers: config.providers,
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
    labelledDemo: mode === 'demo' || mode === 'test',
    limits: normalizeProviderLimits(config.limits),
    uploadLimits: normalizeUploadLimits(config.uploadLimits),
    publicOrigin,
    policy,
  });
}

/**
 * @param {unknown} identity
 * @param {{ mode: string, publicOrigin?: string, listenHost: string }} context
 */
function normalizeIdentityConfig(identity, context) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return identity;
  if (context.mode !== 'production') return identity;
  const browserLogin = normalizeBrowserLoginConfig(identity, context);
  if (!browserLogin) return identity;
  return { ...identity, browser_login: browserLogin };
}

/**
 * Operator-configured public origin for TLS reverse proxies. Must be a full
 * origin (scheme + host + optional port). Request headers such as X-Forwarded-*
 * are not trusted for CSRF checks.
 * @param {unknown} value
 */
function normalizePublicOrigin(value) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('publicOrigin must be a string origin URL');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('publicOrigin must be a valid origin URL');
  }
  if (!parsed.protocol || !parsed.host) {
    throw new Error('publicOrigin must include scheme and host');
  }
  return parsed.origin;
}
