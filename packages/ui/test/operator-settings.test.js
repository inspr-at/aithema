import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { OperatorSettings } from '../src/operator-settings.js';
import { de } from '../src/i18n/de.js';
import { en } from '../src/i18n/en.js';

for (const copy of [de, en]) test(`AIT-165 final General section: muted native operator navigation and inline error (${copy.display.locale})`, async () => {
  const window = new Window();
  try {
    const parent = window.document.createElement('div'); parent.innerHTML = '<section>Existing settings</section><section class="host-verify"></section>';
    const operator = { provider: 'Zitadel', url: '/api/operator/login/', logoutUrl: '/api/operator/logout/' };
    const view = new OperatorSettings({ parent, copy, operator }), s = parent.lastElementChild;
    assert.equal(s, view.element); assert.equal(s.querySelector('h3'), null);
    const link = s.querySelector('.operator-login'); assert.equal(link.getAttribute('href'), operator.url);
    assert.equal(link.textContent.trim(), copy.settings.operatorLogin.replace('{provider}', 'Zitadel'));
    assert.ok(link.querySelector('svg')); assert.equal(s.querySelector('.operator-error').textContent, '');
    view.set({ ...operator, error: true }); assert.equal(s.querySelector('.operator-error').textContent, copy.settings.operatorError);
    view.set({ ...operator, name: '<Ada>' });
    assert.equal(s.querySelector('.operator-name').textContent, 'Operator: <Ada>'); assert.equal(s.querySelector('Ada'), null);
    assert.equal(s.querySelector('form').method, 'post'); assert.equal(s.querySelector('form').getAttribute('action'), operator.logoutUrl);
    assert.equal(s.querySelector('.operator-logout').textContent, copy.settings.operatorLogout);
    assert.equal(link.getAttribute('aria-hidden'), 'true');
    view.set({ ...operator, name: 'Ada' });
    assert.equal(s.querySelector('.operator-signed-in').textContent.trim(),
      copy === de ? 'Operator: Ada · Abmelden' : 'Operator: Ada · Sign out');
  } finally { await window.happyDOM.close(); }
});

test('AIT-165 host without operator configuration renders no section or link', async () => {
  const window = new Window();
  try {
    const parent = window.document.createElement('div');
    for (const operator of [undefined, {}, { url: 'https://evil.test', logoutUrl: '/api/operator/logout/' }]) {
      new OperatorSettings({ parent, copy: en, operator }); assert.equal(parent.children.length, 0);
    }
  } finally { await window.happyDOM.close(); }
});
