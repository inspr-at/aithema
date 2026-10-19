import { bindingReason, processingScope, consentReason, EU_COUNTRIES } from '@inspr/aithema-core';
import { deepFreeze } from '@inspr/aithema-core/plugins';
import { voiceOperation } from '@inspr/aithema-core/live-voice';
import { validateVoxtralAccountConfiguration } from './configuration.js';

const ROLES = ['stt', 'reasoning', 'tts'];
const OPERATIONS = { stt: 'stream', reasoning: 'stream', tts: 'speak' };
const CONSENT = 'current processing consent required';
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every(value => b.includes(value));
const euCountries = countries => Array.isArray(countries) && countries.length > 0 && countries.every(country => EU_COUNTRIES.includes(country));
const snapshot = value => value === undefined ? undefined : deepFreeze(structuredClone(value));

/** Private, effect-free authority for AIT-330's future assembly. Pair each binding
 * with the actual component/reasoning manifest and every host processor. The
 * mounted host must use these checks for admission AND delivery of late results,
 * and supply its authoritative synchronous session reader. No claims or ports for
 * credentials, network dispatch, charging or transport assembly are accepted. */
export function createVoxtralProviderAuthority({ config: raw, componentBindings, plugins, hostProcessing,
  consent, getSession, now = Date.now } = {}) {
  // Only this allowlisted origin is retained for honest routing detail when
  // account evidence is missing; it never establishes eligibility.
  const endpoint = ['https://api.mistral.ai', 'https://api.eu.mistral.ai'].includes(raw?.endpoint) ? raw.endpoint : null;
  let config, parts = [], invalid;
  try {
    parts = ROLES.map(role => ({ role, binding: snapshot(componentBindings?.[role]),
      plugin: { manifest: snapshot(plugins?.[role]?.manifest) }, operation: OPERATIONS[role] }));
    config = validateVoxtralAccountConfiguration(raw, { now: now() });
    if (!Array.isArray(hostProcessing) || !hostProcessing.length) throw new TypeError();
    parts.push(...hostProcessing.map((part, index) => ({ role: `host:${index}`, binding: snapshot(part.binding),
      plugin: { manifest: snapshot(part.plugin?.manifest) }, operation: part.operation })));
  } catch { invalid = 'current Mistral account and complete host processing evidence required'; }

  function linkReason(part, { preset, policy }, clock) {
    const { role, binding, plugin, operation } = part;
    if (!binding || !plugin.manifest || plugin.manifest.id !== binding.plugin) return 'component binding mismatch';
    const model = plugin.manifest.models?.find(model => model.id === binding.model || model.id === '*');
    if (!operation || !model?.operations?.includes(operation)) return 'operation unsupported';
    const reason = bindingReason({ binding, plugin, preset, policy, now: clock });
    if (reason) return reason;
    if (role.startsWith('host:')) return null;
    const e = config.accountEvidence;
    // Other reasoning providers can still be assessed honestly for non-EU use.
    // Only Mistral on the same account, endpoint and DPA may qualify literal EU.
    const mistral = role !== 'reasoning' || binding.plugin === 'mistral';
    if (!mistral) return preset === 'eu' ? 'EU reasoning requires the same Mistral account and regional endpoint' : null;
    if (binding.plugin !== (role === 'reasoning' ? 'mistral' : 'voxtral') ||
      binding.accountRef !== config.accountRef || binding.endpoint !== config.endpoint ||
      binding.secretRef !== config.secretRef || binding.model !== e.services[role].model ||
      Object.keys(binding.routing ?? {}).length || binding.legal.evidence.dpaRef !== e.dpaRef ||
      binding.legal.recipient !== e.recipient || !sameSet(binding.legal.countries, e.recipientCountries) ||
      binding.legal.training !== false) return 'Mistral account/service evidence mismatch';
    if (preset === 'eu') {
      if (config.endpoint !== 'https://api.eu.mistral.ai') return 'EU requires regional Mistral endpoint';
      if (e.undertaking.region !== 'EU' || !e.undertaking.controlPlaneIncluded ||
        !euCountries(e.undertaking.processingCountries) || !euCountries(e.recipientCountries)) return 'exact EU-country undertaking including control plane required';
      if (!sameSet(binding.legal.processingCountries, e.undertaking.processingCountries)) return 'Mistral processing undertaking mismatch';
    }
    return null;
  }
  function evaluate({ preset, policy } = {}) {
    let accountReason = invalid;
    if (!accountReason) {
      try { validateVoxtralAccountConfiguration(config, { now: now() }); }
      catch { accountReason = 'current Mistral account evidence required'; }
    }
    const clock = now(), links = {};
    for (const part of parts) {
      let reason = accountReason;
      if (!reason) {
        try { reason = linkReason(part, { preset, policy }, clock); }
        catch { reason = 'invalid processing binding'; }
      }
      links[part.role] = { reason, available: reason === null };
    }
    const reason = accountReason ?? Object.values(links).find(link => link.reason)?.reason ?? null;
    // Eligibility is independent of the requested preset; a successful best-chain
    // check must never turn international reasoning into an EU claim.
    let euEligible = !reason;
    if (euEligible) for (const part of parts) {
      try { if (linkReason(part, { preset: 'eu', policy }, clock)) euEligible = false; }
      catch { euEligible = false; }
    }
    return deepFreeze({ reason, available: reason === null, euEligible, links });
  }
  const processingScopes = () => {
    try { return invalid ? [] : parts.map(part => snapshot(processingScope(part.binding, part.operation))); }
    catch { return []; }
  };
  function processingDetail() {
    // These are safe presentation data, not evidence or chain qualification.
    const regional = () => Object.freeze({ code: 'regional-inference',
      text: "Processed in Mistral's EU/EFTA region; account and control data may be processed elsewhere." });
    if (endpoint === 'https://api.mistral.ai') return Object.freeze({ code: 'global-uncommitted',
      text: 'Mistral global endpoint has no inference-location commitment.' });
    if (endpoint !== 'https://api.eu.mistral.ai') return Object.freeze({ code: 'unverified',
      text: 'Mistral account processing evidence is unverified.' });
    if (invalid) return regional();
    try { validateVoxtralAccountConfiguration(config, { now: now() }); }
    catch { return regional(); }
    const e = config.accountEvidence;
    if (e.undertaking.region === 'EU' && e.undertaking.controlPlaneIncluded && euCountries(e.undertaking.processingCountries)) {
      return Object.freeze({ code: 'eu-undertaking', text: 'Account evidence includes an exact EU-country undertaking; full-chain admission is checked separately.' });
    }
    return regional();
  }
  async function admissionReason(request = {}, options) {
    // Capture selection and revision before awaiting any external authority.
    const selection = snapshot({ preset: request.preset, policy: request.policy });
    const id = request.session?.id, revision = request.session?.consentRevision, activePreset = request.session?.processingPreset;
    const initial = evaluate(selection); if (initial.reason) return initial.reason;
    let session;
    const current = () => {
      const state = getSession?.(id);
      if (!state || state.id !== id || state.tombstone || state.consentWithdrawn ||
        state.consentRevision !== revision ||
        state.processingPreset !== activePreset) return null;
      return state;
    };
    try {
      session = current();
      if (!session || typeof consent?.coverage !== 'function') return CONSENT;
      const grants = [];
      for (const scope of processingScopes()) {
        const coverage = await voiceOperation(options, opts => consent.coverage({ sessionId: session.id,
          scope: structuredClone(scope), consentRevision: revision }, opts));
        if (!current() || consentReason(coverage, scope, now(), revision)) return CONSENT;
        grants.push({ coverage, scope });
      }
      // Recheck the complete set at receipt: earlier grants and account evidence
      // can expire while the final host coverage is still in flight.
      if (!current() || grants.some(({ coverage, scope }) => consentReason(coverage, scope, now(), revision))) return CONSENT;
      return evaluate(selection).reason;
    } catch { return CONSENT; }
  }
  const adapter = Object.freeze({ admissionReason, processingScopes, processingDetail });
  return Object.freeze({ evaluate, admissionReason, processingScopes, processingDetail,
    ports: Object.freeze({ serverAdapter: adapter }) });
}

