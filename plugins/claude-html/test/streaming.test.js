import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyHTMLArtifact } from '@inspr/aithema-core';
import { createClaudeHTML, DEFAULT_MODEL } from '../src/index.js';
import { previousDocument } from '../src/html-artifact.js';

const idleMs = 30_000;
const generationId = 'gen-draft-first';
const html = '<!doctype html>\n<html lang="de"><head><title>Reparaturen</title></head><body><h1>Grüße 🏠</h1></body></html>';
const spec = { prompt: 'Reparaturen anzeigen', language: 'de' };
const usage = { prompt_tokens: 1200, completion_tokens: 3400, cost: 0.0728 };
const keepAlive = ': OPENROUTER PROCESSING\r\n\r\n';
const done = 'data: [DONE]\r\n\r\n';
const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const first = event({ id: generationId, choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'thinking' } }] });
const delta = content => event({ id: generationId, choices: [{ index: 0, delta: { content } }] });
const stop = event({ id: generationId, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
const receipt = event({ id: generationId, choices: [], usage });

const encode = new TextEncoder();
function mockStream(...chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encode.encode(chunk) : chunk);
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

function setup(t, providerResponse, extraOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'html-stream-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binding = { plugin: 'claude-html', endpoint: 'https://example.test/api/v1', model: DEFAULT_MODEL,
    effort: 'high', accountRef: 'fixture-account', secretRef: 'fixture-secret-ref', maxMicro: 1_000_000,
    maxTokens: 32_000, rates: { inputMicro: 1, outputMicro: 28, inputUSD: 0.000001, outputUSD: 0.000028 } };
  const requests = [], reports = [], observations = [];
  const plugin = createClaudeHTML({ binding, spendPath: join(dir, 'spend.json'), resolveSecret: () => 'fixture-secret',
    fetchImpl(url, init) {
      requests.push({ url, ...init });
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.authorization, 'Bearer fixture-secret');
      if (init.method === 'POST') {
        assert.equal(url, `${binding.endpoint}/chat/completions`);
        assert.equal(plugin.spend.snapshot().reservedMicro, plugin.estimateCost(spec));
        return providerResponse;
      }
      assert.equal(url, `${binding.endpoint}/generation?id=${generationId}`);
      return Response.json({ data: { id: generationId, total_cost: 0.001234 } });
    } });
  const options = { deadlineAt: Date.now() + 5000,
    attempt: { attemptId: 'draft-fixture', claimId: 'draft-claim', consume() {}, observeCost: value => observations.push(value) },
    report: value => reports.push(value), ...extraOptions };
  return { plugin, requests, reports, observations, options, generate: () => plugin.generate(spec, '', options) };
}

async function assertReconciles(f) {
  const attemptId = f.options.attempt.attemptId, ceiling = f.plugin.estimateCost(spec);
  assert.deepEqual(f.plugin.costEvidence(attemptId), { generationId });
  assert.deepEqual(f.observations, [{ generationId }]);
  assert.deepEqual(f.reports, [{ attemptId, outcome: 'uncertain', chargedMicro: ceiling }]);
  assert.deepEqual(f.plugin.spend.snapshot(), { spentMicro: 0, reservedMicro: 0, uncertainMicro: ceiling,
    totalMicro: ceiling, costCeilingBreached: false });
  assert.equal(f.requests.length, 1, 'reconciliation is deferred to the existing host retry');
  const evidence = await f.plugin.reconcileCost({ ...f.plugin.binding, ...f.plugin.costEvidence(attemptId) },
    { deadlineAt: Date.now() + 5000 });
  assert.deepEqual(evidence, { generationId, chargedMicro: 1234 });
  await f.plugin.reconcileSpend(attemptId, evidence.chargedMicro);
  await f.plugin.reconcileSpend(attemptId, evidence.chargedMicro);
  assert.deepEqual(f.plugin.spend.snapshot(), { spentMicro: 1234, reservedMicro: 0, uncertainMicro: 0,
    totalMicro: 1234, costCeilingBreached: false });
  assert.equal(f.requests.length, 2);
}

test('AIT-465 streams one HTML request and settles only the final usage receipt', async t => {
  const response = mockStream(keepAlive, first, event({
    choices: [{ index: 0, delta: { content: html.slice(0, 60) } }],
    usage: { prompt_tokens: 1200, completion_tokens: 1, cost: 0.0001 },
  }), keepAlive, delta(html.slice(60)), stop, receipt, done);
  const f = setup(t, response);
  const artifact = await f.generate();
  assert.equal(f.requests.length, 1);
  const body = JSON.parse(f.requests[0].body);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.equal(body.max_tokens, 32_000);
  assert.equal(f.plugin.manifest.models[0].streaming, false);
  assert.equal(await verifyHTMLArtifact(artifact), true);
  assert.equal(previousDocument(artifact).trim(), html);
  assert.deepEqual(f.reports, [{ attemptId: f.options.attempt.attemptId, outcome: 'completed',
    usage: { inputTokens: 1200, outputTokens: 3400 }, chargedMicro: 72_800 }]);
  assert.deepEqual(f.plugin.costEvidence(f.options.attempt.attemptId), { generationId, chargedMicro: 72_800 });
  assert.equal(f.plugin.spend.snapshot().spentMicro, 72_800);
  assert.equal(f.plugin.spend.snapshot().reservedMicro, 0);
  assert.equal(f.plugin.spend.snapshot().uncertainMicro, 0);
  assert.equal(response.body.locked, false);
});

test('AIT-465 assembles data frames split at every byte including UTF-8 and CRLF', async t => {
  const bytes = encode.encode(keepAlive + first + delta(html) + stop + receipt + done);
  const f = setup(t, mockStream(...Array.from(bytes, byte => Uint8Array.of(byte))));
  const artifact = await f.generate();
  assert.equal(previousDocument(artifact).trim(), html);
  assert.equal(f.plugin.spend.snapshot().spentMicro, 72_800);
});

test('AIT-465 a complete stream without usage returns the artifact and reconciles', async t => {
  const f = setup(t, mockStream(first, delta(html), stop, done));
  assert.equal(previousDocument(await f.generate()).trim(), html);
  await assertReconciles(f);
});

test('AIT-465 a cut stream with usage but without DONE reconciles', async t => {
  const f = setup(t, mockStream(first, delta(html), stop, receipt));
  await assert.rejects(f.generate(), { code: 'invalid-output' });
  await assertReconciles(f);
});

for (const [status, code] of [[401, 'auth'], [402, 'limit'], [429, 'rate-limit'], [502, 'provider']]) {
  test(`AIT-465 an in-stream ${status} error reconciles against the first generation ID`, async t => {
    const response = mockStream(first, delta(html), event({ id: 'gen-draft-error', error: { code: status, message: 'fixture detail' },
      choices: [{ index: 0, delta: {}, finish_reason: 'error' }] }), done);
    const f = setup(t, response);
    await assert.rejects(f.generate(), { code, message: code });
    assert.equal(response.body.locked, false);
    await assertReconciles(f);
  });
}

test('AIT-465 a failed body read reconciles and releases the reader', async t => {
  let firstRead = true;
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (firstRead) {
        firstRead = false;
        controller.enqueue(encode.encode(first));
      } else controller.error(new TypeError('Fixture transport interrupted'));
    },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
  const f = setup(t, response);
  await assert.rejects(f.generate(), { code: 'invalid-output' });
  assert.equal(response.body.locked, false);
  await assertReconciles(f);
});

for (const mode of ['cancelled', 'deadline', 'idle']) {
  test(`AIT-465 ${mode} aborts an active HTML stream and reconciles`, { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
    const advance = ms => {
      // Let the spend ledger renew its lease while the response is idle.
      for (let elapsed = 0; elapsed < ms; elapsed += 5000) t.mock.timers.tick(Math.min(5000, ms - elapsed));
    };
    const abort = new AbortController(), reading = Promise.withResolvers();
    const afterKeepAlive = Promise.withResolvers(), afterEmpty = Promise.withResolvers();
    let stream, cancelled = false, reads = 0;
    const response = new Response(new ReadableStream({
      pull(controller) {
        stream = controller;
        if (++reads === 1) controller.enqueue(encode.encode(first));
        if (reads === 2) reading.resolve();
        if (reads === 3) afterKeepAlive.resolve();
        if (reads === 4) afterEmpty.resolve();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    const deadlineMs = mode === 'deadline' ? 100 : 3 * idleMs;
    const f = setup(t, response, { signal: abort.signal, deadlineAt: Date.now() + deadlineMs });
    const pending = assert.rejects(f.generate(), { code: mode === 'cancelled' ? mode : 'deadline' });
    await reading.promise;
    if (mode === 'cancelled') abort.abort();
    else if (mode === 'deadline') t.mock.timers.tick(deadlineMs);
    else {
      advance(idleMs - 1);
      stream.enqueue(encode.encode(keepAlive));
      await afterKeepAlive.promise;
      advance(idleMs - 1);
      assert.equal(f.requests[0].signal.aborted, false, 'comment bytes renew the idle window');
      stream.enqueue(new Uint8Array());
      await afterEmpty.promise;
      t.mock.timers.tick(1);
      if (!f.requests[0].signal.aborted) {
        abort.abort();
        await pending.catch(() => {});
        assert.fail('idle timeout must abort fetch at the byte deadline');
      }
    }
    await pending;
    assert.equal(f.requests[0].signal.aborted, true);
    assert.equal(cancelled, true);
    assert.equal(response.body.locked, false);
    await assertReconciles(f);
  });
}

for (const [status, code] of [[401, 'auth'], [402, 'limit'], [403, 'auth'], [408, 'provider'],
  [429, 'rate-limit'], [499, 'provider'], [503, 'provider']]) {
  test(`AIT-465 pre-stream HTTP ${status} preserves its mapping and accounting`, async t => {
    const f = setup(t, new Response('fixture detail', { status }));
    await assert.rejects(f.generate(), { code, message: code });
    const uncertain = [408, 499, 503].includes(status);
    assert.equal(f.plugin.spend.snapshot().uncertainMicro, uncertain ? f.plugin.estimateCost(spec) : 0);
    assert.equal(f.plugin.spend.snapshot().reservedMicro, 0);
    assert.equal(f.plugin.spend.snapshot().spentMicro, 0);
    assert.equal(f.reports[0].outcome, uncertain ? 'uncertain' : 'cancelled');
    assert.equal(f.requests.length, 1);
  });
}
