// Visitor processing settings. START engine-settings.ts and ai-settings.ts semantics,
// ported without its catalog or branding (INSPR D3): option ids select host-private
// bindings on the server; the browser only ever sees ids and public facts.
import { EU_COUNTRIES } from './presets.js';

export const EFFORT_ORDER = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const SETTINGS_ORIGINS = Object.freeze(['default', 'last', 'chosen']);
export const SETTINGS_OFF = 'off';
export const GAUGES = Object.freeze(['quality', 'speed', 'cost', 'privacy', 'voice', 'images']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
export const isOptionId = value => typeof value === 'string' && ID.test(value);
// Refusals a visitor can resolve without another host decision. A choice failing only
// these is saved and offered; admission keeps refusing dispatch until they clear.
const DYNAMIC = new Set(['session paused', 'current processing consent required', 'consent port unavailable',
  'plugin unhealthy', 'budget denied', 'admission deadline',
  'Voice minute cap reached for this deployment', 'Voice minute cap reached for this UTC day']);
export const isDynamicReason = reason => DYNAMIC.has(reason) || typeof reason === 'string' &&
  reason.startsWith('delegated reasoning: ') && DYNAMIC.has(reason.slice('delegated reasoning: '.length));
export const CONSENT_REASON = 'current processing consent required';
export const isConsentReason = reason => reason === CONSENT_REASON || reason === `delegated reasoning: ${CONSENT_REASON}`;

/** Null selects the host's current default for the session's preset. */
export function defaultSettings() {
  return { revision: 0, model: null, effort: null, voice: null, visuals: null, origin: 'default', at: null };
}
const nullable = (value, valid) => value === null || value === undefined || valid(value);
/** Strict durable shape; a browser assertion never reaches this without server validation. */
export function normalizeSettings(value = defaultSettings()) {
  const keys = ['revision', 'model', 'effort', 'voice', 'visuals', 'origin', 'at'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)) ||
    !Number.isSafeInteger(value.revision ?? 0) || (value.revision ?? 0) < 0 ||
    !nullable(value.model, isOptionId) || !nullable(value.effort, e => EFFORT_ORDER.includes(e)) ||
    !nullable(value.voice, isOptionId) || !nullable(value.visuals, isOptionId) ||
    !SETTINGS_ORIGINS.includes(value.origin ?? 'default') ||
    !nullable(value.at, at => typeof at === 'string' && Number.isFinite(Date.parse(at)))) {
    throw new TypeError('Invalid processing settings');
  }
  return { revision: value.revision ?? 0, model: value.model ?? null, effort: value.effort ?? null,
    voice: value.voice ?? null, visuals: value.visuals ?? null, origin: value.origin ?? 'default', at: value.at ?? null };
}
export const sameSelection = (a, b) => ['model', 'effort', 'voice', 'visuals'].every(key => (a?.[key] ?? null) === (b?.[key] ?? null));
export const sortEfforts = efforts => EFFORT_ORDER.filter(effort => efforts.includes(effort));
/** START defaultModelEffort: keep a supported current value, else prefer high, then its nearest neighbours. */
export function preferredEffort(efforts, current) {
  if (efforts.includes(current)) return current;
  return ['high', 'medium', 'xhigh', 'low', 'max', 'minimal', 'none'].find(effort => efforts.includes(effort)) ?? efforts[0] ?? null;
}

// START's response-style preference index, extended with minimal. It describes a
// selected preference, never measured latency.
const SPEED = Object.freeze({ none: 5, minimal: 5, low: 5, medium: 4, high: 3, xhigh: 2, max: 1 });
const PRIVACY = Object.freeze({ device: 95, eu: 70, restricted: 55, declared: 30, unverified: 0 });
const PRIVACY_RANK = Object.freeze(['unverified', 'declared', 'restricted', 'eu', 'device']);
const CAPABILITY_WEIGHT = Object.freeze({ native: 1, emulated: 0.5, unavailable: 0 });
function locationCategory(locations = []) {
  if (!locations.length || locations.some(l => l === 'unverified')) return 'unverified';
  if (locations.every(l => l === 'device')) return 'device';
  if (locations.every(l => l === 'EU' || EU_COUNTRIES.includes(l))) return 'eu';
  return 'declared';
}
function policyCategory(policy) {
  if (policy?.residency === 'eu') return 'eu';
  if (Array.isArray(policy?.countries) && policy.countries.length) {
    return policy.countries.every(c => EU_COUNTRIES.includes(c)) ? 'eu' : 'restricted';
  }
  return null;
}
const lowest = categories => categories.reduce((a, b) => PRIVACY_RANK.indexOf(b) < PRIVACY_RANK.indexOf(a) ? b : a);
const verified = facts => facts?.qualification === 'qualified';

/**
 * The six settings gauges, computed only from the public facts the server derives
 * from each selected binding's manifest and the operator's public configuration.
 * Fill levels are 0-100. States name the explanation; the UI supplies the copy.
 */
export function settingsGauges({ preset, info = {}, model = null, effort = null, voice = null, visuals = null }) {
  if (preset === 'device') {
    return { quality: { state: 'local', fill: 0 }, speed: { state: 'local', fill: 0 }, cost: { state: 'local', fill: 0 },
      privacy: { state: 'device', fill: PRIVACY.device }, voice: { state: 'device', fill: 0 }, images: { state: 'device', fill: 0 } };
  }
  const m = model?.facts, gauges = {};
  const rating = m?.quality;
  gauges.quality = !m ? { state: 'none', fill: 0 }
    : rating && Number.isFinite(rating.score) && rating.score >= 0 && rating.score <= 100 && rating.source?.name && rating.source?.url && rating.source?.asOf
      ? { state: 'rated', fill: Math.round(rating.score), score: Math.round(rating.score), source: rating.source }
      : { state: verified(m) ? 'qualified' : 'unverified', fill: 0 };
  if (!m || !effort) gauges.speed = { state: 'none', fill: 0 };
  else {
    const index = Math.max(1, (SPEED[effort] ?? 3) - (m.streaming === false ? 1 : 0));
    gauges.speed = { state: 'index', fill: index * 20, index, streaming: m.streaming !== false };
  }
  const selected = [model, voice, visuals].filter(Boolean);
  if (!selected.length) gauges.cost = { state: 'none', fill: 0 };
  else if (selected.every(option => option.facts?.free)) gauges.cost = { state: 'free', fill: 0 };
  else if (selected.some(option => !option.facts?.free && !reviewed(option.facts?.cost))) gauges.cost = { state: 'unverified', fill: 0 };
  else {
    // Relative to the most expensive reviewed model the host offers in this preset.
    const rate = option => !option || option.facts?.free || !reviewed(option.facts?.cost) ? 0 : option.facts.cost.inputMicro + option.facts.cost.outputMicro;
    const max = Math.max(0, rate(model), ...(info.models ?? []).map(rate));
    gauges.cost = { state: 'reviewed', fill: max > 0 ? Math.round(rate(model) / max * 100) : 0, unit: m?.cost?.unit ?? null };
  }
  const guaranteed = policyCategory(info.policy);
  const categories = selected.map(option => guaranteed ?? locationCategory(option.facts?.processingLocations));
  const privacy = categories.length ? lowest(categories) : 'unverified';
  gauges.privacy = { state: privacy, fill: PRIVACY[privacy], enforced: Boolean(guaranteed),
    countries: Array.isArray(info.policy?.countries) ? [...info.policy.countries] : null };
  const v = voice?.facts;
  if (!voice) gauges.voice = { state: 'off', fill: 0 };
  else {
    const capabilities = Object.values(v?.capabilities ?? {});
    const score = capabilities.reduce((sum, c) => sum + (CAPABILITY_WEIGHT[c] ?? 0), 0);
    gauges.voice = { state: verified(v) ? 'qualified' : 'unverified', fill: capabilities.length ? Math.round(score / capabilities.length * 100) : 0,
      native: capabilities.filter(c => c === 'native').length, emulated: capabilities.filter(c => c === 'emulated').length, total: capabilities.length };
  }
  const i = visuals?.facts;
  if (!visuals) gauges.images = { state: 'off', fill: 0 };
  else {
    const operations = ['generate', 'edit'].filter(op => i?.operations?.includes(op));
    gauges.images = { state: verified(i) ? 'qualified' : 'unverified', fill: operations.length * 50, operations, formats: [...(i?.formats ?? [])] };
  }
  return gauges;
}
function reviewed(cost) {
  return Boolean(cost) && Number.isFinite(cost.inputMicro) && Number.isFinite(cost.outputMicro) &&
    typeof cost.reviewedAt === 'string' && Number.isFinite(Date.parse(cost.reviewedAt));
}
