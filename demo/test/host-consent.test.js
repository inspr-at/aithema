import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { CONSENT_ITEMS, CONSENT_INTRO, CONSENT_WITHDRAWAL } from '../processing-consent.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';

test('processing consent stays readable before and after opening the conversation', { timeout: 15_000 }, async t => {
  const window = new Window({ url: 'http://localhost' });
  const keys = ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'localStorage', 'fetch'];
  const originals = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  try {
    for (const key of keys.filter(key => key !== 'fetch')) globalThis[key] = window[key];
    await import('../../packages/ui/src/session-element.js');
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const body = html.match(/<body>([\s\S]*?)<\/body>/u)[1].replace(/<script[^>]*>[\s\S]*?<\/script>/gu, '');
    const session = { id: 'consent-test', locale: 'de', processingPreset: 'best', featureMatrix: {} };
    function prepare(items, openRequest = () => Response.json(session), consentRequest = () => Response.json({ selected: [] })) {
      document.body.innerHTML = body;
      localStorage.clear(); localStorage.setItem('aithema-demo-locale', 'de');
      const component = document.querySelector('aithema-session');
      let configuredSession;
      component.configure = ({ session }) => { configuredSession = session; };
      Object.defineProperty(component, 'session', { get: () => configuredSession });
      globalThis.fetch = async url => {
        if (url === '/demo/config') return Response.json({ label: 'Mock reasoning — deterministic demo', imageLabel: 'Images off', voiceMode: 'off',
          processingConsent: { contract: 'test', intro: CONSENT_INTRO, withdrawal: CONSENT_WITHDRAWAL, items } });
        if (url === '/api/sessions') return openRequest();
        if (url === '/api/sessions/consent-test/consent') return consentRequest();
        assert.fail(`Unexpected host request: ${url}`);
      };
    }
    function assertItems(expected) {
      const inputs = [...document.querySelectorAll('#processing-items input')];
      assert.equal(inputs.length, expected.length);
      for (const [index, item] of expected.entries()) {
        assert.equal(inputs[index].parentElement.querySelector('span').textContent, item.title);
        assert.equal(inputs[index].parentElement.nextElementSibling.textContent, `${item.recipients} ${item.text}`);
      }
    }
    for (const stage of ['session', 'consent']) {
      await t.test(`English items remain visible while the ${stage} request is pending and after open() fails`, async () => {
        const pending = Promise.withResolvers(), requested = Promise.withResolvers();
        const delayed = () => { requested.resolve(); return pending.promise; };
        prepare(CONSENT_ITEMS, stage === 'session' ? delayed : undefined, stage === 'consent' ? delayed : undefined);
        const loaded = import(`../host.js?consent-failure=${stage}`);
        await requested.promise;
        const pendingText = [...document.querySelectorAll('#processing-items input')].map(input => [
          input.parentElement.querySelector('span').textContent, input.parentElement.nextElementSibling.textContent]);
        pending.reject(new TypeError('Simulated request failure')); await loaded;
        assert.equal(document.querySelector('#error').textContent, (stage === 'session' ? en : de).host.restoreFailed);
        assertItems(CONSENT_ITEMS);
        assert.deepEqual(pendingText, CONSENT_ITEMS.map(item => [item.title, `${item.recipients} ${item.text}`]));
      });
    }
    await t.test('German painting fills each row when item ids are duplicated', async () => {
      const items = [CONSENT_ITEMS[0], CONSENT_ITEMS[0], CONSENT_ITEMS[1]];
      prepare(items);
      await import('../host.js?consent-duplicate-ids');
      assert.equal(document.querySelector('#error').textContent, '');
      assertItems(items.map(item => de.processingConsent.items[item.id]));
    });
    await t.test('unknown ids and unmatched or absent versions keep their server text', async () => {
      const items = [CONSENT_ITEMS[1],
        { ...CONSENT_ITEMS[0], version: 2, title: 'Updated models', recipients: 'Updated recipients.', text: 'Updated purpose.' },
        { id: 'future-item', version: 1, title: 'Future item', recipients: 'Future recipient.', text: 'Future purpose.' },
        { ...CONSENT_ITEMS[1], version: undefined, title: 'Unversioned voice' }];
      prepare(items);
      await import('../host.js?consent-fallbacks');
      assert.equal(document.querySelector('#error').textContent, '');
      assertItems([de.processingConsent.items[items[0].id], ...items.slice(1)]);
    });
  } finally {
    window.document.querySelector('aithema-session')?.remove();
    await window.happyDOM.close();
    for (const key of keys) { if (originals[key] === undefined) delete globalThis[key]; else globalThis[key] = originals[key]; }
  }
});
