import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { PluginRegistry, createMockReasoning } from '@inspr/aithema-core';
import { SQLiteStorage, createHandlers, createPluginRuntime, createVoiceProvider,
  createFacadeSecrets, mockPresets } from '../src/index.js';
import { createElevenLabsClient } from '../../../plugins/elevenlabs/src/client.js';
import { fakeSdk } from '../../../plugins/elevenlabs/test/fixtures.js';
import { createVoiceControl } from '../../ui/src/voice-control.js';
import { AudioRail } from '../../ui/src/audio-rail.js';
import { styles } from '../../ui/src/styles.js';
import { en } from '../../ui/src/i18n/en.js';
import { eventProbe } from '../../../test/voice-test-events.js';

test('AIT-382 / START-416: transport close, Pause, Resume, late settlement and a competing tab', { timeout: 10_000 }, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100_000 });
  const h = fixture(), window = new Window(), document = window.document;
  const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
  const root = document.createElement('div'); root.className = 'audio-rail'; document.body.append(root);
  const requests = [], notices = eventProbe(), renders = eventProbe();
  let rail;
  const subscription = new AbortController();
  t.after(async () => {
    h.settlement.resolve();
    subscription.abort();
    await rail?.close(); rail?.destroy();
    await h.handlers.close(); h.storage.close();
    await window.happyDOM.close();
  });

  // Aithema's POST /voice and /recover are its agent-token admission boundary.
  // Every browser request goes through the real HTTP handler, without a socket.
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(url, 'http://fixture.test');
    assert.equal(parsed.origin, 'http://fixture.test');
    const body = JSON.parse(options.body);
    const response = await h.handlers.handle(new Request(parsed, options));
    requests.push({ path: parsed.pathname, body, status: response.status, value: await response.clone().json() });
    return response;
  });
  const { control, persistEvent } = createVoiceControl({ sessionId: h.session.id, sessionToken: h.owner });
  const sdk = fakeSdk();
  // RTCPeerConnection.close() is represented at the SDK's transport boundary.
  // Its disconnect notification is asynchronous: Pause can latch before delivery.
  sdk.beforeCreated = (conversation, callbacks) => {
    let closed = false;
    conversation.connection.close = () => {
      if (closed) return;
      closed = true;
      queueMicrotask(() => callbacks.onDisconnect({ reason: 'error', context: { type: 'transport_error' } }));
    };
  };
  const client = createElevenLabsClient({ control, persistEvent, sdk, document,
    mediaDevices: sdk.mediaDevices, AudioContext: sdk.AudioContext });
  rail = new AudioRail({ root, client, copy: en, context: () => ({}), feature: () => ({ available: true }),
    onRender: () => renders.record(root.dataset.state) });
  const response = await h.handlers.handle(new Request(`http://fixture.test/api/sessions/${h.session.id}/events`, {
    headers: { 'x-aithema-session-token': h.owner }, signal: subscription.signal }));
  assert.equal(response.status, 200);
  const consuming = consumeEvents(response, event => {
    if (event.type === 'voice.state') rail.receiveState(event.data);
    if (event.type === 'session.paused') rail.syncPause(event.data.paused, event.data.pauseRequestId, event.data.resumeRequestId);
    notices.record(event);
  });
  t.after(() => consuming);

  const liveControls = () => {
    assert.equal(root.dataset.call, 'active');
    assert.equal(root.dataset.state, 'listening');
    assert.equal(root.hasAttribute('data-call-reconciling'), false);
    for (const name of ['pause', 'input', 'output', 'close']) {
      const button = rail.button(name), computed = window.getComputedStyle(button);
      assert.equal(button.disabled, false, `${name} stays usable`);
      assert.equal(button.hidden, false);
      assert.notEqual(computed.display, 'none');
      assert.equal(computed.visibility, 'visible', `${name} stays visible under the real rail stylesheet`);
    }
    assert.equal(rail.button('pause').title, en.pause);
    assert.equal(rail.button('pause').getAttribute('aria-pressed'), 'false');
  };
  await rail.start(); liveControls();
  renders.events.length = 0;
  const first = rail.session, callId = first.callId, oldId = first.providerSessionId;
  const epoch = first.epoch;
  assert.equal(h.storage.voiceLifecycle(h.session.id).state, 'active');
  t.mock.timers.tick(1000);

  sdk.conversations[0].connection.close();
  await rail.pause(true);
  assert.equal(h.storage.get(h.session.id).paused, true);
  assert.equal(first.lifecycle.state.needsRecovery, true);
  assert.equal(root.dataset.state, 'paused', 'transport loss retains the logical call instead of going idle');
  assert.equal(rail.button('pause').title, en.resume);
  assert.equal(rail.button('pause').disabled, false);
  assert.equal(h.mints.length, 1, 'Pause prevents automatic transport replacement');

  await rail.pause(false);
  await h.closureEntered.promise;
  liveControls();
  const resumedId = first.providerSessionId;
  assert.notEqual(resumedId, oldId);
  assert.equal(rail.session, first, 'Resume retains the logical client session');
  assert.equal(first.callId, callId); assert.equal(first.epoch, epoch);
  assert.equal(h.storage.get(h.session.id).paused, false);
  assert.equal(h.storage.voiceLifecycle(h.session.id).providerSessionId, resumedId);
  assert.equal(h.storage.voiceLifecycle(h.session.id).state, 'active');
  assert.equal(h.storage.voiceCalls(h.session.id).find(row => row.providerSessionId === oldId).terminal, undefined,
    'replacement is live while predecessor settlement is still deferred');
  const recoveries = requests.filter(request => request.path.endsWith('/recover'));
  assert.equal(recoveries.length, 1, 'Resume needs one admission POST, without a 409 retry loop');
  assert.equal(recoveries[0].body.explicit, true);
  assert.equal(recoveries[0].status, 200);
  assert.equal(requests.filter(request => request.path.endsWith('/resume')).length, 1);
  assert.equal(requests.some(request => request.status === 409), false);
  assert.deepEqual(h.mints, [oldId, resumedId]);

  const afterResume = notices.events.length;
  t.mock.timers.tick(1000);
  h.settlement.resolve();
  await h.handlers.idle();
  // Drain queued stream delivery without advancing the clock or sleeping.
  await new Promise(resolve => setImmediate(resolve));
  const old = h.storage.voiceCalls(h.session.id).find(row => row.providerSessionId === oldId);
  assert.equal(old.terminal.closureConfirmed, true, 'the old call really settled');
  const logical = h.storage.voiceLifecycle(h.session.id);
  assert.equal(logical.segments[oldId].closureConfirmed, true);
  assert.equal(logical.segments[resumedId].closureConfirmed, false);
  assert.equal(logical.providerSessionId, resumedId); assert.equal(logical.state, 'active');
  assert.equal(logical.controllingTabId, control.tabId); assert.equal(logical.epoch, epoch);
  assert.equal(notices.events.slice(afterResume).some(event => event.type === 'voice.state' &&
    event.data.providerSessionId === oldId), false, 'late settlement never publishes over its successor');
  liveControls();

  const second = createVoiceControl({ sessionId: h.session.id, sessionToken: h.owner }).control;
  assert.notEqual(second.tabId, control.tabId);
  await assert.rejects(second.start({ callId: 'competing-tab-call' }), error => {
    assert.equal(error.status, 409); assert.equal(error.code, 'voice-ownership-lost'); return true;
  });
  await assert.rejects(second.recover({ callId, providerSessionId: resumedId, epoch, explicit: true }), error => {
    assert.equal(error.status, 409); assert.equal(error.code, 'voice-ownership-lost'); return true;
  });
  assert.deepEqual(h.mints, [oldId, resumedId], 'the second tab never obtains a provider credential');
  assert.equal(h.storage.voiceLifecycle(h.session.id).controllingTabId, control.tabId);
  assert.equal(h.storage.voiceLifecycle(h.session.id).providerSessionId, resumedId);
  assert.equal((await first.heartbeat()).acknowledged, true, 'old settlement did not remove the successor entry');
  await rail.pause(true); assert.equal(h.storage.get(h.session.id).paused, true);
  await rail.pause(false); liveControls();
  assert.equal(sdk.conversations.length, 2, 'the first tab still controls the same resumed transport');
  assert.equal(renders.events.includes('idle'), false, 'the journey never loses live controls to idle');
});

async function consumeEvents(response, receive) {
  const decoder = new TextDecoder(); let pending = '';
  for await (const bytes of response.body) {
    pending += decoder.decode(bytes, { stream: true });
    let end;
    while ((end = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, end); pending = pending.slice(end + 2);
      const data = frame.split('\n').find(line => line.startsWith('data:'));
      if (data) receive(JSON.parse(data.slice(5)));
    }
  }
}

function fixture() {
  const storage = new SQLiteStorage(), secrets = createFacadeSecrets(), now = () => Date.now();
  const settlement = Promise.withResolvers(), closureEntered = Promise.withResolvers(), mints = [];
  const opened = new Map();
  const binding = { plugin: 'elevenlabs', model: 'fixture-agent', agentId: 'fixture-agent', effort: 'none',
    endpoint: 'https://provider.test', accountRef: 'fixture', secretRef: 'fixture-ref', maxMicro: 60_000,
    maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds: 60, minRunwaySeconds: 1,
    upstreamMicroPerMinute: 60_000, visitorMicroPerMinute: 120_000, publicFacadeBaseUrl: 'https://facade.test' };
  binding.legal = { approved: true, countries: ['AT'], training: false, retention: 'fixture', purpose: 'conversation',
    recipient: 'fixture', processors: [], dataCategories: ['conversation'], consentVersion: 1,
    evidence: { qualified: true, accountRef: binding.accountRef, secretRef: binding.secretRef,
      model: binding.model, endpoint: binding.endpoint, routing: {}, verifiedAt: now() - 1000, expiresAt: now() + 100_000 } };
  const plugin = createVoiceProvider({ storage, now, binding: { agentId: binding.agentId, secretRef: binding.secretRef,
    apiBaseUrl: binding.endpoint, upstreamMicroPerMinute: binding.upstreamMicroPerMinute,
    visitorMicroPerMinute: binding.visitorMicroPerMinute },
    resolveSecret: () => 'offline-fixture', revokeFacade: secrets.revoke,
    requestProviderClose: () => {}, provisionFacade: async () => {}, closureTimeoutMs: 30_000,
    fetchImpl: async input => {
      const url = new URL(input); assert.equal(url.origin, binding.endpoint);
      if (url.pathname.endsWith('/token')) {
        const id = `provider-${mints.length + 1}`; mints.push(id); opened.set(id, now());
        return Response.json({ token: `fixture-token-${id}`, conversation_id: id });
      }
      const id = url.pathname.split('/').at(-1); assert.ok(opened.has(id));
      if (id === mints[0]) { closureEntered.resolve(); await settlement.promise; }
      return Response.json({ conversation_id: id, status: 'done', metadata: {
        start_time_unix_secs: opened.get(id) / 1000, call_duration_secs: (now() - opened.get(id)) / 1000, cost: 7 } });
    } });
  const presets = mockPresets();
  presets.best.plugins.push('elevenlabs'); presets.best.bindings.voice = binding;
  presets.best.policy = { endpoints: [binding.endpoint] };
  const consent = { async coverage({ scope, consentRevision }) {
    return { covered: true, ...scope, scope, consentRevision, checkedAt: now(), expiresAt: now() + 100_000 };
  } };
  const registry = new PluginRegistry().register(createMockReasoning()).register(plugin);
  const runtime = createPluginRuntime({ storage, registry, presets, consent, now });
  const handlers = createHandlers({ storage, pluginRuntime: runtime, consent, voice: { secrets, now } });
  const owner = 'offline-owner', session = storage.create({ ownerToken: owner, demo: true });
  return { storage, handlers, owner, session, settlement, closureEntered, mints };
}
