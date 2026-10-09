import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startChild, temporaryDb, post } from '../../test/helpers.js';
function rawStatus(url, options) {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, options, response => { response.resume(); resolve(response.statusCode); });
    outgoing.on('error', reject); outgoing.end(options?.method === 'POST' ? '{}' : undefined);
  });
}
test('demo serves native UI modules, labelled mock host and persistent handlers', { timeout: 10_000 }, async t => {
  const db = await temporaryDb(); let running = await startChild(new URL('../server.js', import.meta.url), db);
  t.after(async () => running.kill());
  const page = await fetch(running.url), html = await page.text(); assert.match(html, /Demo — Aithema reset slice 1/);
  assert.equal(page.headers.get('content-security-policy'), "frame-src 'none'; child-src 'none'");
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="frame-src 'none'; child-src 'none'">/u);
  for (const method of ['GET', 'HEAD']) {
    const response = await fetch(running.url + '/demo/index.html', { method });
    assert.equal(response.headers.get('content-security-policy'), "frame-src 'none'; child-src 'none'");
    await response.body?.cancel();
  }
  assert.match((await fetch(running.url + '/demo/config').then(r => r.json())).label, /Mock reasoning/);
  for (const path of ['/demo/host.js', '/packages/ui/src/session-element.js', '/packages/ui/src/post-json.js', '/packages/ui/src/i18n/en.js', '/packages/core/src/readiness.js', '/plugins/device/src/index.js', '/packages/core/src/chat-completions.js', '/packages/core/src/plugins.js', '/packages/core/src/invocation.js', '/packages/core/src/presets.js']) {
    const r = await fetch(running.url + path); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
  }
  for (const path of ['/package.json', '/demo/config.js', '/.env', '/packages/server/src/storage.js', '/plugins/mistral/src/index.js']) assert.equal((await fetch(running.url + path)).status, 404);
  const created = await post(running.url + '/api/sessions', {}), s = await created.json();
  const cookie = created.headers.get('set-cookie').split(';')[0];
  assert.match(created.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(created.headers.get('x-aithema-session-token'), null);
  await post(running.url + `/api/sessions/${s.id}/turns`, { clientEventId: 'demo-turn', content: 'Demo turn' }, { cookie });
  await running.kill(); running = await startChild(new URL('../server.js', import.meta.url), db);
  const restored = await fetch(running.url + `/api/sessions/${s.id}`, { headers: { cookie } }).then(r => r.json()); assert.equal(restored.transcript[0].content, 'Demo turn');
});
test('demo rejects foreign Hosts and non-JSON POSTs before session creation', { timeout: 10_000 }, async t => {
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb());
  t.after(() => running.kill());
  const port = new URL(running.url).port;
  for (const host of ['attacker.example', `attacker.example:${port}`, 'localhost', '127.0.0.1:1']) {
    assert.equal(await rawStatus(running.url, { headers: { host } }), 403);
    assert.equal(await rawStatus(running.url + '/api/sessions', { method: 'POST',
      headers: { host, 'content-type': 'application/json' } }), 403);
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    assert.equal(await rawStatus(running.url, { headers: { host } }), 200);
  }
  for (const headers of [{}, { 'content-type': 'text/plain' }, { 'content-type': 'application/jsonp' }]) {
    assert.equal((await fetch(running.url + '/api/sessions', { method: 'POST', headers, body: '{}' })).status, 415);
  }
  assert.equal((await fetch(running.url + '/api/sessions', { method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{}' })).status, 201);
});
// The server answers non-JSON POST bodies with 415, so every client request that
// is not a plain GET must go through postJson. Detect any request method set
// elsewhere, however it is written.
// Any mention of the word "method" outside postJson fails (quoted keys, bracket
// access and shorthand included); a false alarm in a comment is the safe side.
const sendsMethod = source => /\bmethod\b|new\s+Request\s*\(|navigator\.sendBeacon|XMLHttpRequest/u.test(source);
async function clientFiles() {
  const { readdir } = await import('node:fs/promises');
  const files = [new URL('../host.js', import.meta.url)];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) await walk(url); else if (entry.name.endsWith('.js')) files.push(url);
    }
  };
  await walk(new URL('../../packages/ui/src/', import.meta.url));
  return files;
}
test('the request-method detector catches every way of writing a non-GET request', () => {
  for (const fixture of [
    "fetch('/x', { method: 'POST', body: '{}' })", 'fetch("/x", { method: "POST" })', 'fetch(`/x?a=)`, { method: `POST` })',
    'const init = { method: verb }; fetch(url, init)', 'init.method = "PUT"', 'fetch(new Request(url, init))',
    'navigator.sendBeacon(url, data)', 'new XMLHttpRequest()',
    'fetch(\'/x\', { "method": "POST", body: "{}" })', "init['method'] = 'POST'", 'const send = (url, method, body) => fetch(url, { method, body })',
  ]) assert.ok(sendsMethod(fixture), fixture);
  for (const fixture of ["fetch(`${base}/api/sessions/${id}`)", 'const methodology = 1;', "fetch('/x', { signal })"]) assert.ok(!sendsMethod(fixture), fixture);
});
test('postJson sends the JSON content type the server requires', async t => {
  const { postJson } = await import('../../packages/ui/src/post-json.js');
  const calls = []; const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{}'); };
  t.after(() => { globalThis.fetch = original; });
  await postJson('/api/sessions'); await postJson('/api/sessions/s/turns', { clientEventId: 'c', content: 'Hello' });
  assert.deepEqual(calls.map(c => [c.url, c.init.method, c.init.headers['content-type'], c.init.body]), [
    ['/api/sessions', 'POST', 'application/json', '{}'],
    ['/api/sessions/s/turns', 'POST', 'application/json', '{"clientEventId":"c","content":"Hello"}'],
  ]);
});
test('no client file sends a non-GET request except through postJson', async () => {
  const { readFile } = await import('node:fs/promises');
  const files = await clientFiles();
  assert.ok(files.some(f => f.pathname.endsWith('/i18n/en.js')), 'nested client files are scanned');
  for (const file of files) {
    if (file.pathname.endsWith('/packages/ui/src/post-json.js')) continue;
    assert.ok(!sendsMethod(await readFile(file, 'utf8')), `${file.pathname} sets a request method; use postJson`);
  }
});

test('postJson carries explicit header ownership without changing JSON or cookie defaults', async t => {
  const { postJson } = await import('../../packages/ui/src/post-json.js');
  const calls = []; t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push(init); return Response.json({}); });
  await postJson('/api/sessions', {}, { sessionToken: 'post-owner-fixture' });
  await postJson('/api/sessions');
  assert.equal(new Headers(calls[0].headers).get('x-aithema-session-token'), 'post-owner-fixture');
  assert.equal(new Headers(calls[1].headers).has('x-aithema-session-token'), false);
  assert.ok(calls.every(call => new Headers(call.headers).get('content-type') === 'application/json'));
});

for (const asynchronous of [false, true]) {
  test(`demo expiry contains ${asynchronous ? 'asynchronous' : 'synchronous'} failures, logs metadata and runs again`, async t => {
    const { startExpiry } = await import('../session-lifecycle.js');
    let tick, calls = 0; const logs = [];
    t.mock.method(globalThis, 'setInterval', callback => { tick = callback; return { unref() {} }; });
    t.mock.method(console, 'error', (...values) => logs.push(values));
    const handlers = { expire(before) {
      assert.ok(before < Date.now()); calls++;
      if (calls > 1) return;
      const error = new Error('private expiry content must never reach a log');
      if (asynchronous) return Promise.reject(error);
      throw error;
    } };
    startExpiry(handlers);
    await assert.doesNotReject(async () => tick());
    assert.equal(logs.length, 1); assert.equal(JSON.stringify(logs).includes('private expiry content'), false);
    assert.deepEqual(logs[0], [{ event: 'session-expiry-failed' }]);
    await tick(); assert.equal(calls, 2);
  });
}

test('demo ownership marks HTTPS cookies Secure and keeps HTTP localhost cookies usable', async () => {
  const { ownership } = await import('../session-lifecycle.js');
  for (const protocol of ['https', 'http']) {
    const request = new Request(`${protocol}://localhost/api/sessions`), response = new Response();
    ownership.created(response, 'cookie-owner-fixture', request);
    const cookie = response.headers.get('set-cookie');
    assert.equal(/; Secure(?:;|$)/u.test(cookie), protocol === 'https');
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.equal(ownership.token(new Request(request.url, { headers: { cookie: cookie.split(';')[0] } })), 'cookie-owner-fixture');
  }
});

test('the demo exposes a realistic operator allowlist and serves the settings modules', { timeout: 10_000 }, async t => {
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb());
  t.after(() => running.kill());
  for (const path of ['/packages/ui/src/settings-dialog.js', '/packages/ui/src/local-connector.js', '/packages/ui/src/settings-styles.js', '/packages/core/src/settings.js']) {
    assert.equal((await fetch(running.url + path)).status, 200, path);
  }
  for (const path of ['/demo/choices.js', '/packages/server/src/plugin-runtime.js']) assert.equal((await fetch(running.url + path)).status, 404, path);
  const created = await post(running.url + '/api/sessions', {}), session = await created.json();
  const cookie = created.headers.get('set-cookie').split(';')[0], headers = { cookie };
  assert.deepEqual([session.processingPreset, session.settings.model, session.settings.voice, session.settings.visuals, session.settings.origin],
    ['best', 'mock', 'fake-voice', 'fake-images', 'default']);
  const catalog = await fetch(running.url + `/api/sessions/${session.id}/settings`, { headers }).then(r => r.json());
  const ids = list => list.map(o => [o.id, o.status, o.reason]);
  assert.deepEqual(ids(catalog.presets.best.models), [['mock', 'consent', 'current processing consent required'],
    ['mock/deep', 'consent', 'current processing consent required'], ['openrouter/openai/gpt-4.1-mini', 'unavailable', 'not configured']]);
  assert.deepEqual(catalog.presets.custom.models.map(o => o.id), ['mock', 'mock/swift', 'mock/deep', 'openrouter/openai/gpt-4.1-mini']);
  assert.deepEqual(ids(catalog.presets.best.voices).map(([id, status]) => [id, status]), [['fake-voice', 'consent'], ['elevenlabs', 'unavailable']]);
  assert.deepEqual(ids(catalog.presets.best.visuals).map(([id, status]) => [id, status]), [['fake-images', 'consent'], ['openai-images', 'unavailable']]);
  assert.deepEqual([catalog.presets.eu.status, catalog.presets.eu.reason, catalog.presets.device.status], ['unavailable', 'not configured', 'available']);
  assert.equal(JSON.stringify(catalog).includes('example.test'), false, 'private endpoints stay on the server');
  const saved = await post(running.url + `/api/sessions/${session.id}/settings`, { processingPreset: 'custom', model: 'mock/swift', effort: 'low' }, headers);
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).consent, { required: true, features: ['text', 'analysis'] }, 'the demo still waits for mock consent');
});
