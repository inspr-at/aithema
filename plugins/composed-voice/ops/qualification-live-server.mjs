import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createBinding, consentCoverage, processingScope, deepFreeze, collectPurposeReply, stripThanksOpener } from '@inspr/aithema-core';
import { PluginError } from '@inspr/aithema-core/invocation';
import { generationId } from '@inspr/aithema-core/cost';
import { createVoiceReplyExecutor, createVoiceTurnOperations } from '@inspr/aithema-server';
import { createOpenRouterReasoning } from '@inspr/aithema-plugin-openrouter';
import { createElevenLabsSTT, createElevenLabsTTS, TTS_FORMAT } from '../../elevenlabs/src/components.js';
import { validateVoiceSettings, VOICE_SETTING_KEYS } from '../../elevenlabs/src/voice-settings.js';
import { createComposedVoice } from '../src/server.js';
import { normalizeQualificationEntity } from '../src/qualification.js';
import { QualificationSampleFailure } from '../src/qualification-failure.js';
import { loopbackOrigin } from './qualification-server.mjs';
import { connectQualificationSocket } from './qualification-live-transport.mjs';
import { baselineOrigin, baselineAttemptCeiling } from './qualification-production-baseline.mjs';

// Source: qualification-server.mjs bounds sample PCM to 16 MB and sample life
// to two minutes. The relay's 60 s connection grant is separate from paid life.
export const MAX_SAMPLE_PCM_BYTES = 16_000_000;
export const MAX_SAMPLE_SECONDS = 120;
// Explicit operator choice, bounded to one initial attempt plus one retry.
export const MAX_REASONING_ATTEMPTS = 2;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const amount = value => Number.isSafeInteger(value) && value >= 0;
const invalidBinding = () => { throw new TypeError('Explicit valid qualification binding required'); };

/** No model, voice, tariff, account or paid duration default. No secrets here. */
export function validateQualificationBinding(raw) {
  try {
    const b = structuredClone(raw);
    if (b && b.reasoningAttempts === undefined) b.reasoningAttempts = 1;
    if (!b || Object.keys(b).some(key => !['stt', 'tts', 'reasoning', 'baseline', 'baselineOrigin', 'baselineAuthFile', 'baselineReasoningCeilingMicro', 'maxDurationSeconds', 'reasoningAttempts'].includes(key)) ||
      !Number.isSafeInteger(b.maxDurationSeconds) || b.maxDurationSeconds < 1 || b.maxDurationSeconds > MAX_SAMPLE_SECONDS ||
      !Number.isSafeInteger(b.reasoningAttempts) || b.reasoningAttempts < 1 || b.reasoningAttempts > MAX_REASONING_ATTEMPTS) invalidBinding();
    baselineOrigin(b.baselineOrigin);
    if (b.baselineAuthFile !== undefined && !isAbsolute(b.baselineAuthFile)) invalidBinding();
    for (const [role, operation] of [['stt', 'stream'], ['tts', 'speak'], ['reasoning', 'stream'], ['baseline', 'start']]) {
      const part = b[role], reasoning = role === 'reasoning';
      if (!part || part.plugin !== (reasoning ? 'openrouter' : 'elevenlabs') ||
        part.secretRef !== (reasoning ? 'OPENROUTER_API_KEY' : 'ELEVENLABS_API_KEY') ||
        typeof part.accountRef !== 'string' || !part.accountRef.trim() ||
        part.endpoint !== (reasoning ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.elevenlabs.io') ||
        part.legal?.purpose !== (reasoning ? 'models-international' : 'voice-elevenlabs') || part.legal.consentVersion !== 1) invalidBinding();
      if (typeof part.legal.recipient !== 'string' || !part.legal.recipient.trim() ||
        !Array.isArray(part.legal.processors) || part.legal.processors.some(value => typeof value !== 'string' || !value) ||
        !Array.isArray(part.legal.dataCategories) || !part.legal.dataCategories.length || part.legal.dataCategories.some(value => typeof value !== 'string' || !value)) invalidBinding();
      const common = ['plugin', 'model', 'effort', 'endpoint', 'routing', 'accountRef', 'secretRef', 'legal'];
      const extra = role === 'stt' ? ['microPerSecond'] : role === 'tts' ? ['voiceId', 'voiceSettings', 'microPerCharacter']
        : role === 'baseline' ? ['agentId', 'microPerMinute', 'tts'] : ['maxMicro', 'maxTokens', 'maxInputTokens', 'rates'];
      if (Object.keys(part).some(key => ![...common, ...extra].includes(key))) invalidBinding();
      processingScope(part, operation);
    }
    if (b.stt.model !== 'scribe_v2_realtime' || !amount(b.stt.microPerSecond) ||
      b.tts.model !== 'eleven_flash_v2_5' || !id(b.tts.voiceId) || !amount(b.tts.microPerCharacter) ||
      !id(b.baseline.agentId) || b.baseline.model !== b.baseline.agentId || !amount(b.baseline.microPerMinute) ||
      !b.reasoning.model?.includes('/') || b.reasoning.effort !== 'none' || !amount(b.reasoning.maxMicro) ||
      !Number.isSafeInteger(b.reasoning.maxTokens) || b.reasoning.maxTokens < 1 ||
      !Number.isSafeInteger(b.reasoning.maxInputTokens) || b.reasoning.maxInputTokens < 1 ||
      ![b.reasoning.rates?.inputMicro, b.reasoning.rates?.outputMicro].every(amount)) invalidBinding();
    b.tts.voiceSettings = validateVoiceSettings(b.tts.voiceSettings);
    const baselineTTS = b.baseline.tts;
    if (!baselineTTS || Object.keys(baselineTTS).some(key => !['model', 'voiceId', 'voiceSettings'].includes(key)) ||
      !id(baselineTTS.model) || baselineTTS.voiceId !== b.tts.voiceId) invalidBinding();
    baselineTTS.voiceSettings = validateVoiceSettings(baselineTTS.voiceSettings);
    if (VOICE_SETTING_KEYS.some(key => baselineTTS.voiceSettings[key] !== b.tts.voiceSettings[key])) invalidBinding();
    // Existing OpenRouter binding validation, including routing/effort/ceilings.
    createBinding(b.reasoning);
    for (const value of [b.stt.microPerSecond * MAX_SAMPLE_SECONDS, b.tts.microPerCharacter * 242,
      baselineAttemptCeiling(b)]) if (!amount(value)) invalidBinding();
    return deepFreeze(b);
  } catch { return invalidBinding(); }
}

export async function loadQualificationBinding(path) {
  if (!isAbsolute(path ?? '')) invalidBinding();
  try { return validateQualificationBinding(JSON.parse(await readFile(path, 'utf8'))); }
  catch { return invalidBinding(); }
}
export function qualificationProcessingBindings(binding) {
  return ['stt', 'tts', 'reasoning', 'baseline'].map(role => binding[role]);
}
export function qualificationProcessingOperations(binding) {
  return binding.plugin === 'claude-html' ? ['generate', 'edit'] : binding.plugin === 'elevenlabs' && binding.model === 'scribe_v2_realtime' ? ['stream']
    : binding.plugin === 'elevenlabs' && binding.model === 'eleven_flash_v2_5' ? ['speak']
      : binding.plugin === 'elevenlabs' ? ['start'] : ['stream', 'structured'];
}

export function matchQualificationEntities(hypothesis, expected) {
  const text = normalizeQualificationEntity(hypothesis);
  return expected.map(value => {
    const needle = normalizeQualificationEntity(value);
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const found = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(text);
    return { expected: value, actual: found ? needle : '' };
  });
}

/** Source-only reference wiring. Inject transports only for hermetic wire tests.
 * keys stays inside the provider resolver; never enters specs, grants or records. */
export function createQualificationServer({ relayOrigin, authenticateRelay, storage, handlers, keys, binding: raw,
  transports = { connect: connectQualificationSocket, fetch: globalThis.fetch } } = {}) {
  const binding = validateQualificationBinding(raw);
  loopbackOrigin(relayOrigin);
  if (!keys || !Object.isFrozen(keys) || !['ELEVENLABS_API_KEY', 'OPENROUTER_API_KEY'].every(name =>
    typeof keys[name] === 'string' && keys[name] && !/[\r\n]/u.test(keys[name])) ||
    ![authenticateRelay, storage?.authorize, handlers?.consent?.coverage, handlers?.buildVoiceReplyRequest, transports.connect, transports.fetch].every(fn => typeof fn === 'function')) {
    throw new TypeError('Frozen file-only keys and authoritative qualification server ports required');
  }
  const resolveSecret = ref => keys[ref];
  let active, starting = false;
  const networkRelay = {
    handle: request => active?.networkRelay?.handle(request) ?? new Response(null, { status: 403 }),
    revoke: providerSessionId => active?.networkRelay?.revoke(providerSessionId),
    async close() { await active?.close(); },
  };
  return {
    networkRelay,
    // Called by the host before acknowledging a consent/hold/erasure mutation.
    async revokeSession(sessionId) { if (active?.sessionId === sessionId) await active.close(); },
    async createSample({ item, lane, runId, owner, signal, admit, measurementTerminal = () => false }) {
      if (active || starting) throw new PluginError('not-admitted');
      if (lane !== 'candidate') throw new PluginError('not-admitted', 'Baseline requires its production origin browser');
      if (!id(item?.id) || !id(item.sessionId) || !id(runId) ||
        !Array.isArray(item.expectedEntities) || !item.expectedEntities.length ||
        item.expectedEntities.some(value => typeof value !== 'string' || !value.trim() || value.length > 32_768) || typeof admit !== 'function') {
        throw new TypeError('Session, sample identity and expected entities required');
      }
      starting = true;
      const sessionId = item.sessionId, cancellation = new AbortController();
      const sampleSignal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
      const deadlineAt = Date.now() + binding.maxDurationSeconds * 1000, rows = [], jobs = new Set();
      const answer = Promise.withResolvers(), setup = Promise.withResolvers(); answer.promise.catch(() => {});
      let sample, closing, expiry, hypothesis, pcmBytes = 0;
      const chunks = []; let revision;
      const relevant = ['stt', 'tts', 'reasoning'];
      const authorize = async () => {
        sampleSignal.throwIfAborted();
        const session = storage.authorize(sessionId, owner), lifecycle = storage.voiceLifecycle(sessionId);
        if (Date.now() >= deadlineAt || session.consentWithdrawn || session.paused || session.consentRevision !== revision ||
          lifecycle?.holds?.length || storage.voiceCalls(sessionId).some(call => !call.terminal && call.paused)) throw new PluginError('not-admitted');
        for (const role of relevant) if (!await consentCoverage(handlers.consent, session,
          processingScope(binding[role], role === 'tts' ? 'speak' : 'stream'),
          { signal: sampleSignal, deadlineAt })) throw new PluginError('not-admitted');
        const current = storage.authorize(sessionId, owner);
        if (current.paused || current.consentWithdrawn || current.consentRevision !== revision) throw new PluginError('not-admitted');
        return true;
      };
      function capture(bytes) {
        pcmBytes += bytes.byteLength;
        if (pcmBytes > MAX_SAMPLE_PCM_BYTES) {
          const error = new QualificationSampleFailure('pcm-bound');
          answer.reject(error); throw error;
        }
        chunks.push(Uint8Array.from(bytes));
      }
      const track = promise => { jobs.add(promise); promise.finally(() => jobs.delete(promise)).catch(() => {}); return promise; };
      async function admission(role, request, maxMicro, retryOf) {
        await authorize();
        const part = binding[role];
        const spec = { attemptId: `qualification-${randomUUID()}`, lane, role,
          provider: part.plugin, model: part.model, operation: role === 'tts' ? 'speak' : 'stream',
          accountRef: part.accountRef, endpoint: part.endpoint, maxMicro, request, ...(retryOf ? { retryOf } : {}) };
        const granted = await admit(spec);
        // The mount's terminal fence is an ordinary no-spend admission refusal.
        if (granted.refused === 'sample-complete') throw new PluginError('not-admitted', 'Qualification sample complete');
        const row = { attemptId: spec.attemptId, consumed: false }; rows.push(row);
        const report = terminal => {
          // A terminal measurement cannot release a reservation that raced its
          // fence. Keep undispatched exposure for explicit OPS reconciliation.
          if (!row.consumed && measurementTerminal()) return;
          if (row.reporting) throw new PluginError('already-claimed');
          const generation = role === 'reasoning' ? generationId(terminal.generationId) : null;
          const identity = role === 'reasoning' ? generation ? { generationId: generation } : null : terminal.identity ?? null;
          // Tariff estimates/stream usage never substitute for OPS receipts.
          row.reporting = track(Promise.resolve().then(() => granted.report({ attemptId: spec.attemptId,
            outcome: row.consumed ? 'uncertain' : 'cancelled',
            ...(!row.consumed ? { chargedMicro: 0 } : {}),
            ...(generation ? { generationId: generation } : {}), identity,
            ...(identity === null ? { identityReason: terminal.identityReason ?? 'provider-identity-not-observed' } : {}),
            ...(terminal.servedModel ? { servedModel: terminal.servedModel } : {}),
            ...(role === 'tts' && terminal.matchingKey ? { matchingKey: terminal.matchingKey } : {}) })).catch(() => {
              const error = new QualificationSampleFailure('report-rejected');
              answer.reject(error); throw error;
            }));
          return row.reporting;
        };
        const attempt = { attemptId: spec.attemptId, claimId: granted.attempt.claimId, maxMicro,
          async consume() { await authorize(); await granted.attempt.consume(); row.consumed = true; } };
        row.finish = () => row.reporting ?? report({});
        return { attempt, report, signal: sampleSignal, deadlineAt, finish: row.finish };
      }
      async function close() {
        if (closing) return closing;
        const done = Promise.withResolvers(); closing = done.promise;
        clearTimeout(expiry); cancellation.abort();
        void (async () => {
          try {
            await setup.promise;
            await sample?.close();
            await Promise.allSettled([...jobs]);
            await Promise.all(rows.map(row => row.finish()));
          } catch (error) {
            const failure = error instanceof QualificationSampleFailure ? error : new QualificationSampleFailure('stop-failed');
            answer.reject(failure); throw failure;
          }
          if (!hypothesis) answer.reject(new QualificationSampleFailure('missing-transcript'));
          else if (!pcmBytes) answer.reject(new QualificationSampleFailure('missing-audio'));
          else answer.resolve({ hypothesis, entities: matchQualificationEntities(hypothesis, item.expectedEntities),
            ttsPCM: Uint8Array.from(Buffer.concat(chunks)), ttsFormat: sample.format,
            ttsConfig: { model: binding.tts.model, voiceId: binding.tts.voiceId, voiceSettings: binding.tts.voiceSettings } });
        })().then(() => {
          if (active?.close === close) active = undefined;
          done.resolve();
        }, done.reject);
        return closing;
      }
      const aborted = () => { void close().catch(() => {}); };
      expiry = setTimeout(aborted, Math.max(0, deadlineAt - Date.now()));
      active = { sessionId, close };
      try {
        revision = storage.authorize(sessionId, owner).consentRevision;
        await authorize();
        const ports = { binding, storage, sessionId, owner, deadlineAt, signal: sampleSignal, authorize, admission,
          buildVoiceReplyRequest: handlers.buildVoiceReplyRequest,
          relayOrigin, authenticateRelay, consent: handlers.consent, connect: transports.connect, fetchImpl: transports.fetch, resolveSecret, capture,
          transcript(text) { hypothesis ??= text; }, track };
        sample = await startCandidateSample(ports);
        sampleSignal.throwIfAborted();
        active.networkRelay = sample.networkRelay;
        setup.resolve();
        signal?.addEventListener('abort', aborted, { once: true });
        // Browser close comes through the attached segment, so it must also
        // drain reports/results, before the control mount sees completion.
        sample.onClose(close);
        return { grant: sample.grant, result: answer.promise, async close() {
          signal?.removeEventListener('abort', aborted); await close();
        } };
      } catch {
        setup.resolve(); await close(); throw new PluginError('not-admitted', 'Qualification setup refused');
      } finally { starting = false; }
    },
  };
}

async function startCandidateSample(p) {
  const { binding, storage, sessionId, owner, signal, deadlineAt, authorize, admission, resolveSecret, capture, track } = p;
  const turns = createVoiceTurnOperations({ storage });
  const prices = { [binding.reasoning.model]: { prompt: binding.reasoning.rates.inputMicro / 1e6,
    completion: binding.reasoning.rates.outputMicro / 1e6 } };
  const reasoning = createOpenRouterReasoning({ binding: binding.reasoning, resolveSecret, prices,
    fetchImpl: async (...args) => { await authorize(); return p.fetchImpl(...args); } });
  const replyExecutor = createVoiceReplyExecutor({ execute(envelope, options) {
    return turns.run(envelope.payload, worker => {
      const { callId, providerSessionId, callbackBody } = envelope.payload;
      const request = p.buildVoiceReplyRequest(storage.authorize(sessionId, owner), callbackBody.messages, { callId, providerSessionId });
      if (!request.purposePolicy) throw new PluginError('not-admitted', 'Production purpose policy required');
      const replyId = `chatcmpl-${randomUUID()}`;
      return { replyId, created: Math.floor(Date.now() / 1000), events: (async function* () {
        let attempts = 0, retryOf, admitted = false;
        async function* invoke(input) {
          if (attempts >= binding.reasoningAttempts) throw new PluginError('invalid-output');
          for (;;) {
            let text = '';
            worker.beforeAdmission();
            const opts = await admission('reasoning', reasoning.streamRequest(input), reasoning.estimateUncertainCost(input, 'stream'), retryOf);
            attempts++;
            if (retryOf) worker.retry('qualification-retry');
            const originalConsume = opts.attempt.consume;
            opts.attempt.consume = async () => {
              worker.beforeAdmission(); await originalConsume();
              if (!admitted) { worker.admitted(opts.attempt.attemptId); admitted = true; }
            };
            try {
              for await (const delta of reasoning.stream(input, { ...options, ...opts,
                signal: AbortSignal.any([signal, worker.signal]) })) {
                text += delta; yield delta;
              }
              retryOf = opts.attempt.attemptId; return;
            } catch (error) {
              await opts.finish();
              if (text || signal.aborted || !['provider', 'rate-limit'].includes(error.code) || attempts >= binding.reasoningAttempts) throw error;
              retryOf = opts.attempt.attemptId;
            }
          }
        }
        // Production's purpose policy requests JSON. Buffer and validate it
        // through the same decoder before any text can reach candidate TTS.
        const safe = await collectPurposeReply(request, invoke, { guardDirection: reply => storage.guardPurposeDirection(sessionId, reply,
          request.purposePolicy, request.safeguardRevision ? undefined : JSON.stringify(['voice', callId, callbackBody.messages.filter(m => m.role === 'user').length])) });
        const text = stripThanksOpener(safe.content, request.locale).text;
        await authorize();
        storage.postVoiceEvent(sessionId, callId, providerSessionId, { type: 'final', role: 'assistant', callId,
          turnId: `${providerSessionId}:${replyId}`, text }, { ownerToken: owner, replyId, userTurnOrdinal: worker.ordinal,
          model: binding.reasoning.model, provider: binding.reasoning.plugin, provenance: 'facade-produced' });
        yield { type: 'delta', text };
        yield { type: 'completion', text };
      })() };
    }, options);
  } });
  const component = role => {
    const part = binding[role];
    return { enabled: true, config: { secretRef: part.secretRef, voiceId: binding.tts.voiceId, voiceSettings: binding.tts.voiceSettings,
      sttMicroPerSecond: binding.stt.microPerSecond, ttsMicroPerCharacter: binding.tts.microPerCharacter },
      consent: { session: storage.get(sessionId), binding: part, port: p.consent }, resolveSecret,
      connect: async request => { await authorize(); return p.connect(request); } };
  };
  const stt = createElevenLabsSTT(component('stt')), realTTS = createElevenLabsTTS(component('tts'));
  const tts = { ...realTTS, async *speak(request, options) {
    for await (const bytes of realTTS.speak(request, options)) { capture(bytes); yield bytes; }
  } };
  const factory = createComposedVoice({ enabled: true, storage, relayOrigin: p.relayOrigin, authenticateRelay: p.authenticateRelay,
    config: { maxDurationSeconds: binding.maxDurationSeconds, voice: binding.tts.voiceId }, stt, tts, replyExecutor, authorize,
    commitUtterance: async envelope => {
      await authorize();
      const { callId, providerSessionId, callbackBody } = envelope.payload, text = callbackBody.messages.at(-1).content;
      storage.postVoiceEvent(sessionId, callId, providerSessionId, { type: 'final', role: 'user', callId,
        turnId: `${providerSessionId}:${callbackBody.metadata.utteranceId}`, text, userTurnOrdinal: callbackBody.metadata.sequence }, { ownerToken: owner });
      p.transcript(text);
    },
    admitComponent: async ({ role, request, signal: componentSignal }) => ({
      ...await admission(role, request, (role === 'stt' ? stt : tts).estimateCost(request)), signal: componentSignal,
    }) });
  const segment = await factory.start({ sessionId, ownerToken: owner, callId: `qualification-${randomUUID()}` },
    { signal, deadlineAt, spendDeadlineAt: deadlineAt, browserLivenessDeadlineAt: deadlineAt,
      attempt: { attemptId: `parent-${randomUUID()}`, claimId: 'qualification-zero-parent', maxMicro: 0, consume() {} }, report() {} });
  const originalClose = segment.close;
  return { grant: segment.grant, networkRelay: factory.networkRelay, format: TTS_FORMAT,
    onClose(close) { segment.close = close; },
    async close() { await originalClose(); factory.networkRelay.close(); await track(segment.idle()); await turns.idle(); } };
}
