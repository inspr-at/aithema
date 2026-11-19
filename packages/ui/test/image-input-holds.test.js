import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { reasonSeparator } from '../src/reason-separator.js';
import { window, tick, fixture, choose } from './image-input-fixture.js';

for (const copy of [en, de]) for (const entrance of ['choice', 'combined']) for (const detected of [false, true])
  for (const later of ['pick', 'drop', 'refused', 'paste'])
  test(`AIT-561 r2 Medium 1: ${copy.display.locale}/${entrance}/${detected}/${later} preserves held images through a later selection and grant`, async t => {
    const f = fixture(t, copy, false, { entrance }), original = globalThis.fetch, schedule = globalThis.setTimeout, timers = [];
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
      if (delay === 180000) { timers.push(callback); return schedule(() => {}, delay); }
      return schedule(callback, delay, ...args);
    });
    const heldName = detected ? 'scan.pdf' : 'photo.png';
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
      if (!url.endsWith('/uploads') || options.method !== 'POST') return original(url, options);
      const files = options.body.getAll('files'), events = [], refused = [];
      for (const [index, file] of files.entries()) {
        if (detected && file.name === heldName && !f.c.session.featureMatrix.best.imageInput.available)
          refused.push({ index, kind: 'image', reason: 'current processing consent required' });
        else events.push({ sessionId: f.c.session.id, seq: f.c.session.seq + events.length + 1, type: 'upload.state', data: {
          id: `held-${file.name}`, filename: file.name, kind: file.name === heldName || file.name === 'pasted.png' ? 'image' : 'document',
          state: file.name === heldName || file.name === 'pasted.png' ? 'staged-ready' : 'accepted', bytes: file.size, at: new Date(0).toISOString() } });
      }
      return Response.json({ events, refused }, { status: 202 });
    });
    await choose(f.root, [new window.File([new Uint8Array([255, 216, 255, 224])], heldName)]);
    assert.equal(timers.length, 1); assert.equal(f.asks.length, 1);
    const laterName = later === 'refused' ? 'newer.exe' : later === 'paste' ? 'pasted.png' : 'report.pdf';
    const file = new window.File(['%PDF-fixture'], laterName);
    if (later === 'drop' || later === 'paste') {
      const event = new window.Event(later === 'drop' ? 'drop' : 'paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, later === 'drop' ? 'dataTransfer' : 'clipboardData', { value: { types: ['Files'], files: [file], getData: () => '' } });
      f.root.querySelector('.conversation').dispatchEvent(event); await tick(); await tick();
    } else await choose(f.root, [file]);
    const notice = f.root.querySelector('.composer-reason').textContent;
    if (later === 'refused') assert.ok(notice.includes(copy.uploads.type.replace('{name}', laterName)), 'newer refusal stays visible');
    f.grantImages();
    for (let n = 0; n < 100 && !f.c.session.uploads.some(u => u.filename === heldName); n++) await tick();
    assert.equal(f.c.session.uploads.filter(u => u.filename === heldName).length, 1, 'the held image attaches exactly once after grant');
    if (later !== 'refused') assert.equal(f.c.session.uploads.filter(u => u.filename === laterName).length, 1);
    if (later === 'refused') assert.ok(f.root.querySelector('.composer-reason').textContent.includes(copy.uploads.type.replace('{name}', laterName)));
    const afterGrant = f.root.querySelector('.composer-reason').textContent;
    timers[0]();
    assert.equal(f.root.querySelector('.composer-reason').textContent, afterGrant, 'an obsolete hold timer cannot replace newer feedback');
  });

for (const copy of [en, de]) test(`AIT-561 r2 Medium 1: ${copy.display.locale} expiry preserves a newer refusal and visibly ends the older hold`, async t => {
  const f = fixture(t, copy, false), schedule = globalThis.setTimeout, timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 180000) { timers.push(callback); return schedule(() => {}, delay); }
    return schedule(callback, delay, ...args);
  });
  await choose(f.root, [new window.File(['pixels'], 'photo.png')]);
  await choose(f.root, [new window.File(['x'], 'newer.exe')]);
  const newer = copy.uploads.refused.replace('{list}', copy.uploads.type.replace('{name}', 'newer.exe')) + ' ' + copy.uploadsSupported;
  assert.equal(f.root.querySelector('.composer-reason').textContent, newer);
  timers[0]();
  assert.equal(f.root.querySelector('.composer-reason').textContent, newer + reasonSeparator + copy.uploadsReselect.one);
  f.grantImages(); await tick(); await tick();
  assert.equal(f.c.session.uploads.length, 0, 'expiry ends the hold with a visible choose-again reason');
});
