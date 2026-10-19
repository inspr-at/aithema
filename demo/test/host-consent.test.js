import { test } from 'node:test';
import { SQLiteStorage, createHandlers } from '../../packages/server/src/index.js';
import { ownedRequest, testToken } from '../../test/helpers.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { runInNewContext } from 'node:vm';
import { mountConsentPage, consentReturnPath, translatedItem } from '../consent-page.js';
import { preferredLocale, preferredTheme, remember, mountTheme, themeKey, localeKey } from '../page-preferences.js';
import { CONSENT_ITEMS, CONSENT_INTRO, CONSENT_WITHDRAWAL } from '../processing-consent.js';
import { manifest as voiceManifest } from '../../plugins/elevenlabs/src/manifest.js';
import { en as defaultEn } from '../../packages/ui/src/i18n/en.js';
import { de as defaultDe } from '../../packages/ui/src/i18n/de.js';
import { withDemoConsentCopy } from '../consent-copy.js';
const en = withDemoConsentCopy(defaultEn), de = withDemoConsentCopy(defaultDe);

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
    items: options.items ?? CONSENT_ITEMS, ...(options.optional ? { optional: options.optional } : {}) };
  let selected = options.selected ?? [], currentContract = contract.contract, fail = options.fail;
  const posts = [], returns = [];
  const fetchImpl = async path => {
    if (path === '/demo/config') return Response.json(options.binding ?? { processingConsent: contract, voiceMode: 'off', voicePresentation: voiceManifest.presentation });
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
test('host voice consent translations are rendered verbatim only for the matching item and version', () => {
  const item = { id: 'host-voice', version: 1, title: 'Server title', recipients: 'Server recipient', text: 'Server text' };
  const supplied = { label: 'Host', translations: [{ locale: 'de', label: 'Host', consentItem: { ...item,
    title: '<b>Host title</b>', recipients: 'Host recipient', text: 'Host text' } }] };
  assert.deepEqual(translatedItem(item, de, supplied), supplied.translations[0].consentItem);
  assert.equal(translatedItem({ ...item, version: 2 }, de, supplied).title, item.title);
  assert.equal(translatedItem(item, en, supplied).title, item.title);
  assert.equal(translatedItem({ ...item, id: 'another-item' }, de, supplied).title, item.title);
});

for (const locale of ['de', 'en']) test(`draft consent uses matching ${locale} copy and the server optional marking`, async t => {
  const copy = { de, en }[locale];
  const p = await page(t, { session: { id: 's', locale, engine: {} }, optional: ['drafts-anthropic'] });
  const row = p.document.querySelector('input[value="drafts-anthropic"]').closest('.consent-item');
  assert.equal(row.querySelector('label span').textContent, copy.processingConsent.items['drafts-anthropic'].title);
  assert.equal(row.querySelector('.consent-item__mark').textContent, copy.host.consentPage.optional);
  const changed = { ...CONSENT_ITEMS.find(item => item.id === 'drafts-anthropic'), version: 2, text: 'New server draft terms.' };
  const q = await page(t, { session: { id: 's', locale, engine: {} }, items: [changed] });
  assert.equal(q.document.querySelectorAll('.consent-item p')[1].textContent, changed.text);
});

test('consent renders contract items, uses only matching translations and current server grants', async t => {
  const unknown = { id: 'future', version: 1, title: '<b>Future</b>', recipients: 'Other recipient', text: 'Other purpose and consequence.' };
  const updated = { ...CONSENT_ITEMS[0], version: 2, title: 'New legal title' };
  const p = await page(t, { items: [CONSENT_ITEMS[0], updated, unknown, CONSENT_ITEMS[1]], selected: ['voice-elevenlabs'] });
  const rows = [...p.document.querySelectorAll('.consent-item')];
  assert.deepEqual(rows.map(r => r.querySelector('span').textContent), [de.processingConsent.items[CONSENT_ITEMS[0].id].title, updated.title, unknown.title, voiceManifest.presentation.translations.find(entry => entry.locale === 'de').consentItem.title]);
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
    const expected = index < CONSENT_ITEMS.length ? en.processingConsent.items[item.id] ?? voiceManifest.presentation.translations.find(entry => entry.locale === 'en').consentItem : item;
    assert.equal(rows[index].querySelector('span').textContent, expected.title);
    assert.deepEqual([...rows[index].querySelectorAll('p')].map(p => p.textContent), [expected.recipients, expected.text]);
  }
  assert.deepEqual([...p.document.querySelectorAll('input')].map(b => b.value), items.map(i => i.id));
  assert.deepEqual([...p.document.querySelectorAll('input')].map(b => b.checked), [false, true, false, false, false]);
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
  await tick(() => p.document.querySelectorAll('.consent-item').length === CONSENT_ITEMS.length);
  assert.equal(p.document.querySelector('[data-grant]').disabled, true);
  pending.reject(new Error('Read failed')); await p.mounting;
  assert.equal(p.document.querySelector('#consent-status').dataset.state, 'failed');
  assert.equal(p.document.querySelectorAll('input:checked').length, 0);
  // An unreadable verdict never hides withdrawal of a grant the session records.
  const granted = Promise.withResolvers(), q = await page(t, { pending: granted, session: { id: 's', locale: 'de', engine: { visuals: 'off' }, consentRevision: 2, consentWithdrawn: false } });
  granted.reject(new Error('Read failed')); await q.mounting;
  assert.equal(q.document.querySelector('[data-revoke]').hidden, false);
  assert.equal(q.document.querySelector('[data-revoke]').disabled, false);
});

test('the status line grows with its retry action instead of clipping it', async () => {
  const css = await readFile(new URL('../host.css', import.meta.url), 'utf8'), rule = css.match(/\.consent-status \{([^}]*)\}/u)[1];
  assert.match(rule, /min-height:3em/u);
  assert.doesNotMatch(rule, /(?:^|[;\s])(?:height|overflow):/u);
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
  assert.notEqual(voiceGrant.document.querySelector('[data-grant]').textContent, de.host.revoke, 'one withdrawal label only');
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
  assert.doesNotThrow(() => runInNewContext(init, {
    document: window.document, customElements: window.customElements,
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    get localStorage() { throw new DOMException('Sandboxed document', 'SecurityError'); },
  }));
  const failedHost = window.document.createElement('script');
  failedHost.setAttribute('src', '/demo/host.js'); window.document.body.append(failedHost);
  failedHost.dispatchEvent(new window.Event('error'));
  assert.equal(window.document.documentElement.dataset.hostUnavailable, '', 'resource error restores native utility fallback without a window global');
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
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.document.documentElement.lang, 'en', 'running conversation language does not change');
  assert.equal(p.document.querySelector('#locale').selectedOptions[0].textContent, 'EN');
  assert.equal(p.document.querySelector('#locale').value, 'en');
  assert.equal(p.document.querySelector('#language-note').textContent, en.host.languageNext.replace('{language}', en.host.languages.de));
});

// AIT-376: these fixtures deliberately ignore abort and never settle until the
// test delivers a late answer. Advancing this clock never waits on wall time.
async function deadlinePage(t, { stallGet = false, selected = ['voice-elevenlabs'], locale = 'de', bindingOverride } = {}) {
  const window = new Window({ url: 'http://localhost/consent/?session=s&return=%2F%3Fsaved%3D1' });
  t.after(() => window.happyDOM.close());
  window.document.write(html.replace(/<script[^>]*>[\s\S]*?<\/script>/gu, ''));
  window.localStorage.setItem(localeKey, locale);
  let now = 0, sequence = 0;
  const timers = new Map(), posts = [], gets = [], returns = [];
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const clock = {
    setTimeout(fn, delay) { const key = ++sequence; timers.set(key, { fn, at: now + delay }); return key; },
    clearTimeout(key) { timers.delete(key); },
    async advance(ms) { now += ms; for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.fn(); } await flush(); },
  };
  const contract = { contract: 'rendered-v1', items: CONSENT_ITEMS, intro: CONSENT_INTRO, withdrawal: CONSENT_WITHDRAWAL };
  const fixture = { stallGet, selected, posts, gets, returns, clock, flush, window, document: window.document, timers };
  const fetchImpl = async (path, options = {}) => {
    gets.push({ path, signal: options.signal });
    const override = fixture.readOverride?.(path, options);
    if (override) return override;
    if (path === '/demo/config') return Response.json(bindingOverride ?? { processingConsent: contract, voiceMode: 'off' });
    if (path === '/api/sessions/s') return Response.json({ id: 's', locale, engine: {}, consentRevision: 1, consentWithdrawn: false });
    if (path.endsWith('/consent')) {
      if (fixture.stallGet) { const answer = Promise.withResolvers(); fixture.lateGet = answer; return answer.promise; }
      return Response.json({ ...contract, selected: fixture.selected });
    }
    assert.fail(`Unexpected request ${path}`);
  };
  fixture.mounting = mountConsentPage({ document: window.document, location: window.location, storage: window.localStorage,
    clock, fetchImpl, navigate: path => returns.push(path), submit: (path, body, options = {}) => {
      const answer = Promise.withResolvers(); posts.push({ path, body, signal: options.signal, ...answer }); return answer.promise;
    } });
  await flush();
  if (!stallGet) fixture.api = await fixture.mounting;
  fixture.state = () => window.document.querySelector('#consent-status').dataset.state;
  fixture.message = () => window.document.querySelector('#status-text').textContent;
  fixture.retry = () => window.document.querySelector('#retry');
  fixture.choose = () => window.document.querySelector('[data-select-all]').click();
  return fixture;
}

for (const locale of ['de', 'en']) {
  const c = { de, en }[locale].host.consentPage;
  test(`AIT-376 C1/C3/C6: whole GET load has an 8s deadline, fresh Retry and late-answer fence (${locale})`, async t => {
    const p = await deadlinePage(t, { stallGet: true, locale });
    await p.clock.advance(7999); assert.equal(p.state(), 'loading');
    await p.clock.advance(1);
    assert.equal(p.state(), 'load-timeout');
    assert.equal(p.message(), c.loadTimeout);
    assert.equal(p.retry().disabled, false); assert.equal(p.document.activeElement, p.retry());
    assert.equal(p.document.querySelectorAll('input:checked').length, 0);
    assert.equal(p.document.querySelector('#processing-items').disabled, true);
    assert.equal(p.document.querySelector('[data-revoke]').disabled, true);
    assert.equal(p.gets.at(-1).signal.aborted, true);
    const late = p.lateGet;
    p.retry().click(); await p.flush();
    await p.clock.advance(7999); assert.equal(p.state(), 'loading');
    await p.clock.advance(1); assert.equal(p.state(), 'load-timeout');
    late.resolve(Response.json({ selected: ['voice-elevenlabs'] })); await p.flush();
    assert.equal(p.state(), 'load-timeout'); assert.equal(p.message(), c.loadTimeout);
    assert.equal(p.document.querySelectorAll('input:checked').length, 0);
    assert.equal(p.document.querySelector('#consent-status').getAttribute('aria-live'), 'polite');
    assert.equal(p.document.querySelector('#consent-status').getAttribute('role'), 'status');
  });

  for (const matches of [true, false]) test(`AIT-376 C2/C4/C6: 10s POST deadline re-reads rather than repeats; matches=${matches} (${locale})`, async t => {
    const p = await deadlinePage(t, { locale });
    p.choose(); void p.api.save(); await p.flush();
    await p.clock.advance(9999); assert.equal(p.state(), 'saving');
    await p.clock.advance(1); assert.equal(p.state(), 'save-unconfirmed');
    assert.equal(p.message(), c.saveUnconfirmed); assert.equal(p.retry().textContent, c.loadCurrent);
    assert.equal(p.document.activeElement, p.retry()); assert.equal(p.posts[0].signal.aborted, true);
    assert.equal(p.document.querySelector('[data-grant]').disabled, true);
    p.posts[0].resolve(Response.json({ granted: true })); await p.flush();
    assert.equal(p.state(), 'save-unconfirmed'); assert.equal(p.message(), c.saveUnconfirmed); assert.deepEqual(p.returns, []);
    p.selected = matches ? CONSENT_ITEMS.map(item => item.id) : ['voice-elevenlabs'];
    p.retry().click(); await p.flush();
    assert.equal(p.posts.length, 1, 'unknown save is never blindly repeated');
    if (matches) assert.deepEqual(p.returns, ['/?saved=1']);
    else {
      assert.deepEqual(p.returns, []); assert.equal(p.state(), 'ready'); assert.equal(p.message(), c.notSavedYet);
      assert.equal(p.document.querySelector('[data-grant]').disabled, false);
      assert.equal(p.document.querySelector('#processing-items').disabled, false);
      assert.deepEqual([...p.document.querySelectorAll('input:checked')].map(box => box.value), ['voice-elevenlabs']);
    }
    assert.equal(p.timers.size, 0);
  });

  test(`AIT-376 C5: withdrawal aborts saving immediately, times out and retries idempotently (${locale})`, async t => {
    const p = await deadlinePage(t, { locale });
    p.choose(); void p.api.save(); await p.flush();
    const revoke = p.document.querySelector('[data-revoke]');
    assert.equal(revoke.disabled, false); revoke.click(); await p.flush();
    assert.equal(p.posts[0].signal.aborted, true);
    assert.equal(p.posts.length, 2); assert.equal(p.posts[1].body.granted, false);
    assert.deepEqual(p.posts[1].body.processing.items, []);
    p.posts[0].resolve(Response.json({ granted: true })); await p.flush(); assert.deepEqual(p.returns, []);
    await p.clock.advance(10000);
    assert.equal(p.state(), 'withdraw-unconfirmed'); assert.equal(p.message(), c.withdrawUnconfirmed);
    assert.equal(p.document.activeElement, p.retry()); assert.equal(p.retry().textContent, c.retry);
    assert.equal(p.posts[1].signal.aborted, true);
    p.retry().click(); await p.flush(); assert.equal(p.posts.length, 3);
    assert.deepEqual(p.posts[2].body, p.posts[1].body);
    p.selected = []; p.posts[2].resolve(Response.json({ granted: false })); await p.flush();
    assert.deepEqual(p.returns, ['/?saved=1']); assert.equal(p.timers.size, 0);
  });
}


test('AIT-376: config, session and verdict share one load deadline, including response bodies', async t => {
  const p = await deadlinePage(t);
  const config = Promise.withResolvers(), session = Promise.withResolvers();
  p.readOverride = path => path === '/demo/config' ? config.promise : path === '/api/sessions/s' ? session.promise : null;
  const loading = p.api.load(); await p.flush();
  await p.clock.advance(7000); assert.equal(p.state(), 'loading');
  config.resolve(Response.json({ processingConsent: { contract: 'v1', items: CONSENT_ITEMS } })); await p.flush();
  await p.clock.advance(999); assert.equal(p.state(), 'loading');
  await p.clock.advance(1); await loading;
  assert.equal(p.state(), 'load-timeout');
  assert.equal(p.gets.at(-1).signal.aborted, true);
  session.resolve(Response.json({ id: 's', locale: 'en' })); await p.flush();
  assert.equal(p.state(), 'load-timeout'); assert.equal(p.document.documentElement.lang, 'de');
  const body = Promise.withResolvers();
  p.readOverride = path => path === '/demo/config' ? { ok: true, json: () => body.promise } : null;
  const retrying = p.api.load(); await p.flush(); await p.clock.advance(8000); await retrying;
  assert.equal(p.state(), 'load-timeout');
  body.resolve({ voiceMode: 'fake' }); await p.flush(); assert.equal(p.state(), 'load-timeout');
});

for (const phase of ['body', 'confirmation']) test(`AIT-376: save deadline includes ${phase} and fences its late result`, async t => {
  const p = await deadlinePage(t), body = Promise.withResolvers();
  p.choose(); const saving = p.api.save(); await p.flush();
  if (phase === 'body') p.posts[0].resolve({ ok: true, json: () => body.promise });
  else { p.stallGet = true; p.posts[0].resolve(Response.json({ granted: true })); }
  await p.flush(); await p.clock.advance(10000); await saving;
  assert.equal(p.state(), 'save-unconfirmed');
  if (phase === 'body') body.resolve({ granted: true });
  else p.lateGet.resolve(Response.json({ selected: CONSENT_ITEMS.map(item => item.id), contract: 'rendered-v1' }));
  await p.flush(); assert.equal(p.state(), 'save-unconfirmed'); assert.deepEqual(p.returns, []);
});

test('AIT-376: withdrawal can cancel a first grant with no previously recorded selection', async t => {
  const p = await deadlinePage(t, { selected: [] });
  assert.equal(p.document.querySelector('[data-revoke]').hidden, true);
  p.choose(); void p.api.save(); await p.flush();
  const revoke = p.document.querySelector('[data-revoke]');
  assert.equal(revoke.hidden, false); assert.equal(revoke.disabled, false); revoke.click(); await p.flush();
  assert.equal(p.posts.length, 2); assert.equal(p.posts[0].signal.aborted, true); assert.equal(p.posts[1].body.granted, false);
  assert.equal(revoke.hidden, false); assert.equal(revoke.disabled, false, 'withdrawal remains available during its own pending request');
  await p.clock.advance(10000); assert.equal(p.state(), 'withdraw-unconfirmed');
  assert.equal(revoke.hidden, false); assert.equal(revoke.disabled, false);
});

test('AIT-376: postJson passes the AbortSignal to the POST transport', async t => {
  const { postJson } = await import('../post-json.js');
  const original = globalThis.fetch, controller = new AbortController(); let sent;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (url, options) => { sent = { url, ...options }; return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); };
  const request = postJson('/api/sessions/s/consent', { granted: false }, { signal: controller.signal });
  assert.equal(sent.method, 'POST'); assert.equal(sent.body, '{"granted":false}'); assert.equal(sent.signal, controller.signal);
  controller.abort(); await assert.rejects(request, { name: 'AbortError' });
});


test('AIT-376: a stalled reconciliation gets 8s and Retry retains the intended choice', async t => {
  const p = await deadlinePage(t); p.choose(); void p.api.save(); await p.flush();
  await p.clock.advance(10000); assert.equal(p.state(), 'save-unconfirmed');
  p.stallGet = true; p.retry().click(); await p.flush();
  await p.clock.advance(8000); assert.equal(p.state(), 'load-timeout');
  assert.equal(p.document.querySelectorAll('input:checked').length, 0);
  p.stallGet = false; p.selected = CONSENT_ITEMS.map(item => item.id);
  p.retry().click(); await p.flush();
  assert.deepEqual(p.returns, ['/?saved=1']); assert.equal(p.posts.length, 1);
});

test('AIT-376: withdrawal starts its own fresh deadline even 9s into saving', async t => {
  const p = await deadlinePage(t); p.choose(); void p.api.save(); await p.flush();
  await p.clock.advance(9000); p.document.querySelector('[data-revoke]').click(); await p.flush();
  assert.equal(p.posts[0].signal.aborted, true); assert.equal(p.posts.length, 2);
  await p.clock.advance(9999); assert.equal(p.state(), 'saving');
  await p.clock.advance(1); assert.equal(p.state(), 'withdraw-unconfirmed'); assert.equal(p.posts[1].signal.aborted, true);
});


for (const locale of ['de', 'en']) {
  test(`AIT-376 round 2: revision conflict re-reads current choices without repeating a save (${locale})`, async t => {
    const p = await deadlinePage(t, { locale });
    p.readOverride = path => path.endsWith('/consent') ? Response.json({ contract: 'rendered-v1', items: CONSENT_ITEMS, selected: ['voice-elevenlabs'], consentRevision: 7 }) : null;
    await p.api.load(); p.choose(); void p.api.save(); await p.flush();
    assert.equal(p.posts[0].body.processing.revision, 7, 'save uses the consent document revision, not the earlier session snapshot');
    p.posts[0].resolve(Response.json({ error: 'consent-stale', consentRevision: 8 }, { status: 409 })); await p.flush();
    assert.equal(p.state(), 'ready'); assert.equal(p.message(), { de, en }[locale].host.consentPage.notSavedYet);
    assert.equal(p.document.querySelector('fieldset').disabled, false);
    assert.deepEqual([...p.document.querySelectorAll('input:checked')].map(box => box.value), ['voice-elevenlabs']);
    assert.equal(p.posts.length, 1); assert.deepEqual(p.returns, []);
    p.choose(); void p.api.save(); await p.flush();
    assert.equal(p.posts[1].body.processing.revision, 7);
  });
  test(`AIT-376 round 2: existing failed and stale messages retain assertive alert semantics (${locale})`, async t => {
    for (const options of [{ fail: true }, { stale: true }]) {
      const p = await page(t, { ...options, session: { id: 's', locale, engine: {} } });
      p.document.querySelector('[data-select-all]').click(); p.document.querySelector('[data-grant]').click();
      await tick(() => ['failed', 'stale'].includes(p.document.querySelector('#consent-status').dataset.state));
      assert.equal(p.document.querySelector('#consent-status').getAttribute('role'), 'alert');
      assert.equal(p.document.querySelector('#consent-status').getAttribute('aria-live'), 'assertive');
      if (options.stale) {
        p.document.querySelector('#retry').click(); await tick(() => p.document.querySelector('#consent-status').dataset.state === 'ready');
        assert.equal(p.document.querySelector('#consent-status').getAttribute('role'), 'status');
        assert.equal(p.document.querySelector('#consent-status').getAttribute('aria-live'), 'polite');
      }
    }
  });
}

test('AIT-376 round 2: a sent grant arriving after withdrawal is refused by the real server', async t => {
  const storage = new SQLiteStorage(), selected = new Set(), responses = [], returns = [];
  const contract = { contract: 'same-terms', items: CONSENT_ITEMS };
  const consent = { coverage: () => ({ covered: false }), describe: () => ({ ...contract, selected: [...selected] }),
    grant: ({ decision }) => { decision.items.forEach(item => selected.add(item)); return true; }, withdraw: () => selected.clear() };
  const handlers = createHandlers({ storage, consent });
  const session = storage.create({ demo: true, ownerToken: testToken });
  const window = new Window({ url: `http://localhost/consent/?session=${session.id}` });
  t.after(async () => { await window.happyDOM.close(); await handlers.close(); storage.close(); });
  window.document.write(html.replace(/<script[^>]*>[\s\S]*?<\/script>/gu, ''));
  const send = (path, body) => handlers.handle(ownedRequest(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const held = Promise.withResolvers(); let sentGrant, withdrawal;
  const api = await mountConsentPage({ document: window.document, location: window.location, storage: window.localStorage,
    fetchImpl: path => path === '/demo/config' ? Response.json({ processingConsent: contract }) : handlers.handle(ownedRequest(`http://localhost${path}`)),
    navigate: path => returns.push(path), submit: async (path, body, { signal }) => {
      if (body.granted) { sentGrant = { path, body, signal }; await held.promise; }
      else withdrawal = body;
      const response = await send(path, body); responses.push({ granted: body.granted, status: response.status }); return response;
    } });
  window.document.querySelector('[data-select-all]').click(); const saving = api.save();
  await tick(() => sentGrant);
  await api.save(true);
  assert.equal(sentGrant.signal.aborted, true); assert.equal(Object.hasOwn(withdrawal.processing, 'revision'), false);
  assert.deepEqual(returns, ['/']); assert.deepEqual([...selected], []);
  held.resolve(); await saving; await tick(() => responses.length === 2);
  assert.deepEqual(responses, [{ granted: false, status: 200 }, { granted: true, status: 409 }]);
  assert.equal(storage.get(session.id).consentWithdrawn, true);
  assert.deepEqual((await (await handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/consent`))).json()).selected, []);
  assert.deepEqual(returns, ['/'], 'late refusal cannot repaint or navigate again');
});
