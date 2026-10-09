import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { startChild, temporaryDb } from '../../test/helpers.js';
import { AudioRail } from '../../packages/ui/src/audio-rail.js';
import { eventProbe, observedVoiceEvents } from '../../test/voice-test-events.js';

test('labelled fake agent exercises speech, voice barge-in, typing, acknowledged pause, reconnect and close through the demo', { timeout: 60_000 }, async t => {
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb());
  const nativeFetch = globalThis.fetch, window = new Window({ url: running.url });
  const keys = ['HTMLElement', 'customElements', 'document', 'CustomEvent', 'localStorage'];
  const originals = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  let cookie = '', failRecovery = false; const paths = [], failures = [];
  const notifications = eventProbe(), render = AudioRail.prototype.render, consume = AudioRail.prototype.consume;
  t.mock.method(AudioRail.prototype, 'render', function () {
    render.call(this);
    notifications.record({ source: 'render', state: this.root.dataset.state, busy: Boolean(this.busy),
      input: this.input, startDisabled: this.button('start').disabled, retryDisabled: this.button('retry').disabled });
  });
  t.mock.method(AudioRail.prototype, 'consume', function (session, generation) {
    session.events = observedVoiceEvents(session.events, event => notifications.record({ source: 'voice', event }));
    return consume.call(this, session, generation);
  });
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
    c.addEventListener('aithema-event', ({ detail: event }) => notifications.record({ source: 'session', event }));
    const act = (action, ...predicates) => {
      const after = notifications.events.length;
      const ready = Promise.all(predicates.map(predicate => notifications.waitFor(predicate, after)));
      action(); return ready;
    };
    const voice = (type, predicate = () => true) => notice => notice.source === 'voice' && notice.event.type === type && predicate(notice.event);
    const session = (type, predicate = () => true) => notice => notice.source === 'session' && notice.event.type === type && predicate(notice.event);
    const rendered = predicate => notice => notice.source === 'render' && predicate(notice);
    assert.match(document.querySelector('#fake-label').textContent, /Fake voice.*no provider network/);
    await act(() => document.querySelector('#grant').click(), session('consent.revised'), rendered(n => !n.startDisabled));
    await act(() => root.querySelector('.voice-start').click(), voice('final', e => e.role === 'assistant'));
    assert.equal(root.querySelector('.audio-rail').dataset.state, 'speaking');
    await act(() => document.querySelector('#fake-say').click(), voice('final', e => e.role === 'user' && e.text.includes('public API')),
      session('turn.final', e => e.data.role === 'user' && e.data.content.includes('public API')),
      voice('final', e => e.role === 'assistant' && e.text === 'I understand. Which part should we clarify first?'));
    assert.ok(c.session.transcript.some(t => t.role === 'user' && t.content.includes('public API')));
    await act(() => document.querySelector('#fake-interrupt').click(), session('turn.corrected', e => e.data.content === 'I understand.'),
      voice('heard', e => e.prefix === 'I understand.'), voice('listening'));
    assert.ok(c.session.transcript.some(t => t.content === 'I understand.'));
    assert.ok(c.session.transcript.every(t => t.content !== 'I understand. Which part should we clarify first?'));
    root.querySelector('textarea').value = 'Typed during voice';
    await act(() => root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })),
      session('turn.final', e => e.data.content === 'Typed during voice'), voice('final', e => e.role === 'assistant'));
    assert.ok(c.session.transcript.some(t => t.content === 'Typed during voice'));
    await act(() => root.querySelector('.voice-input').click(), rendered(n => !n.input && !n.busy));
    await act(() => root.querySelector('.voice-pause').click(), session('session.paused', e => e.data.paused), rendered(n => n.state === 'paused' && !n.busy));
    assert.equal(c.session.paused, true);
    await act(() => root.querySelector('.voice-pause').click(), session('session.paused', e => !e.data.paused), rendered(n => n.state === 'listening' && !n.busy));
    assert.equal(c.session.paused, false);
    assert.equal(root.querySelector('.voice-input').getAttribute('aria-pressed'), 'false', 'pause preserves input selection');
    await act(() => document.querySelector('#fake-disconnect').click(), voice('recovering'), voice('recovered'));
    assert.ok(paths.some(p => p.endsWith('/recover')));
    assert.ok(['listening', 'speaking'].includes(root.querySelector('.audio-rail').dataset.state));
    failRecovery = true; const attempts = paths.filter(p => p.endsWith('/recover')).length;
    await act(() => document.querySelector('#fake-disconnect').click(), voice('ended', e => e.reason === 'recovery-failed'));
    assert.equal(root.querySelector('.voice-retry').disabled, false);
    assert.equal(paths.filter(p => p.endsWith('/recover')).length - attempts, 3);
    assert.match(root.querySelector('.voice-state').textContent, /Three reconnect attempts failed/);
    assert.equal(root.querySelector('.send').disabled, false, 'typing remains available after exhausted recovery');
    failRecovery = false;
    await act(() => root.querySelector('.voice-retry').click(), voice('final', e => e.role === 'assistant'));
    assert.equal(root.querySelector('.voice-close').disabled, false);
    await act(() => root.querySelector('.voice-close').click(), rendered(n => n.state === 'idle'));
    assert.ok(paths.some(p => p.endsWith('/close')));
    for (const path of ['/demo/fake-voice.js', '/plugins/elevenlabs/src/client.js', '/plugins/elevenlabs/src/manifest.js',
      '/plugins/elevenlabs/src/options.js', '/packages/ui/src/audio-rail.js', '/vendor/elevenlabs/lib.iife.js', '/vendor/elevenlabs/worklets/raw-audio.js', '/vendor/elevenlabs/worklets/audio-concat.js']) {
      assert.equal((await nativeFetch(running.url + path)).status, 200);
    }
    assert.match(await nativeFetch(running.url + '/vendor/elevenlabs/worklets/raw-audio.js').then(r => r.text()), /registerProcessor/);
    for (const path of ['/plugins/elevenlabs/src/server.js', '/plugins/elevenlabs/src/facade.js']) {
      assert.equal((await nativeFetch(running.url + path)).status, 404);
    }
    assert.deepEqual(failures, []);
  } finally {
    window.document.querySelector('aithema-session')?.remove(); await running.kill(); await window.happyDOM.close();
    globalThis.fetch = nativeFetch;
    for (const key of keys) { if (originals[key] === undefined) delete globalThis[key]; else globalThis[key] = originals[key]; }
  }
});
