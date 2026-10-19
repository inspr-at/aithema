import { PluginError } from '@inspr/aithema-core/invocation';
import { createComposedVoice } from '@inspr/aithema-server/composed-voice/server';
import { createComposedVoiceAuthority } from '@inspr/aithema-server/composed-voice/authority';
import { createVoxtralComponents } from './server.js';
import { createVoxtralTransports } from './transports.js';
import { manifest, componentManifest } from './manifest.js';
import { bindingReason, processingScope, consentReason, EU_COUNTRIES } from '@inspr/aithema-core';
import { deepFreeze } from '@inspr/aithema-core/plugins';
import { voiceOperation } from '@inspr/aithema-core/live-voice';
import { validateVoxtralAccountConfiguration } from './configuration.js';

const ROLES = ['stt', 'reasoning', 'tts'];
const OPERATIONS = { stt: 'stream', reasoning: 'stream', tts: 'speak' };
const CONSENT = 'current processing consent required';
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && new Set(a).size === a.length && a.every(value => b.includes(value));
const euCountries = countries => Array.isArray(countries) && countries.length > 0 && countries.every(country => EU_COUNTRIES.includes(country));
const emptyRouting = routing => routing === undefined || routing !== null && typeof routing === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(routing)) && Reflect.ownKeys(routing).length === 0;
const SELECTED_REASONING = 'selected reasoning binding must match the Voxtral authority';
// Runtime effort selection changes invocation policy, not account/model identity.
const sameReasoning = (a, b) => ['plugin', 'model', 'endpoint', 'accountRef', 'secretRef'].every(key => a?.[key] === b?.[key]) &&
  a?.legal?.evidence?.dpaRef === b?.legal?.evidence?.dpaRef;
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
    parts = ROLES.map(role => {
      const binding = componentBindings?.[role];
      // Check the original too: cloning can erase custom prototypes or keys.
      if (!emptyRouting(binding?.routing)) throw new TypeError('Invalid Mistral routing');
      return { role, binding: snapshot(binding),
        plugin: { manifest: snapshot(plugins?.[role]?.manifest) }, operation: OPERATIONS[role] };
    });
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
      !emptyRouting(binding.routing) || binding.legal.evidence.dpaRef !== e.dpaRef ||
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
  function evaluate({ preset, policy, reasoningBinding } = {}) {
    let accountReason = invalid;
    if (!accountReason) {
      try { validateVoxtralAccountConfiguration(config, { now: now() }); }
      catch { accountReason = 'current Mistral account evidence required'; }
    }
    const clock = now(), links = {};
    for (const part of parts) {
      let reason = accountReason;
      if (!reason) {
        try {
          reason = part.role === 'reasoning' && reasoningBinding !== undefined && !sameReasoning(reasoningBinding, part.binding)
            ? SELECTED_REASONING : linkReason(part, { preset, policy }, clock);
        }
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
    if (invalid || parts.length < ROLES.length + 1) throw new TypeError('Complete processing scopes required');
    return parts.map(part => snapshot(processingScope(part.binding, part.operation)));
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
    const selection = snapshot({ preset: request.preset, policy: request.policy, reasoningBinding: request.reasoningBinding });
    if (!selection.reasoningBinding) return SELECTED_REASONING;
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
  const adapter = Object.freeze({ requiresReasoningBinding: true, admissionReason, processingScopes, processingDetail });
  return Object.freeze({ evaluate, admissionReason, processingScopes, processingDetail,
    ports: Object.freeze({ serverAdapter: adapter }) });
}


/** Supported host assembly. Host callbacks own session/reasoning selection and
 * re-enter AIT-331 on every authorization, including late result delivery.
 * Component admission is a private host port; reservation formulas and durable
 * speech charging are deliberately left to AIT-332. */
export function createVoxtralVoiceProvider({ enabled = false, config: raw, binding: rawBinding,
  componentBindings: rawBindings, plugins, hostProcessing, storage, consent, getSession,
  resolveSecret, connect, fetchImpl, WebSocket, composition, admitComponent,
  authenticateRelay, relayOrigin, now = Date.now } = {}) {
  const binding = snapshot(rawBinding), componentBindings = snapshot(rawBindings);
  let config, components, unavailable;
  try {
    config = validateVoxtralAccountConfiguration(raw, { now: now() });
    if (!binding || binding.plugin !== 'voxtral-voice' || binding.model !== 'voxtral-voice' ||
      binding.endpoint !== config.endpoint || binding.accountRef !== config.accountRef || binding.secretRef !== config.secretRef ||
      binding.maxMicro !== 0 || binding.upstreamMicroPerMinute !== 0) throw new TypeError('Invalid parent binding');
    if (!connect && WebSocket) ({ connect } = createVoxtralTransports({ endpoint: config.endpoint, WebSocket }));
    components = createVoxtralComponents({ enabled, config, composition, resolveSecret, connect, fetchImpl });
  } catch { unavailable = 'current Mistral account and parent binding required'; }
  const gate = createVoxtralProviderAuthority({ config: raw, componentBindings, hostProcessing, consent, getSession, now,
    plugins: { ...plugins, stt: { manifest: componentManifest }, tts: { manifest: componentManifest } } });
  let mounted;
  const authorize = async (request, options) => {
    if (unavailable || !enabled || !mounted) return false;
    // The mounted authority reads the current session and actual reasoning
    // selection through runtime.checkVoice, which calls this adapter's gate.
    return await mounted.authorize(request, options) === true;
  };
  const composed = createComposedVoice({ enabled, binding, manifest, storage, now,
    config: binding?.adapterConfig ?? {}, interruptionAwareness: true,
    stt: components?.stt, tts: components?.tts, componentsReady: components?.preflight,
    authenticateRelay, relayOrigin, authorize,
    commitUtterance: (envelope, options) => mounted.commitUtterance(envelope, options),
    replyExecutor: { execute: (envelope, options) => mounted.replyExecutor.execute(envelope, options) },
    async admitComponent(request) {
      if (!await authorize(request, request)) throw new PluginError('not-admitted');
      if (typeof admitComponent !== 'function') throw new PluginError('not-admitted', 'host speech admission required');
      return admitComponent({ ...request, binding: componentBindings[request.role] });
    },
  });
  async function health() {
    if (unavailable) return { available: false, reason: unavailable };
    try { validateVoxtralAccountConfiguration(config, { now: now() }); }
    catch { return { available: false, reason: 'current Mistral account evidence required' }; }
    const available = enabled && typeof resolveSecret === 'function' && typeof connect === 'function' &&
      typeof fetchImpl === 'function' && typeof storage?.saveVoiceCall === 'function';
    return { available, reason: available ? 'not yet qualified in live use' : 'Voxtral components unavailable' };
  }
  const start = async (request, options) => {
    if (components) await voiceOperation(options, () => components.preflight);
    const state = await health(); if (!state.available) throw new PluginError('unavailable', state.reason);
    if (!await authorize(request, options)) throw new PluginError('not-admitted');
    const session = await storage.authorize(request.sessionId, request.ownerToken);
    const epoch = storage.voiceLifecycle?.(request.sessionId, request.callId)?.epoch ?? 0;
    return composed.start({ ...request, epoch, voice: config.voiceId, language: session.locale }, options);
  };
  const adapter = Object.freeze({ ...composed.ports.serverAdapter, ...gate.ports.serverAdapter,
    async admissionReason(request, options) {
      if (components) await voiceOperation(options, () => components.preflight);
      const state = await health(); if (!state.available) return state.reason;
      return gate.admissionReason(request, options);
    },
    bindCallbacks(operations) {
      if (mounted) throw new PluginError('already-claimed');
      mounted = createComposedVoiceAuthority(operations);
      return { prepareCallback: () => ({ request: {}, prepare() {}, revoke() {} }),
        callbackRoutes: composed.networkRelay ? [{ method: 'POST', path: '/composed/relay', handle: request => composed.networkRelay.handle(request) }] : [] };
    },
    startSegment: start,
  });
  return Object.freeze({ ...composed, manifest, binding, health, start,
    ports: Object.freeze({ ...composed.ports, serverAdapter: adapter }) });
}
