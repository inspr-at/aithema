import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startChild, temporaryDb, post } from '../../test/helpers.js';
import { deploymentConfig, deploymentGate } from '../deployment.js';
import { openRouterConfig } from '../openrouter-config.js';
import { demoPresets } from '../choices.js';
import { isOptionId } from '@inspr/aithema-core';
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
    assert.equal(binding.effort, 'none');
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

test('analysis effort accepts the plugin efforts and leaves reaction effort at none', () => {
  const values = { OPENROUTER_MODEL: 'anthropic/fixture',
    AITHEMA_OPENROUTER_PRICES: '{"anthropic/fixture":{"prompt":0.000005,"completion":0.000025}}' };
  for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const configured = openRouterConfig({ ...values, OPENROUTER_ANALYSIS_EFFORT: ` "${effort}" ` });
    assert.equal(configured.understanding.effort, effort);
    assert.equal(configured.reaction.effort, 'none');
  }
  assert.equal(openRouterConfig({ ...values, OPENROUTER_ANALYSIS_EFFORT: ' ' }).understanding.effort, 'none');
});

test('alias route ids are stable, valid and distinct from concrete models and other aliases', () => {
  const models = ['~anthropic/claude-haiku-latest', 'anthropic/claude-haiku-latest', '~anthropic/claude-opus-latest'];
  const route = model => demoPresets({ provider: 'openrouter', reaction: { model } }).best.choices.models[0];
  const ids = models.map(model => route(model).id);
  assert.ok(ids.every(isOptionId)); assert.equal(new Set(ids).size, models.length);
  assert.deepEqual(models.map(model => route(model).id), ids);
  assert.equal(ids[1], 'openrouter/anthropic/claude-haiku-latest');
  assert.equal(isOptionId('openrouter/~anthropic/claude-haiku-latest'), false);
});

for (const htmlMode of ['off', 'claude']) test(`start2 alias environment reaches ready with HTML ${htmlMode} and no provider calls`, { timeout: 15_000 }, async t => {
  const analysis = '~anthropic/claude-opus-latest', speech = '~anthropic/claude-haiku-latest';
  const analysisPrice = { prompt: 5e-6, completion: 25e-6 };
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb(), {
    AITHEMA_PROVIDER: 'openrouter', OPENROUTER_MODEL: analysis, OPENROUTER_ANALYSIS_EFFORT: 'low',
    OPENROUTER_SPEECH_MODEL: speech, OPENROUTER_PROVIDER_ONLY: 'Anthropic',
    AITHEMA_OPENROUTER_PRICES: JSON.stringify({ [analysis]: analysisPrice, [speech]: { prompt: 1e-6, completion: 5e-6 },
      ...(htmlMode === 'claude' ? { 'anthropic/claude-opus-5.5': analysisPrice } : {}) }),
    OPENROUTER_API_KEY: 'test-not-a-key', AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: htmlMode,
  });
  t.after(() => running.kill());
  const config = await fetch(running.url + '/demo/config').then(r => r.json());
  assert.ok(config.label.includes(speech)); assert.equal(config.voiceMode, 'off'); assert.equal(config.imageMode, 'off');
  assert.equal(config.htmlMode, htmlMode); assert.equal(config.htmlDisabledReason, null);
  assert.deepEqual(config.processingConsent.items.map(item => item.id), ['models-international']);
  // Creating a session and reading choices never grants consent or dispatches a lane.
  const created = await post(running.url + '/api/sessions', {}); assert.equal(created.status, 201);
  const session = await created.json(), headers = { cookie: created.headers.get('set-cookie').split(';')[0] };
  const response = await fetch(running.url + `/api/sessions/${session.id}/settings`, { headers }); assert.equal(response.status, 200);
  const { best } = (await response.json()).presets, [route] = best.models;
  assert.equal(best.models.length, 1); assert.equal(route.id, 'openrouter/alias/anthropic/claude-haiku-latest');
  assert.equal(best.defaults.model, route.id); assert.ok(route.label.includes(speech)); assert.ok(route.label.includes(analysis));
  assert.equal(best.voices.length, 0);
  assert.deepEqual(best.visuals.map(option => option.id), htmlMode === 'claude' ? ['claude-html'] : []);
});

test('invalid live model/prices/token caps/effort refuse startup before database or voice work', async () => {
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
    [{ OPENROUTER_ANALYSIS_EFFORT: 'minimal' }, /OPENROUTER_ANALYSIS_EFFORT must be one of/],
    [{ OPENROUTER_ANALYSIS_EFFORT: 'LOW' }, /OPENROUTER_ANALYSIS_EFFORT must be one of/],
  ]) {
    const db = await temporaryDb();
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
      env: { PATH: process.env.PATH, PORT: '0', AITHEMA_DB: db, ...valid, ...change }, timeout: 5000, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, expected);
    await assert.rejects(access(db), { code: 'ENOENT' });
  }
});
