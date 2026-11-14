import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { Verification, POLL_MS } from '../src/verification.js';
import { en } from '../src/i18n/en.js';

const pending = { status: 'verification-pending', address: 'visitor@example.test', verificationRequired: true,
  assessmentUnlocked: false, pollVerification: true, resendAfterMs: 30_000 };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
  const window = new Window({ url: 'http://local/' }), document = window.document;
  globalThis.document = document;
  const host = document.createElement('div'); document.body.append(host);
  if (options.privacyDocumentConfigured) {
    const privacy = document.createElement('a'); privacy.slot = 'legal'; privacy.dataset.aithemaPrivacy = ''; privacy.href = '/privacy'; host.append(privacy);
  }
  const root = host.attachShadow({ mode: 'open' });
  const entry = document.createElement('section'), lock = document.createElement('section'), dialog = document.createElement('dialog');
  root.append(entry, lock, dialog);
  let visibility = options.hidden ? 'hidden' : 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  const calls = [], changes = [];
  const verification = new Verification({ root, entry, lock, dialog, copy: en, demo: true, identity: pending,
    onChange: change => changes.push(change), ...options, request: (path, body) => {
      calls.push({ path, body });
      return options.reply?.(path, body) ?? Promise.resolve({ ok: true, body: { identity: pending } });
    } });
  t.after(async () => { verification.destroy(); await window.happyDOM.close(); delete globalThis.document; });
  return { verification, calls, changes, lock, entry, document, window,
    visible(value) { visibility = value ? 'visible' : 'hidden'; document.dispatchEvent(new window.Event('visibilitychange')); },
    focus() { window.dispatchEvent(new window.Event('focus')); },
    async advance(ms) { t.mock.timers.tick(ms); await flush(); } };
}

test('AIT-518: connect checks immediately once, then polls from completion', async t => {
  const f = fixture(t);
  f.verification.connect();
  assert.deepEqual(f.calls, [{ path: 'identity/unlock', body: {} }]);
  await flush();
  await f.advance(POLL_MS - 1); assert.equal(f.calls.length, 1);
  await f.advance(1); assert.equal(f.calls.length, 2);
  await f.advance(POLL_MS); assert.equal(f.calls.length, 3);
});

test('AIT-518: hidden connect and focus do not poll; visible and focus coalesce after settlement', async t => {
  const f = fixture(t, { hidden: true });
  f.verification.connect(); f.focus();
  await f.advance(POLL_MS * 3); assert.equal(f.calls.length, 0);
  f.visible(true); await flush(); f.focus(); await flush();
  assert.equal(f.calls.length, 1);
  await f.advance(100); f.focus(); await flush(); assert.equal(f.calls.length, 1);
  await f.advance(POLL_MS); assert.equal(f.calls.length, 2);
  f.visible(false); f.focus();
  await f.advance(POLL_MS * 3); assert.equal(f.calls.length, 2);
  f.visible(true); f.focus(); await flush(); assert.equal(f.calls.length, 3);
});

test('AIT-518: focus alone refreshes and restarts the normal poll', async t => {
  const f = fixture(t);
  f.verification.connect(); await flush(); await f.advance(POLL_MS - 100);
  f.focus(); await flush(); assert.equal(f.calls.length, 2);
  await f.advance(100); assert.equal(f.calls.length, 2, 'old poll was cancelled');
  await f.advance(POLL_MS - 100); assert.equal(f.calls.length, 3);
});

test('AIT-518: a held check excludes focus, visibility and timer requests', async t => {
  let resolve;
  const f = fixture(t, { reply: () => new Promise(done => { resolve = done; }) });
  f.verification.connect(); assert.equal(f.calls.length, 1);
  f.visible(false); f.visible(true); f.focus(); f.verification.connect();
  await f.advance(POLL_MS * 3); assert.equal(f.calls.length, 1);
  resolve({ ok: true, body: { identity: pending } }); await flush();
  await f.advance(POLL_MS - 1); assert.equal(f.calls.length, 1);
  await f.advance(1); assert.equal(f.calls.length, 2);
});

for (const [gate, options] of [
  ['erased', { identity: { ...pending, erased: true } }],
  ['identity port unavailable', { identity: null }],
  ['polling disabled', { identity: { ...pending, pollVerification: false } }],
  ['delivery disabled', { delivery: false }],
  ['collection unavailable', { demo: false, privacyDocumentConfigured: false }],
]) test(`AIT-518: ${gate} blocks immediate and scheduled checks`, async t => {
  const f = fixture(t, options);
  f.verification.connect(); f.focus(); f.visible(false); f.visible(true);
  await f.advance(POLL_MS * 3); assert.equal(f.calls.length, 0);
});

for (const lifecycle of ['disconnect', 'destroy']) test(`AIT-518: ${lifecycle} removes listeners and prevents checks`, async t => {
  const f = fixture(t, { hidden: true });
  const removed = [];
  for (const [target, event] of [[f.document, 'visibilitychange'], [f.window, 'focus']]) {
    const original = target.removeEventListener.bind(target);
    t.mock.method(target, 'removeEventListener', (type, listener, ...args) => {
      if (type === event) removed.push(type);
      return original(type, listener, ...args);
    });
  }
  f.verification.connect(); f.verification[lifecycle]();
  f.visible(true); f.focus(); await f.advance(POLL_MS * 3);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(removed.sort(), ['focus', 'visibilitychange']);
  if (lifecycle === 'destroy') {
    f.verification.connect(); f.focus(); await f.advance(POLL_MS);
    assert.equal(f.calls.length, 0);
  } else {
    f.verification.connect(); await flush(); assert.equal(f.calls.length, 1);
  }
});

for (const lifecycle of ['erased', 'disconnect', 'destroy']) test(`AIT-518: a late check cannot revive ${lifecycle} state`, async t => {
  let resolve;
  const f = fixture(t, { reply: () => new Promise(done => { resolve = done; }) });
  f.verification.connect(); assert.equal(f.calls.length, 1);
  if (lifecycle === 'erased') f.verification.set({ ...pending, erased: true });
  else f.verification[lifecycle]();
  const before = f.verification.identity;
  resolve({ ok: true, body: { identity: { ...pending, status: 'verified', assessmentUnlocked: true, pollVerification: false } } });
  await flush(); f.focus(); f.visible(true); await f.advance(POLL_MS * 2);
  assert.deepEqual(f.verification.identity, before);
  assert.equal(f.calls.length, 1);
});

test('AIT-518: immediate confirmation repaints and unlocks without waiting for the poll', async t => {
  const confirmed = { ...pending, status: 'verified', assessmentUnlocked: true, pollVerification: false };
  const f = fixture(t, { reply: () => Promise.resolve({ ok: true, body: { identity: confirmed } }) });
  assert.equal(f.lock.hidden, false);
  f.verification.connect(); await flush();
  assert.deepEqual(f.verification.identity, confirmed);
  assert.equal(f.lock.hidden, true);
  assert.equal(f.lock.querySelector('form').dataset.mode, 'verified');
  assert.equal(f.entry.querySelector('.verify-done').hidden, false);
  assert.deepEqual(f.changes, [{ unlocked: true }]);
  f.focus(); await f.advance(POLL_MS * 2); assert.equal(f.calls.length, 1);
});

test('AIT-518: immediate fresh views only shorten an anchored resend cooldown', async t => {
  let resendAfterMs = 60_000;
  const f = fixture(t, { hidden: true, reply: () => Promise.resolve({ ok: true, body: { identity: { ...pending, resendAfterMs } } }) });
  f.verification.connect(); await f.advance(5000);
  f.visible(true); await flush();
  assert.equal(f.lock.querySelector('.verify__note').textContent, en.hostSurface.verify.cooldown.replace('{seconds}', '25'));
  await f.advance(1000); resendAfterMs = 2000; f.focus(); await flush();
  assert.equal(f.lock.querySelector('.verify__note').textContent, en.hostSurface.verify.cooldown.replace('{seconds}', '2'));
  assert.equal(f.calls.length, 2);
});

for (const outcome of ['rejected', 'unavailable']) test(`AIT-518: ${outcome} immediate request resumes polling`, async t => {
  const f = fixture(t, { reply: () => outcome === 'rejected' ? Promise.reject(new Error('fixture unavailable')) : Promise.resolve({ ok: false, status: 503 }) });
  f.verification.connect(); await flush(); assert.equal(f.calls.length, 1);
  await f.advance(POLL_MS); assert.equal(f.calls.length, 2);
});

test('AIT-518 M1: loading delivery on a non-demo host performs the owed connect check', async t => {
  const f = fixture(t, { demo: false, delivery: false, privacyDocumentConfigured: true,
    reply: path => Promise.resolve({ ok: true, body: path === 'identity' ?
      { identity: pending, delivery: true, visitorEmail: { canSave: false, canDelete: false } } : { identity: pending } }) });
  f.verification.connect(); await flush();
  assert.deepEqual(f.calls, []);
  await f.verification.load(); await flush();
  assert.deepEqual(f.calls.map(call => call.path), ['identity', 'identity/unlock']);
  f.focus(); f.visible(true); await flush();
  assert.equal(f.calls.length, 2, 'load, focus and visibility burst coalesces');
  await f.advance(POLL_MS - 1); assert.equal(f.calls.length, 2);
  await f.advance(1); assert.equal(f.calls.length, 3);
});

test('AIT-518 M1: non-demo delivery loaded while hidden refreshes on tab return', async t => {
  const f = fixture(t, { demo: false, delivery: false, privacyDocumentConfigured: true, hidden: true,
    reply: path => Promise.resolve({ ok: true, body: path === 'identity' ?
      { identity: pending, delivery: true, visitorEmail: { canSave: false, canDelete: false } } : { identity: pending } }) });
  f.verification.connect(); await f.verification.load(); await flush();
  await f.advance(POLL_MS * 2);
  assert.deepEqual(f.calls.map(call => call.path), ['identity']);
  f.visible(true); await flush(); f.focus(); await flush();
  assert.deepEqual(f.calls.map(call => call.path), ['identity', 'identity/unlock']);
  await f.advance(POLL_MS); assert.equal(f.calls.length, 3);
});

test('AIT-518 M1: an identity gate opening after connect performs the first check', async t => {
  const f = fixture(t, { identity: null });
  f.verification.connect(); await flush(); assert.equal(f.calls.length, 0);
  f.verification.set(pending); await flush();
  assert.deepEqual(f.calls, [{ path: 'identity/unlock', body: {} }]);
  f.verification.set(pending); f.focus(); await flush(); assert.equal(f.calls.length, 1);
});

test('AIT-518 L1: reconnect during a held check refreshes after its stale reply', async t => {
  let resolve;
  const confirmed = { ...pending, status: 'verified', assessmentUnlocked: true, pollVerification: false };
  const replies = [];
  const f = fixture(t, { reply: () => {
    if (!replies.length) { replies.push('held'); return new Promise(done => { resolve = done; }); }
    return Promise.resolve({ ok: true, body: { identity: confirmed } });
  } });
  f.verification.connect(); assert.equal(f.calls.length, 1);
  f.verification.disconnect(); f.verification.connect(); f.focus();
  assert.equal(f.calls.length, 1, 'reconnect never overlaps the old request');
  resolve({ ok: true, body: { identity: pending } }); await flush();
  await f.advance(250); // A fast stale reply may still be inside the burst window.
  assert.equal(f.calls.length, 2, 'the reconnect refresh is owed before the regular poll');
  assert.deepEqual(f.verification.identity, confirmed);
  assert.equal(f.lock.hidden, true);
  await f.advance(POLL_MS * 2); assert.equal(f.calls.length, 2);
});

test('AIT-518 L2: a backwards wall clock jump cannot suppress regular polls', async t => {
  const f = fixture(t);
  f.verification.connect(); await flush(); assert.equal(f.calls.length, 1);
  const jumpedNow = Date.now() - 60_000;
  t.mock.method(Date, 'now', () => jumpedNow);
  await f.advance(POLL_MS); assert.equal(f.calls.length, 2);
  await f.advance(POLL_MS); assert.equal(f.calls.length, 3);
});
