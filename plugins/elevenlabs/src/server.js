import { setTimeout as delay } from 'node:timers/promises';
import { PluginError, normalizedError } from '../../../packages/core/src/invocation.js';
import { beginVoiceInvocation, voiceLifetime, voiceOperation } from '../../../packages/core/src/live-voice.js';
import { deepFreeze } from '../../../packages/core/src/plugins.js';
import { manifest } from './manifest.js';
import { voiceOverrides } from './options.js';
export { manifest } from './manifest.js';
export { createCompletionsHandler } from './facade.js';

const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
const amount = value => Number.isSafeInteger(value) && value >= 0;
export function createVoiceBinding(value) {
  if (!value || !identifier(value.agentId) || typeof value.secretRef !== 'string' || !value.secretRef ||
    !['upstreamMicroPerMinute', 'visitorMicroPerMinute'].every(key => amount(value[key]))) throw new TypeError('Invalid private voice binding');
  const apiBaseUrl = new URL(value.apiBaseUrl ?? 'https://api.elevenlabs.io');
  const loopbackHttp = apiBaseUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(apiBaseUrl.hostname);
  if (apiBaseUrl.protocol !== 'https:' && !loopbackHttp || apiBaseUrl.username || apiBaseUrl.password ||
    apiBaseUrl.search || apiBaseUrl.hash) throw new TypeError('Invalid ElevenLabs API base URL');
  return deepFreeze({ agentId: value.agentId, secretRef: value.secretRef, apiBaseUrl: apiBaseUrl.href.replace(/\/$/u, ''),
    upstreamMicroPerMinute: value.upstreamMicroPerMinute, visitorMicroPerMinute: value.visitorMicroPerMinute });
}
export async function readJson(response, maxBytes = 65_536) {
  const reader = response.body?.getReader();
  if (!reader) throw new PluginError('invalid-output', 'Missing JSON body');
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new PluginError('limit', 'JSON body exceeds limit');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new PluginError('invalid-output', 'Invalid JSON body'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function providerJson(binding, path, { fetchImpl, resolveSecret }, options) {
  return voiceOperation(options, async ({ signal }) => {
    const key = await resolveSecret(binding.secretRef);
    if (typeof key !== 'string' || !key) throw new PluginError('auth', 'ElevenLabs credential unavailable');
    signal.throwIfAborted();
    const response = await fetchImpl(`${binding.apiBaseUrl}${path}`, {
      headers: { 'xi-api-key': key }, signal, redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new PluginError([401, 403].includes(response.status) ? 'auth' : response.status === 429 ? 'rate-limit' : 'provider');
    }
    return readJson(response);
  });
}

/** Low-level server primitive; the start authority below consumes the claim before calling it. */
export async function mintConversationCredential(binding, { transport = 'webrtc' } = {}, options = {}, ports = {}) {
  binding = createVoiceBinding(binding);
  if (!['webrtc', 'websocket'].includes(transport)) throw new TypeError('Invalid voice transport');
  const provider = { fetchImpl: ports.fetchImpl ?? fetch, resolveSecret: ports.resolveSecret ?? (ref => process.env[ref]) };
  // START src/pages/api/v2/agent-token.ts mintConversationToken/mintSignedUrl:
  // authenticated GET paths, agent_id, include_conversation_id, token/signed_url/conversation_id.
  const path = transport === 'websocket' ? 'get-signed-url' : 'token';
  const body = await providerJson(binding, `/v1/convai/conversation/${path}?agent_id=${encodeURIComponent(binding.agentId)}${transport === 'websocket' ? '&include_conversation_id=true' : ''}`, provider, options);
  let providerSessionId = body.conversation_id;
  if (transport === 'websocket') {
    let url; try { url = new URL(body.signed_url); } catch { throw new PluginError('invalid-output', 'Invalid signed URL'); }
    if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password) throw new PluginError('invalid-output', 'Invalid signed URL');
    providerSessionId ??= url.searchParams.get('conversation_id');
  }
  if (!identifier(providerSessionId) || transport === 'webrtc' && (typeof body.token !== 'string' || !body.token)) {
    throw new PluginError('invalid-output', 'Missing provider conversation identity or credential');
  }
  return { providerSessionId, connectionType: transport,
    ...(transport === 'websocket' ? { signedUrl: body.signed_url } : { conversationToken: body.token }),
    // Application freshness window. Provider signed URLs have their own 15-minute initiation TTL.
    ttlMs: 60_000 };
}

function pausedMilliseconds(pauses, start, end) {
  const intervals = pauses.map(({ from, to }) => [Math.max(start, from), Math.min(end, to ?? end)])
    .filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0]);
  let total = 0, through = start;
  for (const [from, to] of intervals) { total += Math.max(0, to - Math.max(from, through)); through = Math.max(through, to); }
  return total;
}
/** Only a final provider record confirms closure. Browser endSession is never evidence of stopped billing. */
export function reconcileUsage({ call, details, binding, maxMicro, outcome = 'completed' }) {
  if (!amount(maxMicro) || !['completed', 'cancelled'].includes(outcome)) throw new TypeError('Invalid voice settlement');
  const seconds = details?.metadata?.call_duration_secs;
  const providerStart = details?.metadata?.start_time_unix_secs;
  // UNVERIFIED API SHAPE: details.conversation_id echo. START call-reconcile.ts
  // confirms the GET/status/metadata but binds its signed context instead of reading this echo.
  const identityMatches = details?.conversation_id === call.providerSessionId;
  const validDuration = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0;
  let usage = null;
  if (identityMatches && validDuration) {
    const start = typeof providerStart === 'number' && Number.isFinite(providerStart) && providerStart > 0 ? providerStart * 1000 : call.startedAt;
    const pausedSeconds = pausedMilliseconds(call.pauses ?? [], start, start + seconds * 1000) / 1000;
    const visitorSeconds = Math.max(0, seconds - pausedSeconds);
    const upstreamMicro = Math.ceil(seconds / 60 * binding.upstreamMicroPerMinute);
    const visitorMicro = Math.ceil(visitorSeconds / 60 * binding.visitorMicroPerMinute);
    if ([upstreamMicro, visitorMicro].every(amount)) usage = {
      providerSeconds: seconds, providerMinutes: seconds / 60, pausedSeconds, visitorSeconds, upstreamMicro, visitorMicro,
      ...(typeof details.metadata.cost === 'number' && Number.isFinite(details.metadata.cost) && details.metadata.cost >= 0
        ? { providerCredits: details.metadata.cost } : {}),
    };
  }
  const closureConfirmed = identityMatches && ['done', 'failed'].includes(details?.status) && usage !== null;
  return { providerSessionId: call.providerSessionId, outcome: closureConfirmed ? outcome : 'uncertain', closureConfirmed,
    usage, chargedMicro: closureConfirmed ? usage.upstreamMicro : maxMicro,
    overrun: closureConfirmed && usage.upstreamMicro > maxMicro };
}

/** Private host ports persist call state and acknowledge an atomic engine-wide pause transition. */
export function createElevenLabsServer({ binding, fetchImpl = fetch, resolveSecret = ref => process.env[ref],
  saveCall, prepareCall, requestProviderClose, reconcileLater, now = Date.now, closureTimeoutMs = 30_000,
  closurePollIntervalMs = 250 } = {}) {
  binding = createVoiceBinding(binding);
  if (typeof saveCall !== 'function' || typeof prepareCall !== 'function' ||
    ![closureTimeoutMs, closurePollIntervalMs].every(value => Number.isFinite(value) && value > 0) ||
    reconcileLater !== undefined && typeof reconcileLater !== 'function') throw new TypeError('Durable saveCall, prepareCall and valid closure options required');
  const provider = { fetchImpl, resolveSecret };
  return {
    manifest, binding,
    async health(options) {
      return voiceOperation(options, async ({ signal }) => {
        const key = await resolveSecret(binding.secretRef); signal.throwIfAborted();
        return { available: typeof key === 'string' && key.length > 0, reason: key ? undefined : 'credential unavailable' };
      });
    },
    async start(request, options) {
      if (!identifier(request?.callId) || typeof request.facadeSecretRef !== 'string' || !request.facadeSecretRef) throw new TypeError('Private call identity and facade secret reference required');
      const invocation = await beginVoiceInvocation(options, request.callId);
      let call = { callId: request.callId, startedAt: now(), pauses: [], paused: false,
        attemptId: options.attempt.attemptId, claimId: options.attempt.claimId, maxMicro: options.attempt.maxMicro,
        spendDeadlineAt: options.spendDeadlineAt, browserLivenessDeadlineAt: options.browserLivenessDeadlineAt,
        facadeSecretRef: request.facadeSecretRef };
      const callCancellation = new AbortController();
      let lifetime, closing, finished = false, mutation = Promise.resolve();
      const cancelled = () => { void close('cancelled', 'cancelled').catch(() => {}); };
      const serial = fn => { const next = mutation.then(fn); mutation = next.catch(() => {}); return next; };
      const close = (reason = 'closed', outcome = 'completed') => {
        if (!['completed', 'cancelled'].includes(outcome)) return Promise.reject(new TypeError('Invalid voice settlement'));
        if (closing) return closing;
        lifetime?.dispose();
        options.signal?.removeEventListener('abort', cancelled);
        call = { ...call, closing: true, reason };
        closing = serial(async () => {
          finished = true;
          const closeOptions = { deadlineAt: Date.now() + closureTimeoutMs };
          let details, backoffMs = closurePollIntervalMs;
          if (call.providerSessionId) {
            try {
              if (requestProviderClose) await voiceOperation({ deadlineAt: Math.min(closeOptions.deadlineAt, Date.now() + 1000) },
                opts => requestProviderClose(structuredClone(call), opts));
            } catch { /* A failed shutdown request does not invalidate authenticated closure evidence. */ }
            while (Date.now() < closeOptions.deadlineAt) {
              try {
                // START src/pages/api/v2/call-reconcile.ts fetchConversationDetails: GET path/status/metadata.
                details = await providerJson(binding, `/v1/convai/conversations/${encodeURIComponent(call.providerSessionId)}`, provider,
                  { deadlineAt: Math.min(closeOptions.deadlineAt, Date.now() + 5000) });
                if (reconcileUsage({ call, details, binding, maxMicro: options.attempt.maxMicro, outcome }).closureConfirmed) break;
              } catch { /* Processing records and transient lookup failures are retryable within the window. */ }
              const remainingMs = closeOptions.deadlineAt - Date.now();
              if (remainingMs <= 0) break;
              try { await voiceOperation(closeOptions, ({ signal }) => delay(Math.min(backoffMs, remainingMs), undefined, { signal })); }
              catch { break; }
              backoffMs = Math.min(backoffMs * 2, 2000);
            }
          }
          const terminal = reconcileUsage({ call, details, binding, maxMicro: options.attempt.maxMicro, outcome });
          call = { ...call, endedAt: now(), reason, terminal };
          // Even a journal failure must settle the admitted attempt exactly once.
          try { await voiceOperation({ deadlineAt: Date.now() + 1000 }, opts => saveCall(structuredClone(call), opts)); }
          finally {
            try { await invocation.finish(terminal); }
            finally {
              if (terminal.outcome === 'uncertain' && call.providerSessionId && reconcileLater) {
                try { await voiceOperation({ deadlineAt: Date.now() + 1000 }, opts => reconcileLater(structuredClone(call), opts)); }
                catch { /* The host owns durable retry scheduling; the conservative report remains settled. */ }
              }
            }
          }
          return terminal;
        });
        callCancellation.abort(['spend-deadline', 'browser-liveness-deadline'].includes(reason)
          ? new DOMException('Voice call deadline', 'TimeoutError') : undefined);
        return closing;
      };
      try {
        const overrides = voiceOverrides(request.overrides);
        await voiceOperation(options, async opts => {
          if (![options.spendDeadlineAt, options.browserLivenessDeadlineAt].every(value => Number.isFinite(value) && value > now())) throw new PluginError('deadline', 'Spend and browser-liveness deadlines required');
          const spendBound = Math.ceil((options.spendDeadlineAt - now()) / 60_000 * binding.upstreamMicroPerMinute);
          if (!amount(spendBound) || spendBound > options.attempt.maxMicro) throw new PluginError('not-admitted', 'Voice spend deadline exceeds admitted maximum');
          // Host preflight: legacy provisioning, or startup-established static callback authentication.
          await prepareCall(structuredClone(call), opts); opts.signal.throwIfAborted();
          invocation.dispatch();
          const credential = await mintConversationCredential(binding, request, opts, { ...provider, now });
          call = { ...call, providerSessionId: credential.providerSessionId };
          await saveCall(structuredClone(call), opts); opts.signal.throwIfAborted();
          call.credential = credential; // Kept in this private closure, never in the journal.
        });
        const credential = call.credential; delete call.credential;
        lifetime = voiceLifetime({ ...call, now, onExpire: reason => close(reason, 'cancelled') });
        options.signal?.addEventListener('abort', cancelled, { once: true });
        if (options.signal?.aborted) cancelled();
        const leaseMs = options.browserLivenessDeadlineAt - now();
        const boundedCommand = commandOptions => ({ ...commandOptions,
          signal: commandOptions?.signal ? AbortSignal.any([commandOptions.signal, callCancellation.signal]) : callCancellation.signal,
          deadlineAt: Math.min(commandOptions?.deadlineAt ?? Infinity, call.spendDeadlineAt, call.browserLivenessDeadlineAt) });
        const changePause = (paused, commandOptions) => serial(() => voiceOperation(boundedCommand(commandOptions), async opts => {
          if (closing || finished) throw new PluginError('unavailable', 'Voice call ended');
          const next = structuredClone(call), at = now();
          if (next.paused !== paused) {
            if (paused) next.pauses.push({ from: at, to: null });
            else next.pauses.at(-1).to = at;
          }
          next.paused = paused;
          const ack = await saveCall(next, { ...opts, paused });
          opts.signal.throwIfAborted();
          if (ack?.acknowledged !== true || ack.paused !== paused) throw new PluginError('invalid-output', 'Server pause was not acknowledged');
          call = next; return { acknowledged: true, paused };
        }));
        return {
          callId: call.callId, providerSessionId: call.providerSessionId, credential,
          ...(overrides ? { overrides } : {}),
          spendDeadlineAt: call.spendDeadlineAt, browserLivenessDeadlineAt: call.browserLivenessDeadlineAt,
          signal: callCancellation.signal,
          snapshot: () => structuredClone(call), close,
          pause: opts => changePause(true, opts), resume: opts => changePause(false, opts),
          heartbeat: commandOptions => serial(() => voiceOperation(boundedCommand(commandOptions), async opts => {
            if (closing || finished) throw new PluginError('unavailable', 'Voice call ended');
            if (now() >= Math.min(call.spendDeadlineAt, call.browserLivenessDeadlineAt)) throw new PluginError('deadline', 'Voice lease expired');
            const deadline = Math.min(now() + leaseMs, call.spendDeadlineAt);
            const next = { ...call, browserLivenessDeadlineAt: deadline };
            await saveCall(structuredClone(next), opts); opts.signal.throwIfAborted();
            lifetime.heartbeat(deadline); call = next;
            return { acknowledged: true, browserLivenessDeadlineAt: deadline };
          })),
        };
      } catch (error) {
        await close('start-failed', 'cancelled');
        throw normalizedError(error, options.signal);
      }
    },
  };
}
