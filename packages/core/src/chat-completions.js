import { operationScope, matchesSchema } from './reasoning.js';
import { beginInvocation, normalizedError, PluginError } from './invocation.js';

export function providerUsage(usage) {
  if (!usage) return null;
  const inputTokens = usage.prompt_tokens, outputTokens = usage.completion_tokens;
  return Number.isSafeInteger(inputTokens) && inputTokens >= 0 && Number.isSafeInteger(outputTokens) && outputTokens >= 0
    ? { inputTokens, outputTokens } : null;
}
export async function responseText(response, limit = 1_000_000) {
  if (!response.body) throw new PluginError('invalid-output');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let size = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) throw new PluginError('limit');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
// Shared wire parser; no retries. It is also used by the browser loopback half.
export function createChatCompletions({ manifest, binding, resolveSecret, fetchImpl = globalThis.fetch,
  providerOptions = () => ({}), transportOptions = {}, billable = true, spendCap,
  spendCeiling = () => binding.maxMicro, prepareBody = body => body }) {
  const label = manifest.vendor.name;
  async function dispatch(request, scope, extra, invocation, spend) {
    scope.signal.throwIfAborted();
    const key = resolveSecret?.(binding.secretRef);
    if (billable && (typeof key !== 'string' || !key || /[\r\n]/u.test(key))) throw new PluginError('auth');
    const payload = prepareBody({ model: binding.model, messages: [{ role: 'system', content: request.system ?? '' }, ...request.messages],
      max_tokens: binding.maxTokens, ...providerOptions(extra.stream), ...extra });
    const body = JSON.stringify(payload);
    spend.ceiling = spendCeiling(payload);
    scope.signal.throwIfAborted();
    if (spendCap) spend.reservation = spendCap.reserve(spend.ceiling);
    invocation.dispatch();
    const response = await fetchImpl(binding.endpoint, { ...transportOptions, method: 'POST', signal: scope.signal,
      redirect: 'error', headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' }, body });
    if (!response.ok) {
      spend.httpError = true;
      // A received HTTP error may still carry billed usage. Otherwise keep the hold.
      if (spend.reservation) {
        try {
          const payload = JSON.parse(await responseText(response));
          invocation.servedModel(payload.model);
          spend.cost = costMicro(payload.usage);
        } catch { /* unknown cost */ }
      } else await response.body?.cancel().catch(() => {});
      throw new PluginError(response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rate-limit' : 'provider', `${label} request failed`);
    }
    return response;
  }
  return {
    id: manifest.id, billable, label: `${label} — ${binding.model}`, manifest, binding, providerOptions,
    async health(options) {
      const scope = operationScope(options);
      try { scope.signal.throwIfAborted(); return { available: !billable || Boolean(resolveSecret?.(binding.secretRef)) }; }
      catch (error) { throw normalizedError(error, scope.signal); }
      finally { scope.dispose(); }
    },
    async *stream(request, options) {
      const invocation = await beginInvocation(options, { billable });
      const scope = operationScope(options); let reader, completed = false; const spend = {};
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
          invocation.servedModel(value.model);
          invocation.usage(providerUsage(value.usage));
          const cost = costMicro(value.usage);
          if (cost !== null) spend.cost = cost;
          if (spend.reservation && cost > spend.ceiling) {
            settleSpend(spend, true);
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
          const { done, value } = await reader.read();
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
        // Incomplete streams retain the ceiling unless known cost already exceeds it.
        try { settleSpend(spend, completed || spend.httpError || spend.cost > spend.ceiling); }
        finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); scope.dispose(); await invocation.finish(completed); }
      }
    },
    async structured(request, options) {
      const invocation = await beginInvocation(options, { billable });
      const scope = operationScope(options); let completed = false; const spend = {};
      try {
        const response = await dispatch(request, scope, { stream: false,
          response_format: { type: 'json_schema', json_schema: { name: 'understanding', strict: true, schema: request.schema } } }, invocation, spend);
        let payload, result;
        try {
          payload = JSON.parse(await responseText(response));
          invocation.servedModel(payload.model);
          spend.cost = costMicro(payload.usage);
          invocation.usage(providerUsage(payload.usage));
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
        try { settleSpend(spend, true); }
        finally { scope.dispose(); await invocation.finish(completed); }
      }
    },
  };
  function settleSpend(spend, known) {
    if (known && spend.reservation && spend.cost !== null && spend.cost !== undefined) spendCap.settle(spend.reservation, spend.cost);
  }
}
// USD usage is separate from the token ledger. Round upwards; missing cost keeps the hold.
function costMicro(usage) {
  const cost = usage?.cost;
  const micro = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? Math.ceil(cost * 1_000_000) : NaN;
  return Number.isSafeInteger(micro) ? micro : null;
}
