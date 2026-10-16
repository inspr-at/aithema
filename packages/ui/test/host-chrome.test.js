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
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, voice: { available: false, reason: 'not configured' } } };
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
    assert.equal(root.querySelector('.host-version__value').textContent, ' 1.2.3');
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
