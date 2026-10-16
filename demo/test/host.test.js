import { reviseMockConsent } from './consent-helper.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { startChild, temporaryDb } from '../../test/helpers.js';
import { contrast, mix, tokens } from '../../test/contrast.js';

test('demo host creates owned sessions through postJson and combines consent, pause and settings controls', { timeout: 60_000 }, async t => {
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb());
  const nativeFetch = globalThis.fetch, window = new Window({ url: running.url });
  const keys = ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'localStorage', 'location'];
  const originals = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  let cookie = ''; const posts = [];
  try {
    const html = await nativeFetch(running.url).then(response => response.text());
    window.document.write(html.replace(/<script[^>]*>[\s\S]*?<\/script>/gu, ''));
    for (const key of keys) globalThis[key] = window[key];
    localStorage.setItem('aithema-demo-locale', 'en');
    globalThis.fetch = async (url, init = {}) => {
      const headers = new Headers(init.headers);
      if (cookie) headers.set('cookie', cookie);
      if (init.method === 'POST') posts.push({ path: String(url), contentType: headers.get('content-type') });
      const response = await nativeFetch(new URL(url, running.url), { ...init, headers });
      const createdCookie = response.headers.get('set-cookie');
      if (createdCookie) cookie = createdCookie.split(';')[0];
      return response;
    };
    await import('../host.js');
    const component = document.querySelector('aithema-session'), root = component.shadowRoot;
    const wait = async (step, predicate) => {
      const started = performance.now();
      // HTTP admission, mock reasoning and the event stream compete with the full
      // unit suite. Bound elapsed time, rather than counting nominal timer ticks.
      const timeoutMs = 10_000;
      while (!predicate()) {
        const elapsed = performance.now() - started;
        assert.ok(elapsed < timeoutMs, `Demo did not reach ${step} within ${timeoutMs}ms (elapsed ${elapsed.toFixed(0)}ms)`);
        await new Promise(resolve => setTimeout(resolve, Math.min(5, timeoutMs - elapsed)));
      }
      if (process.env.AITHEMA_WAIT_TIMING) t.diagnostic(`${step}: ${(performance.now() - started).toFixed(1)}ms`);
    };
    assert.ok(component.session.id);
    assert.equal(document.querySelector('#error').textContent, '');
    const firstId = component.session.id, input = root.querySelector('textarea');
    input.value = 'A draft before language choice';
    const language = document.querySelector('#locale');
    language.value = 'de'; language.dispatchEvent(new window.Event('change'));
    await wait('German locale acknowledged', () => component.session.locale === 'de' && document.documentElement.lang === 'de');
    assert.equal(component.session.id, firstId); assert.equal(root.querySelector('textarea'), input);
    assert.equal(input.value, 'A draft before language choice'); assert.equal(document.querySelector('#language-note').textContent, '');
    language.value = 'en'; language.dispatchEvent(new window.Event('change'));
    await wait('English locale acknowledged', () => component.session.locale === 'en' && document.documentElement.lang === 'en');
    assert.equal(root.querySelector('.intro').dataset.mode, 'chooser', 'a new conversation starts with the preset chooser');
    assert.equal(root.querySelector('.engine__value').textContent, 'Best models');
    assert.equal(root.querySelector('.send').disabled, true, 'initial mock admission waits for consent');
    await reviseMockConsent(component);
    await wait('send enabled after initial consent', () => !root.querySelector('.send').disabled);
    const send = root.querySelector('.send'), pause = root.querySelector('.pause');
    root.querySelector('textarea').value = 'systems: API; data: public';
    root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await wait('submitted systems constraint reflected in understanding', () => component.session.understanding.constraints.systems?.value === 'API');
    root.querySelector('.preset-panel').dispatchEvent(new window.Event('pointerenter'));
    const features = root.querySelector('.features').textContent;
    pause.click();
    await wait('pause acknowledged and send disabled', () => component.session.paused && send.disabled);
    assert.equal(pause.textContent, 'Resume');
    assert.notEqual(root.querySelector('.features').textContent, features, 'preset rows update at once under the pointer');
    assert.equal(document.documentElement.lang, 'en'); assert.equal(component.session.locale, 'en');
    assert.equal(root.querySelector('.readiness').style.visibility, '', 'cached analysis stays visible during pause');
    pause.click(); await wait('resume acknowledged and send enabled', () => !component.session.paused && !send.disabled);
    await reviseMockConsent(component, false);
    await wait('consent withdrawal acknowledged and send disabled', () => component.session.consentWithdrawn && send.disabled);
    assert.equal(root.querySelector('.summary-text').textContent, '');
    assert.equal(root.querySelector('.send'), send); assert.equal(root.querySelector('.pause'), pause);
    await reviseMockConsent(component);
    await wait('renewed consent acknowledged and send enabled', () => !component.session.consentWithdrawn && !send.disabled);
    root.querySelector('.preset-panel').dispatchEvent(new window.Event('pointerleave'));
    // Settings: the demo operator allowlist, enforced and acknowledged by the server.
    const previousId = component.session.id, dialog = root.querySelector('dialog.settings');
    const option = (name, label) => [...dialog.querySelectorAll(`[data-select="${name}"] [role=option]`)].find(node => node.querySelector('strong').textContent === label);
    root.querySelector('.settings-open').click();
    await wait('settings model options opened', () => dialog.open && option('model', 'Deep (mock)'));
    const eu = dialog.querySelector('.preset-option[data-preset="eu"]'), before = posts.length;
    assert.equal(eu.getAttribute('aria-disabled'), 'true'); eu.click();
    assert.equal(posts.length, before, 'an unavailable preset is never sent');
    assert.equal(option('model', 'GPT-4.1 mini').getAttribute('aria-disabled'), 'true', 'declared providers stay disabled with a reason');
    option('model', 'Deep (mock)').click();
    await wait('Deep mock model acknowledged', () => component.session.settings.model === 'mock/deep');
    assert.equal(component.session.id, previousId, 'model changes apply to this conversation');
    assert.match(root.querySelector('.engine__detail').textContent, /Replies: Deep \(mock\)/u);
    // AIT-118: the header and the mock consent name the active visual kind from the server's binding, never always the image label.
    const { en: copy } = await import('../../packages/ui/src/i18n/en.js'), h = copy.host;
    const header = () => document.querySelector('#provider').textContent;
    assert.equal(component.session.conceptVisualKind, 'html');
    assert.equal(header(), `Mock reasoning — deterministic demo · ${h.labels['Fake HTML — local deterministic click-dummy, no provider network']}`);
    assert.equal(header(), 'Mock reasoning — deterministic demo · Test drafts (local click-dummy)');
    option('visuals', 'Fake images (local PNG)').click();
    await wait('image visuals acknowledged in header', () => component.session.conceptVisualKind === 'images' && header().endsWith('Test images (local PNG)'));
    option('visuals', 'Off').click();
    await wait('visuals disabled in header', () => header().endsWith(h.visualsOff));
    option('visuals', 'Fake HTML (local click-dummy)').click();
    await wait('HTML visuals acknowledged in header', () => header().endsWith('Test drafts (local click-dummy)'));
    dialog.querySelector('.preset-option[data-preset="custom"]').click();
    await wait('custom preset saved', () => component.session.processingPreset === 'custom' && dialog.querySelector('.save-status').textContent === 'Changes saved');
    assert.equal(component.session.id, previousId);
    dialog.querySelector('.preset-option[data-preset="device"]').click();
    await wait('device preset offers a new conversation', () => dialog.querySelector('.notice-body .notice-action:not([hidden])'));
    assert.equal(component.session.processingPreset, 'custom', 'a started conversation never becomes a device conversation in place');
    dialog.querySelector('.notice-body .notice-action').click();
    await wait('new device conversation created', () => component.session.processingPreset === 'device' && component.session.id !== previousId);
    assert.equal(component.shadowRoot.querySelector('.intro').dataset.mode, 'ready', 'the explicit device choice is confirmed');
    assert.equal(document.querySelector('#error').textContent, '');
    assert.ok(posts.some(post => post.path.endsWith('/settings')));
    // The settings dialog defers consent to the host; its message comes from the i18n bundle.
    const { en } = await import('../../packages/ui/src/i18n/en.js');
    component.dispatchEvent(new CustomEvent('aithema-consent', { detail: { reason: 'settings', features: ['text'] } }));
    assert.equal(location.pathname, '/consent/');
    assert.equal(new URLSearchParams(location.search).get('session'), component.session.id);
    assert.ok(posts.length >= 9);
    assert.ok(posts.every(post => post.contentType === 'application/json'));
    assert.equal(posts[0].path, '/api/sessions', 'browser creation uses the guarded JSON request');
  } finally {
    window.document.querySelector('aithema-session')?.remove();
    await running.kill(); await window.happyDOM.close();
    globalThis.fetch = nativeFetch;
    for (const key of keys) { if (originals[key] === undefined) delete globalThis[key]; else globalThis[key] = originals[key]; }
  }
});

test('demo page tokens reach WCAG AA text contrast in light and dark (AIT-116 D9, AIT-118)', async () => {
  const html = await readFile(new URL('../host.css', import.meta.url), 'utf8');
  const light = tokens(html.match(/^:root \{([^}]*)\}/mu)[1], '');
  const dark = tokens(html.match(/@media\(prefers-color-scheme:dark\) \{ :root:not\(\[data-theme="light"\]\) \{([^}]*)\}/u)[1], '');
  for (const [theme, t] of Object.entries({ light, dark })) {
    const backgrounds = { paper: t.paper, surface: t.surface, 'hover tint': mix(t.accent, t.paper, .08) };
    const pairs = [];
    for (const text of ['ink', 'muted', 'accent', 'error']) for (const [name, background] of Object.entries(backgrounds)) pairs.push([`${text} on ${name}`, t[text], background]);
    for (const [pair, text, background] of pairs) assert.ok(contrast(text, background) >= 4.5, `${theme} ${pair}: ${contrast(text, background).toFixed(2)}:1`);
  }
  const grant = html.match(/\.consent-actions \[data-grant\] \{([^}]*)\}/u)[1];
  const color = grant.match(/color:(#[0-9a-f]{3,6});/u)[1], foreground = color.length === 4 ? '#' + [...color.slice(1)].map(c => c + c).join('') : color;
  const stops = grant.match(/linear-gradient\(150deg,(#[0-9a-f]{6}),(#[0-9a-f]{6})\)/u).slice(1);
  for (const stop of stops) assert.ok(contrast(foreground, stop) >= 4.5, `consent grant on ${stop}: ${contrast(foreground, stop).toFixed(2)}:1`);
});
