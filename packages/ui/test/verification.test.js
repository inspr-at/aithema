import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { Verification } from '../src/verification.js';
import { en } from '../src/i18n/en.js';
import { confirmationHost } from '../../../test/fixtures/confirmation-host.js';

test('AIT-414: tiers and conversation identity confirm and change without a visitor-email port', async t => {
  const f = await confirmationHost(t), window = new Window({ url: 'http://local/' });
  globalThis.document = window.document;
  t.after(() => { delete globalThis.document; });
  const host = window.document.createElement('div'); window.document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const entry = window.document.createElement('section'), lock = window.document.createElement('section'), dialog = window.document.createElement('dialog');
  root.append(entry, lock, dialog);
  const verification = new Verification({ root, entry, lock, dialog, copy: en, request: f.call, identity: f.session.identity, demo: true });
  t.after(async () => { verification.destroy(); await window.happyDOM.close(); });
  await verification.load(); verification.setCredits({ tiers: f.tiers() });
  assert.equal(f.calls.filter(call => call.path === '/api/visitor/email').length, 0, 'AIT-442: no read without the visitor-email port');
  for (const [command, address] of [['request', 'first@example.test'], ['change', 'changed@example.test']]) {
    if (command === 'change') lock.querySelector('.verify-change').click();
    lock.querySelector('input').value = address;
    lock.querySelector('form').requestSubmit();
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls.filter(call => call.path === `identity/${command}`), [{ path: `identity/${command}`, body: { address } }]);
    assert.equal(verification.identity.status, 'verification-pending');
    assert.equal(f.deliveries.at(-1).address, address);
    const confirmed = await f.call('identity/confirm', { token: 'fixture-confirmation' });
    assert.equal(confirmed.ok, true);
    verification.set(confirmed.body.identity);
    assert.equal(verification.identity.status, 'verified');
    assert.equal(verification.identity.address, address);
    assert.equal(f.tiers().current, 'emailConfirmed');
  }
  assert.equal(f.calls.filter(call => call.path === '/api/visitor/email' && call.body).length, 0, 'no visitor-email write is attempted');
});

for (const visitorEmail of [null, {}, { canSave: false }, { canSave: true, canDelete: true }, { canSave: true, canDelete: false }, { canSave: false, canDelete: true }]) {
  test(`AIT-442: visitor-email reads remain compatible with capabilities ${JSON.stringify(visitorEmail)}`, async t => {
    const window = new Window({ url: 'http://local/' });
    globalThis.document = window.document;
    t.after(() => { delete globalThis.document; });
    const host = window.document.createElement('div'); window.document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const entry = window.document.createElement('section'), lock = window.document.createElement('section'), dialog = window.document.createElement('dialog');
    root.append(entry, lock, dialog);
    const identity = { status: 'guest', address: null, assessmentUnlocked: true, pollVerification: false }, calls = [];
    const verification = new Verification({ root, entry, lock, dialog, copy: en, demo: true, request: async path => {
      calls.push(path);
      return path === 'identity' ? { ok: true, body: { identity, visitorEmail } }
        : { ok: false, status: 404, body: { error: 'visitor-unavailable' } };
    } });
    t.after(async () => { verification.destroy(); await window.happyDOM.close(); });
    await verification.load();
    assert.deepEqual(calls, ['identity', '/api/visitor/email']);
    assert.equal(verification.enabled, true, 'an unavailable visitor read keeps conversation verification');
    assert.deepEqual(verification.identity, identity);
  });
}
