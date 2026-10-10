// AIT-104 B2 gate fix round 1: the demo page's slot fills, fake outbox and demo handover wording
// belong to the local demo host only. A live provider host (demoHost:false) shows none of them and
// keeps the component's own handover wording; the demo host's outbox confirmation carries the AI notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { aiNotice } from '../../packages/core/src/ai-notice.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';

const demoCopy = /Demo only|Nur Demo|\(demo\)|\(nur Demo\)|Nothing leaves this computer|Nichts verlässt diesen Computer|fake mail|Test-E-Mails/iu;
// The demo-specific strings (generic words such as Source code or Close also name the page's own controls).
const demoTexts = copy => [...['account', 'accountNote', 'handoverOffer', 'creditsLimit', 'legal', 'footer'].map(key => copy.host.slots[key]),
  ...['open', 'title', 'note', 'empty', 'confirmed'].map(key => copy.host.outbox[key]), copy.host.handover.sent];

test('demo slot fills, the fake outbox and the demo handover wording appear only with the demo host', { timeout: 15_000 }, async t => {
  const window = new Window({ url: 'http://localhost' });
  const keys = ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'localStorage', 'fetch'];
  const originals = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  try {
    for (const key of keys.filter(key => key !== 'fetch')) globalThis[key] = window[key];
    await import('../../packages/ui/src/session-element.js');
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const body = html.match(/<body>([\s\S]*?)<\/body>/u)[1].replace(/<script[^>]*>[\s\S]*?<\/script>/gu, '');
    // The page with a stubbed component: configure() records what the host passes.
    function prepare(demoHost, locale, providers = { imageLabel: 'Images off', voiceMode: 'off' }, engine = {}) {
      document.body.innerHTML = body;
      localStorage.clear(); localStorage.setItem('aithema-demo-locale', locale);
      const session = { id: `slots-${locale}`, locale, processingPreset: 'best', featureMatrix: {}, ...engine };
      const component = document.querySelector('aithema-session'), configured = [];
      component.configure = options => { configured.push(options); };
      Object.defineProperty(component, 'session', { get: () => configured.at(-1)?.session });
      globalThis.fetch = async url => {
        if (url === '/demo/config') return Response.json({ label: 'Mock reasoning — deterministic demo', ...providers, demoHost });
        if (url === '/api/sessions') return Response.json(session);
        if (url === `/api/sessions/${session.id}/demo/outbox`) return Response.json({ messages: [{ address: 'visitor@example.com', token: 'token' }] });
        assert.fail(`Unexpected host request: ${url}`);
      };
      return configured;
    }
    for (const locale of ['en', 'de']) {
      const copy = locale === 'de' ? de : en;
      await t.test(`live provider host (demoHost:false, ${locale}): none of the demo copy is present`, async () => {
        const configured = prepare(false, locale);
        await import(`../host.js?slots-live-${locale}`);
        assert.equal(document.querySelector('#error').textContent, '');
        assert.equal(document.querySelectorAll('[data-demo-only]').length, 0);
        assert.equal(document.querySelector('#outbox-open') === null, true, 'no fake outbox button');
        for (const id of ['title', 'provider', 'mock-hint', 'settings-hint', 'resume-hint', 'fake-voice']) assert.equal(document.getElementById(id), null);
        assert.equal(document.title, 'Aithema');
        assert.equal(document.querySelector('section[aria-labelledby="consent-title"]'), null);
        const page = document.body.innerHTML;
        assert.doesNotMatch(page, demoCopy);
        for (const text of [...demoTexts(en), ...demoTexts(de)]) assert.ok(!page.includes(text), `demo copy on a live page: ${text}`);
        assert.equal(configured.at(-1).copy.hostSurface.handover.sent, copy.hostSurface.handover.sent, 'the live wording stays');
      });
      await t.test(`demo host (${locale}): labelled fills, accurate handover success and an outbox confirmation described by the AI notice`, async () => {
        const configured = prepare(true, locale);
        await import(`../host.js?slots-demo-${locale}`);
        assert.equal(document.querySelector('#error').textContent, '');
        assert.equal(document.querySelector('#demo-footer').textContent, copy.host.slots.footer);
        assert.equal(document.querySelector('#demo-credits-limit').textContent, copy.host.slots.creditsLimit);
        assert.equal(document.querySelector('#outbox-open').hidden, false);
        // The demo handover reaches a fake recipient: success promises no contact, in line with the slot's disclaimer.
        const sent = configured.at(-1).copy.hostSurface.handover.sent;
        assert.equal(sent, copy.host.handover.sent);
        assert.doesNotMatch(sent, locale === 'de' ? /melden uns persönlich/u : /contact you personally/u);
        assert.equal(configured.at(-1).copy.hostSurface.handover.request, copy.hostSurface.handover.request, 'only the success line changes');
        document.querySelector('#outbox-open').click();
        for (let i = 0; i < 100 && !document.querySelector('#outbox-list li button'); i++) await new Promise(resolve => setTimeout(resolve, 5));
        const confirm = document.querySelector('#outbox-list li button'), notice = document.getElementById('ai-notice');
        assert.deepEqual(confirm.getAttribute('aria-describedby').split(' '), ['ai-notice']);
        assert.ok(document.querySelector('#outbox').contains(notice), 'the notice is in view inside the modal outbox');
        assert.equal(notice.textContent, aiNotice(locale).text);
      });
      // Gate round 2: demoHost depends on the text provider alone, so live voice or images can run beside the
      // simulated email, handover and credits. The demo copy claims only what the demo host itself simulates.
      await t.test(`demo host beside live images or voice (${locale}): no copy claims that nothing leaves this computer`, async () => {
        // Live images render here; the ElevenLabs voice SDK cannot load in happy-dom, so the copy check below covers voice.
        prepare(true, locale, { imageMode: 'openai', imageLabel: 'OpenAI images', voiceMode: 'off' },
          { engine: { visuals: 'openai' }, conceptVisualKind: 'images' });
        await import(`../host.js?slots-mixed-${locale}`);
        assert.equal(document.querySelector('#error').textContent, '');
        assert.equal(document.querySelector('#demo-footer').textContent, copy.host.slots.footer);
        assert.match(document.querySelector('#provider').textContent, /OpenAI/u, 'the header names the live image provider');
        const page = document.body.textContent;
        assert.doesNotMatch(page, /leaves this computer|verlässt diesen Computer|stays local|bleibt lokal|nothing leaves|nichts verlässt/iu);
        for (const text of demoTexts(copy)) assert.doesNotMatch(text, /leaves this computer|verlässt diesen Computer|nothing leaves|nichts verlässt/iu, text);
      });
    }
  } finally {
    window.document.querySelector('aithema-session')?.remove();
    await window.happyDOM.close();
    for (const key of keys) { if (originals[key] === undefined) delete globalThis[key]; else globalThis[key] = originals[key]; }
  }
});

test('the limit slot never recommends New: the owner time guard survives new and reset (credits.js rebindCredits)', () => {
  for (const copy of [en, de]) assert.doesNotMatch(copy.host.slots.creditsLimit, /Start a new conversation|Beginnen Sie .* ein neues Gespräch/u);
  assert.match(en.host.slots.creditsLimit, /a new conversation does not lift it/u);
  assert.match(de.host.slots.creditsLimit, /ein neues Gespräch hebt sie nicht auf/u);
});
