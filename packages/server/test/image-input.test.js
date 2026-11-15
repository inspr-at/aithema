import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, SERVER_UPLOAD_LIMITS } from '../src/index.js';
import { inputRevision } from '@inspr/aithema-core';
import { testToken } from '../../../test/helpers.js';

const clock = 1_800_000_000_000;
function fixture(t) {
  const storage = new SQLiteStorage({ now: () => clock });
  t.after(() => storage.close());
  const session = storage.create({ ownerToken: testToken, demo: true });
  return { storage, session };
}
function stage(f, clientId = 'image') {
  return f.storage.postUploads(f.session.id, clientId, clientId, [{ filename: 'fixture.png', mediaType: 'image/png', kind: 'image', bytes: Buffer.from('fixture'), deadlineAt: clock + 25000 }], SERVER_UPLOAD_LIMITS).events[0].data;
}
test('AIT-510: stage, normalize, discard never changes input or erases replies; originals are erased', t => {
  const f = fixture(t), revision = inputRevision(f.session), upload = stage(f);
  assert.equal(upload.state, 'staged-pending');
  assert.equal(inputRevision(f.storage.get(f.session.id)), revision);
  f.storage.completeUpload(f.session.id, upload.id, { status: 'staged-ready', bytes: Buffer.from('normalized'), mediaType: 'image/png', digest: 'fixture', w: 2, h: 1 });
  assert.equal(f.storage.get(f.session.id).uploads[0].state, 'staged-ready');
  assert.equal(inputRevision(f.storage.get(f.session.id)), revision);
  f.storage.withdrawUpload(f.session.id, upload.id);
  assert.equal(inputRevision(f.storage.get(f.session.id)), revision);
  assert.equal(f.storage.uploadBytes(f.session.id, upload.id), null);
});
test('AIT-510: image-only turn atomically sends its attachments and replays once', t => {
  const f = fixture(t), upload = stage(f);
  f.storage.completeUpload(f.session.id, upload.id, { status: 'staged-ready', bytes: Buffer.from('normalized'), mediaType: 'image/png', digest: 'fixture', w: 2, h: 1 });
  const args = [f.session.id, 'turn', Buffer.from('turn-with-image'), '', { attachments: [upload.id] }];
  const sent = f.storage.postTurn(...args);
  assert.deepEqual(sent.event.data.attachments, [upload.id]);
  assert.equal(f.storage.get(f.session.id).uploads[0].state, 'sent');
  assert.equal(f.storage.postTurn(...args).replayed, true);
  assert.throws(() => f.storage.postTurn(f.session.id, 'other', Buffer.from('other'), '', { attachments: [upload.id] }));
});
test('AIT-510: eight images have a separate quota from eight documents', t => {
  const f = fixture(t);
  assert.equal(SERVER_UPLOAD_LIMITS.maxImagesPerSession, 8);
  for (let i = 0; i < 8; i++) stage(f, `image-${i}`);
  assert.throws(() => stage(f, 'ninth'), /limit/iu);
  assert.doesNotThrow(() => f.storage.postUploads(f.session.id, 'document', 'document', [{ filename: 'fixture.txt', mediaType: 'text/plain', bytes: Buffer.from('text'), deadlineAt: clock + 25000 }], SERVER_UPLOAD_LIMITS));
});

test('AIT-510: optional image-input withdrawal erases pixels, excludes images and keeps replies', t => {
  const f = fixture(t), upload = stage(f);
  f.storage.completeUpload(f.session.id, upload.id, { status: 'staged-ready', bytes: Buffer.from('normalized'), mediaType: 'image/png', digest: 'fixture', w: 2, h: 1 });
  f.storage.postTurn(f.session.id, 'turn', Buffer.from('turn'), '', { attachments: [upload.id] });
  f.storage.append(f.session.id, 'turn.final', { id: 'reply', role: 'assistant', content: 'Retained reply' });
  f.storage.reviseConsent(f.session.id, true, {}, { conversationUnchanged: true, removed: ['imageInput'] });
  const next = f.storage.get(f.session.id);
  assert.equal(next.transcript.at(-1).content, 'Retained reply');
  assert.equal(f.storage.uploadBytes(f.session.id, upload.id), null);
  assert.equal(next.uploads[0].state, 'withheld');
});
test('AIT-510: staged images expire after thirty minutes without conversation invalidation', t => {
  const f = fixture(t), upload = stage(f), revision = inputRevision(f.storage.get(f.session.id));
  assert.equal(upload.expiresAt, clock + 30 * 60 * 1000);
  const events = f.storage.expireStagedUploads(f.session.id, clock + 30 * 60 * 1000);
  assert.equal(events.length, 1);
  assert.equal(inputRevision(f.storage.get(f.session.id)), revision);
  assert.equal(f.storage.uploadBytes(f.session.id, upload.id), null);
});
