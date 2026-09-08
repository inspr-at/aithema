import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import {
  MOCK_PROVIDER_ID,
  MOCK_REPLY_MARK,
  MockLlmProvider,
  OpenAICompatibleProvider,
  createProviderFromRegistry,
  rejectBrowserProviderOverride,
  assistantTurnForPersistence,
} from '../runtime/index.js';

function validUnderstanding(statement = 'Users sign in with a magic link') {
  return {
    summary: 'Need authenticated access',
    facts: [{ key: 'auth', value: statement, evidence: statement }],
    open_questions: ['What is one concrete acceptance check?'],
    next_question: 'What is one concrete acceptance check?',
    candidate_requirements: [{
      requirement_ref: 'req.sign-in',
      statement,
      acceptance_criteria: ['A reviewer can complete sign-in on staging'],
      constraint_refs: [],
    }],
    project_kinds: ['new_product', 'iteration'],
  };
}

async function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe('provider registry', () => {
  it('identifies the mock as labelled non-live and refuses it in production', () => {
    const mock = new MockLlmProvider();
    assert.equal(mock.id, MOCK_PROVIDER_ID);
    assert.equal(mock.live, false);
    assert.equal(mock.labelledDemo, true);
    assert.throws(
      () => createProviderFromRegistry({
        mode: 'production',
        defaultProvider: 'mock',
        providers: { mock: { kind: 'mock' } },
      }),
      /not allowed in production/,
    );
    const demo = createProviderFromRegistry({
      mode: 'demo',
      defaultProvider: 'mock',
      providers: { mock: { kind: 'mock' } },
    });
    assert.equal(demo.labelledDemo, true);
  });

  it('ignores browser-supplied endpoints, credentials, and unapproved models', () => {
    assert.throws(
      () => rejectBrowserProviderOverride({ baseUrl: 'http://evil.example', message: 'hi' }),
      /must not supply provider endpoints, credentials, or limits/,
    );
    const provider = new OpenAICompatibleProvider({
      id: 'local',
      baseUrl: 'http://127.0.0.1:9/v1',
      modelId: 'allowed-model',
      allowedModels: ['allowed-model'],
    });
    assert.throws(() => provider.resolveModel('gpt-secret'), /not in the operator-approved registry/);
  });

  it('does not import vendor SDKs', () => {
    const source = readFileSync(fileURLToPath(new URL('../runtime/provider.js', import.meta.url)), 'utf8');
    assert.equal(/anthropic|openrouter|elevenlabs|@openai/.test(source), false);
  });
});

describe('configured openai-compatible HTTP adapter', () => {
  it('streams a complete turn from a deterministic test server and refuses incomplete persistence', async () => {
    const server = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, 'Bearer test-key');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model, 'fixture-model');
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Focused next: "}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"what is the acceptance check?"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(validUnderstanding()) } }],
      }));
    });
    const baseUrl = `${await listen(server)}/v1`;
    try {
      const provider = new OpenAICompatibleProvider({
        id: 'fixture',
        baseUrl,
        apiKey: 'test-key',
        modelId: 'fixture-model',
        allowedModels: ['fixture-model'],
      });
      let text = '';
      for await (const chunk of provider.streamChat({
        system: 'test',
        messages: [{ role: 'user', content: 'We need sign-in' }],
      })) {
        text += chunk;
      }
      assert.equal(text, 'Focused next: what is the acceptance check?');
      assert.equal(assistantTurnForPersistence(text, true), text);
      const understanding = await provider.understand({
        system: 'test',
        messages: [{ role: 'user', content: 'We need sign-in' }],
      });
      assert.equal(understanding.candidate_requirements[0].requirement_ref, 'req.sign-in');
      assert.deepEqual([...understanding.project_kinds], ['new_product', 'iteration']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('treats cancellation as an incomplete stream', async () => {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    });
    const baseUrl = `${await listen(server)}/v1`;
    try {
      const provider = new OpenAICompatibleProvider({
        id: 'fixture',
        baseUrl,
        modelId: 'fixture-model',
        allowedModels: ['fixture-model'],
      });
      const abort = new AbortController();
      const iterator = provider.streamChat({
        system: 'test',
        messages: [{ role: 'user', content: 'hi' }],
        signal: abort.signal,
      });
      const first = await iterator.next();
      assert.equal(first.value, 'partial');
      abort.abort();
      await assert.rejects(async () => {
        // eslint-disable-next-line no-unused-vars
        for await (const _ of iterator) { /* drain */ }
      }, /cancelled|AbortError/);
      assert.equal(assistantTurnForPersistence('partial', false), null);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('does not complete a clean close without a successful terminator', async () => {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Focused next: what is the acc"}}]}\n\n');
      res.end();
    });
    const baseUrl = `${await listen(server)}/v1`;
    try {
      const provider = new OpenAICompatibleProvider({
        id: 'fixture',
        baseUrl,
        modelId: 'fixture-model',
        allowedModels: ['fixture-model'],
      });
      await assert.rejects(async () => {
        let text = '';
        for await (const chunk of provider.streamChat({
          system: 'test',
          messages: [{ role: 'user', content: 'hi' }],
        })) {
          text += chunk;
        }
        return text;
      }, /incomplete: truncated|without a successful terminator/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('does not complete length or content-filter finishes even with [DONE]', async () => {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"cut off"},"finish_reason":"length"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const baseUrl = `${await listen(server)}/v1`;
    try {
      const provider = new OpenAICompatibleProvider({
        id: 'fixture',
        baseUrl,
        modelId: 'fixture-model',
        allowedModels: ['fixture-model'],
      });
      await assert.rejects(async () => {
        for await (const chunk of provider.streamChat({
          system: 'test',
          messages: [{ role: 'user', content: 'hi' }],
        })) {
          void chunk;
        }
      }, /finished with length|incomplete: length/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('keeps a latched length finish when a later stop and [DONE] arrive', async () => {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"cut"},"finish_reason":"length"}]}\n\n');
      res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const baseUrl = `${await listen(server)}/v1`;
    try {
      const provider = new OpenAICompatibleProvider({
        id: 'fixture',
        baseUrl,
        modelId: 'fixture-model',
        allowedModels: ['fixture-model'],
      });
      await assert.rejects(async () => {
        for await (const chunk of provider.streamChat({
          system: 'test',
          messages: [{ role: 'user', content: 'hi' }],
        })) {
          void chunk;
        }
      }, /finished with length|incomplete: length/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('completes when finish_reason stop arrives without [DONE]', async () => {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"done via stop"},"finish_reason":"stop"}]}\n\n');
      res.end();
    });
    const baseUrl = `${await listen(server)}/v1`;
    try {
      const provider = new OpenAICompatibleProvider({
        id: 'fixture',
        baseUrl,
        modelId: 'fixture-model',
        allowedModels: ['fixture-model'],
      });
      let text = '';
      for await (const chunk of provider.streamChat({
        system: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        text += chunk;
      }
      assert.equal(text, 'done via stop');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('bounds hung providers and oversized streams', async () => {
    const hung = createServer(() => {});
    const huge = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: {"choices":[{"delta":{"content":${JSON.stringify('x'.repeat(5000))}}}]}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const hungUrl = `${await listen(hung)}/v1`;
    const hugeUrl = `${await listen(huge)}/v1`;
    try {
      const hungProvider = new OpenAICompatibleProvider({
        id: 'hung',
        baseUrl: hungUrl,
        modelId: 'fixture-model',
        allowedModels: ['fixture-model'],
        limits: { maxDurationMs: 80 },
      });
      const started = Date.now();
      await assert.rejects(async () => {
        for await (const chunk of hungProvider.streamChat({
          system: 'test',
          messages: [{ role: 'user', content: 'hi' }],
        })) {
          void chunk;
        }
      }, /timeout|incomplete: timeout|exceeded the configured duration/);
      assert.ok(Date.now() - started < 4_000);

      const hugeProvider = new OpenAICompatibleProvider({
        id: 'huge',
        baseUrl: hugeUrl,
        modelId: 'fixture-model',
        allowedModels: ['fixture-model'],
        limits: { maxAssembledChars: 100 },
      });
      await assert.rejects(async () => {
        for await (const chunk of hugeProvider.streamChat({
          system: 'test',
          messages: [{ role: 'user', content: 'hi' }],
        })) {
          void chunk;
        }
      }, /text limit|response_too_large/);
    } finally {
      await new Promise((resolve) => hung.close(resolve));
      await new Promise((resolve) => huge.close(resolve));
    }
  });

  it('forwards an operator-approved requested model', async () => {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.model, 'other-model');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const baseUrl = `${await listen(server)}/v1`;
    try {
      const provider = new OpenAICompatibleProvider({
        id: 'fixture',
        baseUrl,
        modelId: 'fixture-model',
        allowedModels: ['fixture-model', 'other-model'],
      });
      let text = '';
      for await (const chunk of provider.streamChat({
        system: 'test',
        messages: [{ role: 'user', content: 'hi' }],
        model: 'other-model',
      })) {
        text += chunk;
      }
      assert.equal(text, 'ok');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
