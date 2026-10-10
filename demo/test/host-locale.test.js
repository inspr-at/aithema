// AIT-126: switching the language on a conversation without turns restarts it in that language at once.
// The first live test on start2 kept speaking English after a switch to German, because the choice only
// applied to the next conversation. A conversation with turns keeps its language (the next one follows the choice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

test('the language switch restarts an empty conversation in the chosen language and keeps one with turns', { timeout: 15_000 }, async t => {
  const window = new Window({ url: 'http://localhost' });
  const keys = ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'Event', 'localStorage', 'fetch'];
  const originals = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  try {
    for (const key of keys.filter(key => key !== 'fetch')) globalThis[key] = window[key];
    await import('../../packages/ui/src/session-element.js');
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const body = html.match(/<body>([\s\S]*?)<\/body>/u)[1].replace(/<script[^>]*>[\s\S]*?<\/script>/gu, '');
    // The page with a stubbed component; each created conversation is recorded with its requested language.
    function prepare(transcript) {
      document.body.innerHTML = body;
      localStorage.clear(); localStorage.setItem('aithema-demo-locale', 'en');
      const component = document.querySelector('aithema-session'), configured = [], created = [];
      component.configure = options => { configured.push(options); };
      Object.defineProperty(component, 'session', { get: () => configured.at(-1)?.session });
      globalThis.fetch = async (url, init = {}) => {
        if (url === '/demo/config') return Response.json({ label: 'Mock reasoning — deterministic demo', imageLabel: 'Images off', voiceMode: 'off', demoHost: false });
        if (url === '/api/sessions' && init.method === 'POST') {
          const { locale } = JSON.parse(init.body); created.push(locale);
          return Response.json({ id: `locale-${created.length}`, locale, processingPreset: 'best', featureMatrix: {}, transcript: created.length === 1 ? transcript : [] });
        }
        assert.fail(`Unexpected host request: ${url}`);
      };
      return { configured, created };
    }
    const settle = async (check, label) => {
      for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok(check(), label);
    };
    const choose = locale => {
      const select = document.querySelector('#locale'); select.value = locale;
      select.dispatchEvent(new Event('change'));
    };
    await t.test('no turn yet: switching to German creates a German conversation at once and adopts it', async () => {
      const { configured, created } = prepare([]);
      await import('../host.js?locale-empty');
      await settle(() => configured.at(-1)?.session?.locale === 'en', 'the first conversation follows the stored choice');
      choose('de');
      await settle(() => configured.at(-1)?.session?.locale === 'de', 'the German conversation is adopted');
      assert.deepEqual(created, ['en', 'de']);
      assert.equal(localStorage.getItem('aithema-demo-locale'), 'de');
    });
    await t.test('with turns: the conversation keeps its language; only the next one follows the choice', async () => {
      const { configured, created } = prepare([{ id: 'turn-1', role: 'user', content: 'Hello' }]);
      await import('../host.js?locale-turns');
      await settle(() => configured.at(-1)?.session?.locale === 'en', 'the first conversation follows the stored choice');
      choose('de');
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepEqual(created, ['en'], 'no new conversation while this one has turns');
      assert.equal(configured.at(-1).session.locale, 'en');
      assert.equal(localStorage.getItem('aithema-demo-locale'), 'de', 'the next conversation follows the choice');
    });
  } finally {
    window.document.querySelector('aithema-session')?.remove();
    await window.happyDOM.close();
    for (const key of keys) { if (originals[key] === undefined) delete globalThis[key]; else globalThis[key] = originals[key]; }
  }
});
