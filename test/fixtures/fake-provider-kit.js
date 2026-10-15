/**
 * AIT-201 deterministic provider wire kit. No network, timers or sleeps.
 * Tests await next(predicate), then resolve/reject/httpError/timeout/abort calls.
 * Calls remain pending until explicitly released, including invalid requests.
 *
 * Provider-rule table (text-only adapter subset; checked 2026-10-15):
 * | Rule | Adapter | Provider source |
 * | Thinking forbids assistant-final prefill | openrouter providerOptions(reasoning) | https://platform.claude.com/docs/en/build-with-claude/thinking |
 * | Consecutive equal roles COMBINE into a turn; do not reject them | chat-completions payloadFor, prompts reasoningRequest | https://platform.claude.com/docs/en/api/messages/create |
 * | Anthropic messages use user/assistant; system is top-level | claude-html prompt/buildMessages; OpenRouter translates leading system messages | https://platform.claude.com/docs/en/api/messages/create |
 * | Non-empty message content except optional final assistant prefill | reasoning/HTML text messages | https://platform.claude.com/docs/en/api/messages/create ; provider error reproduction: https://github.com/anthropics/anthropic-sdk-go/issues/242 |
 * | Chat messages require role/content; system is a message, user content is string or parts | core/chat-completions payloadFor | https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion |
 * | 400 invalid_request_error envelope, no invented usage | core/chat-completions dispatch/observeResponse | https://platform.claude.com/docs/en/api/errors |
 *
 * Scope: no tools/images in these chat adapters. OpenRouter does not universally
 * prohibit empty strings, system messages after user messages or repeated roles:
 * those are NOT made-up OpenRouter rules. The Anthropic messages profile checks
 * its actual top-level-system contract; the OpenRouter profile translates leading
 * system messages before applying Anthropic rules to an anthropic/* model.
 */
export const assessment = { summary: 'Ein Überblick. An overview.', signals: [], openQuestions: [],
  constraints: { operations: null, data: null, systems: null, reach: null, requirements: null },
  progress: { talk: { value: 0.2, reasoning: 'First details' }, build: { value: 0, reasoning: 'Pending' } },
  actor: null, engagement: null, conceptIntent: null };
export const reply = { content: 'Welche Arbeit? Which work?', scope: 'in', question_short: null, options: [] };
export const draftHTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Draft</title></head><body><main><h1>Draft</h1><p>Sample data</p><button onclick="this.textContent=\'Done\'">Try</button></main></body></html>';
const invalid = message => ({ error: { type: 'invalid_request_error', message } });
export function providerRuleViolation(body, profile = 'openrouter') {
  if (!Array.isArray(body.messages) || !body.messages.length) return 'messages is required';
  const anthropic = profile === 'anthropic' || body.model?.startsWith('anthropic/');
  let messages = body.messages;
  if (profile === 'openrouter') {
    if (messages.some(m => !['system', 'user', 'assistant', 'developer', 'tool'].includes(m.role) ||
      typeof m.content !== 'string' && !Array.isArray(m.content) && !(m.role === 'assistant' && m.content === null))) return 'Invalid chat message';
    if (anthropic) {
      let leading = 0; while (messages[leading]?.role === 'system') leading++;
      messages = messages.slice(leading);
    }
  }
  if (anthropic) {
    if (messages.some(m => !['user', 'assistant'].includes(m.role))) return 'Messages use user/assistant; system belongs outside messages';
    if (!messages.length || messages[0].role !== 'user') return 'Conversation must start with user';
    const thinking = body.thinking?.type === 'enabled' || body.thinking?.type === 'adaptive' ||
      body.reasoning?.enabled === true || body.reasoning?.effort && body.reasoning.effort !== 'none';
    if (messages.some((m, index) => {
      if (!thinking && m.role === 'assistant' && index === messages.length - 1 &&
        (m.content === '' || Array.isArray(m.content) && !m.content.length)) return false;
      return typeof m.content === 'string' ? m.content.length === 0 :
        !Array.isArray(m.content) || !m.content.length || m.content.some(b => b.type !== 'text' || typeof b.text !== 'string' || !b.text.length);
    })) return 'Text content must be non-empty';
    if (thinking && messages.at(-1)?.role === 'assistant') return 'Assistant prefill is not supported when thinking is enabled';
  }
  return null;
}
export function createFakeProviderKit({ profile = 'openrouter', honorAbort = true } = {}) {
  const calls = [], waiters = [];
  const notify = () => {
    for (const waiter of [...waiters]) {
      const call = calls.find(c => !c.claimed && waiter.predicate(c));
      if (call) { call.claimed = true; waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(call); }
    }
  };
  const fetchImpl = (_url, init) => {
    const body = JSON.parse(init.body), gate = Promise.withResolvers();
    const violation = providerRuleViolation(body, profile);
    let settled = false;
    const finish = (method, value) => {
      if (settled) throw new Error('Fake call already released');
      settled = true; call.released = true; init.signal?.removeEventListener('abort', onAbort); gate[method](value);
    };
    const call = { body, signal: init.signal, violation, claimed: false, released: false,
      resolve(value = body.stream ? reply : assessment, { usage = true, cost = true, costUSD = 0.00011, finishReason = 'stop' } = {}) {
        if (violation) return finish('resolve', Response.json(invalid(violation), { status: 400 }));
        const receipt = usage ? { usage: { prompt_tokens: 30, completion_tokens: 40, ...(cost ? { cost: costUSD } : {}) } } : {};
        const content = typeof value === 'string' ? value : JSON.stringify(value);
        finish('resolve', body.stream ? new Response(`data: ${JSON.stringify({ ...receipt, choices: [{ delta: { content }, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`)
          : Response.json({ ...receipt, choices: [{ finish_reason: finishReason, message: { content } }] }));
      },
      openStream() {
        if (!body.stream) throw new TypeError('Streaming request required');
        if (violation) { finish('resolve', Response.json(invalid(violation), { status: 400 })); return null; }
        const stream = new TransformStream(), writer = stream.writable.getWriter(), encoder = new TextEncoder();
        finish('resolve', new Response(stream.readable));
        return {
          frame: value => writer.write(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)),
          async end() { await writer.write(encoder.encode('data: [DONE]\n\n')); await writer.close(); },
          fail: error => writer.abort(error),
        };
      },
      httpError(status, { usage, message = 'Controlled provider failure' } = {}) {
        const type = status >= 500 ? 'api_error' : status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : 'invalid_request_error';
        finish('resolve', Response.json({ error: { type, message }, ...(usage ? { usage } : {}) }, { status }));
      },
      reject(error = new TypeError('Controlled transport failure')) { finish('reject', error); },
      timeout() { finish('reject', new DOMException('Controlled provider timeout', 'TimeoutError')); },
      abort() { finish('reject', new DOMException('Controlled provider abort', 'AbortError')); },
    };
    const onAbort = () => { if (honorAbort && !settled) finish('reject', init.signal.reason); };
    calls.push(call); notify();
    if (init.signal?.aborted) onAbort(); else init.signal?.addEventListener('abort', onAbort, { once: true });
    return gate.promise;
  };
  return { calls, fetchImpl,
    next(predicate = () => true) { const gate = Promise.withResolvers(); waiters.push({ predicate, resolve: gate.resolve }); notify(); return gate.promise; },
    close() { for (const c of calls) if (!c.released) c.abort(); for (const w of waiters.splice(0)) w.resolve(null); },
  };
}
