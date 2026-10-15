// Diagnostic-only observation. Never retain or emit headers, content, error
// messages, routing values, schema values, generation IDs or token counts.
const has = (value, key) => value != null && Object.hasOwn(value, key);
const keys = value => value && typeof value === 'object' ? Object.keys(value).sort() : [];
const token = value => typeof value === 'string' && /^[A-Za-z0-9._:/~-]{1,128}$/u.test(value) ? value : null;
const code = value => Number.isSafeInteger(value) ? value : token(value);

export function createDiagnosticTransport({ fetchImpl, write, now = () => performance.now() }) {
  const started = now();
  let order = 0;
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const format = body.response_format;
    const record = {
      case: 'provider-call', lane: body.stream ? 'reply' : 'understanding',
      call_order: ++order, offset_ms: Math.max(0, Math.round(now() - started)),
      http_status_class: null, http_status: null,
      provider_error_code: null, provider_error_type: null, finish_reason: null,
      usage_present: false, usage_cost_present: false,
      request_shape: {
        parameter_keys: keys(body), message_count: body.messages?.length ?? 0,
        roles: (body.messages ?? []).map(message => token(message.role)),
        response_format_present: has(body, 'response_format'), response_format_type: token(format?.type),
        schema_property_keys: keys(format?.json_schema?.schema?.properties),
        provider_routing_present: Object.fromEntries(['only', 'ignore', 'allow_fallbacks', 'require_parameters']
          .map(key => [key, has(body.provider, key)])),
        reasoning_present: has(body, 'reasoning'),
        effort_present: has(body, 'effort') || has(body, 'reasoning_effort') || has(body.reasoning, 'effort'),
        max_tokens: Number.isSafeInteger(body.max_tokens) ? body.max_tokens : null,
        model: token(body.model),
      },
      stream_end: { requested: body.stream === true, done_seen: false, terminal_event_seen: false, state: 'pending' },
      observation_truncated: false,
    };
    let emitted = false, buffer = '', size = 0;
    const decoder = new TextDecoder();
    const observe = value => {
      if (!value || typeof value !== 'object') return;
      record.provider_error_code ??= code(value.error?.code);
      record.provider_error_type ??= token(value.error?.type);
      // OpenRouter can wrap an upstream Anthropic error as JSON in metadata.raw.
      // Extract only its code/type; never copy raw or message into the record.
      if (typeof value.error?.metadata?.raw === 'string') {
        try {
          const upstream = JSON.parse(value.error.metadata.raw);
          record.provider_error_code ??= code(upstream.error?.code);
          record.provider_error_type ??= token(upstream.error?.type);
        } catch { /* Non-JSON upstream text is deliberately ignored. */ }
      }
      record.finish_reason ??= token(value.choices?.[0]?.finish_reason ?? value.delta?.stop_reason ?? value.stop_reason);
      record.usage_present ||= has(value, 'usage') && value.usage != null || value.message?.usage != null;
      record.usage_cost_present ||= has(value.usage, 'cost') || has(value.message?.usage, 'cost');
    };
    const terminal = name => ['message_stop', 'response.completed', 'response.failed', 'response.incomplete', 'error'].includes(name);
    const block = frame => {
      const lines = frame.split(/\r?\n/u);
      const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
      record.stream_end.terminal_event_seen ||= terminal(event);
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data === '[DONE]') { record.stream_end.done_seen = true; return; }
      try {
        const value = JSON.parse(data);
        observe(value);
        record.stream_end.terminal_event_seen ||= terminal(value.type) || Boolean(value.choices?.some(choice => choice.finish_reason != null));
      } catch { /* Malformed payloads carry no printable evidence. */ }
    };
    let sse = false;
    const consume = chunk => {
      size += chunk.byteLength;
      // Match the adapter's limits, and never accumulate an unbounded response.
      if (size > (sse ? 2_000_000 : 1_000_000)) { record.observation_truncated = true; buffer = ''; return; }
      if (record.observation_truncated) return;
      buffer += decoder.decode(chunk, { stream: true });
      if (sse) {
        let boundary;
        while ((boundary = /\r?\n\r?\n/u.exec(buffer))) {
          block(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary[0].length);
        }
      }
    };
    const finish = state => {
      if (emitted) return;
      emitted = true;
      if (!record.observation_truncated) {
        buffer += decoder.decode();
        if (sse) { if (buffer.trim()) block(buffer); }
        else { try { observe(JSON.parse(buffer)); } catch { /* Empty or malformed JSON. */ } }
      }
      buffer = '';
      record.stream_end.state = state;
      write(record);
    };
    let response;
    try { response = await fetchImpl(url, init); }
    catch (error) { finish('transport-error'); throw error; }
    record.http_status = response.status;
    record.http_status_class = `${Math.floor(response.status / 100)}xx`;
    sse = response.headers.get('content-type')?.includes('text/event-stream') || body.stream === true && response.ok;
    if (!response.body) { finish('no-body'); return response; }
    const reader = response.body.getReader();
    // Read only when the adapter asks. No clone, extra request, or eager drain.
    const observed = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { finish('eof'); reader.releaseLock(); controller.close(); }
          else { consume(value); controller.enqueue(value); }
        } catch (error) { finish('read-error'); controller.error(error); }
      },
      async cancel(reason) {
        finish('cancelled');
        try { await reader.cancel(reason); } finally { reader.releaseLock(); }
      },
    }, { highWaterMark: 0 });
    return new Response(observed, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
