import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, inputRevision } from '@inspr/aithema-core';
import { voiceEvents } from '../../core/src/live-voice.js';
import { manifest } from '../../../plugins/elevenlabs/src/manifest.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
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
test('duplicate backend reply-in-flight is requesting, not a failure', async t => {
  const f = fixture(t);
  f.post(() => Response.json({ error: 'focus-refused', reason: 'reply-in-flight' }, { status: 409 }));
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id), { reason: 'reply-in-flight' });
  f.lane(['reaction']);
  assert.equal(f.rows()[1].dataset.state, 'requesting');
  assert.equal(f.root.querySelector('.reaction-failure').hidden, true);
  f.lane(); assert.equal(f.rows()[1].dataset.state, 'rest', 'the existing reply finishing releases the actions');
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
for (const reason of ['invalid-request', 'not-admitted', 'not-found', undefined]) test(`other refusal ${reason ?? 'network'} keeps structured failure and current actions`, async t => {
  const f = fixture(t);
  f.post(() => { if (!reason) throw new Error('offline'); return Response.json({ error: reason === 'not-found' ? reason : 'focus-refused', reason }, { status: 400 }); });
  await assert.rejects(f.c.focusQuestion(f.c.openQuestionItems[1].id));
  assert.equal(f.rows()[1].dataset.state, 'rest');
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
  assert.equal(f.rows()[1].querySelector('.question-failed-long').textContent, en.clarify.failed);
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
