import { operationScope, matchesSchema } from '@inspr/aithema-next-core';

export function createOpenRouterReasoning({ apiKey, model, endpoint = 'https://openrouter.ai/api/v1/chat/completions' }) {
  if (!apiKey || typeof model !== 'string' || !model.includes('/')) throw new TypeError('OpenRouter binding requires key and model id');
  async function dispatch(request, options, extra) {
    return fetch(endpoint, { method: 'POST', signal: options.signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: request.system }, ...request.messages], ...extra }),
    });
  }
  return {
    id: 'openrouter', label: `OpenRouter — ${model}`,
    async *stream(request, options) {
      const scope = operationScope(options);
      let reader;
      try {
        scope.signal.throwIfAborted();
        const response = await dispatch(request, scope, { stream: true });
        if (!response.ok || !response.body) throw new Error('OpenRouter request failed');
        reader = response.body.getReader();
        const decoder = new TextDecoder(); let buffer = '', completed = false;
        const parse = block => {
          const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (!data) return null;
          if (data === '[DONE]') { completed = true; return null; }
          let value;
          try { value = JSON.parse(data); } catch { throw new Error('Invalid OpenRouter stream'); }
          if (value.error) throw new Error('OpenRouter stream failed');
          const choice = value.choices?.[0];
          if (choice?.finish_reason && choice.finish_reason !== 'stop') throw new Error('Incomplete OpenRouter stream');
          return typeof choice?.delta?.content === 'string' ? choice.delta.content : null;
        };
        while (!completed) {
          scope.signal.throwIfAborted();
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          buffer = buffer.replace(/\r\n/gu, '\n');
          if (buffer.length > 1_000_000) throw new Error('OpenRouter stream limit');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const delta = parse(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
            if (delta !== null) yield delta;
            if (completed) break;
          }
          if (done) break;
        }
        scope.signal.throwIfAborted();
        if (!completed) throw new Error('Incomplete OpenRouter stream');
      } finally { await reader?.cancel().catch(() => {}); scope.dispose(); }
    },
    async structured(request, options) {
      const scope = operationScope(options);
      try {
        scope.signal.throwIfAborted();
        const response = await dispatch(request, scope, { stream: false,
          provider: { require_parameters: true },
          response_format: { type: 'json_schema', json_schema: { name: 'understanding', strict: true, schema: request.schema } },
        });
        if (!response.ok) throw new Error('OpenRouter request failed');
        // Bound response bytes, including server errors; never surface provider content.
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.length;
            if (size > 1_000_000) throw new Error('OpenRouter response limit');
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        scope.signal.throwIfAborted();
        let payload, result;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (payload.choices?.[0]?.finish_reason !== 'stop') throw new Error();
          result = JSON.parse(payload.choices[0].message.content);
        } catch { throw new Error('Invalid OpenRouter structured output'); }
        if (!matchesSchema(result, request.schema)) throw new Error('Invalid OpenRouter structured output');
        return result;
      } finally { scope.dispose(); }
    },
  };
}
