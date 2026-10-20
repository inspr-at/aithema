import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { applyEvent, createSession, inputRevision } from '@inspr/aithema-core';
import { voiceEvents } from '../../core/src/live-voice.js';
import { manifest } from '../../../plugins/elevenlabs/src/manifest.js';
import { en } from '../src/i18n/en.js';

const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true });
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true }, analysis: { available: true } } };
  session.transcript = [{ id: 'user', role: 'user', content: 'Invoice approvals' }];
  Object.assign(session.understanding, { summary: 'Original context', openQuestions: ['Which system?'], inputRevision: inputRevision(session) });
  const commands = [], events = voiceEvents();
  let snapshot, voice;
  const fetch = t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, `/api/sessions/${session.id}`, 'only the fixture snapshot is fetched');
    return Response.json(snapshot);
  });
  c.configure({ copy: en, session, voiceClient: { manifest, async start({ callId }) {
    voice = { callId, providerSessionId: 'fixture-provider', events,
      async setInput() {}, async setOutput() {},
      async updateContext(context) { commands.push(['context', structuredClone(context)]); },
      async speakReply(reply) { commands.push(['speak', reply]); },
      async pause() { commands.push(['pause']); return { acknowledged: true, paused: true }; },
      async resume() { commands.push(['resume']); return { acknowledged: true, paused: false }; },
      async close() { commands.push(['close']); events.end(); return { closureConfirmed: true }; },
      lifecycle: { wait(reason) { commands.push(['wait', reason]); events.push({ type: 'waiting', callId, reason }); } },
    };
    return voice;
  } } });
  t.after(async () => { c.configure({ copy: en, session }); c.remove(); await tick(); });
  c.shadowRoot.querySelector('.voice-start').click(); await tick();
  assert.equal(c.shadowRoot.querySelector('.audio-rail').dataset.state, 'listening');
  commands.length = 0;
  const gap = () => c.receive({ seq: c.session.seq + 2, type: 'verification.requested', data: {} });
  const recover = async (changes, extra = {}) => {
    snapshot = changes.reduce((s, change) => applyEvent(s, { ...change, seq: s.seq + 1 }), c.session);
    // The HTTP acknowledgement arrives before the earlier journal event.
    snapshot = applyEvent(snapshot, { seq: snapshot.seq + 1, type: 'verification.requested', data: {} });
    Object.assign(snapshot, extra);
    gap(); await tick();
    assert.equal(c.session.seq, snapshot.seq, 'the forced gap adopts the fixture snapshot');
  };
  const repeat = async () => { gap(); await tick(); };
  return { c, voice, commands, fetch, recover, repeat, gap };
}

for (const kind of ['understanding', 'transcript', 'focus']) test(`AIT-391: gap recovery refreshes changed ${kind} context once`, async t => {
  const f = await fixture(t);
  const change = kind === 'understanding' ? { type: 'understanding.updated', data: { ...f.c.session.understanding, summary: 'Recovered context' } }
    : kind === 'transcript' ? { type: 'turn.corrected', data: { id: 'user', content: 'Corrected approvals' } }
      : { type: 'question.focused', data: { question: 'Which system?' } };
  await f.recover([change]);
  assert.deepEqual(f.commands, [['context', { understanding: f.c.session.understanding,
    focusedQuestion: kind === 'focus' ? 'Which system?' : null }]], 'the voice client receives the recovered context');
  await f.repeat();
  f.c.receive({ seq: f.c.session.seq - 1, ...change }); await tick();
  assert.equal(f.commands.length, 1, 'duplicate snapshots and late SSE cannot refresh the same context again');
});

const focused = session => ({ type: 'question.focused', data: { question: 'Which system?', questionId: 'q-0-0',
  requestId: 'focus', chosenBy: 'user', inputRevision: inputRevision(session) } });
const reply = session => ({ type: 'turn.final', data: { id: 'clarify-reply', role: 'assistant', content: 'Which accounting system?',
  focusRequestId: 'focus', inputRevision: inputRevision(session) } });

test('AIT-391: a recovered pending clarify reply is spoken once across concurrent snapshots and late SSE', async t => {
  const f = await fixture(t), pending = [];
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => pending.push(resolve)));
  const focus = { seq: 1, ...focused(f.c.session) }, final = { seq: 2, ...reply(f.c.session) };
  const snapshot = [focus, final].reduce(applyEvent, f.c.session);
  f.gap(); f.gap();
  assert.equal(pending.length, 2, 'two restores are in flight');
  pending[1](Response.json(snapshot)); await tick();
  pending[0](Response.json(snapshot)); await tick();
  assert.equal(f.c.session.seq, 2);
  assert.deepEqual(f.commands.filter(([name]) => name === 'speak'), [['speak', { turnId: 'clarify-reply', text: 'Which accounting system?' }]]);
  f.c.receive(focus); f.c.receive(final); await tick();
  assert.equal(f.commands.filter(([name]) => name === 'speak').length, 1, 'late journal delivery never double-speaks');
});

test('AIT-391: an in-order clarify reply is not spoken again by later gap recovery', async t => {
  const f = await fixture(t);
  f.c.receive({ seq: 1, ...focused(f.c.session) });
  f.c.receive({ seq: 2, ...reply(f.c.session) }); await tick();
  assert.equal(f.commands.filter(([name]) => name === 'speak').length, 1);
  await f.recover([{ type: 'verification.requested', data: {} }]);
  assert.equal(f.commands.filter(([name]) => name === 'speak').length, 1, 'known transcript replies are never replayed');
});

for (const hold of ['paused', 'muted', 'withdrawn', 'erased', 'stale', 'superseded']) test(`AIT-391: recovered ${hold} clarification stays silent`, async t => {
  const f = await fixture(t), changes = [focused(f.c.session), reply(f.c.session)];
  if (hold === 'muted') { f.c.shadowRoot.querySelector('.voice-output').click(); await tick(); }
  if (hold === 'paused') changes.push({ type: 'session.paused', data: { paused: true } });
  if (hold === 'withdrawn') changes[1].data.withdrawn = true;
  if (hold === 'erased') changes[1].data.erased = true;
  if (hold === 'stale') changes.push({ type: 'turn.final', data: { id: 'new-input', role: 'user', content: 'A later answer' } });
  if (hold === 'superseded') changes.push({ ...focused(f.c.session), data: { ...focused(f.c.session).data, requestId: 'new-focus' } });
  await f.recover(changes);
  assert.equal(f.commands.filter(([name]) => name === 'speak').length, 0);
});

test('AIT-391: recovered server pause holds the active rail once before speech or context work', async t => {
  const f = await fixture(t);
  await f.recover([focused(f.c.session), reply(f.c.session), { type: 'session.paused', data: { paused: true } }]);
  assert.deepEqual(f.commands, [['pause']], 'server hold precedes any recovered voice output');
  assert.equal(f.c.session.paused, true);
  assert.equal(f.c.shadowRoot.querySelector('.audio-rail').dataset.state, 'paused');
  await f.repeat();
  assert.deepEqual(f.commands, [['pause']], 'a repeated snapshot does not issue another pause');
});

test('AIT-391: an unpaused snapshot cannot resume a locally paused call', async t => {
  const f = await fixture(t);
  f.c.shadowRoot.querySelector('.pause').click(); await tick();
  assert.equal(f.c.session.paused, true);
  await f.recover([{ type: 'session.paused', data: { paused: false } }]);
  assert.equal(f.c.session.paused, true, 'resume still requires the visitor command acknowledgement');
  assert.equal(f.c.shadowRoot.querySelector('.audio-rail').dataset.state, 'paused');
  assert.equal(f.commands.filter(([name]) => name === 'resume').length, 0);
});

for (const state of ['waiting', 'ended']) test(`AIT-391: recovered ${state} lifecycle reaches the matching active voice session once`, async t => {
  const f = await fixture(t), reason = state === 'waiting' ? 'browser-liveness-deadline' : 'visitor-ended';
  await f.recover([{ type: 'verification.requested', data: {} }], { voiceLifecycle: {
    callId: f.voice.callId, providerSessionId: f.voice.providerSessionId, state, reason,
  } });
  assert.deepEqual(f.commands, state === 'waiting' ? [['wait', reason]] : [['close']]);
  assert.equal(f.c.shadowRoot.querySelector('.audio-rail').dataset.state, state === 'waiting' ? 'waiting' : 'idle');
  await f.repeat();
  assert.equal(f.commands.length, 1, 'repeated lifecycle snapshots are idempotent');
});

test('AIT-391: stale snapshot recovery cannot replay voice effects after a newer journal event', async t => {
  const f = await fixture(t), pending = Promise.withResolvers();
  const snapshot = [focused(f.c.session), reply(f.c.session)].reduce((s, change) => applyEvent(s, { ...change, seq: s.seq + 1 }), f.c.session);
  t.mock.method(globalThis, 'fetch', () => pending.promise);
  f.gap();
  for (let seq = 1; seq <= 3; seq++) f.c.receive({ seq, type: 'verification.requested', data: {} });
  pending.resolve(Response.json(snapshot)); await tick();
  assert.equal(f.c.session.seq, 3);
  assert.deepEqual(f.commands, [], 'rejected snapshots cause no context, speech or pause side effects');
});
