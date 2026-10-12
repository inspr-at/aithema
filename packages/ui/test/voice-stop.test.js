import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession } from '@inspr/aithema-core';
import { AudioRail } from '../src/audio-rail.js';
import { createVoiceControl } from '../src/voice-control.js';
import { voiceJournal } from '../src/voice-orphan.js';
import { en } from '../src/i18n/en.js';
import { createElevenLabsClient } from '../../../plugins/elevenlabs/src/client.js';
import { fakeSdk } from '../../../plugins/elevenlabs/test/fixtures.js';

const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 4; i++) await tick(); };

function fixture(t, { transport, restored = true, component = false, echoPause = false } = {}) {
  const session = createSession({ demo: true }), sdk = fakeSdk(), requests = [], returned = [], failures = [];
  const resumeEntered = Promise.withResolvers(), resumeAck = Promise.withResolvers();
  const closeEntered = Promise.withResolvers(), closeAck = Promise.withResolvers();
  let callId = 'restored-call', echoed = false;
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true } } };
  const waiting = { callId, providerSessionId: 'retired-provider', state: 'waiting', attempts: 3,
    needsRecovery: true, spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() - 1000 };
  if (restored) session.voiceLifecycle = waiting;
  const records = new Map(), storage = { getItem: key => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) };
  const journal = voiceJournal(storage, session.id);
  if (restored) journal.save({ callId, providerSessionId: waiting.providerSessionId });
  const originalStorage = globalThis.sessionStorage; globalThis.sessionStorage = storage;
  t.after(() => { globalThis.sessionStorage = originalStorage; });
  const receipt = () => ({ callId, providerSessionId: 'resumed-provider',
    credential: { providerSessionId: 'resumed-provider', ttlMs: 60_000, connectionType: transport,
      ...(transport === 'websocket' ? { signedUrl: 'wss://socket.example.test/call?conversation_id=resumed-provider' }
        : { conversationToken: 'fixture-token-resumed-provider' }) },
    spendDeadlineAt: waiting.spendDeadlineAt, browserLivenessDeadlineAt: Date.now() + 30_000,
    ...(restored ? { overrides: { agent: { language: 'en', firstMessage: '' } } } : {}) });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (!options.body) {
      if (url.endsWith('/events')) return new Response(new ReadableStream({ start(stream) {
        options.signal?.addEventListener('abort', () => stream.close(), { once: true });
      } }), { headers: { 'content-type': 'text/event-stream' } });
      return Response.json(session);
    }
    const request = { url, body: JSON.parse(options.body), keepalive: options.keepalive, completed: false };
    requests.push(request);
    if (url.endsWith('/close')) {
      closeEntered.resolve(); await closeAck.promise; request.completed = true;
      return Response.json({ closureConfirmed: true, usage: { costEstimated: false } });
    }
    if (url.endsWith('/resume')) {
      resumeEntered.resolve(); await resumeAck.promise; return Response.json({ acknowledged: true, paused: false });
    }
    if (url.endsWith('/pause')) {
      if (echoPause && !echoed) {
        echoed = true; element.receive({ seq: 1, type: 'session.paused',
          data: { paused: true, pauseRequestId: request.body.pauseRequestId } });
      }
      return Response.json({ acknowledged: true, paused: true });
    }
    if (url.endsWith('/heartbeat')) return Response.json({ acknowledged: true, browserLivenessDeadlineAt: Date.now() + 30_000 });
    callId = request.body.callId; return Response.json(receipt());
  });
  const { control } = createVoiceControl({ sessionId: session.id });
  const client = createElevenLabsClient({ control, sdk, mediaDevices: sdk.mediaDevices, AudioContext: sdk.AudioContext,
    persistEvent: async () => {} });
  const start = client.start;
  client.start = async (...args) => {
    try { const result = await start(...args); returned.push(result); return result; }
    catch (error) { failures.push(error); throw error; }
  };
  let root, rail, element;
  if (component) {
    element = document.createElement('aithema-session'); document.body.append(element);
    element.configure({ copy: en, session, voiceClient: client }); root = element.shadowRoot;
  } else {
    root = document.createElement('div'); document.body.append(root);
    rail = new AudioRail({ root, copy: en, client, waitingCall: restored ? waiting : undefined,
      feature: () => ({ available: true }), context: () => ({}), journal });
  }
  t.after(async () => {
    resumeAck.resolve(); closeAck.resolve(); await flush();
    await rail?.close(); rail?.destroy();
    element?.remove(); element?.configure({ copy: en, session: createSession() });
    if (!element) root.remove();
    await Promise.all(returned.map(value => value.close())); await flush();
  });
  return { sdk, client, root, rail, element, returned, failures, requests, waiting, journal,
    resumeEntered, resumeAck, closeEntered, closeAck };
}

for (const transport of ['webrtc', 'websocket']) {
  test(`AIT-138 fix 2: ${transport} Close fences restored Resume before a stalled closeWaiting POST`, async t => {
    const f = fixture(t, { transport }), starting = f.rail.start();
    await f.resumeEntered.promise;
    assert.equal(f.sdk.acquired.length, 0, 'restored setup uses device-free silence');
    const generation = f.rail.generation, before = f.sdk.effects.length, closing = f.rail.close();
    const abortedOnClose = f.rail.controller.signal.aborted;
    await f.closeEntered.promise;
    assert.equal(f.requests.filter(request => request.url.endsWith('/close'))[0].completed, false);
    f.resumeAck.resolve(); await flush();
    assert.deepEqual({ abortedOnClose, generation: f.rail.generation, acquisitions: f.sdk.acquired.length,
      unmuted: f.sdk.effects.slice(before).filter(([name, volume]) => name === 'setVolume' && volume > 0),
      state: f.root.dataset.state, call: f.root.dataset.call },
    { abortedOnClose: true, generation: generation + 1, acquisitions: 0, unmuted: [], state: 'idle', call: 'none' });
    assert.equal(f.rail.endedCall.callId, f.waiting.callId);
    f.closeAck.resolve(); await closing; await starting;
    assert.equal(f.failures[0]?.code, 'cancelled');
    assert.equal(f.returned.length, 0, 'a terminal startup cannot return a live session');
    assert.ok(f.requests.some(request => request.url.endsWith('/close') && request.body.background === true && request.completed));
    assert.equal(f.journal.read(), null, 'background completion settles the retained journal');
  });

  test(`AIT-138 fix 2: ${transport} a startup deadline stops media before the exhaustion POST and late Resume`, async t => {
    const f = fixture(t, { transport });
    const starting = f.client.start(f.waiting, { deadlineAt: Date.now() + 100 }).then(value => value, error => error);
    await f.resumeEntered.promise; await f.closeEntered.promise;
    f.resumeAck.resolve(); await flush();
    assert.equal(f.sdk.acquired.length, 0, 'an expired startup never acquires the microphone after its late acknowledgement');
    assert.ok(f.sdk.closed, 'SDK shutdown starts before the stalled exhaustion request');
    assert.ok(f.sdk.effects.filter(([name]) => name === 'setVolume').every(([, volume]) => volume === 0));
    f.closeAck.resolve(); assert.equal((await starting).code, 'deadline');
    assert.ok(f.requests.some(request => request.body.reason === 'recovery-failed' && request.body.recoveryAttempts === 3 && request.completed));
  });

  for (const restored of [false, true]) {
    test(`AIT-138 fix 2: ${transport} its own pause echo preserves ${restored ? 'restored Resume' : 'one Pause request'}`, async t => {
      const f = fixture(t, { transport, restored, component: true, echoPause: true });
      f.root.querySelector(restored ? '.pause' : '.voice-start').click(); await flush();
      if (!restored) { f.root.querySelector('.pause').click(); await flush(); }
      assert.equal(f.requests.filter(request => request.url.endsWith('/pause')).length, 1, 'an echo cannot recursively pause its own request');
      if (restored) {
        assert.equal(f.requests.filter(request => request.url.endsWith('/resume')).length, 1, 'setup pause acknowledgement must allow the explicit Resume');
        f.resumeAck.resolve(); await flush();
      }
      assert.equal(f.root.querySelector('.audio-rail').dataset.state, restored ? 'listening' : 'paused');
    });

    test(`AIT-138 fix 2: ${transport} a server pause fences ${restored ? 'restored startup' : 'active Resume'} before its acknowledgement`, async t => {
      const f = fixture(t, { transport, restored, component: true });
      f.root.querySelector(restored ? '.pause' : '.voice-start').click();
      if (!restored) {
        await flush(); f.root.querySelector('.pause').click(); await flush();
        f.root.querySelector('.pause').click();
      }
      await f.resumeEntered.promise;
      const acquired = f.sdk.acquired.length, before = f.sdk.effects.length;
      f.element.receive({ seq: 1, type: 'session.paused', data: { paused: true } });
      const mutedImmediately = f.sdk.effects.slice(before).some(([name, volume]) => name === 'setVolume' && volume === 0);
      f.resumeAck.resolve(); await flush();
      assert.deepEqual({ mutedImmediately, acquisitions: f.sdk.acquired.length,
        unmuted: f.sdk.effects.slice(before).filter(([name, volume]) => name === 'setVolume' && volume > 0),
        state: f.root.querySelector('.audio-rail').dataset.state },
      { mutedImmediately: true, acquisitions: acquired, unmuted: [], state: 'paused' });
      if (!restored) assert.equal(f.returned[0].lifecycle.state.state, 'paused');
      f.closeAck.resolve(); await flush();
      if (restored) {
        assert.equal(f.returned.length, 0); assert.equal(f.failures[0]?.code, 'unavailable');
        assert.equal(f.root.querySelector('.audio-rail').dataset.state, 'waiting');
      }
    });
  }

  for (const restored of [false, true]) {
    test(`AIT-138 fix 2: ${transport} pagehide stops ${restored ? 'restored Resume' : 'an active call'} before stalled closure`, async t => {
      const f = fixture(t, { transport, restored, component: true });
      if (!restored) f.resumeAck.resolve();
      f.root.querySelector(restored ? '.pause' : '.voice-start').click();
      if (restored) await f.resumeEntered.promise;
      else await flush();
      const before = f.sdk.effects.length, acquired = f.sdk.acquired.length;
      window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: true }));
      const stoppedImmediately = f.sdk.acquired.every(stream => stream.getTracks().every(track => track.readyState === 'ended'));
      const mutedImmediately = f.sdk.effects.slice(before).some(([name, volume]) => name === 'setVolume' && volume === 0);
      const closeWasSent = f.requests.some(request => request.url.endsWith('/close') && request.keepalive === true);
      f.resumeAck.resolve(); await flush();
      window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true })); await flush();
      assert.deepEqual({ stoppedImmediately, mutedImmediately, closeWasSent,
        acquisitions: f.sdk.acquired.length, unmuted: f.sdk.effects.slice(before).filter(([name, volume]) => name === 'setVolume' && volume > 0),
        state: f.root.querySelector('.audio-rail').dataset.state },
      { stoppedImmediately: true, mutedImmediately: true, closeWasSent: true, acquisitions: acquired, unmuted: [], state: 'idle' });
      for (const session of f.returned) assert.equal(session.lifecycle.state.state, 'ended', 'page restoration cannot undo terminal intent');
      f.closeAck.resolve(); await flush();
      assert.ok(f.requests.some(request => request.url.endsWith('/close') && request.keepalive === true && request.completed));
    });
  }
}
