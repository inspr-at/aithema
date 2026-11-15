import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.env.AITHEMA_EVIDENCE_DIR) {
  mkdirSync(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(process.env.AITHEMA_EVIDENCE_DIR, 'image-input-targeted.json'), JSON.stringify({ ticket: 'AIT-510', suite: 'image-input targeted' }) + '\n');
}
import { createSession, applyEvent, inputRevision, reasoningRequest } from '../src/index.js';

const event = (session, data) => ({ type: 'upload.state', seq: session.seq + 1, data });
for (const state of ['staged-pending', 'staged-ready', 'staged-refused', 'staged-discarded']) test(`AIT-510: ${state} never becomes conversation input`, () => {
  const session = createSession(), revision = inputRevision(session);
  session.transcript.push({ id: 'reply', role: 'assistant', content: 'Retained reply' });
  session.understanding.summary = 'Retained assessment';
  const next = applyEvent(session, event(session, { id: 'image', kind: 'image', state }));
  assert.equal(inputRevision(next), revision);
  assert.deepEqual(next.understanding, session.understanding);
  assert.deepEqual(next.transcript, session.transcript);
});

test('AIT-510: prompt references only sent images from the last two user turns, maximum four; drafts stay text-only', () => {
  const session = createSession();
  for (let i = 0; i < 4; i++) {
    const attachments = Array.from({ length: 3 }, (_, j) => `image-${i}-${j}`);
    session.transcript.push({ id: `turn-${i}`, role: 'user', content: '', attachments });
    session.uploads.push(...attachments.map(id => ({ id, kind: 'image', state: 'sent', filename: `${id}.png`, digest: 'fixture', w: 2, h: 1, mediaType: 'image/png' })));
  }
  session.uploads.push({ id: 'unsent', kind: 'image', state: 'staged-ready' });
  const references = request => request.messages.flatMap(m => m.images ?? []);
  const request = reasoningRequest(session, 'reaction');
  assert.equal(references(request).length, 4);
  assert.ok(references(request).every(r => /^image-[23]-/u.test(r.uploadId)));
  assert.match(request.messages.map(m => m.content).join('\n'), /sent earlier/u);
  assert.equal(references(reasoningRequest(session, 'understanding', true)).length, 0);
  assert.equal(references(reasoningRequest(session, 'understanding')).length, 4);
});

test('AIT-510: shared bound excludes image bytes and charges configured image tokens, refusing missing capability', async () => {
  const { reasoningInputBound } = await import('../src/image-input.js');
  const request = { messages: [{ role: 'user', content: 'fixture', images: [{ uploadId: 'image', digest: 'fixture', w: 2, h: 1, mediaType: 'image/png' }] }] };
  const plain = { messages: [{ role: 'user', content: 'fixture' }] };
  const capability = { maxImages: 4, maxTokensPerImage: 1600 };
  assert.equal(reasoningInputBound(request, capability), reasoningInputBound(plain) + 1600);
  assert.throws(() => reasoningInputBound(request), /image/u);
  assert.throws(() => reasoningInputBound(request, { ...capability, maxImages: 0 }), /image/u);
});
