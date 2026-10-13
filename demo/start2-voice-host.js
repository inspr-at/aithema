import { ensureAgent, AgentEnsureError } from '../plugins/elevenlabs/src/ensure-agent.js';
import { reconcileUsage, readConversationDetails } from '../plugins/elevenlabs/src/server.js';
import { qualifyStartBinding } from './processing-consent.js';
import { AI_NOTICE, aiNoticeText } from '../packages/core/src/ai-notice.js';
import { voiceCostConfig } from './voice-cost-config.js';

export async function createVoiceHost({ storage, resolveSecret, publicOrigin, templateAgentId,
  apiBaseUrl, fetchImpl = fetch, log = console.log, values = process.env } = {}) {
  const { maxDurationSeconds, reservationSeconds, minRunwaySeconds, upstreamMicroPerMinute, usdPerCredit } = voiceCostConfig(values);
  try {
    const { agentId, apiBaseUrl: endpoint } = await ensureAgent({ storage, resolveSecret, publicOrigin,
      templateAgentId, apiBaseUrl, fetchImpl, log, maxDurationSeconds });
    const binding = qualifyStartBinding({ plugin: 'elevenlabs', model: agentId, agentId, effort: 'none',
      endpoint, accountRef: 'start2-elevenlabs', secretRef: 'ELEVENLABS_API_KEY', maxMicro: Math.ceil(upstreamMicroPerMinute * reservationSeconds / 60),
      maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds, reservationSeconds, minRunwaySeconds,
      upstreamMicroPerMinute, visitorMicroPerMinute: upstreamMicroPerMinute,
      ...(usdPerCredit === undefined ? {} : { usdPerCredit }), publicFacadeBaseUrl: publicOrigin });
    return { binding, staticSecretRef: 'AITHEMA_VOICE_FACADE_SECRET', log,
      // Every call receives the component's exact AI notice in its conversation language only.
      // Startup enables language + first_message on our owned agent and verifies read-back.
      presentation: locale => Object.hasOwn(AI_NOTICE, locale)
        ? { agent: { language: locale, firstMessage: aiNoticeText(locale) } } : undefined,
      async closeOrphan(call, { signal }) {
        // Remote end_call requires enterprise monitoring (ElevenLabs docs,
        // /eleven-agents/guides/realtime-monitoring). This self-serve host has
        // no qualified monitor port: keep ceiling exposure until final GET data.
        // verified by read-only GET 2026-10-09: conversation_id echo,
        // status and metadata.call_duration_secs/cost (provider credits).
        const details = await readConversationDetails({ ...binding, apiBaseUrl: endpoint }, call.providerSessionId,
          { signal }, { fetchImpl, resolveSecret });
        return reconcileUsage({ call, details, binding, maxMicro: call.maxMicro });
      } };
  } catch (error) {
    // Do not let upstream response text, config or key-bearing exceptions reach logs.
    return { disabledReason: error instanceof AgentEnsureError ? error.message : 'voice-host-unavailable' };
  }
}
