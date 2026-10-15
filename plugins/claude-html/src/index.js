import { createBinding, deepFreeze, beginInvocation, operationScope, normalizedError, providerUsage, PluginError, generationId } from '@inspr/aithema-core';
import { buildMessages } from './prompt.js';
import { repairHTML, previousDocument, htmlArtifact } from './html-artifact.js';
import { createSpendLedger, callCeilingMicro, costMicro, DEFAULT_CAP_MICRO } from './spend.js';
import { providerMaxPrice } from '../../openrouter/src/pricing.js';
import { reconcileGeneration } from '../../openrouter/src/reconcile.js';
export { SYSTEM_PROMPT, buildMessages, revisionOf } from './prompt.js';
export { repairHTML, htmlArtifact } from './html-artifact.js';
export { createSpendLedger, callCeilingMicro, costMicro, DEFAULT_CAP_MICRO } from './spend.js';
// Wire contract: https://openrouter.ai/docs/api-reference/chat-completion and
// https://openrouter.ai/docs/use-cases/usage-accounting (usage.cost in credits).
// Rates stay unset: the host binding must carry explicit per-token USD prices.
const ledgerFailures = new WeakMap();
export const DEFAULT_MODEL = 'anthropic/claude-opus-5.5';
export const manifest = deepFreeze({ id: 'claude-html', version: '0.0.0', apiVersion: '^1.0.0',
  kinds: ['ui-generation'], placement: 'server', entrypoints: { server: './src/index.js' },
  configSchema: { type: 'object', properties: {}, additionalProperties: false }, vendor: { name: 'Anthropic via OpenRouter', url: 'https://openrouter.ai' },
  models: [{ id: '*', operations: ['generate', 'edit'], streaming: false, structured: false,
    efforts: ['none'], languages: ['en', 'de'], germanQuality: 'unverified', formats: ['text/html'],
    processingLocations: ['unverified'], qualification: 'unverified', expiresAt: null,
    evidence: ['https://openrouter.ai/anthropic'],
    cost: { unit: 'token', inputMicro: null, outputMicro: null, reviewedAt: null } }] });
const RESPONSE_LIMIT = 4 * 1024 * 1024;
function abortable(promise, signal) {
  let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); });
  return Promise.race([promise, cancelled]).finally(() => signal.removeEventListener('abort', abort));
}
async function readText(response, signal, observeId) {
  if (!response.body) throw new PluginError('invalid-output');
  if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) { void response.body.cancel().catch(() => {}); throw new PluginError('limit'); }
  const reader = response.body.getReader(), chunks = []; let size = 0, prefix = '';
  try {
    while (true) {
      signal.throwIfAborted(); const { value, done } = await abortable(reader.read(), signal); if (done) break;
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
/**
 * Claude click-dummy generation through OpenRouter chat completions.
 * `spend` is the persistent per-deployment ledger (or `spendPath` to create one);
 * `capMicro` is the hard USD cap in micro-dollars, checked before each dispatch
 * against a byte/token cost ceiling within the admitted `maxMicro`.
 */
export function createClaudeHTML({ binding, baseUrl, spend, spendPath, capMicro = DEFAULT_CAP_MICRO,
  resolveSecret = ref => process.env[ref], fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  binding = createBinding(binding);
  if (binding.plugin !== manifest.id || !/^(?:anthropic\/claude-[a-z0-9.:-]+|~anthropic\/claude-[a-z0-9.:-]+-latest)$/u.test(binding.model) ||
    !manifest.models[0].efforts.includes(binding.effort)) throw new TypeError('Claude HTML binding requires an anthropic/claude-* model and effort none');
  if (!['inputUSD', 'outputUSD'].every(k => typeof binding.rates[k] === 'number' && Number.isFinite(binding.rates[k]) && binding.rates[k] > 0)) {
    throw new TypeError('Claude HTML binding requires explicit positive per-token USD rates');
  }
  if (binding.maxMicro < 1) throw new TypeError('Claude HTML binding requires a per-call ceiling');
  if (!Number.isSafeInteger(capMicro) || capMicro < 0) throw new TypeError('Invalid spend cap');
  const ledger = spend ?? createSpendLedger({ path: spendPath, capMicro });
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
    const checkLifetime = () => { scope.signal.throwIfAborted(); if (Date.now() >= options.deadlineAt) throw new PluginError('deadline'); };
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
      // Match reasoning settlement: received 4xx without usage is unbilled;
      // 5xx, usage without cost and incomplete responses keep the ceiling.
      if (response.status >= 400 && response.status < 500 && payload?.usage == null) {
        invocation.usage({ inputTokens: 0, outputTokens: 0 });
        observe({ usage: { cost: 0 } });
      }
    };
    const checkedResponse = response => {
      try { checkLifetime(); return response; }
      catch (error) {
        // A late paid response cannot publish a draft, but its receipt still repairs costs.
        if (!(response.status >= 400 && response.status < 500) && !response.headers.get('content-type')?.includes('application/json')) {
          void response.body?.cancel().catch(() => {}); throw error;
        }
        const late = operationScope({ deadlineAt: Date.now() + 1000 });
        void (async () => {
          try {
            await observeResponse(response, late.signal);
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
      if (ledgerFailures.has(ledger) || current.costCeilingBreached || ceiling > binding.maxMicro || ceiling > capMicro - current.totalMicro) {
        throw new PluginError('limit');
      }
      // Verified live on AIT-113, 2026-10-09: provider.max_price is USD per
      // million tokens. Shift configured decimals exactly, as on the reasoning route.
      // reasoning.enabled=false explicitly disables billable thinking.
      const body = JSON.stringify({ model: binding.model, messages, max_tokens: binding.maxTokens, stream: false,
        usage: { include: true }, provider: { ...binding.routing, require_parameters: true, allow_fallbacks: false,
          max_price: providerMaxPrice({ prompt: binding.rates.inputUSD, completion: binding.rates.outputUSD }) },
        reasoning: { enabled: false } });
      checkLifetime();
      reservation = await ledger.reserve(ceiling, { attemptId: options.attempt?.attemptId, provider: 'openrouter' });
      checkLifetime();
      // The account journal fences ownership before either the invocation or
      // the budget can record provider dispatch. A lease refusal is unsent.
      await ledger.dispatch(reservation);
      invocation.dispatch(); dispatched = true;
      options.attempt?.dispatchCost?.(); checkLifetime();
      // Close even a late response from a transport that ignores cancellation.
      const response = checkedResponse(await abortable(Promise.resolve().then(() => fetchImpl(endpoint, { method: 'POST', signal: scope.signal,
        redirect: 'error', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body })).then(checkedResponse), scope.signal));
      if (!response.ok) {
        try { await observeResponse(response, scope.signal); }
        catch { /* An incomplete response retains the dispatched ceiling. */ }
        throw new PluginError(response.status === 401 || response.status === 403 ? 'auth' : response.status === 402 ? 'limit' :
          response.status === 429 ? 'rate-limit' : 'provider');
      }
      let payload;
      try { payload = JSON.parse(await readText(response, scope.signal, id => observe({ id }))); }
      catch (error) { if (error instanceof PluginError || scope.signal.aborted) throw error; throw new PluginError('invalid-output'); }
      observe(payload);
      if (cost !== null && cost > ceiling) {
        ledgerFailures.set(ledger, 'cost ceiling breached'); throw new PluginError('limit');
      }
      if (payload?.error) throw new PluginError('provider');
      const choice = payload?.choices?.[0];
      if (payload?.choices?.length !== 1 || choice?.finish_reason !== 'stop' || typeof choice?.message?.content !== 'string') throw new PluginError('invalid-output');
      const html = repairHTML(choice.message.content);
      checkLifetime();
      const result = htmlArtifact(html, { prompt: messages.map(m => m.content).join('\n\n'), model: binding.model, operation, now: now() });
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
