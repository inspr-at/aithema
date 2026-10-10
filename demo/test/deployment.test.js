import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startChild, temporaryDb, post } from '../../test/helpers.js';
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
const healthcheck = (url, origin) => spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/healthcheck.js', import.meta.url))], {
  env: { PATH: process.env.PATH, PORT: new URL(url).port, ...(origin ? { AITHEMA_PUBLIC_ORIGIN: origin } : {}) },
  timeout: 5000, encoding: 'utf8',
});
test('healthz has no session, commit defaults null, and local Host allowlist still applies', async t => {
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb()); t.after(() => running.kill());
  const response = await fetch(running.url + '/healthz'); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, commit: null }); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await raw(running.url + '/healthz', { host: 'foreign.test' })).status, 403);
  assert.equal(healthcheck(running.url).status, 0);
});
test('public origin controls accepted Host, origin checking and Secure cookies behind HTTP proxy; health only checks Host', async t => {
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb(), {
    AITHEMA_PUBLIC_ORIGIN: 'https://start2.example.test', AITHEMA_COMMIT: 'local-commit-fixture', AITHEMA_LISTEN_HOST: '127.0.0.1' });
  t.after(() => running.kill());
  const headers = { host: 'start2.example.test', origin: 'https://start2.example.test', 'content-type': 'application/json' };
  const health = await raw(running.url + '/healthz', { ...headers, origin: 'https://foreign.test' });
  assert.equal(health.status, 200); assert.deepEqual(JSON.parse(health.body), { ok: true, commit: 'local-commit-fixture' });
  assert.equal((await fetch(running.url + '/healthz')).status, 403);
  assert.equal(healthcheck(running.url, 'https://start2.example.test').status, 0);
  assert.equal(healthcheck(running.url, 'https://foreign.test').status, 1);
  assert.equal(healthcheck(running.url).status, 1);
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

test('demo reads either voice-minute cap from env and exposes a feature and admission reason', async t => {
  for (const [key, reason] of [['AITHEMA_VOICE_CAP_MINUTES', 'Voice minute cap reached for this deployment'],
    ['AITHEMA_VOICE_CAP_MINUTES_PER_DAY', 'Voice minute cap reached for this UTC day']]) {
    const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb(), { [key]: '0' });
    t.after(() => running.kill());
    const created = await post(running.url + '/api/sessions', {}), session = await created.json();
    const headers = { cookie: created.headers.get('set-cookie').split(';')[0] };
    await post(running.url + `/api/sessions/${session.id}/consent`, { granted: true }, headers);
    const granted = await fetch(running.url + `/api/sessions/${session.id}`, { headers }).then(r => r.json());
    assert.equal(granted.featureMatrix.best.voice.reason, reason);
    const response = await post(running.url + `/api/sessions/${session.id}/voice`, { callId: 'denied' }, headers);
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'not-admitted', reason });
    await running.kill();
  }
});

test('speech defaults to the required understanding model with START token caps and analysis routing', () => {
  const configured = openRouterConfig({ OPENROUTER_MODEL: 'anthropic/fixture',
    AITHEMA_OPENROUTER_PRICES: '{"anthropic/fixture":{"prompt":0.000005,"completion":0.000025}}' });
  assert.equal(configured.reaction.model, 'anthropic/fixture'); assert.equal(configured.understanding.model, 'anthropic/fixture');
  assert.equal(configured.reaction.maxTokens, 1200); assert.equal(configured.understanding.maxTokens, 8000);
  assert.equal(configured.capMicro, 10_000_000);
  assert.deepEqual(configured.reaction.routing.max_price, { prompt: 5, completion: 25 });
  assert.equal(configured.reaction.routing.require_parameters, true);
  assert.equal(configured.understanding.routing.require_parameters, true);
  assert.equal(Object.hasOwn(configured.reaction.routing, 'only'), false);
  assert.equal(Object.hasOwn(configured.understanding.routing, 'only'), false);
  assert.equal(Object.hasOwn(configured.reaction.routing, 'ignore'), false);
  assert.deepEqual(configured.understanding.routing.ignore, ['Azure']);
  for (const binding of [configured.reaction, configured.understanding]) {
    assert.deepEqual(binding.legal.evidence.routing, binding.routing);
  }
});

test('START routing parsing trims CSV entries and matching quotes, defaults blanks and permits empty lists', () => {
  const values = { OPENROUTER_MODEL: 'openai/fixture',
    AITHEMA_OPENROUTER_PRICES: '{"openai/fixture":{"prompt":0.000001,"completion":0.000002}}' };
  const configured = openRouterConfig({ ...values, OPENROUTER_MAX_TOKENS: ' "37" ', OPENROUTER_ANALYSIS_MAX_TOKENS: " '63' ",
    OPENROUTER_PROVIDER_ONLY: ' "Anthropic, , OpenAI" ', OPENROUTER_ANALYSIS_PROVIDER_IGNORE: ' Azure, Microsoft, ' });
  assert.equal(configured.reaction.maxTokens, 37); assert.equal(configured.understanding.maxTokens, 63);
  assert.deepEqual(configured.reaction.routing.only, ['Anthropic', 'OpenAI']);
  assert.deepEqual(configured.understanding.routing.only, ['Anthropic', 'OpenAI']);
  assert.deepEqual(configured.understanding.routing.ignore, ['Azure', 'Microsoft']);
  assert.equal(Object.hasOwn(configured.reaction.routing, 'ignore'), false);
  for (const binding of [configured.reaction, configured.understanding]) assert.deepEqual(binding.legal.evidence.routing, binding.routing);
  const blank = openRouterConfig({ ...values, OPENROUTER_MAX_TOKENS: ' ', OPENROUTER_ANALYSIS_MAX_TOKENS: '""',
    OPENROUTER_PROVIDER_ONLY: '', OPENROUTER_ANALYSIS_PROVIDER_IGNORE: ' ' });
  assert.equal(blank.reaction.maxTokens, 1200); assert.equal(blank.understanding.maxTokens, 8000);
  assert.equal(Object.hasOwn(blank.reaction.routing, 'only'), false);
  assert.deepEqual(blank.understanding.routing.ignore, ['Azure']);
  const empty = openRouterConfig({ ...values, OPENROUTER_PROVIDER_ONLY: ' , ', OPENROUTER_ANALYSIS_PROVIDER_IGNORE: ' , ' });
  assert.equal(Object.hasOwn(empty.reaction.routing, 'only'), false);
  assert.equal(Object.hasOwn(empty.understanding.routing, 'ignore'), false);
});

test('invalid live model/prices/token caps refuse startup before database or voice work', async () => {
  const valid = { AITHEMA_PROVIDER: 'openrouter', AITHEMA_VOICE_MODE: 'elevenlabs', OPENROUTER_MODEL: 'openai/fixture',
    AITHEMA_OPENROUTER_PRICES: '{"openai/fixture":{"prompt":0.000001,"completion":0.000002}}' };
  for (const [change, expected] of [
    [{ OPENROUTER_MODEL: '' }, /OPENROUTER_MODEL is required/],
    [{ AITHEMA_OPENROUTER_PRICES: '' }, /AITHEMA_OPENROUTER_PRICES is required as JSON/],
    [{ AITHEMA_OPENROUTER_PRICES: '{}' }, /requires valid prompt\/completion/],
    [{ AITHEMA_OPENROUTER_PRICES: '{"openai/fixture":{"prompt":-1,"completion":2}}' }, /requires valid prompt\/completion/],
    [{ AITHEMA_OPENROUTER_PRICES: '{"openai/fixture":{"prompt":1}}' }, /requires valid prompt\/completion/],
    [{ OPENROUTER_SPEECH_MODEL: 'anthropic/missing' }, /for anthropic\/missing/],
    [{ OPENROUTER_MAX_TOKENS: '0' }, /OPENROUTER_MAX_TOKENS must be a positive integer/],
    [{ OPENROUTER_MAX_TOKENS: 'NaN' }, /OPENROUTER_MAX_TOKENS must be a positive integer/],
    [{ OPENROUTER_ANALYSIS_MAX_TOKENS: '-1' }, /OPENROUTER_ANALYSIS_MAX_TOKENS must be a positive integer/],
    [{ OPENROUTER_ANALYSIS_MAX_TOKENS: 'NaN' }, /OPENROUTER_ANALYSIS_MAX_TOKENS must be a positive integer/],
  ]) {
    const db = await temporaryDb();
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
      env: { PATH: process.env.PATH, PORT: '0', AITHEMA_DB: db, ...valid, ...change }, timeout: 5000, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, expected);
    await assert.rejects(access(db), { code: 'ENOENT' });
  }
});
