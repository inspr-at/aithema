import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { ConsentSettings } from '../src/consent-settings.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';

function fixture(t, copy = en, overrides = {}) {
  const window = new Window(); globalThis.document = window.document;
  t.after(() => window.happyDOM.close());
  const root = document.createElement('section'); document.body.append(root);
  const doc = { contract: 'v1', features: { voice: ['host-speech', 'host-model'] }, selected: ['host-speech'], items: [
    { id: 'host-speech', title: 'Speech', recipients: 'Voice processor', text: 'Speech purpose', version: 1 },
    { id: 'host-model', title: 'Model', recipients: 'Model processor', text: 'Model purpose', version: 1 },
  ] };
  const saves = [], done = Promise.withResolvers();
  const editor = new ConsentSettings({ root, copy, ports: { load: async () => doc,
    save: async body => saves.push(body), done: () => done.resolve(), ...overrides } });
  return { root, editor, saves, done, window };
}
for (const copy of [de, en]) test(`AIT-197 ${copy.display.locale}: host-mapped consent focuses first missing delegated item and preserves other grants`, async t => {
  const h = fixture(t, copy); await h.editor.open('voice');
  const boxes = [...h.root.querySelectorAll('input')];
  assert.equal(h.window.document.activeElement, boxes[1]); assert.equal(boxes[0].checked, true);
  assert.equal(boxes[1].checked, false); boxes[1].click();
  h.root.querySelector('.consent-save').click(); await h.done.promise;
  assert.deepEqual(h.saves, [{ granted: true, processing: { contract: 'v1', items: ['host-speech', 'host-model'] } }]);
});
test('AIT-197: missing mapping fails closed and a closed editor ignores a late document', async t => {
  const h = fixture(t); await h.editor.open('analysis');
  assert.equal(h.root.querySelector('.consent-save').disabled, true);
  assert.equal(h.root.querySelector('.consent-status').textContent, en.host.consentFailed);
  const loading = Promise.withResolvers(), late = fixture(t, en, { load: () => loading.promise });
  const opening = late.editor.open('voice'); late.editor.close(); loading.resolve({}); await opening;
  assert.equal(late.root.hidden, true); assert.equal(late.root.querySelectorAll('input').length, 0);
});
