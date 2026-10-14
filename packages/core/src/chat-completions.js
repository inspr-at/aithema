import { operationScope, matchesSchema } from './reasoning.js';
import { beginInvocation, normalizedError, PluginError } from './invocation.js';
import { untilCancelled } from './cancellation.js';
import { usdCostMicro, generationId } from './cost.js';

// Only the portable strict-output subset crosses the wire. Limits, patterns,
// numeric bounds and other validation rules stay in the original host schema.
function providerReplySchema(schema) {
  const safe = {};
  for (const key of ['type', 'enum', 'description', '$ref']) if (Object.hasOwn(schema, key)) safe[key] = schema[key];
  if (schema.properties) {
    safe.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, shape]) => [key, providerReplySchema(shape)]));
    safe.required = Object.keys(schema.properties);
    safe.additionalProperties = false;
  }
  if (schema.items) safe.items = providerReplySchema(schema.items);
  if (schema.anyOf) safe.anyOf = schema.anyOf.map(providerReplySchema);
  if (schema.$defs) safe.$defs = Object.fromEntries(Object.entries(schema.$defs).map(([key, shape]) => [key, providerReplySchema(shape)]));
  return safe;
}

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
  spendCeiling = () => binding.maxMicro, prepareBody = body => body, observedCost, uncertainCeiling, authoritativeCost = false,
  streamSchema = false }) {
  const label = manifest.vendor.name;
  const payloadFor = (request, extra) => prepareBody({ model: binding.model,
    messages: [{ role: 'system', content: request.system ?? '' }, ...request.messages],
    max_tokens: binding.maxTokens, ...providerOptions(extra.stream), ...extra });
  const structuredExtra = request => ({ stream: false,
    response_format: { type: 'json_schema', json_schema: { name: 'understanding', strict: true, schema: request.schema } } });
  // Opt in per adapter and guarded request; other hosts keep their wire contract.
  const streamExtra = request => {
    if (!streamSchema || !request.purposePolicy || !request.schema || request.replySchemaConstrained === false) return { stream: true };
    const schema = providerReplySchema(request.schema);
    return { stream: true, response_format: { type: 'json_schema', json_schema: { name: 'reply', strict: true, schema } } };
  };
  const unsupportedResponseFormat = value => [value.error?.message, value.error?.metadata?.raw].some(message =>
    typeof message === 'string' && (/no endpoints (?:found (?:that|which) )?support (?:the )?(?:requested|required) parameters/iu.test(message) ||
      /response_format|json_schema|structured outputs?/iu.test(message) && /not support|unsupported|not available|unavailable|not permitted|not allowed|invalid schema/iu.test(message)));
  const encoder = new TextEncoder();
  const outputBytes = message => {
    if (!message) return 0;
    const reasoning = message.reasoning ?? message.reasoning_content;
    // OpenRouter may expose the same reasoning as plain text and details. Count
    // the plain form once, or text/summary details when it is absent. Encrypted
    // data is an opaque transport blob, not token evidence.
    const parts = typeof reasoning === 'string' ? [reasoning] : (message.reasoning_details ?? [])
      .flatMap(detail => [detail.text, detail.summary]);
    return [message.content, ...parts].reduce((sum, part) => sum + (typeof part === 'string' ? encoder.encode(part).byteLength : 0), 0);
  };
  const floor = (spend, usage, ceiling = Infinity) => {
    if (observedCost) spend.floorMicro = Math.max(spend.floorMicro ?? 0, Math.min(ceiling, observedCost(usage)));
  };
  // UTF-8 bytes bound tokens from above. This estimate must stay within both
  // max_tokens and the reservation; actual provider usage remains uncapped.
  const byteFloor = (spend, bytes) => floor(spend,
    { inputTokens: spend.inputBound, outputTokens: Math.min(bytes, binding.maxTokens) }, spend.ceiling);
  const persistFloor = (spend, final = false) => {
    if (spend.floorMicro === undefined || spend.floorMicro <= (spend.persistedFloorMicro ?? -1)) return;
    if (!final && spend.floorAt !== undefined && Date.now() - spend.floorAt < 1000) return;
    spend.options.attempt?.observeCost?.({ observedCostMicro: spend.floorMicro });
    spend.persistedFloorMicro = spend.floorMicro; spend.floorAt = Date.now();
  };
  const observe = (value, options, invocation, spend) => {
    const id = generationId(value.id), cost = usdCostMicro(value.usage?.cost);
    const usage = providerUsage(value.usage);
    invocation.servedModel(value.model); invocation.usage(usage);
    if (usage) floor(spend, usage); // completion_tokens already includes reasoning tokens.
    const bytes = outputBytes(value.choices?.[0]?.message);
    if (bytes) byteFloor(spend, bytes);
    if (!spend.stream) persistFloor(spend, true);
    if (cost !== null) { spend.cost = cost; invocation.cost(cost); }
    if (id && id !== spend.generationId || cost !== null && cost !== spend.recordedCost) {
      const evidence = { ...(id ? { generationId: id } : {}), ...(cost !== null ? { chargedMicro: cost } : {}) };
      // Save identity and receipts before either settlement; late usage can repair an uncertain terminal.
      if (spend.reservation) spendCap.record?.(spend.reservation, evidence);
      options.attempt?.observeCost?.(evidence);
      if (id) spend.generationId = id;
      if (cost !== null) spend.recordedCost = cost;
    }
  };
  async function dispatch(request, scope, extra, invocation, spend) {
    scope.signal.throwIfAborted();
    const key = resolveSecret?.(binding.secretRef);
    if (billable && (typeof key !== 'string' || !key || /[\r\n]/u.test(key))) throw new PluginError('auth');
    const payload = payloadFor(request, extra);
    const body = JSON.stringify(payload);
    spend.ceiling = spendCeiling(payload);
    spend.inputBound = new TextEncoder().encode(JSON.stringify(payload.messages)).byteLength;
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
      const providerErrorClass = response.status >= 400 && response.status < 500 ? '4xx'
        : response.status >= 500 && response.status < 600 ? '5xx' : undefined;
      const responseFormatUnsupported = extra.stream && Boolean(extra.response_format) && providerErrorClass === '4xx';
      // A received HTTP error may still carry billed usage. Otherwise keep the hold.
      try {
        const value = JSON.parse(await responseText(response, 1_000_000, { signal: scope.signal,
          observeId: id => observe({ id }, spend.options, invocation, spend) }));
        observe(value, spend.options, invocation, spend);
      }
      catch { /* unknown cost */ }
      const error = new PluginError(response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rate-limit' : 'provider', `${label} request failed`);
      if (providerErrorClass) error.providerErrorClass = providerErrorClass;
      if (responseFormatUnsupported) error.responseFormatUnsupported = true;
      throw error;
    }
    return response;
  }
  return {
    id: manifest.id, billable, label: `${label} — ${binding.model}`, manifest, binding, providerOptions,
    ...(authoritativeCost ? { estimateCost: (request, operation) => spendCeiling(payloadFor(request, operation === 'stream' ? streamExtra(request) : structuredExtra(request))) } : {}),
    ...(uncertainCeiling ? { estimateUncertainCost: (request, operation) => uncertainCeiling(payloadFor(request, operation === 'stream' ? streamExtra(request) : structuredExtra(request))) } : {}),
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
      const spend = { options, stream: true, metadata: { attemptId: options?.attempt?.attemptId, provider: authoritativeCost ? 'openrouter' : manifest.id } };
      try {
        const response = await dispatch(request, scope, streamExtra(request), invocation, spend);
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
          const bytes = outputBytes(value.choices?.[0]?.delta);
          if (bytes) {
            spend.outputBytes = (spend.outputBytes ?? 0) + bytes;
            byteFloor(spend, spend.outputBytes);
          }
          // Keep evidence in memory and persist at most once a second. Identity
          // and authoritative receipts bypass the throttle; finally flushes even
          // on malformed output, cancellation or a consumer ending iteration.
          persistFloor(spend);
          const cost = spend.cost;
          if (spend.reservation && cost > spend.ceiling) {
            settleSpend(spend);
            throw new PluginError('not-admitted', 'OpenRouter spend cap exhausted');
          }
          if (value.error) {
            const error = new PluginError('provider', `${label} stream failed`);
            if (streamExtra(request).response_format && unsupportedResponseFormat(value)) error.responseFormatUnsupported = true;
            throw error;
          }
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
        try { persistFloor(spend, true); settleSpend(spend); }
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
