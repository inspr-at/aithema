import { BlockList, isIP } from 'node:net';
import { canExecute, canonicalJson, sha256Hex, validate } from '../../contracts/validate.js';
import { countryRegistry, isSubset } from './countries.js';
import { checkDeploymentPeriod } from '../budget/period.js';

export const LANES = Object.freeze(['reaction', 'spec', 'design', 'stt', 'tts']);
export const PRESETS = Object.freeze(['local-l1', 'eu-e1', 'cloud-c1']);

// Reject known private/reserved literals even if an operator accidentally
// allowlists one. DNS names still need resolution/pinning at the outbound gate.
const blockedAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blockedAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]]) {
  blockedAddresses.addSubnet(address, prefix, 'ipv6');
}

/** Capability reasons, not new foundation error codes. No provider messages. */
export const CAPABILITY_REASONS = Object.freeze([
  'not_configured', 'voice_disabled', 'template_missing', 'model_not_allowed', 'voice_not_allowed',
  'account_mismatch', 'secret_binding_invalid', 'evidence_missing', 'evidence_mismatch',
  'evidence_not_yet_valid', 'evidence_expired', 'country_set_invalid', 'residency_denied',
  'training_opt_out_missing', 'licence_denied', 'egress_denied', 'preset_policy_invalid',
  'hosting_residency_denied', 'account_tier_denied', 'adapter_missing', 'adapter_invalid',
  'adapter_unhealthy', 'adapter_unsupported', 'authorization_missing', 'authorization_invalid',
  'authorization_scope_mismatch', 'authorization_withdrawn', 'authorization_purpose_missing',
  'authorization_processor_missing', 'budget_missing', 'budget_invalid', 'budget_denied',
]);

export class SettingsError extends Error {
  /** @param {string} code @param {string[]} diagnostics */
  constructor(code, diagnostics) {
    super(`${code}: ${diagnostics.join('; ')}`);
    this.name = 'SettingsError';
    this.code = code;
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

/**
 * UTC instants retain the contracts' six-digit fraction precision. Date.parse
 * alone truncates microseconds and could enable not-yet-valid evidence.
 * @param {string} value
 * @returns {bigint}
 */
export function instant(value) {
  if (typeof value !== 'string') throw new TypeError('now must be an RFC 3339 UTC timestamp');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match) throw new TypeError('now must be an RFC 3339 UTC timestamp');
  const base = `${match[1]}Z`;
  const milliseconds = Date.parse(base);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== `${match[1]}.000Z`) {
    throw new TypeError('now must be a real UTC timestamp');
  }
  return BigInt(milliseconds) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

/** @param {any} value */
export function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** @param {any[]} values @param {string} label */
function uniqueById(values, label) {
  const result = new Map();
  for (const value of values) {
    if (result.has(value.id)) throw new SettingsError('settings_invalid', [`duplicate ${label} id`]);
    result.set(value.id, value);
  }
  return result;
}

/** Exact canonical hosts only: no URL, port, wildcard, CIDR or suffix match. */
export function isEgressHost(host) {
  try {
    if (typeof host !== 'string' || host !== host.toLowerCase()) return false;
    if (host.startsWith('[') && host.endsWith(']')) {
      return isIP(host.slice(1, -1)) === 6 && new URL(`http://${host}`).hostname === host;
    }
    if (isIP(host) === 4) return new URL(`http://${host}`).hostname === host;
    return host.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)
      && host.split('.').every((part) => part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))
      && new URL(`http://${host}`).hostname === host;
  } catch {
    return false;
  }
}

/** @param {string} host */
export function isLoopbackHost(host) {
  return host === 'localhost' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'));
}

/** This validates configuration only; dispatch still needs the DNS/claim gate. */
function endpointAllowed(endpoint, location, allow) {
  try {
    const url = new URL(endpoint);
    if (endpoint !== endpoint.trim() || endpoint.includes('\\') || url.username || url.password
        || url.search || url.hash || !isEgressHost(url.hostname)) return false;
    if (!allow.includes(url.hostname)) return false;
    const loopback = isLoopbackHost(url.hostname);
    if (loopback && location !== 'operator') return false;
    const address = url.hostname.replace(/^\[|\]$/g, '');
    const version = isIP(address);
    if (!loopback && version && blockedAddresses.check(address, version === 4 ? 'ipv4' : 'ipv6')) return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && location === 'operator' && loopback);
  } catch {
    return false;
  }
}

/** @param {any} settings @param {any} input */
function preferencesFor(settings, input) {
  const defaults = settings.defaults;
  if (input === undefined) return structuredClone(defaults);
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['preset', 'language', 'address', 'voice'].includes(key))) {
    throw new SettingsError('settings_invalid', ['session preferences contain an unknown key or shape']);
  }
  if (input.voice !== undefined && (!input.voice || typeof input.voice !== 'object' || Array.isArray(input.voice)
      || Object.keys(input.voice).some((key) => !['enabled', 'tts_voice'].includes(key)))) {
    throw new SettingsError('settings_invalid', ['voice preferences contain an unknown key or shape']);
  }
  const out = { ...defaults, ...input, voice: { ...defaults.voice, ...input.voice } };
  if (!PRESETS.includes(out.preset) || typeof out.language !== 'string' || !/^[a-z]{2}(-[A-Z]{2})?$/.test(out.language)
      || !['formal', 'informal'].includes(out.address) || typeof out.voice.enabled !== 'boolean'
      || !(out.voice.tts_voice === null || (typeof out.voice.tts_voice === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(out.voice.tts_voice)))) {
    throw new SettingsError('settings_invalid', ['invalid session preferences']);
  }
  return structuredClone(out);
}

// Offline, closed v1 recognition list: unlisted identifiers, prose, custom
// licences and compound SPDX expressions require review before admission.
const weightLicences = new Set([
  'MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC',
  'CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'CC-BY-SA-3.0', 'CC-BY-SA-4.0',
  'MPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'AGPL-3.0-only', 'AGPL-3.0-or-later', 'LGPL-2.1-only', 'LGPL-2.1-or-later',
  'LGPL-3.0-only', 'LGPL-3.0-or-later', 'Unlicense', 'BSL-1.0', 'Zlib',
]);

function licenceAllowed(template, commercial) {
  if (template.deployment !== 'api' && /voxtral[-_.:]?tts/i.test(template.product)) return false;
  for (const artifact of template.artifacts) {
    const licence = artifact.licence.trim().replace(/\s+/g, '-');
    const product = artifact.product.toLowerCase();
    // §9.5: Voxtral TTS weights never self-hosted; its evidenced API is allowed.
    if (template.deployment !== 'api' && artifact.kind === 'weights' && /voxtral[-_.:]?tts/.test(product)) return false;
    if (commercial && artifact.kind === 'weights'
        && (/^CC-BY-NC(?:-|$)/i.test(licence) || !weightLicences.has(licence))) return false;
    // Only the archived MIT release may be bundled, even noncommercially.
    if (artifact.bundled && /piper/.test(product) && !['MIT', 'MIT-0'].includes(licence)) return false;
  }
  return true;
}

/** @param {string[]} reasons @param {string} reason */
function add(reasons, reason) {
  if (!CAPABILITY_REASONS.includes(reason)) throw new Error('unregistered capability reason');
  if (!reasons.includes(reason)) reasons.push(reason);
}

/**
 * Pure resolver; call at validation, session start and every authority check.
 * No cached evidence, provider calls, secret reads, tenant bindings or fallback.
 * Schema/envelope errors refuse the document. Semantic failures disable each
 * affected lane and remain inspectable across all three presets in issues.
 * @param {unknown} document
 * @param {{now?: string, preferences?: object, reader?: object}} [options]
 */
export function resolveSettings(document, options = {}) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new SettingsError('settings_invalid', ['settings must be an object']);
  }
  const compatible = canExecute(document, options.reader);
  if (!compatible.ok) throw new SettingsError(compatible.code, ['unsupported major or min_reader']);
  const validated = validate('aithema.settings', document);
  if (!validated.ok) throw new SettingsError('settings_invalid', [...validated.schemaErrors, ...validated.invariants]);
  if (Object.hasOwn(document.policy.spend, 'deployment_period')) {
    try { checkDeploymentPeriod(document.policy.spend.deployment_period); }
    catch { throw new SettingsError('settings_invalid', ['invalid deployment_period policy, IANA time_zone or notify_at ordering']); }
  }
  // Work on detached bytes; callers retain their verbatim document.
  const settings = structuredClone(document);
  const now = options.now === undefined ? new Date().toISOString() : options.now;
  const at = instant(now);
  const preferences = preferencesFor(settings, options.preferences);
  const templates = uniqueById(settings.provider_templates, 'template');
  const evidence = uniqueById(settings.evidence, 'evidence');
  const secretAccounts = new Map();
  for (const template of templates.values()) {
    const accounts = secretAccounts.get(template.secret.ref) ?? new Set();
    accounts.add(template.account_ref);
    accounts.add(template.secret.account_ref);
    secretAccounts.set(template.secret.ref, accounts);
  }
  const expand = countryRegistry(settings.country_sets);
  const globalCountries = expand(settings.policy.residency.allowed_countries);
  const placement = expand(settings.hosting.region_placement);
  const globalHosts = settings.policy.egress.allow;
  const byPreset = {};
  const issues = [];
  for (const presetId of PRESETS) {
    const preset = settings.presets[presetId];
    const countries = expand(preset.residency.allowed_countries);
    const hosts = preset.egress.allow;
    const commonReasons = [];
    if (!globalCountries || !countries || !placement) add(commonReasons, 'country_set_invalid');
    if (globalCountries && countries && !isSubset(countries, globalCountries)) add(commonReasons, 'preset_policy_invalid');
    if (placement && countries && !isSubset(placement, countries)) add(commonReasons, 'hosting_residency_denied');
    if (![...globalHosts, ...hosts].every(isEgressHost) || !hosts.every((host) => globalHosts.includes(host))) {
      add(commonReasons, 'preset_policy_invalid');
    }
    if (presetId === 'local-l1' && !hosts.every(isLoopbackHost)) add(commonReasons, 'egress_denied');
    if (settings.hosting.proxy !== null && (!endpointAllowed(settings.hosting.proxy, 'operator', hosts)
        || (presetId === 'local-l1' && !isLoopbackHost(new URL(settings.hosting.proxy).hostname)))) {
      add(commonReasons, 'egress_denied');
    }
    const lanes = {};
    for (const lane of LANES) {
      const selection = preset.lanes[lane];
      const template = selection && templates.get(selection.template_ref);
      const record = template && evidence.get(template.evidence_ref);
      const reasons = [...commonReasons];
      let residency = null;
      if (!selection) add(reasons, 'not_configured');
      else if (!template) add(reasons, 'template_missing');
      else {
        if (!template.models.includes(selection.model)) add(reasons, 'model_not_allowed');
        if (template.account_ref !== template.secret.account_ref) add(reasons, 'account_mismatch');
        if (secretAccounts.get(template.secret.ref).size !== 1) add(reasons, 'secret_binding_invalid');
        if (!licenceAllowed(template, settings.hosting.commercial)) add(reasons, 'licence_denied');
        if (!endpointAllowed(template.endpoint, template.location, hosts)
            || (presetId === 'local-l1' && (template.location !== 'operator'
              || !isLoopbackHost(new URL(template.endpoint).hostname)))) add(reasons, 'egress_denied');
        if (!record) add(reasons, 'evidence_missing');
        else {
          if (record.template_ref !== template.id) add(reasons, 'evidence_mismatch');
          if (record.account_ref !== template.account_ref) add(reasons, 'account_mismatch');
          const binding = record.secret_binding;
          if (!binding.attested || binding.ref !== template.secret.ref || binding.account_ref !== template.account_ref) {
            add(reasons, 'secret_binding_invalid');
          }
          if (instant(record.verified_at) > at) add(reasons, 'evidence_not_yet_valid');
          if (at >= instant(record.expires_at)) add(reasons, 'evidence_expired');
          const sets = Object.values(record.countries).map((refs) => expand(refs));
          if (sets.some((set) => !set)) add(reasons, 'country_set_invalid');
          else {
            residency = [...new Set(sets.flat())].sort();
            if (countries && !isSubset(residency, countries)) add(reasons, 'residency_denied');
          }
          if (record.training_on_content && (!record.opt_out || !record.opt_out.active
              || record.opt_out.account_ref !== template.account_ref)) add(reasons, 'training_opt_out_missing');
          if (template.provider === 'elevenlabs' && presetId === 'eu-e1' && record.account_tier !== 'enterprise') {
            add(reasons, 'account_tier_denied');
          }
        }
      }
      lanes[lane] = {
        template_ref: selection?.template_ref ?? null,
        model: selection?.model ?? null,
        execution_location: template?.location ?? 'operator',
        enabled: reasons.length === 0,
        reason: reasons[0] ?? null,
        reasons,
        template: template ?? null,
        evidence: record ?? null,
        countries: residency,
      };
      if (selection) for (const reason of reasons) issues.push({ preset: presetId, lane, reason });
    }
    byPreset[presetId] = { lanes, countries, egress: { allow: [...hosts] } };
  }
  const selected = byPreset[preferences.preset];
  const referenced = new Set(Object.values(selected.lanes).map((lane) => lane.template_ref).filter(Boolean));
  const processing_inventory = [...referenced].map((id) => {
    const template = templates.get(id);
    return {
      template_ref: id,
      account_ref: template?.account_ref ?? null,
      evidence_ref: template?.evidence_ref ?? null,
      secret: template?.secret ?? null,
      execution_location: template?.location ?? 'operator',
    };
  });
  return deepFreeze({
    settings_sha256: sha256Hex(canonicalJson(document)),
    checked_at: now,
    preset: preferences.preset,
    preferences,
    lanes: selected.lanes,
    policy: { egress: selected.egress, residency: { allowed_countries: selected.countries }, spend: settings.policy.spend },
    processing_inventory,
    issues,
  });
}
