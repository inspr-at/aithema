import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { confirmationCopy, confirmationWait, createConfirmationPage } from '../confirmation-page.js';
import { startChild, temporaryDb } from '../../test/helpers.js';

const origin = 'https://host.example.test';
const states = [
  ['valid', 'ready', {}], ['confirmed', 'confirmed', {}],
  ['alreadyUsed', 'usedConfirmed', { addressConfirmed: true }], ['alreadyUsed', 'usedLink', { addressConfirmed: false }],
  ['expired', 'expired', {}], ['invalid', 'invalid', {}],
  ['tooManyAttempts', 'tooMany', { retryAt: 721_000 }], ['tooManyAttempts', 'tooManyNow', { retryAt: 1_000 }],
];
for (const locale of ['de', 'en']) for (const [state, key, extra] of states) test(`C2 ${locale} ${key} has approved copy, one active view, privacy and CSP-clean markup`, async () => {
  let redeems = 0;
  const host = { identity: { deliversVerification: true }, privacyDocumentConfigured: () => true,
    confirmation: { inspect: () => ({ state, locale, address: 'visitor@example.test', tier: locale === 'de' ? '2.000' : '2,000', ...extra }),
      csrf: () => 'c'.repeat(64), redeem: () => { redeems++; } } };
  const page = createConfirmationPage({ host, publicOrigin: origin, now: () => 1_000 });
  const response = await page.handle(new Request(origin + '/confirm-email?token=opaque'));
  const html = await response.text();
  const window = new Window({ settings: { disableJavaScriptEvaluation: true } });
  try {
    window.document.write(html);
    const d = window.document, c = confirmationCopy[locale][key];
    assert.equal(d.querySelector('h1').textContent, c.h1);
    assert.equal(d.title, state === 'valid' ? (locale === 'de' ? 'E-Mail-Adresse bestätigen' : 'Confirm your email address') : c.h1);
    assert.equal(d.querySelectorAll('h1').length, 1);
    assert.equal(d.querySelectorAll('.confirm-view:not([aria-hidden])').length, 1);
    assert.equal(d.querySelector('.confirm-view:not([aria-hidden]) .confirm-label').textContent, c.button);
    assert.equal(d.querySelector('[data-confirmation-state]').dataset.confirmationState, state);
    if (['valid', 'confirmed'].includes(state)) {
      assert.equal(d.querySelectorAll('.confirm-view').length, 2);
      const hidden = d.querySelector('.confirm-view[aria-hidden="true"]');
      assert.ok(hidden.hasAttribute('inert')); assert.equal(hidden.querySelector('.confirm-title').tagName, 'P');
      assert.equal(hidden.querySelector('.confirm-button').tagName, 'SPAN');
      assert.equal(d.querySelectorAll('.confirm-num').length, 2);
      // Tick's approved done badge is a single check stroke, never the ready envelope.
      const done = d.querySelector('.confirm-icon--done svg');
      assert.equal(done.children.length, 1);
      assert.equal(done.querySelector('path')?.getAttribute('d'), 'M5.75 12.5l4.1 4.1 8.4-8.6');
      assert.equal(d.querySelector('.confirm-address').textContent, 'visitor@example.test');
    } else assert.equal(d.querySelectorAll('.confirm-view').length, 1);
    if (state === 'valid') {
      assert.equal(d.querySelector('form').method, 'post');
      assert.deepEqual([...d.querySelectorAll('input')].map(x => [x.name, x.value]), [['token', 'opaque'], ['csrf', 'c'.repeat(64)], ['lang', locale]]);
    }
    assert.equal(d.querySelector('.confirm-privacy').getAttribute('href'), '/privacy?locale=' + locale);
    assert.equal(d.querySelectorAll('[style], style, script:not([src])').length, 0);
    assert.deepEqual([...d.querySelectorAll('script')].map(x => x.getAttribute('src')), ['/demo/theme-init.js', '/demo/confirm-email.js']);
    assert.equal(response.status, 200); assert.equal(redeems, 0);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(d.querySelector('meta[name=referrer]').content, 'strict-origin');
    assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
    assert.doesNotMatch(html, /lena\.gruber|2[.,]400|Almost done/u);
  } finally { await window.happyDOM.close(); }
});

for (const locale of ['de', 'en']) for (const state of ['valid', 'confirmed']) test(`C2 ${locale} ${state} omits unknown address and uses the approved tier fallback`, async () => {
  const host = { demo: true, identity: { deliversVerification: true }, confirmation: { inspect: () => ({ state, locale }), csrf: () => '' } };
  const html = await (await createConfirmationPage({ host, publicOrigin: origin }).handle(new Request(origin + '/confirm-email'))).text();
  assert.ok(html.includes(confirmationCopy[locale][state === 'valid' ? 'ready' : 'confirmed'].leadFallback));
  assert.doesNotMatch(html, /class="confirm-address"|class="confirm-num"|class="confirm-privacy"|undefined|\{tier\}/u);
});

test('C2 address and tier are escaped before the tier/unit emphasis is added', async () => {
  const host = { demo: true, identity: { deliversVerification: true }, confirmation: {
    inspect: () => ({ state: 'valid', address: '<script>alert(1)</script>', tier: '<img src=x>' }), csrf: () => '' } };
  const html = await (await createConfirmationPage({ host, publicOrigin: origin }).handle(new Request(origin + '/confirm-email'))).text();
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;')); assert.ok(html.includes('&lt;img src=x&gt; Credits</b>'));
  assert.doesNotMatch(html, /<img|<script>alert/u);
});

test('C2 resend wait rounds up minutes and hours, with singulars and ready-now fallback', () => {
  for (const [ms, de, en] of [[1, '1 Minute', '1 minute'], [60_001, '2 Minuten', '2 minutes'], [660_001, '12 Minuten', '12 minutes'],
    [3_599_999, '60 Minuten', '60 minutes'], [3_600_000, '1 Stunde', '1 hour'], [3_600_001, '2 Stunden', '2 hours']]) {
    assert.equal(confirmationWait(1_000 + ms, 'de', 1_000), de); assert.equal(confirmationWait(1_000 + ms, 'en', 1_000), en);
  }
  for (const retry of [undefined, null, NaN, 999, 1_000]) assert.equal(confirmationWait(retry, 'en', 1_000), null);
});

test('C2 the real host static allowlist serves the confirmation script', async t => {
  const demo = await startChild(new URL('../server.js', import.meta.url), await temporaryDb());
  t.after(() => demo.kill());
  const response = await fetch(demo.url + '/demo/confirm-email.js');
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /javascript/u);
  assert.match(await response.text(), /form\[data-confirm\]/u);
});
