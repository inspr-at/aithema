// AIT-625 r7 (gate4c M1): the demo page's own requests (config, session restore, the outbox,
// postJson) carry the owner cookie, so they go through the guarded owner-request helper. On a page
// whose <base> points elsewhere the demo host sends nothing at all and reports its startup failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import '../../packages/ui/test/fixtures/page-origin.js';

test('AIT-625 r7 demo host: a foreign <base> on the demo page sends zero owner requests', { timeout: 30_000 }, async t => {
  const window = new Window({ url: 'http://app.test/' });
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  window.document.write(html.replace(/<script[^>]*>[\s\S]*?<\/script>/gu, '').replace('<head>', '<head><base href="https://evil.example/">'));
  const keys = ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'localStorage', 'location'];
  const originals = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const sent = [], strays = [];
  // Reading fetch from anywhere but the helper is recorded and gets a function that throws.
  Object.defineProperty(globalThis, 'fetch', { configurable: true, get() {
    const caller = new Error().stack.split('\n')[2] ?? '';
    if (/\/packages\/ui\/src\/owner-request\.js:/u.test(caller)) return async (url, init) => { sent.push({ url, init }); return Response.json({}); };
    strays.push(caller.trim());
    return () => { throw new Error('fetch outside the owner-request helper'); };
  } });
  t.after(async () => {
    await host?.stopHost?.();
    if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor); else delete globalThis.fetch;
    for (const key of keys) { if (originals[key]) Object.defineProperty(globalThis, key, originals[key]); else delete globalThis[key]; }
    await window.happyDOM.close();
  });
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: window[key] });
  const failed = new Promise(resolve => window.document.addEventListener('aithema-host-failed', resolve, { once: true }));
  let host;
  host = await import('../host.js');
  await Promise.race([failed, new Promise(resolve => setTimeout(resolve, 5000))]);
  assert.equal(sent.length, 0, 'a foreign <base>: zero owner requests');
  assert.deepEqual(strays, [], 'the demo host never reads fetch itself');
});
