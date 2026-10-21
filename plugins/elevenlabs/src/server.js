import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PluginError, normalizedError } from '@inspr/aithema-core/invocation';
import { beginVoiceInvocation, voiceLifetime, voiceOperation } from '@inspr/aithema-core/live-voice';
import { manifest } from './manifest.js';
import { perMinuteCostMicro, usdCostMicro } from '@inspr/aithema-core/cost';
import { voiceOverrides, elevenLabsMediaGrant, elevenLabsComponents } from './options.js';
import { elevenLabsCallbackPort } from './callbacks.js';
import { createTextSpeech } from './text-speech.js';
import { createElevenLabsConfig, elevenLabsConfig, bridgeElevenLabsConfig, normalizeElevenLabsDurationBinding } from './config.js';
export { createElevenLabsConfig } from './config.js';
export { createElevenLabsReplyExecutor } from './reply.js';
export { manifest } from './manifest.js';
export { createCompletionsHandler } from './facade.js';
export { createVoiceProvider } from './provider.js';
export { createFacadeSecrets } from './callbacks.js';

const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
const amount = value => Number.isSafeInteger(value) && value >= 0;
export function createVoiceBinding(value) {
  const config = elevenLabsConfig(value);
  if (!value || !identifier(config.agentId) || typeof value.secretRef !== 'string' || !value.secretRef ||
    !['upstreamMicroPerMinute', 'visitorMicroPerMinute'].every(key => amount(value[key])) ||
    config.usdPerCredit !== undefined && (typeof config.usdPerCredit !== 'number' || !Number.isFinite(config.usdPerCredit) || config.usdPerCredit < 0) ||
    value.reservationSeconds !== undefined && (!Number.isSafeInteger(value.reservationSeconds) || value.reservationSeconds < 1)) throw new TypeError('Invalid private voice binding');
  const apiBaseUrl = new URL(value.apiBaseUrl ?? 'https://api.elevenlabs.io');
  const loopbackHttp = apiBaseUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(apiBaseUrl.hostname);
  if (apiBaseUrl.protocol !== 'https:' && !loopbackHttp || apiBaseUrl.username || apiBaseUrl.password ||
    apiBaseUrl.search || apiBaseUrl.hash) throw new TypeError('Invalid ElevenLabs API base URL');
  return bridgeElevenLabsConfig({ agentId: config.agentId, secretRef: value.secretRef, apiBaseUrl: apiBaseUrl.href.replace(/\/$/u, ''),
    upstreamMicroPerMinute: value.upstreamMicroPerMinute, visitorMicroPerMinute: value.visitorMicroPerMinute,
    ...(config.usdPerCredit === undefined ? {} : { usdPerCredit: config.usdPerCredit }),
    ...(value.reservationSeconds === undefined ? {} : { reservationSeconds: value.reservationSeconds }) }, createElevenLabsConfig(config));
}

// Current API schema: metadata.cost_fiat is total USD; metadata.cost is total credits.
// charging fields are components, not an additional charge on top of either total.
function conversationCost(metadata, binding, seconds) {
  const fiat = usdCostMicro(metadata.cost_fiat);
  if (fiat !== null) return { upstreamMicro: fiat, costSource: 'elevenlabs.cost_fiat', costEstimated: false };
  const charging = metadata.charging;
  const platform = charging?.platform_charge ?? charging?.call_charge;
  const parts = [platform, charging?.llm_charge, charging?.analysis?.total?.charge];
  const credits = amount(metadata.cost) ? metadata.cost
    // Optional components are unknown when absent, including a missing analysis
    // charge. Only an explicit total or every component can confirm even zero.
    : parts.every(amount) ? parts.reduce((sum, n) => sum + n, 0) : null;
  if (credits !== null && (binding.usdPerCredit !== undefined || credits === 0)) {
    const micro = usdCostMicro(binding.usdPerCredit ?? 0, credits);
    if (micro !== null) return { upstreamMicro: micro, providerCredits: credits,
      costSource: amount(metadata.cost) ? 'elevenlabs.cost' : 'elevenlabs.charging', costEstimated: false,
      usdPerCredit: binding.usdPerCredit ?? 0 };
  }
  return { upstreamMicro: perMinuteCostMicro(seconds, binding.upstreamMicroPerMinute),
    costSource: 'duration-estimate', costEstimated: true,
    estimateMicroPerMinute: binding.upstreamMicroPerMinute,
    ...(credits === null ? {} : { providerCredits: credits }) };
}
export async function readJson(response, maxBytes = 65_536, { signal, onBytes } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('Positive JSON byte limit required');
  const reader = response.body?.getReader();
  if (!reader) throw new PluginError('invalid-output', 'Missing JSON body');
  // Coalesce tiny transport chunks into slabs: both retained bytes and chunk metadata stay bounded.
  const chunks = []; let length = 0, slab, used = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted(); if (done) break;
      onBytes?.(length + value.byteLength);
      if (length + value.byteLength > maxBytes) throw new PluginError('limit', 'JSON body exceeds limit');
      for (let offset = 0; offset < value.byteLength;) {
        if (!slab || used === slab.byteLength) {
          slab = new Uint8Array(Math.min(65_536, maxBytes - length)); chunks.push(slab); used = 0;
        }
        const count = Math.min(slab.byteLength - used, value.byteLength - offset);
        slab.set(value.subarray(offset, offset + count), used);
        used += count; offset += count; length += count;
      }
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) {
      const part = chunk.subarray(0, Math.min(chunk.byteLength, length - offset));
      bytes.set(part, offset); offset += part.byteLength;
    }
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new PluginError('invalid-output', 'Invalid JSON body'); }
  } finally {
    signal?.removeEventListener('abort', cancel);
    // A stalled source's cancel hook must not keep the callback alive beyond its deadline.
    cancel(); reader.releaseLock();
  }
}
// RFC 9110 section 5.6.7: accept the three HTTP-date forms, not Date.parse's
// permissive extensions. Normalize obsolete forms to GMT before parsing.
function retryAfterSeconds(header, now = Date.now()) {
  const value = header?.trim();
  if (!value) return NaN;
  if (/^\d+$/u.test(value)) return Number(value);
  let normalized = value;
  const rfc850 = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/u.exec(value);
  const asctime = /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ( \d|\d{2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/u.exec(value);
  if (rfc850) {
    const limit = new Date(now); limit.setUTCFullYear(limit.getUTCFullYear() + 50);
    let year = Math.floor(limit.getUTCFullYear() / 100) * 100 + Number(rfc850[4]);
    const format = () => `${rfc850[1].slice(0, 3)}, ${rfc850[2]} ${rfc850[3]} ${year} ${rfc850[5]} GMT`;
    if (Date.parse(format()) > limit.getTime()) year -= 100;
    normalized = format();
  } else if (asctime) {
    normalized = `${asctime[1]}, ${asctime[3].trim().padStart(2, '0')} ${asctime[2]} ${asctime[5]} ${asctime[4]} GMT`;
  }
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(normalized)) return NaN;
  const leapSecond = normalized.endsWith(':60 GMT');
  const parsed = leapSecond ? normalized.replace(/:60 GMT$/u, ':59 GMT') : normalized;
  const date = Date.parse(parsed);
  // Round-trip rejects impossible dates, times and mismatched weekdays.
  if (new Date(date).toUTCString() !== parsed) return NaN;
  return Math.max(0, Math.ceil((date + (leapSecond ? 1000 : 0) - now) / 1000));
}
async function providerJson(binding, path, { fetchImpl, resolveSecret }, options, maxBytes = 65_536) {
  return voiceOperation(options, async ({ signal }) => {
    const key = await resolveSecret(binding.secretRef);
    if (typeof key !== 'string' || !key) throw new PluginError('auth', 'ElevenLabs credential unavailable');
    signal.throwIfAborted();
    const response = await fetchImpl(`${binding.apiBaseUrl}${path}`, {
      headers: { 'xi-api-key': key }, signal, redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      const error = new PluginError([401, 403].includes(response.status) ? 'auth' : response.status === 429 ? 'rate-limit' : 'provider');
      if (response.status === 429) {
        error.status = 429;
        const header = response.headers.get('retry-after');
        // The browser control accepts delta seconds. Normalize HTTP dates here,
        // retaining the provider wait; the lifecycle owns its existing 60s cap.
        const seconds = retryAfterSeconds(header);
        if (Number.isFinite(seconds) && seconds >= 0) error.retryAfter = String(seconds);
      }
      throw error;
    }
    return readJson(response, maxBytes, { signal });
  });
}

/** Details include the full transcript and telemetry, unlike a small token receipt. */
export async function readConversationDetails(binding, providerSessionId, options = {}, ports = {}) {
  binding = createVoiceBinding(binding);
  if (!identifier(providerSessionId)) throw new TypeError('Invalid provider conversation identity');
  return providerJson(binding, `/v1/convai/conversations/${encodeURIComponent(providerSessionId)}`,
    { fetchImpl: ports.fetchImpl ?? fetch, resolveSecret: ports.resolveSecret ?? (ref => process.env[ref]) }, options, 8_388_608);
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
  // verified by read-only GET 2026-10-09: conversation_id echo,
  // final status and metadata.call_duration_secs/cost (provider credits, not USD).
  const identityMatches = details?.conversation_id === call.providerSessionId;
  const validDuration = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0;
  let usage = null;
  if (identityMatches && validDuration) {
    const start = typeof providerStart === 'number' && Number.isFinite(providerStart) && providerStart > 0 ? providerStart * 1000 : call.startedAt;
    const pausedSeconds = pausedMilliseconds(call.pauses ?? [], start, start + seconds * 1000) / 1000;
    const visitorSeconds = Math.max(0, seconds - pausedSeconds);
    const cost = conversationCost(details.metadata, binding, seconds), upstreamMicro = cost.upstreamMicro;
    const visitorMicro = perMinuteCostMicro(visitorSeconds, binding.visitorMicroPerMinute);
    if ([upstreamMicro, visitorMicro].every(amount)) usage = {
      providerSeconds: seconds, providerMinutes: seconds / 60, pausedSeconds, visitorSeconds, visitorMicro, ...cost,
    };
  }
  const closureConfirmed = identityMatches && ['done', 'failed'].includes(details?.status) && usage !== null;
  return { providerSessionId: call.providerSessionId, outcome: closureConfirmed ? outcome : 'uncertain', closureConfirmed,
    usage, chargedMicro: closureConfirmed ? usage.upstreamMicro : Math.max(maxMicro, amount(call.exposureMicro) ? call.exposureMicro : 0),
    overrun: closureConfirmed && usage.upstreamMicro > maxMicro };
}

/** Private host ports persist call state and acknowledge an atomic engine-wide pause transition. */
export function createElevenLabsServer({ binding, fetchImpl = fetch, resolveSecret = ref => process.env[ref],
  saveCall, prepareCall, requestProviderClose, reconcileLater, now: configuredNow = Date.now, closureTimeoutMs = 30_000,
  closurePollIntervalMs = 250, log } = {}) {
  binding = createVoiceBinding(binding);
  if (typeof saveCall !== 'function' || typeof prepareCall !== 'function' ||
    ![closureTimeoutMs, closurePollIntervalMs].every(value => Number.isFinite(value) && value > 0) ||
    reconcileLater !== undefined && typeof reconcileLater !== 'function' || log !== undefined && typeof log !== 'function') throw new TypeError('Durable saveCall, prepareCall and valid closure options required');
  const provider = { fetchImpl, resolveSecret };
  const adapter = {
    manifest, binding,
    async health(options) {
      return voiceOperation(options, async ({ signal }) => {
        const key = await resolveSecret(binding.secretRef); signal.throwIfAborted();
        return { available: typeof key === 'string' && key.length > 0, reason: key ? undefined : 'credential unavailable' };
      });
    },
    async start(request, options) {
      const now = options.now ?? configuredNow;
      if (!identifier(request?.callId) || typeof request.facadeSecretRef !== 'string' || !request.facadeSecretRef) throw new TypeError('Private call identity and facade secret reference required');
      const invocation = await beginVoiceInvocation(options, request.callId);
      let call = { callId: request.callId, startedAt: now(), pauses: [], paused: false,
        attemptId: options.attempt.attemptId, claimId: options.attempt.claimId, maxMicro: options.attempt.maxMicro,
        spendDeadlineAt: options.spendDeadlineAt, browserLivenessDeadlineAt: options.browserLivenessDeadlineAt,
        exposureMicro: options.attempt.exposureMicro ?? perMinuteCostMicro((options.spendDeadlineAt - now()) / 1000, binding.upstreamMicroPerMinute),
        facadeSecretRef: request.facadeSecretRef };
      const callCancellation = new AbortController();
      let lifetime, rollingTimer, fundedTimer, closing, finished = false, delivered = false, mutation = Promise.resolve();
      const cancelled = () => { void close('cancelled', 'cancelled').catch(() => {}); };
      const serial = fn => { const next = mutation.then(fn); mutation = next.catch(() => {}); return next; };
      const diagnostic = (event, fields) => {
        try { log?.({ event, callHash: createHash('sha256').update(call.callId).digest('hex'),
          ...(call.providerSessionId ? { providerHash: createHash('sha256').update(call.providerSessionId).digest('hex') } : {}), ...fields }); }
        catch { /* Operator diagnostics must never interrupt accounting. */ }
      };
      const close = (reason = 'closed', outcome = 'completed') => {
        if (!['completed', 'cancelled'].includes(outcome)) return Promise.reject(new TypeError('Invalid voice settlement'));
        if (closing) return closing;
        // A browser hangup or host timeout cannot prove billing stopped. Replace
        // the healthy segment with full provider liability before stopping renewal.
        if (delivered) {
          options.attempt.retainExposure?.();
          call = { ...call, maxMicro: Math.max(options.attempt.maxMicro, call.exposureMicro) };
        }
        clearInterval(rollingTimer);
        clearTimeout(fundedTimer);
        lifetime?.dispose();
        options.signal?.removeEventListener('abort', cancelled);
        call = { ...call, closing: true, reason };
        diagnostic('voice-closed', { reason: /^[a-z][a-z0-9-]{0,63}$/u.test(reason) ? reason : 'closed' });
        closing = serial(async () => {
          finished = true;
          const closureStartedAt = Date.now(), closeOptions = { deadlineAt: closureStartedAt + closureTimeoutMs };
          let details, backoffMs = closurePollIntervalMs;
          if (delivered && call.providerSessionId) {
            try { await voiceOperation({ deadlineAt: Date.now() + 1000 }, opts => saveCall(structuredClone(call), opts)); }
            catch { /* Budget exposure is already durable; still request closure and settle exactly once. */ }
            try {
              if (requestProviderClose) await voiceOperation({ deadlineAt: Math.min(closeOptions.deadlineAt, Date.now() + 1000) },
                opts => requestProviderClose(structuredClone(call), opts));
            } catch { /* A failed shutdown request does not invalidate authenticated closure evidence. */ }
            while (Date.now() < closeOptions.deadlineAt) {
              try {
                // START src/pages/api/v2/call-reconcile.ts fetchConversationDetails: GET path/status/metadata.
                details = await readConversationDetails(binding, call.providerSessionId,
                  { deadlineAt: Math.min(closeOptions.deadlineAt, Date.now() + 5000) }, provider);
                const observed = reconcileUsage({ call, details, binding, maxMicro: options.attempt.maxMicro, outcome });
                diagnostic('voice.closure-observed', { status: ['initiated', 'in-progress', 'processing', 'done', 'failed'].includes(details?.status) ? details.status : 'invalid',
                  identityMatches: details?.conversation_id === call.providerSessionId, closureConfirmed: observed.closureConfirmed,
                  costEstimated: observed.usage?.costEstimated === true, elapsedMs: Date.now() - closureStartedAt });
                if (observed.closureConfirmed) break;
              } catch (error) {
                diagnostic('voice.closure-lookup-failed', { code: error instanceof PluginError ? error.code : 'provider',
                  elapsedMs: Date.now() - closureStartedAt });
                // Processing records and transient lookup failures remain retryable.
              }
              const remainingMs = closeOptions.deadlineAt - Date.now();
              if (remainingMs <= 0) break;
              try { await voiceOperation(closeOptions, ({ signal }) => delay(Math.min(backoffMs, remainingMs), undefined, { signal })); }
              catch { break; }
              backoffMs = Math.min(backoffMs * 2, 2000);
            }
          }
          // Minting a credential does not start a billable browser conversation.
          // A failed start never handed it off, even if the provider allocated an id.
          const terminal = delivered ? reconcileUsage({ call, details, binding, maxMicro: options.attempt.maxMicro, outcome })
            : { outcome: 'cancelled', closureConfirmed: true, chargedMicro: 0,
              ...(call.providerSessionId ? { providerSessionId: call.providerSessionId } : {}),
              usage: { providerSeconds: 0, providerMinutes: 0, pausedSeconds: 0, visitorSeconds: 0, upstreamMicro: 0, visitorMicro: 0 } };
          call = { ...call, endedAt: now(), reason, terminal };
          diagnostic(terminal.closureConfirmed && !terminal.usage?.costEstimated ? 'voice.cost-confirmed' : 'voice.closure-pending',
            { closureConfirmed: terminal.closureConfirmed, costEstimated: terminal.usage?.costEstimated === true,
              retainedMicro: terminal.chargedMicro, elapsedMs: Date.now() - closureStartedAt });
          // Even a journal failure must settle the admitted attempt exactly once.
          try { await voiceOperation({ deadlineAt: Date.now() + 1000 }, opts => saveCall(structuredClone(call), opts)); }
          finally {
            try { await invocation.finish(terminal); }
            finally {
              if ((terminal.outcome === 'uncertain' || terminal.usage?.costEstimated) && call.providerSessionId && reconcileLater) {
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
          const spendBound = perMinuteCostMicro((options.spendDeadlineAt - now()) / 1000, binding.upstreamMicroPerMinute);
          if (!amount(spendBound) || !options.attempt.extend && spendBound > options.attempt.maxMicro) throw new PluginError('not-admitted', 'Voice spend deadline exceeds admitted maximum');
          // Host preflight: legacy provisioning, or startup-established static callback authentication.
          await prepareCall(structuredClone(call), opts); opts.signal.throwIfAborted();
          const credential = await mintConversationCredential(binding, request, opts, { ...provider, now });
          opts.signal.throwIfAborted();
          call = { ...call, providerSessionId: credential.providerSessionId };
          await saveCall(structuredClone(call), opts); opts.signal.throwIfAborted();
          call.credential = credential; // Kept in this private closure, never in the journal.
        });
        const credential = call.credential; delete call.credential;
        lifetime = voiceLifetime({ ...call, now, onExpire: reason => close(reason, 'cancelled') });
        options.signal?.addEventListener('abort', cancelled, { once: true });
        if (options.signal?.aborted) cancelled();
        const leaseMs = options.browserLivenessDeadlineAt - now();
        const boundedCommand = commandOptions => ({ now, ...commandOptions,
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
        const session = {
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
        // Authority is consumed before minting; billing begins at credential handoff.
        invocation.dispatch(); delivered = true;
        if (binding.reservationSeconds && options.attempt.extend) {
          // Healthy calls extend only a short priced segment. Closing or recovery
          // retains the full technical exposure until authenticated closure.
          rollingTimer = setInterval(() => {
            void serial(async () => {
              if (closing || finished) return;
              const seconds = Math.min((call.spendDeadlineAt - call.startedAt) / 1000,
                Math.max(0, (now() - call.startedAt) / 1000) + binding.reservationSeconds);
              const extended = options.attempt.extend(seconds);
              call = { ...call, maxMicro: extended.maxMicro };
              await saveCall(structuredClone(call), { deadlineAt: Date.now() + 1000 });
            }).catch(() => {
              if (closing || finished || fundedTimer) return;
              clearInterval(rollingTimer);
              // A refused next segment does not consume the current reservation.
              // Run through its funded end, then close with normal accounting.
              const remainingMs = Math.max(0, call.startedAt + (options.attempt.fundedSeconds ?? 0) * 1000 - now());
              fundedTimer = setTimeout(() => { void close('budget-limit', 'cancelled').catch(() => {}); }, remainingMs);
              fundedTimer.unref?.();
            });
          }, Math.max(10, binding.reservationSeconds * 500));
          rollingTimer.unref?.();
        }
        return session;
      } catch (error) {
        await close('start-failed', 'cancelled');
        throw normalizedError(error, options.signal);
      }
    },
  };
  adapter.ports = Object.freeze({ serverAdapter: Object.freeze({
    ...elevenLabsCallbackPort,
    ...createTextSpeech({ binding, fetchImpl, resolveSecret, readJson }),
    config: binding.adapterConfig,
    validateConfig: createElevenLabsConfig,
    normalizeBinding: normalizeElevenLabsDurationBinding,
    binding: Object.freeze({ endpoint: binding.apiBaseUrl, secretRef: binding.secretRef,
      upstreamMicroPerMinute: binding.upstreamMicroPerMinute, visitorMicroPerMinute: binding.visitorMicroPerMinute,
      reservationSeconds: binding.reservationSeconds }),
    matchesConfig(config) {
      return config?.agentId === binding.adapterConfig.agentId && config.usdPerCredit === binding.adapterConfig.usdPerCredit;
    },
    async startSegment(request, options) {
      const segment = await adapter.start(request, options);
      const receipt = { callId: segment.callId, providerSessionId: segment.providerSessionId,
        credential: segment.credential, spendDeadlineAt: segment.spendDeadlineAt,
        browserLivenessDeadlineAt: segment.browserLivenessDeadlineAt,
        facadeCallId: request.facadeCallId ?? request.callId,
        ...(request.epoch === undefined ? {} : { epoch: request.epoch }),
        ...(segment.overrides ? { overrides: segment.overrides } : {}) };
      try { return { ...segment, grant: elevenLabsMediaGrant(receipt, (options.now ?? configuredNow)()) }; }
      catch (error) { await segment.close('start-failed', 'cancelled'); throw error; }
    },
    stopSegment: (segment, options) => segment.close(options?.reason ?? 'closed', options?.outcome ?? 'completed'),
    async reconciliationEvidence(request, options) {
      const details = await readConversationDetails(binding, request.call.providerSessionId, options, provider);
      return { details, terminal: reconcileUsage({ ...request, details, binding }) };
    },
  }), components: elevenLabsComponents });
  return adapter;
}
