import { reviseMockConsent } from './consent-helper.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { startChild, temporaryDb } from '../../test/helpers.js';
import { contrast, mix, tokens } from '../../test/contrast.js';
import { hostDrain } from './host-drain.js';

test('demo host creates owned sessions through postJson and combines consent, pause and settings controls', { timeout: 60_000 }, async t => {
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb());
  const nativeFetch = globalThis.fetch, window = new Window({ url: running.url });
  const keys = ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'localStorage', 'location'];
  const originals = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  let cookie = ''; const posts = [];
  const lateRequest = Promise.withResolvers(), lateOutbox = Promise.withResolvers(), lateAdoption = Promise.withResolvers();
  const heldSignals = [];
  let holdSession = false, host;
  // AIT-611: the device conversation's host reads answer only after teardown.
  let holdHostReads = false; const hostReadGate = Promise.withResolvers(), hostReadsHeld = Promise.withResolvers();
  // AIT-611: the harness drain (test-only, ./host-drain.js) tracks the page's requests; its first drain
  // releases the held host reads, so they answer while teardown waits for them and the page still exists.
  let harness;
  try {
    const html = await nativeFetch(running.url).then(response => response.text());
    window.document.write(html.replace(/<script[^>]*>[\s\S]*?<\/script>/gu, ''));
    for (const key of keys) globalThis[key] = window[key];
    localStorage.setItem('aithema-demo-locale', 'en');
    harness = hostDrain({ onDrain: () => hostReadGate.resolve(), fetch: async (url, init = {}) => {
      if (holdSession && (String(url) === '/api/sessions' || String(url).endsWith('/demo/outbox'))) {
        const held = String(url) === '/api/sessions' ? lateRequest : lateOutbox;
        heldSignals.push(init.signal);
        init.signal?.addEventListener('abort', () => held.reject(init.signal.reason), { once: true });
        return held.promise;
      }
      const headers = new Headers(init.headers);
      if (cookie) headers.set('cookie', cookie);
      if (holdHostReads && !init.method && /\/(credits|identity|handover)$/u.test(String(url))) {
        // The server answers now; the page receives the answer only after the test has torn down its DOM.
        const held = Promise.withResolvers();
        init.signal?.addEventListener('abort', () => held.reject(init.signal.reason), { once: true });
        const answer = nativeFetch(new URL(url, running.url), { headers })
          .then(async response => new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers }));
        answer.then(response => hostReadGate.promise.then(() => held.resolve(response)), held.reject);
        if (String(url).endsWith('/credits')) answer.then(() => hostReadsHeld.resolve(), hostReadsHeld.reject);
        return held.promise;
      }
      if (init.method === 'POST') posts.push({ path: String(url), contentType: headers.get('content-type') });
      const response = await nativeFetch(new URL(url, running.url), { ...init, headers });
      const createdCookie = response.headers.get('set-cookie');
      if (createdCookie) cookie = createdCookie.split(';')[0];
      return response;
    } });
    globalThis.fetch = harness.fetch;
    host = await import('../host.js');
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
    await wait('settings model options opened', () => dialog.open && option('model', 'Demo only: thorough replies'));
    const eu = dialog.querySelector('.preset-option[data-preset="eu"]'), before = posts.length;
    assert.equal(eu.getAttribute('aria-disabled'), 'true'); eu.click();
    assert.equal(posts.length, before, 'an unavailable preset is never sent');
    assert.equal(option('model', 'GPT-4.1 mini').getAttribute('aria-disabled'), 'true', 'declared providers stay disabled with a reason');
    option('model', 'Demo only: thorough replies').click();
    await wait('Deep mock model acknowledged', () => component.session.settings.model === 'mock/deep');
    assert.equal(component.session.id, previousId, 'model changes apply to this conversation');
    assert.match(root.querySelector('.engine__detail').textContent, /Replies: Demo only: thorough replies/u);
    // AIT-118: the header and the mock consent name the active visual kind from the server's binding, never always the image label.
    const { en: copy } = await import('../../packages/ui/src/i18n/en.js'), h = copy.host;
    const header = () => document.querySelector('#provider').textContent;
    assert.equal(component.session.conceptVisualKind, 'html');
    assert.equal(header(), `Local demo, no AI provider\u00a0· ${h.labels['Fake HTML — local deterministic click-dummy, no provider network']}`);
    assert.equal(header(), 'Local demo, no AI provider\u00a0· Demo only: clickable draft');
    option('visuals', 'Demo only: sample images').click();
    await wait('image visuals acknowledged in header', () => component.session.conceptVisualKind === 'images' && header().endsWith('Test images (local PNG)'));
    option('visuals', 'Off').click();
    await wait('visuals disabled in header', () => header().endsWith(h.visualsOff));
    option('visuals', 'Demo only: clickable draft').click();
    await wait('HTML visuals acknowledged in header', () => header().endsWith('Demo only: clickable draft'));
    dialog.querySelector('.preset-option[data-preset="custom"]').click();
    await wait('custom preset saved', () => component.session.processingPreset === 'custom' && dialog.querySelector('.save-status').textContent === 'Changes saved');
    assert.equal(component.session.id, previousId);
    dialog.querySelector('.preset-option[data-preset="device"]').click();
    await wait('device preset offers a new conversation', () => dialog.querySelector('.notice-body .notice-action:not([hidden])'));
    assert.equal(component.session.processingPreset, 'custom', 'a started conversation never becomes a device conversation in place');
    holdHostReads = true;
    dialog.querySelector('.notice-body .notice-action').click();
    await wait('new device conversation created', () => component.session.processingPreset === 'device' && component.session.id !== previousId);
    await hostReadsHeld.promise;
    assert.equal(component.shadowRoot.querySelector('.intro').dataset.mode, 'ready', 'the explicit device choice is confirmed');
    assert.equal(document.querySelector('#error').textContent, '');
    assert.ok(posts.some(post => post.path.endsWith('/settings')));
    // The settings dialog defers consent to the host; its message comes from the i18n bundle.
    const { en } = await import('../../packages/ui/src/i18n/en.js');
    component.dispatchEvent(new CustomEvent('aithema-consent', { detail: { reason: 'settings', features: ['text'] } }));
    assert.equal(component.shadowRoot.querySelector('dialog.settings').open, true, 'AIT-509: host consent stays in-page');
    assert.notEqual(location.pathname, '/consent/');
    assert.ok(posts.length >= 9);
    assert.ok(posts.every(post => post.contentType === 'application/json'));
    assert.equal(posts[0].path, '/api/sessions', 'browser creation uses the guarded JSON request');
    // AIT-550: force a request to fail only after the test has torn down its DOM.
    // An abort-aware host can settle it during teardown instead. No timer race.
    holdSession = true;
    component.dispatchEvent(new CustomEvent('aithema-new-conversation', { detail: {} }));
    document.querySelector('#outbox').showModal = () => {};
    document.querySelector('#outbox-open').click();
    // Also hold adoption after configure, where locale acknowledgement can fail.
    component.configure = () => {};
    component.changeLocale = () => lateAdoption.promise;
    component.dispatchEvent(new CustomEvent('aithema-open-conversation', { detail: { session: component.session } }));
    assert.equal(heldSignals.length, 2, 'both host fetches are held');
    assert.ok(heldSignals.every(signal => signal && !signal.aborted));
    const cached = new window.Event('pagehide'); Object.defineProperty(cached, 'persisted', { value: true });
    window.dispatchEvent(cached);
    assert.ok(heldSignals.every(signal => !signal.aborted), 'a cached page keeps its work');
    const errorBefore = document.querySelector('#error').textContent, outboxBefore = document.querySelector('#outbox-status').textContent;
    window.dispatchEvent(new window.Event('pagehide'));
    let drained = false;
    const stopping = host.stopHost().then(() => { drained = true; });
    assert.ok(heldSignals.every(signal => signal.aborted), 'page unload aborts host requests');
    await Promise.resolve();
    assert.equal(drained, false, 'teardown also waits for adoption, beyond the fetch aborts');
    lateAdoption.reject(new Error('fixture: locale acknowledgement failed after unload'));
    await stopping;
    assert.equal(document.querySelector('#error').textContent, errorBefore, 'late failures do not repaint the stopped host');
    assert.equal(document.querySelector('#outbox-status').textContent, outboxBefore, 'late outbox failure does not repaint');
    const count = heldSignals.length;
    component.dispatchEvent(new CustomEvent('aithema-new-conversation', { detail: {} }));
    assert.equal(heldSignals.length, count, 'a stopped host starts no new work');
    t.after(() => setImmediate(() => lateRequest.reject(new Error('fixture: page has closed'))));
    t.after(() => setImmediate(() => hostReadGate.resolve()));
  } finally {
    lateAdoption.resolve();
    await host?.stopHost();
    // AIT-611: host reads still in flight answer (and their continuations run) before the DOM globals go;
    // an exceeded deadline fails the test naming the open requests (after the globals are restored).
    const undrained = await harness?.drain().then(() => null, error => error);
    window.document.querySelector('aithema-session')?.remove();
    await running.kill(); await window.happyDOM.close();
    globalThis.fetch = nativeFetch;
    for (const key of keys) { if (originals[key] === undefined) delete globalThis[key]; else globalThis[key] = originals[key]; }
    if (undrained) throw undrained;
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
