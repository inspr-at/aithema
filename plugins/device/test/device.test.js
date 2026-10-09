import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localEndpoint, createDeviceReasoning, manifest, localFailure } from '../src/index.js';
import { validateManifest } from '@inspr/aithema-core';
import { chatServer, request } from '../../../test/plugin-fixtures.js';
test('device accepts literal localhost/127.0.0.1 only before URL normalization', () => {
  assert.equal(localEndpoint('http://localhost:8000/'), 'http://localhost:8000');
  assert.equal(localEndpoint('https://127.0.0.1'), 'https://127.0.0.1');
  for (const url of ['http://127.1', 'http://2130706433', 'http://0177.0.0.1', 'http://127.0.0.2', 'http://[::1]',
    'http://localhost.example', 'http://localhost@evil.test', 'http://LOCALHOST', 'http://localhost:0',
    'http://localhost:65536', 'http://localhost/v1', 'http://localhost?x=1', ' http://localhost', 'http://localhost#x']) assert.throws(() => localEndpoint(url));
  assert.equal(manifest.placement, 'browser'); assert.equal(validateManifest(manifest).ok, true);
});
test('device handshakes and streams directly with no proxy, credentials or redirect', async t => {
  const fake = await chatServer(t), calls = [];
  const client = createDeviceReasoning({ endpoint: new URL(fake.endpoint).origin, fetchImpl: (url, options) => {
    calls.push({ url, options }); return fetch(url, options);
  } });
  assert.deepEqual(await client.connect(), ['fixture-model']);
  let text = ''; for await (const delta of client.stream(request, { deadlineAt: Date.now() + 1000 })) text += delta;
  assert.equal(text, 'Hello');
  for (const { url, options } of calls) {
    assert.ok(url.startsWith(new URL(fake.endpoint).origin)); assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.headers?.authorization, undefined);
  }
  await assert.rejects(client.structured(request), /unavailable on device/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(client.connect({ signal: cancelled.signal }), { code: 'cancelled' });
});
test('the connector offers the handshake\'s models for selection and classifies failures for setup help', async t => {
  const fake = await chatServer(t), origin = new URL(fake.endpoint).origin;
  const client = createDeviceReasoning({ endpoint: origin });
  assert.equal(client.model, null); assert.deepEqual(client.models(), []);
  assert.deepEqual(await client.connect(), ['fixture-model']);
  assert.equal(client.model, 'fixture-model'); assert.deepEqual(client.models(), ['fixture-model']);
  assert.throws(() => client.select('not-returned'), error => localFailure(error) === 'models');
  assert.equal(client.select('fixture-model'), 'fixture-model');
  client.disconnect(); assert.equal(client.model, null);
  await assert.rejects(async () => { for await (const _ of client.stream(request, {})) { /* refused */ } }, error => localFailure(error) === 'models');
  const responding = status => createDeviceReasoning({ endpoint: origin, fetchImpl: async () => new Response('{}', { status }) });
  for (const [status, code] of [[401, 'auth'], [403, 'access'], [404, 'api'], [500, 'response']]) {
    await assert.rejects(responding(status).connect(), error => localFailure(error) === code, String(status));
  }
  await assert.rejects(createDeviceReasoning({ endpoint: origin, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }).connect(),
    error => localFailure(error) === 'cors');
  await assert.rejects(createDeviceReasoning({ endpoint: origin, fetchImpl: async () => new Response('not json') }).connect(), error => localFailure(error) === 'models');
  await assert.rejects(createDeviceReasoning({ endpoint: origin, fetchImpl: async () => Response.json({ data: [] }) }).connect(), error => localFailure(error) === 'models');
  assert.throws(() => createDeviceReasoning({ endpoint: 'http://localhost/v1' }), error => localFailure(error) === 'endpoint');
  await assert.rejects(createDeviceReasoning({ endpoint: origin, fetchImpl: (url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))) })
    .connect({ deadlineAt: Date.now() + 20 }), error => localFailure(error) === 'timeout');
  assert.equal(localFailure({ code: 'invalid-output' }), 'stream'); assert.equal(localFailure({ code: 'limit' }), 'limit');
});
