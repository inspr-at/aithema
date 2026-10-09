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
  const html = await fetch(running.url).then(r => r.text()); assert.match(html, /Demo — Aithema reset slice 1/);
  assert.match((await fetch(running.url + '/demo/config').then(r => r.json())).label, /Mock reasoning/);
  for (const path of ['/demo/host.js', '/packages/ui/src/session-element.js', '/packages/ui/src/post-json.js', '/packages/ui/src/i18n/en.js', '/packages/core/src/readiness.js']) {
    const r = await fetch(running.url + path); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
  }
  for (const path of ['/package.json', '/demo/config.js', '/.env', '/packages/server/src/storage.js']) assert.equal((await fetch(running.url + path)).status, 404);
  const s = await post(running.url + '/api/sessions', {}).then(r => r.json());
  await post(running.url + `/api/sessions/${s.id}/turns`, { clientEventId: 'demo-turn', content: 'Demo turn' });
  await running.kill(); running = await startChild(new URL('../server.js', import.meta.url), db);
  const restored = await fetch(running.url + `/api/sessions/${s.id}`).then(r => r.json()); assert.equal(restored.transcript[0].content, 'Demo turn');
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
const sendsMethod = source => /\bmethod\b\s*[:=]|new\s+Request\s*\(|navigator\.sendBeacon|XMLHttpRequest/u.test(source);
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
