import { createHash } from 'node:crypto';
import { PluginRegistry, createMockReasoning, createBinding, PluginError, isCancelledZeroReport, PROCESSING_PRESETS, FEATURES,
  deviceFeatures, featureUnavailable, bindingReason, processingScope, consentReason, MOCK_PROCESSING_SCOPE,
  operationScope, inputRevision, untilCancelled, MAX_HTML_BYTES, isCanonicalMockReasoning, EFFORT_ORDER, SETTINGS_OFF, isOptionId,
  sortEfforts, preferredEffort, isDynamicReason, isConsentReason, CONSENT_REASON } from '@inspr/aithema-core';
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
const CONSENT = CONSENT_REASON;
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
  return { legacy: false, models, voices, visuals, defaults: { model, effort: d.effort ?? defaultModel?.effort ?? null,
    voice: pick(d.voice, voices, SETTINGS_OFF), visuals: pick(d.visuals, visuals, SETTINGS_OFF) } };
}

export function mockPresets() {
  const binding = { plugin: 'mock', model: 'mock', effort: 'none', endpoint: 'https://example.test',
    accountRef: 'demo', secretRef: 'none', maxMicro: 0, maxTokens: 4096, rates: { inputMicro: 0, outputMicro: 0 } };
  return { best: { plugins: ['mock'], bindings: { reaction: binding, understanding: binding } },
    eu: { plugins: [], bindings: {} }, custom: { plugins: [], bindings: {} } };
}
export function createPluginRuntime({ storage, reasoning = createMockReasoning(), registry = new PluginRegistry().register(reasoning),
  presets = mockPresets(), consent, budget = new SQLiteBudgetLedger(storage), healthMs = 1000, now = () => Date.now(), uiRenderLimits = {},
  renderLimiter = createUIRenderLimiter({ storage, now, ...uiRenderLimits }) } = {}) {
  // Invalid host choices fail at startup instead of at a visitor's first request.
  for (const preset of PROCESSING_PRESETS) if (preset !== 'device') normalizeChoices(presets[preset]);
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
      return { raw: { ...raw, effort: selection.effort } };
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
  const unchanged = (session, lane) => {
    const current = storage.get(session.id);
    return Boolean(session.ownerHash) && current.ownerHash === session.ownerHash && !current.tombstone &&
      !current.consentWithdrawn && !current.paused && inputRevision(current) === inputRevision(session) &&
      selectionKey(current, lane) === selectionKey(session, lane);
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
    const { raw, reason: unselected } = options.raw ? { raw: options.raw } : selectedBinding(session, preset, lane);
    if (!raw) return { reason: unselected };
    if (!config.plugins?.includes(raw.plugin)) return { reason: 'plugin not in preset' };
    let binding; try { binding = feature === 'voice' ? createDurationBinding(raw) : feature === 'images' ? createImageBinding(raw) : createBinding(raw); } catch { return { reason: 'binding invalid' }; }
    let plugin = registry.get(binding.plugin);
    if (!plugin) return { reason: 'plugin not registered' };
    // Mock trust starts at the registered canonical entry and must survive binding.
    const canonical = registry.isCanonicalMock(plugin);
    if (plugin.bind) { try { plugin = plugin.bind(feature === 'images' ? imagePluginBinding(binding) : binding); } catch { return { reason: 'binding invalid' }; } }
    const mock = canonical && isCanonicalMockReasoning(plugin) || feature === 'html' && isLocalHTML(plugin) && binding.maxMicro === 0 || feature === 'images' && isLocalImages(plugin) && binding.maxMicro === 0 &&
      binding.imageCost.inputMicro === 0 && binding.imageCost.outputMicro === 0 || feature === 'voice' && isLocalVoice(plugin) &&
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
      const reaction = await evaluate(session, preset, 'text', { ...options, raw: undefined, existingCall: false });
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
  // Public facts only: ids, labels, manifest technical facts and whether the host
  // charges nothing. Endpoints, accounts, secrets, rates and legal terms stay here.
  function facts(raw, option = {}) {
    const plugin = raw && registry.get(raw.plugin), manifest = plugin?.manifest;
    const model = manifest?.models.find(m => m.id === raw.model) ?? manifest?.models.find(m => m.id === '*');
    return { vendor: manifest?.vendor.name ?? null, plugin: raw?.plugin ?? null, model: raw?.model ?? null,
      qualification: model?.qualification ?? 'unverified', processingLocations: [...(model?.processingLocations ?? ['unverified'])],
      streaming: model?.streaming ?? false, structured: model?.structured ?? false, germanQuality: model?.germanQuality ?? 'unverified',
      efforts: [...(model?.efforts ?? [])], operations: [...(model?.operations ?? [])], formats: [...(model?.formats ?? [])],
      cost: model ? structuredClone(model.cost) : null, free: free(raw),
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
  const runtime = {
    budget, consent, visualKind, renderLimiter, selectionKey, choicesFor,
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
          const f = facts(raw, option), effort = option.efforts ? option.effort : null;
          const supported = [reaction, understanding].filter(Boolean).map(b => facts(b).efforts);
          const withEffort = b => b && effort ? { ...b, effort } : b;
          const [textReason, analysisReason] = await Promise.all([verdict('text', withEffort(reaction)), verdict('analysis', withEffort(understanding))]);
          return { id: option.id, label: label(option, raw), configured: Boolean(raw),
            efforts: option.efforts ? option.efforts.filter(e => supported.every(list => list.includes(e))) : [], effort,
            facts: f, status: status(textReason), reason: textReason, features: { text: textReason, analysis: analysisReason } };
        }));
        const optional = (list, feature) => Promise.all(list.map(async option => {
          const reason = await verdict(option.kind ?? feature, option.binding);
          return { id: option.id, label: label(option, option.binding), ...(option.kind ? { kind: option.kind } : {}), configured: Boolean(option.binding),
            facts: facts(option.binding), status: status(reason), reason };
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
      const keys = ['processingPreset', 'model', 'effort', 'voice', 'visuals', 'baseRevision'];
      const invalid = { status: 400, error: 'invalid-settings' };
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !keys.includes(k))) return invalid;
      const preset = body.processingPreset ?? session.processingPreset ?? 'best';
      if (!PROCESSING_PRESETS.includes(preset) || ['model', 'voice', 'visuals'].some(k => body[k] !== undefined && body[k] !== null && !isOptionId(body[k])) ||
        body.effort !== undefined && body.effort !== null && !EFFORT_ORDER.includes(body.effort) ||
        body.baseRevision !== undefined && (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0)) return invalid;
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
    /** Private processing scopes of the current choice, for the host consent ledger. */
    scopes(session) {
      const preset = session.processingPreset ?? 'best';
      if (preset === 'device') return [];
      const result = [], kind = visualKind(session);
      for (const [feature, operation] of [['text', 'stream'], ['analysis', 'structured'], ['voice', 'start'], [kind, 'generate'], [kind, 'edit']]) {
        const { raw } = selectedBinding(session, preset, map[feature][0]);
        if (!raw || !presets[preset]?.plugins?.includes(raw.plugin)) continue;
        let binding; try { binding = feature === 'voice' ? createDurationBinding(raw) : feature === 'images' ? createImageBinding(raw) : createBinding(raw); } catch { continue; }
        const plugin = registry.get(binding.plugin);
        // Only operations the manifest supports and admission would run need consent.
        const model = plugin?.manifest.models.find(m => m.id === binding.model) ?? plugin?.manifest.models.find(m => m.id === '*');
        if (!model?.operations.includes(operation) || operation === 'stream' && !model.streaming || operation === 'structured' && !model.structured ||
          feature === 'html' && !model.formats.includes('text/html')) continue;
        const scope = registry.isCanonicalMock(plugin) || feature === 'voice' && isLocalVoice(plugin) || feature === 'images' && isLocalImages(plugin) ||
          feature === 'html' && isLocalHTML(plugin) ? MOCK_PROCESSING_SCOPE : binding.legal ? processingScope(binding, operation) : null;
        if (scope && !result.some(s => hash(s) === hash(scope))) result.push(structuredClone(scope));
      }
      return result;
    },
    async checkVoice(session, { allowPaused = false, ...options } = {}) {
      const result = await boundedEvaluate(allowPaused ? { ...session, paused: false } : session,
        session.processingPreset ?? 'best', 'voice', options);
      const current = storage.get(session.id);
      if (result.reason || current.ownerHash !== session.ownerHash || current.tombstone || current.consentWithdrawn ||
        (!allowPaused && current.paused) || inputRevision(current) !== inputRevision(session) ||
        selectionKey(current, 'voice') !== selectionKey(session, 'voice')) throw new PluginError('not-admitted', result.reason ?? 'Session changed');
      return result;
    },
    /**
     * Publication follows the visuals option that produced an artifact: switching
     * visuals off stops new renders without hiding earlier ones, and a later
     * provider's coverage never vouches for another provider's result.
     */
    async publicationAllowed(session, { signal, deadlineAt = now() + healthMs, operation = 'generate', visualKind: selected = visualKind(session), visuals } = {}) {
      const current = storage.get(session.id), preset = current.processingPreset ?? 'best';
      if (current.tombstone || current.consentWithdrawn || current.ownerHash !== session.ownerHash || current.consentRevision !== session.consentRevision) return false;
      const offered = (choicesFor(preset)?.visuals ?? []).filter(option => option.binding && option.kind === selected && (visuals === undefined || option.id === visuals));
      for (const option of offered) {
        const result = await boundedEvaluate({ ...current, paused: false }, preset, selected, { signal, deadlineAt, operation, existingCall: true, raw: option.binding });
        const latest = storage.get(session.id);
        if (!result.reason && !signal?.aborted && !latest.tombstone && !latest.consentWithdrawn && latest.ownerHash === session.ownerHash &&
          latest.consentRevision === session.consentRevision) return true;
      }
      return false;
    },
    // The visitor's own visuals choice prices the concept, never a preset-wide binding.
    imageQuote(session) {
      try { const kind = visualKind(session), raw = selectedBinding(session, session.processingPreset ?? 'best', kind).raw;
        return { maxMicro: (kind === 'images' ? createImageBinding(raw) : createBinding(raw)).maxMicro }; }
      catch { return null; }
    },
    async admitVoice({ session, request, options = {} }) {
      if (!unchanged(session, 'voice')) throw new PluginError('not-admitted');
      const result = await this.checkVoice(session, options);
      if (!unchanged(session, 'voice')) throw new PluginError('not-admitted');
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
          if (!unchanged(session, 'voice')) throw new PluginError('not-admitted');
          if (result.scope) {
            const scope = operationScope(options);
            try {
              const coverage = await untilCancelled(coverageFor(session, result.scope, { ...options, signal: scope.signal }), scope.signal);
              if (consentReason(coverage, result.scope, now(), session.consentRevision)) throw new PluginError('not-admitted');
            } finally { scope.dispose(); }
          }
          options.signal?.throwIfAborted();
          if (!unchanged(session, 'voice')) throw new PluginError('not-admitted');
          claim.consume();
        } catch { zero(); throw new PluginError('not-admitted', 'Voice dispatch refused'); }
      } };
      return { plugin, binding, options: { ...options, attempt, report }, finish() {
        if (!reported) report({ attemptId, outcome: 'uncertain', closureConfirmed: false, chargedMicro: maxMicro });
      } };
    },
    async admit({ session, lane, operation, request, options = {} }) {
      const invocationCurrent = () => unchanged(session, lane) && (lane !== 'concept' ||
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
      const described = runtime.describe(session);
      return { plugin, ...(lane === 'concept' ? { visuals: described.visuals?.id ?? null } : { engine: { preset: described.preset, model: described.model?.id ?? null,
        label: described.model?.label ?? null, effort: binding.effort } }), options: { ...options, attempt, report }, finish({ failed = false } = {}) {
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
  return runtime;
}
