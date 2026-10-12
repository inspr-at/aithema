import { operationScope, matchesSchema } from './reasoning.js';
import { beginInvocation, normalizedError, PluginError } from './invocation.js';
import { untilCancelled } from './cancellation.js';
import { usdCostMicro, generationId } from './cost.js';

export function providerUsage(usage) {
  if (!usage) return null;
  const inputTokens = usage.prompt_tokens, outputTokens = usage.completion_tokens;
  return Number.isSafeInteger(inputTokens) && inputTokens >= 0 && Number.isSafeInteger(outputTokens) && outputTokens >= 0
    ? { inputTokens, outputTokens } : null;
}
export async function responseText(response, limit = 1_000_000, { signal, observeId } = {}) {
  if (!response.body) throw new PluginError('invalid-output');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let size = 0, text = '';
  try {
    while (true) {
      const { done, value } = await (signal ? untilCancelled(reader.read(), signal) : reader.read()); if (done) break;
      size += value.byteLength; if (size > limit) throw new PluginError('limit');
      text += decoder.decode(value, { stream: true });
      if (observeId) {
        const id = generationId(/"id"\s*:\s*"(gen-[A-Za-z0-9-]+)"/u.exec(text.slice(0, 8192))?.[1]);
        if (id) { observeId(id); observeId = undefined; }
      }
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
// Shared wire parser; no retries. It is also used by the browser loopback half.
export function createChatCompletions({ manifest, binding, resolveSecret, fetchImpl = globalThis.fetch,
  providerOptions = () => ({}), transportOptions = {}, billable = true, spendCap,
  spendCeiling = () => binding.maxMicro, prepareBody = body => body, authoritativeCost = false }) {
  const label = manifest.vendor.name;
  const payloadFor = (request, extra) => prepareBody({ model: binding.model,
    messages: [{ role: 'system', content: request.system ?? '' }, ...request.messages],
    max_tokens: binding.maxTokens, ...providerOptions(extra.stream), ...extra });
  const structuredExtra = request => ({ stream: false,
    response_format: { type: 'json_schema', json_schema: { name: 'understanding', strict: true, schema: request.schema } } });
  const observe = (value, options, invocation, spend) => {
    const id = generationId(value.id), cost = usdCostMicro(value.usage?.cost);
    invocation.servedModel(value.model); invocation.usage(providerUsage(value.usage));
    if (cost !== null) { spend.cost = cost; invocation.cost(cost); }
    if (id || cost !== null) {
      const evidence = { ...(id ? { generationId: id } : {}), ...(cost !== null ? { chargedMicro: cost } : {}) };
      // Save identity and receipts before either settlement; late usage can repair an uncertain terminal.
      if (spend.reservation) spendCap.record?.(spend.reservation, evidence);
      options.attempt?.observeCost?.(evidence);
    }
  };
  async function dispatch(request, scope, extra, invocation, spend) {
    scope.signal.throwIfAborted();
    const key = resolveSecret?.(binding.secretRef);
    if (billable && (typeof key !== 'string' || !key || /[\r\n]/u.test(key))) throw new PluginError('auth');
    const payload = payloadFor(request, extra);
    const body = JSON.stringify(payload);
    spend.ceiling = spendCeiling(payload);
    scope.signal.throwIfAborted();
    if (spendCap) spend.reservation = spendCap.reserve(spend.ceiling, spend.metadata);
    invocation.dispatch();
    spend.dispatched = true;
    spend.options.attempt?.dispatchCost?.();
    if (spend.reservation) spendCap.dispatch?.(spend.reservation);
    const pending = Promise.resolve(fetchImpl(binding.endpoint, { ...transportOptions, method: 'POST', signal: scope.signal,
      redirect: 'error', headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' }, body }));
    // A late non-stream response may still provide billed cost after cancellation.
    const tracked = pending.then(async response => {
      if (scope.signal.aborted) {
        const late = operationScope({ deadlineAt: Date.now() + 1000 });
        try { observe(JSON.parse(await responseText(response, 1_000_000, { signal: late.signal,
          observeId: id => observe({ id }, spend.options, invocation, spend) })), spend.options, invocation, spend); }
        catch { /* Durable unknown costs remain retryable. */ }
        finally { settleSpend(spend); late.dispose(); }
      }
      return response;
    });
    const response = await untilCancelled(tracked, scope.signal);
    if (!response.ok) {
      spend.httpError = true;
      // A received HTTP error may still carry billed usage. Otherwise keep the hold.
      try { observe(JSON.parse(await responseText(response, 1_000_000, { signal: scope.signal,
        observeId: id => observe({ id }, spend.options, invocation, spend) })), spend.options, invocation, spend); }
      catch { /* unknown cost */ }
      throw new PluginError(response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rate-limit' : 'provider', `${label} request failed`);
    }
    return response;
  }
  return {
    id: manifest.id, billable, label: `${label} — ${binding.model}`, manifest, binding, providerOptions,
    ...(authoritativeCost ? { estimateCost: (request, operation) => spendCeiling(payloadFor(request, operation === 'stream' ? { stream: true } : structuredExtra(request))) } : {}),
    async health(options) {
      const scope = operationScope(options);
      try { scope.signal.throwIfAborted(); return { available: !billable || Boolean(resolveSecret?.(binding.secretRef)) }; }
      catch (error) { throw normalizedError(error, scope.signal); }
      finally { scope.dispose(); }
    },
    async *stream(request, options) {
      const scope = operationScope(options); let reader, completed = false;
      const invocation = await beginInvocation({ ...options, signal: scope.signal }, { billable, authoritativeCost })
        .catch(error => { scope.dispose(); throw error; });
      const spend = { options, metadata: { attemptId: options?.attempt?.attemptId, provider: authoritativeCost ? 'openrouter' : manifest.id } };
      try {
        const response = await dispatch(request, scope, { stream: true }, invocation, spend);
        if (!response.body) throw new PluginError('invalid-output');
        reader = response.body.getReader();
        const decoder = new TextDecoder(); let buffer = '', doneMarker = false, stopped = false, size = 0;
        const parse = block => {
          const data = block.split(/\r?\n/u).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (!data) return null;
          if (data === '[DONE]') { doneMarker = true; return null; }
          let value;
          try { value = JSON.parse(data); } catch { throw new PluginError('invalid-output', `Invalid ${label} stream`); }
          observe(value, options, invocation, spend);
          const cost = spend.cost;
          if (spend.reservation && cost > spend.ceiling) {
            settleSpend(spend);
            throw new PluginError('not-admitted', 'OpenRouter spend cap exhausted');
          }
          if (value.error) throw new PluginError('provider', `${label} stream failed`);
          const choice = value.choices?.[0];
          if (choice?.delta?.tool_calls || choice?.finish_reason && choice.finish_reason !== 'stop') throw new PluginError('invalid-output', `Incomplete ${label} stream`);
          if (choice?.finish_reason === 'stop') stopped = true;
          return typeof choice?.delta?.content === 'string' ? choice.delta.content : null;
        };
        while (!doneMarker) {
          scope.signal.throwIfAborted();
          const { done, value } = await untilCancelled(reader.read(), scope.signal);
          size += value?.byteLength ?? 0;
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          if (size > 2_000_000 || buffer.length > 1_000_000) throw new PluginError('limit');
          let boundary;
          while ((boundary = /\r?\n\r?\n/u.exec(buffer))) {
            const delta = parse(buffer.slice(0, boundary.index)); buffer = buffer.slice(boundary.index + boundary[0].length);
            if (delta !== null) yield delta;
            if (doneMarker) break;
          }
          if (done) break;
        }
        scope.signal.throwIfAborted();
        if (!doneMarker || !stopped) throw new PluginError('invalid-output', `Incomplete ${label} stream`);
        completed = true;
      } catch (error) { throw normalizedError(error, scope.signal); }
      finally {
        try { settleSpend(spend); }
        finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); scope.dispose(); await invocation?.finish(completed); }
      }
    },
    async structured(request, options) {
      const scope = operationScope(options); let completed = false;
      const invocation = await beginInvocation({ ...options, signal: scope.signal }, { billable, authoritativeCost })
        .catch(error => { scope.dispose(); throw error; });
      const spend = { options, metadata: { attemptId: options?.attempt?.attemptId, provider: authoritativeCost ? 'openrouter' : manifest.id } };
      try {
        const response = await dispatch(request, scope, structuredExtra(request), invocation, spend);
        let payload, result;
        try {
          payload = JSON.parse(await responseText(response, 1_000_000, { signal: scope.signal,
            observeId: id => observe({ id }, options, invocation, spend) }));
          observe(payload, options, invocation, spend);
          if (payload.choices?.[0]?.finish_reason !== 'stop') throw new Error();
          result = JSON.parse(payload.choices[0].message.content);
        } catch (error) {
          if (scope.signal.aborted || error instanceof PluginError) throw error;
          throw new PluginError('invalid-output', `Invalid ${label} structured output`);
        }
        scope.signal.throwIfAborted();
        if (!matchesSchema(result, request.schema)) throw new PluginError('invalid-output', `Invalid ${label} structured output`);
        completed = true;
        return result;
      } catch (error) { throw normalizedError(error, scope.signal); }
      finally {
        try { settleSpend(spend); }
        finally { scope.dispose(); await invocation?.finish(completed); }
      }
    },
  };
  function settleSpend(spend) {
    if (!spend.reservation) return;
    if (!spend.dispatched || spend.cost !== null && spend.cost !== undefined) spendCap.settle(spend.reservation, spend.dispatched ? spend.cost : 0);
    else spendCap.uncertain?.(spend.reservation);
  }
}
