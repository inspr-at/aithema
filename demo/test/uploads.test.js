import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startChild, temporaryDb } from '../../test/helpers.js';

test('demo cookie ownership, existing consent, multipart route and durable upload snapshot', { timeout: 10000 }, async t => {
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb());
  t.after(() => running.kill());
  const created = await fetch(running.url + '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const session = await created.json(), cookie = created.headers.get('set-cookie').split(';')[0];
  assert.equal(session.featureMatrix.best.uploads.reason, 'current processing consent required');
  const endpoint = `${running.url}/api/sessions/${session.id}`;
  const form = () => { const data = new FormData(); data.append('clientEventId', 'demo-file');
    data.append('files', new File(['Read this local demo fixture'], 'demo.txt', { type: 'application/pdf' })); return data; };
  assert.equal((await fetch(endpoint + '/uploads', { method: 'POST', headers: { cookie }, body: form() })).status, 403);
  assert.equal((await fetch(endpoint + '/consent', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"granted":true}' })).status, 200);
  const posted = await fetch(endpoint + '/uploads', { method: 'POST', headers: { cookie }, body: form() });
  assert.equal(posted.status, 202); const pending = await posted.json();
  assert.equal(pending.uploads[0].state, 'pending');
  let current;
  for (let i = 0; i < 100; i++) {
    current = await fetch(endpoint, { headers: { cookie } }).then(r => r.json());
    if (current.uploads[0]?.state === 'accepted' && current.understanding.inputRevision !== null) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(current.uploads[0].state, 'accepted'); assert.equal(current.uploads[0].text, 'Read this local demo fixture');
  assert.equal((await fetch(endpoint + '/uploads', { method: 'POST', body: form() })).status, 404);
  assert.equal((await fetch(endpoint + '/uploads', { method: 'POST', headers: { cookie }, body: form() })).status, 200);
  assert.equal((await fetch(endpoint + `/uploads/${pending.uploads[0].id}`, { method: 'DELETE', headers: { cookie } })).status, 200);
  const removed = await fetch(endpoint + '/uploads', { headers: { cookie } }).then(r => r.json());
  assert.equal(removed.uploads[0].state, 'withdrawn'); assert.equal(removed.uploads[0].text, undefined);
});
