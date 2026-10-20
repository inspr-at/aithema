import { providerProcessingFacts } from './provider-processing.js';
import { createHash, randomUUID } from 'node:crypto';
import { PluginRegistry, createMockReasoning, createBinding, PluginError, isCancelledZeroReport, PROCESSING_PRESETS, FEATURES,
  deviceFeatures, featureUnavailable, bindingReason, processingScope, consentReason, MOCK_PROCESSING_SCOPE,
  operationScope, inputRevision, voiceAuthorizationRevision, untilCancelled, MAX_HTML_BYTES, isCanonicalMockReasoning, EFFORT_ORDER, SETTINGS_OFF, isOptionId,
  sortEfforts, preferredEffort, isDynamicReason, isConsentReason, CONSENT_REASON, activeUploads, beginInvocation, admitCredits } from '@inspr/aithema-core';
import { assertExtractor, createExtractor, normalizeExtractorLimits } from '@inspr/aithema-core/extractor';
import { createDurationBinding, durationPluginMatches } from './voice-binding.js';
import { localVoiceImplementation } from './voice-provider.js';
import { createImageBinding, imagePluginBinding } from './image-binding.js';
import { localImagesImplementation } from './local-images.js';
import { localHTMLImplementation } from './local-html.js';
import { createUIRenderLimiter } from './ui-render-limits.js';
import { SQLiteBudgetLedger } from './budget.js';
import { createConversationLimits } from './conversation-limits.js';
import { createComposedComponentAccounting } from './composed/accounting.js';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const map = { text: ['reaction', 'reasoning', 'stream'], analysis: ['understanding', 'reasoning', 'structured'],
  voice: ['voice', 'live-voice', 'start'], transcription: ['transcription', 'stt', 'transcribe'], images: ['images', 'ui-generation', 'generate'], html: ['html', 'ui-generation', 'generate'] };
const CONSENT = CONSENT_REASON;
const COST_ESTIMATE_ATTEMPTS = 12;
const text = (value, max = 120) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
const free = raw => raw?.maxMicro === 0 && raw.rates?.inputMicro === 0 && raw.rates?.outputMicro === 0 &&
  (raw.upstreamMicroPerMinute ?? 0) === 0 && (raw.visitorMicroPerMinute ?? 0) === 0 &&
  (!raw.imageCost || raw.imageCost.inputMicro === 0 && raw.imageCost.outputMicro === 0);

/**
 * Host allowlist of visitor choices. `presets[p].choices` lists model, voice and
 * visual options with private bindings; without it the legacy single bindings form
 * one implicit option per lane. Options without a binding are declared but not
 * configured, and are shown disabled with that reason.
 */
export function normalizeChoices(config) {
  if (!config) return null;
  const quality = value => {
    if (value === undefined || value === null) return null;
    const source = value.source;
    if (!Number.isFinite(value.score) || value.score < 0 || value.score > 100 || !text(source?.name) ||
      !/^https:\/\//u.test(source?.url ?? '') || !Number.isFinite(Date.parse(source?.asOf))) throw new TypeError('Invalid model quality rating');
    return { score: value.score, source: { name: source.name, url: source.url, asOf: source.asOf } };
  };
  if (!config.choices) {
    const { reaction, understanding, voice } = config.bindings ?? {};
    // B1 contract: `bindings.visuals` picks html or images; HTML leads when both are bound.
    const kind = config.bindings?.visuals ?? (config.bindings?.html ? 'html' : 'images'), visual = config.bindings?.[kind];
    const models = reaction || understanding ? [{ id: 'default', label: null, bindings: { reaction, understanding }, efforts: null, effort: null, quality: null }] : [];
    return { legacy: true, models, voices: voice ? [{ id: 'default', label: null, binding: voice }] : [],
      visuals: visual ? [{ id: 'default', label: null, kind, binding: visual }] : [],
      defaults: { model: models[0]?.id ?? null, effort: null, voice: voice ? 'default' : SETTINGS_OFF, visuals: visual ? 'default' : SETTINGS_OFF } };
  }
  const choices = config.choices, seen = new Set();
  const entry = (option, kind) => {
    if (!option || typeof option !== 'object' || !isOptionId(option.id) || option.id === SETTINGS_OFF || seen.has(`${kind}:${option.id}`) ||
      option.label !== undefined && !text(option.label) || Object.keys(option).some(k => !['id', 'label', 'binding', 'bindings', 'efforts', 'effort', 'quality', 'kind'].includes(k)) ||
      kind !== 'model' && ['bindings', 'efforts', 'effort', 'quality'].some(k => option[k] !== undefined) ||
      option.kind !== undefined && (kind !== 'visual' || !['images', 'html'].includes(option.kind))) throw new TypeError(`Invalid ${kind} choice`);
    seen.add(`${kind}:${option.id}`);
    return option;
  };
  const models = (choices.models ?? []).map(option => {
    entry(option, 'model');
    const efforts = option.efforts === undefined ? null : option.efforts;
    if (efforts && (!Array.isArray(efforts) || !efforts.length || efforts.some(e => !EFFORT_ORDER.includes(e)) ||
      new Set(efforts).size !== efforts.length) || option.effort !== undefined && !efforts?.includes(option.effort)) throw new TypeError('Invalid model efforts');
    const bindings = option.bindings ?? (option.binding ? { reaction: option.binding, understanding: option.binding } : {});
    if (!bindings || typeof bindings !== 'object' || Object.keys(bindings).some(k => !['reaction', 'understanding'].includes(k))) throw new TypeError('Invalid model bindings');
    const sorted = efforts && sortEfforts(efforts);
    return { id: option.id, label: text(option.label), bindings, efforts: sorted, effort: sorted ? option.effort ?? preferredEffort(sorted) : null,
      quality: quality(option.quality) };
  });
  const voices = (choices.voices ?? []).map(option => ({ id: entry(option, 'voice').id, label: text(option.label), binding: option.binding ?? null }));
  // A visuals option renders images unless it declares the HTML click-dummy kind.
  const visuals = (choices.visuals ?? []).map(option => ({ id: entry(option, 'visual').id, label: text(option.label), kind: option.kind ?? 'images',
    binding: option.binding ?? null }));
  const d = choices.defaults ?? {};
  const pick = (value, list, fallback) => {
    if (value === undefined) return fallback;
    if (value !== SETTINGS_OFF && !list.some(o => o.id === value) || value === SETTINGS_OFF && list === models) throw new TypeError('Invalid choice default');
    return value;
  };
  const model = pick(d.model, models, models.find(o => Object.values(o.bindings).some(Boolean))?.id ?? models[0]?.id ?? null);
  const defaultModel = models.find(o => o.id === model);
  if (d.effort !== undefined && !defaultModel?.efforts?.includes(d.effort)) throw new TypeError('Invalid default effort');
  // A configured draft renderer is the default; an explicit host default still wins.
  return { legacy: false, models, voices, visuals, defaults: { model, effort: d.effort ?? defaultModel?.effort ?? null,
    voice: pick(d.voice, voices, SETTINGS_OFF),
    visuals: pick(d.visuals, visuals, visuals.find(o => o.kind === 'html' && o.binding)?.id ?? SETTINGS_OFF) } };
}

export function mockPresets() {
  const binding = { plugin: 'mock', model: 'mock', effort: 'none', endpoint: 'https://example.test',
    accountRef: 'demo', secretRef: 'none', maxMicro: 0, maxTokens: 4096, rates: { inputMicro: 0, outputMicro: 0 } };
  return { best: { plugins: ['mock'], bindings: { reaction: binding, understanding: binding } },
    eu: { plugins: [], bindings: {} }, custom: { plugins: [], bindings: {} } };
}
export function createPluginRuntime({ storage, reasoning = createMockReasoning(), registry = new PluginRegistry().register(reasoning),
  presets = mockPresets(), consent, costReconciliationWindowMs = 300_000, now: configuredNow, budget = new SQLiteBudgetLedger(storage, { now: configuredNow }), voiceCap, healthMs = 1000, uiRenderLimits = {},
  renderLimiter = createUIRenderLimiter({ storage, now: configuredNow, ...uiRenderLimits }),
  conversationLimits = createConversationLimits({ storage, now: configuredNow }) } = {}) {
  let now = configuredNow ?? (() => Date.now());
  // Follow later host-clock installation while retaining explicit runtime precedence.
  voiceCap?.setClock?.(() => now());
  if (!Number.isSafeInteger(costReconciliationWindowMs) || costReconciliationWindowMs < 1) throw new TypeError('Invalid cost evidence window');
  if (configuredNow) storage.setHostClock?.(now);
  // A synchronous session lease precedes every authorization, quote and wallet await.
  // It survives the synthesis receipt until playback ends (or its bounded lease expires).
  const replyReplays = new Map();
  const releaseReplyReplay = (sessionId, lease) => {
    if (replyReplays.get(sessionId) !== lease) return;
    replyReplays.delete(sessionId); clearTimeout(lease.timer);
    lease.signal?.removeEventListener('abort', lease.abort);
    lease.controller.abort();
  };
  const stopReplyReplay = (sessionId, replayId) => {
    const entry = replyReplays.get(sessionId);
    if (!entry || replayId !== undefined && entry.replayId !== replayId) return;
    releaseReplyReplay(sessionId, entry);
  };
  let ownerWallet, costRetryOffset = 0, costJob;
  const admitBudget = async (session, request) => {
    conversationLimits.start(session.id);
    const wallet = ownerWallet?.(session);
    if (!wallet) return budget.admit(request);
    const verdict = await admitCredits(budget, request, wallet, { beforeReserve: () => conversationLimits.assertOpen(session.id) });
    if (!verdict.ok) {
      conversationLimits.assertOpen(session.id);
      throw new PluginError('not-admitted', verdict.reason);
    }
    return verdict.admission;
  };
  const componentAccounting = createComposedComponentAccounting({ storage, budget, reserve: admitBudget,
    assertCurrent({ sessionId }) { conversationLimits.assertOpen(sessionId); } });
  // Voice never inherits the analysis route. Validate every configured model/voice
  // combination at registration, then recheck the selected route at admission:
  // saved choices, host recovery and expired evidence cannot bypass this rule.
  const voiceConfigurationErrors = new Set();
  const fastReactionRefusal = reason => Object.assign(new PluginError('not-admitted', reason), { reason: 'voice-host-unavailable' });
  function fastReactionReason(preset, model, voice) {
    if (localVoiceImplementation(registry.get(voice?.binding?.plugin))) return null;
    const reaction = model?.bindings.reaction, understanding = model?.bindings.understanding;
    const plugin = registry.get(reaction?.plugin);
    // The canonical, zero-cost demo does no model processing. Identity, rather
    // than a provider name or a host-controlled flag, owns this exemption.
    if (registry.isCanonicalMock(plugin) && free(reaction)) return null;
    let reason = !reaction ? 'reaction not configured'
      : reaction.model === understanding?.model ? 'reaction uses the analysis model'
      : reaction.effort !== 'none' ? 'reaction effort must be none'
      : !presets[preset]?.plugins?.includes(reaction.plugin) ? 'reaction plugin not in preset' : null;
    if (!reason) {
      try {
        const binding = createBinding(reaction);
        reason = bindingReason({ binding, plugin, preset, policy: presets[preset]?.policy, now: now() });
        const supported = plugin?.manifest.models.find(m => m.id === binding.model) ?? plugin?.manifest.models.find(m => m.id === '*');
        if (!reason && (!plugin.manifest.kinds.includes('reasoning') || !supported?.streaming || !supported.operations.includes('stream'))) reason = 'reaction streaming unsupported';
      } catch { reason = 'reaction binding invalid'; }
    }
    if (!reason) return null;
    const key = JSON.stringify([preset, voice?.id, model?.id, reason]);
    if (!voiceConfigurationErrors.has(key)) {
      voiceConfigurationErrors.add(key);
      console.error(`Voice configuration error: preset ${preset}, voice ${voice?.id ?? 'selected'}, reaction binding for model ${model?.id ?? 'default'} requires an explicitly qualified fast reaction route distinct from the analysis binding with effort none (${reason}); voice start refused.`);
    }
    // Only a neutral code reaches public availability; operator details stay here.
    return 'fast reaction binding required';
  }
  // Invalid host choices fail at startup instead of at a visitor's first request.
  for (const preset of PROCESSING_PRESETS) if (preset !== 'device') {
    const choices = normalizeChoices(presets[preset]);
    for (const voice of choices?.voices ?? []) if (voice.binding) {
      const models = choices.models.filter(model => Object.values(model.bindings).some(Boolean));
      for (const model of models.length ? models : [null]) fastReactionReason(preset, model, voice);
    }
  }
  const choicesFor = preset => { try { return normalizeChoices(presets[preset]); } catch { return null; } };
  // The session's own choice applies to its preset; other presets show their defaults.
  function selectionFor(session, preset) {
    const choices = choicesFor(preset), current = preset === (session.processingPreset ?? 'best') ? session.settings : null;
    if (!choices) return { choices: null };
    const d = choices.defaults, modelId = current?.model ?? d.model, model = choices.models.find(o => o.id === modelId) ?? null;
    const effort = model?.efforts ? current?.effort ?? (model.id === d.model && d.effort && model.efforts.includes(d.effort) ? d.effort : model.effort) : null;
    const voiceId = current?.voice ?? d.voice, visualsId = current?.visuals ?? d.visuals;
    return { choices, modelId, model, effort, voiceId, voice: choices.voices.find(o => o.id === voiceId) ?? null,
      visualsId, visuals: choices.visuals.find(o => o.id === visualsId) ?? null };
  }
  function selectedBinding(session, preset, lane) {
    const config = presets[preset], selection = selectionFor(session, preset), choices = selection.choices;
    if (!choices) return { reason: config ? 'preset choices invalid' : 'preset not configured' };
    if (lane === 'reaction' || lane === 'understanding') {
      if (!selection.modelId) return { reason: 'not configured' };
      if (!selection.model) return { reason: 'model not offered' };
      const raw = selection.model.bindings[lane];
      if (!raw) return { reason: 'not configured' };
      if (!selection.model.efforts) return { raw };
      if (!selection.model.efforts.includes(selection.effort)) return { reason: 'effort not offered' };
      // Explicit lane bindings reserve reaction's latency budget independently.
      // Shared text-only options retain their effort-selector contract; selecting
      // voice applies the reaction ceiling to those options as well.
      const effort = lane === 'reaction' && EFFORT_ORDER.includes(raw.effort) && (raw !== selection.model.bindings.understanding || selection.voice?.binding) &&
        EFFORT_ORDER.indexOf(selection.effort) > EFFORT_ORDER.indexOf(raw.effort) ? raw.effort : selection.effort;
      return { raw: { ...raw, effort } };
    }
    if (lane === 'voice' || lane === 'images' || lane === 'html') {
      const [id, option, list, off] = lane === 'voice' ? [selection.voiceId, selection.voice, choices.voices, 'voice off']
        : [selection.visualsId, selection.visuals, choices.visuals, 'visuals off'];
      if (id === SETTINGS_OFF) return { reason: list.length ? off : 'not configured' };
      if (!option) return { reason: `${lane === 'voice' ? 'voice' : 'visuals'} not offered` };
      // One Visuals control governs both kinds: only the selected option's kind renders.
      if (lane !== 'voice' && option.kind !== lane) return { reason: 'visual kind not selected' };
      return option.binding ? { raw: option.binding } : { reason: 'not configured' };
    }
    return config.bindings?.[lane] ? { raw: config.bindings[lane] } : { reason: 'not configured' };
  }
  // Supersession keys: only a change that alters a lane's effective choice stops it.
  function selectionKey(session, lane) {
    const s = session.settings ?? {}, preset = session.processingPreset ?? 'best';
    const reasoning = `${preset}|${s.model ?? ''}|${s.effort ?? ''}`;
    if (lane === 'reaction' || lane === 'understanding') return reasoning;
    if (lane === 'voice') return `${reasoning}|${s.voice ?? ''}`;
    if (lane === 'images' || lane === 'html' || lane === 'concept') return `${preset}|${s.visuals ?? ''}`;
    return preset;
  }
  // The selected visuals option names the kind; with visuals off the B1 preset
  // preference still labels the panel. Unavailable HTML never silently changes processor.
  const visualKind = session => {
    const preset = session.processingPreset ?? 'best', selected = selectionFor(session, preset).visuals;
    if (selected) return selected.kind;
    const bindings = presets[preset]?.bindings;
    return bindings?.visuals ?? (bindings?.html ? 'html' : 'images');
  };
  const visual = feature => ['images', 'html'].includes(feature);
  // Single writer recovery is invoked by the host on startup, never on each dispatch.
  const unchanged = (session, lane, allowTranscriptFinals = false, purposeAssessment = false) => {
    const current = storage.get(session.id);
    if (!session.ownerHash || current.ownerHash !== session.ownerHash || current.tombstone || current.consentWithdrawn || current.paused && !(purposeAssessment && current.pauseReason === 'purpose') ||
      selectionKey(current, lane) !== selectionKey(session, lane)) return false;
    if (inputRevision(current) === inputRevision(session)) return true;
    if (!allowTranscriptFinals || inputRevision({ ...current, inputRevision: session.inputRevision }) !== inputRevision(session)) return false;
    // A voice reply already owns its callback input. Only append-only finals
    // are benign: existing transcript bytes and uploads must remain identical,
    // and every added user final must account for exactly one input increment.
    // Consent, withdrawals, corrections, locale/session revisions and choices
    // retain their ordinary dispatch fences; the budget claim still owns spend.
    const added = current.transcript.slice(session.transcript.length);
    const transcriptBytes = turns => turns.map(({ userTurnOrdinal, replyId, provenance, origin, model, provider, engine, ...turn }) => turn);
    return added.length > 0 && added.every(turn => ['user', 'assistant'].includes(turn.role) && !turn.erased && !turn.withdrawn) &&
      current.inputRevision === session.inputRevision + added.filter(turn => turn.role === 'user').length &&
      hash(transcriptBytes(current.transcript.slice(0, session.transcript.length))) === hash(transcriptBytes(session.transcript)) &&
      hash(current.uploads) === hash(session.uploads);
  };
  const voiceUnchanged = (session, allowPaused = false) => {
    const current = storage.get(session.id);
    return Boolean(session.ownerHash) && !current.tombstone && !current.consentWithdrawn && (allowPaused || !current.paused) &&
      voiceAuthorizationRevision(current) === voiceAuthorizationRevision(session) && selectionKey(current, 'voice') === selectionKey(session, 'voice');
  };
  const coverageFor = (session, scope, options) => consent.coverage({ sessionId: session.id,
    scope: structuredClone(scope), consentRevision: session.consentRevision }, options);
  const voiceAmounts = (binding, options) => {
    const milliseconds = options.spendDeadlineAt === undefined ? binding.maxDurationSeconds * 1000
      : Math.min(binding.maxDurationSeconds * 1000, Math.max(0, options.spendDeadlineAt - now()));
    // Only a brand-new logical call needs the runway. Re-admission funds the
    // next segment (or the shorter remaining duration) under its original end.
    const runwayMs = options.voiceContinuation ? 0 : Math.min(binding.minRunwaySeconds * 1000, binding.maxDurationSeconds * 1000);
    if (milliseconds <= 0 || milliseconds < runwayMs) throw new PluginError('not-admitted', 'host-limit');
    const reservedMs = binding.reservationSeconds ? Math.min(milliseconds, Math.max(binding.reservationSeconds * 1000, runwayMs)) : milliseconds;
    return { maxMilliseconds: Math.ceil(milliseconds), fundedSeconds: reservedMs / 1000, maxMicro: binding.reservationSeconds
      ? Math.ceil(reservedMs / 60_000 * binding.upstreamMicroPerMinute)
      : options.spendDeadlineAt === undefined ? binding.maxMicro : Math.ceil(milliseconds / 60_000 * binding.upstreamMicroPerMinute),
      maxVisitorMicro: Math.ceil(reservedMs / 60_000 * binding.visitorMicroPerMinute) };
  };
  // Resolve once, synchronously. Every exempt dispatch uses only this private,
  // frozen implementation through health, consent awaits, admission and replay.
  const localImplementation = (plugin, feature) => feature === 'voice' ? localVoiceImplementation(plugin)
    : feature === 'images' ? localImagesImplementation(plugin) : feature === 'html' ? localHTMLImplementation(plugin) : undefined;
  const durationBinding = raw => createDurationBinding(
    registry.get(raw.plugin)?.ports?.serverAdapter?.normalizeBinding?.(raw) ?? raw);
  async function evaluate(session, preset, feature, options) {
    const terminalReason = !options.existingCall && conversationLimits.reason(session.id);
    if (terminalReason) return { reason: terminalReason };
    if (session.identity?.verificationRequired === true && ((feature === 'analysis' && !session.identity.assessmentUnlocked) ||
      (visual(feature) && !session.identity.conceptsUnlocked))) return { reason: 'verification required' };
    if (!PROCESSING_PRESETS.includes(preset)) return { reason: 'unknown preset' };
    if (preset === 'device') return { reason: feature === 'text' ? 'device browser only' : 'unavailable on device' };
    if (feature === 'uploads') return evaluateUploads(session, preset, options);
    const config = presets[preset], [lane, kind, defaultOperation] = map[feature];
    const operation = visual(feature) ? options.operation ?? defaultOperation : defaultOperation;
    if (visual(feature) && !['generate', 'edit'].includes(operation)) return { reason: 'operation unsupported' };
    if (config?.bindings?.visuals && !['html', 'images'].includes(config.bindings.visuals)) return { reason: 'visual kind invalid' };
    if (!config) return { reason: 'preset not configured' };
    if (feature === 'text' && options.voiceReply === true) {
      const selected = selectionFor(session, preset);
      const reason = fastReactionReason(preset, selected.model, selected.voice);
      if (reason) return { reason: 'binding evidence unverified', configurationError: reason };
    }
    const { raw, reason: unselected } = options.raw && !(feature === 'text' && options.voiceReply === true)
      ? { raw: options.raw } : selectedBinding(session, preset, lane);
    if (!raw) return { reason: unselected };
    if (!config.plugins?.includes(raw.plugin)) return { reason: 'plugin not in preset' };
    let binding; try { binding = feature === 'voice' ? durationBinding(raw) : feature === 'images' ? createImageBinding(raw) : createBinding(raw); } catch { return { reason: 'binding invalid' }; }
    let plugin = registry.get(binding.plugin);
    if (!plugin) return { reason: 'plugin not registered' };
    // Canonical reasoning can bind only to another private canonical instance.
    // Local providers cannot bind: the host would retain a mutable dispatch target.
    const canonical = registry.isCanonicalMock(plugin), local = localImplementation(plugin, feature);
    if (plugin.bind) {
      if (local) return { reason: 'binding invalid' };
      try { plugin = plugin.bind(feature === 'images' ? imagePluginBinding(binding) : binding); } catch { return { reason: 'binding invalid' }; }
      if (localImplementation(plugin, feature)) return { reason: 'binding invalid' };
    }
    // Discard the registry entry before any await or untrusted health callback.
    // start/serverAdapter and generate/edit now come from the private pairing.
    if (local) {
      try { plugin = plugin.binding ? Object.freeze({ ...local, binding: createBinding(plugin.binding) }) : local; }
      catch { return { reason: 'binding invalid' }; }
    }
    const mock = canonical && isCanonicalMockReasoning(plugin) || feature === 'html' && local && binding.maxMicro === 0 || feature === 'images' && local && binding.maxMicro === 0 &&
      binding.imageCost.inputMicro === 0 && binding.imageCost.outputMicro === 0 || feature === 'voice' && local &&
      binding.maxMicro === 0 && binding.upstreamMicroPerMinute === 0 && binding.visitorMicroPerMinute === 0;
    if (!plugin.bind && !mock && (feature === 'voice' ? !durationPluginMatches(plugin, binding) : !plugin.binding || hash(plugin.binding) !== hash(feature === 'images' ? imagePluginBinding(binding) : binding))) return { reason: 'plugin binding mismatch' };
    if (!plugin.manifest.kinds.includes(kind)) return { reason: 'plugin kind unsupported' };
    const model = plugin.manifest.models.find(m => m.id === binding.model) ?? plugin.manifest.models.find(m => m.id === '*');
    if (feature === 'html' && !model?.formats.includes('text/html')) return { reason: 'HTML format unsupported' };
    if (!model?.operations.includes(operation) || operation === 'stream' && !model.streaming || operation === 'structured' && !model.structured) return { reason: 'operation unsupported' };
    if (!model.efforts.includes(binding.effort)) return { reason: 'effort not supported' };
    if (session.paused) return { reason: 'session paused' };
    if (session.tombstone || session.consentWithdrawn) return { reason: CONSENT };
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
    if (['text', 'analysis'].includes(feature) && !mock && activeUploads(session).some(u => u.state === 'accepted') &&
      !scope?.dataCategories.includes('file-text')) return { reason: 'document text not covered by reasoning scope' };
    if (scope) {
      if (!consent?.coverage) return { reason: 'consent port unavailable' };
      try {
        coverage = await coverageFor(session, scope, options);
        const reason = consentReason(coverage, scope, now(), session.consentRevision); if (reason) return { reason };
      } catch { return { reason: 'consent port unavailable' }; }
    }
    if (feature === 'voice') {
      const selected = selectionFor(session, preset);
      const reason = fastReactionReason(preset, selected.model, { ...selected.voice, binding: raw });
      if (reason) return { reason: 'binding evidence unverified', configurationError: reason };
    }
    const admissionReason = plugin.ports?.serverAdapter?.admissionReason;
    if (feature === 'voice' && admissionReason) {
      try {
        // Opt-in authorities must qualify the same session selection that the
        // delegated reasoning lane will dispatch, including preset defaults.
        const selection = plugin.ports.serverAdapter.requiresReasoningBinding === true
          ? { reasoningBinding: selectedBinding(session, preset, 'reaction').raw } : {};
        const reason = await admissionReason({ session, preset, policy: config.policy, ...selection }, options);
        if (reason) return { reason };
      } catch { return { reason: 'voice components unavailable' }; }
    }
    // Provider health (including spend headroom) governs new dispatch only.
    // Paid results still require all binding, consent and session checks above.
    if (!options.existingCall) {
      try { if (!(await plugin.health(options))?.available) return { reason: 'plugin unhealthy' }; }
      catch { return { reason: 'plugin unhealthy' }; }
    }
    if (scope) { const reason = consentReason(coverage, scope, now(), session.consentRevision); if (reason) return { reason }; }
    if (feature === 'voice' && !options.textReplay && plugin.manifest.liveVoice?.reasoning === 'delegated') {
      const reaction = await evaluate(session, preset, 'text', { ...options, raw: undefined, existingCall: false });
      if (reaction.reason) return { reason: `delegated reasoning: ${reaction.reason}` };
    }
    let amounts;
    try { amounts = feature === 'voice' ? voiceAmounts(binding, options) : { maxMicro:
      plugin.estimateCost ? plugin.estimateCost(feature === 'html' ? options.costRequest : options.costRequest ?? { system: '', messages: [] }, operation)
        : binding.maxMicro, maxVisitorMicro: 0 }; }
    catch { return { reason: 'budget denied' }; }
    if (feature === 'voice' && !options.existingCall) {
      const reason = voiceCap?.reason(amounts.maxMilliseconds);
      if (reason) return { reason };
    }
    if (visual(feature) && !options.existingCall && !storage.canStoreConcept(session.id, feature === 'html' ? MAX_HTML_BYTES : undefined)) return { reason: 'concept storage limit' };
    if (visual(feature) && !options.existingCall && renderLimiter.reason(session.id)) return { reason: renderLimiter.reason(session.id) };
    if (!options.existingCall) {
      const wallet = session.ownerHash && ownerWallet?.(session);
      const ledgerAllowed = budget.canAdmit(session.id, amounts.maxMicro, amounts.maxVisitorMicro);
      const ownerAllowed = wallet?.canAdmit(amounts) !== false;
      if (!ledgerAllowed || !ownerAllowed) {
        const onlyReconciling = (ledgerAllowed || budget.canAdmitWithoutReconcilingHold?.(session.id, amounts.maxMicro, amounts.maxVisitorMicro) === true) &&
          (ownerAllowed || wallet.canAdmitWithoutReconcilingHold?.(amounts) === true);
        return { reason: onlyReconciling ? 'budget reconciling' : 'budget denied' };
      }
    }
    return { binding, plugin, operation, coverage, scope };
  }
  async function evaluateUploads(session, preset, options = {}) {
    const config = presets[preset], bindings = config?.extractors;
    if (!config) return { reason: 'preset not configured' };
    if (!Array.isArray(bindings) || !bindings.length) return { reason: 'extractors not configured' };
    if (session.paused) return { reason: 'session paused' };
    if (session.tombstone || session.consentWithdrawn) return { reason: CONSENT };
    // Reuse precisely the selected reasoning scopes, including file-text. Local
    // extraction never broadens a provider grant or creates a new legal item.
    for (const feature of ['text', 'analysis']) {
      if (feature === 'analysis' && !selectedBinding(session, preset, 'understanding').raw) continue;
      const result = await evaluate(session, preset, feature, { ...options, existingCall: true });
      if (result.reason) return result;
      if (result.scope !== MOCK_PROCESSING_SCOPE && !result.scope?.dataCategories.includes('file-text')) return { reason: 'document text not covered by reasoning scope' };
    }
    const plugins = [];
    for (const binding of bindings) {
      if (!binding || Object.keys(binding).some(k => !['plugin', 'limits'].includes(k)) || !config.plugins?.includes(binding.plugin)) return { reason: 'extractor not in preset' };
      const plugin = registry.get(binding.plugin);
      try { assertExtractor(plugin); normalizeExtractorLimits(binding.limits); } catch { return { reason: 'extractor binding invalid' }; }
      if (plugin.manifest.placement !== 'server' || plugin.manifest.models.some(m => m.processingLocations.some(l => l !== 'host') ||
        m.cost.inputMicro !== 0 || m.cost.outputMicro !== 0)) return { reason: 'extractor must be local and free' };
      try { if (!(await plugin.health(options))?.available) return { reason: 'extractor unhealthy' }; } catch { return { reason: 'extractor unhealthy' }; }
      plugins.push({ plugin, binding });
    }
    return { plugins };
  }
  async function boundedEvaluate(session, preset, feature, options = {}) {
    const clock = options.now ?? now;
    const bounded = { ...options, now: clock, deadlineAt: Math.min(options.deadlineAt ?? Infinity, clock() + healthMs) };
    const scope = operationScope(bounded);
    let abort;
    try {
      const expired = new Promise(resolve => { abort = () => resolve({ reason: 'admission deadline' });
        scope.signal.addEventListener('abort', abort, { once: true }); if (scope.signal.aborted) abort(); });
      return await Promise.race([evaluate(session, preset, feature, { ...bounded, signal: scope.signal }), expired]);
    } finally { scope.signal.removeEventListener('abort', abort); scope.dispose(); }
  }
  // Resolve by the admitted scope, never an option id that the host can rebind.
  // Local mock scopes use the same path and existing-call evaluation as providers.
  async function publicationStatus(session, { signal, deadlineAt = now() + healthMs, operation = 'generate',
    visualKind: selected = visualKind(session), visuals, artifactId, consentScope } = {}) {
    const current = storage.get(session.id), preset = current.processingPreset ?? 'best';
    if (current.tombstone || current.consentWithdrawn || current.ownerHash !== session.ownerHash ||
      current.consentRevision !== session.consentRevision) return 'consent';
    const artifact = artifactId ? current.concepts?.find(item => item.id === artifactId) : null;
    if (artifactId && (!artifact || artifact.consentPurpose && !storage.conceptConsentScope?.(session.id, artifactId))) return 'unavailable';
    const admitted = consentScope ?? (artifactId ? storage.conceptConsentScope?.(session.id, artifactId) : null);
    const config = presets[preset], choices = choicesFor(preset);
    const offered = config?.choices ? (choices?.visuals ?? []).filter(option => option.kind === selected && option.binding)
      : config?.bindings?.[selected] ? [{ binding: config.bindings[selected] }] : [];
    const candidates = admitted ? offered.filter(({ id, binding: raw }) => {
      // The shared local scope carries no provider identity. Preserve its
      // recorded producer constraint as well as the exact scope match; another
      // local option cannot vouch for a removed producer. This never skips gates.
      const producer = artifact?.visuals ?? visuals;
      if (!admitted.plugin && producer && config?.choices && id !== producer) return false;
      try {
        const binding = selected === 'images' ? createImageBinding(raw) : createBinding(raw), plugin = registry.get(binding.plugin);
        const scope = plugin && !plugin.bind && localImplementation(plugin, selected) && free(binding)
          ? MOCK_PROCESSING_SCOPE : processingScope(binding, operation);
        return hash(scope) === hash(admitted);
      } catch { return false; }
    }) : artifactId ? [{ binding: artifact.visuals
      ? choices?.visuals.find(option => option.id === artifact.visuals && option.kind === selected)?.binding
      : config?.bindings?.[selected] }].filter(option => option.binding)
      : offered.filter(option => visuals === undefined || option.id === visuals);
    let refusal = 'unavailable';
    for (const { binding: raw } of candidates) {
      const result = await boundedEvaluate({ ...current, paused: false }, preset, selected,
        { signal, deadlineAt, operation, existingCall: true, raw });
      const latest = storage.get(session.id);
      if (signal?.aborted || latest.tombstone || latest.consentWithdrawn || latest.ownerHash !== session.ownerHash ||
        latest.consentRevision !== session.consentRevision) return 'consent';
      if (!result.reason && (!admitted || result.scope && hash(result.scope) === hash(admitted))) return 'allowed';
      if (isConsentReason(result.reason)) refusal = 'consent';
    }
    return refusal;
  }
  // Public facts only: ids, labels, manifest technical facts and host summaries.
  // Endpoints, accounts, secrets, rates and legal terms stay here.
  function facts(raw, preset, option = {}) {
    const plugin = raw && registry.get(raw.plugin), manifest = plugin?.manifest;
    const model = manifest?.models.find(m => m.id === raw.model) ?? manifest?.models.find(m => m.id === '*');
    const config = presets[preset], bindings = option.bindings ? Object.values(option.bindings).filter(Boolean) : [raw];
    // Reuse admission's full evidence/legal verdict at the current host time.
    const hostQualified = bindings.length > 0 && bindings.every(binding => config?.plugins?.includes(binding?.plugin) &&
      bindingReason({ binding, plugin: registry.get(binding.plugin), preset, policy: config.policy, now: now() }) === null);
    return { vendor: manifest?.vendor.name ?? null, plugin: raw?.plugin ?? null, model: raw?.model ?? null,
      qualification: model?.qualification ?? 'unverified', processingLocations: [...(model?.processingLocations ?? ['unverified'])],
      streaming: model?.streaming ?? false, structured: model?.structured ?? false, germanQuality: model?.germanQuality ?? 'unverified',
      efforts: [...(model?.efforts ?? [])], operations: [...(model?.operations ?? [])], formats: [...(model?.formats ?? [])],
      cost: model ? structuredClone(model.cost) : null, free: free(raw),
      ...(hostQualified ? { hostQualified: true, ...(raw?.plugin === 'grok-voice' && !raw.legal.processingCountries ? {} : { hostCountries: [...new Set(bindings.flatMap(b => b.legal.countries))] }),
        hostTraining: bindings.some(b => b.legal.training),
        hostPriceReviewed: bindings.every(b => registry.get(b.plugin).priceReviewed?.(b.model) === true) } : {}),
      ...(manifest?.liveVoice ? { capabilities: structuredClone(manifest.liveVoice.capabilities), reasoning: manifest.liveVoice.reasoning } : {}),
      ...(option.quality ? { quality: structuredClone(option.quality) } : {}) };
  }
  const status = reason => !reason ? 'available' : isConsentReason(reason) ? 'consent'
    : isDynamicReason(reason) ? 'limited' : 'unavailable';
  const label = (option, raw) => option.label ?? raw?.model ?? option.id;
  function policyFacts(preset) {
    const policy = presets[preset]?.policy ?? {};
    return { residency: preset === 'eu' ? 'eu' : null, countries: Array.isArray(policy.countries) ? [...policy.countries] : null,
      noTraining: preset === 'eu' || Boolean(policy.noTraining) };
  }
  // Static host policy: a visitor may store a choice whose remaining refusal is dynamic.
  async function check(session, preset, settings) {
    const candidate = { ...session, paused: false, processingPreset: preset, settings: { ...session.settings, ...settings } };
    const selection = selectionFor(candidate, preset);
    // Both reasoning lanes run the chosen model and effort; each passes on its own
    // (effort, operation and evidence), so a split binding cannot hide a refusal.
    for (const [field, feature, active] of [['model', 'text', true], ['model', 'analysis', Boolean(selection.model?.bindings.understanding)],
      ['voice', 'voice', settings.voice !== SETTINGS_OFF], ['visuals', visualKind(candidate), settings.visuals !== SETTINGS_OFF]]) {
      if (!active) continue;
      const result = await boundedEvaluate(candidate, preset, feature);
      if (result.reason && !isDynamicReason(result.reason)) return { field, reason: result.reason, selection };
    }
    return { selection };
  }
  let laneDiagnostic = () => {};
  const emitOutcome = (lane, outcome, reason, providerErrorClass) => {
    try { Promise.resolve(laneDiagnostic({ event: `${lane === 'reaction' ? 'reply' : lane}.${outcome}`, count: 1, lane,
      ...(reason ? { reason } : {}), ...(['4xx', '5xx'].includes(providerErrorClass) ? { providerErrorClass } : {}) })).catch(() => {}); } catch { /* Diagnostics cannot interrupt paid work. */ }
  };
  const runtime = {
    now: () => now(),
    setLaneDiagnostic(callback) { laneDiagnostic = callback; },
    budget, voiceCap, consent, visualKind, renderLimiter, selectionKey, choicesFor, conversationLimits,
    admitVoiceComponent: request => componentAccounting.admit(request),
    voiceServerAdapters: () => registry.list().flatMap(plugin => {
      const adapter = (localVoiceImplementation(plugin) ?? plugin).ports?.serverAdapter;
      return adapter ? [adapter] : [];
    }),
    setOwnerWallet(provider) { ownerWallet = provider; },
    setHostClock(clock) { now = configuredNow ?? clock; budget.now = clock; storage.setHostClock?.(clock); },
    recoverCosts() { return Promise.all(registry.list().map(plugin => plugin.recoverCosts?.())); },
    async reconcileCosts(options = {}) {
      // OPS and the background worker share one writer. A dry-run performs only
      // receipt reads; it never records evidence, changes a balance or releases a cap.
      if (costJob) { await costJob; return this.reconcileCosts(options); }
      const run = async () => {
        const rows = [...budget.pendingCosts(), ...budget.deferredCosts(now())], limit = options.limit ?? 10;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid reconciliation batch');
        const count = Math.min(limit, rows.length), summary = { candidates: 0, beforeMicro: 0, afterMicro: 0, corrected: 0, pending: 0 };
        // Receipt lookups have an elapsed transport budget, independent of the
        // policy clock used for retry eligibility and evidence age above/below.
        for (let i = 0; i < count && !options.signal?.aborted && Date.now() < (options.deadlineAt ?? Infinity); i++) {
          const row = rows[(costRetryOffset + i) % rows.length];
          let record = row.provider_cost_json ? JSON.parse(row.provider_cost_json) : null;
          if (!record && ['reaction', 'understanding'].includes(row.lane)) {
            // Pre-AIT-134 rows have no receipt metadata. Their original terminal
            // remains untouched; an explicit estimate is attached as new evidence.
            try {
              const session = storage.get(row.session_id), raw = selectedBinding(session, session.processingPreset ?? 'best', row.lane).raw;
              if (raw?.plugin === 'openrouter') {
                const plugin = registry.get(raw.plugin)?.bind?.(createBinding(raw));
                // Historical requests have lost their prompt bound. Use the
                // configured technical input ceiling and full lane output budget,
                // capped by the original call maximum; observed usage floors it.
                const estimateMicro = Math.min(row.max_micro, raw.maxInputTokens === undefined ? raw.maxMicro
                  : plugin?.usageCost?.({ inputTokens: raw.maxInputTokens, outputTokens: raw.maxTokens }) ?? raw.maxMicro);
                record = { plugin: raw.plugin, endpoint: raw.endpoint, model: raw.model,
                  secretRef: raw.secretRef, accountRef: raw.accountRef, estimateMicro, settledAt: 0 };
              }
            } catch { summary.pending++; continue; }
          }
          const plugin = record && registry.get(record.plugin);
          // A removed provider cannot service its scheduled retry. Erased sessions
          // may retire with their existing conservative receipt; live receipts stay
          // retryable if the host restores the plugin. Never fabricate settlement.
          if (!plugin && record?.retryAt != null && storage.get(row.session_id).tombstone) {
            summary.candidates++; summary.beforeMicro += row.settled_micro; summary.afterMicro += row.settled_micro;
            if (!options.dryRun) budget.acknowledgeCost(row.attempt_id);
            continue;
          }
          if (!plugin?.reconcileCost) { summary.pending++; continue; }
          const usage = row.usage ? JSON.parse(row.usage) : null;
          if (usage && ['inputTokens', 'outputTokens'].every(k => Number.isSafeInteger(usage[k]) && usage[k] >= 0)) {
            try { record.observedCostMicro = Math.max(record.observedCostMicro ?? 0, plugin.usageCost?.(usage, record.model) ?? 0); }
            catch { summary.pending++; continue; } // Unknown price cannot turn existing usage into free spend.
          }
          summary.candidates++; summary.beforeMicro += row.settled_micro;
          let evidence, saved;
          try { saved = await plugin.costEvidence?.(row.attempt_id); }
          catch { /* The receipt endpoint is still eligible; an absent cap journal is not zero usage. */ }
          if (saved) record = { ...record, ...saved };
          const previous = row.cost_reconciliation_json ? JSON.parse(row.cost_reconciliation_json) : null;
          if (record.chargedMicro !== undefined) evidence = { chargedMicro: record.chargedMicro, ...(record.generationId ? { generationId: record.generationId } : {}) };
          else if (previous && previous.estimated !== true) evidence = previous;
          else if (row.outcome !== 'uncertain') evidence = { chargedMicro: row.settled_micro, ...(record.generationId ? { generationId: record.generationId } : {}) };
          else {
            if ((record.retryAttempts ?? 0) < COST_ESTIMATE_ATTEMPTS) {
              try { evidence = await plugin.reconcileCost(record, { ...options, now: Date.now, deadlineAt: Math.min(options.deadlineAt ?? Infinity, Date.now() + 5000) }); }
              catch { /* Timeouts and unavailable generations reach the same bounded fallback. */ }
            }
            if (!evidence && now() - (record.settledAt ?? 0) >= costReconciliationWindowMs) {
              const estimate = record.estimateMicro ?? plugin.uncertainEstimateMicro;
              if (Number.isSafeInteger(estimate) && estimate >= 0) evidence = {
                chargedMicro: Math.max(estimate, record.observedCostMicro ?? 0, previous?.estimated ? previous.chargedMicro : 0),
                estimated: true, source: 'configured-call-estimate', estimateMicro: estimate,
                observedCostMicro: record.observedCostMicro ?? 0, windowMs: costReconciliationWindowMs, ...(record.generationId ? { generationId: record.generationId } : {}) };
            }
          }
          summary.afterMicro += evidence?.chargedMicro ?? row.settled_micro;
          if (!evidence) { summary.pending++; continue; }
          if (options.dryRun) continue;
          try {
            if (!row.provider_cost_json) budget.attachCost(row.attempt_id, record);
            if (saved && Object.keys(saved).length) budget.observeCost(row.attempt_id, saved);
            const before = row.cost_reconciliation_json;
            budget.reconcileCost(row.attempt_id, evidence);
            if (before !== budget.get(row.attempt_id).cost_reconciliation_json || row.settled_micro !== evidence.chargedMicro) summary.corrected++;
            if (evidence.estimated !== true) {
              await plugin.reconcileSpend?.(row.attempt_id, evidence.chargedMicro);
              budget.acknowledgeCost(row.attempt_id);
            } else {
              // Persist the bounded slower retry count across restart. Fresh
              // evidence can still requeue exhausted estimates for correction;
              // it cannot start another cycle of generation lookups.
              const retryAttempts = record.generationId ? Math.min(COST_ESTIMATE_ATTEMPTS, (record.retryAttempts ?? 0) + 1) : 0;
              budget.acknowledgeCost(row.attempt_id,
                record.generationId && retryAttempts < COST_ESTIMATE_ATTEMPTS ? now() + costReconciliationWindowMs : null, retryAttempts);
              summary.pending++;
            }
          } catch { summary.pending++; /* The durable evidence is retried after a crash or cap settlement failure. */ }
        }
        if (!options.dryRun) costRetryOffset = rows.length ? (costRetryOffset + count) % rows.length : 0;
        return summary;
      };
      costJob = run();
      try { return await costJob; } finally { costJob = undefined; }
    },
    /** Revalidate a dispatched operation's admitted scope against the current grant. */
    async processingAllowed(session, consentScope, options = {}) {
      const clock = options.now ?? now;
      options = { ...options, now: clock, deadlineAt: Math.min(options.deadlineAt ?? Infinity, clock() + healthMs) };
      const scope = operationScope(options);
      try {
        const current = storage.get(session.id);
        if (current.tombstone || current.consentWithdrawn || current.ownerHash !== session.ownerHash) return false;
        if (consentScope) {
          const coverage = await untilCancelled(coverageFor(current, consentScope, { ...options, signal: scope.signal }), scope.signal);
          if (consentReason(coverage, consentScope, now(), current.consentRevision)) return false;
        }
        const latest = storage.get(session.id);
        return !scope.signal.aborted && !latest.tombstone && !latest.consentWithdrawn && latest.ownerHash === session.ownerHash &&
          latest.consentRevision === current.consentRevision;
      } catch { return false; }
      finally { scope.dispose(); }
    },
    async uploadAvailability(session, options = {}) {
      return boundedEvaluate(session, session.processingPreset ?? 'best', 'uploads', options);
    },
    async extractUpload({ session, uploadId, bytes, metadata, options = {} }) {
      const current = () => {
        const latest = storage.get(session.id);
        return !latest.tombstone && !latest.consentWithdrawn && latest.ownerHash === session.ownerHash &&
          (latest.conversationConsentRevision ?? latest.consentRevision) === (session.conversationConsentRevision ?? session.consentRevision) &&
          selectionKey(latest, 'reaction') === selectionKey(session, 'reaction') &&
          latest.uploads.some(u => u.id === uploadId && u.state === 'pending');
      };
      if (!current()) throw new PluginError('not-admitted');
      const admission = await runtime.uploadAvailability(session, options);
      if (admission.reason || !current()) throw new PluginError('not-admitted', admission.reason);
      const admitted = admission.plugins.find(({ plugin }) => plugin.manifest.models.some(m => m.formats.includes(metadata.mediaType)));
      if (!admitted) throw new PluginError('invalid-output');
      const { plugin, binding } = admitted;
      const { attemptId } = budget.admit({ sessionId: session.id, lane: 'extractor', maxMicro: 0,
        requestSha256: createHash('sha256').update(bytes).digest('hex'), bindingSha256: hash(binding) });
      const claim = budget.claim(attemptId);
      const invocation = await beginInvocation({ ...options, attempt: { ...claim, async consume() {
        try {
          const check = await runtime.uploadAvailability(storage.get(session.id), options);
          if (check.reason || !current()) throw new PluginError('not-admitted');
          options.signal?.throwIfAborted(); claim.consume();
        } catch (error) {
          budget.settle(claim.claimId, { attemptId, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } }, { inputMicro: 0, outputMicro: 0 });
          throw error;
        }
      } }, report: terminal => budget.settle(claim.claimId, terminal, { inputMicro: 0, outputMicro: 0 }) });
      try {
        invocation.dispatch();
        const extractor = createExtractor({ plugins: [plugin], limits: binding.limits });
        const result = await extractor.extract(bytes, metadata, options);
        invocation.usage({ inputTokens: 0, outputTokens: 0 });
        options.signal?.throwIfAborted();
        if (!current()) throw new PluginError('cancelled');
        await invocation.finish(true);
        return { ...result, extractor: plugin.manifest.id };
      } catch (error) { await invocation.finish(false); throw error; }
    },
    // Host capability is independent of the selected preset, pause, consent and admission.
    visualsBound: () => PROCESSING_PRESETS.some(preset => choicesFor(preset)?.visuals.some(option => Boolean(option.binding))),
    /** Hosts withhold On my device with `presets.device = false`; other presets exist when configured. */
    offered: preset => preset === 'device' ? presets.device !== false : Boolean(presets[preset]),
    async matrix(session) {
      const matrix = {};
      for (const preset of PROCESSING_PRESETS) {
        if (preset === 'device') {
          matrix[preset] = presets.device === false ? Object.fromEntries(FEATURES.map(f => [f, featureUnavailable('preset not configured')])) : deviceFeatures();
          continue;
        }
        matrix[preset] = {};
        for (const feature of FEATURES) {
          const result = await boundedEvaluate(session, preset, feature);
          matrix[preset][feature] = result.reason ? featureUnavailable(result.reason) : { available: true, reason: null };
          if (visual(feature)) matrix[preset][feature].consentPurposes = [...new Set(runtime.scopes({ ...session, processingPreset: preset,
            settings: preset === (session.processingPreset ?? 'best') ? session.settings : {}, concepts: [] }, { feature }).map(scope => scope.purpose))];
          // Paused reloads and acknowledged takebacks need the ordinary stage
          // and composer verdicts. This is presentation only: admission and
          // the outer verdict stay paused.
          if ((visual(feature) || feature === 'analysis' || feature === 'text') && result.reason === 'session paused') {
            const unpaused = await boundedEvaluate({ ...session, paused: false }, preset, feature);
            matrix[preset][feature].unpaused = { ...(unpaused.reason ? featureUnavailable(unpaused.reason) : { available: true, reason: null }),
              ...(visual(feature) ? { consentPurposes: matrix[preset][feature].consentPurposes } : {}) };
          }
        }
      }
      return matrix;
    },
    /** Public label summary of the effective choice for snapshots and transcripts. */
    describe(session) {
      const preset = session.processingPreset ?? 'best', origin = session.settings?.origin ?? 'default';
      if (preset === 'device') return { preset, model: null, effort: null, voice: SETTINGS_OFF, visuals: SETTINGS_OFF, origin };
      const s = selectionFor(session, preset);
      if (!s.choices) return { preset, model: null, effort: null, voice: SETTINGS_OFF, visuals: SETTINGS_OFF, origin };
      const reaction = s.model?.bindings.reaction ?? s.model?.bindings.understanding;
      const named = (option, id) => id === SETTINGS_OFF ? SETTINGS_OFF : { id, label: option ? label(option, option.binding) : id, offered: Boolean(option) };
      return { preset, origin, effort: s.effort ?? reaction?.effort ?? null,
        model: s.modelId ? { id: s.modelId, label: s.model ? label(s.model, reaction) : s.modelId,
          reply: reaction?.model ?? null, understanding: s.model?.bindings.understanding?.model ?? null, provider: reaction?.plugin ?? null,
          vendor: reaction ? registry.get(reaction.plugin)?.manifest.vendor.name ?? null : null, offered: Boolean(s.model) } : null,
        voice: named(s.voice, s.voiceId), visuals: named(s.visuals, s.visualsId) };
    },
    /** Every offered choice with public facts and its current verdict for this session. */
    async catalog(session) {
      const presetsOut = {};
      await Promise.all(PROCESSING_PRESETS.map(async preset => {
        if (preset === 'device') { const offered = presets.device !== false;
          presetsOut.device = { offered, status: offered ? 'available' : 'unavailable', reason: offered ? null : 'preset not configured' }; return; }
        const config = presets[preset], choices = choicesFor(preset);
        if (!config || !choices) { presetsOut[preset] = { offered: false, status: 'unavailable', reason: config ? 'preset choices invalid' : 'preset not configured' }; return; }
        // The current preset keeps the visitor's choice (delegated voice uses it); others show defaults.
        const probe = preset === (session.processingPreset ?? 'best') ? session : { ...session, processingPreset: preset, settings: {} };
        const verdict = async (feature, raw) => raw ? (await boundedEvaluate(probe, preset, feature, { raw })).reason ?? null : 'not configured';
        const models = await Promise.all(choices.models.map(async option => {
          const reaction = option.bindings.reaction, understanding = option.bindings.understanding, raw = reaction ?? understanding;
          const f = facts(raw, preset, option), effort = option.efforts ? option.effort : null;
          const supported = [reaction, understanding].filter(Boolean).map(b => facts(b, preset).efforts);
          const withEffort = b => b && effort ? { ...b, effort } : b;
          const [textReason, analysisReason] = await Promise.all([verdict('text', withEffort(reaction)), verdict('analysis', withEffort(understanding))]);
          return { id: option.id, label: label(option, raw), configured: Boolean(raw),
            efforts: option.efforts ? option.efforts.filter(e => supported.every(list => list.includes(e))) : [], effort,
            facts: f, status: status(textReason), reason: textReason, features: { text: textReason, analysis: analysisReason } };
        }));
        const optional = (list, feature) => Promise.all(list.map(async option => {
          const reason = option.id === 'grok-voice' && !option.binding ? 'grok-account-not-configured' : await verdict(option.kind ?? feature, option.binding);
          return { id: option.id, label: label(option, option.binding), ...(option.kind ? { kind: option.kind } : {}), configured: Boolean(option.binding),
            facts: { ...facts(option.binding ?? { plugin: option.id }, preset),
              providerProcessing: providerProcessingFacts(option.binding, { plugin: registry.get(option.binding?.plugin ?? option.id), preset, policy: config.policy, now: now() }),
              ...(option.binding?.plugin === 'grok-voice' || option.id === 'grok-voice' ? { liveQualification: 'unverified', consentItem: { id: 'voice-xai', version: 1 } } : {}) }, status: status(reason), reason };
        }));
        const [voices, visuals, base] = await Promise.all([optional(choices.voices, 'voice'), optional(choices.visuals, 'images'),
          boundedEvaluate({ ...probe, settings: {} }, preset, 'text')]);
        presetsOut[preset] = { offered: true, status: status(base.reason), reason: base.reason ?? null, legacy: choices.legacy,
          defaults: { ...choices.defaults }, policy: policyFacts(preset), models, voices, visuals };
      }));
      return { processingPreset: session.processingPreset ?? 'best', settings: structuredClone(session.settings ?? null),
        engine: runtime.describe(session), presets: presetsOut };
    },
    /**
     * Validates a visitor request against the host allowlist and static policy.
     * Unset fields keep the current choice for the same preset, else its defaults.
     */
    async validate(session, body) {
      const keys = ['processingPreset', 'model', 'effort', 'voice', 'visuals', 'baseRevision', 'confirm'];
      const invalid = { status: 400, error: 'invalid-settings' };
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !keys.includes(k))) return invalid;
      const preset = body.processingPreset ?? session.processingPreset ?? 'best';
      if (!PROCESSING_PRESETS.includes(preset) || ['model', 'voice', 'visuals'].some(k => body[k] !== undefined && body[k] !== null && !isOptionId(body[k])) ||
        body.effort !== undefined && body.effort !== null && !EFFORT_ORDER.includes(body.effort) ||
        body.baseRevision !== undefined && (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0) ||
        body.confirm !== undefined && typeof body.confirm !== 'boolean') return invalid;
      const refuse = (field, reason) => ({ status: 409, error: 'setting-not-allowed', field, reason });
      if (preset === 'device') {
        if (presets.device === false) return refuse('processingPreset', 'preset not configured');
        if (body.model || body.effort || [body.voice, body.visuals].some(v => v && v !== SETTINGS_OFF)) return refuse(body.model || body.effort ? 'model' : 'voice', 'unavailable on device');
        return { processingPreset: preset, settings: { model: null, effort: null, voice: SETTINGS_OFF, visuals: SETTINGS_OFF } };
      }
      const choices = choicesFor(preset);
      if (!presets[preset] || !choices) return refuse('processingPreset', presets[preset] ? 'preset choices invalid' : 'preset not configured');
      if (!choices.models.length) return refuse('processingPreset', 'not configured');
      const same = preset === (session.processingPreset ?? 'best'), base = selectionFor(same ? session : { ...session, processingPreset: preset, settings: {} }, preset);
      const modelId = body.model ?? base.modelId, option = choices.models.find(o => o.id === modelId);
      if (!modelId) return refuse('model', 'not configured');
      if (!option) return refuse('model', 'not offered');
      let effort = null;
      if (option.efforts) {
        if (body.effort && !option.efforts.includes(body.effort)) return refuse('effort', 'effort not offered');
        effort = body.effort ?? (modelId === base.modelId && option.efforts.includes(base.effort) ? base.effort : option.effort);
      } else if (body.effort && body.effort !== (option.bindings.reaction ?? option.bindings.understanding)?.effort) return refuse('effort', 'effort not offered');
      const settings = { model: modelId, effort };
      for (const [field, list] of [['voice', choices.voices], ['visuals', choices.visuals]]) {
        const id = body[field] ?? base[`${field}Id`];
        if (id !== SETTINGS_OFF && !list.some(o => o.id === id)) return refuse(field, 'not offered');
        if (id !== SETTINGS_OFF && !list.find(o => o.id === id).binding) return refuse(field, 'not configured');
        settings[field] = id;
      }
      const voice = choices.voices.find(o => o.id === settings.voice);
      if (voice?.binding?.plugin === 'grok-voice' && settings.voice !== base.voiceId) {
        const candidate = { ...session, processingPreset: preset, settings: { ...session.settings, ...settings } };
        const result = await boundedEvaluate(candidate, preset, 'voice', { raw: voice.binding });
        if (isConsentReason(result.reason)) return refuse('voice', result.reason);
      }
      const verdict = await check(session, preset, settings);
      if (verdict.reason) return refuse(verdict.field, verdict.reason);
      return { processingPreset: preset, settings };
    },
    /** Concrete defaults pinned at creation, so later host default changes never mix in. */
    defaults(preset) {
      if (preset === 'device') return { model: null, effort: null, voice: SETTINGS_OFF, visuals: SETTINGS_OFF };
      const choices = choicesFor(preset);
      if (!choices) return { model: null, effort: null, voice: null, visuals: null };
      const model = choices.models.find(o => o.id === choices.defaults.model);
      return { model: choices.defaults.model, effort: model?.efforts ? choices.defaults.effort ?? model.effort : null,
        voice: choices.defaults.voice, visuals: choices.defaults.visuals };
    },
    /** Grants include today's choice and producers; documents use producers per delivered kind. */
    scopes(session, { feature: only, delivered: coverageOnly = false } = {}) {
      const preset = session.processingPreset ?? 'best';
      const result = [], kind = visualKind(session);
      const artifacts = (session.concepts ?? []).filter(artifact => !artifact.erased && !artifact.withdrawn && !artifact.archived);
      const deliveredKinds = new Set(artifacts.map(artifact => artifact.mediaType === 'text/html' ? 'html' : 'images'));
      const entries = [['text', 'stream'], ['analysis', 'structured'], ['voice', 'start'], [kind, 'generate'], [kind, 'edit']]
        .filter(([feature]) => preset !== 'device' && (!coverageOnly || !deliveredKinds.has(feature)))
        .map(([feature, operation]) => ({ feature, operation, raw: selectedBinding(session, preset, map[feature][0]).raw }));
      const unresolved = new Set();
      for (const artifact of artifacts) {
        const feature = artifact.mediaType === 'text/html' ? 'html' : 'images';
        if (only && feature !== only) continue;
        const scope = storage.conceptConsentScope?.(session.id, artifact.id);
        if (artifact.consentPurpose) {
          // The purpose is public provenance; the exact admitted scope stays private.
          const producer = coverageOnly ? { purpose: artifact.consentPurpose } : scope;
          if (producer && !result.some(s => hash(s) === hash(producer))) result.push(structuredClone(producer));
          else if (!producer) unresolved.add(feature);
          continue;
        }
        // Legacy artifacts resolve against today's binding, never another offered option.
        const raw = artifact.visuals
          ? choicesFor(preset)?.visuals.find(option => option.id === artifact.visuals && option.kind === feature)?.binding
          : presets[preset]?.bindings?.[feature];
        for (const operation of ['generate', 'edit']) entries.push({ feature, operation, raw, producer: true });
      }
      for (const { feature, operation, raw, producer } of entries) {
        if (only && feature !== only) continue;
        const reject = () => { if (producer) unresolved.add(feature); };
        if (!raw || !presets[preset]?.plugins?.includes(raw.plugin)) { reject(); continue; }
        let binding; try { binding = feature === 'voice' ? durationBinding(raw) : feature === 'images' ? createImageBinding(raw) : createBinding(raw); } catch { reject(); continue; }
        const plugin = registry.get(binding.plugin);
        const model = plugin?.manifest.models.find(m => m.id === binding.model) ?? plugin?.manifest.models.find(m => m.id === '*');
        if (!model || feature === 'html' && !model.formats.includes('text/html')) { reject(); continue; }
        if (!model.operations.includes(operation) || operation === 'stream' && !model.streaming || operation === 'structured' && !model.structured) continue;
        const scope = registry.isCanonicalMock(plugin) || !plugin.bind && localImplementation(plugin, feature) ? MOCK_PROCESSING_SCOPE : binding.legal ? processingScope(binding, operation) : null;
        if (!scope) reject();
        if (scope && !result.some(s => hash(s) === hash(scope))) result.push(structuredClone(scope));
        if (feature === 'voice') for (const child of plugin?.ports?.serverAdapter?.processingScopes?.() ?? []) {
          if (!result.some(s => hash(s) === hash(child))) result.push(structuredClone(child));
        }
      }
      if (coverageOnly && only && unresolved.has(only)) return [];
      const voice = selectedBinding(session, preset, 'voice').raw;
      if (only === 'voice' && registry.get(voice?.plugin)?.manifest.liveVoice?.reasoning === 'delegated') {
        for (const scope of runtime.scopes(session, { feature: 'text' })) if (!result.some(s => hash(s) === hash(scope))) result.push(scope);
      }
      return result;
    },
    async checkVoice(session, { allowPaused = false, ...options } = {}) {
      conversationLimits.assertOpen(session.id);
      const result = await boundedEvaluate(allowPaused ? { ...session, paused: false } : session,
        session.processingPreset ?? 'best', 'voice', options);
      const current = storage.get(session.id);
      conversationLimits.assertOpen(session.id);
      if (result.configurationError) throw fastReactionRefusal(result.configurationError);
      if (result.reason || current.ownerHash !== session.ownerHash || current.tombstone || current.consentWithdrawn ||
        (!allowPaused && current.paused) || voiceAuthorizationRevision(current) !== voiceAuthorizationRevision(session) ||
        selectionKey(current, 'voice') !== selectionKey(session, 'voice')) throw new PluginError('not-admitted', result.reason === 'budget denied' ? 'host-limit' : result.reason ?? 'Session changed');
      return result;
    },
    /** Publication resolves provenance against today's full binding gate. */
    async publicationAllowed(session, options) {
      return await publicationStatus(session, options) === 'allowed';
    },
    publicationStatus,
    // The visitor's own visuals choice prices the concept, never a preset-wide binding.
    imageQuote(session) {
      try { const kind = visualKind(session), raw = selectedBinding(session, session.processingPreset ?? 'best', kind).raw;
        return { maxMicro: (kind === 'images' ? createImageBinding(raw) : createBinding(raw)).maxMicro }; }
      catch { return null; }
    },
    stopReplyReplay,
    stopReplyReplays() { for (const id of replyReplays.keys()) stopReplyReplay(id); },
    async speakText({ session, turnId, options = {} }) {
      if (replyReplays.has(session.id)) return { kind: 'busy' };
      const lease = { replayId: options.replayId ?? randomUUID(), controller: new AbortController(), signal: options.signal };
      replyReplays.set(session.id, lease);
      lease.abort = () => releaseReplyReplay(session.id, lease);
      lease.signal?.addEventListener('abort', lease.abort, { once: true });
      lease.timer = setTimeout(lease.abort, 30_000); lease.timer.unref?.();
      options = { ...options, signal: lease.signal ? AbortSignal.any([lease.signal, lease.controller.signal]) : lease.controller.signal };
      let playing = false;
      try {
        const last = snapshot => snapshot.transcript.findLast(turn => turn.role === 'assistant' && !turn.erased && !turn.withdrawn && turn.content);
        const requested = snapshot => snapshot.transcript.findLast(turn => turn.id === turnId && turn.role === 'assistant' && !turn.erased && !turn.withdrawn && turn.content);
        const snapshot = storage.get(session.id), reply = requested(snapshot), latestAtStart = last(snapshot);
        const current = () => {
          const fresh = storage.get(session.id), latest = last(fresh), exact = requested(fresh);
          // Earlier replies are valid replay targets. Keep both their exact
          // bytes and the existing in-flight newer-reply/authority fences.
          if (!voiceUnchanged(session) || options.current?.() === false || exact?.id !== reply?.id || exact?.content !== reply?.content ||
              latest?.id !== latestAtStart?.id || latest?.content !== latestAtStart?.content) throw new PluginError('unavailable');
          options.signal?.throwIfAborted();
        };
        if (!reply || reply.id !== turnId) throw new PluginError('unavailable');
        current();
        const fallback = { kind: 'text', text: reply.content };
        if (!selectedBinding(session, session.processingPreset ?? 'best', 'voice').raw) return fallback;
        let result;
        try { result = await this.checkVoice(session, { ...options, existingCall: true, textReplay: true }); }
        catch (error) { current(); if (error.message === 'plugin unhealthy') return fallback; throw error; }
        const adapter = result.plugin.ports?.serverAdapter;
        if (!adapter?.quoteSpeakText || !adapter.speakText) return fallback;
        let quote;
        try { quote = await adapter.quoteSpeakText({ text: reply.content }, options); }
        catch { current(); return fallback; }
        current();
        if (!Number.isSafeInteger(quote?.maxMicro) || quote.maxMicro < 0) return fallback;
        let admission;
        try { admission = await admitBudget(session, { sessionId: session.id, lane: 'voice', maxMicro: quote.maxMicro,
          maxVisitorMicro: quote.maxMicro, requestSha256: hash({ turnId, text: reply.content }), bindingSha256: hash(result.binding) }); }
        catch (error) {
          if (error.code === 'not-admitted' && ['host-limit', 'session', 'voiceVisitor', 'Budget denied'].includes(error.message)) throw new PluginError('not-admitted', 'host-limit');
          throw error;
        }
        const { attemptId } = admission;
        const claim = budget.claim(attemptId); let dispatched = false, reported = false;
        const report = terminal => {
          if (reported) return; reported = true;
          const receipt = { ...terminal, attemptId };
          budget.settleVoice(claim.claimId, receipt);
          if (receipt.closureConfirmed && receipt.usage) this.reconcileVoice(attemptId, receipt);
        };
        try {
          const audio = await adapter.speakText({ text: reply.content, quote }, { ...options,
            attempt: { ...claim, async consume() {
              conversationLimits.assertOpen(session.id);
              current();
              if (result.scope) {
                const coverage = await coverageFor(session, result.scope, options);
                if (consentReason(coverage, result.scope, now(), session.consentRevision)) throw new PluginError('not-admitted');
              }
              conversationLimits.assertOpen(session.id);
              current(); claim.consume(); dispatched = true;
            } }, report });
          current();
          if (audio?.audio?.format !== 'pcm_16000' || typeof audio.audio.data !== 'string' || audio.audio.data.length > 5_592_408) return fallback;
          // HTTP response completion aborts the request signal. Playback instead
          // belongs to the call lifetime and its explicit, token-bound release.
          lease.signal?.removeEventListener('abort', lease.abort);
          lease.signal = options.playbackSignal;
          lease.signal?.throwIfAborted();
          lease.signal?.addEventListener('abort', lease.abort, { once: true });
          playing = true;
          clearTimeout(lease.timer);
          // PCM is bounded by the output contract; expiry also releases abandoned tabs.
          const durationMs = Buffer.from(audio.audio.data, 'base64').length / 32;
          lease.timer = setTimeout(lease.abort, Math.ceil(durationMs) + 30_000); lease.timer.unref?.();
          return { kind: 'audio', text: reply.content, turnId, replayId: lease.replayId, audio: audio.audio };
        } catch (error) {
          current();
          if (['not-admitted', 'already-claimed', 'cancelled', 'deadline'].includes(error.code)) throw error;
          return fallback;
        } finally {
          if (!reported) report({ outcome: 'uncertain', closureConfirmed: false, chargedMicro: dispatched ? quote.maxMicro : 0, usage: null });
        }
      } catch (error) { playing = false; throw error; }
      finally { if (!playing) releaseReplyReplay(session.id, lease); }
    },
    async admitVoice({ session, request, options = {} }) {
      options = { ...options, now: options.now ?? now };
      if (!voiceUnchanged(session, options.allowPaused)) throw new PluginError('not-admitted');
      const result = await this.checkVoice(session, options);
      if (!voiceUnchanged(session, options.allowPaused)) throw new PluginError('not-admitted');
      const { binding, plugin } = result;
      const { maxMicro, maxVisitorMicro, maxMilliseconds, fundedSeconds: initialFundedSeconds } = voiceAmounts(binding, options);
      let fundedSeconds = initialFundedSeconds;
      const { attemptId } = await admitBudget(session, { sessionId: session.id, lane: 'voice', maxMicro, maxVisitorMicro,
        voiceEstimate: { upstreamMicroPerMinute: binding.upstreamMicroPerMinute, visitorMicroPerMinute: binding.visitorMicroPerMinute },
        voiceExposure: { maxMicro: Math.max(maxMicro, Math.ceil(binding.maxDurationSeconds / 60 * binding.upstreamMicroPerMinute)),
          maxVisitorMicro: Math.max(maxVisitorMicro, Math.ceil(binding.maxDurationSeconds / 60 * binding.visitorMicroPerMinute)) },
        requestSha256: hash(request), bindingSha256: hash(binding) });
      const claim = budget.claim(attemptId); let reported = false, consuming = false, dispatched = false, reservation;
      const report = terminal => {
        const receipt = budget.settleVoice(claim.claimId, terminal); reported = true;
        if (reservation && receipt.outcome !== 'uncertain') {
          voiceCap.settle(reservation, JSON.parse(receipt.usage).providerSeconds);
        }
        return receipt;
      };
      const zero = () => report({ attemptId, outcome: 'cancelled', closureConfirmed: true, chargedMicro: 0,
        usage: { providerSeconds: 0, providerMinutes: 0, pausedSeconds: 0, visitorSeconds: 0, upstreamMicro: 0, visitorMicro: 0 } });
      // The owner/ledger await can finish just before expiry; a separate
      // aggregate reservation still requires current admission authority.
      try { conversationLimits.assertOpen(session.id); }
      catch (error) { zero(); throw error; }
      // Atomic aggregate admission precedes facade provisioning and provider credentials.
      try { reservation = voiceCap?.reserve({ attemptId, sessionId: session.id, callId: request.callId, maxMilliseconds }); }
      catch (error) { zero(); throw error; }
      const attempt = { ...claim, get maxMicro() { return budget.get(attemptId).max_micro; },
        get fundedSeconds() { return fundedSeconds; },
        get exposureMicro() { return budget.get(attemptId).voice_exposure_micro; },
        retainExposure: () => budget.retainVoiceExposure(attemptId),
        ...(binding.reservationSeconds ? { extend(seconds) {
          conversationLimits.assertOpen(session.id);
          // The runway is funded once at admission. Healthy extensions reserve
          // only elapsed + one segment, bounded by the technical end.
          const totalSeconds = Math.min(maxMilliseconds / 1000, seconds);
          const extended = budget.extendVoice(attemptId, { maxMicro: Math.ceil(totalSeconds / 60 * binding.upstreamMicroPerMinute),
            maxVisitorMicro: Math.ceil(totalSeconds / 60 * binding.visitorMicroPerMinute) }, (extra, context) => ownerWallet?.(session)?.canAdmit(extra, context));
          fundedSeconds = Math.max(fundedSeconds, totalSeconds);
          return extended;
        } } : {}), async consume() {
        if (reported || consuming) throw new PluginError('already-claimed');
        consuming = true;
        const assertOpen = () => conversationLimits.assertOpen(session.id);
        assertOpen();
        try {
          if (!voiceUnchanged(session, options.allowPaused)) throw new PluginError('not-admitted');
          if (result.scope) {
            const scope = operationScope(options);
            try {
              const coverage = await untilCancelled(coverageFor(session, result.scope, { ...options, signal: scope.signal }), scope.signal);
              if (consentReason(coverage, result.scope, now(), session.consentRevision)) throw new PluginError('not-admitted');
            } finally { scope.dispose(); }
          }
          options.signal?.throwIfAborted();
          assertOpen();
          if (!voiceUnchanged(session, options.allowPaused)) throw new PluginError('not-admitted');
          claim.consume(); dispatched = true;
        } catch { assertOpen(); zero(); throw new PluginError('not-admitted', 'Voice dispatch refused'); }
      } };
      return { plugin, binding, options: { ...options, attempt, report }, finish() {
        if (!reported) {
          if (dispatched) attempt.retainExposure();
          report({ attemptId, outcome: 'uncertain', closureConfirmed: false, chargedMicro: attempt.maxMicro });
        }
      } };
    },
    recoverVoiceCap() { voiceCap?.recover(); },
    reconcileVoice(attemptId, terminal) {
      const receipt = budget.reconcileVoice(attemptId, terminal);
      // Calls made before the cap existed have no aggregate reservation.
      if (voiceCap && storage.db.prepare('SELECT 1 FROM voice_cap_reservations WHERE attempt_id=?').get(attemptId)) {
        voiceCap.settle({ attemptId }, JSON.parse(receipt.voice_reconciliation_json).usage.providerSeconds);
      }
      return receipt;
    },
    // Availability only; the reaction lane still owns budget admission and dispatch.
    async checkReply(session, options = {}) {
      return (await boundedEvaluate(session, session.processingPreset ?? 'best', 'text', options)).reason ?? null;
    },
    async admit({ session, lane, operation, request, options = {} }) {
      options = { ...options, now: options.now ?? now };
      conversationLimits.assertOpen(session.id);
      const purposeAssessment = lane === 'understanding' && options.purposeAssessment === true &&
        Boolean(storage.purposeAssessmentInput(session));
      const invocationCurrent = () => unchanged(session, lane, false, purposeAssessment) && (lane !== 'concept' ||
        storage.get(session.id).conceptIntent?.pending?.id === session.conceptIntent?.pending?.id);
      const dispatchCurrent = () => (options.voiceReply === true && lane === 'reaction' ? unchanged(session, lane, true) : invocationCurrent()) &&
        options.beforeDispatch?.() !== false;
      // Ownership, revision and tombstone precede health, consent and budget work.
      if (!invocationCurrent()) throw new PluginError('not-admitted', 'Session changed during admission');
      if (lane === 'concept' && (!session.conceptIntent?.visualIntent || !session.conceptIntent.pending ||
        storage.get(session.id).conceptIntent?.pending?.id !== session.conceptIntent.pending.id)) throw new PluginError('not-admitted', 'Visual intent required');
      const selected = visualKind(session), html = lane === 'concept' && selected === 'html';
      if (lane === 'concept' && options.visualKind && options.visualKind !== selected) throw new PluginError('not-admitted', 'Visual kind changed');
      const result = await boundedEvaluate(purposeAssessment && session.pauseReason === 'purpose' ? { ...session, paused: false } : session, session.processingPreset ?? 'best', lane === 'concept' ? selected : lane === 'reaction' ? 'text' : 'analysis', { ...options, operation, costRequest: request });
      if (result.configurationError) throw fastReactionRefusal(result.configurationError);
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
      // HTML providers own prompt serialization and exact request pricing. A host
      // without an estimator reserves the entire admitted binding ceiling.
      const ceiling = html ? (plugin.estimateCost ? plugin.estimateCost(request, operation) : binding.maxMicro)
        : lane === 'concept' ? rates.maxInputTokens * rates.inputMicro + rates.maxOutputTokens * rates.outputMicro
        : plugin.estimateCost ? plugin.estimateCost(request, operation)
        : (promptBytes + 256 + (request.messages?.length ?? 0) * 64) * rates.inputMicro + binding.maxTokens * rates.outputMicro;
      const tokenCeiling = lane === 'concept' ? ceiling : (promptBytes + 256 + (request.messages?.length ?? 0) * 64) * rates.inputMicro + binding.maxTokens * rates.outputMicro;
      if (![ceiling, tokenCeiling].every(Number.isSafeInteger) || Math.max(ceiling, tokenCeiling) > binding.maxMicro) throw new PluginError('not-admitted', 'Request exceeds binding cost ceiling');
      if (operation !== result.operation) throw new PluginError('not-admitted');
      const { attemptId } = await admitBudget(session, { sessionId: session.id, lane, maxMicro: html || plugin.estimateCost ? ceiling : binding.maxMicro,
        ...(plugin.reconcileCost ? { providerCost: { plugin: binding.plugin, endpoint: binding.endpoint, secretRef: binding.secretRef, accountRef: binding.accountRef, model: binding.model, estimateMicro: plugin.estimateUncertainCost?.(request, operation) ?? plugin.uncertainEstimateMicro } } : {}),
        requestSha256: hash(html ? { ...request, previousArtifact: request.previousArtifact?.provenance.subject.contentDigest } : lane === 'concept' ? { prompt: request.prompt, feedback: request.feedback, references: request.references?.map(r => ({
          mediaType: r.mediaType, role: r.role, sha256: createHash('sha256').update(r.bytes).digest('hex') })) } : request), bindingSha256: hash(binding) });
      const diagnosticLane = options.voiceReply ? 'voice-facade' : lane;
      try { if (budget.startOutcome(attemptId, diagnosticLane)) emitOutcome(diagnosticLane, 'started'); }
      catch { /* Diagnostics cannot interrupt admission. */ }
      const claim = budget.claim(attemptId); let reported = false, refused = false, consuming = false, detached = false, settlementAborted = false, settlementDispatched = false;
      const producer = { model: binding.model, plugin: binding.plugin };
      const report = terminal => {
        if (reported) {
          // A lane released on cancellation owns settlement; late provider usage
          // cannot reopen or reduce its conservative dispatched charge.
          if (detached && terminal?.attemptId === attemptId) return;
          if (refused && isCancelledZeroReport(terminal, attemptId)) return;
          throw new PluginError('already-claimed');
        }
        settlementAborted = Boolean(options.signal?.aborted);
        settlementDispatched = budget.get(attemptId).state === 'dispatched';
        const settlement = budget.settle(claim.claimId, terminal, rates); reported = true;
        try { Promise.resolve(options.onTerminal?.({ outcome: settlement.outcome })).catch(() => {}); }
        catch { /* Diagnostics cannot interrupt settlement. */ }
        if (typeof terminal.servedModel === 'string' && terminal.servedModel.trim()) producer.model = terminal.servedModel;
        return settlement;
      };
      const refuse = reason => {
        assertDispatchOpen();
        report({ attemptId, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } });
        refused = true;
        throw new PluginError('not-admitted', reason);
      };
      const consume = () => lane === 'concept' ? renderLimiter.consume(attemptId, session.id, claim.consume) : claim.consume();
      const assertDispatchOpen = () => conversationLimits.assertOpen(session.id);
      const consumeOrRefuse = () => {
        try { return consume(); } catch (error) {
          report({ attemptId, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } }); refused = true; throw error;
        }
      };
      const attempt = Object.freeze({ ...claim, ...(plugin.reconcileCost ? {
        observeCost: evidence => budget.observeCost(attemptId, evidence), dispatchCost: () => budget.markCostDispatch(attemptId) } : {}), consume() {
        if (reported || consuming) throw new PluginError('already-claimed');
        assertDispatchOpen();
        if (!dispatchCurrent() || options.signal?.aborted) return refuse('Session changed before dispatch');
        consuming = true;
        if (!result.scope) return consumeOrRefuse();
        return (async () => {
          const scope = operationScope(options);
          try {
            let coverage;
            try { coverage = await untilCancelled(coverageFor(session, result.scope, { ...options, signal: scope.signal }), scope.signal); }
            catch { return refuse('consent port unavailable'); }
            assertDispatchOpen();
            if (!dispatchCurrent() || scope.signal.aborted) return refuse('Session changed before dispatch');
            const reason = consentReason(coverage, result.scope, now(), session.consentRevision);
            if (reason) return refuse(reason);
            consumeOrRefuse();
          } finally { scope.dispose(); }
        })();
      } });
      const described = runtime.describe(session);
      return { plugin, releaseCredits: () => { if (lane === 'reaction') budget.releaseReplyCredits(attemptId); }, consentScope: result.scope ? structuredClone(result.scope) : null,
        ...(lane === 'concept' ? { visuals: described.visuals?.id ?? null } : { producer, engine: { preset: described.preset, model: described.model?.id ?? null,
        label: described.model?.label ?? null, effort: binding.effort } }), options: { ...options, attempt, report,
          ...(lane === 'concept' && !html ? { imageCost: binding.imageCost } : {}) }, finish({ failed = false, error } = {}) {
        try {
          if (!reported) {
            report({ attemptId, outcome: 'uncertain' });
            detached = failed && Boolean(options.signal?.aborted);
            throw new PluginError('invalid-output', 'Plugin omitted its terminal report');
          }
        } catch (error) { if (!failed) throw error; }
        finally {
          if (failed && lane === 'understanding') budget.releaseUnderstandingCredits(attemptId);
          try {
            const row = budget.get(attemptId), latest = storage.get(session.id);
            const inputChanged = inputRevision(latest) !== inputRevision(session);
            const superseded = selectionKey(latest, lane) !== selectionKey(session, lane) || inputChanged;
            const outcome = row.outcome === 'uncertain' && settlementDispatched ? 'uncertain'
              : row.outcome === 'completed' && !failed ? 'completed'
              : latest.tombstone || latest.consentWithdrawn ? 'aborted'
              : latest.paused && !(purposeAssessment && latest.pauseReason === 'purpose') && row.outcome !== 'completed' ? 'deferred'
              : superseded ? 'superseded'
              : settlementAborted ? 'aborted'
              : failed || row.outcome !== 'completed' ? 'failed' : 'completed';
            if (budget.finishOutcome(attemptId, outcome)) emitOutcome(diagnosticLane, outcome,
              outcome === 'uncertain' ? 'provider-cost-unknown' : ['4xx', '5xx'].includes(error?.providerErrorClass) ? `provider-${error.providerErrorClass}` : undefined, error?.providerErrorClass);
          } catch { /* Diagnostics cannot interrupt settlement. */ }
        }
      } };
    },
  };
  return runtime;
}
