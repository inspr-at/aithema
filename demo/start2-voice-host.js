import { ensureAgent, AgentEnsureError } from '../plugins/elevenlabs/src/ensure-agent.js';
import { reconcileUsage } from '../plugins/elevenlabs/src/server.js';
import { qualifyStartBinding } from './processing-consent.js';

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
      async closeOrphan(call, { signal }) {
        // Confirmed GET + final duration/status fields: START src/pages/api/v2/call-reconcile.ts.
        // UNVERIFIED API SHAPE: the conversation_id echo required by reconcileUsage.
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
