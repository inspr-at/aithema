import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startChild, temporaryDb, post } from '../../test/helpers.js';
test('demo serves native UI modules, labelled mock host and persistent handlers', { timeout: 10_000 }, async t => {
  const db = await temporaryDb(); let running = await startChild(new URL('../server.js', import.meta.url), db);
  t.after(async () => running.kill());
  const html = await fetch(running.url).then(r => r.text()); assert.match(html, /Demo — Aithema reset slice 1/);
  assert.match((await fetch(running.url + '/demo/config').then(r => r.json())).label, /Mock reasoning/);
  for (const path of ['/demo/host.js', '/packages/ui/src/session-element.js', '/packages/ui/src/i18n/en.js', '/packages/core/src/readiness.js']) {
    const r = await fetch(running.url + path); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
  }
  for (const path of ['/package.json', '/demo/config.js', '/.env', '/packages/server/src/storage.js']) assert.equal((await fetch(running.url + path)).status, 404);
  const s = await post(running.url + '/api/sessions', {}).then(r => r.json());
  await post(running.url + `/api/sessions/${s.id}/turns`, { clientEventId: 'demo-turn', content: 'Demo turn' });
  await running.kill(); running = await startChild(new URL('../server.js', import.meta.url), db);
  const restored = await fetch(running.url + `/api/sessions/${s.id}`).then(r => r.json()); assert.equal(restored.transcript[0].content, 'Demo turn');
});
