import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, inputRevision } from '@inspr/aithema-core';
import { voiceEvents } from '../../core/src/live-voice.js';
import { manifest } from '../../../plugins/elevenlabs/src/manifest.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { clarifyRefusals } from '../../../test/clarify-refusals.js';
const window = new Window({ url: 'http://localhost/' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
test.after(async () => window.happyDOM.close());
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, locale = 'en') {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true, locale });
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
  session.transcript = [{ id: 'person', role: 'user', content: 'Invoice approvals' },
    { id: 'ordinary', role: 'assistant', content: 'Who approves them?', inputRevision: inputRevision(session) }];
  Object.assign(session.understanding, { inputRevision: inputRevision(session), readinessAssessed: true,
    draft: false, summary: 'Invoice approvals', openQuestions: ['Accounting system?', 'Who approves invoices?', 'PDF or paper?'] });
  session.operations = { inputRevision: inputRevision(session), running: [], failures: [], lastFailure: null };
  c.configure({ session, copy: locale === 'de' ? de : en, sessionToken: 'test-only' });
  const root = c.shadowRoot, rows = () => [...root.querySelectorAll('.open-question')], button = index => rows()[index].querySelector('button');
  const event = (type, data) => c.receive({ seq: c.session.seq + 1, type, data });
  const lane = (running = [], failures = []) => c.receive({ type: 'lane.status', data: {
    inputRevision: inputRevision(c.session), running, failures, lastFailure: failures.at(-1) ?? null,
  } });
  let post, calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      init.signal?.addEventListener('abort', () => controller.close(), { once: true });
    } }));
    if (init.method === 'POST') { calls.push({ url, body: JSON.parse(init.body) }); return post?.(url, init) ?? Response.json({}); }
    return Response.json(c.session);
  });
  const accept = () => {
    const item = c.openQuestionItems[1];
    const data = { ...item, questionId: item.id, requestId: 'focus-1', chosenBy: 'user', inputRevision: inputRevision(c.session) };
    return { accepted: true, event: { seq: c.session.seq + 1, type: 'question.focused', data } };
  };
  t.after(() => c.remove());
  return { c, root, rows, button, event, lane, calls, accept, post: value => { post = value; } };
}
for (const locale of ['de', 'en']) test(`clarify ${locale}: rest → requesting → selected → asked; stable action, one request, no fabricated turn, one announcement`, async t => {
  const f = fixture(t, locale), pending = Promise.withResolvers();
  f.post(() => pending.promise); document.body.append(f.c);
  const action = f.button(1), before = f.c.session.transcript.length;
  action.focus();
  const request = f.c.focusQuestion(f.c.openQuestionItems[1].id);
  assert.equal(f.rows()[1].dataset.state, 'requesting');
  assert.equal(f.button(0).getAttribute('aria-disabled'), 'true');
  assert.equal(f.root.activeElement, action);
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[0].id), { reason: 'reply-in-flight' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.c.session.transcript.length, before);
  pending.resolve(Response.json(f.accept(), { status: 202 })); await request;
  f.lane(['reaction']);
  const live = f.root.querySelector('.clarify-announcement'), requesting = live.textContent;
  f.lane(['reaction']); assert.equal(live.textContent, requesting);
  f.c.receive({ type: 'turn.partial', data: { id: 'focused-reply', delta: 'Who approves invoices?', inputRevision: inputRevision(f.c.session) } });
  assert.equal(f.rows()[1].dataset.state, 'selected');
  assert.equal(f.root.activeElement, action); assert.equal(f.button(1), action);
  assert.equal(f.root.querySelector('.clarify-meta-question').textContent, 'Who approves invoices?');
  assert.equal(f.root.querySelectorAll('.clarify-meta').length, 1);
  const selectedText = live.firstChild;
  f.lane(['reaction']); assert.equal(live.firstChild, selectedText, 'unchanged state does not announce again');
  f.event('turn.final', { id: 'focused-reply', role: 'assistant', content: 'Who approves invoices?', focusRequestId: 'focus-1', inputRevision: inputRevision(f.c.session) });
  f.lane();
  assert.equal(f.rows()[1].dataset.state, 'asked');
  assert.equal(f.root.activeElement, action);
  assert.equal(f.c.session.transcript.filter(t => t.role === 'user').length, 1);
  assert.equal(f.root.querySelectorAll('.clarify-meta').length, 1);
  console.log(`AIT-274 STATE PASS ${locale}: stable action/focus; one request; requesting/selected/asked announcements once`);
});
async function firstReply(f) {
  f.post(() => Response.json(f.accept(), { status: 202 }));
  await f.c.focusQuestion(f.c.openQuestionItems[1].id);
  f.event('turn.final', { id: 'first-reply', role: 'assistant', content: 'Who approves invoices?',
    focusRequestId: 'focus-1', inputRevision: inputRevision(f.c.session) });
  f.lane();
  assert.equal(f.rows()[1].dataset.state, 'asked');
}
for (const locale of ['de', 'en']) test(`second request in the same revision ${locale}: clicked row requests and retains focus`, async t => {
  const f = fixture(t, locale); document.body.append(f.c); await firstReply(f);
  const pending = Promise.withResolvers(); f.post(() => pending.promise);
  const action = f.button(0); action.focus();
  const request = f.c.focusQuestion(f.c.openQuestionItems[0].id);
  assert.equal(f.rows()[0].dataset.state, 'requesting');
  assert.equal(f.button(0), action); assert.equal(f.root.activeElement, action);
  assert.equal(f.rows()[1].dataset.state, 'asked');
  assert.equal(f.rows()[2].dataset.state, 'disabled');
  const item = f.c.openQuestionItems[0];
  pending.resolve(Response.json({ accepted: true, event: { seq: f.c.session.seq + 1, type: 'question.focused', data: {
    ...item, questionId: item.id, requestId: 'focus-2', chosenBy: 'user', inputRevision: inputRevision(f.c.session),
  } } }, { status: 202 }));
  await request;
  assert.equal(f.rows()[0].dataset.state, 'requesting');
  f.event('turn.final', { id: 'second-reply', role: 'assistant', content: 'Which accounting system?',
    focusRequestId: 'focus-2', inputRevision: inputRevision(f.c.session) });
  f.lane(); assert.equal(f.rows()[0].dataset.state, 'asked');
  console.log(`AIT-274 SECOND REQUEST PASS ${locale}: clicked row requesting; completed focus retained as asked`);
});
for (const reason of ['paused', 'consent-required']) test(`second request refused ${reason}: current row shows reason and way out`, async t => {
  const f = fixture(t); await firstReply(f);
  f.post(() => Response.json({ error: 'focus-refused', reason }, { status: 409 }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[0].id), { reason });
  assert.equal(f.rows()[0].dataset.state, 'refused');
  assert.match(f.rows()[0].textContent, new RegExp(reason === 'paused' ? en.clarify.paused : en.clarify.consent));
  assert.equal(f.button(0).textContent, reason === 'paused' ? en.resume : en.clarify.review);
  assert.equal(f.button(0).getAttribute('aria-disabled'), 'false');
  assert.equal(f.rows()[1].dataset.state, 'asked');
  console.log(`AIT-274 SECOND REFUSAL PASS ${reason}: current row refused with enabled way out`);
});
test('duplicate backend reply-in-flight is requesting, not a failure', async t => {
  const f = fixture(t);
  f.post(() => { f.lane(['reaction']); return Response.json({ error: 'focus-refused', reason: 'reply-in-flight' }, { status: 409 }); });
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id), { reason: 'reply-in-flight' });
  f.lane(['reaction']);
  assert.equal(f.rows()[1].dataset.state, 'requesting');
  assert.equal(f.root.querySelector('.reaction-failure').hidden, true);
  f.lane(); await tick(); assert.equal(f.calls.length, 2, 'RC24 N6 re-sends once after the existing reply finishes');
  assert.equal(f.rows()[1].dataset.state, 'focus-retry', 'a second Wait refusal rests with Retry');
  assert.equal(f.button(1).hidden, false);
  f.lane(); await tick(); assert.equal(f.calls.length, 2, 'no third automatic POST');
});
for (const reason of ['stale-question', 'stale-revision']) test(`${reason} refreshes the list and reserves the heading notice for exactly 4 seconds`, async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.post(() => Response.json({ error: 'focus-refused', reason }, { status: 409 }));
  const refreshed = f.c.session; refreshed.understanding.openQuestions[1] = 'New approval question?';
  const oldFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, init) => init?.method === 'POST' ? oldFetch(url, init) : Promise.resolve(Response.json(refreshed)));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id), { reason });
  assert.equal(f.rows()[1].querySelector('.question-text').textContent, 'New approval question?');
  const notice = f.root.querySelector('.question-notice');
  assert.equal(notice.hasAttribute('data-on'), true);
  t.mock.timers.tick(3999); assert.equal(notice.hasAttribute('data-on'), true);
  t.mock.timers.tick(1); assert.equal(notice.hasAttribute('data-on'), false);
});
for (const [reason, admissionReason, state] of [['paused', null, 'paused'], ['consent-required', null, 'consent'], ['not-admitted', 'one-hour', 'deadline']]) {
  test(`pre-acceptance refusal ${reason}/${admissionReason}: reason and way out; deadline removes actions`, async t => {
    const f = fixture(t);
    f.post(() => Response.json({ error: 'focus-refused', reason, admissionReason }, { status: 403 }));
    await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id), { reason });
    assert.equal(f.rows()[1].dataset.state, 'refused');
    assert.match(f.rows()[1].textContent, new RegExp(en.clarify[state]));
    assert.ok(f.rows()[1].querySelector('.question-status svg'), 'every refusal has its approved icon');
    assert.equal(f.rows()[1].textContent.includes('undefined'), false);
    if (state === 'deadline') assert.ok(f.rows().every(row => row.querySelector('button').hidden));
    else assert.equal(f.button(1).textContent, state === 'paused' ? en.resume : en.clarify.review);
  });
}
for (const reason of ['invalid-request', 'not-admitted', 'not-found', undefined]) test(`other refusal ${reason ?? 'network'} keeps structured failure and rests unavailable`, async t => {
  const f = fixture(t);
  f.post(() => { if (!reason) throw new Error('offline'); return Response.json({ error: reason === 'not-found' ? reason : 'focus-refused', reason }, { status: 400 }); });
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id));
  assert.equal(f.rows()[1].dataset.state, 'unavailable');
});
test('accepted reaction failure has warning, full accessible text, and exactly one retry per failure', async t => {
  const f = fixture(t); f.post(() => Response.json(f.accept(), { status: 202 }));
  await f.c.focusQuestion(f.c.openQuestionItems[1].id);
  f.lane([], [{ lane: 'reaction', error: 'reasoning-unavailable', retryable: true }, { lane: 'understanding', error: 'reasoning-unavailable' }]);
  assert.equal(f.rows()[1].dataset.state, 'retry');
  assert.equal(f.root.querySelector('.retry').hidden, true);
  assert.equal(f.root.querySelector('.overview-retry').hidden, true);
  assert.equal(f.root.querySelector('.reaction-failure').hidden, false);
  assert.ok(f.rows()[1].querySelector('.question-status svg'));
  assert.equal(f.rows()[1].querySelector('.question-failed-long').textContent, en.clarifyFailed);
  const pending = Promise.withResolvers(); f.post(() => pending.promise);
  f.button(1).click(); f.button(1).click(); assert.equal(f.calls.length, 2, 'one focus and one retry');
  assert.ok(f.calls[1].url.endsWith('/retry'));
  pending.resolve(Response.json({ accepted: true })); await tick();
  f.lane(['reaction']); assert.equal(f.rows()[1].dataset.state, 'requesting');
  f.lane([], [{ lane: 'reaction', retryable: true }]); assert.equal(f.rows()[1].dataset.state, 'retry');
});
test('assessment reorder retains selection; removal clears UI selection and the voice context', async t => {
  const f = fixture(t); f.post(() => Response.json(f.accept(), { status: 202 }));
  await f.c.focusQuestion(f.c.openQuestionItems[1].id);
  const data = f.c.session.understanding;
  data.openQuestions.reverse(); f.event('understanding.updated', data);
  assert.equal(f.rows().find(row => row.querySelector('.question-text').textContent === 'Who approves invoices?').dataset.state, 'requesting');
  data.openQuestions = ['PDF or paper?']; f.event('understanding.updated', data);
  assert.ok(f.rows().every(row => row.dataset.state !== 'selected' && row.dataset.state !== 'retry'));
});
test('host pane title wins and no visuals line is introduced on an unbound host', t => {
  const f = fixture(t); assert.equal(f.root.querySelector('#understanding-title').textContent, 'Overview');
  const copy = { ...en, understanding: 'Our host title' };
  f.c.configure({ session: f.c.session, copy });
  assert.equal(f.root.querySelector('#understanding-title').textContent, 'Our host title');
  assert.equal(f.root.querySelector('.drafts-notice'), null);
});

test('AIT-263 Low: removed focus is never passed to the active voice adapter', async t => {
  const f = fixture(t), contexts = [], events = voiceEvents();
  const session = f.c.session; session.featureMatrix.best.voice = { available: true };
  f.c.configure({ session, copy: en, voiceClient: { manifest, async start(request) {
    return { callId: request.callId, providerSessionId: 'clarify-voice', events,
      async setInput() {}, async setOutput() {}, async updateContext(context) { contexts.push(context); },
      async close() { events.end(); return { closureConfirmed: true }; } };
  } } });
  t.after(() => f.c.configure({ session: createSession(), copy: en }));
  f.c.shadowRoot.querySelector('.voice-start').click(); await tick();
  f.event('question.focused', { question: 'Who approves invoices?', questionId: f.c.openQuestionItems[1].id,
    requestId: 'voice-focus', chosenBy: 'user', inputRevision: inputRevision(f.c.session) });
  await tick(); assert.equal(contexts.at(-1).focusedQuestion, 'Who approves invoices?');
  const understanding = f.c.session.understanding; understanding.openQuestions = ['PDF or paper?'];
  f.event('understanding.updated', understanding); await tick();
  assert.equal(f.c.session.focusedQuestion, 'Who approves invoices?', 'the later automatic focus event has not arrived yet');
  assert.equal(contexts.at(-1).focusedQuestion, null, 'the intermediate voice update already excludes the removed question');
});

for (const finish of ['listening', 'ended', 'before-refusal']) test(`voice-busy refusal re-sends once after speaking (${finish}) without new input`, async t => {
  const f = fixture(t), events = voiceEvents(); let callId;
  const session = f.c.session; session.featureMatrix.best.voice = { available: true };
  f.c.configure({ session, copy: en, voiceClient: { manifest, async start(request) {
    callId = request.callId;
    return { callId, providerSessionId: 'busy-voice', events, async setInput() {}, async setOutput() {},
      async updateContext() {}, async close() { events.end(); return { closureConfirmed: true }; } };
  } } });
  t.after(() => f.c.configure({ session: createSession(), copy: en }));
  f.root.querySelector('.voice-start').click(); await tick();
  events.push({ type: 'speaking', callId }); await tick();
  // Each HTTP attempt owns a fresh body, including the bounded automatic resend.
  const pending = Promise.withResolvers(); f.post(() => pending.promise.then(response => response.clone()));
  const request = f.c.focusQuestion(f.c.openQuestionItems[0].id);
  const rejected = assert.rejects(request, { reason: 'reply-in-flight' });
  if (finish === 'before-refusal') { events.push({ type: 'listening', callId }); await tick(); }
  pending.resolve(Response.json({ error: 'focus-refused', reason: 'reply-in-flight' }, { status: 409 }));
  await rejected;
  if (finish !== 'before-refusal') {
    assert.equal(f.rows()[0].dataset.state, 'requesting');
    f.lane(); assert.equal(f.rows()[0].dataset.state, 'requesting', 'idle reaction status cannot release a speaking reply');
    events.push({ type: finish, callId, ...(finish === 'ended' ? { reason: 'closed' } : {}) }); await tick();
  }
  await tick();
  assert.equal(f.rows()[0].dataset.state, 'focus-retry');
  assert.equal(f.button(0).hidden, false);
  assert.equal(f.calls.length, 2, 'RC24 N6 permits exactly one resend after speaking ends');
  assert.equal(f.c.session.transcript.filter(turn => turn.role === 'user').length, 1);
  console.log(`AIT-274 VOICE BUSY PASS ${finish}: bounded resend rests with Retry; no fabricated input`);
});
test('final reply-in-flight refusal with no running reply re-sends once then rests with Retry', async t => {
  const f = fixture(t);
  f.post(() => Response.json({ error: 'focus-refused', reason: 'reply-in-flight' }, { status: 409 }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[0].id), { reason: 'reply-in-flight' });
  f.lane(); await tick();
  assert.equal(f.rows()[0].dataset.state, 'focus-retry');
  assert.equal(f.button(0).hidden, false);
  assert.equal(f.calls.length, 2);
});

for (const row of clarifyRefusals) test(`AIT-503 UI refusal branch and value-free diagnostic: ${row.name}`, async t => {
  const f = fixture(t), warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  f.post(() => Response.json(row.body, { status: row.status }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id), { status: row.status });
  const retryable = ['admission deadline', 'plugin unhealthy', 'consent port unavailable'].includes(row.name);
  assert.equal(f.rows()[1].dataset.state, row.name === 'budget reconciling' ? 'requesting' : row.branch === 'generic' ? 'unavailable' : 'refused');
  if (row.branch === 'generic' && row.name !== 'budget reconciling') assert.equal(f.rows()[1].querySelector('button').hidden, true);
  const expected = ['Aithema: clarify refusal', {
    status: row.status, error: row.body.error, reason: row.body.reason,
    admissionReason: row.body.admissionReason ?? null, accepted: false, acceptedThenLaneFailed: false,
  }];
  assert.deepEqual(warnings, Array.from({ length: retryable ? 2 : 1 }, () => expected));
  assert.equal(f.c.session.transcript.length, 2, 'diagnostics add no conversation content or turns');
});

test('AIT-503 accepted then lane.failed diagnostic distinguishes failure from immediate refusal', async t => {
  const f = fixture(t), warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  f.post(() => Response.json(f.accept(), { status: 202 }));
  await f.c.focusQuestion(f.c.openQuestionItems[1].id);
  assert.deepEqual(warnings, []);
  f.c.receive({ type: 'lane.failed', data: { lane: 'reaction', inputRevision: inputRevision(f.c.session), error: 'reasoning-unavailable', retryable: true } });
  assert.equal(f.rows()[1].dataset.state, 'retry');
  assert.deepEqual(warnings, [['Aithema: clarify refusal', {
    status: 202, error: 'reasoning-unavailable', reason: null, admissionReason: null,
    accepted: true, acceptedThenLaneFailed: true,
  }]]);
  f.lane([], [{ lane: 'reaction', error: 'reasoning-unavailable', retryable: true }]);
  assert.equal(warnings.length, 1, 'status replay does not repeat the diagnostic');
});

test('AIT-503 lane failure before HTTP acceptance does not claim an earlier 202', async t => {
  const f = fixture(t), warnings = [], pending = Promise.withResolvers();
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const accepted = f.accept(); f.post(() => pending.promise);
  const request = f.c.focusQuestion(f.c.openQuestionItems[1].id);
  f.c.receive(accepted.event);
  f.c.receive({ type: 'lane.failed', data: { lane: 'reaction', inputRevision: inputRevision(f.c.session), error: 'reasoning-unavailable', retryable: true } });
  pending.resolve(Response.json(accepted, { status: 202 })); await request;
  assert.equal(f.rows()[1].dataset.state, 'retry');
  assert.deepEqual(warnings, [['Aithema: clarify refusal', {
    status: null, error: 'reasoning-unavailable', reason: null, admissionReason: null,
    accepted: false, acceptedThenLaneFailed: false,
  }]]);
});

test('AIT-503 local busy refusal stays quiet without another request', async t => {
  const f = fixture(t), warnings = [], pending = Promise.withResolvers();
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  f.post(() => pending.promise);
  const request = f.c.focusQuestion(f.c.openQuestionItems[1].id);
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[0].id), { reason: 'reply-in-flight' });
  pending.resolve(Response.json(f.accept(), { status: 202 })); await request;
  assert.equal(f.calls.length, 1);
  assert.deepEqual(warnings, []);
});

test('AIT-503 diagnostic excludes arbitrary server strings, transport messages and conversation data', async t => {
  const f = fixture(t), warnings = [], content = 'synthetic conversation content must stay private';
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  f.post(() => Response.json({ error: content, reason: content, admissionReason: content, question: content }, { status: 500 }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id));
  f.post(() => { throw new Error(content); });
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id));
  assert.equal(warnings.length, 4);
  assert.equal(JSON.stringify(warnings).includes(content), false);
  assert.equal(JSON.stringify(warnings).includes('Who approves invoices?'), false);
  assert.deepEqual(warnings.map(args => args[1]), [
    { status: 500, error: 'unclassified', reason: 'unclassified', admissionReason: 'unclassified', accepted: false, acceptedThenLaneFailed: false },
    { status: null, error: null, reason: null, admissionReason: null, accepted: false, acceptedThenLaneFailed: false },
  ].flatMap(record => [record, record]));
});

test('AIT-503 rejected selected-item retry keeps its row branch and records HTTP status', async t => {
  const f = fixture(t), warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  f.post(() => Response.json(f.accept(), { status: 202 }));
  await f.c.focusQuestion(f.c.openQuestionItems[1].id);
  f.c.receive({ type: 'lane.failed', data: { lane: 'reaction', inputRevision: inputRevision(f.c.session), error: 'reasoning-unavailable', retryable: true } });
  warnings.length = 0;
  f.post(() => Response.json({ error: 'focus-refused', reason: 'not-admitted', admissionReason: 'budget reconciling' }, { status: 403 }));
  f.button(1).click(); await tick();
  assert.equal(f.rows()[1].dataset.state, 'retry');
  assert.deepEqual(warnings, [['Aithema: clarify refusal', {
    status: 403, error: 'focus-refused', reason: 'not-admitted', admissionReason: 'budget reconciling',
    accepted: false, acceptedThenLaneFailed: false,
  }]]);
});

test('AIT-503 malformed accepted JSON preserves observed 202 without claiming lane.failed', async t => {
  const f = fixture(t), warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  f.post(() => new Response('{', { status: 202, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id));
  assert.deepEqual(warnings, [['Aithema: clarify refusal', {
    status: 202, error: null, reason: null, admissionReason: null, accepted: true, acceptedThenLaneFailed: false,
  }]]);
});

for (const index of [0, 1]) test(`AIT-503 SSE-only focus ${index} never inherits an earlier local 202`, async t => {
  const f = fixture(t), warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  await firstReply(f);
  const item = f.c.openQuestionItems[index];
  f.event('question.focused', { question: item.question, questionId: item.id, requestId: 'peer-focus',
    chosenBy: 'user', inputRevision: inputRevision(f.c.session) });
  f.c.receive({ type: 'lane.failed', data: { lane: 'reaction', inputRevision: inputRevision(f.c.session), error: 'reasoning-unavailable', retryable: true } });
  assert.equal(f.calls.length, 1, 'this UI observed only the older local request');
  assert.deepEqual(warnings, [['Aithema: clarify refusal', {
    status: null, error: 'reasoning-unavailable', reason: null, admissionReason: null,
    accepted: false, acceptedThenLaneFailed: false,
  }]]);
});

for (const locale of ['en', 'de']) test(`RC24 split failure copy ${locale}: shipped fallback and legacy override`, async t => {
  const f = fixture(t, locale), shipped = locale === 'de' ? de : en;
  f.post(() => Response.json(f.accept(), { status: 202 }));
  await f.c.focusQuestion(f.c.openQuestionItems[1].id);
  f.lane([], [{ lane: 'reaction', retryable: true }]);
  assert.equal(f.rows()[1].querySelector('.question-failed-long').textContent, shipped.clarifyFailed);
  assert.equal(f.rows()[1].querySelector('.question-failed-short').textContent, locale === 'de' ? 'Gerade nicht' : 'Not now');
  const copy = structuredClone(shipped); copy.reasoningFailed = 'Host legacy failure';
  f.c.configure({ session: f.c.session, copy });
  assert.equal(f.rows()[1].querySelector('.question-failed-long').textContent, 'Host legacy failure');
});
for (const admissionReason of ['admission deadline', 'plugin unhealthy', 'consent port unavailable']) test(`RC24 retryable ${admissionReason}: two focus POSTs then unavailable`, async t => {
  const f = fixture(t);
  f.post(() => Response.json({ reason: 'not-admitted', admissionReason }, { status: 403 }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id));
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.url.endsWith('/focus-question')));
  assert.equal(f.rows()[1].dataset.state, 'unavailable');
  assert.equal(f.rows()[1].querySelector('.question-status').textContent, en.clarifyUnavailable);
});
for (const admissionReason of ['budget reconciling', null]) test(`RC24 Wait ${admissionReason ?? 'reply'} expires at 60 seconds with row Retry`, async t => {
  const f = fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  f.lane(['reaction']);
  f.post(() => Response.json(admissionReason ? { reason: 'not-admitted', admissionReason } : { reason: 'reply-in-flight' }, { status: 409 }));
  // The simulated in-flight reply starts on the server after the click.
  f.lane();
  f.post(() => { f.lane(['reaction']); return Response.json(admissionReason ? { reason: 'not-admitted', admissionReason } : { reason: 'reply-in-flight' }, { status: 409 }); });
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id));
  t.mock.timers.tick(59_999); assert.equal(f.rows()[1].dataset.state, 'requesting');
  t.mock.timers.tick(1); assert.equal(f.rows()[1].dataset.state, 'focus-retry');
  assert.equal(f.button(1).textContent, en.clarify.retry);
  assert.equal(f.calls.length, 1);
});
test('RC24 Wait clears then re-sends exactly once', async t => {
  const f = fixture(t); let calls = 0;
  f.post(() => { if (++calls === 1) { f.lane(['reaction']); return Response.json({ reason: 'reply-in-flight' }, { status: 409 }); }
    return Response.json(f.accept(), { status: 202 }); });
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id));
  f.lane(); await tick();
  assert.equal(f.calls.length, 2); assert.equal(f.rows()[1].dataset.state, 'requesting');
  f.lane(); await tick(); assert.equal(f.calls.length, 2);
});
for (const failure of ['network', '5xx']) for (const outcome of ['absent', 'running', 'completed', 'read-failed']) test(`RC24 N5 ${failure}/${outcome}: snapshot precedes any re-send`, async t => {
  const f = fixture(t), order = []; let posts = 0;
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (init.method === 'POST') {
      order.push('POST'); if (++posts > 1) return Response.json(f.accept(), { status: 202 });
      if (failure === 'network') throw new TypeError('offline');
      return Response.json({ error: 'server-error' }, { status: 503 });
    }
    if (url.endsWith('/events')) return fetch(url, init);
    order.push('GET'); if (outcome === 'read-failed') return Response.json({}, { status: 503 });
    const snapshot = f.c.session;
    if (outcome === 'running' || outcome === 'completed') {
      const item = f.c.openQuestionItems[1];
      snapshot.seq += 1; snapshot.questionFocus = { questionId: item.id, requestId: 'lost-ack', inputRevision: inputRevision(snapshot) };
      snapshot.focusedQuestion = item.question;
      snapshot.operations.running = outcome === 'running' ? ['reaction'] : [];
      if (outcome === 'completed') snapshot.transcript.push({ id: 'lost-reply', role: 'assistant', content: 'Who approves?', focusRequestId: 'lost-ack' });
    }
    return Response.json(snapshot);
  });
  await f.c.focusQuestion(f.c.openQuestionItems[1].id).catch(() => {});
  assert.deepEqual(order, outcome === 'absent' ? ['POST', 'GET', 'POST'] : ['POST', 'GET']);
});
test('RC24 budget denied during a live call rests immediately as unavailable', async t => {
  const f = fixture(t), session = f.c.session;
  session.voiceLifecycle = { state: 'active', callId: 'fixture-call' };
  f.c.configure({ session, copy: en });
  f.post(() => Response.json({ reason: 'not-admitted', admissionReason: 'budget denied' }, { status: 403 }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id));
  assert.equal(f.rows()[1].dataset.state, 'unavailable'); assert.equal(f.calls.length, 1);
});

for (const [status, reason] of [[400, 'invalid-request'], [403, 'configuration'], [409, undefined]]) test(`RC24 terminal ${status}/${reason}: no automatic retry and no row action`, async t => {
  const f = fixture(t); f.post(() => Response.json({ reason }, { status }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id));
  assert.equal(f.calls.length, 1);
  assert.ok(f.rows().every(row => row.querySelector('button').hidden));
  assert.ok(f.rows()[1].querySelector('.question-status').textContent.trim());
});
test('RC24 budget Wait clears on an authoritative refresh and re-sends once', async t => {
  const f = fixture(t); let posts = 0;
  f.post(() => ++posts === 1 ? Response.json({ reason: 'not-admitted', admissionReason: 'budget reconciling' }, { status: 403 })
    : Response.json(f.accept(), { status: 202 }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id));
  assert.equal(f.rows()[1].dataset.state, 'requesting'); assert.equal(f.calls.length, 1);
  f.lane(); await tick(); assert.equal(f.calls.length, 2);
  assert.equal(f.rows()[1].dataset.state, 'requesting');
});
test('RC24 timed-out Wait Retry posts focus-question, with duplicate activation bounded', async t => {
  const f = fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  f.post(() => Response.json({ reason: 'not-admitted', admissionReason: 'budget reconciling' }, { status: 403 }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id));
  t.mock.timers.tick(60_000);
  const pending = Promise.withResolvers(); f.post(() => pending.promise);
  f.button(1).click(); f.button(1).click(); assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1].url.endsWith('/focus-question'));
  pending.resolve(Response.json(f.accept(), { status: 202 })); await tick();
});
for (const locale of ['en', 'de']) test(`RC24 reply failure ${locale}: absent Retry offers typing`, t => {
  const f = fixture(t, locale), copy = locale === 'de' ? de : en;
  f.lane(['reaction'], [{ lane: 'reaction', retryable: true }]);
  assert.equal(f.root.querySelector('.retry').hidden, true);
  assert.equal(f.root.querySelector('.reaction-failure-text').textContent, `${copy.replyFailed} ${copy.replyKeepTyping}`);
});
test('RC24 a detached pending command cannot start automatic recovery', async t => {
  const f = fixture(t), pending = Promise.withResolvers();
  document.body.append(f.c); f.post(() => pending.promise);
  const request = f.c.focusQuestion(f.c.openQuestionItems[1].id);
  f.c.remove(); pending.reject(new TypeError('offline'));
  await assert.rejects(request, TypeError);
  assert.equal(f.calls.length, 1);
});
test('RC24 a peer focus completed before a local Wait refusal is never re-sent', async t => {
  const f = fixture(t), pending = Promise.withResolvers();
  f.post(() => pending.promise);
  const request = f.c.focusQuestion(f.c.openQuestionItems[1].id);
  f.c.receive(f.accept().event);
  f.event('turn.final', { id: 'peer-reply', role: 'assistant', content: 'Who approves?', focusRequestId: 'focus-1', inputRevision: inputRevision(f.c.session) });
  pending.resolve(Response.json({ reason: 'reply-in-flight' }, { status: 409 }));
  await assert.rejects(request); f.lane(); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.rows()[1].dataset.state, 'asked');
});
test('RC24 a connected budget Wait refreshes availability before its one resend', async t => {
  const f = fixture(t); let posts = 0;
  document.body.append(f.c);
  f.post(() => ++posts === 1 ? Response.json({ reason: 'not-admitted', admissionReason: 'budget reconciling' }, { status: 403 })
    : Response.json(f.accept(), { status: 202 }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id)); await tick();
  assert.equal(f.calls.length, 2); assert.equal(f.rows()[1].dataset.state, 'requesting');
});
test('RC24 a direct one-hour refusal keeps its specific reason and hides the action', async t => {
  const f = fixture(t); f.post(() => Response.json({ reason: 'one-hour' }, { status: 403 }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id));
  assert.equal(f.rows()[1].querySelector('.question-status').textContent, en.clarify.deadline);
  assert.ok(f.rows().every(row => row.querySelector('button').hidden));
  assert.equal(f.calls.length, 1);
});
test('RC24 a different peer focus never inherits a pending local acceptance or stays pending', async t => {
  const f = fixture(t), body = Promise.withResolvers(), warnings = [], local = f.accept();
  const response = Response.json({}, { status: 202 });
  t.mock.method(response, 'json', () => body.promise);
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  f.post(() => response);
  const request = f.c.focusQuestion(f.c.openQuestionItems[1].id);
  t.after(async () => { body.resolve(local); await request.catch(() => {}); });
  await tick();
  f.c.receive(local.event); // The later peer gets its own canonical journal sequence.
  const peer = f.c.openQuestionItems[0];
  f.event('question.focused', { question: peer.question, questionId: peer.id, requestId: 'peer-pending', chosenBy: 'user', inputRevision: inputRevision(f.c.session) });
  f.c.receive({ type: 'lane.failed', data: { lane: 'reaction', retryable: true, inputRevision: inputRevision(f.c.session) } });
  assert.equal(warnings.length, 1); assert.equal(warnings[0][1].accepted, false);
  assert.equal(f.button(0).getAttribute('aria-disabled'), 'true');
  body.resolve(local); assert.equal((await request).accepted, true);
  assert.equal(f.rows()[0].dataset.state, 'retry');
  assert.equal(f.button(0).getAttribute('aria-disabled'), 'false');
  assert.equal(f.calls.length, 1);
});
test('RC24 a Wait snapshot with live-call budget denial settles without another POST', async t => {
  const f = fixture(t), session = f.c.session;
  session.voiceLifecycle = { state: 'active', callId: 'budget-wait-call' };
  f.c.configure({ session, copy: en });
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, init = {}) => {
    if (init.method === 'POST' || url.endsWith('/events')) return fetch(url, init);
    const snapshot = f.c.session;
    snapshot.featureMatrix.best.text = { available: false, reason: 'budget denied' };
    return Promise.resolve(Response.json(snapshot));
  });
  document.body.append(f.c);
  f.post(() => Response.json({ reason: 'not-admitted', admissionReason: 'budget reconciling' }, { status: 403 }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id)); await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.rows()[1].dataset.state, 'unavailable');
  assert.equal(f.rows()[1].querySelector('.question-status').textContent, en.clarifyUnavailable);
});
test('RC24 a terminal credit snapshot without a known time bound never claims a time limit', async t => {
  const f = fixture(t); f.post(() => Response.json(f.accept(), { status: 202 }));
  await f.c.focusQuestion(f.c.openQuestionItems[1].id);
  const session = f.c.session; session.credits = { status: 'ended' };
  f.c.configure({ session, copy: en });
  assert.ok(f.rows().every(row => row.querySelector('button').hidden));
  assert.equal(f.rows()[1].querySelector('.question-status').textContent, en.clarifyUnavailable);
});
for (const status of [200, 202]) test(`RC24 invalid ${status} acknowledgement reads state, rests, and never re-posts`, async t => {
  const f = fixture(t), fetch = globalThis.fetch; let snapshots = 0;
  t.mock.method(globalThis, 'fetch', (url, init = {}) => {
    if (init.method !== 'POST' && !url.endsWith('/events')) snapshots++;
    return fetch(url, init);
  });
  f.post(() => Response.json({}, { status }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id));
  assert.equal(snapshots, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.rows()[1].dataset.state, 'unavailable');
});

for (const locale of ['en', 'de']) test(`RC24 ${locale}: existing row-only copy overrides survive beneath explicit root overrides`, async t => {
  const f = fixture(t, locale), copy = structuredClone(locale === 'de' ? de : en);
  copy.clarify.failed = 'Host row failure'; copy.clarify.failedShort = 'Host short'; copy.clarify.say.retry = 'Host announcement';
  f.c.configure({ session: f.c.session, copy });
  f.post(() => Response.json(f.accept(), { status: 202 }));
  await f.c.focusQuestion(f.c.openQuestionItems[1].id);
  f.lane([], [{ lane: 'reaction', retryable: true }]);
  assert.equal(f.rows()[1].querySelector('.question-failed-long').textContent, 'Host row failure');
  assert.equal(f.rows()[1].querySelector('.question-failed-short').textContent, 'Host short');
  assert.equal(f.root.querySelector('.clarify-announcement').textContent, 'Host announcement');
  copy.reasoningFailed = 'Generic host failure'; f.c.configure({ session: f.c.session, copy });
  assert.equal(f.rows()[1].querySelector('.question-failed-long').textContent, 'Generic host failure');
  assert.equal(f.root.querySelector('.clarify-announcement').textContent, 'Generic host failure');
  copy.clarifyFailed = 'New host failure'; copy.clarifyFailedShort = 'New host short'; f.c.configure({ session: f.c.session, copy });
  assert.equal(f.rows()[1].querySelector('.question-failed-long').textContent, 'New host failure');
  assert.equal(f.rows()[1].querySelector('.question-failed-short').textContent, 'New host short');
  assert.equal(f.root.querySelector('.clarify-announcement').textContent, 'New host failure');
});
test('RC24 choosing another point after a reaction failure keeps the new row requesting', async t => {
  const f = fixture(t); f.post(() => Response.json(f.accept(), { status: 202 }));
  await f.c.focusQuestion(f.c.openQuestionItems[1].id);
  f.lane([], [{ lane: 'reaction', retryable: true }]); assert.equal(f.rows()[1].dataset.state, 'retry');
  const item = f.c.openQuestionItems[0], pending = Promise.withResolvers();
  const ack = { accepted: true, event: { seq: f.c.session.seq + 1, type: 'question.focused', data: {
    question: item.question, questionId: item.id, requestId: 'after-failure', chosenBy: 'user', inputRevision: inputRevision(f.c.session),
  } } };
  f.post(() => pending.promise); const request = f.c.focusQuestion(item.id);
  t.after(async () => { pending.resolve(Response.json(ack, { status: 202 })); await request.catch(() => {}); });
  assert.equal(f.rows()[0].dataset.state, 'requesting');
  pending.resolve(Response.json(ack, { status: 202 })); await request;
  assert.equal(f.c.session.questionFocus.questionId, item.id);
  assert.equal(f.rows()[0].dataset.state, 'requesting', 'a new accepted focus cannot inherit the old reaction failure');
});
test('RC24 a newer HTTP focus event supersedes a peer event and retains its actual acceptance', async t => {
  const f = fixture(t), body = Promise.withResolvers(), warnings = [], response = Response.json({}, { status: 202 });
  t.mock.method(response, 'json', () => body.promise); t.mock.method(console, 'warn', (...args) => warnings.push(args));
  f.post(() => response); const item = f.c.openQuestionItems[1];
  const request = f.c.focusQuestion(item.id);
  t.after(async () => { body.resolve(f.accept()); await request.catch(() => {}); });
  await tick(); const peer = f.c.openQuestionItems[0];
  f.event('question.focused', { question: peer.question, questionId: peer.id, requestId: 'earlier-peer', chosenBy: 'user', inputRevision: inputRevision(f.c.session) });
  body.resolve(f.accept()); await request;
  assert.equal(f.c.session.questionFocus.questionId, item.id);
  assert.equal(f.rows()[1].dataset.state, 'requesting');
  f.c.receive({ type: 'lane.failed', data: { lane: 'reaction', retryable: true, inputRevision: inputRevision(f.c.session) } });
  assert.equal(warnings.at(-1)[1].accepted, true);
  assert.equal(warnings.at(-1)[1].acceptedThenLaneFailed, true);
});
test('RC24 a retryable local refusal cannot re-ask a point completed by a peer since the click', async t => {
  const f = fixture(t), pending = Promise.withResolvers(); f.post(() => pending.promise);
  const request = f.c.focusQuestion(f.c.openQuestionItems[1].id);
  f.c.receive(f.accept().event);
  f.event('turn.final', { id: 'peer-completed', role: 'assistant', content: 'Who approves?', focusRequestId: 'focus-1', inputRevision: inputRevision(f.c.session) });
  pending.resolve(Response.json({ reason: 'not-admitted', admissionReason: 'plugin unhealthy' }, { status: 403 }));
  await assert.rejects(request); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.rows()[1].dataset.state, 'asked');
});

for (const refusal of [
  { reason: 'network' },
  { reason: 'network', admissionReason: 'invalid-request' },
]) test(`RC24 shared core policy retries a structured network refusal: ${JSON.stringify(refusal)}`, async t => {
  const f = fixture(t);
  f.post(() => Response.json(refusal, { status: 409 }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id));
  assert.equal(f.calls.length, 2);
  assert.equal(f.rows()[1].dataset.state, 'unavailable');
});

for (const reason of ['reply-in-flight', 'budget reconciling']) test(`gate1 M2: repeated ${reason} rests with Retry and no third automatic POST`, async t => {
  const f = fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  f.post(() => Response.json(reason === 'reply-in-flight' ? { reason } : { reason: 'not-admitted', admissionReason: reason }, { status: 409 }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id));
  f.lane(); await tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.rows()[1].dataset.state, 'focus-retry');
  assert.equal(f.button(1).hidden, false);
  assert.equal(f.button(1).getAttribute('aria-disabled'), 'false');
  assert.match(f.rows()[1].querySelector('.question-status').textContent, /Couldn't ask just now/);
  f.lane(); t.mock.timers.tick(120_000); await tick();
  assert.equal(f.calls.length, 2);
});
for (const accepted of [false, true]) test(`gate1 L1: reply failure retires only on accepted focus (${accepted})`, async t => {
  const f = fixture(t), pending = Promise.withResolvers();
  f.lane([], [{ lane: 'reaction', retryable: true }]);
  const notice = f.root.querySelector('.reaction-failure'), retry = f.root.querySelector('.retry');
  assert.equal(notice.hidden, false); assert.equal(retry.hidden, false);
  f.post(() => pending.promise);
  const request = f.c.focusQuestion(f.c.openQuestionItems[1].id);
  const settled = accepted ? request : assert.rejects(request);
  const pendingVisibility = { notice: notice.hidden, retry: retry.hidden };
  const pendingRetryDisabled = retry.getAttribute('aria-disabled'); retry.click();
  pending.resolve(accepted ? Response.json(f.accept(), { status: 202 }) : Response.json({ reason: 'invalid-request' }, { status: 400 }));
  await settled;
  assert.deepEqual(pendingVisibility, { notice: false, retry: false }, 'pending POST preserves the reply failure');
  assert.equal(pendingRetryDisabled, 'true');
  assert.equal(f.calls.length, 1, 'the visible reply Retry cannot race a pending Clarify POST');
  assert.equal(notice.hidden, accepted);
  if (!accepted) assert.equal(retry.hidden, false, 'refused POST preserves server reply Retry');
});
for (const locale of ['en', 'de']) {
  for (const reason of ['session', 'budget denied', 'host-limit']) test(`gate1 L2: ${locale}/${reason} announces the displayed terminal reason`, async t => {
    const f = fixture(t, locale);
    f.post(() => Response.json({ reason: 'not-admitted', admissionReason: reason }, { status: 403 }));
    await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id));
    assert.equal(f.root.querySelector('.clarify-announcement').textContent, f.rows()[1].querySelector('.question-why').textContent);
  });
  test(`gate1 L2: ${locale} accepted retry announcement offers Retry`, async t => {
    const f = fixture(t, locale), copy = locale === 'de' ? de : en;
    f.post(() => Response.json(f.accept(), { status: 202 }));
    await f.c.focusQuestion(f.c.openQuestionItems[1].id);
    f.lane([], [{ lane: 'reaction', retryable: true }]);
    assert.equal(f.rows()[1].dataset.state, 'retry');
    assert.match(f.root.querySelector('.clarify-announcement').textContent, locale === 'de' ? /Erneut versuchen/ : /You can retry/);
    assert.ok(f.root.querySelector('.clarify-announcement').textContent.includes(copy.clarifyFailed));
  });
}

test('gate1 L1: accepting focus preserves a newer server reaction failure', async t => {
  const f = fixture(t), pending = Promise.withResolvers();
  f.lane([], [{ lane: 'reaction', retryable: true, error: 'old-failure' }]);
  f.post(() => pending.promise);
  const request = f.c.focusQuestion(f.c.openQuestionItems[1].id);
  f.lane([], [{ lane: 'reaction', retryable: true, error: 'new-failure' }]);
  pending.resolve(Response.json(f.accept(), { status: 202 })); await request;
  assert.equal(f.c.session.operations.lastFailure.error, 'new-failure');
  assert.equal(f.rows()[1].dataset.state, 'retry');
});

test('gate1 L1: canonical acceptance retires the old reply failure before a lost HTTP receipt', async t => {
  const f = fixture(t), pending = Promise.withResolvers();
  f.lane([], [{ lane: 'reaction', retryable: true }]);
  f.post(() => pending.promise);
  const request = f.c.focusQuestion(f.c.openQuestionItems[1].id), settled = assert.rejects(request, TypeError);
  f.c.receive(f.accept().event);
  const noticeHiddenOnAcceptance = f.root.querySelector('.reaction-failure').hidden;
  pending.reject(new TypeError('offline')); await settled;
  assert.equal(noticeHiddenOnAcceptance, true);
  assert.equal(f.root.querySelector('.reaction-failure').hidden, true);
  assert.equal(f.rows()[1].dataset.state, 'requesting');
  assert.equal(f.calls.length, 1, 'accepted canonical work prevents another POST');
});

test('gate1 L1: a fresh snapshot confirms acceptance after a lost receipt', async t => {
  const f = fixture(t);
  f.lane([], [{ lane: 'reaction', retryable: true }]);
  f.post(() => { throw new TypeError('offline'); });
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    if (init?.method === 'POST' || url.endsWith('/events')) return fetch(url, init);
    const snapshot = f.c.session, { event } = f.accept();
    snapshot.seq = event.seq; snapshot.questionFocus = event.data; snapshot.focusedQuestion = event.data.question;
    return Promise.resolve(Response.json(snapshot));
  });
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id), TypeError);
  assert.equal(f.root.querySelector('.reaction-failure').hidden, true);
  assert.equal(f.rows()[1].dataset.state, 'requesting');
  assert.equal(f.calls.length, 1);
});

test('gate1 L2: accepted retry guidance preserves literal host failure copy', async t => {
  const f = fixture(t), copy = structuredClone(en); copy.clarify.failed = 'Host $& status';
  f.c.configure({ session: f.c.session, copy });
  f.post(() => Response.json(f.accept(), { status: 202 }));
  await f.c.focusQuestion(f.c.openQuestionItems[1].id);
  f.lane([], [{ lane: 'reaction', retryable: true }]);
  assert.equal(f.rows()[1].querySelector('.question-failed-long').textContent, 'Host $& status');
  assert.equal(f.root.querySelector('.clarify-announcement').textContent, 'Host $& status. You can retry.');
});

for (const acceptance of ['http', 'event', 'snapshot']) test(`gate2 L2: redelivered reaction failure clears on ${acceptance} focus acceptance`, async t => {
  const f = fixture(t), pending = Promise.withResolvers();
  const failure = { lane: 'reaction', retryable: true, error: 'reasoning-unavailable', inputRevision: inputRevision(f.c.session) };
  f.lane([], [failure]);
  f.post(() => pending.promise);
  const request = f.c.focusQuestion(f.c.openQuestionItems[1].id);
  // A new decoded object (with different property order) is the same failure.
  f.lane([], [{ inputRevision: failure.inputRevision, error: failure.error, retryable: true, lane: 'reaction' }]);
  assert.equal(f.root.querySelector('.reaction-failure').hidden, false, 'pending POST retains the failure');
  const receipt = f.accept();
  if (acceptance === 'event') f.c.receive(receipt.event);
  if (acceptance === 'snapshot') {
    const snapshot = structuredClone(f.c.session);
    snapshot.seq = receipt.event.seq; snapshot.questionFocus = receipt.event.data;
    snapshot.focusedQuestion = receipt.event.data.question;
    t.mock.method(globalThis, 'fetch', async () => Response.json(snapshot));
    const rejected = assert.rejects(request, TypeError);
    pending.reject(new TypeError('offline')); await rejected;
  } else {
    pending.resolve(Response.json(receipt, { status: 202 })); await request;
  }
  assert.equal(f.root.querySelector('.reaction-failure').hidden, true);
  assert.equal(f.c.session.operations.lastFailure, null);
  assert.equal(f.rows()[1].dataset.state, 'requesting');
  assert.equal(f.calls.length, 1);
});
for (const locale of ['en', 'de']) test(`gate2 L1: ${locale} focus-retry announcement offers Retry`, async t => {
  const f = fixture(t, locale), copy = locale === 'de' ? de : en;
  f.post(() => Response.json({ reason: 'reply-in-flight' }, { status: 409 }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id), { reason: 'reply-in-flight' });
  f.lane(); await tick();
  assert.equal(f.rows()[1].dataset.state, 'focus-retry');
  const announcement = f.root.querySelector('.clarify-announcement').textContent;
  assert.ok(announcement.includes(copy.clarifyFailed));
  assert.match(announcement, locale === 'de' ? /Erneut versuchen/ : /You can retry/);
});
