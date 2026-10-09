import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startChild, temporaryDb, post, readEvents } from '../../test/helpers.js';
import { inputRevision } from '@inspr/aithema-core';

test('labelled local PNG concept flow persists progress, feedback, archive and image bytes across a demo restart', { timeout: 15000 }, async t => {
  const db = await temporaryDb(); let running = await startChild(new URL('../server.js', import.meta.url), db, { AITHEMA_HTML_MODE: 'off' });
  t.after(async () => running.kill());
  const config = await fetch(running.url + '/demo/config').then(r => r.json());
  assert.equal(config.imageMode, 'fake'); assert.match(config.imageLabel, /Fake images.*no provider network/);
  const created = await post(running.url + '/api/sessions', {}), session = await created.json();
  const cookie = created.headers.get('set-cookie').split(';')[0], headers = { cookie };
  const path = action => `${running.url}/api/sessions/${session.id}${action ? '/' + action : ''}`;
  await post(path('consent'), { granted: true }, headers);
  await post(path('turns'), { clientEventId: 'needs', content: 'operations: hosted; data: public; systems: API; reach: international' }, headers);
  async function wait(predicate) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const current = await fetch(path(''), { headers }).then(r => r.json()); if (predicate(current)) return current;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('Demo concept did not reach expected state');
  }
  await wait(s => s.understanding.inputRevision === inputRevision(s));
  const request = await post(path('concepts'), { clientEventId: 'wish', intent: true, sourceTurnId: 'needs' }, headers); assert.equal(request.status, 202);
  const ready = await wait(s => s.concepts?.length === 1), first = ready.concepts[0];
  const image = await fetch(path(`concepts/${first.id}/image`), { headers }), bytes = new Uint8Array(await image.arrayBuffer());
  assert.equal(image.headers.get('content-type'), 'image/png'); assert.ok(bytes.length > 1000);
  assert.equal(first.provenance.generator.provider, 'local-demo-fake');
  const events = await readEvents(await fetch(path('events'), { headers }), ready.seq);
  assert.ok(events.some(e => e.type === 'concept.state' && e.data.status.phase === 'pending'));
  assert.ok(events.some(e => e.type === 'concept.state' && e.data.status.phase === 'ready'));
  await post(path(`concepts/${first.id}/feedback`), { clientEventId: 'feedback', vote: 'up', chips: ['More contrast'] }, headers);
  await post(path(`concepts/${first.id}/regenerate`), { clientEventId: 'refinement', intent: true, sourceTurnId: 'needs' }, headers);
  const refined = await wait(s => s.concepts.length === 2), second = refined.concepts[1];
  assert.equal(second.provenance.origin, 'ai-manipulated');
  await post(path(`concepts/${second.id}/reject`), { clientEventId: 'reject' }, headers);
  await running.kill(); running = await startChild(new URL('../server.js', import.meta.url), db, { AITHEMA_HTML_MODE: 'off' });
  assert.equal((await fetch(path(`concepts/${first.id}/image`), { headers })).status, 403, 'restart loses the host grant');
  await post(path('consent'), { granted: true }, headers);
  const restored = await fetch(path(''), { headers }).then(r => r.json());
  assert.equal(restored.concepts.length, 2); assert.equal(restored.concepts[1].archived, true);
  assert.deepEqual(restored.concepts[0].feedback.chips, ['More contrast']);
  assert.deepEqual(new Uint8Array(await (await fetch(path(`concepts/${first.id}/image`), { headers })).arrayBuffer()), bytes);
  assert.equal((await fetch(path(`concepts/${first.id}/image`))).status, 404);
});
