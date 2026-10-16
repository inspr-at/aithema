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
  const doc = overrides.document ?? { contract: 'v1', features: { voice: ['host-speech', 'host-model'] }, selected: ['host-speech'], items: [
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

for (const copy of [de, en]) for (const mock of [false, true]) test(`AIT-231 ${copy.display.locale}: ${mock ? 'mock' : 'real'} documents retain every described item`, async t => {
  const h = fixture(t, copy, { load: async () => ({ contract: 'persistent-v1', mock,
    selected: ['host-speech'], features: { voice: ['host-speech', 'host-model'] }, items: [
      { id: 'host-speech', version: 'speech-v2', title: 'Host speech', recipients: 'Speech recipient', text: 'Speech purpose' },
      { id: 'host-model', version: 1, title: 'Host model', recipients: 'Model recipient', text: 'Model purpose' },
    ] }) });
  await h.editor.open('voice');
  assert.deepEqual([...h.root.querySelectorAll('input')].map(box => [box.value, box.checked]), [['host-speech', true], ['host-model', false]]);
  assert.ok(h.root.textContent.includes('Speech recipient'));
  assert.ok(h.root.textContent.includes('Model purpose'));
  assert.equal(h.root.querySelector('.consent-save').disabled, false);
  assert.equal(h.root.querySelector('.consent-intro').textContent, mock
    ? `${copy.host.consentPage.mockNotice} ${copy.host.consentPage.intro}` : copy.processingConsent.intro);
});

test('AIT-231: invalid described items leave the existing visitor failure state without editable data', async t => {
  const h = fixture(t, en, { document: { contract: 'v1', selected: [], features: { voice: ['speech'] },
    items: [{ id: 'speech', version: 1, title: 'Speech', recipients: 'Processor', text: '' }] } });
  await h.editor.open('voice');
  assert.equal(h.root.querySelector('.consent-status').textContent, en.host.consentFailed);
  assert.equal(h.root.querySelector('.consent-save').disabled, true);
  assert.equal(h.root.querySelectorAll('input').length, 0);
});
test('AIT-197: missing mapping fails closed and a closed editor ignores a late document', async t => {
  const h = fixture(t); await h.editor.open('analysis');
  assert.equal(h.root.querySelector('.consent-save').disabled, true);
  assert.equal(h.root.querySelector('.consent-status').textContent, en.host.consentFailed);
  const loading = Promise.withResolvers(), late = fixture(t, en, { load: () => loading.promise });
  const opening = late.editor.open('voice'); late.editor.close(); loading.resolve({}); await opening;
  assert.equal(late.root.hidden, true); assert.equal(late.root.querySelectorAll('input').length, 0);
});

test('AIT-197 R2 High: an empty first save closes without sending a withdrawal', async t => {
  const h = fixture(t, en, { document: { contract: 'v1', selected: [], features: { voice: ['speech'] },
    items: [{ id: 'speech', version: 1, title: 'Speech', recipients: 'Processor', text: 'Speech purpose' }] } });
  await h.editor.open('voice'); h.root.querySelector('.consent-save').click(); await h.done.promise;
  assert.deepEqual(h.saves, [], 'no prior grant and no choice sends nothing');
});
for (const copy of [de, en]) for (const removal of ['model', 'voice', 'drafts', 'all']) test(`AIT-197 R2 High ${copy.display.locale}: removing ${removal} uses the server ending predicate`, async t => {
  const doc = { contract: 'v1', selected: ['model', 'voice', 'drafts'], features: { text: ['model'], analysis: ['model'], voice: ['voice', 'model'], html: ['drafts'] },
    items: ['model', 'voice', 'drafts'].map(id => ({ id, title: id, version: 1, recipients: 'Processor', text: 'Purpose' })) };
  const h = fixture(t, copy, { document: doc }); await h.editor.open('voice');
  for (const box of h.root.querySelectorAll('input')) if (removal === 'all' || box.value === removal) box.click();
  const ending = ['model', 'all'].includes(removal);
  assert.equal(h.root.querySelector('.consent-save').textContent, ending
    ? copy.display.locale === 'de' ? 'Widerrufen und Gespräch beenden' : 'Withdraw and end conversation'
    : copy.featureConsent.save);
  h.root.querySelector('.consent-save').click(); await h.done.promise;
  assert.equal(h.saves[0].granted, !ending, 'only conversation withdrawal ends the conversation');
});
