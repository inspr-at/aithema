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
  const h = fixture(t, copy, { load: async () => ({ contract: 'persistent-v1', mock, intro: 'Host page introduction', withdrawal: 'Host page withdrawal',
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
  assert.equal(h.root.querySelector('.consent-withdrawal').textContent, mock ? copy.host.consentPage.mockTerms : copy.processingConsent.withdrawal);
});

test('AIT-231: invalid described items leave the existing visitor failure state without editable data', async t => {
  const h = fixture(t, en, { document: { contract: 'v1', selected: [], features: { voice: ['speech'] },
    items: [{ id: 'speech', version: 1, title: 'Speech', recipients: 'Processor', text: '' }] } });
  await h.editor.open('voice');
  // AIT-612: a document that cannot be used is a failed LOAD, not a failed save.
  assert.equal(h.root.querySelector('.consent-status').textContent, en.host.consentPage.loadFailed);
  assert.equal(h.root.querySelector('.consent-save').disabled, true);
  assert.equal(h.root.querySelectorAll('input').length, 0);
});
test('AIT-197: missing mapping fails closed and a closed editor ignores a late document', async t => {
  const h = fixture(t); await h.editor.open('analysis');
  assert.equal(h.root.querySelector('.consent-save').disabled, true);
  assert.equal(h.root.querySelector('.consent-status').textContent, en.host.consentPage.loadFailed, 'AIT-612: a missing mapping is a failed load');
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

for (const copy of [de, en]) test(`AIT-321 ${copy.display.locale}: reloads a refused decision once and keeps it unsaved until a visitor acts`, async t => {
  const reload = Promise.withResolvers(), save = Promise.withResolvers(); let loads = 0;
  const doc = { contract: 'v1', consentRevision: 7, selected: ['images'], features: { images: ['images'] },
    items: [{ id: 'images', version: 1, title: 'Images', recipients: 'Processor', text: 'Image purpose' }] };
  const posts = [];
  const h = fixture(t, copy, { load: () => ++loads === 1 ? doc : reload.promise,
    save: body => { posts.push(body); return save.promise; } });
  await h.editor.open('images');
  const button = h.root.querySelector('.consent-save'); button.focus(); button.click();
  save.reject(Object.assign(new Error('Conflict'), { code: 'consent-stale' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.root.getAttribute('aria-busy'), 'true');
  assert.equal(h.root.querySelector('fieldset').inert, true);
  assert.equal(h.root.querySelector('input').checked, true);
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.textContent, copy.featureConsent.save);
  assert.equal(h.window.document.activeElement, button);
  button.click();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].processing.revision, 7);
  reload.resolve({ ...doc, contract: 'v2', consentRevision: 8, selected: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.root.querySelector('input').checked, false);
  assert.equal(h.root.getAttribute('aria-busy'), 'false');
  assert.equal(h.root.querySelector('fieldset').inert, false);
  assert.equal(h.root.querySelector('.consent-status').textContent, copy.host.consentStale);
  assert.equal(h.root.querySelector('.consent-status').getAttribute('aria-live'), 'polite');
  assert.equal(h.window.document.activeElement, button);
  assert.equal(posts.length, 1); assert.equal(loads, 2);
  h.root.querySelector('input').click();
  assert.equal(h.root.querySelector('.consent-status').textContent, '');
  assert.equal(posts.length, 1);
  h.editor.close(); assert.equal(h.editor.stale, false);
});

// AIT-603 PR-B: the sheet opened for the text feature shows the host's text-consent
// sentence in full (the host override, else the stock copy); other features show none.
for (const copy of [de, en]) test(`AIT-603 ${copy.display.locale}: the text feature shows the full host sentence, the stock one without an override, none for other features`, async t => {
  const long = Array(6).fill(copy.featureConsent.text).join(' ');
  const text = { contract: 'v1', features: { text: ['host-model'], voice: ['host-speech'] }, selected: [], items: [
    { id: 'host-speech', title: 'Speech', recipients: 'Voice processor', text: 'Speech purpose', version: 1 },
    { id: 'host-model', title: 'Model', recipients: 'Model processor', text: 'Model purpose', version: 1 },
  ] };
  const reason = h => [...h.root.querySelectorAll('p')].find(p => p.textContent === long || p.textContent === copy.featureConsent.text);
  const host = fixture(t, { ...copy, featureConsent: { ...copy.featureConsent, text: long } }, { document: text, load: async () => text });
  await host.editor.open('text');
  assert.equal(reason(host)?.textContent, long); assert.equal(reason(host).hidden, false);
  await host.editor.open('voice');
  assert.equal([...host.root.querySelectorAll('p')].some(p => !p.hidden && p.textContent === long), false);
  const stock = fixture(t, copy, { document: text, load: async () => { throw new Error('unavailable'); } });
  await stock.editor.open('text');
  assert.equal(stock.root.querySelector('.consent-status').textContent, copy.host.consentPage.loadFailed, 'AIT-612: a failed load says so');
  assert.equal(reason(stock)?.textContent, copy.featureConsent.text); assert.equal(reason(stock).hidden, false);
});

// AIT-612 (TICK AIT-603 r4 L1, AIT-321 design d1cda502): one error, once. A failed load says the consent could
// not be LOADED; a failed save keeps "could not be saved". Standalone, the sheet's own status sits above its Save.
for (const copy of [de, en]) test(`AIT-612 ${copy.display.locale}: a failed load and a failed save each say what failed, once`, async t => {
  assert.equal(typeof copy.host.consentPage.loadFailed, 'string'); assert.notEqual(copy.host.consentPage.loadFailed, copy.host.consentFailed);
  const failedLoad = fixture(t, copy, { load: async () => { throw new Error('unavailable'); } });
  await failedLoad.editor.open('voice');
  assert.equal(failedLoad.root.querySelector('.consent-status').textContent, copy.host.consentPage.loadFailed);
  assert.equal(failedLoad.editor.status, copy.host.consentPage.loadFailed);
  assert.equal(failedLoad.root.textContent.includes(copy.host.consentFailed), false, 'a failed load never says "could not be saved"');
  // The visitor switches language while the failure shows: it follows the page language.
  const other = copy === de ? en : de;
  failedLoad.editor.setCopy(other);
  assert.equal(failedLoad.root.querySelector('.consent-status').textContent, other.host.consentPage.loadFailed);
});

// AIT-612 r2 (gate M1): an existing host copy bundle without host.consentPage.loadFailed still explains a failed
// load: the key resolves through the shipped locale copy (copy-resolve), never to a blank status.
const withoutLoadFailed = copy => { const { loadFailed, ...consentPage } = copy.host.consentPage; return { ...copy, host: { ...copy.host, consentPage } }; };
for (const copy of [de, en]) test(`AIT-612 r2 ${copy.display.locale}: a host copy without loadFailed shows the stock failed-load copy`, async t => {
  const hostCopy = withoutLoadFailed(copy);
  assert.equal(hostCopy.host.consentPage.loadFailed, undefined);
  const h = fixture(t, hostCopy, { load: async () => { throw new Error('unavailable'); } });
  await h.editor.open('voice');
  assert.equal(h.root.querySelector('.consent-status').textContent, copy.host.consentPage.loadFailed);
  assert.equal(h.editor.status, copy.host.consentPage.loadFailed);
  // A language switch to another bundle without the key keeps the failure explained.
  const other = withoutLoadFailed(copy === de ? en : de);
  h.editor.setCopy(other);
  assert.equal(h.root.querySelector('.consent-status').textContent, (copy === de ? en : de).host.consentPage.loadFailed);
});

// AIT-612 r2 (gate Low): a successful stale reload sets the stale notice; a later reload that fails is a failed load,
// and a language switch keeps the failure (it must not bring back the "loaded" stale notice).
for (const copy of [de, en]) test(`AIT-612 r2 ${copy.display.locale}: a failed reload after a stale reload keeps the load error through a language switch`, async t => {
  const doc = { contract: 'v1', features: { voice: ['host-speech'] }, selected: [], items: [{ id: 'host-speech', title: 'Speech', recipients: 'Voice processor', text: 'Speech purpose', version: 1 }] };
  let fail = false;
  const h = fixture(t, copy, { load: async () => { if (fail) throw new Error('unavailable'); return doc; } });
  await h.editor.open('voice');
  await h.editor.open('voice', { reload: true });
  assert.equal(h.editor.stale, true); assert.equal(h.editor.status, copy.host.consentStale);
  fail = true; await h.editor.open('voice', { reload: true });
  assert.equal(h.editor.status, copy.host.consentPage.loadFailed);
  assert.equal(h.editor.stale, false, 'a failed reload is not a stale-but-loaded state');
  const other = copy === de ? en : de;
  h.editor.setCopy(other);
  assert.equal(h.root.querySelector('.consent-status').textContent, other.host.consentPage.loadFailed);
});
