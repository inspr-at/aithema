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
    const operator = { provider: 'Zitadel', url: '/api/operator/login/', logoutUrl: '/api/operator/logout/', adminUrl: '/admin' };
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
      copy === de ? 'Operator: Ada · Verwaltung · Abmelden' : 'Operator: Ada · Admin · Sign out');
  } finally { await window.happyDOM.close(); }
});

for (const copy of [de, en]) {
  const operator = { provider: 'Zitadel', url: '/api/operator/login/', logoutUrl: '/api/operator/logout/', name: 'Ada' };
  for (const adminUrl of [undefined, '', null, 123, 'javascript:alert(1)', 'data:text/html,admin', 'mailto:admin@example.test',
    '//other.test/admin', '/\\other.test/admin', '\\other.test/admin', 'https://', 'https://[invalid', 'java\nscript:alert(1)', ' /admin']) {
    test(`AIT-223 no admin anchor or separator for ${JSON.stringify(adminUrl)} (${copy.display.locale})`, async () => {
      const window = new Window();
      try {
        const parent = window.document.createElement('div');
        new OperatorSettings({ parent, copy, operator: { ...operator, adminUrl } });
        assert.equal(parent.querySelectorAll('.operator-admin').length, 0);
        assert.equal(parent.querySelectorAll('.operator-separator').length, 0);
        assert.equal(parent.querySelector('.operator-name').textContent, 'Operator: Ada');
        assert.ok(!parent.querySelector('.operator-signed-in').textContent.includes(' · '));
        assert.equal(parent.querySelector('.operator-logout').textContent, copy.settings.operatorLogout);
      } finally { await window.happyDOM.close(); }
    });
  }
  for (const adminUrl of ['/admin', '/operator/admin?tab=users#active', './admin', '../admin', 'admin',
    'https://console.example.test/admin', 'http://localhost:3000/admin']) {
    test(`AIT-223 host admin href ${adminUrl} is final before attachment (${copy.display.locale})`, async () => {
      const window = new Window();
      try {
        const parent = window.document.createElement('div'), append = parent.append.bind(parent);
        parent.append = section => {
          assert.equal(section.querySelector('.operator-name').textContent, 'Operator: Ada');
          assert.equal(section.querySelector('.operator-admin').getAttribute('href'), adminUrl);
          assert.equal(section.querySelectorAll('.operator-separator').length, 2);
          append(section);
        };
        const view = new OperatorSettings({ parent, copy, operator: { ...operator, adminUrl } });
        assert.equal(parent.querySelector('.operator-admin').textContent, copy.settings.operatorAdmin);
        view.set({ ...operator, adminUrl: 'javascript:alert(1)' });
        assert.equal(parent.querySelectorAll('.operator-admin').length, 0);
        assert.equal(parent.querySelectorAll('.operator-separator').length, 0);
        view.set({ ...operator, adminUrl }); view.setCopy(copy === de ? en : de);
        assert.equal(parent.querySelector('.operator-admin').getAttribute('href'), adminUrl);
        assert.equal(parent.querySelectorAll('.operator-separator').length, 2);
        assert.equal(parent.querySelector('.operator-admin').textContent, (copy === de ? en : de).settings.operatorAdmin);
      } finally { await window.happyDOM.close(); }
    });
  }
}

test('AIT-165 host without operator configuration renders no section or link', async () => {
  const window = new Window();
  try {
    const parent = window.document.createElement('div');
    for (const operator of [undefined, {}, { url: 'https://evil.test', logoutUrl: '/api/operator/logout/' }]) {
      new OperatorSettings({ parent, copy: en, operator }); assert.equal(parent.children.length, 0);
    }
  } finally { await window.happyDOM.close(); }
});
