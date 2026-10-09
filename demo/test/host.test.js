import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { startChild, temporaryDb } from '../../test/helpers.js';

test('demo host creates owned sessions through postJson and combines consent, pause and settings controls', { timeout: 15_000 }, async () => {
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb());
  const nativeFetch = globalThis.fetch, window = new Window({ url: running.url });
  const keys = ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'localStorage'];
  const originals = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  let cookie = ''; const posts = [];
  try {
    const html = await nativeFetch(running.url).then(response => response.text());
    window.document.write(html.replace(/<script[^>]*>[\s\S]*?<\/script>/gu, ''));
    for (const key of keys) globalThis[key] = window[key];
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
    const wait = async predicate => {
      for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
      assert.fail('Demo did not reach the expected consent/pause/preset state');
    };
    assert.ok(component.session.id);
    assert.equal(document.querySelector('#error').textContent, '');
    assert.equal(root.querySelector('.intro').dataset.mode, 'chooser', 'a new conversation starts with the preset chooser');
    assert.equal(root.querySelector('.engine__value').textContent, 'Best models');
    assert.equal(root.querySelector('.send').disabled, true, 'initial mock admission waits for consent');
    document.querySelector('#grant').click();
    await wait(() => !root.querySelector('.send').disabled);
    const send = root.querySelector('.send'), pause = root.querySelector('.pause');
    root.querySelector('textarea').value = 'systems: API; data: public';
    root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await wait(() => component.session.understanding.constraints.systems?.value === 'API');
    root.querySelector('.preset-panel').dispatchEvent(new window.Event('pointerenter'));
    const features = root.querySelector('.features').textContent;
    pause.click();
    await wait(() => component.session.paused && send.disabled);
    assert.equal(pause.textContent, 'Resume');
    assert.notEqual(root.querySelector('.features').textContent, features, 'preset rows update at once under the pointer');
    assert.equal(document.documentElement.lang, 'en'); assert.equal(component.session.locale, 'en');
    assert.equal(root.querySelector('.readiness').style.visibility, '', 'cached analysis stays visible during pause');
    pause.click(); await wait(() => !component.session.paused && !send.disabled);
    document.querySelector('#revoke').click();
    await wait(() => component.session.consentWithdrawn && send.disabled);
    assert.equal(root.querySelector('.summary-text').textContent, '');
    assert.equal(root.querySelector('.send'), send); assert.equal(root.querySelector('.pause'), pause);
    document.querySelector('#grant').click();
    await wait(() => !component.session.consentWithdrawn && !send.disabled);
    root.querySelector('.preset-panel').dispatchEvent(new window.Event('pointerleave'));
    // Settings: the demo operator allowlist, enforced and acknowledged by the server.
    const previousId = component.session.id, dialog = root.querySelector('dialog.settings');
    const option = (name, label) => [...dialog.querySelectorAll(`[data-select="${name}"] [role=option]`)].find(node => node.querySelector('strong').textContent === label);
    root.querySelector('.settings-open').click();
    await wait(() => dialog.open && option('model', 'Deep (mock)'));
    const eu = dialog.querySelector('.preset-option[data-preset="eu"]'), before = posts.length;
    assert.equal(eu.getAttribute('aria-disabled'), 'true'); eu.click();
    assert.equal(posts.length, before, 'an unavailable preset is never sent');
    assert.equal(option('model', 'GPT-4.1 mini via OpenRouter').getAttribute('aria-disabled'), 'true', 'declared providers stay disabled with a reason');
    option('model', 'Deep (mock)').click();
    await wait(() => component.session.settings.model === 'mock/deep');
    assert.equal(component.session.id, previousId, 'model changes apply to this conversation');
    assert.match(root.querySelector('.engine__detail').textContent, /Deep \(mock\)/u);
    dialog.querySelector('.preset-option[data-preset="custom"]').click();
    await wait(() => component.session.processingPreset === 'custom' && dialog.querySelector('.save-status').textContent === 'Changes saved');
    assert.equal(component.session.id, previousId);
    dialog.querySelector('.preset-option[data-preset="device"]').click();
    await wait(() => dialog.querySelector('.notice-action:not([hidden])'));
    assert.equal(component.session.processingPreset, 'custom', 'a started conversation never becomes a device conversation in place');
    dialog.querySelector('.notice-action').click();
    await wait(() => component.session.processingPreset === 'device' && component.session.id !== previousId);
    assert.equal(component.shadowRoot.querySelector('.intro').dataset.mode, 'ready', 'the explicit device choice is confirmed');
    assert.equal(document.querySelector('#error').textContent, '');
    assert.ok(posts.some(post => post.path.endsWith('/settings')));
    // The settings dialog defers consent to the host; its message comes from the i18n bundle.
    const { en } = await import('../../packages/ui/src/i18n/en.js');
    component.dispatchEvent(new CustomEvent('aithema-consent', { detail: { reason: 'settings', features: ['text'] } }));
    assert.equal(document.querySelector('#consent-status').textContent, en.consentForSelection);
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
