import { ensureAgent, AgentEnsureError } from './ensure-agent.js';
import { reconcileUsage, readConversationDetails } from './server.js';
import { AI_NOTICE, aiNoticeText } from '@inspr/aithema-core/ai-notice';
import { perMinuteCostMicro } from '@inspr/aithema-core/cost';
import { manifest } from './manifest.js';
import { voiceOverrides } from './options.js';
import { watchBearerRejections } from './secret-repair.js';

const REJECTION_WINDOW_MS = 5 * 60_000, REPAIR_WINDOW_MS = 30 * 60_000;
const REJECTION_THRESHOLD = 3;
export { normalizeElevenLabsDurationBinding } from './config.js';

export async function createElevenLabsVoiceHost({ storage, resolveSecret, publicOrigin, templateAgentId,
  apiBaseUrl, fetchImpl = fetch, log = console.log, values = process.env, random = Math.random,
  spokenOpeners, spokenContinuations, agentName, facadeSecretName, costConfig, qualifyBinding,
  accountRef = agentName, facadeSecrets, now = Date.now } = {}) {
  for (const [name, value] of Object.entries({ agentName, facadeSecretName })) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) {
      throw new TypeError(`${name} is required and must be a host-specific identifier (1–128 letters, digits, _ or -)`);
    }
  }
  if (typeof costConfig !== 'function' && (!costConfig || typeof costConfig !== 'object' || Array.isArray(costConfig))) {
    throw new TypeError('costConfig is required and must be a cost object or function');
  }
  if (typeof qualifyBinding !== 'function') throw new TypeError('qualifyBinding is required and must be a function');
  // Snapshot host configuration so startup/read-back and subsequent calls always agree.
  spokenOpeners = Object.freeze(Object.fromEntries(Object.keys(AI_NOTICE).map(locale =>
    [locale, aiNoticeText(locale, { opener: spokenOpeners?.[locale] })])));
  // Continuations are session copy only; never change the managed agent's opener.
  spokenContinuations = Object.freeze(Object.fromEntries(Object.keys(AI_NOTICE)
    .filter(locale => spokenContinuations?.[locale] !== undefined).map(locale => {
      const { firstMessage } = voiceOverrides({ agent: { language: locale, firstMessage: spokenContinuations[locale] } }).agent;
      return [locale, firstMessage];
    })));
  const stop = new AbortController(), listeners = new Set();
  let timer, inFlight, backoff = 30_000, costs, running = false, repairMode = false, repairPatchAt, repairSnapshot;
  let rejections = [], lastRepairAt = -Infinity;
  let unwatch = () => {};
  let availability = { state: 'starting', disabledReason: null, transient: false };
  const host = { voicePresentation: manifest.presentation, staticSecretRef: 'AITHEMA_VOICE_FACADE_SECRET', log,
    get binding() { return availability.binding; },
    get runtime() { return availability.runtime; },
    get disabledReason() { return availability.disabledReason; },
    get transient() { return availability.transient; },
    // Listeners prepare private state synchronously and return it for publication.
    // No listener may mutate the active registry, policy or presets.
    onAvailable(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() {
      stop.abort(); unwatch(); rejections = []; clearTimeout(timer); timer = undefined;
      await inFlight;
    },
    // These ports exist while off so the server can keep its handlers alive.
    presentation: (locale, { hasPriorTurns = false } = {}) => Object.hasOwn(AI_NOTICE, locale)
      ? { agent: { language: locale, firstMessage: hasPriorTurns ? spokenContinuations[locale] ?? spokenOpeners[locale] : spokenOpeners[locale] } } : undefined,
    async closeOrphan(call, { signal }) {
      // The server sweep catches this, retains the durable pending call and retries.
      if (!host.binding) throw new AgentEnsureError(host.disabledReason);
      const binding = host.binding;
      // Self-serve has no qualified monitor port: retain ceiling exposure until final GET data.
      const details = await readConversationDetails({ ...binding, apiBaseUrl: binding.endpoint }, call.providerSessionId,
        { signal }, { fetchImpl, resolveSecret });
      return reconcileUsage({ call, details, binding, maxMicro: call.maxMicro });
    } };
  const transition = (to, reason, prepared = {}) => {
    const from = availability.state;
    const changed = from !== to || availability.disabledReason !== reason;
    // Config, dispatch, settlement and consent scopes all read this one snapshot.
    availability = { ...prepared, state: to, disabledReason: reason, transient: prepared.transient ?? false };
    if (changed) log({ event: 'voice-availability', from, to, reason });
  };
  const retryLater = () => {
    // +/-20% jitter, capped at ten minutes before the repair write cooldown.
    const delay = Math.max(Math.min(600_000, Math.round(backoff * (0.8 + random() * 0.4))),
      // Even a failed/ambiguous PATCH consumes the repair write budget. Read/API
      // recovery uses the existing single timer, never a second retry loop.
      repairMode && repairPatchAt !== undefined ? Math.max(0, repairPatchAt + REPAIR_WINDOW_MS - now()) : 0);
    backoff = Math.min(600_000, backoff * 2);
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = attempt();
    }, delay);
    timer.unref?.();
  };
  const attempt = async () => {
    running = true;
    try {
      const { maxDurationSeconds, reservationSeconds, minRunwaySeconds, upstreamMicroPerMinute, usdPerCredit, maxMicro } = costs;
      const { agentId, apiBaseUrl: endpoint } = await ensureAgent({ storage, resolveSecret, publicOrigin,
        templateAgentId, apiBaseUrl, fetchImpl, log, maxDurationSeconds, spokenOpeners, agentName, facadeSecretName, signal: stop.signal,
        beforeSecretPatch: repairMode ? () => { lastRepairAt = repairPatchAt = now(); } : undefined });
      if (stop.signal.aborted) return;
      repairMode = false; backoff = 30_000;
      // A secret-only repair restores the already prepared runtime, even after
      // a transient outage. Recovery listeners would register its plugin twice.
      if (repairSnapshot) {
        const prepared = repairSnapshot; repairSnapshot = undefined;
        transition('available', null, prepared); return;
      }
      const binding = qualifyBinding({ plugin: 'elevenlabs', model: agentId, agentId, effort: 'none',
        endpoint, accountRef, secretRef: 'ELEVENLABS_API_KEY', maxMicro,
        maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds, reservationSeconds, minRunwaySeconds,
        upstreamMicroPerMinute, visitorMicroPerMinute: upstreamMicroPerMinute,
        ...(usdPerCredit === undefined ? {} : { usdPerCredit }), publicFacadeBaseUrl: publicOrigin }, now());
      let prepared = { binding };
      for (const listener of listeners) prepared = { ...prepared, ...listener({ ...host, ...prepared }) };
      if (stop.signal.aborted) return;
      transition('available', null, prepared);
    } catch (error) {
      if (stop.signal.aborted) return;
      // Provider exceptions and config values never reach logs or public reasons.
      // Repair starts from a prepared runtime: even a rejected PATCH must be
      // retryable. The single retry timer still enforces the repair write cooldown.
      const transient = repairMode || error instanceof AgentEnsureError && error.transient;
      transition('off', error instanceof AgentEnsureError ? error.message : 'voice-host-unavailable', { transient });
      if (host.transient) retryLater();
    } finally { running = false; }
  };
  try {
    costs = typeof costConfig === 'function' ? costConfig(values) : costConfig;
    const { maxDurationSeconds, reservationSeconds, minRunwaySeconds, upstreamMicroPerMinute } = costs;
    // Validate provider-independent duration/cost fields before provisioning.
    const maxMicro = perMinuteCostMicro(reservationSeconds ?? maxDurationSeconds, upstreamMicroPerMinute);
    if (!Number.isSafeInteger(maxDurationSeconds) || maxDurationSeconds < 1 || maxDurationSeconds > 86400 ||
      reservationSeconds !== undefined && (!Number.isSafeInteger(reservationSeconds) || reservationSeconds < 1 || reservationSeconds > maxDurationSeconds) ||
      minRunwaySeconds !== undefined && (!Number.isSafeInteger(minRunwaySeconds) || minRunwaySeconds < 1 || minRunwaySeconds > 86400) ||
      !Number.isSafeInteger(maxMicro) || !Number.isSafeInteger(perMinuteCostMicro(maxDurationSeconds, upstreamMicroPerMinute))) {
      throw new TypeError('Invalid duration costs');
    }
    costs = { ...costs, maxMicro };
  }
  catch { transition('off', 'voice-host-unavailable'); return host; }
  inFlight = attempt();
  await inFlight;
  unwatch = watchBearerRejections(facadeSecrets, () => {
    if (stop.signal.aborted || running || timer || !host.binding) return;
    const time = now();
    if (time - lastRepairAt < REPAIR_WINDOW_MS) return;
    // At most three timestamps, no values, IPs, request objects or per-client map.
    rejections = rejections.filter(at => time - at < REJECTION_WINDOW_MS);
    rejections.push(time);
    if (rejections.length < REJECTION_THRESHOLD) return;
    rejections = []; lastRepairAt = time;
    const deleted = storage.db.prepare('DELETE FROM host_voice_secret_hashes WHERE name=?').run(facadeSecretName);
    if (!deleted.changes) return;
    repairMode = true; repairPatchAt = undefined; repairSnapshot = availability;
    try { Promise.resolve(log({ event: 'voice-secret-repair', name: facadeSecretName })).catch(() => {}); }
    catch { /* Diagnostics cannot block repair. */ }
    inFlight = attempt();
  });
  return host;
}
