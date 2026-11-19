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
  assert.equal(f.root.querySelector('.held-upload-notice').textContent, newer.slice(0, -(1 + copy.uploadsSupported.length)));
  timers[0]();
  assert.equal(f.root.querySelector('.composer-reason').textContent, newer + reasonSeparator + copy.uploadsReselect.one);
  f.grantImages(); await tick(); await tick();
  assert.equal(f.c.session.uploads.length, 0, 'expiry ends the hold with a visible choose-again reason');
});

// A detected image can share its first selection with a refused document.
function followupFixture(t, copy, entrance = 'choice', detected = true, available = false) {
  const f = fixture(t, copy, available, { entrance }), original = globalThis.fetch;
  let receipt = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (!url.endsWith('/uploads') || options.method !== 'POST') return original(url, options);
    const events = [], refused = [], files = options.body.getAll('files');
    for (const [index, file] of files.entries()) {
      const image = file.name === 'scan.pdf' || file.name === 'photo.png';
      if (image && (!f.c.session.featureMatrix.best.imageInput.available || available))
        refused.push({ index, kind: 'image', reason: 'current processing consent required' });
      else events.push({ sessionId: f.c.session.id, seq: f.c.session.seq + events.length + 1, type: 'upload.state', data: {
        id: `receipt-${++receipt}`, filename: file.name, kind: image ? 'image' : 'document', state: image ? 'staged-ready' : 'accepted', bytes: file.size, at: new Date(0).toISOString() } });
    }
    return Response.json({ events, refused }, { status: 202 });
  });
  return { ...f, held: (extra = {}) => new window.File([new Uint8Array([255, 216, 255, 224])], detected ? 'scan.pdf' : 'photo.png', { lastModified: 1234, ...extra }) };
}

for (const copy of [en, de]) for (const entrance of ['choice', 'combined']) for (const detected of [false, true])
  test(`AIT-563 Low 1: ${copy.display.locale}/${entrance}/${detected} newer refusal keeps named held consent visible`, async t => {
    const f = followupFixture(t, copy, entrance, detected), held = f.held();
    await choose(f.root, [held]);
    await choose(f.root, [new window.File(['x'], 'newer.exe')]);
    const reason = f.root.querySelector('.composer-reason');
    assert.ok(reason.textContent.includes(copy.uploads.type.replace('{name}', 'newer.exe')));
    assert.ok(reason.textContent.includes(held.name), 'the consent line names the held file');
    assert.equal(reason.querySelector('.consent-action')?.textContent, copy.featureConsent.action, 'the existing consent action stays present');
    assert.ok(reason.querySelector('.consent-line-copy')?.textContent.includes(copy.featureConsent.imageInput));
  });

for (const copy of [en, de]) for (const entrance of ['choice', 'combined']) for (const detected of [false, true])
  test(`AIT-563 Low 2: ${copy.display.locale}/${entrance}/${detected} re-picking the same held file attaches once`, async t => {
    const f = followupFixture(t, copy, entrance, detected);
    await choose(f.root, [f.held()]); await choose(f.root, [f.held()]);
    f.grantImages();
    for (let n = 0; n < 100 && !f.c.session.uploads.length; n++) await tick();
    assert.equal(f.c.session.uploads.length, 1, 'distinct File objects with the same name, size and lastModified attach once');
  });

for (const copy of [en, de]) for (const ending of ['grant', 'expiry']) for (const newer of [false, true])
  test(`AIT-563 Low 3: ${copy.display.locale}/${ending}/${newer} a successful later attachment clears the old held-selection notice permanently`, async t => {
    const f = followupFixture(t, copy), schedule = globalThis.setTimeout, timers = [];
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
      if (delay === 180000) { timers.push(callback); return schedule(() => {}, delay); }
      return schedule(callback, delay, ...args);
    });
    await choose(f.root, [f.held(), new window.File(['x'], 'older.exe')]);
    await choose(f.root, [new window.File(['%PDF-fixture'], 'report.pdf')]);
    assert.equal(f.root.querySelector('.composer-reason').textContent.includes('older.exe'), false);
    if (newer) await choose(f.root, [new window.File(['x'], 'newer.exe')]);
    if (ending === 'expiry') timers.at(-1)();
    else {
      f.grantImages();
      for (let n = 0; n < 100 && !f.c.session.uploads.some(u => u.kind === 'image'); n++) await tick();
      assert.equal(f.c.session.uploads.filter(u => u.kind === 'image').length, 1);
    }
    const reason = f.root.querySelector('.composer-reason').textContent;
    assert.equal(reason.includes('older.exe'), false, 'cleared older feedback never resurrects');
    assert.equal(reason.includes('newer.exe'), newer, 'current newer feedback survives');
    if (ending === 'expiry') assert.ok(reason.includes(copy.uploadsReselect.one));
    assert.ok(f.c.session.uploads.some(u => u.filename === 'report.pdf'), 'eligible documents continue');
  });

test('AIT-563 Low 2: files with different metadata remain separate holds', async t => {
  const f = followupFixture(t, en);
  await choose(f.root, [f.held(), f.held({ lastModified: 5678 }), new window.File(['different bytes'], 'scan.pdf', { lastModified: 1234 })]);
  f.grantImages();
  for (let n = 0; n < 100 && !f.c.session.uploads.length; n++) await tick();
  assert.equal(f.c.session.uploads.length, 3);
});

for (const copy of [en, de]) for (const entrance of ['choice', 'combined'])
  test(`AIT-563 Low 1 retry: ${copy.display.locale}/${entrance} retained newer documents keep the held image consent action`, async t => {
    const f = followupFixture(t, copy, entrance), original = globalThis.fetch, schedule = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => schedule(callback, [5000, 10000].includes(delay) ? 0 : delay, ...args));
    t.mock.method(globalThis, 'fetch', (url, options = {}) => url.endsWith('/uploads') && options.method === 'POST' && options.body.getAll('files').some(file => file.name === 'report.pdf')
      ? Response.json({ error: 'upload-rate-limit' }, { status: 429 }) : original(url, options));
    await choose(f.root, [f.held()]); await choose(f.root, [new window.File(['%PDF-fixture'], 'report.pdf')]);
    for (let n = 0; n < 100 && !f.root.querySelector('.upload-retry'); n++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(f.root.querySelector('.upload-retry'), 'the newer document retains its retry action');
    assert.ok(f.root.querySelector('.upload-discard'), 'the newer document retains its discard action');
    const consent = f.root.querySelector('[data-consent-feature="imageInput"]');
    assert.equal(consent?.querySelector('.consent-action')?.textContent, copy.featureConsent.action, 'the held image retains its own consent action');
    assert.ok(consent.textContent.includes('scan.pdf'));
  });

for (const copy of [en, de]) test(`AIT-563 Low 1 retry expiry: ${copy.display.locale} expiry removes the ended hold's consent action`, async t => {
  const f = followupFixture(t, copy), original = globalThis.fetch, schedule = globalThis.setTimeout, timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 180000) { timers.push(callback); return schedule(() => {}, delay); }
    return schedule(callback, [5000, 10000].includes(delay) ? 0 : delay, ...args);
  });
  t.mock.method(globalThis, 'fetch', (url, options = {}) => url.endsWith('/uploads') && options.method === 'POST' && options.body.getAll('files').some(file => file.name === 'report.pdf')
    ? Response.json({ error: 'upload-rate-limit' }, { status: 429 }) : original(url, options));
  await choose(f.root, [f.held()]); await choose(f.root, [new window.File(['%PDF-fixture'], 'report.pdf')]);
  for (let n = 0; n < 100 && !f.root.querySelector('.upload-retry'); n++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(f.root.querySelector('.held-upload-consent'));
  timers.at(-1)();
  assert.equal(f.root.querySelector('.held-upload-consent') === null, true, 'expired files no longer offer a consent action');
  assert.ok(f.root.querySelector('.upload-retry'));
  assert.ok(f.root.querySelector('.upload-discard'));
  assert.ok(f.root.querySelector('.composer-reason').textContent.includes(copy.uploadsReselect.one));
});

test('AIT-563 Low 1 retry expiry: discarding newer retained documents keeps the live held image', async t => {
  const f = followupFixture(t, en), original = globalThis.fetch, schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => schedule(callback, [5000, 10000].includes(delay) ? 0 : delay, ...args));
  t.mock.method(globalThis, 'fetch', (url, options = {}) => url.endsWith('/uploads') && options.method === 'POST' && options.body.getAll('files').some(file => file.name === 'report.pdf')
    ? Response.json({ error: 'upload-rate-limit' }, { status: 429 }) : original(url, options));
  await choose(f.root, [f.held()]); await choose(f.root, [new window.File(['%PDF-fixture'], 'report.pdf')]);
  for (let n = 0; n < 100 && !f.root.querySelector('.upload-retry'); n++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(f.root.querySelector('.upload-discard'));
  f.root.querySelector('.upload-discard').click();
  assert.equal(f.root.querySelector('.upload-retry') === null, true);
  assert.equal(f.root.querySelector('.held-upload-consent .consent-action')?.textContent, en.featureConsent.action);
  assert.ok(f.root.querySelector('.held-upload-consent').textContent.includes('scan.pdf'));
  f.grantImages();
  for (let n = 0; n < 100 && !f.c.session.uploads.length; n++) await tick();
  assert.deepEqual(f.c.session.uploads.map(u => u.filename), ['scan.pdf']);
});

for (const copy of [en, de]) for (const ending of ['decline', 'expiry', 'grant'])
  test(`AIT-566 L-b: ${copy.display.locale}/${ending} re-hold replaces choose-again feedback`, async t => {
    const f = followupFixture(t, copy, 'choice', false), schedule = globalThis.setTimeout, timers = [];
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
      if (delay === 180000) { timers.push(callback); return schedule(() => {}, delay); }
      return schedule(callback, delay, ...args);
    });
    await choose(f.root, [f.held()]); f.asks.at(-1).cancel();
    assert.ok(f.root.querySelector('.composer-reason').textContent.includes(copy.uploadsReselect.one));
    await choose(f.root, [f.held()]);
    const during = f.root.querySelector('.composer-reason').textContent;
    if (ending === 'decline') f.asks.at(-1).cancel();
    else if (ending === 'expiry') timers.at(-1)();
    else {
      f.grantImages();
      for (let n = 0; n < 100 && !f.c.session.uploads.length; n++) await tick();
      assert.equal(f.c.session.uploads.length, 1);
    }
    const after = f.root.querySelector('.composer-reason').textContent;
    assert.equal(after.split(copy.uploadsReselect.one).length - 1, ending === 'grant' ? 0 : 1, 'choose again occurs once after an ended hold and disappears after attachment');
    assert.equal(during.includes(copy.uploadsReselect.one), false, 'the live consent line supersedes stale choose-again feedback');
  });

for (const copy of [en, de]) test(`AIT-566 L-a: ${copy.display.locale} text consent action exists on the first blocked render`, async t => {
  const f = followupFixture(t, copy), original = globalThis.fetch;
  await choose(f.root, [f.held()]);
  const reason = f.root.querySelector('.composer-reason'), toggle = reason.toggleAttribute.bind(reason), renders = [];
  t.mock.method(reason, 'toggleAttribute', (name, force) => {
    if (name === 'data-held-consent' && !f.c.session.featureMatrix.best.text.available)
      renders.push({ action: Boolean(reason.querySelector('.consent-action')), feature: reason.dataset.consentFeature });
    return toggle(name, force);
  });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith(`/api/sessions/${f.c.session.id}`)) {
      const snapshot = f.c.session;
      snapshot.featureMatrix.best.text = { available: false, reason: 'current processing consent required' };
      return Response.json(snapshot);
    }
    return original(url, options);
  });
  f.c.receive({ sessionId: f.c.session.id, seq: f.c.session.seq + 1, type: 'settings.changed', data: { processingPreset: 'best', settings: { ...f.c.session.settings, revision: 2 } } });
  for (let n = 0; n < 100 && !renders.length; n++) await tick();
  assert.deepEqual(renders[0], { action: true, feature: 'text' }, 'no extra render tick is allowed to restore the text consent action');
});

for (const copy of [en, de]) test(`AIT-566 L-c: ${copy.display.locale} newer image and document refusals share the held line`, async t => {
  const f = followupFixture(t, copy, 'choice', true, true);
  await choose(f.root, [f.held()]);
  const large = new window.File(['pixels'], 'oversized.png'); Object.defineProperty(large, 'size', { value: 21 * 1024 * 1024 });
  await choose(f.root, [new window.File(['x'], 'newer.exe'), large]);
  const reason = f.root.querySelector('.composer-reason');
  assert.ok(reason.textContent.includes(copy.uploads.type.replace('{name}', 'newer.exe')));
  assert.ok(reason.textContent.includes('oversized.png'), 'the newer image refusal stays visible during the hold');
  assert.ok(reason.textContent.includes(copy.imageRefusals.size));
  assert.ok(reason.querySelector('.held-upload-consent .consent-action'));
});
