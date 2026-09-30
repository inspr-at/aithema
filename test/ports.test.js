import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getEventListeners, once } from 'node:events';
import {
  createReasoningPort, LocalOpenAIProvider, OpenAICompatibleProvider, PaimosHarnessProvider,
} from '../runtime/ports/reasoning.js';
import {
  createProviderRegistry, iterateSseContent, MockLlmProvider, readBoundedResponse, streamWords,
} from '../runtime/provider.js';
import { ConversationController } from '../runtime/controller.js';
import { SqliteProjectStore } from '../runtime/store.js';

const request = (signal) => ({ system: 'Synthetic test', messages: [{ role: 'user', content: 'A demo counter' }], signal });
const config = (fetchImpl, extra = {}) => ({
  id: 'synthetic', baseUrl: 'http://127.0.0.1:9/v1', modelId: 'demo-model',
  allowedModels: ['demo-model'], fetchImpl, ...extra,
});
const delta = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

function barrier() {
  let reach;
  return { reached: new Promise((resolve) => { reach = resolve; }), reach: () => reach() };
}

async function collect(stream) {
  let text = '';
  for await (const chunk of stream) text += chunk;
  return text;
}

function stalledResponse(initial = '', cancelPromise) {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      if (initial) controller.enqueue(new TextEncoder().encode(initial));
    },
    cancel() { cancelled = true; return cancelPromise; },
  });
  return { response: new Response(stream), cancelled: () => cancelled };
}

describe('text reasoning port and adapters', () => {
  it('defines the same cancellable methods for all three adapters', async () => {
    for (const Adapter of [OpenAICompatibleProvider, LocalOpenAIProvider, PaimosHarnessProvider]) {
      assert.equal(typeof Adapter.prototype.streamChat === 'function' || typeof Object.getPrototypeOf(Adapter.prototype).streamChat === 'function', true);
      assert.equal(typeof Adapter.prototype.understand === 'function' || typeof Object.getPrototypeOf(Adapter.prototype).understand === 'function', true);
    }
    const abort = new AbortController();
    let received;
    const adapter = {
      label: 'delegate',
      async *streamChat(value) { received = value; yield this.label; },
      async understand(value) { received = value; return this.label; },
    };
    const port = createReasoningPort(adapter);
    const input = request(abort.signal);
    assert.equal(await collect(port.streamChat(input)), 'delegate');
    assert.equal(received, input);
    assert.equal(await port.understand(input), 'delegate');
    assert.equal(received.signal, abort.signal);
    assert.equal(Object.isFrozen(port), true);
    assert.throws(() => createReasoningPort({ streamChat() {} }), TypeError);
  });

  it('constructs a local-openai registry entry with operator-local execution metadata', async () => {
    let received;
    const registry = createProviderRegistry({
      mode: 'production', defaultProvider: 'local',
      providers: { local: { kind: 'local-openai', baseUrl: 'http://127.0.0.1:9/v1', modelId: 'demo-model', allowedModels: ['demo-model'] } },
    }, { fetchImpl: async (url, options) => {
      received = { url, options };
      return new Response(`${delta('local demo')}data: [DONE]\n\n`);
    } });
    assert.ok(registry.defaultProvider instanceof LocalOpenAIProvider);
    assert.equal(registry.defaultProvider.executionLocation, 'local');
    assert.equal(await collect(createReasoningPort(registry.defaultProvider).streamChat(request())), 'local demo');
    assert.equal(received.url, 'http://127.0.0.1:9/v1/chat/completions');
    assert.equal(received.options.redirect, 'error');
  });

  for (const baseUrl of ['http://127.0.0.1:9/v1', 'http://127.2.3.4:9/v1', 'http://[::1]:9/v1', 'https://127.0.0.1:9/v1']) {
    it(`accepts literal loopback ${baseUrl}`, () => {
      const provider = new LocalOpenAIProvider(config(() => assert.fail('must not fetch'), { baseUrl }));
      assert.equal(provider.executionLocation, 'local');
    });
  }

  for (const baseUrl of [
    'http://provider.example.invalid/v1', 'http://localhost:9/v1', 'http://127.0.0.1.evil.invalid/v1',
    'http://192.168.1.1/v1', 'http://0.0.0.0/v1', 'http://[::]/v1', 'http://[::ffff:127.0.0.1]/v1',
    'http://user:password@127.0.0.1/v1', 'http://127.0.0.1/v1?redirect=remote',
    'http://127.0.0.1/v1#fragment', 'file:///tmp/local', 'not a URL',
  ]) {
    it(`refuses nonliteral or ambiguous local endpoint ${baseUrl}`, () => {
      assert.throws(() => new LocalOpenAIProvider(config(() => assert.fail('must not fetch'), { baseUrl })), /loopback/);
    });
  }

  it('refuses a cloud location on a local adapter and unapproved models', () => {
    assert.throws(() => new LocalOpenAIProvider(config(undefined, { executionLocation: 'cloud' })), /must be local/);
    assert.throws(() => new LocalOpenAIProvider(config(undefined)).resolveModel('other'), /operator-approved/);
  });

  for (const Adapter of [OpenAICompatibleProvider, LocalOpenAIProvider]) {
    it(`${Adapter.name}: rejects pre-cancelled chat and understanding before fetching`, async () => {
      const abort = new AbortController(); abort.abort();
      const provider = new Adapter(config(() => assert.fail('cancelled request must not fetch')));
      await assert.rejects(collect(provider.streamChat(request(abort.signal))), { name: 'AbortError' });
      await assert.rejects(provider.understand(request(abort.signal)), { name: 'AbortError' });
      await assert.rejects(collect(provider.streamChat(request({ aborted: false }))), TypeError);
    });

    it(`${Adapter.name}: cancels a pending body read and does not consume buffered completion after abort`, async () => {
      const abort = new AbortController();
      const fx = stalledResponse(delta('partial'));
      const provider = new Adapter(config(async () => fx.response));
      const stream = provider.streamChat(request(abort.signal));
      assert.equal((await stream.next()).value, 'partial');
      const pending = stream.next();
      const rejected = assert.rejects(pending, { name: 'AbortError' });
      abort.abort();
      await rejected;
      assert.equal(fx.cancelled(), true);
      assert.equal(fx.response.body.locked, false);

      const bufferedAbort = new AbortController();
      const buffered = new Adapter(config(async () => new Response(`${delta('partial')}${delta('must not be emitted')}data: [DONE]\n\n`)));
      const iterator = buffered.streamChat(request(bufferedAbort.signal));
      assert.equal((await iterator.next()).value, 'partial');
      bufferedAbort.abort();
      await assert.rejects(iterator.next(), { name: 'AbortError' });
    });

    it(`${Adapter.name}: cancels a stalled structured response without a completed understanding`, async () => {
      const abort = new AbortController();
      const started = barrier();
      const fx = stalledResponse('{"choices":');
      const provider = new Adapter(config(async () => { started.reach(); return fx.response; }));
      const pending = provider.understand(request(abort.signal));
      const rejected = assert.rejects(pending, { name: 'AbortError' });
      await started.reached;
      abort.abort();
      await rejected;
      assert.equal(fx.cancelled(), true);
    });

    it(`${Adapter.name}: an EOF without a protocol terminator stays incomplete`, async () => {
      const provider = new Adapter(config(async () => new Response(delta('partial'))));
      await assert.rejects(collect(provider.streamChat(request())), (error) => error.code === 'incomplete_stream' && error.reason === 'truncated');
    });
  }

  it('stops a hung body at the configured duration and cancels its producer', async () => {
    const fx = stalledResponse(delta('partial'));
    const provider = new OpenAICompatibleProvider(config(async () => fx.response, { limits: { maxDurationMs: 30 } }));
    // AbortSignal.timeout uses an unref'd timer; keep this deterministic fixture alive.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(collect(provider.streamChat(request())), (error) => error.reason === 'timeout');
      assert.equal(fx.cancelled(), true);
    } finally { clearTimeout(keepAlive); }
  });

  it('rejects promptly even when a stream never acknowledges cancellation', async () => {
    const abort = new AbortController();
    const fx = stalledResponse('', new Promise(() => {}));
    const pending = readBoundedResponse(fx.response, 1024, abort.signal);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    abort.abort();
    await rejected;
    assert.equal(fx.cancelled(), true);
    assert.equal(fx.response.body.locked, false);
  });

  it('removes delay and reader abort listeners after normal completion', async () => {
    const abort = new AbortController();
    const initial = getEventListeners(abort.signal, 'abort').length;
    await collect(streamWords('one two three four', 1, abort.signal));
    await collect(iterateSseContent(new Response(`${delta('done')}data: [DONE]\n\n`), abort.signal));
    await readBoundedResponse(new Response('complete'), 1024, abort.signal);
    assert.equal(getEventListeners(abort.signal, 'abort').length, initial);
  });

  it('a mock cancelled during its last chunk cannot complete as a turn', async () => {
    const abort = new AbortController();
    const iterator = streamWords('last', 0, abort.signal);
    assert.equal((await iterator.next()).value, 'last');
    abort.abort();
    await assert.rejects(iterator.next(), { name: 'AbortError' });
    const delayed = new MockLlmProvider({ chunkDelayMs: 10_000 });
    const secondAbort = new AbortController();
    const work = collect(delayed.streamChat(request(secondAbort.signal)));
    const rejected = assert.rejects(work, { name: 'AbortError' });
    secondAbort.abort();
    await rejected;
  });
});

describe('actual transport cancellation and incomplete persistence', () => {
  for (const phase of ['headers', 'stream', 'understand']) {
    it(`aborts an in-flight loopback HTTP ${phase} request and closes its socket`, async (t) => {
      const started = barrier();
      const disconnected = barrier();
      const server = createServer(async (req, res) => {
        for await (const chunk of req) void chunk;
        res.on('close', disconnected.reach);
        if (phase !== 'headers') {
          res.writeHead(200, { 'content-type': phase === 'stream' ? 'text/event-stream' : 'application/json' });
          res.write(phase === 'stream' ? delta('partial') : '{"choices":');
        }
        started.reach();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
      const abort = new AbortController();
      const provider = new LocalOpenAIProvider(config(undefined, { baseUrl: `http://127.0.0.1:${server.address().port}/v1` }));
      const work = phase === 'understand'
        ? provider.understand(request(abort.signal)) : collect(provider.streamChat(request(abort.signal)));
      const rejected = assert.rejects(work, { name: 'AbortError' });
      await started.reached;
      abort.abort();
      await rejected;
      await disconnected.reached;
    });
  }

  it('the controller never persists a cancelled partial stream as a complete assistant turn', async () => {
    const store = new SqliteProjectStore(':memory:');
    const actor = { party_ref: 'party:demo', actor_kind: 'human', roles: ['delivery_party'], subject: 'demo-subject', projects: [] };
    const provider = new LocalOpenAIProvider(config(async () => new Response(`${delta('partial')}data: [DONE]\n\n`)));
    const controller = new ConversationController({ store, provider, mode: 'test' });
    const abort = new AbortController();
    try {
      const created = controller.createProject(actor, { title: 'Synthetic port cancellation', projectKinds: ['new_product'] });
      const result = await controller.submitTurn({
        projectRef: created.project_ref, actor, expectedRevision: created.revision, turnId: 'turn:ports-demo',
        message: 'Show a demo counter', signal: abort.signal, onChunk() { abort.abort(); },
      });
      assert.equal(result.status, 'incomplete');
      assert.equal(result.stream_completed, false);
      assert.equal(result.assistant, 'partial');
      assert.deepEqual(result.proposals_created, []);
      const project = controller.loadProject(actor, created.project_ref);
      assert.equal(project.transcript.some((message) => message.role === 'assistant'), false);
    } finally { store.close(); }
  });
});
