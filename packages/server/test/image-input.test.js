import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, SERVER_UPLOAD_LIMITS } from '../src/index.js';
import { inputRevision } from '@inspr/aithema-core';
import { testToken } from '../../../test/helpers.js';

const clock = 1_800_000_000_000;
function fixture(t) {
  const storage = new SQLiteStorage(':memory:', { now: () => clock });
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

test('AIT-510: fixture pixels reach reply and final understanding only after image-only send, with owner-only export', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: clock });
  const { createHandlers, createPluginRuntime } = await import('../src/index.js');
  const { PluginRegistry } = await import('@inspr/aithema-core');
  const { createOpenRouterReasoning } = await import('@inspr/aithema-plugin-openrouter');
  const { createImageInput } = await import('../../../plugins/image-input/src/index.js');
  const { qualifyStartBinding } = await import('../../../demo/processing-consent.js');
  const { ownedRequest, unzip } = await import('../../../test/helpers.js');
  const { default: sharp } = await import('sharp');
  const storage = new SQLiteStorage(), seen = [], imageInput = { maxImages: 4, maxTokensPerImage: 1600 };
  const binding = qualifyStartBinding({ plugin: 'openrouter', model: 'anthropic/fixture', effort: 'none', endpoint: 'https://example.test/chat',
    accountRef: 'fixture', secretRef: 'fixture', maxMicro: 1000000, maxTokens: 1000, rates: { inputMicro: 1, outputMicro: 1 }, imageInput }, clock);
  const consent = { coverage({ scope, consentRevision }) { return { covered: true, ...scope, scope, consentRevision, checkedAt: clock, expiresAt: clock + 60000 }; } };
  const reasoning = createOpenRouterReasoning({ binding, prices: { 'anthropic/fixture': { prompt: .000001, completion: .000001 } }, resolveSecret: () => 'fixture',
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body), parts = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []);
      const image = parts.find(p => p.type === 'image_url'); let red = false;
      if (image) {
        const pixels = await sharp(Buffer.from(image.image_url.url.split(',')[1], 'base64')).resize(1, 1).removeAlpha().raw().toBuffer();
        red = pixels[0] > 200 && pixels[1] < 70 && pixels[2] < 70;
      }
      seen.push({ stream: body.stream, red });
      const summary = red ? 'Red screenshot' : 'No screenshot';
      const result = body.stream ? { content: summary, question_short: null, options: [] } : { summary, signals: [summary], openQuestions: [],
        constraints: Object.fromEntries(storage.get(session.id).preset.slots.map(key => [key, null])),
        progress: { talk: { value: .2, reasoning: 'Fixture' }, build: { value: .1, reasoning: 'Fixture' } }, actor: null, engagement: null, conceptIntent: null };
      const usage = { prompt_tokens: 1800, completion_tokens: 20, cost: 0 };
      return body.stream ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(result) }, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`)
        : Response.json({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }], usage });
    } });
  const registry = new PluginRegistry().register(reasoning).register(createImageInput());
  const presets = { best: { plugins: ['openrouter', 'image-input'], bindings: { reaction: binding, understanding: binding }, policy: { endpoints: [binding.endpoint] }, imageInput: { plugin: 'image-input' } } };
  const runtime = createPluginRuntime({ storage, reasoning, registry, presets, consent, now: () => clock });
  const handlers = createHandlers({ storage, reasoning, pluginRuntime: runtime, consent, now: () => clock });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ ownerToken: testToken, demo: true }), revision = inputRevision(session);
  const source = await sharp({ create: { width: 2, height: 1, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const form = new FormData(); form.append('clientEventId', 'fixture-image'); form.append('files', new File([source], 'red.png', { type: 'image/png' }));
  const response = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/uploads`, { method: 'POST', body: form }));
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  await handlers.idle();
  const staged = storage.get(session.id).uploads[0]; assert.equal(staged.state, 'staged-ready');
  assert.equal(inputRevision(storage.get(session.id)), revision); assert.deepEqual(seen, [], 'attach schedules no provider work');
  const route = `http://localhost/api/sessions/${session.id}/uploads/${staged.id}/image`;
  assert.equal((await handlers.handle(new Request(route))).status, 404);
  const imageResponse = await handlers.handle(ownedRequest(route)); assert.equal(imageResponse.status, 200); assert.equal(imageResponse.headers.get('cache-control'), 'no-store');
  const servedImage = Buffer.from(await imageResponse.arrayBuffer());
  const servedPixels = await sharp(servedImage).resize(1, 1).removeAlpha().raw().toBuffer();
  assert.ok(servedPixels[0] > 200 && servedPixels[1] < 70 && servedPixels[2] < 70, 'the owner route serves normalized fixture pixels');
  const send = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/turns`, { method: 'POST', body: JSON.stringify({ clientEventId: 'sent-image', content: '', attachments: [staged.id] }) }));
  assert.equal(send.status, 200); await handlers.idle();
  assert.ok(seen.some(call => call.stream && call.red), 'reply depends on the actual fixture pixels');
  assert.ok(seen.some(call => !call.stream && call.red), 'final understanding depends on the actual fixture pixels');
  assert.equal(storage.get(session.id).understanding.summary, 'Red screenshot');
  const exported = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/export`));
  assert.equal(exported.status, 200);
  const files = unzip(Buffer.from(await exported.arrayBuffer()), { binary: true });
  assert.ok(Object.keys(files).some(path => path.startsWith('images/')));
  const exportedImage = Object.entries(files).find(([path]) => path.startsWith('images/'));
  assert.deepEqual(Buffer.from(exportedImage[1]), servedImage, 'export contains the exact normalized image bytes');
  assert.equal(JSON.stringify(storage.db.prepare('SELECT * FROM events').all()).includes(source.toString('base64')), false);
  const revisionBeforeRefusals = inputRevision(storage.get(session.id)), callsBeforeRefusals = seen.length;
  for (const [name, type, bytes] of [['clipboard', 'image/heic', Buffer.from('excluded image fixture')],
    ['blob', 'application/octet-stream', Buffer.from([0,0,0,20,102,116,121,112,104,101,105,99,0,0,0,0,104,101,105,99])]]) {
    const rejected = new FormData(); rejected.append('clientEventId', `excluded-${name}`); rejected.append('files', new File([bytes], name, { type }));
    const response = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/uploads`, { method: 'POST', body: rejected }));
    assert.equal(response.status, 202); await handlers.idle();
    const image = storage.get(session.id).uploads.find(upload => upload.filename === name);
    assert.equal(image.kind, 'image'); assert.equal(image.state, 'staged-refused'); assert.equal(image.reason, 'unsupported');
    assert.equal(storage.uploadBytes(session.id, image.id), null);
    assert.equal(inputRevision(storage.get(session.id)), revisionBeforeRefusals);
    assert.equal(storage.get(session.id).understanding.summary, 'Red screenshot');
    assert.equal(seen.length, callsBeforeRefusals, 'unsupported images schedule no provider work');
  }
});

test('AIT-510: late normalization cannot restore a discarded or consent-revoked image', t => {
  const f = fixture(t), first = stage(f, 'first'), second = stage(f, 'second');
  f.storage.withdrawUpload(f.session.id, first.id);
  f.storage.reviseConsent(f.session.id, true, {}, { conversationUnchanged: true, removed: ['imageInput'] });
  for (const image of [first, second]) {
    assert.equal(f.storage.completeUpload(f.session.id, image.id, { status: 'staged-ready', bytes: Buffer.from('late'), mediaType: 'image/png', w: 1, h: 1 }), null);
    assert.equal(f.storage.uploadBytes(f.session.id, image.id), null);
  }
});
test('AIT-510: replaying erased staged events does not invent input revisions', async t => {
  const { applyEvent, createSession } = await import('@inspr/aithema-core');
  const f = fixture(t), image = stage(f); f.storage.withdrawUpload(f.session.id, image.id);
  const replay = f.storage.read(f.session.id).reduce(applyEvent, createSession({ id: f.session.id, demo: true }));
  assert.equal(inputRevision(replay), inputRevision(f.storage.get(f.session.id)));
  assert.equal(replay.uploads[0].state, 'staged-discarded');
});

test('AIT-510: normalized bytes and send receipts survive a storage restart', async t => {
  const { temporaryDb } = await import('../../../test/helpers.js'), path = await temporaryDb();
  let storage = new SQLiteStorage(path, { now: () => clock }); t.after(() => storage.close());
  const session = storage.create({ ownerToken: testToken, demo: true }), f = { storage, session }, image = stage(f);
  const pixels = Buffer.from('normalized pixels');
  storage.completeUpload(session.id, image.id, { status: 'staged-ready', bytes: pixels, mediaType: 'image/png', w: 2, h: 1 });
  storage.close(); storage = new SQLiteStorage(path, { now: () => clock });
  assert.deepEqual(Buffer.from(storage.uploadBytes(session.id, image.id)), pixels);
  assert.equal(storage.get(session.id).uploads[0].state, 'staged-ready');
  const args = [session.id, 'sent', Buffer.from('sent with image'), '', { attachments: [image.id] }];
  storage.postTurn(...args); storage.close(); storage = new SQLiteStorage(path, { now: () => clock });
  assert.equal(storage.postTurn(...args).replayed, true);
  assert.equal(storage.get(session.id).transcript.length, 1);
  assert.equal(storage.get(session.id).uploads[0].state, 'sent');
});
