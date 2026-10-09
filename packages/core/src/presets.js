export const PROCESSING_PRESETS = Object.freeze(['best', 'eu', 'device', 'custom']);
export const FEATURES = Object.freeze(['text', 'analysis', 'voice', 'transcription', 'images', 'html']);
export const EU_COUNTRIES = Object.freeze(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
export const featureUnavailable = reason => ({ available: false, reason });
export const deviceFeatures = () => Object.fromEntries(FEATURES.map(f => [f,
  f === 'text' ? { available: true, reason: null } : featureUnavailable('unavailable on device')]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Gen-2 settings resolver semantics retained: effective account evidence, expiry,
// residency and per-operation scope. Public vendor nationality never admits a route.
export function bindingReason({ binding, plugin, preset, policy = {}, now = Date.now() }) {
  if (!binding) return 'not configured';
  if (!plugin) return 'plugin not registered';
  if (plugin.manifest.placement !== 'server') return 'browser only';
  const model = plugin.manifest.models.find(m => m.id === binding.model) ?? plugin.manifest.models.find(m => m.id === '*');
  if (!model) return 'model not supported';
  if (!model.efforts.includes(binding.effort)) return 'effort not supported';
  if (model.expiresAt && Date.parse(model.expiresAt) <= now) return 'manifest evidence expired';
  const legal = binding.legal, e = legal?.evidence;
  if (!legal?.approved || !e?.qualified) return 'binding evidence unverified';
  if (e.accountRef !== binding.accountRef || e.secretRef !== binding.secretRef || e.model !== binding.model ||
    e.endpoint !== binding.endpoint || !same(e.routing, binding.routing ?? {})) return 'binding evidence mismatch';
  if (!Number.isFinite(e.verifiedAt) || e.verifiedAt > now) return 'binding evidence not yet valid';
  if (!Number.isFinite(e.expiresAt) || e.expiresAt <= now) return 'binding evidence expired';
  if (!legal.purpose || !legal.recipient || !legal.consentVersion || !Array.isArray(legal.processors) ||
    !Array.isArray(legal.dataCategories) || !legal.dataCategories.length || typeof legal.training !== 'boolean' ||
    typeof legal.retention !== 'string' || !legal.retention) return 'processing scope invalid';
  const countries = preset === 'eu' ? EU_COUNTRIES.filter(c => !policy.countries || policy.countries.includes(c)) : policy.countries;
  if (!Array.isArray(legal.countries) || !legal.countries.length || legal.countries.some(c => !/^[A-Z]{2}$/u.test(c))) return 'processing residency unverified';
  if (countries && legal.countries.some(c => !countries.includes(c))) return 'processing residency denied';
  if ((preset === 'eu' || policy.noTraining) && legal.training) return 'training policy denied';
  if (!Array.isArray(policy.endpoints) || !policy.endpoints.includes(binding.endpoint)) return 'endpoint not allowed';
  return null;
}
export function processingScope(binding, operation) {
  const l = binding.legal;
  return { plugin: binding.plugin, model: binding.model, endpoint: binding.endpoint, routing: binding.routing ?? {},
    accountRef: binding.accountRef, operation, purpose: l.purpose,
    recipients: [l.recipient], upstreamProcessors: l.processors, itemVersion: l.consentVersion,
    dataCategories: l.dataCategories };
}
export { consentReason } from './consent.js';
