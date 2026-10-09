import { createHash } from 'node:crypto';
import { PluginRegistry, createMockReasoning, createBinding, PluginError, isCancelledZeroReport, PROCESSING_PRESETS, FEATURES,
  deviceFeatures, featureUnavailable, bindingReason, processingScope, consentReason, MOCK_PROCESSING_SCOPE,
  operationScope, inputRevision, untilCancelled, MAX_HTML_BYTES } from '@inspr/aithema-core';
import { createDurationBinding, durationPluginMatches } from './voice-binding.js';
import { isLocalVoice } from './local-voice.js';
import { createImageBinding, imagePluginBinding } from './image-binding.js';
import { isLocalImages } from './local-images.js';
import { isLocalHTML } from './local-html.js';
import { createUIRenderLimiter } from './ui-render-limits.js';
import { buildMessages, callCeilingMicro } from '../../../plugins/claude-html/src/index.js';
import { previousDocument } from '../../../plugins/claude-html/src/html-artifact.js';
import { SQLiteBudgetLedger } from './budget.js';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const map = { text: ['reaction', 'reasoning', 'stream'], analysis: ['understanding', 'reasoning', 'structured'],
  voice: ['voice', 'live-voice', 'start'], transcription: ['transcription', 'stt', 'transcribe'], images: ['images', 'ui-generation', 'generate'], html: ['html', 'ui-generation', 'generate'] };
export function mockPresets() {
  const binding = { plugin: 'mock', model: 'mock', effort: 'none', endpoint: 'https://example.test',
    accountRef: 'demo', secretRef: 'none', maxMicro: 0, maxTokens: 4096, rates: { inputMicro: 0, outputMicro: 0 } };
  return { best: { plugins: ['mock'], bindings: { reaction: binding, understanding: binding } },
    eu: { plugins: [], bindings: {} }, custom: { plugins: [], bindings: {} } };
}
export function createPluginRuntime({ storage, reasoning = createMockReasoning(), registry = new PluginRegistry().register(reasoning),
  presets = mockPresets(), consent, budget = new SQLiteBudgetLedger(storage), healthMs = 1000, now = () => Date.now(), uiRenderLimits = {},
  renderLimiter = createUIRenderLimiter({ storage, now, ...uiRenderLimits }) } = {}) {
  // HTML is the primary click-dummy when both visual bindings exist. A host
  // can select images explicitly; unavailable HTML never silently changes processor.
  const visualKind = session => {
    const bindings = presets[session.processingPreset ?? 'best']?.bindings;
    return bindings?.visuals ?? (bindings?.html ? 'html' : 'images');
  };
  const visual = feature => ['images', 'html'].includes(feature);
  // Single writer recovery is invoked by the host on startup, never on each dispatch.
  const unchanged = session => {
    const current = storage.get(session.id);
    return Boolean(session.ownerHash) && current.ownerHash === session.ownerHash && !current.tombstone &&
      !current.consentWithdrawn && !current.paused && inputRevision(current) === inputRevision(session);
  };
  const coverageFor = (session, scope, options) => consent.coverage({ sessionId: session.id,
    scope: structuredClone(scope), consentRevision: session.consentRevision }, options);
  const voiceAmounts = (binding, options) => {
    const milliseconds = options.spendDeadlineAt === undefined ? binding.maxDurationSeconds * 1000
      : Math.min(binding.maxDurationSeconds * 1000, Math.max(0, options.spendDeadlineAt - now()));
    return { maxMicro: options.spendDeadlineAt === undefined ? binding.maxMicro : Math.ceil(milliseconds / 60_000 * binding.upstreamMicroPerMinute),
      maxVisitorMicro: Math.ceil(milliseconds / 60_000 * binding.visitorMicroPerMinute) };
  };
  async function evaluate(session, preset, feature, options) {
    if (!PROCESSING_PRESETS.includes(preset)) return { reason: 'unknown preset' };
    if (preset === 'device') return { reason: feature === 'text' ? 'device browser only' : 'unavailable on device' };
    const config = presets[preset], [lane, kind, defaultOperation] = map[feature];
    const operation = visual(feature) ? options.operation ?? defaultOperation : defaultOperation;
    if (visual(feature) && !['generate', 'edit'].includes(operation)) return { reason: 'operation unsupported' };
    if (config?.bindings?.visuals && !['html', 'images'].includes(config.bindings.visuals)) return { reason: 'visual kind invalid' };
    if (!config) return { reason: 'preset not configured' };
    const raw = config.bindings?.[lane];
    if (!raw) return { reason: 'not configured' };
    if (!config.plugins?.includes(raw.plugin)) return { reason: 'plugin not in preset' };
    let binding; try { binding = feature === 'voice' ? createDurationBinding(raw) : feature === 'images' ? createImageBinding(raw) : createBinding(raw); } catch { return { reason: 'binding invalid' }; }
    let plugin = registry.get(binding.plugin);
    if (!plugin) return { reason: 'plugin not registered' };
    if (plugin.bind) { try { plugin = plugin.bind(feature === 'images' ? imagePluginBinding(binding) : binding); } catch { return { reason: 'binding invalid' }; } }
    const mock = registry.isCanonicalMock(plugin) || feature === 'html' && isLocalHTML(plugin) && binding.maxMicro === 0 || feature === 'images' && isLocalImages(plugin) && binding.maxMicro === 0 &&
      binding.imageCost.inputMicro === 0 && binding.imageCost.outputMicro === 0 || feature === 'voice' && isLocalVoice(plugin) &&
      binding.maxMicro === 0 && binding.upstreamMicroPerMinute === 0 && binding.visitorMicroPerMinute === 0;
    if (!plugin.bind && !mock && (feature === 'voice' ? !durationPluginMatches(plugin, binding) : !plugin.binding || hash(plugin.binding) !== hash(feature === 'images' ? imagePluginBinding(binding) : binding))) return { reason: 'plugin binding mismatch' };
    if (!plugin.manifest.kinds.includes(kind)) return { reason: 'plugin kind unsupported' };
    const model = plugin.manifest.models.find(m => m.id === binding.model) ?? plugin.manifest.models.find(m => m.id === '*');
    if (feature === 'html' && !model?.formats.includes('text/html')) return { reason: 'HTML format unsupported' };
    if (!model?.operations.includes(operation) || operation === 'stream' && !model.streaming || operation === 'structured' && !model.structured) return { reason: 'operation unsupported' };
    if (session.paused) return { reason: 'session paused' };
    if (session.tombstone || session.consentWithdrawn) return { reason: 'current processing consent required' };
    let coverage, scope;
    // The non-billable deterministic demo has no external processing scope.
    if (!mock) {
      if (feature === 'html' && !binding.legal) return { reason: 'HTML consent scope unavailable: START has no matching HTML item' };
      const reason = bindingReason({ binding, plugin, preset, policy: config.policy, now: now() });
      if (reason) return { reason };
      scope = processingScope(binding, operation);
    } else if (binding.maxMicro !== 0 || binding.rates.inputMicro !== 0 || binding.rates.outputMicro !== 0) return { reason: 'invalid mock budget' };
    // The canonical mock needs no external legal qualification. A host ledger,
    // including the demo's local grant, still governs its processing when supplied.
    if (mock && consent) scope = MOCK_PROCESSING_SCOPE;
    if (scope) {
      if (!consent?.coverage) return { reason: 'consent port unavailable' };
      try {
        coverage = await coverageFor(session, scope, options);
        const reason = consentReason(coverage, scope, now(), session.consentRevision); if (reason) return { reason };
      } catch { return { reason: 'consent port unavailable' }; }
    }
    // Provider health (including spend headroom) governs new dispatch only.
    // Paid results still require all binding, consent and session checks above.
    if (!options.existingCall) {
      try { if (!(await plugin.health(options))?.available) return { reason: 'plugin unhealthy' }; }
      catch { return { reason: 'plugin unhealthy' }; }
    }
    if (scope) { const reason = consentReason(coverage, scope, now(), session.consentRevision); if (reason) return { reason }; }
    if (feature === 'voice' && plugin.manifest.liveVoice?.reasoning === 'delegated') {
      const reaction = await evaluate(session, preset, 'text', { ...options, existingCall: false });
      if (reaction.reason) return { reason: `delegated reasoning: ${reaction.reason}` };
    }
    const amounts = feature === 'voice' ? voiceAmounts(binding, options) : { maxMicro: binding.maxMicro, maxVisitorMicro: 0 };
    if (visual(feature) && !options.existingCall && !storage.canStoreConcept(session.id, feature === 'html' ? MAX_HTML_BYTES : undefined)) return { reason: 'concept storage limit' };
    if (visual(feature) && !options.existingCall && renderLimiter.reason(session.id)) return { reason: renderLimiter.reason(session.id) };
    if (!options.existingCall && !budget.canAdmit(session.id, amounts.maxMicro, amounts.maxVisitorMicro)) return { reason: 'budget denied' };
    return { binding, plugin, operation, coverage, scope };
  }
  async function boundedEvaluate(session, preset, feature, options = {}) {
    const scope = operationScope({ ...options, deadlineAt: Math.min(options.deadlineAt ?? Infinity, now() + healthMs) });
    let abort;
    try {
      const expired = new Promise(resolve => { abort = () => resolve({ reason: 'admission deadline' });
        scope.signal.addEventListener('abort', abort, { once: true }); if (scope.signal.aborted) abort(); });
      return await Promise.race([evaluate(session, preset, feature, { ...options, signal: scope.signal, deadlineAt: now() + healthMs }), expired]);
    } finally { scope.signal.removeEventListener('abort', abort); scope.dispose(); }
  }
  return {
    budget, consent, visualKind, renderLimiter,
    async matrix(session) {
      const matrix = {};
      for (const preset of PROCESSING_PRESETS) {
        if (preset === 'device') { matrix[preset] = deviceFeatures(); continue; }
        matrix[preset] = {};
        for (const feature of FEATURES) {
          const result = await boundedEvaluate(session, preset, feature);
          matrix[preset][feature] = result.reason ? featureUnavailable(result.reason) : { available: true, reason: null };
        }
      }
      return matrix;
    },
    async checkVoice(session, { allowPaused = false, ...options } = {}) {
      const result = await boundedEvaluate(allowPaused ? { ...session, paused: false } : session,
        session.processingPreset ?? 'best', 'voice', options);
      const current = storage.get(session.id);
      if (result.reason || current.ownerHash !== session.ownerHash || current.tombstone || current.consentWithdrawn ||
        (!allowPaused && current.paused) || inputRevision(current) !== inputRevision(session)) throw new PluginError('not-admitted', result.reason ?? 'Session changed');
      return result;
    },
    async publicationAllowed(session, { signal, deadlineAt = now() + healthMs, operation = 'generate', visualKind: selected = visualKind(session) } = {}) {
      const current = storage.get(session.id);
      if (current.tombstone || current.consentWithdrawn || current.ownerHash !== session.ownerHash || current.consentRevision !== session.consentRevision) return false;
      const result = await boundedEvaluate({ ...current, paused: false }, current.processingPreset ?? 'best', selected, { signal, deadlineAt, operation, existingCall: true });
      const latest = storage.get(session.id);
      return !result.reason && !signal?.aborted && !latest.tombstone && !latest.consentWithdrawn && latest.ownerHash === session.ownerHash && latest.consentRevision === session.consentRevision;
    },
    imageQuote(session) {
      try { const kind = visualKind(session), raw = presets[session.processingPreset ?? 'best']?.bindings?.[kind];
        return { maxMicro: (kind === 'images' ? createImageBinding(raw) : createBinding(raw)).maxMicro }; }
      catch { return null; }
    },
    async admitVoice({ session, request, options = {} }) {
      if (!unchanged(session)) throw new PluginError('not-admitted');
      const result = await this.checkVoice(session, options);
      if (!unchanged(session)) throw new PluginError('not-admitted');
      const { binding, plugin } = result;
      const { maxMicro, maxVisitorMicro } = voiceAmounts(binding, options);
      const { attemptId } = budget.admit({ sessionId: session.id, lane: 'voice', maxMicro, maxVisitorMicro,
        requestSha256: hash(request), bindingSha256: hash(binding) });
      const claim = budget.claim(attemptId); let reported = false, consuming = false;
      const report = terminal => {
        const receipt = budget.settleVoice(claim.claimId, terminal); reported = true; return receipt;
      };
      const zero = () => report({ attemptId, outcome: 'cancelled', closureConfirmed: true, chargedMicro: 0,
        usage: { providerSeconds: 0, providerMinutes: 0, pausedSeconds: 0, visitorSeconds: 0, upstreamMicro: 0, visitorMicro: 0 } });
      const attempt = { ...claim, maxMicro, async consume() {
        if (reported || consuming) throw new PluginError('already-claimed');
        consuming = true;
        try {
          if (!unchanged(session)) throw new PluginError('not-admitted');
          if (result.scope) {
            const scope = operationScope(options);
            try {
              const coverage = await untilCancelled(coverageFor(session, result.scope, { ...options, signal: scope.signal }), scope.signal);
              if (consentReason(coverage, result.scope, now(), session.consentRevision)) throw new PluginError('not-admitted');
            } finally { scope.dispose(); }
          }
          options.signal?.throwIfAborted();
          if (!unchanged(session)) throw new PluginError('not-admitted');
          claim.consume();
        } catch { zero(); throw new PluginError('not-admitted', 'Voice dispatch refused'); }
      } };
      return { plugin, binding, options: { ...options, attempt, report }, finish() {
        if (!reported) report({ attemptId, outcome: 'uncertain', closureConfirmed: false, chargedMicro: maxMicro });
      } };
    },
    async admit({ session, lane, operation, request, options = {} }) {
      const invocationCurrent = () => unchanged(session) && (lane !== 'concept' ||
        storage.get(session.id).conceptIntent?.pending?.id === session.conceptIntent?.pending?.id);
      // Ownership, revision and tombstone precede health, consent and budget work.
      if (!invocationCurrent()) throw new PluginError('not-admitted', 'Session changed during admission');
      if (lane === 'concept' && (!session.conceptIntent?.visualIntent || !session.conceptIntent.pending ||
        storage.get(session.id).conceptIntent?.pending?.id !== session.conceptIntent.pending.id)) throw new PluginError('not-admitted', 'Visual intent required');
      const selected = visualKind(session), html = lane === 'concept' && selected === 'html';
      if (lane === 'concept' && options.visualKind && options.visualKind !== selected) throw new PluginError('not-admitted', 'Visual kind changed');
      const result = await boundedEvaluate(session, session.processingPreset ?? 'best', lane === 'concept' ? selected : lane === 'reaction' ? 'text' : 'analysis', { ...options, operation });
      if (result.reason) throw new PluginError(result.reason.startsWith('UI render limit reached') ? 'rate-limit' : 'not-admitted', result.reason);
      options.signal?.throwIfAborted();
      if (!invocationCurrent()) throw new PluginError('not-admitted', 'Session changed during admission');
      const { binding, plugin } = result;
      // A byte bound plus message framing conservatively bounds chat input tokens;
      // reasoning tokens share the requested max_tokens output ceiling.
      const promptBytes = new TextEncoder().encode(JSON.stringify(lane === 'concept' ? { prompt: request.prompt, feedback: request.feedback,
        references: request.references?.map(r => ({ mediaType: r.mediaType, role: r.role, size: r.bytes.length })) }
        : { system: request.system, messages: request.messages, schema: request.schema, providerOptions: request.providerOptions,
          adapterOptions: plugin.providerOptions?.(operation === 'stream') })).byteLength;
      const rates = lane === 'concept' && !html ? binding.imageCost : binding.rates;
      // Image inputs have separate units; the host's bound includes decoded image
      // tokenization. Account qualification is responsible for this conservative cap.
      if (lane === 'concept' && !html && promptBytes > binding.imageCost.maxInputTokens) throw new PluginError('not-admitted', 'Image input ceiling');
      let htmlCeiling;
      if (html) {
        const { feedback, previousArtifact, ...spec } = request;
        const { messages } = buildMessages(spec, feedback, previousArtifact ? previousDocument(previousArtifact) : undefined);
        htmlCeiling = binding.maxMicro === 0 ? 0 : callCeilingMicro(messages, binding);
      }
      const ceiling = html ? htmlCeiling : lane === 'concept' ? rates.maxInputTokens * rates.inputMicro + rates.maxOutputTokens * rates.outputMicro
        : (promptBytes + 256 + (request.messages?.length ?? 0) * 64) * rates.inputMicro + binding.maxTokens * rates.outputMicro;
      if (!Number.isSafeInteger(ceiling) || ceiling > binding.maxMicro) throw new PluginError('not-admitted', 'Request exceeds binding cost ceiling');
      if (operation !== result.operation) throw new PluginError('not-admitted');
      const { attemptId } = budget.admit({ sessionId: session.id, lane, maxMicro: binding.maxMicro,
        requestSha256: hash(html ? { ...request, previousArtifact: request.previousArtifact?.provenance.subject.contentDigest } : lane === 'concept' ? { prompt: request.prompt, feedback: request.feedback, references: request.references?.map(r => ({
          mediaType: r.mediaType, role: r.role, sha256: createHash('sha256').update(r.bytes).digest('hex') })) } : request), bindingSha256: hash(binding) });
      const claim = budget.claim(attemptId); let reported = false, refused = false, consuming = false, detached = false;
      const report = terminal => {
        if (reported) {
          // A lane released on cancellation owns settlement; late provider usage
          // cannot reopen or reduce its conservative dispatched charge.
          if (detached && terminal?.attemptId === attemptId) return;
          if (refused && isCancelledZeroReport(terminal, attemptId)) return;
          throw new PluginError('already-claimed');
        }
        const settlement = budget.settle(claim.claimId, terminal, rates); reported = true; return settlement;
      };
      const refuse = reason => {
        report({ attemptId, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } });
        refused = true;
        throw new PluginError('not-admitted', reason);
      };
      const consume = () => lane === 'concept' ? renderLimiter.consume(attemptId, session.id, claim.consume) : claim.consume();
      const consumeOrRefuse = () => {
        try { return consume(); } catch (error) {
          report({ attemptId, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } }); refused = true; throw error;
        }
      };
      const attempt = Object.freeze({ ...claim, consume() {
        if (reported || consuming) throw new PluginError('already-claimed');
        if (!invocationCurrent() || options.signal?.aborted) return refuse('Session changed before dispatch');
        consuming = true;
        if (!result.scope) return consumeOrRefuse();
        return (async () => {
          const scope = operationScope(options);
          try {
            let coverage;
            try { coverage = await untilCancelled(coverageFor(session, result.scope, { ...options, signal: scope.signal }), scope.signal); }
            catch { return refuse('consent port unavailable'); }
            if (!invocationCurrent() || scope.signal.aborted) return refuse('Session changed before dispatch');
            const reason = consentReason(coverage, result.scope, now(), session.consentRevision);
            if (reason) return refuse(reason);
            consumeOrRefuse();
          } finally { scope.dispose(); }
        })();
      } });
      return { plugin, options: { ...options, attempt, report }, finish({ failed = false } = {}) {
        try {
          if (!reported) {
            report({ attemptId, outcome: 'uncertain' });
            detached = failed && Boolean(options.signal?.aborted);
            throw new PluginError('invalid-output', 'Plugin omitted its terminal report');
          }
        } catch (error) { if (!failed) throw error; }
      } };
    },
  };
}
