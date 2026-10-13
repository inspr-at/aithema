import { PluginError } from '../../../packages/core/src/invocation.js';
import { beginVoiceInvocation, voiceOperation, voiceLifetime } from '../../../packages/core/src/live-voice.js';
import { manifest, fakeMediaGrant } from './manifest.js';

const config = Object.freeze({});
export const localVoiceBinding = Object.freeze({ plugin: 'fake-voice', model: 'local-agent', adapterConfig: config,
  effort: 'none', endpoint: 'https://example.test', accountRef: 'local-demo', secretRef: 'local-only',
  maxMicro: 0, maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds: 3600,
  upstreamMicroPerMinute: 0, visitorMicroPerMinute: 0 });
const localStarts = new WeakSet();
export const isLocalVoice = plugin => localStarts.has(plugin?.start);

function terminal(call, at, outcome = 'completed') {
  const end = call.endedAt ?? at, providerSeconds = Math.max(0, end - call.startedAt) / 1000;
  const pausedSeconds = Math.min(providerSeconds, call.pauses.reduce((sum, pause) =>
    sum + Math.max(0, Math.min(end, pause.to ?? end) - pause.from) / 1000, 0));
  return { providerSessionId: call.providerSessionId, outcome, closureConfirmed: true, chargedMicro: 0, overrun: false,
    usage: { providerSeconds, providerMinutes: providerSeconds / 60, pausedSeconds,
      visitorSeconds: Math.max(0, providerSeconds - pausedSeconds), upstreamMicro: 0, visitorMicro: 0 } };
}

/** Admission, durable holds and leases without credentials, HTTP or callbacks. */
export function createLocalVoiceProvider({ storage, now = Date.now }) {
  if (typeof storage?.saveVoiceCall !== 'function') throw new TypeError('Durable voice storage required');
  const start = async (request, options) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(request?.callId ?? '')) throw new TypeError('Call identity required');
    const invocation = await beginVoiceInvocation(options, request.callId), cancellation = new AbortController();
    let call = { callId: request.callId, providerSessionId: 'fake-' + crypto.randomUUID(), startedAt: now(),
      pauses: [], paused: false, attemptId: options.attempt.attemptId, claimId: options.attempt.claimId,
      maxMicro: options.attempt.maxMicro, exposureMicro: 0, spendDeadlineAt: options.spendDeadlineAt,
      browserLivenessDeadlineAt: options.browserLivenessDeadlineAt,
      ...(Number.isSafeInteger(request.settingsRevision) ? { settingsRevision: request.settingsRevision } : {}) };
    let closing, lifetime, mutations = Promise.resolve();
    const serial = fn => { const pending = mutations.then(fn); mutations = pending.catch(() => {}); return pending; };
    const save = (record, opts) => storage.saveVoiceCall(request.sessionId, structuredClone(record),
      { ...opts, guard: { ...opts?.guard, ownerToken: request.ownerToken } });
    const close = (reason = 'closed', outcome = 'completed') => {
      if (closing) return closing;
      if (!['completed', 'cancelled'].includes(outcome)) return Promise.reject(new TypeError('Invalid settlement'));
      lifetime?.dispose(); options.signal?.removeEventListener('abort', cancel);
      call = { ...call, closing: true, reason, endedAt: now() };
      closing = serial(async () => {
        const result = terminal(call, now(), outcome); call = { ...call, terminal: result };
        try { await voiceOperation({ deadlineAt: Date.now() + 1000 }, opts => save(call, opts)); }
        finally { await invocation.finish(result); }
        return result;
      });
      cancellation.abort(); return closing;
    };
    const cancel = () => { void close('cancelled', 'cancelled').catch(() => {}); };
    const bounded = opts => ({ ...opts, signal: opts?.signal ? AbortSignal.any([opts.signal, cancellation.signal]) : cancellation.signal,
      deadlineAt: Math.min(opts?.deadlineAt ?? Infinity, call.spendDeadlineAt, call.browserLivenessDeadlineAt) });
    const pause = (paused, opts) => serial(() => voiceOperation(bounded(opts), async command => {
      if (closing) throw new PluginError('unavailable');
      const next = structuredClone(call);
      if (next.paused !== paused) {
        if (paused) next.pauses.push({ from: now(), to: null }); else next.pauses.at(-1).to = now();
      }
      next.paused = paused;
      const ack = await save(next, { ...command, paused }); command.signal.throwIfAborted();
      if (ack?.acknowledged !== true || ack.paused !== paused) throw new PluginError('invalid-output', 'Pause not acknowledged');
      call = next; return { acknowledged: true, paused };
    }));
    try {
      await voiceOperation(options, async opts => {
        if (![call.spendDeadlineAt, call.browserLivenessDeadlineAt].every(at => Number.isFinite(at) && at > now())) throw new PluginError('deadline');
        await save(call, opts); opts.signal.throwIfAborted();
      });
      invocation.dispatch();
      lifetime = voiceLifetime({ ...call, now, onExpire: reason => close(reason, 'cancelled') });
      options.signal?.addEventListener('abort', cancel, { once: true });
      const leaseMs = call.browserLivenessDeadlineAt - now();
      return { callId: call.callId, providerSessionId: call.providerSessionId, signal: cancellation.signal,
        spendDeadlineAt: call.spendDeadlineAt, browserLivenessDeadlineAt: call.browserLivenessDeadlineAt,
        snapshot: () => structuredClone(call), close,
        pause: opts => pause(true, opts), resume: opts => pause(false, opts),
        heartbeat: opts => serial(() => voiceOperation(bounded(opts), async command => {
          const next = { ...call, browserLivenessDeadlineAt: Math.min(now() + leaseMs, call.spendDeadlineAt) };
          await save(next, command); command.signal.throwIfAborted();
          lifetime.heartbeat(next.browserLivenessDeadlineAt); call = next;
          return { acknowledged: true, browserLivenessDeadlineAt: call.browserLivenessDeadlineAt };
        })),
      };
    } catch (error) { await close('start-failed', 'cancelled'); throw error; }
  };
  const serverAdapter = Object.freeze({ config, binding: Object.freeze({ endpoint: localVoiceBinding.endpoint,
    secretRef: localVoiceBinding.secretRef, upstreamMicroPerMinute: 0, visitorMicroPerMinute: 0 }),
    validateConfig(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new TypeError('Invalid simulator configuration');
      return config;
    },
    matchesConfig: value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0,
    async startSegment(request, options) {
      const segment = await start(request, options);
      return { ...segment, grant: fakeMediaGrant({ callId: segment.callId, providerSessionId: segment.providerSessionId,
        spendDeadlineAt: segment.spendDeadlineAt, browserLivenessDeadlineAt: segment.browserLivenessDeadlineAt,
        ...(request.epoch === undefined ? {} : { epoch: request.epoch }) }, now()) };
    },
    stopSegment: (segment, options) => segment.close(options?.reason ?? 'closed', options?.outcome ?? 'completed'),
    async reconciliationEvidence(request, options) {
      return voiceOperation(options, async () => ({ details: { simulated: true }, terminal: terminal(request.call, now(), request.outcome) }));
    },
  });
  const plugin = { manifest, health: options => voiceOperation(options, async () => ({ available: true })),
    start, ports: Object.freeze({ serverAdapter }) };
  localStarts.add(start); return plugin;
}
