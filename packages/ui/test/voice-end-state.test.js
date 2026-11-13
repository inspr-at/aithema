import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession } from '@inspr/aithema-core';
import { voiceEvents } from '../../core/src/live-voice.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { manifest } from '../../../plugins/elevenlabs/src/manifest.js';
const window = new Window({ url: 'http://localhost/' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
for (const timeLimit of ['call', 'conversation']) test(`AIT-502: durable voice.state spend-deadline/${timeLimit} goes through close`, async t => {
  const session = createSession({ demo: true }), events = voiceEvents(), c = document.createElement('aithema-session');
  session.featureMatrix = { best: Object.fromEntries(['text', 'voice', 'analysis'].map(key => [key, { available: true }])) };
  const call = { callId: 'call', providerSessionId: 'segment', events, async setInput() {}, async setOutput() {}, async updateContext() {},
    async close() { events.end(); return { closureConfirmed: true, usage: { costEstimated: false } }; } };
  t.mock.method(globalThis, 'fetch', async (_url, init = {}) => init.method === 'POST'
    ? Response.json({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'typed', role: 'user', content: 'Continue typing' } })
    : new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.close(), { once: true }); } })));
  c.configure({ session, copy: en, voiceClient: { manifest, async start() { return call; } } });
  document.body.append(c); t.after(async () => { c.remove(); events.end(); await window.happyDOM.abort(); });
  const root = c.shadowRoot; root.querySelector('.voice-start').click(); await flush();
  c.receive({ type: 'voice.state', data: { callId: 'call', providerSessionId: 'segment', state: 'ended', reason: 'spend-deadline', timeLimit } });
  await flush();
  assert.equal(root.querySelector('.voice-state').getAttribute('aria-label'), timeLimit === 'call' ? en.voiceTimeLimit : en.voiceStates.timeExpired);
  assert.equal(root.querySelector('.voice-retry').disabled, timeLimit === 'conversation');
  if (timeLimit === 'call') {
    root.querySelector('textarea').value = 'Continue typing'; root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await flush();
    assert.equal(root.querySelector('.audio-rail').hasAttribute('data-message'), false);
  }
});

test('AIT-502 v2.2: unknown durable spend bound has no message and offers Start', async t => {
  const session = createSession({ demo: true }), events = voiceEvents(), c = document.createElement('aithema-session');
  session.featureMatrix = { best: Object.fromEntries(['text', 'voice', 'analysis'].map(key => [key, { available: true }])) };
  const call = { callId: 'unknown-call', providerSessionId: 'segment', events, async setInput() {}, async setOutput() {}, async updateContext() {},
    async close() { events.end(); return { closureConfirmed: true, usage: { costEstimated: false } }; } };
  t.mock.method(globalThis, 'fetch', async (_url, init = {}) => new Response(new ReadableStream({ start(controller) {
    init.signal?.addEventListener('abort', () => controller.close(), { once: true });
  } })));
  c.configure({ session, copy: en, voiceClient: { manifest, async start() { return call; } } });
  document.body.append(c); t.after(async () => { c.remove(); events.end(); await window.happyDOM.abort(); });
  const root = c.shadowRoot; root.querySelector('.voice-start').click(); await flush();
  c.receive({ type: 'voice.state', data: { callId: 'unknown-call', providerSessionId: 'segment', state: 'ended', reason: 'spend-deadline' } });
  await flush();
  assert.equal(root.querySelector('.voice-state').getAttribute('aria-label'), en.voiceStates.failed);
  assert.equal(root.querySelector('.audio-rail').hasAttribute('data-message'), false);
  assert.equal(root.querySelector('.voice-start').disabled, false); assert.equal(root.querySelector('.voice-retry').disabled, true);
});

test('AIT-502 gate L1: German component supplies locale for a host bundle without display.locale', async t => {
  const session = createSession({ demo: true, locale: 'de' }), c = document.createElement('aithema-session');
  session.locale = 'de';
  session.featureMatrix = { best: Object.fromEntries(['text', 'voice', 'analysis'].map(key => [key, { available: true }])) };
  const copy = structuredClone(de); delete copy.display.locale; delete copy.voiceConnectFailed; delete copy.voiceMessageClose;
  delete copy.voiceMessagesNarrow.voiceConnectFailed;
  c.configure({ session, copy, voiceClient: { manifest, async start() { throw { code: 'deadline', status: 504 }; } } });
  t.after(() => c.remove());
  const root = c.shadowRoot; root.querySelector('.voice-start').click(); await flush();
  assert.equal(root.querySelector('.voice-state').getAttribute('aria-label'), de.voiceConnectFailed);
  assert.equal(root.querySelector('.consent-narrow').dataset.copy, de.voiceMessagesNarrow.voiceConnectFailed);
  assert.equal(root.querySelector('.voice-message-close').getAttribute('aria-label'), de.voiceMessageClose);
});
