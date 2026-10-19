import { isDeepStrictEqual } from 'node:util';
import { readJson } from './server.js';

// Shared by managed-agent writes, strict readback and the read-only OPS check.
export const CLIENT_EVENTS = Object.freeze(['conversation_initiation_metadata', 'asr_initiation_metadata', 'audio', 'interruption',
  'user_transcript', 'tentative_user_transcript', 'agent_response',
  'agent_response_correction', 'agent_chat_response_part', 'agent_response_metadata', 'agent_tool_response', 'ping']);
export const CLIENT_EVENTS_REMEDIATION = 'Set conversation_config.conversation.client_events to the complete managed contract, including agent_tool_response; run the authorized host ensure and repeat the GET-only health check.';
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);

export class AgentHealthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentHealthError';
    this.code = code;
  }
}

/** Read only the configured agent's client-events contract; never repair or enumerate agents/secrets. */
export async function checkAgentHealth({ agentId, resolveSecret, secretRef = 'ELEVENLABS_API_KEY',
  apiBaseUrl = 'https://api.elevenlabs.io', fetchImpl = fetch, signal } = {}) {
  if (!identifier(agentId)) throw new AgentHealthError('agent-health-config-invalid', 'Configure a valid agentId before checking agent health.');
  let base;
  try { base = new URL(apiBaseUrl); } catch {
    throw new AgentHealthError('agent-health-config-invalid', 'Configure a valid provider API base URL before checking agent health.');
  }
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) ||
    base.username || base.password || base.search || base.hash) {
    throw new AgentHealthError('agent-health-config-invalid', 'Configure HTTPS (or loopback HTTP) without URL credentials, query or fragment for agent health.');
  }
  let key;
  try { key = await resolveSecret(secretRef); } catch {
    throw new AgentHealthError('agent-health-secret-unavailable', 'Resolve the configured provider secret before checking agent health.');
  }
  if (typeof key !== 'string' || !key || /[\r\n]/u.test(key)) {
    throw new AgentHealthError('agent-health-secret-unavailable', 'Resolve the configured provider secret before checking agent health.');
  }
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  let agent;
  try {
    requestSignal.throwIfAborted();
    const response = await fetchImpl(`${base.href.replace(/\/$/u, '')}/v1/convai/agents/${encodeURIComponent(agentId)}`, {
      method: 'GET', redirect: 'error', signal: requestSignal, headers: { 'xi-api-key': key },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new AgentHealthError('agent-health-api-failed', `Agent health GET returned HTTP ${response.status}; check access to the configured agent and retry.`);
    }
    agent = await readJson(response, 1_048_576, { signal: requestSignal });
  } catch (error) {
    if (error instanceof AgentHealthError) throw error;
    throw new AgentHealthError('agent-health-api-failed', 'Agent health GET failed; check provider connectivity and the configured agent, then retry.');
  }
  const clientEvents = agent?.conversation_config?.conversation?.client_events;
  if (!isDeepStrictEqual(clientEvents, CLIENT_EVENTS)) {
    const missing = CLIENT_EVENTS.filter(event => !Array.isArray(clientEvents) || !clientEvents.includes(event));
    throw new AgentHealthError('agent-client-events-mismatch', `${CLIENT_EVENTS_REMEDIATION} ${missing.length
      ? `Missing required events: ${missing.join(', ')}.` : 'Event order, duplicates or unexpected entries differ from the managed contract.'}`);
  }
  return { healthy: true, agentId, clientEvents: [...clientEvents] };
}
