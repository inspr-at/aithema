import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, inputRevision } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
test.after(() => window.happyDOM.close());
const absent = '.audio-rail, .voice-notices, .pause, .voice-start, .voice-input, .voice-output, .ai-notice__voice, .ready__mode[data-mode="voice"], [data-ready="microphone"], [data-ready="speaker"], .voice-repeat, .voice-read-text, .voice-reply-actions';
function configure(locale, options = {}) {
  const c = document.createElement('aithema-session'), session = createSession({ locale, demo: true });
  // A catalog can offer voice even when its browser client is absent/off-only.
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, voice: { available: true } } };
  c.configure({ copy: { en, de }[locale], session, ...options });
  return c;
}
for (const locale of ['de', 'en']) {
  test(`AIT-260: no bound voice mounts no voice UI through entrance, readiness, replies and pause, ${locale}`, () => {
    for (const voiceClients of [undefined, {}, { off: null }, { off: {} }]) {
      const c = configure(locale, { voiceClients }), root = c.shadowRoot;
      const check = () => {
        assert.equal(root.querySelector(absent), null);
        const content = root.querySelector('.workspace');
        assert.doesNotMatch(content.textContent, /synthetische Stimme|synthetic voice|Text lesen|Read text/u);
      };
      check();
      c.receive({ seq: c.session.seq + 1, type: 'settings.changed', data: { processingPreset: 'best', settings: { ...c.session.settings, origin: 'chosen', revision: 1 } } });
      check();
      c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'u', role: 'user', content: 'Hello' } });
      c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'a', role: 'assistant', content: 'Reply', inputRevision: inputRevision(c.session) } });
      c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
      assert.equal(c.session.paused, true); check();
      c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: false } });
      assert.equal(c.session.paused, false); check();
    }
  });
  test(`AIT-260: bound voice stays mounted when unselected or temporarily unavailable, ${locale}`, () => {
    for (const clients of [{ voiceClient: {} }, { voiceClients: { offered: {} } }]) {
      const c = configure(locale, clients), root = c.shadowRoot;
      const rail = root.querySelector('.audio-rail'), pause = root.querySelector('.pause');
      assert.ok(rail); assert.ok(pause);
      assert.equal(root.querySelector('.ai-notice__voice').textContent, { en, de }[locale].layout.syntheticVoice);
      c.receive({ seq: c.session.seq + 1, type: 'settings.changed', data: { processingPreset: 'device', settings: { ...c.session.settings, voice: 'off', origin: 'chosen', revision: 1 } } });
      assert.equal(root.querySelector('.audio-rail'), rail); assert.equal(root.querySelector('.pause'), pause);
    }
  });
  test(`AIT-260: host version uses normalised, reactive brand text and never overrides Aithema, ${locale}`, async () => {
    const c = document.createElement('aithema-session'), brand = document.createElement('h1');
    brand.slot = 'brand'; brand.textContent = '  START\n  Studio  '; c.append(brand);
    const session = createSession({ locale, demo: true });
    c.configure({ copy: { en, de }[locale], session, host: { version: { product: 'Override', version: '1.2.3', version_scheme: 'legacy', commit: 'abcdef1234' } } });
    const root = c.shadowRoot;
    assert.equal(root.querySelector('.wordmark').classList.contains('visually-hidden'), false);
    assert.equal(root.querySelector('slot[name="brand"]').assignedElements()[0], brand);
    assert.equal(root.querySelector('.host-version__label').textContent, 'START Studio');
    assert.equal(root.querySelector('.host-version__value').dataset.canonical, '1.2.3');
    assert.equal(root.querySelector('.display-version').textContent, 'Aithema 2026.10');
    assert.match(root.querySelector('#build-info').textContent, /Build abcdef1/u);
    brand.textContent = 'New\t Brand'; await new Promise(resolve => setImmediate(resolve));
    assert.equal(root.querySelector('.host-version__label').textContent, 'New Brand');
    brand.remove(); root.querySelector('slot[name="brand"]').dispatchEvent(new window.Event('slotchange'));
    assert.equal(root.querySelector('.host-version__label').textContent, 'Host');
    assert.equal(root.querySelector('.wordmark').classList.contains('visually-hidden'), true);
  });
  test(`AIT-260: legal slot lives in the footer bar without requiring host surface ports, ${locale}`, () => {
    const c = configure(locale), legal = document.createElement('nav'); legal.slot = 'legal';
    legal.innerHTML = '<a href="/imprint">Imprint</a><a href="/privacy">Privacy</a>'; c.append(legal);
    const root = c.shadowRoot, slot = root.querySelector('slot[name="legal"]');
    slot.dispatchEvent(new window.Event('slotchange'));
    assert.ok(slot.closest('.display-foot .footer-right'));
    assert.equal(slot.closest('.footer-popup'), null);
    assert.equal(slot.parentElement.hidden, false);
    assert.ok(root.querySelector('slot[name="footer"]').closest('.footer-popup'));
  });
}

test('AIT-260: changing device connector and voice binding keeps teardown renders consistent', () => {
  const c = configure('en'), session = c.session, deviceConnector = () => {};
  for (const voiceClient of [undefined, {}, undefined, {}]) {
    c.configure({ copy: en, session, voiceClient, deviceConnector });
    c.configure({ copy: en, session, voiceClient: voiceClient ? undefined : {} });
    assert.equal(Boolean(c.shadowRoot.querySelector('.audio-rail')), !voiceClient);
  }
});

for (const locale of ['de', 'en']) {
  test(`AIT-260: no-voice resume is acknowledged, retryable and preserves the draft, ${locale}`, async t => {
    const c = configure(locale), root = c.shadowRoot, copy = { en, de }[locale];
    const input = root.querySelector('textarea');
    input.value = 'Unsent draft';
    let release, calls = 0;
    t.mock.method(globalThis, 'fetch', (url, init) => {
      assert.ok(url.endsWith(`/sessions/${c.session.id}/pause`));
      assert.deepEqual(JSON.parse(init.body), { paused: false }); calls++;
      return new Promise(resolve => { release = resolve; });
    });
    for (const cause of ['restore', 'blur', 'limits']) {
      const paused = cause === 'restore' ? { ...c.session, paused: true } : null;
      if (paused) c.configure({ copy, session: paused });
      else c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true, reason: cause } });
      const r = c.shadowRoot, field = r.querySelector('textarea'), button = r.querySelector('.send'), resume = r.querySelector('.composer-resume');
      field.value = 'Unsent draft';
      assert.equal(field.disabled, true); assert.equal(button.disabled, false);
      assert.equal(r.querySelector('.composer-paused').hidden, false);
      assert.equal(r.querySelector('.composer-paused span').textContent, copy.composerPaused);
      assert.equal(resume.textContent, copy.resume); assert.equal(button.getAttribute('aria-label'), copy.resume);
      assert.equal(button.title, copy.resume); assert.equal(r.querySelector(absent), null);
      resume.click(); assert.equal(c.session.paused, true);
      assert.equal(resume.disabled, true); assert.equal(button.disabled, true);
      const pendingCalls = calls; button.click(); resume.click(); assert.equal(calls, pendingCalls);
      release(new Response(null, { status: 500 })); await new Promise(resolve => setImmediate(resolve));
      assert.equal(c.session.paused, true); assert.equal(field.disabled, true);
      assert.equal(resume.disabled, false); assert.equal(button.disabled, false);
      // Exercise the Send slot's actual submit path as well as the inline click.
      r.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
      release(Response.json({ event: { seq: c.session.seq + 1, type: 'session.paused', data: { paused: false } } }));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(c.session.paused, false); assert.equal(field.disabled, false);
      assert.equal(r.querySelector('.composer-paused').hidden, true);
      assert.equal(field.value, 'Unsent draft'); assert.equal(button.getAttribute('aria-label'), copy.send);
    }
  });
}

for (const locale of ['de', 'en']) for (const source of ['host', 'budget']) {
  test(`AIT-260: used-up panel takes precedence over pause and survives resume, ${locale}/${source}`, () => {
    const session = createSession({ locale, demo: true }), copy = { en, de }[locale];
    session.paused = true;
    session.featureMatrix = { best: { text: { available: false, reason: 'session paused',
      unpaused: { available: false, reason: 'budget denied' } } } };
    if (source === 'host') session.credits = { status: 'ended', endReason: 'session' };
    const c = configure(locale, { session, host: source === 'host' ? { library: true } : undefined }), r = c.shadowRoot;
    const check = () => {
      assert.equal(r.querySelector('.composer-shell').hasAttribute('data-used-up'), true);
      assert.equal(r.querySelector('form.composer').inert, true);
      assert.equal(r.querySelector('form.composer').getAttribute('aria-hidden'), 'true');
      assert.equal(r.querySelector('.composer-out').inert, false);
      assert.equal(r.querySelector('.composer-out').getAttribute('aria-hidden'), 'false');
      assert.equal(r.querySelector('.composer-out__title').textContent, copy.hostSurface.usedUp.title);
      assert.equal(r.querySelector('.composer-paused').hidden, true);
      assert.equal(r.querySelector('.qcard').inert, true);
    };
    check();
    // A programmatic click cannot resume a terminal composer, either.
    r.querySelector('.composer-resume').click();
    assert.equal(c.session.paused, true); check();
    c.session.featureMatrix.best.text = { available: false, reason: 'budget denied' };
    c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: false } }); check();
    c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true, reason: 'limits' } }); check();
  });
}

for (const locale of ['de', 'en']) for (const voice of [false, true]) {
  test(`AIT-283: first footer paint reserves transport labels, ${locale}/voice=${voice}`, () => {
    const copy = { en, de }[locale], c = configure(locale, voice ? { voiceClient: {} } : {});
    const r = c.shadowRoot, status = r.querySelector('.status');
    assert.equal(status.querySelector('.status__label').textContent, copy.connectionLabels.connecting);
    const reserved = [...status.querySelectorAll('.status__sizer > span')].map(n => n.textContent);
    for (const words of ['connecting', 'connected', 'reconnecting', ...(voice ? ['paused', 'voiceInAnotherTab'] : [])].map(key => copy.connectionLabels[key])) {
      assert.ok(reserved.includes(words), 'transport and bound-voice labels have a permanent width reservation');
    }
    assert.equal(status.querySelector('.status__sizer').getAttribute('aria-hidden'), 'true');
    assert.equal(r.querySelector('.engine-info').disabled, false);
    assert.equal(r.querySelector('.ai-notice').disabled, false);
  });
}

for (const locale of ['de', 'en']) {
  test(`AIT-283: all footer states have short localized labels and full descriptions, ${locale}`, () => {
    const copy = { en, de }[locale];
    assert.deepEqual(copy.connectionLabels, locale === 'de'
      ? { connecting: 'Verbindet …', connected: 'Verbunden', reconnecting: 'Verbindet …', paused: 'Pausiert', voiceInAnotherTab: 'Anderer Tab' }
      : { connecting: 'Connecting …', connected: 'Connected', reconnecting: 'Reconnecting …', paused: 'Paused', voiceInAnotherTab: 'Other tab' });
    for (const key of Object.keys(copy.connectionLabels)) {
      assert.ok(copy[key], `${key} retains its full description`);
      assert.ok(copy.connectionLabels[key].length <= 14);
    }
  });
  test(`AIT-283: transport tooltip/live text changes once and short labels stay reserved, ${locale}`, async t => {
    const copy = { en, de }[locale], c = configure(locale), r = c.shadowRoot;
    let resolveResponse, stream;
    t.mock.method(globalThis, 'fetch', (url, init) => {
      if (url.endsWith('/events')) return new Promise(resolve => {
        resolveResponse = () => resolve(new Response(new ReadableStream({ start(controller) { stream = controller; } })));
        init.signal.addEventListener('abort', () => resolve(new Response(null, { status: 499 })), { once: true });
      });
      return Promise.resolve(Response.json({}));
    });
    document.body.append(c); t.after(() => c.remove());
    const live = r.querySelector('.status__live'), announcements = [];
    const observer = new window.MutationObserver(() => announcements.push(live.textContent));
    observer.observe(live, { childList: true, subtree: true, characterData: true });
    t.after(() => observer.disconnect());
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    const check = key => {
      assert.equal(r.querySelector('.status').title, copy[key]);
      assert.equal(live.textContent, copy[key]);
      assert.equal(live.getAttribute('aria-live'), 'polite');
      assert.equal(r.querySelector('.status__label').textContent, copy.connectionLabels[key]);
      assert.equal(r.querySelector('.status__dot').getAttribute('aria-label'), copy[key]);
    };
    check('connecting'); resolveResponse(); await flush(); check('connected');
    // Unrelated repaints retain the live node without another announcement.
    c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
    await flush(); assert.equal(r.querySelector('.status__live'), live);
    assert.deepEqual(announcements, [copy.connected]);
    stream.close(); await flush(); check('reconnecting');
    await flush(); assert.deepEqual(announcements, [copy.connected, copy.reconnecting]);
  });
}
