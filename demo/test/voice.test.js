import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { startChild, temporaryDb } from '../../test/helpers.js';

test('labelled fake agent exercises speech, voice barge-in, typing, acknowledged pause, reconnect and close through the demo', { timeout: 15_000 }, async () => {
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb());
  const nativeFetch = globalThis.fetch, window = new Window({ url: running.url });
  const keys = ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'localStorage'];
  const originals = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  let cookie = '', failRecovery = false; const paths = [], failures = [];
  try {
    const html = await nativeFetch(running.url).then(r => r.text());
    window.document.write(html.replace(/<script[^>]*>[\s\S]*?<\/script>/gu, ''));
    for (const key of keys) globalThis[key] = window[key];
    globalThis.fetch = async (url, init = {}) => {
      const absolute = new URL(url, running.url); assert.equal(absolute.origin, new URL(running.url).origin, 'agent never opens an external network');
      paths.push(absolute.pathname);
      if (failRecovery && absolute.pathname.endsWith('/recover')) return Response.json({ error: 'local-fixture-failure' }, { status: 503 });
      const headers = new Headers(init.headers); if (cookie) headers.set('cookie', cookie);
      const response = await nativeFetch(absolute, { ...init, headers });
      if (response.status >= 400) failures.push({ path: absolute.pathname, status: response.status, error: await response.clone().text() });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return response;
    };
    await import('../host.js');
    const c = document.querySelector('aithema-session'), root = c.shadowRoot;
    const wait = async predicate => {
      for (let i = 0; i < 800; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
      assert.fail('Fake voice did not reach the expected state: ' + JSON.stringify({ state: root.querySelector('.audio-rail').dataset.state, failures, turns: c.session.transcript.map(t => ({id:t.id,content:t.content})) }));
    };
    assert.match(document.querySelector('#fake-label').textContent, /Fake voice.*no provider network/);
    document.querySelector('#grant').click(); await wait(() => !root.querySelector('.voice-start').disabled);
    root.querySelector('.voice-start').click(); await wait(() => root.querySelector('.audio-rail').dataset.state === 'speaking');
    document.querySelector('#fake-say').click(); await wait(() => c.session.transcript.some(t => t.content?.includes('public API')));
    document.querySelector('#fake-interrupt').click(); await wait(() => c.session.transcript.some(t => t.content === 'I understand.'));
    assert.ok(c.session.transcript.every(t => t.content !== 'I understand. Which part should we clarify first?'));
    root.querySelector('textarea').value = 'Typed during voice'; root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await wait(() => c.session.transcript.some(t => t.content === 'Typed during voice'));
    root.querySelector('.voice-input').click(); await wait(() => root.querySelector('.voice-input').getAttribute('aria-pressed') === 'false');
    root.querySelector('.voice-pause').click(); await wait(() => c.session.paused && root.querySelector('.audio-rail').dataset.state === 'paused');
    root.querySelector('.voice-pause').click(); await wait(() => !c.session.paused && root.querySelector('.audio-rail').dataset.state === 'listening');
    assert.equal(root.querySelector('.voice-input').getAttribute('aria-pressed'), 'false', 'pause preserves input selection');
    document.querySelector('#fake-disconnect').click(); await wait(() => paths.some(p => p.endsWith('/recover')));
    await wait(() => root.querySelector('.audio-rail').dataset.state === 'listening' || root.querySelector('.audio-rail').dataset.state === 'speaking');
    failRecovery = true; const attempts = paths.filter(p => p.endsWith('/recover')).length;
    document.querySelector('#fake-disconnect').click(); await wait(() => root.querySelector('.voice-retry').disabled === false);
    assert.equal(paths.filter(p => p.endsWith('/recover')).length - attempts, 3);
    assert.match(root.querySelector('.voice-state').textContent, /Three reconnect attempts failed/);
    assert.equal(root.querySelector('.send').disabled, false, 'typing remains available after exhausted recovery');
    failRecovery = false; root.querySelector('.voice-retry').click(); await wait(() => root.querySelector('.voice-close').disabled === false);
    root.querySelector('.voice-close').click(); await wait(() => root.querySelector('.audio-rail').dataset.state === 'idle');
    assert.ok(paths.some(p => p.endsWith('/close')));
    for (const path of ['/demo/fake-voice.js', '/plugins/elevenlabs/src/client.js', '/plugins/elevenlabs/src/manifest.js',
      '/plugins/elevenlabs/src/options.js', '/packages/ui/src/audio-rail.js', '/vendor/elevenlabs/lib.iife.js', '/vendor/elevenlabs/worklets/raw-audio.js', '/vendor/elevenlabs/worklets/audio-concat.js']) {
      assert.equal((await nativeFetch(running.url + path)).status, 200);
    }
    assert.match(await nativeFetch(running.url + '/vendor/elevenlabs/worklets/raw-audio.js').then(r => r.text()), /registerProcessor/);
    for (const path of ['/plugins/elevenlabs/src/server.js', '/plugins/elevenlabs/src/facade.js']) {
      assert.equal((await nativeFetch(running.url + path)).status, 404);
    }
  } finally {
    window.document.querySelector('aithema-session')?.remove(); await running.kill(); await window.happyDOM.close();
    globalThis.fetch = nativeFetch;
    for (const key of keys) { if (originals[key] === undefined) delete globalThis[key]; else globalThis[key] = originals[key]; }
  }
});
