import { ensureAgent, AgentEnsureError } from '../plugins/elevenlabs/src/ensure-agent.js';
import { reconcileUsage } from '../plugins/elevenlabs/src/server.js';
import { qualifyStartBinding } from './processing-consent.js';
import { AI_NOTICE } from '../packages/core/src/ai-notice.js';

// START src/lib/provider-pricing.ts PROVIDER_COST_RESERVATIONS.agentCallMicrodollarsPerMinute.
const RATE = 100_000, DURATION = 600;
export async function createVoiceHost({ storage, resolveSecret, publicOrigin, templateAgentId,
  apiBaseUrl, fetchImpl = fetch, log } = {}) {
  try {
    const { agentId, apiBaseUrl: endpoint } = await ensureAgent({ storage, resolveSecret, publicOrigin,
      templateAgentId, apiBaseUrl, fetchImpl, log, maxDurationSeconds: DURATION });
    const binding = qualifyStartBinding({ plugin: 'elevenlabs', model: agentId, agentId, effort: 'none',
      endpoint, accountRef: 'start2-elevenlabs', secretRef: 'ELEVENLABS_API_KEY', maxMicro: RATE * DURATION / 60,
      maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds: DURATION,
      upstreamMicroPerMinute: RATE, visitorMicroPerMinute: RATE, publicFacadeBaseUrl: publicOrigin });
    return { binding, staticSecretRef: 'AITHEMA_VOICE_FACADE_SECRET',
      // Each call listens and speaks in the conversation's language. The greeting is the agent's fixed,
      // bilingual AI notice (AIT-119), which no override can replace. UNVERIFIED LIVE: that a call speaks
      // the notice first and that this language override leaves its text unchanged rests on the read-back
      // and the provider's documentation; verify live (README, "Coordinator live smoke", step 4).
      presentation: locale => Object.hasOwn(AI_NOTICE, locale) ? { agent: { language: locale } } : undefined,
      async closeOrphan(call, { signal }) {
        // verified by read-only GET 2026-10-09: conversation_id echo,
        // status and metadata.call_duration_secs/cost (provider credits).
        const response = await fetchImpl(`${endpoint}/v1/convai/conversations/${encodeURIComponent(call.providerSessionId)}`,
          { headers: { 'xi-api-key': await resolveSecret(binding.secretRef) }, signal, redirect: 'error' });
        if (!response.ok) { await response.body?.cancel(); return null; }
        const details = await response.json();
        return reconcileUsage({ call, details, binding, maxMicro: call.maxMicro });
      } };
  } catch (error) {
    // Do not let upstream response text, config or key-bearing exceptions reach logs.
    return { disabledReason: error instanceof AgentEnsureError ? error.message : 'voice-host-unavailable' };
  }
}
