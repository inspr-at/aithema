import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers } from '../src/index.js';
import { createMockReasoning, inputRevision, openQuestionItems, pendingQuestionFocus, PluginError } from '@inspr/aithema-core';
import { mockConsent, testToken, ownedRequest } from '../../../test/helpers.js';
import { instrumentedMockRuntime } from '../../../test/server-fixtures.js';
import { purposePolicy } from '../../../test/safeguards-corpus.js';

function fixture(t, { consent = mockConsent, policy = false, hold, failOnce = false } = {}) {
  const storage = new SQLiteStorage(), calls = [], admissions = [];
  const reasoning = { ...createMockReasoning(), async *stream(request) {
    calls.push(request); await hold?.promise;
    if (failOnce) { failOnce = false; throw new Error('fixture failure'); }
    yield JSON.stringify({ content: 'Which launch date should we plan for?', question_short: 'Launch date?', options: [], ...(policy ? { scope: 'in' } : {}) });
  } };
  const runtime = instrumentedMockRuntime(storage, reasoning, consent);
  const admit = runtime.admit;
  runtime.admit = args => { admissions.push(args); return admit(args); };
  const handlers = createHandlers({ storage, reasoning, pluginRuntime: runtime, ...(policy ? { purposePolicy } : {}) });
  const session = storage.create({ ownerToken: testToken, demo: true });
  storage.postTurn(session.id, 'person', Buffer.from('person'), 'We need a website.');
  const revision = inputRevision(storage.get(session.id));
  storage.append(session.id, 'turn.final', { id: 'ordinary', role: 'assistant', content: 'Who is it for?', inputRevision: revision });
  const assess = (questions = ['Who is it for?', 'When should it launch?']) => {
    const current = storage.get(session.id);
    storage.append(session.id, 'understanding.updated', { ...current.understanding, openQuestions: questions, inputRevision: inputRevision(current), draft: false });
  };
  assess();
  if (policy) storage.recordSafeguard(session.id, 'person', revision, false, purposePolicy.offTopicLimit);
  const route = (action, body, token = testToken) => handlers.handle(ownedRequest(`http://local/api/sessions/${session.id}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': token }, body: JSON.stringify(body),
  }));
  const command = () => ({ questionId: openQuestionItems(storage.get(session.id))[1]?.id, inputRevision: inputRevision(storage.get(session.id)) });
  t.after(async () => { hold?.resolve(); await handlers.close(); storage.close(); });
  return { storage, handlers, runtime, session, calls, admissions, assess, route, command };
}
const held = () => Promise.withResolvers();
async function entered(f) {
  for (let i = 0; i < 100; i++) { if (f.calls.length) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('reply did not start');
}

for (const policy of [false, true]) test(`non-first focus bypasses the completed reaction cache through admission (purpose=${policy})`, async t => {
  const f = fixture(t, { policy }), before = f.storage.get(f.session.id), command = f.command();
  const response = await f.route('focus-question', command);
  assert.equal(response.status, 202);
  const { event } = await response.json();
  assert.equal(event.type, 'question.focused'); assert.equal(event.data.chosenBy, 'user');
  assert.equal(event.data.questionId, command.questionId); assert.equal(event.data.question, 'When should it launch?');
  await f.handlers.idle();
  const after = f.storage.get(f.session.id), reply = after.transcript.at(-1);
  assert.equal(f.calls.length, 1); assert.equal(f.admissions.length, 1);
  assert.equal(f.admissions[0].lane, 'reaction'); assert.equal(f.admissions[0].operation, 'stream');
  assert.match(f.calls[0].system, /explicitly selected[^\n]*When should it launch\?/u);
  assert.equal(f.calls[0].messages.filter(m => m.role === 'user').length, 2, 'only existing context and person turn');
  assert.deepEqual(after.transcript.filter(x => x.role === 'user'), before.transcript.filter(x => x.role === 'user'));
  assert.equal(after.inputRevision, before.inputRevision);
  assert.equal(reply.focusRequestId, event.data.requestId); assert.equal(reply.role, 'assistant');
  assert.equal(pendingQuestionFocus(after), null);
  assert.equal(f.storage.read(after.id).find(x => x.type === 'question.focused').data.chosenBy, 'user');
  const stream = await f.handlers.handle(ownedRequest(`http://local/api/sessions/${after.id}/events?after=${after.seq}`));
  await stream.body.cancel(); await f.handlers.idle();
  assert.equal(f.calls.length, 1, 'reconnect cannot repeat the selected reply');
});

test('duplicates are refused while a selected reply is in flight', async t => {
  const hold = held(), f = fixture(t, { hold });
  assert.equal((await f.route('focus-question', f.command())).status, 202); await entered(f);
  const duplicate = await f.route('focus-question', f.command());
  assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).reason, 'reply-in-flight');
  hold.resolve(); await f.handlers.idle(); assert.equal(f.calls.length, 1);
});

for (const state of ['removed', 'clarified', 'replaced', 'withdrawn', 'paused', 'stale-revision', 'no-consent', 'wrong-owner', 'invalid']) {
  test(`focus refuses ${state} without publishing or dispatch`, async t => {
    const consent = state === 'no-consent' ? { coverage: () => ({ covered: false }) } : mockConsent;
    const f = fixture(t, { consent }), command = f.command();
    if (state === 'removed') f.assess(['Who is it for?']);
    if (state === 'clarified') f.assess([]);
    if (state === 'replaced') f.assess(['Who is it for?', 'What is the budget?']);
    if (state === 'withdrawn') f.storage.withdraw(f.session.id, 'person');
    if (state === 'paused') f.storage.pause(f.session.id, true);
    if (state === 'stale-revision') f.storage.postTurn(f.session.id, 'new', Buffer.from('new'), 'A new answer');
    if (state === 'invalid') delete command.inputRevision;
    // Even a caller using the new revision cannot reuse an ID derived from withdrawn evidence.
    if (state === 'withdrawn') command.inputRevision = inputRevision(f.storage.get(f.session.id));
    const before = f.storage.get(f.session.id).seq;
    const response = await f.route('focus-question', command, state === 'wrong-owner' ? 'someone-else' : testToken);
    assert.equal(response.status, state === 'wrong-owner' ? 404 : state === 'invalid' ? 400 : state === 'no-consent' ? 403 : 409);
    const reasons = { removed: 'stale-question', clarified: 'stale-question', replaced: 'stale-question', withdrawn: 'stale-question', paused: 'paused', 'stale-revision': 'stale-revision', 'no-consent': 'consent-required', invalid: 'invalid-request' };
    if (reasons[state]) assert.equal((await response.json()).reason, reasons[state]);
    assert.equal(f.storage.get(f.session.id).seq, before); assert.equal(f.calls.length, 0);
  });
}

test('a concurrent request cannot pass availability work; withdrawal is rechecked afterwards', async t => {
  const gate = held(), seen = held(); let waiting = false;
  const consent = { async coverage(args) { if (waiting) { seen.resolve(); await gate.promise; } return mockConsent.coverage(args); } };
  const f = fixture(t, { consent }); waiting = true;
  const command = f.command(), pending = f.route('focus-question', command); await seen.promise;
  const duplicate = await f.route('focus-question', command);
  assert.equal((await duplicate.json()).reason, 'reply-in-flight');
  f.storage.withdraw(f.session.id, 'person'); gate.resolve();
  const response = await pending; assert.equal(response.status, 409);
  assert.equal(f.calls.length, 0);
});

test('real reaction budget admission can refuse focus, and retry retains the chosen question', async t => {
  const f = fixture(t), admitBudget = f.runtime.budget.admit.bind(f.runtime.budget);
  f.runtime.budget.admit = () => { throw new PluginError('not-admitted', 'Budget denied'); };
  assert.equal((await f.route('focus-question', f.command())).status, 202);
  await f.handlers.idle(); assert.equal(f.calls.length, 0);
  assert.equal(f.storage.laneFailures(f.session.id)[0].lane, 'reaction');
  assert.ok(pendingQuestionFocus(f.storage.get(f.session.id)));
  f.runtime.budget.admit = admitBudget;
  assert.equal((await f.route('retry', {})).status, 202); await f.handlers.idle();
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].system, /When should it launch\?/u);
  assert.equal(f.storage.get(f.session.id).transcript.filter(x => x.role === 'user').length, 1);
});

for (const change of ['withdraw', 'pause']) test(`${change} while the focused reply is held fences its late final`, async t => {
  const hold = held(), f = fixture(t, { hold });
  await f.route('focus-question', f.command()); await entered(f);
  if (change === 'withdraw') f.storage.withdraw(f.session.id, 'person');
  else f.storage.pause(f.session.id, true);
  hold.resolve(); await f.handlers.idle();
  assert.equal(f.storage.get(f.session.id).transcript.some(x => x.focusRequestId), false);
  if (change === 'withdraw') {
    const event = f.storage.read(f.session.id).find(x => x.type === 'question.focused');
    assert.equal(event.data.erased, true);
    assert.equal(f.storage.get(f.session.id).questionFocus, null);
  }
});
