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
    epoch: 1, needsRecovery: true, spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() - 1000 };
  if (restored) session.voiceLifecycle = waiting;
  const records = new Map(), storage = { getItem: key => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) };
  const journal = voiceJournal(storage, session.id);
  if (restored) journal.save({ callId, providerSessionId: waiting.providerSessionId });
  const originalStorage = globalThis.sessionStorage; globalThis.sessionStorage = storage;
  t.after(() => { globalThis.sessionStorage = originalStorage; });
  const receipt = () => ({ callId, providerSessionId: 'resumed-provider',
    epoch: waiting.epoch, controllingTabId: control.tabId,
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
      resumeEntered.resolve(); await resumeAck.promise; request.completed = true;
      return Response.json({ acknowledged: true, paused: false });
    }
    if (url.endsWith('/pause')) {
      if (echoPause && !echoed) {
        echoed = true; element.receive({ seq: 1, type: 'session.paused',
          data: { paused: true, pauseRequestId: request.body.pauseRequestId } });
      }
      request.completed = true; return Response.json({ acknowledged: true, paused: true });
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
  test(`AIT-138 d fix 1: ${transport} takeover after restored server Resume fences its delayed HTTP acknowledgement`, async t => {
    const f = fixture(t, { transport, component: true });
    const root = f.root.querySelector('.audio-rail');
    f.root.querySelector('.pause').click(); await f.resumeEntered.promise;
    const resume = f.requests.find(request => request.url.endsWith('/resume'));
    // Resume has committed on the server. Its HTTP receipt is still in flight
    // when the next tab takes ownership and the durable notification arrives.
    f.element.receive({ seq: 1, type: 'session.paused',
      data: { paused: false, resumeRequestId: resume.body.resumeRequestId } });
    f.element.receive({ type: 'voice.state', data: { callId: f.waiting.callId,
      providerSessionId: 'resumed-provider', epoch: 2, controllingTabId: 'successor-tab',
      state: 'waiting', needsRecovery: true, reason: 'tab-takeover' } });
    const synchronousState = root.dataset.state;
    f.resumeAck.resolve(); f.closeAck.resolve(); await flush();
    const outgoing = f.sdk.outgoing.length; f.sdk.sample({ buffered: true });
    assert.deepEqual({ synchronousState, state: root.dataset.state, returned: f.returned.length,
      captures: f.sdk.acquired.length, unmuted: f.sdk.effects.filter(([name, volume]) => name === 'setVolume' && volume > 0),
      sentAfterTakeover: f.sdk.outgoing.length - outgoing },
    { synchronousState: 'waiting', state: 'waiting', returned: 0, captures: 0, unmuted: [], sentAfterTakeover: 0 });
    assert.equal(root.querySelector('.voice-state').textContent, en.voiceMoved);
    assert.equal(root.querySelector('.voice-pause').disabled, false, 'the retired tab offers a fresh explicit takeover');
    assert.ok(f.requests.filter(request => request.url.endsWith('/close')).every(request =>
      request.body.epoch === 1 && request.body.reason === 'recovery-failed'), 'cleanup retains only the retired epoch');
  });

  for (const hold of [null, 'server Pause', 'visibility hold']) {
    test(`AIT-138 fix 4: ${transport} restored Resume echo before HTTP acknowledgement ${hold ? `preserves newer ${hold}` : 'unpauses the UI with active media'}`, async t => {
      const f = fixture(t, { transport, component: true });
      let hidden = false;
      if (hold === 'visibility hold') t.mock.method(document, 'hidden', () => hidden, { getter: true });
      const root = f.root.querySelector('.audio-rail'), input = f.root.querySelector('textarea');
      f.root.querySelector('.pause').click(); await f.resumeEntered.promise;
      const resume = f.requests.find(request => request.url.endsWith('/resume'));
      assert.equal(resume.completed, false);
      f.element.receive({ seq: 1, type: 'session.paused',
        data: { paused: false, resumeRequestId: resume.body.resumeRequestId } });
      assert.equal(f.element.session.paused, true, 'the echo cannot release the HTTP acknowledgement fence');
      assert.equal(input.disabled, true);
      assert.equal(f.sdk.acquired.length, 0);
      assert.ok(f.sdk.effects.filter(([name]) => name === 'setVolume').every(([, volume]) => volume === 0));
      if (hold === 'server Pause') f.element.receive({ seq: 2, type: 'session.paused', data: { paused: true } });
      if (hold === 'visibility hold') {
        hidden = true; document.dispatchEvent(new window.Event('visibilitychange'));
      }
      f.resumeAck.resolve(); f.closeAck.resolve(); await flush();
      assert.equal(resume.completed, true);
      assert.equal(f.element.session.paused, Boolean(hold), 'the acknowledged UI projection follows the latest hold');
      assert.equal(input.disabled, Boolean(hold), 'typing and the pause projection agree');
      assert.equal(f.root.querySelector('.send').disabled, Boolean(hold));
      if (hold) {
        assert.equal(root.dataset.state, 'waiting');
        assert.equal(f.root.querySelector('.status__label').textContent, en.paused);
        assert.equal(f.returned.length, 0, 'a superseded startup cannot return active media');
        assert.equal(f.sdk.acquired.length, 0);
        assert.ok(f.sdk.effects.filter(([name]) => name === 'setVolume').every(([, volume]) => volume === 0));
        assert.equal(f.requests.filter(request => request.url.endsWith('/resume')).length, 1);
      } else {
        assert.equal(root.dataset.state, 'listening');
        assert.notEqual(f.root.querySelector('.status__label').textContent, en.paused);
        assert.equal(f.returned[0].lifecycle.state.state, 'active');
        assert.ok(f.sdk.acquired.some(stream => stream.getTracks().some(track => track.readyState === 'live')));
        assert.deepEqual(f.sdk.effects.filter(([name]) => name === 'setVolume').at(-1), ['setVolume', 1]);
        const outgoing = f.sdk.outgoing.length; f.sdk.sample();
        assert.equal(f.sdk.outgoing.length, outgoing + 1, 'acknowledged active capture sends audio');
      }
    });
  }

  for (const hold of ['server Pause', 'visibility hold']) {
    test(`AIT-138 fix 3: ${transport} delayed superseded Resume echo preserves ${hold} after compensating Pause HTTP`, async t => {
      const f = fixture(t, { transport, restored: false, component: true });
      let acquisitions = 0; f.sdk.beforeAcquire = () => { acquisitions++; };
      let hidden = false;
      if (hold === 'visibility hold') t.mock.method(document, 'hidden', () => hidden, { getter: true });
      const pause = f.root.querySelector('.pause'), root = f.root.querySelector('.audio-rail');
      f.root.querySelector('.voice-start').click(); await flush();
      pause.click(); await flush(); pause.click(); await f.resumeEntered.promise;
      const beforeAcquisitions = acquisitions, beforeEffects = f.sdk.effects.length;
      if (hold === 'server Pause') f.element.receive({ seq: 1, type: 'session.paused', data: { paused: true } });
      else {
        hidden = true;
        document.dispatchEvent(new window.Event('visibilitychange'));
      }
      // The superseded Resume completes on the server, then its compensating Pause
      // completes over HTTP before either durable echo is delivered to the UI.
      f.resumeAck.resolve(); await flush();
      const resumes = f.requests.filter(request => request.url.endsWith('/resume'));
      const pauses = f.requests.filter(request => request.url.endsWith('/pause'));
      assert.equal(resumes.length, 1); assert.equal(resumes[0].completed, true);
      assert.equal(pauses.length, 2); assert.ok(pauses.every(request => request.completed));
      hidden = false;
      let seq = f.element.session.seq;
      f.element.receive({ seq: ++seq, type: 'session.paused',
        data: { paused: false, resumeRequestId: resumes[0].body.resumeRequestId } });
      f.element.receive({ seq: ++seq, type: 'session.paused',
        data: { paused: true, pauseRequestId: pauses[1].body.pauseRequestId } });
      await flush();
      assert.deepEqual({ getUserMedia: acquisitions - beforeAcquisitions,
        unmuted: f.sdk.effects.slice(beforeEffects).filter(([name, volume]) => name === 'setVolume' && volume > 0),
        state: root.dataset.state, paused: f.element.session.paused, lifecycle: f.returned[0].lifecycle.state.state,
        resumes: f.requests.filter(request => request.url.endsWith('/resume')).length },
      { getUserMedia: 0, unmuted: [], state: 'paused', paused: true, lifecycle: 'paused', resumes: 1 });
      assert.ok(f.sdk.acquired.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
      const outgoing = f.sdk.outgoing.length; f.sdk.sample({ buffered: true });
      assert.equal(f.sdk.outgoing.length, outgoing, 'held capture cannot send queued audio');
      // A fresh visitor action is the only operation that may lift the hold.
      pause.click(); await flush();
      assert.equal(f.requests.filter(request => request.url.endsWith('/resume')).length, 2);
      assert.ok(acquisitions > beforeAcquisitions);
      assert.equal(root.dataset.state, 'listening'); assert.equal(f.element.session.paused, false);
      assert.equal(f.returned[0].lifecycle.state.state, 'active');
      assert.deepEqual(f.sdk.effects.filter(([name]) => name === 'setVolume').at(-1), ['setVolume', 1]);
    });
  }

  test(`AIT-138 fix 3: ${transport} fast visitor Resume Pause Resume settles on the last click despite delayed echoes`, async t => {
    const f = fixture(t, { transport, restored: false, component: true });
    let acquisitions = 0; f.sdk.beforeAcquire = () => { acquisitions++; };
    const pause = f.root.querySelector('.pause'), root = f.root.querySelector('.audio-rail');
    f.root.querySelector('.voice-start').click(); await flush(); pause.click(); await flush();
    const beforeAcquisitions = acquisitions;
    pause.click(); await f.resumeEntered.promise;
    assert.equal(pause.disabled, false, 'a pending Resume can be superseded by a visitor Pause');
    assert.equal(pause.title, en.pause, 'the visible action follows the pending Resume intent');
    pause.click(); assert.equal(pause.title, en.resume);
    pause.click(); assert.equal(pause.title, en.pause);
    f.resumeAck.resolve(); await flush();
    const resumes = f.requests.filter(request => request.url.endsWith('/resume'));
    const pauses = f.requests.filter(request => request.url.endsWith('/pause'));
    assert.equal(resumes.length, 2); assert.ok(resumes.every(request => request.completed));
    assert.equal(pauses.length, 2); assert.ok(pauses.every(request => request.completed));
    assert.equal(acquisitions - beforeAcquisitions, 1, 'only the last explicit Resume reacquires capture');
    let seq = f.element.session.seq;
    for (const data of [{ paused: false, resumeRequestId: resumes[0].body.resumeRequestId },
      { paused: true, pauseRequestId: pauses[1].body.pauseRequestId },
      { paused: false, resumeRequestId: resumes[1].body.resumeRequestId }]) {
      f.element.receive({ seq: ++seq, type: 'session.paused', data });
    }
    await flush();
    assert.equal(f.requests.filter(request => request.url.endsWith('/resume')).length, 2);
    assert.equal(f.requests.filter(request => request.url.endsWith('/pause')).length, 2);
    assert.equal(acquisitions - beforeAcquisitions, 1);
    assert.equal(root.dataset.state, 'listening'); assert.equal(f.element.session.paused, false);
    assert.equal(f.returned[0].lifecycle.state.state, 'active');
    assert.deepEqual(f.sdk.effects.filter(([name]) => name === 'setVolume').at(-1), ['setVolume', 1]);
  });

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
