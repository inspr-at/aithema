import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { AudioRail } from '../src/audio-rail.js';
import { en } from '../src/i18n/en.js';
import { createElevenLabsClient } from '../../../plugins/elevenlabs/src/client.js';
import { fakeSdk } from '../../../plugins/elevenlabs/test/fixtures.js';

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const lost = () => Object.assign(new Error('Retired epoch'), { status: 409, code: 'voice-ownership-lost' });

// Two independent documents and SDK media ports; every command checks the
// server identity. The browser matrix separately exercises the real server.
function tabsFixture(t, transport) {
  const tabs = [], commands = [], published = [];
  let state, mint = 0;
  const snapshot = () => ({ ...state });
  const broadcast = () => tabs.forEach(tab => tab.rail.receiveState(snapshot()));
  const check = (tab, identity) => {
    if (identity.epoch !== state.epoch || tab.id !== state.controllingTabId) throw lost();
  };
  const receipt = () => ({ ...state, credential: { providerSessionId: state.providerSessionId, ttlMs: 60_000,
    connectionType: transport, ...(transport === 'websocket'
      ? { signedUrl: `wss://socket.example.test/call?conversation_id=${state.providerSessionId}` }
      : { conversationToken: `fixture-token-${state.providerSessionId}` }) },
    spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 30_000 });
  for (const id of ['A', 'B']) {
    const window = new Window(), root = window.document.createElement('div'); window.document.body.append(root);
    const sdk = fakeSdk(), tab = { id, sdk, returned: [] }; tabs.push(tab);
    const record = (name, identity) => commands.push({ tab: id, name, ...identity });
    const control = { tabId: id,
      async start(request) {
        record('start', request);
        state = { callId: request.callId, providerSessionId: `provider-${++mint}`, epoch: 1,
          controllingTabId: id, state: 'active', needsRecovery: false };
        broadcast(); return receipt();
      },
      async takeover(identity) {
        record('takeover', identity);
        assert.equal(identity.explicit, true, 'the button is explicit visitor intent');
        if (identity.epoch !== state.epoch) throw lost();
        state = { ...state, epoch: state.epoch + 1, controllingTabId: id, state: 'waiting', needsRecovery: true };
        broadcast(); const held = snapshot(); await tab.takeoverAck?.promise; return held;
      },
      async recover(identity) {
        record('recover', identity); check(tab, identity); assert.equal(identity.explicit, true);
        state = { ...state, providerSessionId: `provider-${++mint}`, state: 'paused', needsRecovery: false };
        broadcast(); return { ...receipt(), overrides: { agent: { firstMessage: '', language: 'en' } } };
      },
      async pause(identity) { record('pause', identity); check(tab, identity); return { acknowledged: true, paused: true }; },
      async resume(identity) {
        record('resume', identity); check(tab, identity);
        state = { ...state, state: 'active' }; broadcast();
        tab.resumeEntered?.resolve(); await tab.resumeAck?.promise;
        // Deliberately deliver a successful late receipt: media still has to
        // honour the synchronous ownership fence, independent of HTTP status.
        return { acknowledged: true, paused: false };
      },
      async heartbeat(identity) { check(tab, identity); return { acknowledged: true, browserLivenessDeadlineAt: Date.now() + 30_000 }; },
      async close(identity) {
        record('close', identity); check(tab, identity);
        state = { ...state, state: 'ended' }; return { closureConfirmed: true, usage: { costEstimated: false } };
      },
    };
    const client = createElevenLabsClient({ sdk, control, document: window.document,
      mediaDevices: sdk.mediaDevices, AudioContext: sdk.AudioContext,
      persistEvent: async event => { check(tab, event); published.push({ tab: id, ...event }); } });
    const start = client.start;
    client.start = async (...args) => { const session = await start(...args); tab.returned.push(session); return session; };
    tab.rail = new AudioRail({ root, copy: en, client, feature: () => ({ available: true }), context: () => ({}) });
    tab.root = root;
    t.after(async () => {
      tab.resumeAck?.resolve(); tab.takeoverAck?.resolve(); await flush();
      await tab.rail.close(); tab.rail.destroy();
      await Promise.allSettled(tab.returned.map(session => session.close()));
      await window.happyDOM.close();
    });
  }
  const [a, b] = tabs;
  const newcomer = async () => {
    await a.rail.start(); await b.rail.start(); await b.rail.start(); await flush();
    assert.equal(b.root.dataset.state, 'listening'); assert.equal(a.root.dataset.state, 'waiting');
  };
  const held = tab => {
    assert.equal(tab.root.dataset.state, 'waiting'); assert.equal(tab.root.querySelector('.voice-state').textContent, en.voiceMoved);
    assert.equal(tab.rail.button('pause').disabled, false); assert.equal(tab.rail.button('pause').title, en.voiceTakeover);
    assert.ok(tab.sdk.acquired.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
    assert.equal(tab.sdk.effects.filter(([name]) => name === 'setVolume').at(-1)[1], 0);
    const outgoing = tab.sdk.outgoing.length; tab.sdk.sample({ buffered: true }); assert.equal(tab.sdk.outgoing.length, outgoing);
  };
  return { a, b, commands, published, snapshot, newcomer, held };
}

for (const transport of ['webrtc', 'websocket']) {
  test(`AIT-138 d takeback: ${transport} one old-tab click takes over and resumes without double confirmation`, { timeout: 10_000 }, async t => {
    const f = tabsFixture(t, transport); await f.newcomer();
    const before = f.snapshot(), commands = f.commands.length;
    f.a.rail.button('pause').click(); await flush();
    assert.equal(f.snapshot().epoch, before.epoch + 1, 'one old-tab click must advance the server epoch');
    assert.equal(f.snapshot().controllingTabId, 'A'); assert.equal(f.a.root.dataset.state, 'listening'); f.held(f.b);
    assert.deepEqual(f.commands.slice(commands).filter(c => c.tab === 'A' && ['takeover', 'recover', 'resume'].includes(c.name)).map(c => c.name),
      ['takeover', 'recover', 'resume'], 'one click performs exactly one explicit takeover and one Resume');
    assert.ok(f.a.sdk.acquired.some(stream => stream.getTracks().some(track => track.readyState === 'live')));
  });

  test(`AIT-138 d takeback: ${transport} rapid A B A B ping-pong refuses stale states, commands and callbacks`, { timeout: 10_000 }, async t => {
    const f = tabsFixture(t, transport); await f.newcomer();
    const stale = [];
    for (const [winner, loser] of [[f.a, f.b], [f.b, f.a], [f.a, f.b], [f.b, f.a]]) {
      stale.push({ state: f.snapshot(), session: loser.returned.at(-1), sdk: loser.sdk.starts.at(-1) });
      winner.rail.button('pause').click(); await flush();
      assert.equal(f.snapshot().epoch, stale.at(-1).state.epoch + 1); assert.equal(f.snapshot().controllingTabId, winner.id);
      assert.equal(winner.root.dataset.state, 'listening'); f.held(loser);
      const publications = f.published.length;
      for (const old of stale) {
        winner.rail.receiveState(old.state); loser.rail.receiveState(old.state);
        old.sdk.onMessage({ role: 'user', message: 'retired callback', event_id: 99 });
        await assert.rejects(old.session.resume()); await assert.rejects(old.session.sendText('retired command'));
      }
      assert.equal(winner.rail.syncPause(false, undefined, 'retired-resume'), false, 'stale echoes cannot create Resume intent');
      await flush(); assert.equal(f.published.length, publications); assert.equal(winner.root.dataset.state, 'listening'); f.held(loser);
    }
  });

  test(`AIT-138 d takeback: ${transport} old-tab click while the other tab is mid-startup fences its late Resume receipt`, { timeout: 10_000 }, async t => {
    const f = tabsFixture(t, transport);
    await f.a.rail.start(); await f.b.rail.start();
    f.b.resumeEntered = Promise.withResolvers(); f.b.resumeAck = Promise.withResolvers();
    const startup = f.b.rail.start(); await f.b.resumeEntered.promise; await flush();
    const before = f.snapshot(); f.a.rail.button('pause').click(); await flush();
    assert.equal(f.snapshot().epoch, before.epoch + 1); assert.equal(f.snapshot().controllingTabId, 'A');
    assert.equal(f.a.root.dataset.state, 'listening'); f.held(f.b);
    const unmuted = f.b.sdk.effects.filter(([name, volume]) => name === 'setVolume' && volume > 0).length;
    f.b.resumeAck.resolve(); await startup; await flush();
    f.held(f.b); assert.equal(f.b.returned.length, 0, 'retired startup cannot return a live session');
    assert.equal(f.b.sdk.effects.filter(([name, volume]) => name === 'setVolume' && volume > 0).length, unmuted);
    assert.equal(f.b.sdk.acquired.length, 0, 'late Resume cannot acquire a microphone');
    assert.equal(f.a.root.dataset.state, 'listening');
  });

  test(`AIT-138 d takeback: ${transport} a delayed takeover receipt cannot reclaim a newer epoch`, { timeout: 10_000 }, async t => {
    const f = tabsFixture(t, transport); await f.newcomer();
    f.a.takeoverAck = Promise.withResolvers(); f.a.rail.button('pause').click(); await flush();
    assert.equal(f.snapshot().controllingTabId, 'A'); assert.equal(f.snapshot().epoch, 3);
    f.b.rail.button('pause').click(); await flush();
    assert.equal(f.snapshot().controllingTabId, 'B'); assert.equal(f.snapshot().epoch, 4);
    f.a.takeoverAck.resolve(); await flush();
    assert.equal(f.a.root.dataset.state, 'waiting'); f.held(f.a); assert.equal(f.b.root.dataset.state, 'listening');
    assert.ok(!f.commands.some(c => c.tab === 'A' && c.name === 'recover' && c.epoch === 3), 'late takeover receipt cannot start stale recovery');
  });
}
