import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { runInNewContext } from 'node:vm';
import { mountConsentPage, consentReturnPath } from '../consent-page.js';
import { preferredLocale, preferredTheme, remember, mountTheme, themeKey, localeKey } from '../page-preferences.js';
import { CONSENT_ITEMS, CONSENT_INTRO, CONSENT_WITHDRAWAL } from '../processing-consent.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';

const html = await readFile(new URL('../consent.html', import.meta.url), 'utf8');
const tick = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Consent page did not settle');
};
async function page(t, options = {}) {
  const window = new Window({ url: `http://localhost/consent/?session=s&return=${encodeURIComponent(options.returnTo ?? '/')}` });
  t.after(() => window.happyDOM.close());
  window.document.write(html.replace(/<script[^>]*>[\s\S]*?<\/script>/gu, ''));
  const session = options.session ?? { id: 's', locale: 'de', engine: { visuals: 'off' } };
  const contract = { contract: 'rendered-v1', intro: CONSENT_INTRO, withdrawal: CONSENT_WITHDRAWAL,
    items: options.items ?? CONSENT_ITEMS };
  let selected = options.selected ?? [], currentContract = contract.contract, fail = options.fail;
  const posts = [], returns = [];
  const fetchImpl = async path => {
    if (path === '/demo/config') return Response.json(options.binding ?? { processingConsent: contract, voiceMode: 'off' });
    if (path === '/api/sessions/s') return Response.json(session, { status: options.missing ? 404 : 200 });
    if (path === '/api/sessions/s/consent') {
      if (options.pending) return options.pending.promise;
      return Response.json({ ...contract, contract: currentContract, selected });
    }
    throw new Error(`Unexpected consent request ${path}`);
  };
  const submit = async (path, body) => {
    posts.push(body);
    if (fail) return Response.json({ error: 'failed' }, { status: 500 });
    if (options.stale && posts.length === 1) { currentContract = 'current-v2'; return Response.json({ error: 'host-consent-required' }, { status: 409 }); }
    selected = body.granted ? body.processing?.items ?? ['mock-processing'] : [];
    if (options.unconfirmed) selected = [];
    return Response.json({ granted: body.granted });
  };
  const mounting = mountConsentPage({ document: window.document, location: window.location, storage: window.localStorage,
    fetchImpl, submit, navigate: path => returns.push(path) });
  if (!options.pending) await mounting;
  return { window, document: window.document, posts, returns, mounting, recover: () => { fail = false; } };
}

test('consent return normalizes paths and rejects external or disguised network paths', () => {
  for (const path of ['//evil', 'https://evil/', '/\\evil/', '/\nevil', '/.//evil/', '/a/..//evil/', '/%2e//evil/', '/\0']) assert.equal(consentReturnPath(path, 'http://localhost'), '/');
  for (const path of ['/', '/?x=1#settings', '/local/#settings']) assert.equal(consentReturnPath(path, 'http://localhost'), path);
  assert.equal(consentReturnPath('/?context=✓&existing=%C3%A4#übersicht', 'http://localhost'), '/?context=%E2%9C%93&existing=%C3%A4#%C3%BCbersicht');
});

test('consent renders contract items, uses only matching translations and current server grants', async t => {
  const unknown = { id: 'future', version: 1, title: '<b>Future</b>', recipients: 'Other recipient', text: 'Other purpose and consequence.' };
  const updated = { ...CONSENT_ITEMS[0], version: 2, title: 'New legal title' };
  const p = await page(t, { items: [CONSENT_ITEMS[0], updated, unknown, CONSENT_ITEMS[1]], selected: ['voice-elevenlabs'] });
  const rows = [...p.document.querySelectorAll('.consent-item')];
  assert.deepEqual(rows.map(r => r.querySelector('span').textContent), [de.processingConsent.items[CONSENT_ITEMS[0].id].title, updated.title, unknown.title, de.processingConsent.items[CONSENT_ITEMS[1].id].title]);
  assert.equal(rows[0].querySelector('p').textContent, de.processingConsent.items[CONSENT_ITEMS[0].id].recipients);
  assert.equal(rows[2].querySelectorAll('p')[1].textContent, unknown.text);
  assert.equal(p.document.querySelector('b'), null);
  assert.deepEqual([...p.document.querySelectorAll('input')].map(b => b.checked), [false, false, false, true]);
  assert.equal(p.document.querySelector('.consent-item__mark'), null, 'no invented requirement mapping');
  assert.equal(p.document.querySelector('#consent-text').textContent, de.processingConsent.intro);
  assert.match(p.document.querySelector('#consent-text').textContent, /höchstens zwölf Monate/u);
  assert.equal(p.document.querySelectorAll('[data-grant]').length, 2);
  assert.equal(p.document.querySelectorAll('[data-revoke]').length, 2);
});

test('English consent renders every item and keeps unversioned and duplicate-id legal copy', async t => {
  const unversioned = { id: 'models-international', title: 'Unversioned title', recipients: 'Unversioned recipient', text: '<b>Unversioned purpose</b>' };
  const updated = { ...CONSENT_ITEMS[0], version: 2, title: 'Updated title', recipients: 'Updated recipient', text: 'Updated purpose' };
  const items = [...CONSENT_ITEMS, unversioned, updated];
  const p = await page(t, { session: { id: 's', locale: 'en', engine: {} }, items, selected: ['voice-elevenlabs'] });
  assert.equal(p.document.documentElement.lang, 'en');
  assert.equal(p.document.querySelector('#consent-text').textContent, en.processingConsent.intro);
  assert.match(p.document.querySelector('#consent-text').textContent, /at most twelve months/u);
  assert.equal(p.document.querySelector('#consent-info').textContent, en.processingConsent.withdrawal);
  const rows = [...p.document.querySelectorAll('.consent-item')];
  for (const [index, item] of items.entries()) {
    const expected = index < CONSENT_ITEMS.length ? en.processingConsent.items[item.id] : item;
    assert.equal(rows[index].querySelector('span').textContent, expected.title);
    assert.deepEqual([...rows[index].querySelectorAll('p')].map(p => p.textContent), [expected.recipients, expected.text]);
  }
  assert.deepEqual([...p.document.querySelectorAll('input')].map(b => b.value), items.map(i => i.id));
  assert.deepEqual([...p.document.querySelectorAll('input')].map(b => b.checked), [false, true, false, false]);
  assert.equal(p.document.querySelector('b'), null);
});

test('continuing without a grant returns without recording a withdrawal; revoke requires a current grant', async t => {
  for (const binding of [undefined, { voiceMode: 'fake' }]) {
    const p = await page(t, { binding, returnTo: '/?no-grant=1' });
    for (const revoke of p.document.querySelectorAll('[data-revoke]')) {
      assert.equal(revoke.hidden, true); assert.equal(revoke.disabled, true);
    }
    p.document.querySelector('[data-select-all]').click();
    p.document.querySelectorAll('input').forEach(box => { box.checked = false; });
    p.document.querySelector('input').dispatchEvent(new p.window.Event('change', { bubbles: true }));
    p.document.querySelector('[data-grant]').click(); await tick(() => p.returns.length);
    assert.deepEqual(p.posts, []); assert.deepEqual(p.returns, ['/?no-grant=1']);
  }
  const p = await page(t, { selected: ['voice-elevenlabs'] });
  for (const revoke of p.document.querySelectorAll('[data-revoke]')) {
    assert.equal(revoke.hidden, false); assert.equal(revoke.disabled, false);
  }
});

test('consent select all, selection label, grant and withdrawal use the rendered contract and safe return', async t => {
  const p = await page(t, { returnTo: '/?from=consent#ready' });
  const grant = p.document.querySelector('[data-grant]');
  assert.equal(grant.textContent, de.host.consentPage.none);
  p.document.querySelector('[data-select-all]').click();
  assert.equal(grant.textContent, de.host.consentPage.all);
  grant.click(); await tick(() => p.returns.length === 1);
  assert.deepEqual(p.posts, [{ granted: true, processing: { contract: 'rendered-v1', items: CONSENT_ITEMS.map(i => i.id) } }]);
  assert.deepEqual(p.returns, ['/?from=consent#ready']);
  const revoked = await page(t, { selected: ['voice-elevenlabs'] });
  revoked.document.querySelector('[data-revoke]').click(); await tick(() => revoked.returns.length);
  assert.deepEqual(revoked.posts, [{ granted: false, processing: { contract: 'rendered-v1', items: [] } }]);
  const empty = await page(t, { selected: ['voice-elevenlabs'] });
  empty.document.querySelector('input:checked').checked = false;
  empty.document.querySelector('input').dispatchEvent(new empty.window.Event('change', { bubbles: true }));
  assert.equal(empty.document.querySelector('[data-grant]').textContent, de.host.revoke);
  empty.document.querySelector('[data-grant]').click(); await tick(() => empty.returns.length);
  assert.equal(empty.posts[0].granted, false);
});

test('a failed or unconfirmed grant never returns as saved; failure offers retry', async t => {
  for (const options of [{ fail: true }, { unconfirmed: true }]) {
    const p = await page(t, options);
    p.document.querySelector('[data-select-all]').click(); p.document.querySelector('[data-grant]').click();
    await tick(() => p.document.querySelector('#consent-status').dataset.state === 'failed');
    assert.deepEqual(p.returns, []);
    assert.equal(p.document.querySelector('#status-text').textContent, de.host.consentFailed);
    if (options.fail) {
      p.recover(); p.document.querySelector('#retry').click(); await tick(() => p.returns.length);
      assert.equal(p.posts.length, 2);
    }
  }
});

test('a stale contract stays closed until the current terms are reloaded and reviewed', async t => {
  const p = await page(t, { stale: true, selected: ['voice-elevenlabs'] });
  p.document.querySelector('[data-select-all]').click(); p.document.querySelector('[data-grant]').click();
  await tick(() => p.document.querySelector('#consent-status').dataset.state === 'stale');
  assert.equal(p.posts[0].processing.contract, 'rendered-v1'); assert.deepEqual(p.returns, []);
  assert.equal(p.document.querySelector('[data-grant]').disabled, true);
  assert.equal(p.document.querySelector('[data-revoke]').disabled, false, 'stale terms never prevent withdrawal');
  p.document.querySelector('#retry').click(); await tick(() => p.document.querySelector('#consent-status').dataset.state === 'ready');
  assert.deepEqual([...p.document.querySelectorAll('input:checked')].map(b => b.value), ['voice-elevenlabs'], 'reload reflects the current server grant');
  p.document.querySelector('[data-select-all]').click(); p.document.querySelector('[data-grant]').click(); await tick(() => p.returns.length);
  assert.equal(p.posts[1].processing.contract, 'current-v2');
});

test('missing or unknown conversations offer a way back and cannot grant', async t => {
  const unknown = await page(t, { missing: true });
  assert.equal(unknown.document.querySelector('#consent-status').dataset.state, 'missing');
  assert.equal(unknown.document.querySelector('[data-grant]').disabled, true);
  assert.equal(unknown.document.querySelector('[data-back]').getAttribute('href'), '/');
  const window = new Window({ url: 'http://localhost/consent/' }); t.after(() => window.happyDOM.close());
  window.document.write(html.replace(/<script[^>]*>[\s\S]*?<\/script>/gu, ''));
  await mountConsentPage({ document: window.document, location: window.location, storage: window.localStorage,
    fetchImpl: () => assert.fail('Missing session never opens another conversation') });
  assert.equal(window.document.querySelector('#consent-status').dataset.state, 'missing');
});

test('processing document remains readable when its server verdict cannot be loaded', async t => {
  const pending = Promise.withResolvers(), p = await page(t, { pending });
  await tick(() => p.document.querySelectorAll('.consent-item').length === 2);
  assert.equal(p.document.querySelector('[data-grant]').disabled, true);
  pending.reject(new Error('Read failed')); await p.mounting;
  assert.equal(p.document.querySelector('#consent-status').dataset.state, 'failed');
  assert.equal(p.document.querySelectorAll('input:checked').length, 0);
});

test('mock and uncontracted ElevenLabs use the same page without a voice or microphone client', async t => {
  const mock = await page(t, { binding: { voiceMode: 'fake' } });
  assert.ok(mock.document.querySelector('#processing-items').textContent.includes(de.host.consentUse.off));
  mock.document.querySelector('[data-select-all]').click(); mock.document.querySelector('[data-grant]').click();
  await tick(() => mock.returns.length); assert.deepEqual(mock.posts, [{ granted: true }]);
  const voice = await page(t, { binding: { voiceMode: 'elevenlabs' } });
  assert.equal(voice.document.querySelector('[data-grant]').disabled, true);
  assert.equal(voice.document.querySelector('#consent-text').textContent, de.voiceHostConsent);
  assert.equal(voice.document.querySelector('main').textContent.split(de.voiceHostConsent).length - 1, 1);
  assert.equal(mock.document.querySelector('main').textContent.split(de.host.consentPage.mockRecipients).length - 1, 1);
  assert.equal(mock.document.querySelector('#consent-info').textContent, de.host.consentPage.mockTerms);
  assert.equal(mock.document.querySelector('#source').textContent, de.host.slots.source);
  assert.equal(voice.document.querySelector('[data-revoke]').hidden, true);
  const voiceGrant = await page(t, { binding: { voiceMode: 'elevenlabs' }, session: { id: 's', locale: 'de', consentRevision: 1, consentWithdrawn: false } });
  assert.equal(voiceGrant.document.querySelector('[data-revoke]').hidden, false);
  const source = await readFile(new URL('../consent-page.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /getUserMedia|createVoiceControl|createElevenLabsClient|session-element/u);
  for (const p of [mock, voice]) assert.equal(p.document.querySelector('#source').getAttribute('href'), 'https://github.com/inspr-at/aithema');
});

test('blocked localStorage property reads preserve defaults, prepaint, theme controls and consent return', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Sandboxed document', 'SecurityError'); } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage; });
  assert.equal(preferredLocale(), 'de'); assert.equal(preferredTheme(), 'system');
  assert.doesNotThrow(() => remember(localeKey, 'en'));
  const window = new Window({ url: 'http://localhost/consent/' }); t.after(() => window.happyDOM.close());
  window.document.write(html.replace(/<script[^>]*>[\s\S]*?<\/script>/gu, ''));
  const init = await readFile(new URL('../theme-init.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => runInNewContext(init, { document: window.document, get localStorage() { throw new DOMException('Sandboxed document', 'SecurityError'); } }));
  const returns = [];
  await mountConsentPage({ document: window.document, location: window.location, navigate: path => returns.push(path) });
  const theme = window.document.querySelector('#theme'); theme.value = 'dark'; theme.dispatchEvent(new window.Event('change'));
  assert.equal(window.document.documentElement.dataset.theme, 'dark');
  window.document.querySelector('#new').click(); assert.deepEqual(returns, ['/']);
});

test('German defaults independently of browser language, explicit choice wins and themes persist safely', async t => {
  const window = new Window(); t.after(() => window.happyDOM.close());
  assert.equal(preferredLocale(window.localStorage), 'de');
  window.localStorage.setItem(localeKey, 'en'); assert.equal(preferredLocale(window.localStorage), 'en');
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(preferredLocale(blocked), 'de');
  window.document.write('<select id="theme"><option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option></select><aithema-session></aithema-session>');
  mountTheme(window.document, window.localStorage);
  const theme = window.document.querySelector('#theme'); theme.value = 'dark'; theme.dispatchEvent(new window.Event('change'));
  assert.equal(window.localStorage.getItem(themeKey), 'dark'); assert.equal(window.document.documentElement.dataset.theme, 'dark');
  assert.equal(window.document.querySelector('aithema-session').getAttribute('theme'), 'dark');
  mountTheme(window.document, window.localStorage); assert.equal(theme.value, 'dark');
  theme.value = 'system'; theme.dispatchEvent(new window.Event('change'));
  assert.equal(window.document.documentElement.hasAttribute('data-theme'), false);
  mountTheme(window.document, blocked); assert.equal(theme.value, 'system');
  const p = await page(t, { session: { id: 's', locale: 'en', engine: {} } });
  p.window.localStorage.setItem(localeKey, 'de'); p.document.querySelector('#locale').value = 'de';
  p.document.querySelector('#locale').dispatchEvent(new p.window.Event('change'));
  assert.equal(p.document.documentElement.lang, 'en', 'running conversation language does not change');
  assert.equal(p.document.querySelector('#language-note').textContent, en.host.languageNext.replace('{language}', en.host.languages.de));
});
