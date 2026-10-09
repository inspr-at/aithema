import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startChild, temporaryDb } from '../../test/helpers.js';
import { deploymentConfig, deploymentGate } from '../deployment.js';
import { openRouterConfig } from '../openrouter-config.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';

const raw = (url, headers, method = 'GET') => new Promise((resolve, reject) => {
  const outgoing = request(url, { headers, method }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
  }); outgoing.on('error', reject); outgoing.end(method === 'POST' ? '{}' : undefined);
});
test('healthz has no session, commit defaults null, and local Host allowlist still applies', async t => {
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb()); t.after(() => running.kill());
  const response = await fetch(running.url + '/healthz'); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, commit: null }); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await raw(running.url + '/healthz', { host: 'foreign.test' })).status, 403);
});
test('public origin controls accepted Host, origin checking and Secure cookies behind HTTP proxy; health only checks Host', async t => {
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb(), {
    AITHEMA_PUBLIC_ORIGIN: 'https://start2.example.test', AITHEMA_COMMIT: 'local-commit-fixture', AITHEMA_LISTEN_HOST: '127.0.0.1' });
  t.after(() => running.kill());
  const headers = { host: 'start2.example.test', origin: 'https://start2.example.test', 'content-type': 'application/json' };
  const health = await raw(running.url + '/healthz', { ...headers, origin: 'https://foreign.test' });
  assert.equal(health.status, 200); assert.deepEqual(JSON.parse(health.body), { ok: true, commit: 'local-commit-fixture' });
  assert.equal((await fetch(running.url + '/healthz')).status, 403);
  assert.equal((await raw(running.url + '/api/sessions', { ...headers, origin: 'https://foreign.test' }, 'POST')).status, 403);
  const created = await raw(running.url + '/api/sessions', headers, 'POST'); assert.equal(created.status, 201);
  assert.match(created.headers['set-cookie'][0], /; Secure$/); assert.ok(JSON.parse(created.body).id);
  assert.equal((await raw(running.url + '/demo/config', headers)).status, 200);
});
test('deployment config validates canonical origins, port and listen default; callback is exempt from browser-origin check', () => {
  const local = deploymentConfig({}); assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, 3000);
  assert.equal(deploymentConfig({ AITHEMA_LISTEN_HOST: '0.0.0.0', PORT: '4000' }).hostname, '0.0.0.0');
  for (const origin of ['https://start2.example.test/', 'https://start2.example.test/path', 'https://user:password@example.test', 'http://external.test', 'https://example.test?x=1']) {
    assert.throws(() => deploymentConfig({ AITHEMA_PUBLIC_ORIGIN: origin }));
  }
  for (const port of ['NaN', '-1', '65536', '2.5']) assert.throws(() => deploymentConfig({ PORT: port }));
  const settings = deploymentConfig({ AITHEMA_PUBLIC_ORIGIN: 'https://start2.example.test' });
  const callback = new Request('http://localhost/api/voice/llm/chat/completions', { method: 'POST',
    headers: { host: 'start2.example.test', origin: 'https://provider.example.test' } });
  assert.equal(deploymentGate(callback, settings, new Set()), null);
});
test('unconfigured built-in live voice fails closed with a value-free reason; health remains available', async t => {
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb(), { AITHEMA_VOICE_MODE: 'elevenlabs' });
  t.after(() => running.kill());
  const config = await fetch(running.url + '/demo/config').then(r => r.json());
  assert.equal(config.voiceMode, 'off'); assert.equal(config.voiceDisabledReason, 'template-agent-required');
  assert.equal((await fetch(running.url + '/healthz')).status, 200);
});

test('speech defaults to the required understanding model while retaining a 600-token reply ceiling', () => {
  const configured = openRouterConfig({ OPENROUTER_MODEL: 'anthropic/fixture',
    AITHEMA_OPENROUTER_PRICES: '{"anthropic/fixture":{"prompt":0.000005,"completion":0.000025}}' });
  assert.equal(configured.reaction.model, 'anthropic/fixture'); assert.equal(configured.understanding.model, 'anthropic/fixture');
  assert.equal(configured.reaction.maxTokens, 600); assert.equal(configured.understanding.maxTokens, 4096);
  assert.equal(configured.capMicro, 10_000_000);
  assert.deepEqual(configured.reaction.routing.max_price, { prompt: 5, completion: 25 });
});

test('invalid live model/prices refuse startup with clear messages before database or voice work', async () => {
  const valid = { AITHEMA_PROVIDER: 'openrouter', AITHEMA_VOICE_MODE: 'elevenlabs', OPENROUTER_MODEL: 'openai/fixture',
    AITHEMA_OPENROUTER_PRICES: '{"openai/fixture":{"prompt":0.000001,"completion":0.000002}}' };
  for (const [change, expected] of [
    [{ OPENROUTER_MODEL: '' }, /OPENROUTER_MODEL is required/],
    [{ AITHEMA_OPENROUTER_PRICES: '' }, /AITHEMA_OPENROUTER_PRICES is required as JSON/],
    [{ AITHEMA_OPENROUTER_PRICES: '{}' }, /requires valid prompt\/completion/],
    [{ AITHEMA_OPENROUTER_PRICES: '{"openai/fixture":{"prompt":-1,"completion":2}}' }, /requires valid prompt\/completion/],
    [{ AITHEMA_OPENROUTER_PRICES: '{"openai/fixture":{"prompt":1}}' }, /requires valid prompt\/completion/],
    [{ OPENROUTER_SPEECH_MODEL: 'anthropic/missing' }, /for anthropic\/missing/],
  ]) {
    const db = await temporaryDb();
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
      env: { PATH: process.env.PATH, PORT: '0', AITHEMA_DB: db, ...valid, ...change }, timeout: 5000, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, expected);
    await assert.rejects(access(db), { code: 'ENOENT' });
  }
});
