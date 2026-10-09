import { createHash } from 'node:crypto';
import { PluginRegistry, createMockReasoning, createBinding, PluginError, isCancelledZeroReport, PROCESSING_PRESETS, FEATURES,
  deviceFeatures, featureUnavailable, bindingReason, processingScope, consentReason, MOCK_PROCESSING_SCOPE,
  operationScope, inputRevision, untilCancelled } from '@inspr/aithema-core';
import { SQLiteBudgetLedger } from './budget.js';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const map = { text: ['reaction', 'reasoning', 'stream'], analysis: ['understanding', 'reasoning', 'structured'],
  voice: ['voice', 'live-voice', 'start'], transcription: ['transcription', 'stt', 'transcribe'], images: ['images', 'ui-generation', 'generate'] };
export function mockPresets() {
  const binding = { plugin: 'mock', model: 'mock', effort: 'none', endpoint: 'https://example.test',
    accountRef: 'demo', secretRef: 'none', maxMicro: 0, maxTokens: 4096, rates: { inputMicro: 0, outputMicro: 0 } };
  return { best: { plugins: ['mock'], bindings: { reaction: binding, understanding: binding } },
    eu: { plugins: [], bindings: {} }, custom: { plugins: [], bindings: {} } };
}
export function createPluginRuntime({ storage, reasoning = createMockReasoning(), registry = new PluginRegistry().register(reasoning),
  presets = mockPresets(), consent, budget = new SQLiteBudgetLedger(storage), healthMs = 1000, now = () => Date.now() } = {}) {
  // Single writer recovery is invoked by the host on startup, never on each dispatch.
  const unchanged = session => {
    const current = storage.get(session.id);
    return Boolean(session.ownerHash) && current.ownerHash === session.ownerHash && !current.tombstone &&
      !current.consentWithdrawn && !current.paused && inputRevision(current) === inputRevision(session);
  };
  const coverageFor = (session, scope, options) => consent.coverage({ sessionId: session.id,
    scope: structuredClone(scope), consentRevision: session.consentRevision }, options);
  async function evaluate(session, preset, feature, options) {
    if (!PROCESSING_PRESETS.includes(preset)) return { reason: 'unknown preset' };
    if (preset === 'device') return { reason: feature === 'text' ? 'device browser only' : 'unavailable on device' };
    const config = presets[preset], [lane, kind, operation] = map[feature];
    if (!config) return { reason: 'preset not configured' };
    const raw = config.bindings?.[lane];
    if (!raw) return { reason: 'not configured' };
    if (!config.plugins?.includes(raw.plugin)) return { reason: 'plugin not in preset' };
    let binding; try { binding = createBinding(raw); } catch { return { reason: 'binding invalid' }; }
    let plugin = registry.get(binding.plugin);
    if (!plugin) return { reason: 'plugin not registered' };
    if (plugin.bind) { try { plugin = plugin.bind(binding); } catch { return { reason: 'binding invalid' }; } }
    const mock = registry.isCanonicalMock(plugin);
    if (!plugin.bind && !mock && (!plugin.binding || hash(plugin.binding) !== hash(binding))) return { reason: 'plugin binding mismatch' };
    if (!plugin.manifest.kinds.includes(kind)) return { reason: 'plugin kind unsupported' };
    const model = plugin.manifest.models.find(m => m.id === binding.model) ?? plugin.manifest.models.find(m => m.id === '*');
    if (!model?.operations.includes(operation) || operation === 'stream' && !model.streaming || operation === 'structured' && !model.structured) return { reason: 'operation unsupported' };
    if (session.paused) return { reason: 'session paused' };
    if (session.tombstone || session.consentWithdrawn) return { reason: 'current processing consent required' };
    let coverage, scope;
    // The non-billable deterministic demo has no external processing scope.
    if (!mock) {
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
    try { if (!(await plugin.health(options))?.available) return { reason: 'plugin unhealthy' }; }
    catch { return { reason: 'plugin unhealthy' }; }
    if (scope) { const reason = consentReason(coverage, scope, now(), session.consentRevision); if (reason) return { reason }; }
    if (!budget.canAdmit(session.id, binding.maxMicro)) return { reason: 'budget denied' };
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
    budget, consent,
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
    async admit({ session, lane, operation, request, options = {} }) {
      // Ownership, revision and tombstone precede health, consent and budget work.
      if (!unchanged(session)) throw new PluginError('not-admitted', 'Session changed during admission');
      const result = await boundedEvaluate(session, session.processingPreset ?? 'best', lane === 'reaction' ? 'text' : 'analysis', options);
      if (result.reason) throw new PluginError('not-admitted', result.reason);
      options.signal?.throwIfAborted();
      if (!unchanged(session)) throw new PluginError('not-admitted', 'Session changed during admission');
      const { binding, plugin } = result;
      // A byte bound plus message framing conservatively bounds chat input tokens;
      // reasoning tokens share the requested max_tokens output ceiling.
      const promptBytes = new TextEncoder().encode(JSON.stringify({ system: request.system, messages: request.messages,
        schema: request.schema, providerOptions: request.providerOptions,
        adapterOptions: plugin.providerOptions?.(operation === 'stream') })).byteLength;
      const ceiling = (promptBytes + 256 + (request.messages?.length ?? 0) * 64) * binding.rates.inputMicro
        + binding.maxTokens * binding.rates.outputMicro;
      if (!Number.isSafeInteger(ceiling) || ceiling > binding.maxMicro) throw new PluginError('not-admitted', 'Request exceeds binding cost ceiling');
      if (operation !== result.operation) throw new PluginError('not-admitted');
      const { attemptId } = budget.admit({ sessionId: session.id, lane, maxMicro: binding.maxMicro,
        requestSha256: hash(request), bindingSha256: hash(binding) });
      const claim = budget.claim(attemptId); let reported = false, refused = false, consuming = false, detached = false;
      const report = terminal => {
        if (reported) {
          // A lane released on cancellation owns settlement; late provider usage
          // cannot reopen or reduce its conservative dispatched charge.
          if (detached && terminal?.attemptId === attemptId) return;
          if (refused && isCancelledZeroReport(terminal, attemptId)) return;
          throw new PluginError('already-claimed');
        }
        const settlement = budget.settle(claim.claimId, terminal, binding.rates); reported = true; return settlement;
      };
      const refuse = reason => {
        report({ attemptId, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } });
        refused = true;
        throw new PluginError('not-admitted', reason);
      };
      const attempt = Object.freeze({ ...claim, consume() {
        if (reported || consuming) throw new PluginError('already-claimed');
        if (!unchanged(session) || options.signal?.aborted) return refuse('Session changed before dispatch');
        consuming = true;
        if (!result.scope) return claim.consume();
        return (async () => {
          const scope = operationScope(options);
          try {
            let coverage;
            try { coverage = await untilCancelled(coverageFor(session, result.scope, { ...options, signal: scope.signal }), scope.signal); }
            catch { return refuse('consent port unavailable'); }
            if (!unchanged(session) || scope.signal.aborted) return refuse('Session changed before dispatch');
            const reason = consentReason(coverage, result.scope, now(), session.consentRevision);
            if (reason) return refuse(reason);
            claim.consume();
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
