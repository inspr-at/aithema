import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers, createPluginRuntime, mockPresets } from '../src/index.js';
import { createMockReasoning, inputRevision, openQuestionItems, PluginRegistry } from '@inspr/aithema-core';
import { mockConsent, ownedRequest, testToken } from '../../../test/helpers.js';
import { clarifyRefusals } from '../../../test/clarify-refusals.js';

function fixture(t, { healthMs, unhealthy = false, parseFailure = false } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  const now = () => Date.now(), storage = new SQLiteStorage(':memory:', { now });
  const mock = createMockReasoning(), consent = { coverage: args => mockConsent.coverage(args) };
  const presets = mockPresets();
  let registry;
  if (unhealthy) {
    // Synthetic non-canonical plugin: exercise actual health evaluation without a provider.
    const binding = { ...presets.best.bindings.reaction, legal: { approved: true, countries: ['FR'], processingCountries: ['FR'],
      training: false, retention: 'fixture', purpose: 'requirements', recipient: 'fixture-provider', processors: ['fixture-processor'],
      dataCategories: ['conversation'], consentVersion: 'v1', evidence: { qualified: true,
        accountRef: 'demo', secretRef: 'none', model: 'mock', endpoint: 'https://example.test', routing: {},
        verifiedAt: now() - 1000, expiresAt: now() + 60_000 } } };
    presets.best.bindings.reaction = binding;
    presets.best.policy = { endpoints: [binding.endpoint] };
    consent.coverage = ({ scope, consentRevision }) => ({ covered: true, ...scope, scope, consentRevision, checkedAt: now(), expiresAt: now() + 60_000 });
    registry = new PluginRegistry().register({ ...mock, bind: undefined, binding, health: async () => ({ available: false }) });
  }
  const runtime = createPluginRuntime({ storage, reasoning: mock, consent, presets, now,
    ...(registry ? { registry } : {}), ...(healthMs === undefined ? {} : { healthMs }) });
  let calls = 0;
  if (parseFailure) {
    const admit = runtime.admit;
    runtime.admit = async args => ({ ...await admit(args), plugin: { ...mock, async *stream(request, options) {
      calls++;
      for await (const _ of mock.stream(request, options)) { /* canonical receipt lifecycle */ }
      yield '{';
    } } });
  }
  const handlers = createHandlers({ storage, pluginRuntime: runtime, log() {} });
  const session = storage.create({ demo: true, ownerToken: testToken });
  storage.postTurn(session.id, 'person', Buffer.from('person'), 'We need an approval workflow.');
  const current = storage.get(session.id), revision = inputRevision(current);
  storage.append(session.id, 'turn.final', { id: 'reply', role: 'assistant', content: 'What outcome would make this useful?', inputRevision: revision });
  const { contentRef, hash, ...understanding } = current.understanding;
  storage.append(session.id, 'understanding.updated', { ...understanding, openQuestions: ['What outcome would make this useful?'], inputRevision: revision, draft: false });
  const command = { questionId: openQuestionItems(storage.get(session.id))[0].id, inputRevision: revision };
  const route = (body = command) => handlers.handle(ownedRequest(`http://local/api/sessions/${session.id}/focus-question`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  t.after(async () => { await handlers.close(); storage.close(); });
  return { storage, session, runtime, handlers, consent, route, command, calls: () => calls };
}

for (const row of clarifyRefusals) test(`AIT-503 server refusal: ${row.name}`, { timeout: 10_000 }, async t => {
  const f = fixture(t, { unhealthy: row.name === 'plugin unhealthy' });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  if (row.name === 'admission deadline') f.consent.coverage = async args => { entered.resolve(); await release.promise; return mockConsent.coverage(args); };
  if (row.name === 'consent port unavailable') f.consent.coverage = () => { throw new Error('synthetic unavailable port'); };
  if (row.name === 'consent-required') f.consent.coverage = () => ({ covered: false });
  if (row.name.startsWith('budget ')) {
    t.mock.method(f.runtime.budget, 'canAdmit', () => false);
    t.mock.method(f.runtime.budget, 'canAdmitWithoutReconcilingHold', () => row.name === 'budget reconciling');
  }
  if (row.name === 'one-hour') { f.runtime.conversationLimits.start(f.session.id); t.mock.timers.tick(60 * 60_000); }
  const before = f.storage.get(f.session.id).seq;
  const pending = f.route(row.name === 'invalid-request' ? {} : f.command);
  if (row.name === 'admission deadline') { await entered.promise; t.mock.timers.tick(999); t.mock.timers.tick(1); }
  const response = await pending;
  assert.equal(response.status, row.status);
  assert.deepEqual(await response.json(), row.body);
  assert.equal(f.storage.read(f.session.id).some(event => event.type === 'question.focused'), false);
  if (row.name !== 'one-hour') assert.equal(f.storage.get(f.session.id).seq, before);
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM budget_attempts').get().n, 0, 'refused preflight reserves no analysis');
  console.log(`AIT-503 refusal ${row.name}: ${row.status} ${JSON.stringify(row.body)}`);
});

for (const healthMs of [undefined, 2000]) test(`AIT-503 health preflight deadline is ${healthMs ?? 'default 1000'}ms and configurable`, { timeout: 10_000 }, async t => {
  const f = fixture(t, { healthMs }), entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  f.consent.coverage = async args => { entered.resolve(); await release.promise; return mockConsent.coverage(args); };
  let settled = false;
  const pending = f.runtime.checkReply(f.storage.get(f.session.id)).then(reason => { settled = true; return reason; });
  await entered.promise;
  t.mock.timers.tick(999); await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1); await Promise.resolve(); await Promise.resolve();
  if (healthMs === undefined) assert.equal(await pending, 'admission deadline');
  else {
    assert.equal(settled, false, 'the configured longer preflight has not expired at one second');
    release.resolve(); assert.equal(await pending, null);
  }
  assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM budget_attempts').get().n, 0);
});

test('AIT-503 accepted focus can fail parsing later in the reaction lane', { timeout: 10_000 }, async t => {
  const f = fixture(t, { parseFailure: true }), failures = [], failed = Promise.withResolvers();
  const response = await f.handlers.handle(ownedRequest(`http://local/api/sessions/${f.session.id}/events?after=${f.storage.get(f.session.id).seq}`));
  const reader = response.body.getReader();
  const reading = (async () => {
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) return;
      buffer += new TextDecoder().decode(value);
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = block.split('\n').find(line => line.startsWith('data:'));
        if (data) { const event = JSON.parse(data.slice(5)); if (event.type === 'lane.failed') { failures.push(event.data); failed.resolve(); } }
      }
    }
  })();
  t.after(async () => { await reader.cancel(); await reading; });
  const accepted = await f.route();
  assert.equal(accepted.status, 202); assert.equal((await accepted.json()).accepted, true);
  await f.handlers.idle(); await failed.promise;
  assert.ok(f.calls() > 0);
  assert.equal(failures[0].lane, 'reaction'); assert.equal(failures[0].error, 'reasoning-unavailable');
  assert.equal(failures[0].reason, undefined, 'parse details remain sanitized at the server boundary');
  assert.equal(failures[0].retryable, true);
  assert.equal(f.storage.get(f.session.id).transcript.some(turn => turn.focusRequestId), false);
});
