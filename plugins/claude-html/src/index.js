import { createBinding, deepFreeze, beginInvocation, operationScope, normalizedError, providerUsage, PluginError, generationId, untilCancelled } from '@inspr/aithema-core';
import { buildMessages } from './prompt.js';
import { repairHTML, previousDocument, htmlArtifact } from './html-artifact.js';
import { createSpendLedger, callCeilingMicro, costMicro, DEFAULT_CAP_MICRO } from './spend.js';
import { providerMaxPrice } from '@inspr/aithema-plugin-openrouter/pricing';
import { reconcileGeneration } from '@inspr/aithema-plugin-openrouter/reconcile';
export { SYSTEM_PROMPT, buildMessages, revisionOf } from './prompt.js';
export { repairHTML, htmlArtifact } from './html-artifact.js';
export { createSpendLedger, callCeilingMicro, costMicro, DEFAULT_CAP_MICRO } from './spend.js';
// Wire contract: https://openrouter.ai/docs/api-reference/chat-completion and
// https://openrouter.ai/docs/use-cases/usage-accounting (usage.cost in credits).
// Rates stay unset: the host binding must carry explicit per-token USD prices.
const ledgerFailures = new WeakMap();
export const DEFAULT_MODEL = 'anthropic/claude-opus-5.5';
// The adapter forwards reasoning.effort; values follow START's 2026-09-13 check of
// OpenRouter reasoning.supported_efforts. Which model supports which value is the
// host's allowlist decision, and require_parameters forbids a silent fallback.
const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
export const manifest = deepFreeze({ id: 'claude-html', version: '0.0.0', apiVersion: '^1.0.0',
  kinds: ['ui-generation'], placement: 'server', entrypoints: { server: './src/index.js' },
  configSchema: { type: 'object', properties: {}, additionalProperties: false }, vendor: { name: 'Anthropic via OpenRouter', url: 'https://openrouter.ai' },
  // The provider streams internally. Generate and edit each return one artifact.
  models: [{ id: '*', operations: ['generate', 'edit'], streaming: false, structured: false,
    efforts: EFFORTS, languages: ['en', 'de'], germanQuality: 'unverified', formats: ['text/html'],
    processingLocations: ['unverified'], qualification: 'unverified', expiresAt: null,
    evidence: ['https://openrouter.ai/anthropic'],
    cost: { unit: 'token', inputMicro: null, outputMicro: null, reviewedAt: null } }] });
const RESPONSE_LIMIT = 4 * 1024 * 1024;
// SSE repeats provider metadata on each chunk. Budget about 1 KiB of wire
// framing per token for a 32,000-token render while bounding each event.
const STREAM_LIMIT = 32 * 1024 * 1024;
// Allow silent stretches between provider keep-alives while bounding a stalled
// body well before the time budget for a long render.
const STREAM_IDLE_MS = 30_000;
function providerError(status) {
  return new PluginError(status === 401 || status === 403 ? 'auth' : status === 402 ? 'limit' :
    status === 429 ? 'rate-limit' : 'provider');
}
function responseReader(response, limit = RESPONSE_LIMIT) {
  if (!response.body) throw new PluginError('invalid-output');
  if (Number(response.headers.get('content-length')) > limit) {
    void response.body.cancel().catch(() => {});
    throw new PluginError('limit');
  }
  return response.body.getReader();
}
async function readText(response, signal, observeId) {
  const reader = responseReader(response), chunks = []; let size = 0, prefix = '';
  try {
    while (true) {
      signal.throwIfAborted(); const { value, done } = await untilCancelled(reader.read(), signal); if (done) break;
      size += value.byteLength; if (size > RESPONSE_LIMIT) throw new PluginError('limit'); chunks.push(value);
      if (observeId && prefix.length < 8192) {
        prefix += Buffer.from(value).toString('utf8').slice(0, 8192 - prefix.length);
        const id = generationId(/"id"\s*:\s*"(gen-[A-Za-z0-9-]+)"/u.exec(prefix)?.[1]);
        if (id) { observeId(id); observeId = undefined; }
      }
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function readDraftStream(response, signal, observe, idle) {
  const reader = responseReader(response, STREAM_LIMIT), decoder = new TextDecoder(), content = [];
  const separator = /\r?\n\r?\n/gu;
  let buffer = '', offset = 0, size = 0, timer, id, usage, finished = false, invalidChoice = false;
  const refreshIdle = () => {
    clearTimeout(timer);
    if (idle) timer = setTimeout(() => idle.abort(new PluginError('deadline')), STREAM_IDLE_MS);
  };
  try {
    refreshIdle();
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await untilCancelled(reader.read(), signal);
      if (done) throw new PluginError('invalid-output');
      if (value.byteLength) refreshIdle();
      size += value.byteLength;
      if (size > STREAM_LIMIT) throw new PluginError('limit');
      // Check only new text plus a possible separator split across reads.
      separator.lastIndex = Math.max(0, buffer.length - 3);
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = separator.exec(buffer))) {
        if (boundary.index - offset > RESPONSE_LIMIT) throw new PluginError('limit');
        const data = buffer.slice(offset, boundary.index).split(/\r?\n/u)
          .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        offset = separator.lastIndex;
        if (!data) continue; // Comments and keep-alives already counted as bytes.
        if (data === '[DONE]') {
          signal.throwIfAborted();
          if (usage != null) observe({ usage });
          return { content: content.join(''), valid: finished && !invalidChoice && content.length > 0 };
        }
        const chunk = JSON.parse(data);
        if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw new PluginError('invalid-output');
        if (!id) {
          id = generationId(chunk.id);
          if (id) observe({ id });
        }
        if (chunk.error) throw providerError(chunk.error.code);
        const choice = chunk.choices?.[0], delta = choice?.delta;
        if (chunk.choices?.length > 1 || (choice?.index ?? 0) !== 0 || delta?.tool_calls) invalidChoice = true;
        if (typeof delta?.content === 'string') content.push(delta.content);
        else if (delta?.content != null) invalidChoice = true;
        if (choice?.finish_reason != null) {
          finished = true;
          if (choice.finish_reason !== 'stop') invalidChoice = true;
        }
        // The receipt may be a dedicated chunk or travel with the stop choice.
        // A cut stream keeps only its generation ID for reconciliation.
        if (chunk.usage != null && (finished || !choice)) usage = chunk.usage;
      }
      buffer = buffer.slice(offset);
      offset = 0;
      if (buffer.length > RESPONSE_LIMIT) throw new PluginError('limit');
    }
  } catch (error) {
    if (error instanceof PluginError || signal.aborted) throw error;
    throw new PluginError('invalid-output');
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/**
 * Claude click-dummy generation through OpenRouter chat completions.
 * `spend` is the persistent per-deployment ledger (or `spendPath` to create one);
 * `capMicro` is the hard USD cap in micro-dollars, checked before each dispatch
 * against a byte/token cost ceiling within the admitted `maxMicro`.
 * Binding `maxTokens` is the total reasoning plus visible output allowance;
 * all of it is reserved at the output rate, without increasing the token limit.
 */
export function createClaudeHTML({ binding, baseUrl, spend, spendPath, capMicro = DEFAULT_CAP_MICRO,
  resolveSecret = ref => process.env[ref], fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  binding = createBinding(binding);
  if (binding.plugin !== manifest.id || !/^(?:anthropic\/claude-[a-z0-9.:-]+|~anthropic\/claude-[a-z0-9.:-]+-latest)$/u.test(binding.model) ||
    !manifest.models[0].efforts.includes(binding.effort)) throw new TypeError(`Claude HTML binding requires an anthropic/claude-* model and effort ${EFFORTS.join(', ')}`);
  if (!['inputUSD', 'outputUSD'].every(k => typeof binding.rates[k] === 'number' && Number.isFinite(binding.rates[k]) && binding.rates[k] > 0)) {
    throw new TypeError('Claude HTML binding requires explicit positive per-token USD rates');
  }
  if (binding.maxMicro < 1) throw new TypeError('Claude HTML binding requires a per-call ceiling');
  if (!Number.isSafeInteger(capMicro) || capMicro < 0) throw new TypeError('Invalid spend cap');
  const ledger = spend ?? createSpendLedger({ path: spendPath, capMicro, now });
  if (!['reserve', 'settle', 'snapshot', 'dispatch', 'record', 'uncertain', 'recover', 'evidence', 'reconcileAttempt']
    .every(k => typeof ledger[k] === 'function')) throw new TypeError('Spend port requires durable cost receipts and reconciliation');
  const snapshot = async () => {
    const state = await ledger.snapshot();
    if (!state || !['spentMicro', 'reservedMicro'].every(k => Number.isSafeInteger(state[k]) && state[k] >= 0) ||
      !Number.isSafeInteger(state.uncertainMicro ?? 0) || (state.uncertainMicro ?? 0) < 0 ||
      !Number.isSafeInteger(state.spentMicro + state.reservedMicro + (state.uncertainMicro ?? 0))) throw new PluginError('unavailable');
    return { ...state, totalMicro: state.spentMicro + state.reservedMicro + (state.uncertainMicro ?? 0),
      costCeilingBreached: Boolean(state.costCeilingBreached || state.breached) };
  };
  const minimumCeiling = callCeilingMicro(buildMessages({ prompt: 'x' }, '').messages, binding);
  const base = new URL(baseUrl ?? binding.endpoint);
  if (base.href !== new URL(binding.endpoint).href) throw new TypeError('OpenRouter base URL must match the admitted binding');
  if (base.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new TypeError('HTTP is for loopback fixtures only');
  const endpoint = `${base.href.replace(/\/$/u, '')}/chat/completions`;
  const configured = () => { const key = resolveSecret(binding.secretRef); return typeof key === 'string' && key.length > 0 && !/[\r\n]/u.test(key) ? key : null; };
  async function run(operation, spec, feedback, options, artifact) {
    const scope = operationScope(options);
    let invocation, completed = false, reporting, reservation = null, dispatched = false, cost = null, ceiling = null;
    let receipts = Promise.resolve();
    const clock = options.now ?? Date.now;
    const checkLifetime = () => { scope.signal.throwIfAborted(); if (clock() >= options.deadlineAt) throw new PluginError('deadline'); };
    // Report synchronously on abort before the lane can fall back to its larger
    // binding hold. Both ledgers retain the dispatched request's computed ceiling.
    const scoped = { ...options, signal: scope.signal, report: terminal => (reporting = Promise.resolve(options.report({
      ...terminal, ...(dispatched ? { chargedMicro: cost ?? ceiling } : {}) }))) };
    const observe = payload => {
      invocation.usage(providerUsage(payload?.usage));
      const charge = costMicro(payload?.usage?.cost), id = generationId(payload?.id);
      if (charge !== null) { cost = charge; invocation.cost(cost); }
      const evidence = { ...(id ? { generationId: id } : {}), ...(charge === null ? {} : { chargedMicro: charge }) };
      if (Object.keys(evidence).length) {
        receipts = receipts.then(async () => {
          await ledger.record(reservation, evidence); options.attempt?.observeCost?.(evidence);
        });
        // The finalizer awaits and fails closed on any receipt journal error.
        void receipts.catch(() => {});
      }
    };
    const observeResponse = async (response, signal) => {
      const text = response.body ? await readText(response, signal, id => observe({ id })) : '';
      let payload;
      try { payload = JSON.parse(text); } catch { /* Plain-text/empty rejections have no usage. */ }
      observe(payload);
      // Match reasoning settlement: fully received 4xx without usage is unbilled,
      // except timeouts (408/499). Those, usage without cost, 5xx and incomplete
      // responses keep the ceiling until a cost receipt is available.
      if (response.status >= 400 && response.status < 500 && ![408, 499].includes(response.status) && payload?.usage == null) {
        invocation.usage({ inputTokens: 0, outputTokens: 0 });
        observe({ usage: { cost: 0 } });
      }
    };
    const checkedResponse = response => {
      try { checkLifetime(); return response; }
      catch (error) {
        // A late paid response cannot publish a draft, but its receipt still repairs costs.
        if (!response.ok && !(response.status >= 400 && response.status < 500) &&
          !response.headers.get('content-type')?.includes('application/json')) {
          void response.body?.cancel().catch(() => {}); throw error;
        }
        const late = operationScope({ deadlineAt: Date.now() + 1000 });
        void (async () => {
          try {
            if (response.ok) await readDraftStream(response, late.signal, observe);
            else await observeResponse(response, late.signal);
            await receipts;
            if (cost !== null) await ledger.reconcileAttempt(options.attempt.attemptId, cost);
          } catch { /* Durable unknown costs remain retryable. */ }
          finally { late.dispose(); }
        })();
        throw error;
      }
    };
    try {
      invocation = await beginInvocation(scoped, { authoritativeCost: true });
      checkLifetime();
      const key = configured(); if (!key) throw new PluginError('auth');
      const previous = operation === 'edit' ? previousDocument(artifact) : undefined;
      const { messages } = buildMessages(spec, feedback, previous);
      ceiling = callCeilingMicro(messages, binding);
      const current = await snapshot();
      // A shared account may have a lower, host-adjusted cap than this plugin.
      // Refuse with the spend port's admission code before any provider dispatch.
      if (Number.isSafeInteger(current.capMicro) && ceiling > current.capMicro - current.totalMicro) {
        throw new PluginError('not-admitted', 'OpenRouter spend cap exhausted');
      }
      if (ledgerFailures.has(ledger) || current.costCeilingBreached || ceiling > binding.maxMicro || ceiling > capMicro - current.totalMicro) {
        throw new PluginError('limit');
      }
      // Verified live on AIT-113, 2026-10-09: provider.max_price is USD per
      // million tokens. Shift configured decimals exactly, as on the reasoning route.
      // max_tokens covers reasoning plus visible output; never raise it for effort.
      const body = JSON.stringify({ model: binding.model, messages, max_tokens: binding.maxTokens, stream: true,
        usage: { include: true }, provider: { ...binding.routing, require_parameters: true, allow_fallbacks: false,
          max_price: providerMaxPrice({ prompt: binding.rates.inputUSD, completion: binding.rates.outputUSD }) },
        reasoning: binding.effort === 'none' ? { enabled: false } : { effort: binding.effort },
        stream_options: { include_usage: true } });
      checkLifetime();
      reservation = await ledger.reserve(ceiling, { attemptId: options.attempt?.attemptId, provider: 'openrouter' });
      checkLifetime();
      // The account journal fences ownership before either the invocation or
      // the budget can record provider dispatch. A lease refusal is unsent.
      await ledger.dispatch(reservation);
      invocation.dispatch(); dispatched = true;
      options.attempt?.dispatchCost?.(); checkLifetime();
      const idle = new AbortController(), fetchSignal = AbortSignal.any([scope.signal, idle.signal]);
      // Close even a late response from a transport that ignores cancellation.
      const response = checkedResponse(await untilCancelled(Promise.resolve().then(() => fetchImpl(endpoint, { method: 'POST', signal: fetchSignal,
        redirect: 'error', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body })).then(checkedResponse), scope.signal));
      if (!response.ok) {
        try { await observeResponse(response, scope.signal); }
        catch { /* An incomplete response retains the dispatched ceiling. */ }
        throw providerError(response.status);
      }
      const draft = await readDraftStream(response, fetchSignal, observe, idle);
      if (cost !== null && cost > ceiling) {
        ledgerFailures.set(ledger, 'cost ceiling breached'); throw new PluginError('limit');
      }
      if (!draft.valid) throw new PluginError('invalid-output');
      const html = repairHTML(draft.content);
      checkLifetime();
      const result = htmlArtifact(html, { prompt: messages.map(m => m.content).join('\n\n'), model: binding.model, operation, now: (options.now ?? now)() });
      checkLifetime();
      completed = true; return result;
    } catch (error) { throw normalizedError(error, scope.signal); }
    finally {
      try {
        // Unknown cost after dispatch keeps the full ceiling. Unbilled 4xx and
        // undispatched requests release at zero; observed charges stay billable.
        let settlementError;
        if (reservation !== null) try {
          await receipts;
          if (dispatched && cost === null) await ledger.uncertain(reservation);
          else await ledger.settle(reservation, !dispatched ? 0 : cost);
        }
        catch (error) {
          settlementError = error;
          ledgerFailures.set(ledger, error.code === 'not-admitted' ? 'spend reservation lease lost' : 'spend ledger unreadable');
        }
        if (invocation) await invocation.finish(completed && !settlementError); if (reporting) await reporting;
        if (settlementError) throw settlementError instanceof PluginError && settlementError.code === 'not-admitted'
          ? settlementError : new PluginError('unavailable');
      } finally { scope.dispose(); }
    }
  }
  return { id: manifest.id, manifest, binding, billable: true, label: `Claude click-dummy — ${binding.model}`, spend: ledger, capMicro,
    estimateCost(request) {
      if (!request) return minimumCeiling;
      const { feedback = '', previousArtifact, ...spec } = request;
      return callCeilingMicro(buildMessages(spec, feedback, previousArtifact ? previousDocument(previousArtifact) : undefined).messages, binding);
    },
    recoverCosts: () => ledger.recover(), costEvidence: attemptId => ledger.evidence(attemptId),
    reconcileSpend: (attemptId, cost) => ledger.reconcileAttempt(attemptId, cost),
    reconcileCost: (record, options) => reconcileGeneration(record, { resolveSecret, fetchImpl, ...options }),
    bind: next => createClaudeHTML({ binding: next, spend: ledger, capMicro, resolveSecret, fetchImpl, now }),
    generate: (spec, feedback, options) => run('generate', spec, feedback, options),
    edit: (artifact, spec, feedback, options) => run('edit', spec, feedback, options, artifact),
    async health(options) {
      const scope = operationScope(options);
      try {
        scope.signal.throwIfAborted();
        if (!configured()) return { available: false, reason: 'not configured' };
        const state = await snapshot(), failure = ledgerFailures.get(ledger);
        if (failure || state.costCeilingBreached) return { available: false, reason: failure ?? 'cost ceiling breached' };
        return minimumCeiling > binding.maxMicro || minimumCeiling > capMicro - state.totalMicro
          ? { available: false, reason: 'spend cap reached' } : { available: true };
      } catch (error) { if (error instanceof PluginError && error.code === 'unavailable') return { available: false, reason: 'spend ledger unreadable' };
        throw normalizedError(error, scope.signal); } finally { scope.dispose(); }
    },
  };
}
