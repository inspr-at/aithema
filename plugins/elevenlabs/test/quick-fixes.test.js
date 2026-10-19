import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElevenLabsClient } from '../src/client.js';
import { fakeSdk, flush } from './fixtures.js';

const deferred = () => Promise.withResolvers();
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Expected progress within 500 ms');
}
async function setup(t, { sdk = fakeSdk(), transport = 'webrtc', persistEvent = async () => {}, ...settings } = {}) {
  const closed = [], pauses = [], resumes = []; let generation = 0;
  const receipt = ({ callId }) => {
    const providerSessionId = `conv_${++generation}`;
    return { callId, providerSessionId,
      credential: { providerSessionId, connectionType: transport, ttlMs: 60_000,
        ...(transport === 'webrtc' ? { conversationToken: `fixture-token-${providerSessionId}` }
          : { signedUrl: `wss://socket.example.test/call?conversation_id=${providerSessionId}` }) },
      spendDeadlineAt: Date.now() + 10_000, browserLivenessDeadlineAt: Date.now() + 10_000 };
  };
  const control = {
    start: async request => receipt(request), recover: async request => receipt(request),
    close: async identity => { closed.push(identity); return { closureConfirmed: true }; },
    pause: async identity => { pauses.push(identity); return { acknowledged: true, paused: true }; },
    resume: async identity => { resumes.push(identity); return { acknowledged: true, paused: false }; },
    heartbeat: async () => ({ acknowledged: true, browserLivenessDeadlineAt: Date.now() + 10_000 }),
  };
  const client = createElevenLabsClient({ sdk, control, persistEvent, closeTimeoutMs: 150,
    mediaDevices: sdk.mediaDevices, AudioContext: sdk.AudioContext,
    persistenceTimeoutMs: 20, persistenceRetries: 2, persistenceBackoffMs: 5, drainTimeoutMs: 100, ...settings });
  const session = await client.start({ callId: 'call_quick_fix' });
  const observed = [], reader = (async () => { for await (const event of session.events) observed.push(event); })();
  t.after(async () => { await session.close().catch(() => {}); await reader; });
  return { session, sdk, control, closed, pauses, resumes, observed, reader };
}
const message = (sdk, id) => sdk.starts.at(-1).onMessage({ role: 'user', message: `message ${id}`, event_id: id });
const channelEffects = sdk => sdk.effects.filter(([name]) => ['setInputMuted', 'setVolume'].includes(name));

test('AIT-138: heartbeat during recovery joins the replacement instead of closing the logical call', async t => {
  const local = await setup(t), ready = deferred(), recover = local.control.recover;
  local.control.recover = async (...args) => { await ready.promise; return recover(...args); };
  local.sdk.starts[0].onDisconnect(); await until(() => local.closed.length === 1);
  const beat = local.session.heartbeat().then(value => value, error => error);
  try { await flush(); } finally { ready.resolve(); }
  const result = await beat;
  assert.equal(result.acknowledged, true);
  assert.equal(local.closed.some(call => call.reason === 'closed' || call.reason === 'recovery-failed'), false);
  assert.equal(local.session.callId, 'call_quick_fix');
});

test('AIT-138: exhaustion stops media and waits; explicit Resume gets a fresh per-outage allowance', async t => {
  const local = await setup(t), recover = local.control.recover; let attempts = 0;
  local.control.recover = async (...args) => { if (++attempts <= 3) throw new Error('outage'); return recover(...args); };
  local.sdk.starts[0].onDisconnect();
  await until(() => local.observed.some(event => event.type === 'waiting'));
  assert.equal(local.session.lifecycle.state.state, 'waiting'); assert.equal(attempts, 3);
  assert.ok(local.sdk.acquired.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
  await local.session.resume();
  await until(() => local.observed.some(event => event.type === 'recovered'));
  assert.equal(local.session.lifecycle.state.state, 'active'); assert.equal(attempts, 4);
});

test('AIT-138: tentative speech at cutover stays unconfirmed without a fabricated final', async t => {
  const local = await setup(t);
  local.sdk.starts[0].onDebug({ type: 'tentative_user_transcript', tentative_user_transcription_event: { user_transcript: 'still tentative' } });
  local.sdk.starts[0].onDisconnect();
  await until(() => local.observed.some(event => event.type === 'recovered'));
  assert.equal(local.session.lifecycle.state.checkpoint.userUnconfirmed, true);
  assert.equal(local.observed.some(event => event.type === 'final'), false);
});

test('AIT-138: a persisted final whose acknowledgement arrives during cutover is confirmed exactly once', async t => {
  const ack = deferred(), entered = deferred(), local = await setup(t, { persistEvent: async event => {
    if (event.type === 'final') { entered.resolve(); await ack.promise; }
  }, persistenceTimeoutMs: 1000, drainTimeoutMs: 1500 });
  local.sdk.starts[0].onDebug({ type: 'tentative_user_transcript', tentative_user_transcription_event: { user_transcript: 'message' } });
  message(local.sdk, 1); await entered.promise; local.sdk.starts[0].onDisconnect();
  ack.resolve(); await until(() => local.observed.some(event => event.type === 'recovered'));
  const checkpoint = local.session.lifecycle.state.checkpoint;
  assert.equal(checkpoint.userUnconfirmed, false); assert.deepEqual(checkpoint.acceptedTurnIds, ['conv_1:user:1']);
  assert.equal(local.observed.filter(event => event.type === 'final').length, 1);
});

test('AIT-138: playback cutover retains only an evidenced prefix and discards old queued/late audio', async t => {
  const local = await setup(t, { transport: 'websocket' }), original = local.sdk.starts[0];
  original.onMessage({ role: 'agent', message: 'Known reply with a remainder.', event_id: 2 }); await flush();
  original.onAgentResponseCorrection({ event_id: 2, original_agent_response: 'Known reply with a remainder.', corrected_agent_response: 'Known reply' }); await flush();
  original.onDisconnect(); await until(() => local.observed.some(event => event.type === 'recovered'));
  const checkpoint = local.session.lifecycle.state.checkpoint;
  assert.equal(checkpoint.deliveryUncertain, true); assert.equal(checkpoint.heardPrefix, 'Known reply');
  original.onMessage({ role: 'agent', message: 'late old reply', event_id: 3 }); await flush();
  assert.equal(local.observed.some(event => event.text === 'late old reply'), false);
});

test('AIT-138: a late old-generation heartbeat acknowledgement cannot extend the successor lease', async t => {
  const local = await setup(t), ack = deferred(), entered = deferred();
  local.control.heartbeat = async () => { entered.resolve(); return ack.promise; };
  const beat = local.session.heartbeat(); await entered.promise;
  local.sdk.starts[0].onDisconnect(); await until(() => local.observed.some(event => event.type === 'recovered'));
  const deadline = local.session.lifecycle.state.browserLivenessDeadlineAt;
  ack.resolve({ acknowledged: true, browserLivenessDeadlineAt: Date.now() + 999_000 });
  assert.equal((await beat).stale, true);
  assert.equal(local.session.lifecycle.state.browserLivenessDeadlineAt, deadline);
});

test('AIT-138: explicit provider end_call is terminal; diagnostic disconnect reasons recover', async t => {
  const local = await setup(t); let recoveries = 0;
  local.control.recover = async () => { recoveries++; throw new Error('unexpected recovery'); };
  local.sdk.starts[0].onDisconnect({ reason: 'agent', context: { type: 'end_call' } }); await local.reader;
  assert.equal(local.session.lifecycle.state.state, 'ended'); assert.equal(recoveries, 0);
  assert.equal(local.closed.at(-1).reason, 'provider-end');
});

for (const transport of ['webrtc', 'websocket']) test(`AIT-138: ${transport} unmute finishing after replacement cannot restore old capture or playback`, async t => {
  const local = await setup(t, { transport }), old = local.sdk.conversations[0], entered = deferred(), release = deferred();
  const setMuted = old.input.setMuted, setVolume = old.setVolume, oldVolumes = [];
  old.setVolume = value => { oldVolumes.push(value.volume); return setVolume(value); };
  old.input.setMuted = async value => {
    if (!value) { entered.resolve(); await release.promise; }
    return setMuted(value);
  };
  t.after(() => release.resolve());
  const changing = local.session.setInput(true).catch(error => error.code); await entered.promise;
  local.sdk.starts[0].onDisconnect(); await until(() => local.observed.some(event => event.type === 'recovered'));
  release.resolve(); await changing;
  assert.equal(oldVolumes.at(-1), 0);
  assert.ok(old.track.readyState === 'ended' || old.track.source === 'silence', 'a retired generation cannot reacquire a physical microphone');
  assert.equal(local.session.lifecycle.state.state, 'active');
});

test('AIT-136 pause mutes capture immediately before the HTTP acknowledgement', async t => {
  const local = await setup(t), ack = deferred();
  local.control.pause = () => ack.promise;
  const pending = local.session.pause();
  try {
    assert.deepEqual(channelEffects(local.sdk).slice(-2), [['setInputMuted', true], ['setVolume', 0]]);
    await flush(); assert.equal(local.sdk.closed, false);
  } finally { ack.resolve({ acknowledged: true, paused: true }); await pending; }
});

test('AIT-136 a refused pause stays muted; only an acknowledged resume unmutes', async t => {
  const local = await setup(t);
  local.control.pause = async () => { throw new Error('HTTP pause failed'); };
  await assert.rejects(local.session.pause());
  assert.deepEqual(channelEffects(local.sdk).slice(-2), [['setInputMuted', true], ['setVolume', 0]]);
  await local.session.setInput(true);
  assert.equal(channelEffects(local.sdk).filter(([name]) => name === 'setInputMuted').at(-1)[1], true);
  local.control.resume = async () => ({ acknowledged: false, paused: false });
  await assert.rejects(local.session.resume());
  assert.equal(channelEffects(local.sdk).filter(([name]) => name === 'setInputMuted').at(-1)[1], true);
  const ack = deferred(); local.control.resume = () => ack.promise;
  const pending = local.session.resume(); await flush();
  assert.equal(channelEffects(local.sdk).filter(([name]) => name === 'setInputMuted').at(-1)[1], true);
  ack.resolve({ acknowledged: true, paused: false }); await pending;
  assert.deepEqual(channelEffects(local.sdk).slice(-2), [['setInputMuted', false], ['setVolume', 1]]);
});

test('AIT-136 SDK asynchronous mute error ends capture and transport without acknowledging pause', async t => {
  const sdk = fakeSdk();
  const local = await setup(t, { sdk });
  sdk.muteHook = async muted => { if (muted) throw new Error('fixture mute failure'); };
  await assert.rejects(local.session.pause()); await local.reader;
  assert.equal(sdk.closed, true);
  assert.ok(sdk.effects.some(([name]) => name === 'endSession'));
  assert.equal(local.closed.at(-1).reason, 'pause-failed');
  assert.deepEqual(local.pauses, []);
});

test('AIT-136 pause during recovery survives into the replacement before onConnect', async t => {
  const sdk = fakeSdk(), start = sdk.startSession, atConnect = [];
  sdk.startSession = options => start({ ...options, onConnect: identity => {
    atConnect.push(channelEffects(sdk).filter(([name]) => name === 'setInputMuted').at(-1)?.[1]);
    options.onConnect(identity);
  } });
  const local = await setup(t, { sdk }), ready = deferred(), recover = local.control.recover;
  local.control.recover = async (...args) => { await ready.promise; return recover(...args); };
  sdk.starts[0].onDisconnect(); await until(() => local.closed.length === 1);
  const paused = local.session.pause();
  // Attach the rejection handler before releasing recovery, including on the old implementation.
  const result = paused.then(value => value, error => error);
  try {
    assert.equal(channelEffects(sdk).filter(([name]) => name === 'setInputMuted').at(-1)[1], true);
  } finally { ready.resolve(); }
  assert.deepEqual(await result, { acknowledged: true, paused: true });
  await until(() => local.observed.some(event => event.type === 'recovered'));
  assert.equal(atConnect.at(-1), true);
  assert.equal(local.pauses.at(-1).providerSessionId, local.session.providerSessionId);
  message(sdk, 1); await flush(); assert.equal(local.observed.some(event => event.type === 'final'), false);
  await local.session.resume(); assert.equal(channelEffects(sdk).filter(([name]) => name === 'setInputMuted').at(-1)[1], false);
});

for (const transport of ['webrtc', 'websocket']) {
  test(`AIT-136 ${transport} capture lifetime stops before pause acknowledgement and resumes with a fresh track`, async t => {
    const local = await setup(t, { transport }), ack = deferred(), track = local.sdk.conversations[0].track;
    const acquired = local.sdk.acquired.length; local.control.pause = () => ack.promise;
    local.sdk.outgoing.length = 0;
    const pending = local.session.pause();
    try {
      assert.equal(track.readyState, 'ended', 'pause synchronously releases the microphone');
      local.sdk.sample(); assert.deepEqual(local.sdk.outgoing, []);
    } finally { ack.reject(new Error('HTTP pause refused')); await assert.rejects(pending); }
    await local.session.setInput(true);
    assert.equal(local.sdk.acquired.length, acquired, 'a retained pause cannot reacquire capture');
    const resumeAck = deferred(); local.control.resume = () => resumeAck.promise;
    const resuming = local.session.resume(); await flush();
    try { assert.equal(local.sdk.acquired.length, acquired, 'resume must wait for the server'); }
    finally { resumeAck.resolve({ acknowledged: true, paused: false }); await resuming; }
    assert.notEqual(local.sdk.conversations[0].track, track);
    assert.equal(local.sdk.conversations[0].track.readyState, 'live');
    assert.equal(local.sdk.conversations[0].track.source, 'microphone');
  });

  test(`AIT-136 ${transport} late mute rejection cannot arrive after a successful pause acknowledgement`, async t => {
    const local = await setup(t, { transport }), mute = deferred(); let settled = false;
    local.sdk.muteHook = value => value ? mute.promise : Promise.resolve();
    const pending = local.session.pause().then(value => { settled = true; return value; }, error => { settled = true; return error; });
    try {
      await flush();
      assert.deepEqual(local.pauses, [], 'the HTTP request must wait for the actual mute promise');
      assert.equal(settled, false);
      assert.ok(local.sdk.acquired.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
    } finally { mute.reject(new Error('delayed SDK mute failure')); await pending; }
    await local.reader;
    assert.equal(local.sdk.closed, true); assert.deepEqual(local.pauses, []);
    assert.equal(local.closed.at(-1).reason, 'pause-failed');
  });

  test(`AIT-136 ${transport} actual mute completion precedes the pause request`, async t => {
    const local = await setup(t, { transport }), mute = deferred();
    local.sdk.muteHook = value => value ? mute.promise : Promise.resolve();
    const pending = local.session.pause();
    try { await flush(); assert.deepEqual(local.pauses, []); }
    finally { mute.resolve(); await pending; }
    assert.equal(local.pauses.length, 1);
    assert.equal(local.sdk.conversations[0].track.readyState, 'ended');
  });

  test(`AIT-136 ${transport} retained pause blocks capture and publication before the recovery hook`, async t => {
    const local = await setup(t, { transport }), ready = deferred(), recover = local.control.recover;
    const acquired = local.sdk.acquired.length, beforeHook = [];
    local.control.recover = async (...args) => { await ready.promise; return recover(...args); };
    local.sdk.beforeCreated = object => beforeHook.push({ source: object.track.source, acquired: local.sdk.acquired.length });
    local.sdk.starts[0].onDisconnect(); await until(() => local.closed.length === 1);
    const pending = local.session.pause().then(value => value, error => error);
    local.sdk.outgoing.length = 0; ready.resolve();
    assert.deepEqual(await pending, { acknowledged: true, paused: true });
    await until(() => local.observed.some(event => event.type === 'recovered'));
    assert.deepEqual(beforeHook, [{ source: 'silence', acquired }], 'replacement setup has no microphone stream');
    assert.deepEqual(local.sdk.outgoing, [], 'no captured audio is published before the hook');
    await local.session.resume();
    assert.equal(local.sdk.conversations.at(-1).track.source, 'microphone');
    assert.equal(local.sdk.conversations.at(-1).track.readyState, 'live');
  });

  test(`AIT-136 ${transport} pause stops replacement capture while SDK setup is pending`, async t => {
    const local = await setup(t, { transport }), created = deferred(); let replacement;
    local.sdk.beforeCreated = object => { replacement = object; return created.promise; };
    local.sdk.starts[0].onDisconnect(); await until(() => replacement);
    const pending = local.session.pause().then(value => value, error => error);
    try {
      assert.equal(replacement.track.readyState, 'ended', 'pause reaches streams before a Conversation exists');
      local.sdk.outgoing.length = 0; local.sdk.sample(); assert.deepEqual(local.sdk.outgoing, []);
    } finally { created.resolve(); await pending; }
    assert.ok(local.sdk.acquired.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
  });

  test(`AIT-136 ${transport} a new pause fences a pending resume acquisition`, async t => {
    const local = await setup(t, { transport }), acquired = deferred(); let waiting = false;
    await local.session.pause();
    local.sdk.beforeAcquire = () => { waiting = true; return acquired.promise; };
    const resuming = local.session.resume().then(value => value, error => error);
    await until(() => waiting);
    const pausing = local.session.pause().then(value => value, error => error);
    acquired.resolve(); await resuming; await pausing;
    assert.ok(local.sdk.acquired.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
    local.sdk.outgoing.length = 0; local.sdk.sample(); assert.deepEqual(local.sdk.outgoing, []);
    assert.equal(local.sdk.conversations.at(-1).input.isMuted(), true);
  });
}

test('AIT-136 websocket pause discards buffered audio while actual mute is pending', async t => {
  const local = await setup(t, { transport: 'websocket' }), mute = deferred();
  local.sdk.muteHook = value => value ? mute.promise : Promise.resolve();
  local.sdk.outgoing.length = 0;
  const pending = local.session.pause();
  try { local.sdk.sample({ buffered: true }); assert.deepEqual(local.sdk.outgoing, []); }
  finally { mute.resolve(); await pending; }
});

test('AIT-136 events queued before recovery retain their emission generation and drain before revocation', async t => {
  const held = deferred(), posted = [];
  const local = await setup(t, { persistEvent: async event => {
    if (!posted.length) await held.promise;
    posted.push(event);
  } }), original = local.session.providerSessionId;
  message(local.sdk, 1); message(local.sdk, 2);
  await flush(); local.sdk.starts[0].onDisconnect(); await flush();
  held.resolve(); await until(() => local.observed.some(event => event.type === 'recovered'));
  assert.notEqual(local.session.providerSessionId, original);
  assert.deepEqual(posted.map(event => event.providerSessionId), [original, original]);
  assert.ok(posted.every(event => event.turnId.startsWith(event.providerSessionId + ':')));
});

test('AIT-136 one 5xx retries the same event without ending the call', async t => {
  const attempts = [];
  const local = await setup(t, { persistEvent: async event => {
    attempts.push(event); if (attempts.length === 1) throw Object.assign(new Error('temporary'), { status: 503 });
  } });
  message(local.sdk, 1); await until(() => attempts.length === 2);
  assert.equal(local.sdk.closed, false); assert.deepEqual(local.closed, []);
  assert.equal(attempts[0], attempts[1]);
  await until(() => local.observed.some(event => event.type === 'final'));
});

test('AIT-136 a stalled POST times out and retries in order so later events progress', async t => {
  const attempts = [], aborted = [];
  const local = await setup(t, { persistEvent: (event, options) => {
    attempts.push(event.turnId);
    if (attempts.length === 1) {
      options?.signal?.addEventListener('abort', () => aborted.push(event.turnId), { once: true });
      return new Promise(() => {});
    }
    return Promise.resolve();
  } });
  message(local.sdk, 1); message(local.sdk, 2);
  await until(() => local.observed.filter(event => event.type === 'final').length === 2);
  assert.deepEqual(attempts, ['conv_1:user:1', 'conv_1:user:1', 'conv_1:user:2']);
  assert.deepEqual(aborted, ['conv_1:user:1']); assert.equal(local.sdk.closed, false);
});

test('AIT-136 normal end drains accepted events before control.close revokes them', async t => {
  const held = deferred(), posted = [];
  const local = await setup(t, { persistEvent: async event => { await held.promise; posted.push(event.turnId); } });
  message(local.sdk, 1); message(local.sdk, 2); await flush();
  const closing = local.session.close();
  try {
    await flush(); assert.equal(local.sdk.closed, true);
    assert.deepEqual(local.closed, []);
  } finally { held.resolve(); await closing; }
  assert.deepEqual(posted, ['conv_1:user:1', 'conv_1:user:2']); assert.equal(local.closed.length, 1);
});

test('AIT-136 withdrawal aborts the in-flight POST and discards queued persistence', async t => {
  const held = deferred(), posted = [], signals = [];
  const local = await setup(t, { persistEvent: async (event, options) => {
    posted.push(event.turnId); signals.push(options?.signal); await held.promise;
  } });
  message(local.sdk, 1); message(local.sdk, 2); await flush();
  const closing = local.session.close({ reason: 'turn-withdrawn' });
  try {
    await flush(); assert.equal(signals[0]?.aborted, true);
  } finally { held.resolve(); await closing; }
  assert.deepEqual(posted, ['conv_1:user:1']);
  assert.equal(local.observed.some(event => event.type === 'final'), false);
  message(local.sdk, 3); await flush(); assert.equal(posted.length, 1);
});

test('AIT-136 repeated persistence failure closes after bounded retries; 403 closes without retry', async t => {
  for (const status of [503, 403]) {
    let attempts = 0;
    const local = await setup(t, { persistEvent: async () => { attempts++; throw Object.assign(new Error('refused'), { status }); } });
    message(local.sdk, 1); await local.reader;
    assert.equal(attempts, status === 403 ? 1 : 3);
    assert.equal(local.observed.at(-1).reason, 'transcript-persistence-failed'); assert.equal(local.sdk.closed, true);
  }
});


test('AIT-136 withdrawal during an existing drain cancels pending and queued persistence', async t => {
  const held = deferred(), posted = [], signals = [];
  const local = await setup(t, { persistEvent: async (event, options) => {
    posted.push(event.turnId); signals.push(options?.signal); await held.promise;
  } });
  message(local.sdk, 1); message(local.sdk, 2); await flush();
  const closing = local.session.close(); await flush();
  try {
    assert.equal(local.session.close({ reason: 'turn-withdrawn' }), closing);
    assert.equal(signals[0]?.aborted, true);
  } finally { held.resolve(); await closing; }
  assert.deepEqual(posted, ['conv_1:user:1']); assert.equal(local.observed.some(event => event.type === 'final'), false);
});

for (const transport of ['webrtc', 'websocket']) {
  test(`AIT-379: ${transport} native end_call is immediately terminal, even before disconnect`, async t => {
    const local = await setup(t, { transport }), original = local.sdk.starts[0]; let recoveries = 0;
    local.control.recover = async () => { recoveries++; throw new Error('unexpected recovery'); };
    original.onAgentToolResponse?.({ tool_name: 'end_call', tool_call_id: 'fixture-end-call', result: 'success' });
    assert.equal(local.session.lifecycle.state.state, 'ended');
    original.onError('transport failed', { type: 'transport_error' });
    original.onDisconnect({ reason: 'error', context: { type: 'socket_error' } });
    await local.reader;
    assert.equal(recoveries, 0); assert.equal(local.sdk.starts.length, 1);
    assert.equal(local.closed.length, 1); assert.equal(local.closed[0].reason, 'provider-end');
    assert.deepEqual(local.observed.filter(event => event.type === 'ended').map(event => event.reason), ['provider-end']);
    assert.equal(local.observed.some(event => ['recovering', 'recovered', 'waiting'].includes(event.type)), false);
    assert.ok(local.sdk.acquired.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
    assert.equal(local.sdk.closed, true);
  });
  test(`AIT-379: ${transport} other agent tools leave transport recovery at three tries`, async t => {
    const local = await setup(t, { transport }), original = local.sdk.starts[0]; let recoveries = 0;
    local.control.recover = async () => { recoveries++; throw new Error('fixture transport outage'); };
    original.onAgentToolResponse?.({ tool_name: 'other_tool', result: 'success' });
    assert.equal(local.session.lifecycle.state.state, 'active');
    original.onDisconnect({ reason: 'error', context: { type: 'socket_error' } });
    await until(() => local.observed.some(event => event.type === 'waiting'));
    assert.equal(recoveries, 3); assert.equal(local.session.lifecycle.state.state, 'waiting');
    assert.equal(local.observed.some(event => event.type === 'ended'), false);
  });
}
