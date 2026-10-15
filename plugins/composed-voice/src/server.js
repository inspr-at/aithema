import { randomUUID } from 'node:crypto';
import { PluginError } from '../../../packages/core/src/invocation.js';
import { beginVoiceInvocation, voiceOperation } from '../../../packages/core/src/live-voice.js';
import { createComposedVoiceCoordinator, callDurationSeconds } from '../../../packages/server/src/composed-voice.js';
import { createComposedRelay } from './relay.js';
import { configureComposedComponents } from './configuration.js';
import { manifest } from './manifest.js';
import { createComposedRelayRoute } from './network-relay.js';

/** Explicit opt-in factory. Inject separately admitted components and the existing
 * Rule C reply executor; default hosts continue to construct ElevenLabs. */
export function createComposedVoice({ enabled = false, config = {}, binding, storage, stt, tts, replyExecutor,
  admitComponent, authorize, commitUtterance, componentOptions, consent, reasoningBinding, authenticateRelay, relayOrigin, now = Date.now } = {}) {
  let selected;
  if (config.stt !== undefined || config.tts !== undefined) {
    selected = configureComposedComponents({ enabled, config, componentOptions, consent, reasoningBinding, authorize });
    ({ stt, tts, authorize } = selected);
  }
  const relays = new Map();
  const relayOwners = new Map();
  const ownerAllowed = async (grant, owner) => {
    const bound = relayOwners.get(grant?.providerSessionId);
    if (!enabled || !bound || bound.owner !== owner) return false;
    try {
      await storage.authorize(bound.sessionId, owner);
      return await authorize({ sessionId: bound.sessionId, callId: grant.callId, providerSessionId: grant.providerSessionId },
        { deadlineAt: now() + 5000 }) === true;
    } catch { return false; }
  };
  const networkRelay = authenticateRelay ? createComposedRelayRoute({ authenticate: authenticateRelay, origin: relayOrigin, now,
    authorize: ownerAllowed, async connect(grant, owner) {
      if (!await ownerAllowed(grant, owner)) throw new PluginError('not-admitted');
      const relay = relays.get(grant?.providerSessionId);
      if (!relay) throw new PluginError('not-admitted');
      return relay.connect(grant);
    } }) : null;
  const validateConfig = raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['host', 'maxDurationSeconds', 'voice', 'stt', 'tts'].includes(key))) throw new TypeError('Invalid composed configuration');
    callDurationSeconds(raw); return Object.freeze(structuredClone(raw));
  };
  config = validateConfig(config);
  async function start(request, options) {
    if (!enabled) throw new PluginError('unavailable');
    if (!storage?.saveVoiceCall || typeof authorize !== 'function' || typeof commitUtterance !== 'function' || options.attempt?.maxMicro !== 0) throw new PluginError('not-admitted', 'Parent claim must carry zero component cost');
    const invocation = await beginVoiceInvocation(options, request.callId);
    const providerSessionId = `composed-${randomUUID()}`, epoch = request.epoch ?? 0;
    const end = Math.min(options.spendDeadlineAt, now() + callDurationSeconds(config) * 1000);
    const relay = createComposedRelay({ callId: request.callId, providerSessionId, epoch,
      expiresAt: Math.min(end, options.browserLivenessDeadlineAt, now() + 60_000),
      spendDeadlineAt: end, browserLivenessDeadlineAt: options.browserLivenessDeadlineAt, now });
    const coordinator = createComposedVoiceCoordinator({ ...config, ...request, providerSessionId, epoch,
      spendDeadlineAt: end, browserLivenessDeadlineAt: options.browserLivenessDeadlineAt,
      stt, tts, ...(selected ? { outputFormat: selected.outputFormat, outputAudioFormat: selected.outputAudioFormat } :
        tts?.format ? { outputFormat: tts.format.encoding, outputAudioFormat: tts.format } : {}), replyExecutor, admitComponent, authorize, commitUtterance, relay, now });
    let record = { ...coordinator.snapshot(), attemptId: options.attempt.attemptId, claimId: options.attempt.claimId,
      maxMicro: 0, exposureMicro: 0, pauses: [] }, closing, mutations = Promise.resolve(), holdRevision = 0;
    const serial = action => { const job = mutations.then(action); mutations = job.catch(() => {}); return job; };
    const save = (next, opts) => storage.saveVoiceCall(request.sessionId, next, { ...opts, guard: { ...opts?.guard, ownerToken: request.ownerToken } });
    function terminal(outcome = 'completed') {
      const providerSeconds = Math.max(0, now() - record.startedAt) / 1000;
      const pausedSeconds = Math.min(providerSeconds, record.pauses.reduce((sum, pause) => sum + Math.max(0, (pause.to ?? now()) - pause.from) / 1000, 0));
      return { providerSessionId, outcome, closureConfirmed: true, chargedMicro: 0,
        usage: { providerSeconds, providerMinutes: providerSeconds / 60, pausedSeconds, visitorSeconds: providerSeconds - pausedSeconds,
          upstreamMicro: 0, visitorMicro: 0, costSource: 'separate-component-claims', costEstimated: false } };
    }
    function close(reason = 'closed', outcome = 'completed') {
      if (closing) return closing;
      const flight = Promise.withResolvers(); closing = flight.promise;
      coordinator.signal.removeEventListener('abort', cancel);
      void coordinator.close(reason); relay.close(); relays.delete(providerSessionId); relayOwners.delete(providerSessionId); networkRelay?.revoke(providerSessionId);
      options.signal?.removeEventListener('abort', cancel);
      const result = terminal(outcome); record = { ...record, endedAt: now(), reason, terminal: result };
      void Promise.resolve().then(async () => {
        try { await voiceOperation({ deadlineAt: Date.now() + 1000 }, opts => save(record, opts)); }
        finally { await invocation.finish(result); }
        return result;
      }).then(flight.resolve, flight.reject); return closing;
    }
    const cancel = () => { void close('cancelled', 'cancelled').catch(() => {}); };
    coordinator.signal.addEventListener('abort', cancel, { once: true });
    function hold(paused, opts) {
      if (closing) return Promise.reject(new PluginError('unavailable'));
      if (paused) holdRevision++;
      const physicalHold = paused ? coordinator.pause() : Promise.resolve();
      if (paused) networkRelay?.revoke(providerSessionId);
      physicalHold.catch(() => {});
      const revision = holdRevision;
      return serial(async () => {
        if (closing) throw new PluginError('unavailable');
        await physicalHold;
        const next = { ...record, ...coordinator.snapshot(), paused };
        next.pauses = structuredClone(record.pauses);
        if (record.paused !== paused) {
          if (paused) next.pauses.push({ from: now(), to: null }); else if (next.pauses.length) next.pauses.at(-1).to = now();
        }
        const ack = await voiceOperation(opts, command => save(next, { ...command, paused }));
        if (ack?.acknowledged !== true || ack.paused !== paused) throw new PluginError('invalid-output');
        if (!paused) {
          if (revision !== holdRevision) throw new PluginError('cancelled', 'Resume superseded by a hold');
          await coordinator.resume();
        }
        record = next; return { acknowledged: true, paused };
      });
    }
    const segment = { ...coordinator, signal: coordinator.signal, providerSessionId, grant: relay.grant,
      spendDeadlineAt: end, browserLivenessDeadlineAt: record.browserLivenessDeadlineAt, close,
      snapshot: () => structuredClone({ ...record, ...coordinator.snapshot() }),
      pause: opts => hold(true, opts), resume: opts => hold(false, opts),
      heartbeat: async opts => {
        const ack = await coordinator.heartbeat(opts); record = { ...record, ...coordinator.snapshot() };
        await voiceOperation(opts, command => save(record, command)); return ack;
      } };
    try {
      await voiceOperation(options, command => save(record, command));
      invocation.dispatch(); options.signal?.addEventListener('abort', cancel, { once: true });
      options.signal?.throwIfAborted();
      // All browser commands go through the same durable pause/resume/lease methods.
      relay.attach(segment); relays.set(providerSessionId, relay);
      relayOwners.set(providerSessionId, { owner: request.ownerToken, sessionId: request.sessionId }); return segment;
    } catch (error) { await close('start-failed', 'cancelled'); throw error; }
  }
  const serverAdapter = Object.freeze({ config, binding,
    validateConfig, matchesConfig: raw => JSON.stringify(validateConfig(raw)) === JSON.stringify(config),
    startSegment: start,
    stopSegment: (segment, options) => segment.close(options?.reason ?? 'closed', options?.outcome ?? 'completed'),
    async reconciliationEvidence({ call }) {
      return { details: { componentClaims: 'settled-independently' }, terminal: call.terminal ?? {
        providerSessionId: call.providerSessionId, outcome: 'uncertain', closureConfirmed: false, chargedMicro: 0, usage: null } };
    } });
  return Object.freeze({ manifest, start, networkRelay, ports: { serverAdapter, replyExecutor, components: { stt, tts } },
    health: async () => ({ available: enabled, reason: 'offline-unqualified' }),
    connectRelay: grant => {
      const relay = relays.get(grant?.providerSessionId);
      if (!relay) throw new PluginError('not-admitted'); return relay.connect(grant);
    } });
}
