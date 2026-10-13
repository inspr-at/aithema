import { ensureAgent, AgentEnsureError } from '../plugins/elevenlabs/src/ensure-agent.js';
import { reconcileUsage, readConversationDetails } from '../plugins/elevenlabs/src/server.js';
import { qualifyStartBinding } from './processing-consent.js';
import { AI_NOTICE, aiNoticeText } from '../packages/core/src/ai-notice.js';
import { voiceCostConfig } from './voice-cost-config.js';

export async function createVoiceHost({ storage, resolveSecret, publicOrigin, templateAgentId,
  apiBaseUrl, fetchImpl = fetch, log = console.log, values = process.env, random = Math.random } = {}) {
  const stop = new AbortController(), listeners = new Set();
  let timer, inFlight, backoff = 30_000, state = 'starting', costs;
  const host = { disabledReason: null, transient: false, staticSecretRef: 'AITHEMA_VOICE_FACADE_SECRET', log,
    onAvailable(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() {
      stop.abort(); clearTimeout(timer); timer = undefined;
      await inFlight;
    },
    // These ports exist while off so the server can keep its handlers alive.
    presentation: locale => Object.hasOwn(AI_NOTICE, locale)
      ? { agent: { language: locale, firstMessage: aiNoticeText(locale) } } : undefined,
    async closeOrphan(call, { signal }) {
      if (!host.binding) throw new AgentEnsureError(host.disabledReason);
      const binding = host.binding;
      // Self-serve has no qualified monitor port: retain ceiling exposure until final GET data.
      const details = await readConversationDetails({ ...binding, apiBaseUrl: binding.endpoint }, call.providerSessionId,
        { signal }, { fetchImpl, resolveSecret });
      return reconcileUsage({ call, details, binding, maxMicro: call.maxMicro });
    } };
  const transition = (to, reason) => {
    const changed = state !== to || host.disabledReason !== reason;
    const from = state; state = to; host.disabledReason = reason;
    if (changed) log({ event: 'voice-availability', from, to, reason });
  };
  const retryLater = () => {
    // +/-20% jitter, with the actual delay also bounded by ten minutes.
    const delay = Math.min(600_000, Math.round(backoff * (0.8 + random() * 0.4)));
    backoff = Math.min(600_000, backoff * 2);
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = attempt();
    }, delay);
    timer.unref?.();
  };
  const attempt = async () => {
    try {
      const { maxDurationSeconds, reservationSeconds, upstreamMicroPerMinute, usdPerCredit } = costs;
      const { agentId, apiBaseUrl: endpoint } = await ensureAgent({ storage, resolveSecret, publicOrigin,
        templateAgentId, apiBaseUrl, fetchImpl, log: () => {}, maxDurationSeconds, signal: stop.signal });
      if (stop.signal.aborted) return;
      const binding = qualifyStartBinding({ plugin: 'elevenlabs', model: agentId, agentId, effort: 'none',
        endpoint, accountRef: 'start2-elevenlabs', secretRef: 'ELEVENLABS_API_KEY', maxMicro: Math.ceil(upstreamMicroPerMinute * reservationSeconds / 60),
        maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds, reservationSeconds,
        upstreamMicroPerMinute, visitorMicroPerMinute: upstreamMicroPerMinute,
        ...(usdPerCredit === undefined ? {} : { usdPerCredit }), publicFacadeBaseUrl: publicOrigin });
      host.binding = binding;
      for (const listener of listeners) listener(host);
      host.transient = false;
      transition('available', null);
    } catch (error) {
      if (stop.signal.aborted) return;
      delete host.binding;
      // Provider exceptions and config values never reach logs or public reasons.
      host.transient = error instanceof AgentEnsureError && error.transient;
      transition('off', error instanceof AgentEnsureError ? error.message : 'voice-host-unavailable');
      if (host.transient) retryLater();
    }
  };
  try { costs = voiceCostConfig(values); }
  catch { transition('off', 'voice-host-unavailable'); return host; }
  inFlight = attempt();
  await inFlight;
  return host;
}
