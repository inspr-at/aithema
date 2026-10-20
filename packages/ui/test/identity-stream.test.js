import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputRevision } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { window, tick, identity, setup, userTurn } from './host-surface-helpers.js';

for (const copy of [en, de]) test(`AIT-418: address change stays editable, blocks submit, then re-enables (${copy.display.locale})`, async t => {
  const verified = identity({ status: 'verified', address: 'before@example.test' });
  const { c, root, calls } = setup(t, { copy, host: { verification: true }, session: { identified: true, identity: verified },
    routes: { 'GET /identity': () => Response.json({ identity: verified, visitorEmail: { canSave: false } }), 'GET /visitor/email': () => Response.json({}, { status: 404 }) } });
  await tick(8);
  root.querySelector('.m-change-mail').click(); await tick();
  const form = root.querySelector('dialog.verify-dialog .verify-form'), input = form.querySelector('input'), submit = form.querySelector('.verify-send');
  userTurn(c);
  input.value = 'after@example.test';
  assert.equal(submit.getAttribute('aria-disabled'), 'true');
  assert.equal(input.disabled, false); assert.equal(input.readOnly, false);
  assert.equal(form.querySelector('.verify__message').textContent, copy.hostSurface.verify.streamWait);
  form.dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
  assert.equal(calls.some(call => call.path === '/identity/change'), false);
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'reply', role: 'assistant', content: 'Done.', inputRevision: inputRevision(c.session) } });
  assert.equal(submit.getAttribute('aria-disabled'), 'false');
  assert.equal(input.value, 'after@example.test');
  assert.equal(form.querySelector('.verify__message').textContent, '');
});

test('AIT-418: race failure renders existing failed reply with retry and permits address change', async t => {
  const verified = identity({ status: 'verified', address: 'before@example.test' });
  const { c, root } = setup(t, { host: { verification: true }, session: { identified: true, identity: verified } });
  await tick(8); userTurn(c);
  c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: { ...verified, status: 'verification-pending', identified: false } });
  const failure = { inputRevision: inputRevision(c.session), lane: 'reaction', error: 'reasoning-unavailable', retryable: true };
  c.receive({ type: 'lane.failed', data: failure });
  c.receive({ type: 'lane.status', data: { inputRevision: inputRevision(c.session), running: [], failures: [failure], lastFailure: failure } });
  assert.equal(root.querySelector('.reaction-failure').hidden, false);
  assert.match(root.querySelector('.reaction-failure').textContent, /reply|response|reasoning|answer/i);
  assert.equal(root.querySelector('.retry').hidden, false);
  assert.equal(root.querySelector('.verify-send').getAttribute('aria-disabled'), 'false');
});
