import { canExecute, validate } from '../../contracts/validate.js';
import { sameCountries } from './countries.js';
import { deepFreeze, instant, isLoopbackHost, LANES, resolveSettings } from './resolver.js';

/**
 * @typedef {object} AdapterDescriptor
 * @property {string} id
 * @property {string[]} products
 * @property {('operator'|'cloud')[]} execution_locations
 * @property {Partial<Record<'reaction'|'spec'|'design'|'stt'|'tts', string[]>>} models
 * @property {string[]} voices
 * @property {boolean} healthy
 */

const purposeFor = Object.freeze({ reaction: 'intake', spec: 'specification', design: 'design', stt: 'transcription', tts: 'intake' });
const refPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const scopes = Object.freeze(['session', 'principal_day', 'tenant_day']);

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value) {
  return Array.isArray(value) && new Set(value).size === value.length
    && value.every((item) => typeof item === 'string' && refPattern.test(item));
}

/** No adapter methods execute here; these are server-owned metadata snapshots. */
function adapterReason(adapters, row, voice) {
  if (!Array.isArray(adapters)) return 'adapter_missing';
  const matches = adapters.filter((adapter) => adapter?.id === row.template.adapter);
  if (matches.length === 0) return 'adapter_missing';
  if (matches.length !== 1) return 'adapter_invalid';
  const adapter = matches[0];
  if (!isObject(adapter) || typeof adapter.healthy !== 'boolean' || !stringList(adapter.products)
      || !Array.isArray(adapter.execution_locations) || !adapter.execution_locations.length
      || new Set(adapter.execution_locations).size !== adapter.execution_locations.length
      || !adapter.execution_locations.every((location) => ['operator', 'cloud'].includes(location))
      || !isObject(adapter.models) || Object.keys(adapter.models).some((lane) => !LANES.includes(lane))
      || !Object.values(adapter.models).every(stringList) || !stringList(adapter.voices)) return 'adapter_invalid';
  if (!adapter.healthy) return 'adapter_unhealthy';
  if (!adapter.products.includes(row.template.product) || !adapter.execution_locations.includes(row.execution_location)
      || !adapter.models[row.lane]?.includes(row.model)) return 'adapter_unsupported';
  if (row.lane === 'tts' && voice !== null && !adapter.voices.includes(voice)) return 'voice_not_allowed';
  return null;
}

/**
 * Authorization always includes a validated host record and a separately
 * supplied current host scope. A bare boolean cannot authorize processing.
 * @param {any} authorization
 * @param {any} resolved
 */
function authorizationReason(authorization, resolved) {
  if (authorization === undefined || authorization === null) return 'authorization_missing';
  if (!isObject(authorization) || !isObject(authorization.record) || !isObject(authorization.scope)) return 'authorization_invalid';
  const { record, scope } = authorization;
  if (!canExecute(record).ok || !validate('aithema.authz', record).ok) return 'authorization_invalid';
  if (record.withdrawn_at !== null) return 'authorization_withdrawn';
  if (record.settings_sha256 !== resolved.settings_sha256 || instant(record.created_at) > instant(resolved.checked_at)
      || new Set(record.participants.map((p) => p.participant_ref)).size !== record.participants.length
      || new Set(record.processors.map((p) => p.processor_ref)).size !== record.processors.length) return 'authorization_invalid';
  if (['tid', 'pid', 'sid'].some((key) => typeof scope[key] !== 'string' || record[key] !== scope[key])
      || !Number.isSafeInteger(scope.epoch) || scope.epoch < 1 || record.epoch !== scope.epoch
      || !stringList(scope.participant_refs) || !scope.participant_refs.length
      || !sameCountries(scope.participant_refs, record.participants.map((p) => p.participant_ref))) {
    return 'authorization_scope_mismatch';
  }
  return null;
}

function processorReason(record, row) {
  if (!record.purposes.includes(purposeFor[row.lane])) return 'authorization_purpose_missing';
  const processor = record.processors.find((p) => p.processor_ref === row.template_ref);
  if (!processor || processor.evidence_ref !== row.template.evidence_ref || processor.location !== row.execution_location
      || !row.countries || !sameCountries(processor.countries, row.countries)) return 'authorization_processor_missing';
  return null;
}

/**
 * Advisory capability only. BudgetPort still must admit and claim every paid
 * attempt. Integers and exact currency avoid float/implicit FX budget bypass.
 */
function budgetReason(budget, resolved, row) {
  const spend = resolved.policy.spend;
  const maximum = spend.provider_max[row.lane];
  if (maximum === 0) {
    if (row.execution_location === 'operator' && row.template.deployment === 'self_hosted') {
      try {
        if (isLoopbackHost(new URL(row.template.endpoint).hostname)) return null;
      } catch {
        return 'budget_invalid';
      }
    }
    return 'budget_invalid';
  }
  if (budget === undefined || budget === null) return 'budget_missing';
  if (!isObject(budget) || Object.keys(budget).some((key) => !['currency', 'spent_micro'].includes(key))
      || budget.currency !== spend.currency || !isObject(budget.spent_micro)
      || Object.keys(budget.spent_micro).length !== scopes.length
      || !scopes.every((scope) => Number.isSafeInteger(budget.spent_micro[scope]) && budget.spent_micro[scope] >= 0)) {
    return 'budget_invalid';
  }
  const conversions = new Set();
  for (const fx of spend.fx) {
    const key = `${fx.from}:${fx.to}`;
    if (fx.from === fx.to || fx.to !== spend.currency || conversions.has(key)
        || instant(fx.as_of) > instant(resolved.checked_at)) return 'budget_invalid';
    conversions.add(key);
  }
  if (scopes.some((scope) => maximum > spend.caps[`${scope}_micro`] - budget.spent_micro[scope])) return 'budget_denied';
  return null;
}

/**
 * Server-side settings × adapters × evidence × authorization × budget. Always
 * resolves the original document again, including evidence expiry. There is
 * no preset/provider fallback and no client-supplied capability verdict.
 * @param {unknown} settings
 * @param {{now?: string, preferences?: object, reader?: object,
 *   adapters?: AdapterDescriptor[], authorization?: object, budget?: object}} [context]
 */
export function computeCapabilityMatrix(settings, context = {}) {
  const resolved = resolveSettings(settings, context);
  const authReason = authorizationReason(context.authorization, resolved);
  const lanes = {};
  for (const lane of LANES) {
    const row = { ...resolved.lanes[lane], lane };
    const reasons = [...row.reasons];
    if (['stt', 'tts'].includes(lane) && !resolved.preferences.voice.enabled) reasons.push('voice_disabled');
    if (row.template) {
      const voice = lane === 'tts' ? resolved.preferences.voice.tts_voice : null;
      if (lane === 'tts' && ((resolved.preferences.voice.enabled && voice === null)
          || (voice !== null && !row.template.voices.includes(voice)))) reasons.push('voice_not_allowed');
      const adapter = adapterReason(context.adapters, row, voice);
      if (adapter) reasons.push(adapter);
      const budget = budgetReason(context.budget, resolved, row);
      if (budget) reasons.push(budget);
    }
    if (authReason) reasons.push(authReason);
    else if (row.template) {
      const processor = processorReason(context.authorization.record, row);
      if (processor) reasons.push(processor);
    }
    const unique = [...new Set(reasons)];
    lanes[lane] = {
      enabled: unique.length === 0,
      reason: unique[0] ?? null,
      reasons: unique,
      execution_location: row.execution_location,
      template_ref: row.template_ref,
      model: row.model,
    };
  }
  const voiceReasons = [...new Set(['stt', 'tts', 'reaction'].flatMap((lane) => lanes[lane].reasons))];
  if (settings.voice.vad) {
    if (!context.vad) voiceReasons.push('vad_missing');
    else if (!isObject(context.vad) || context.vad.id !== settings.voice.vad.adapter
        || typeof context.vad.healthy !== 'boolean') voiceReasons.push('vad_invalid');
    else if (!context.vad.healthy) voiceReasons.push('vad_unhealthy');
  }
  const captureReason = authReason ?? (context.authorization.record.purposes.includes('intake') ? null : 'authorization_purpose_missing');
  return deepFreeze({
    settings_sha256: resolved.settings_sha256,
    checked_at: resolved.checked_at,
    preset: resolved.preset,
    lanes,
    voice: {
      enabled: voiceReasons.length === 0,
      reason: voiceReasons[0] ?? null,
      reasons: voiceReasons,
      transport: 'inline',
      execution_location: ['stt', 'tts', 'reaction'].some((lane) => lanes[lane].execution_location === 'cloud') ? 'cloud' : 'operator',
    },
    text_capture: { enabled: captureReason === null, reason: captureReason, execution_location: 'operator' },
    processing_inventory: resolved.processing_inventory,
  });
}
