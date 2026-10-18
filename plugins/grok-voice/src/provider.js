import { PluginError } from '@inspr/aithema-core/invocation';
import { bindingReason, processingScope, consentReason } from '@inspr/aithema-core';
import { deepFreeze } from '@inspr/aithema-core/plugins';
import { voiceOperation } from '@inspr/aithema-core/live-voice';
import { createComposedVoice } from '@inspr/aithema-server/composed-voice/server';
import { createComposedVoiceAuthority } from '@inspr/aithema-server/composed-voice/authority';
import { createGrokComponents } from './server.js';
import { validateGrokConfiguration } from './configuration.js';
import { manifest } from './manifest.js';

/** Host-only factory. Normal voice admission and Rule C bind through the server
 * mount; audio claims are the host's separately admitted children (package 4).
 * No transport, credential, account evidence or alternate provider defaults. */
export function createGrokVoiceProvider({ enabled = false, config: raw, binding: rawBinding, componentBindings: rawComponents,
  storage, consent, resolveSecret, connect, admitComponent, authenticateRelay, relayOrigin, now = Date.now } = {}) {
  const binding = rawBinding && deepFreeze(structuredClone(rawBinding));
  const componentBindings = rawComponents && deepFreeze(structuredClone(rawComponents));
  let config, components, unavailable;
  try {
    if (!raw) unavailable = 'Grok account configuration required (private ZDR/DPA references)';
    else {
      config = validateGrokConfiguration(raw, { now: now() });
      if ([binding, ...Object.values(componentBindings ?? {})].some(part => part?.legal?.purpose !== 'voice-xai' ||
        part.legal.consentVersion !== 1 || part.legal.recipient !== 'SpaceXAI LLC' || part.legal.processors?.length !== 0 ||
        JSON.stringify(part.legal.countries) !== '["US"]' || part.legal.processingCountries !== undefined)) {
        unavailable = 'Grok requires voice-xai v1 direct-recipient binding';
      } else if (!binding || binding.plugin !== 'grok-voice' || binding.model !== 'grok-voice' ||
        binding.maxMicro !== 0 || binding.upstreamMicroPerMinute !== 0 ||
        [binding, ...['stt', 'tts'].map(role => componentBindings?.[role])].some((part, index) =>
          !part || part.plugin !== 'grok-voice' || part.accountRef !== config.accountRef || part.secretRef !== config.secretRef ||
          part.endpoint !== config.endpoint || index && part.model !== ['grok-voice-transcribe-2.0', 'grok-voice-tts'][index - 1])) {
        unavailable = 'Grok component binding mismatch';
      } else components = createGrokComponents({ enabled, config, resolveSecret, connect });
    }
  } catch { unavailable = 'Invalid Grok Voice private configuration (private ZDR/DPA account evidence required)'; }
  const liveManifest = deepFreeze({ ...manifest, kinds: ['live-voice'], models: manifest.models.filter(model => model.operations.includes('start')) });
  let authority;
  const scopes = () => ['stt', 'tts'].map(role => processingScope(componentBindings[role], role === 'stt' ? 'stream' : 'speak'));
  async function health() {
    if (unavailable) return { available: false, reason: unavailable };
    try { validateGrokConfiguration(config, { now: now() }); } catch {
      return { available: false, reason: 'Invalid Grok Voice private configuration (private ZDR/DPA account evidence required)' };
    }
    const available = enabled && typeof resolveSecret === 'function' && typeof connect === 'function' &&
      typeof storage?.saveVoiceCall === 'function';
    return { available, reason: available ? 'not yet qualified in live use' : 'Grok components unavailable' };
  }
  const composed = createComposedVoice({ enabled, config: binding?.adapterConfig ?? {}, binding, storage,
    manifest: liveManifest, stt: components?.stt, tts: components?.tts,
    componentsReady: components?.preflight, authenticateRelay, relayOrigin, now,
    authorize: (request, options) => authority?.authorize(request, options) ?? false,
    commitUtterance: (envelope, options) => authority.commitUtterance(envelope, options),
    replyExecutor: { execute: (envelope, options) => authority.replyExecutor.execute(envelope, options) },
    admitComponent: async request => {
      if (!authority || !await authority.authorize(request, request)) throw new PluginError('not-admitted');
      const maxMicro = request.role === 'stt'
        ? Math.ceil(request.request.maxDurationMs / 3_600_000 * config.streamingMicroPerHour)
        : Math.ceil([...request.request.text].length * config.ttsMicroPerMillionCharacters / 1_000_000);
      return (admitComponent ?? authority.admitComponent)({ ...request, maxMicro, binding: componentBindings[request.role] });
    } });
  const adapter = Object.freeze({ ...composed.ports.serverAdapter,
    processingScopes: () => unavailable ? [] : scopes(),
    async admissionReason({ session, preset, policy }, options) {
      const state = await health(); if (!state.available) return state.reason;
      await voiceOperation(options, () => components.preflight);
      if (preset === 'eu') return 'recipient seat outside eu';
      for (const role of ['stt', 'tts']) {
        const reason = bindingReason({ binding: componentBindings[role], plugin: components[role], preset, policy, now: now() });
        if (reason) return reason;
      }
      if (session.tombstone || session.consentWithdrawn || typeof consent?.coverage !== 'function') return 'current processing consent required';
      for (const scope of scopes()) {
        const coverage = await voiceOperation(options, opts => consent.coverage({ sessionId: session.id,
          scope: structuredClone(scope), consentRevision: session.consentRevision }, opts));
        // Coverage can be issued on a later tick than the request. Evaluate its
        // freshness at receipt, retaining the host clock and strict scope checks.
        if (consentReason(coverage, scope, now(), session.consentRevision)) return 'current processing consent required';
      }
      return null;
    },
    bindCallbacks(operations) {
      authority = createComposedVoiceAuthority(operations);
      return { prepareCallback: () => ({ request: {}, prepare() {}, revoke() {} }), callbackRoutes: composed.networkRelay ? [
        { method: 'POST', path: '/composed/relay', handle: request => composed.networkRelay.handle(request) },
      ] : [] };
    },
  });
  const start = async (request, options) => {
    const state = await health(); if (!state.available) throw new PluginError('unavailable', state.reason);
    if (!authority || !await authority.authorize(request, options)) throw new PluginError('not-admitted');
    const session = storage.authorize(request.sessionId, request.ownerToken);
    // The mounted control route owns the epoch; never accept an arbitrary browser generation.
    const epoch = storage.voiceLifecycle?.(request.sessionId, request.callId)?.epoch ?? 0;
    return composed.start({ ...request, epoch, voice: config.voice, language: session.locale }, options);
  };
  return Object.freeze({ ...composed, manifest: liveManifest, binding, health, start,
    ports: Object.freeze({ ...composed.ports, serverAdapter: Object.freeze({ ...adapter, startSegment: start }) }) });
}
