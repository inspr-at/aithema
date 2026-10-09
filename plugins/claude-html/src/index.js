import { createBinding, deepFreeze, beginInvocation, operationScope, normalizedError, providerUsage, PluginError } from '@inspr/aithema-core';
import { buildMessages } from './prompt.js';
import { repairHTML, previousDocument, htmlArtifact } from './html-artifact.js';
import { createSpendLedger, callCeilingMicro, costMicro, DEFAULT_CAP_MICRO } from './spend.js';
import { providerMaxPrice } from '../../openrouter/src/pricing.js';
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
async function readText(response, signal) {
  if (!response.body) throw new PluginError('invalid-output');
  if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) { void response.body.cancel().catch(() => {}); throw new PluginError('limit'); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted(); const { value, done } = await abortable(reader.read(), signal); if (done) break;
      size += value.byteLength; if (size > RESPONSE_LIMIT) throw new PluginError('limit'); chunks.push(value);
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
  if (binding.plugin !== manifest.id || !/^anthropic\/claude-[a-z0-9.:-]+$/u.test(binding.model) ||
    !manifest.models[0].efforts.includes(binding.effort)) throw new TypeError('Claude HTML binding requires an anthropic/claude-* model and effort none');
  if (!['inputUSD', 'outputUSD'].every(k => typeof binding.rates[k] === 'number' && Number.isFinite(binding.rates[k]) && binding.rates[k] > 0)) {
    throw new TypeError('Claude HTML binding requires explicit positive per-token USD rates');
  }
  if (binding.maxMicro < 1) throw new TypeError('Claude HTML binding requires a per-call ceiling');
  if (!Number.isSafeInteger(capMicro) || capMicro < 0) throw new TypeError('Invalid spend cap');
  const ledger = spend ?? createSpendLedger({ path: spendPath, capMicro });
  if (!['reserve', 'settle', 'snapshot'].every(k => typeof ledger[k] === 'function')) throw new TypeError('Invalid spend counter port');
  const snapshot = async () => {
    const state = await ledger.snapshot();
    if (!state || !['spentMicro', 'reservedMicro'].every(k => Number.isSafeInteger(state[k]) && state[k] >= 0) ||
      !Number.isSafeInteger(state.spentMicro + state.reservedMicro)) throw new PluginError('unavailable');
    return { ...state, totalMicro: state.spentMicro + state.reservedMicro,
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
    const checkLifetime = () => { scope.signal.throwIfAborted(); if (Date.now() >= options.deadlineAt) throw new PluginError('deadline'); };
    const scoped = { ...options, signal: scope.signal, report: terminal => (reporting = Promise.resolve().then(() => options.report(terminal))) };
    try {
      invocation = await beginInvocation(scoped);
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
      reservation = await ledger.reserve(ceiling); // atomic shared-cap hard stop before any request
      checkLifetime();
      invocation.dispatch(); dispatched = true;
      const response = await abortable(Promise.resolve().then(() => fetchImpl(endpoint, { method: 'POST', signal: scope.signal,
        redirect: 'error', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body })), scope.signal);
      checkLifetime();
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        // A dispatched refusal is not proof that the socket was never written.
        throw new PluginError(response.status === 401 || response.status === 403 ? 'auth' : response.status === 402 ? 'limit' :
          response.status === 429 ? 'rate-limit' : 'provider');
      }
      let payload;
      try { payload = JSON.parse(await readText(response, scope.signal)); }
      catch (error) { if (error instanceof PluginError || scope.signal.aborted) throw error; throw new PluginError('invalid-output'); }
      invocation.usage(providerUsage(payload?.usage)); cost = costMicro(payload?.usage?.cost);
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
        // Unknown cost after dispatch keeps the full ceiling, including HTTP refusals.
        // Only the path before dispatch is provably unsent and may settle at zero.
        let settlementFailed = false;
        if (reservation !== null) try { await ledger.settle(reservation, !dispatched ? 0 : cost ?? ceiling); }
        catch { settlementFailed = true; ledgerFailures.set(ledger, 'spend ledger unreadable'); }
        if (invocation) await invocation.finish(completed && !settlementFailed); if (reporting) await reporting;
        if (settlementFailed) throw new PluginError('unavailable');
      } finally { scope.dispose(); }
    }
  }
  return { id: manifest.id, manifest, binding, billable: true, label: `Claude click-dummy — ${binding.model}`, spend: ledger, capMicro,
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
