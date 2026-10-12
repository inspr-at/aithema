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
async function setup(t, { sdk = fakeSdk(), persistEvent = async () => {}, ...settings } = {}) {
  const closed = [], pauses = [], resumes = []; let generation = 0;
  const receipt = ({ callId }) => {
    const providerSessionId = `conv_${++generation}`;
    return { callId, providerSessionId,
      credential: { providerSessionId, connectionType: 'webrtc', conversationToken: `fixture-token-${providerSessionId}`, ttlMs: 60_000 },
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
    persistenceTimeoutMs: 20, persistenceRetries: 2, persistenceBackoffMs: 5, drainTimeoutMs: 100, ...settings });
  const session = await client.start({ callId: 'call_quick_fix' });
  const observed = [], reader = (async () => { for await (const event of session.events) observed.push(event); })();
  t.after(async () => { await session.close().catch(() => {}); await reader; });
  return { session, sdk, control, closed, pauses, resumes, observed, reader };
}
const message = (sdk, id) => sdk.starts.at(-1).onMessage({ role: 'user', message: `message ${id}`, event_id: id });

test('AIT-136 pause mutes capture immediately before the HTTP acknowledgement', async t => {
  const local = await setup(t), ack = deferred();
  local.control.pause = () => ack.promise;
  const pending = local.session.pause();
  try {
    assert.deepEqual(local.sdk.effects.slice(-2), [['setMicMuted', true], ['setVolume', 0]]);
    await flush(); assert.equal(local.sdk.closed, false);
  } finally { ack.resolve({ acknowledged: true, paused: true }); await pending; }
});

test('AIT-136 a refused pause stays muted; only an acknowledged resume unmutes', async t => {
  const local = await setup(t);
  local.control.pause = async () => { throw new Error('HTTP pause failed'); };
  await assert.rejects(local.session.pause());
  assert.deepEqual(local.sdk.effects.slice(-2), [['setMicMuted', true], ['setVolume', 0]]);
  await local.session.setInput(true);
  assert.equal(local.sdk.effects.filter(([name]) => name === 'setMicMuted').at(-1)[1], true);
  local.control.resume = async () => ({ acknowledged: false, paused: false });
  await assert.rejects(local.session.resume());
  assert.equal(local.sdk.effects.filter(([name]) => name === 'setMicMuted').at(-1)[1], true);
  const ack = deferred(); local.control.resume = () => ack.promise;
  const pending = local.session.resume(); await flush();
  assert.equal(local.sdk.effects.filter(([name]) => name === 'setMicMuted').at(-1)[1], true);
  ack.resolve({ acknowledged: true, paused: false }); await pending;
  assert.deepEqual(local.sdk.effects.slice(-2), [['setMicMuted', false], ['setVolume', 1]]);
});

test('AIT-136 SDK asynchronous mute error ends capture and transport without acknowledging pause', async t => {
  const sdk = fakeSdk(), start = sdk.startSession;
  sdk.startSession = async options => {
    const conversation = await start(options), mute = conversation.setMicMuted;
    conversation.setMicMuted = muted => {
      mute(muted);
      if (muted) queueMicrotask(() => options.onError('Failed to set input muted state', new Error('fixture mute failure')));
    };
    return conversation;
  };
  const local = await setup(t, { sdk });
  await assert.rejects(local.session.pause()); await local.reader;
  assert.equal(sdk.closed, true);
  assert.ok(sdk.effects.some(([name]) => name === 'endSession'));
  assert.equal(local.closed.at(-1).reason, 'pause-failed');
  assert.deepEqual(local.pauses, []);
});

test('AIT-136 pause during recovery survives into the replacement before onConnect', async t => {
  const sdk = fakeSdk(), start = sdk.startSession, atConnect = [];
  sdk.startSession = options => start({ ...options, onConnect: identity => {
    atConnect.push(sdk.effects.filter(([name]) => name === 'setMicMuted').at(-1)?.[1]);
    options.onConnect(identity);
  } });
  const local = await setup(t, { sdk }), ready = deferred(), recover = local.control.recover;
  local.control.recover = async (...args) => { await ready.promise; return recover(...args); };
  sdk.starts[0].onDisconnect(); await until(() => local.closed.length === 1);
  const paused = local.session.pause();
  // Attach the rejection handler before releasing recovery, including on the old implementation.
  const result = paused.then(value => value, error => error);
  try {
    assert.equal(sdk.effects.filter(([name]) => name === 'setMicMuted').at(-1)[1], true);
  } finally { ready.resolve(); }
  assert.deepEqual(await result, { acknowledged: true, paused: true });
  await until(() => local.observed.some(event => event.type === 'recovered'));
  assert.equal(atConnect.at(-1), true);
  assert.equal(local.pauses.at(-1).providerSessionId, local.session.providerSessionId);
  message(sdk, 1); await flush(); assert.equal(local.observed.some(event => event.type === 'final'), false);
  await local.session.resume(); assert.equal(sdk.effects.filter(([name]) => name === 'setMicMuted').at(-1)[1], false);
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
