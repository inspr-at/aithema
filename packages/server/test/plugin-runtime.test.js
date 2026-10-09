import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers, createPluginRuntime, SQLiteStorage, SQLiteBudgetLedger } from '../src/index.js';
import { PluginRegistry, createMockReasoning, mockManifest, SessionLanes } from '@inspr/aithema-core';
import { createOpenRouterReasoning } from '../../../plugins/openrouter/src/index.js';
import { ownedRequest, testToken, mockConsent } from '../../../test/helpers.js';
import { binding, chatServer, request, consumeInFinallyReasoning, openRouterPrices } from '../../../test/plugin-fixtures.js';
function qualify(b) {
  return { ...b, legal: { approved: true, countries: ['FR'], training: false, retention: 'host qualified',
    purpose: 'requirements', recipient: 'fixture-provider', processors: ['fixture-processor'],
    dataCategories: ['conversation'], consentVersion: 'v1', evidence: { qualified: true,
      accountRef: b.accountRef, secretRef: b.secretRef, model: b.model, endpoint: b.endpoint,
      routing: b.routing ?? {}, verifiedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000 } } };
}
function setup(t, endpoint = 'http://127.0.0.1:1/chat', extra = {}) {
  const storage = new SQLiteStorage(), session = storage.create({ demo: true, ownerToken: testToken }); t.after(() => storage.close());
  const b = qualify(binding('openrouter', endpoint));
  const plugin = createOpenRouterReasoning({ binding: b, prices: openRouterPrices, resolveSecret: () => 'local-fixture' });
  const registry = new PluginRegistry().register(plugin);
  const presets = Object.fromEntries(['best', 'eu', 'custom'].map(p => [p, { plugins: ['openrouter'],
    bindings: { reaction: b, understanding: b }, policy: { endpoints: [endpoint] } }]));
  const scopes = [], consent = { async coverage({ scope, consentRevision }) { scopes.push(scope); return { covered: true, ...scope, consentRevision, scope, checkedAt: Date.now(), expiresAt: Date.now() + 10000 }; } };
  const runtime = createPluginRuntime({ storage, registry, presets, consent, ...extra });
  return { storage, session, b, plugin, presets, scopes, runtime, registry, consent };
}
test('matrix reflects each preset and exact binding, with explicit unavailable reasons', async t => {
  const h = setup(t); let matrix = await h.runtime.matrix(h.session);
  assert.equal(matrix.best.text.available, true); assert.equal(matrix.eu.analysis.available, true);
  assert.equal(matrix.best.voice.reason, 'not configured'); assert.equal(matrix.device.analysis.reason, 'unavailable on device');
  assert.equal(matrix.device.text.available, true);
  h.presets.eu.bindings.understanding = { ...h.b, legal: { ...h.b.legal, countries: ['US'] } };
  matrix = await h.runtime.matrix(h.session);
  assert.equal(matrix.eu.analysis.reason, 'processing residency denied'); assert.equal(matrix.eu.text.available, true);
  const serialized = JSON.stringify(matrix); assert.equal(serialized.includes('FIXTURE_ONLY'), false); assert.equal(serialized.includes('fixture-account'), false);
});
test('admission fails closed for missing/mismatched/expired evidence, consent, health and preset membership', async t => {
  const h = setup(t);
  for (const [change, reason] of [
    [b => delete b.legal, 'binding evidence unverified'],
    [b => b.legal.evidence.accountRef = 'other', 'binding evidence mismatch'],
    [b => b.legal.evidence.expiresAt = Date.now() - 1, 'binding evidence expired'],
    [b => b.legal.evidence.verifiedAt = Date.now() + 5000, 'binding evidence not yet valid'],
    [b => b.endpoint = 'https://other.example', 'binding evidence mismatch'],
    [b => b.model = 'other/model', 'binding evidence mismatch'],
    [b => b.legal.training = true, 'training policy denied'],
  ]) {
    const invalid = structuredClone(h.b); change(invalid); h.presets.eu.bindings.reaction = invalid;
    assert.equal((await h.runtime.matrix(h.session)).eu.text.reason, reason);
  }
  h.presets.eu.bindings.reaction = h.b;
  h.presets.best.plugins = []; assert.equal((await h.runtime.matrix(h.session)).best.text.reason, 'plugin not in preset');
  h.presets.best.plugins = ['openrouter'];
  const noConsent = createPluginRuntime({ storage: h.storage, registry: h.registry, presets: h.presets });
  assert.equal((await noConsent.matrix(h.session)).best.text.reason, 'consent port unavailable');
  for (const coverage of [true, { scope: {}, checkedAt: Date.now(), expiresAt: Date.now() + 1000 },
    { checkedAt: Date.now(), expiresAt: Date.now() - 1 }]) {
    h.consent.coverage = async () => coverage;
    assert.equal((await h.runtime.matrix(h.session)).best.text.reason, 'current processing consent required');
  }
  h.consent.coverage = async ({ scope, consentRevision }) => ({ covered: true, ...scope, consentRevision, scope, checkedAt: Date.now(), expiresAt: Date.now() + 1000, withdrawn: true });
  assert.equal((await h.runtime.matrix(h.session)).best.text.reason, 'current processing consent required');
  assert.equal((await h.runtime.matrix({ ...h.session, paused: true })).eu.text.reason, 'session paused');
});
test('both lanes settle a distinct attempt, recheck consent and charge tokens using the selected bindings', async t => {
  const fake = await chatServer(t), h = setup(t, fake.endpoint);
  // understanding uses a distinct effective model, tested in outbound bytes rather than a family default.
  const other = qualify({ ...h.b, model: 'fixture/understanding' }); h.presets.best.bindings.understanding = other;
  for (const [lane, operation] of [['reaction', 'stream'], ['understanding', 'structured']]) {
    const invocation = await h.runtime.admit({ session: h.session, lane, operation, request,
      options: { signal: new AbortController().signal, deadlineAt: Date.now() + 1000 } });
    if (operation === 'stream') for await (const delta of invocation.plugin.stream(request, invocation.options)) assert.equal(delta, 'Hello');
    else await invocation.plugin.structured(request, invocation.options);
    invocation.finish();
  }
  const rows = h.storage.db.prepare('SELECT * FROM budget_attempts').all();
  assert.equal(rows.length, 2); assert.notEqual(rows[0].claim_id, rows[1].claim_id);
  assert.ok(rows.every(r => r.state === 'settled' && r.settled_micro === 11));
  assert.deepEqual(fake.bodies.map(b => b.model), ['fixture/model', 'fixture/understanding']);
  assert.equal(h.scopes.length, 4);
  h.consent.coverage = async () => { throw new Error('offline'); };
  await assert.rejects(h.runtime.admit({ session: h.session, lane: 'reaction', operation: 'stream', request,
    options: { signal: new AbortController().signal, deadlineAt: Date.now() + 1000 } }), /consent port unavailable/);
  assert.equal(h.storage.db.prepare('SELECT COUNT(*) AS n FROM budget_attempts').get().n, 2);
});
test('admission timeout and budget denial never open providers; a missing terminal settles conservatively', async t => {
  const h = setup(t), budget = new SQLiteBudgetLedger(h.storage, { sessionCapMicro: 1500 });
  const runtime = createPluginRuntime({ storage: h.storage, registry: h.registry, presets: h.presets, consent: h.consent, budget });
  const invocation = await runtime.admit({ session: h.session, lane: 'reaction', operation: 'stream', request,
    options: { signal: new AbortController().signal, deadlineAt: Date.now() + 1000 } });
  await invocation.options.attempt.consume(); assert.throws(() => invocation.finish(), /omitted its terminal report/);
  assert.equal(budget.used(h.session.id), 1000); assert.equal((await runtime.matrix(h.session)).best.text.reason, 'budget denied');
  const stalled = createPluginRuntime({ storage: h.storage, registry: h.registry, presets: h.presets,
    consent: { coverage: () => new Promise(() => {}) }, healthMs: 5 });
  assert.equal((await stalled.matrix(h.session)).best.text.reason, 'admission deadline');
});
test('device sessions cannot run server lanes; creation/snapshot exposes only safe feature verdicts', async t => {
  const storage = new SQLiteStorage(), mock = createMockReasoning(); let calls = 0;
  const handlers = createHandlers({ storage, reasoning: { ...mock, async *stream(...args) { calls++; yield* mock.stream(...args); },
    async structured(...args) { calls++; return mock.structured(...args); } } });
  t.after(async () => { await handlers.close(); storage.close(); });
  const s = await handlers.handle(ownedRequest('http://localhost/api/sessions', { method: 'POST', body: '{"processingPreset":"device"}' })).then(r => r.json());
  assert.equal(s.processingPreset, 'device'); assert.equal(s.featureMatrix.device.voice.reason, 'unavailable on device');
  await handlers.handle(ownedRequest(`http://localhost/api/sessions/${s.id}/turns`, { method: 'POST', body: '{"clientEventId":"x","content":"Hello"}' }));
  await handlers.idle(); assert.equal(calls, 0); assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM budget_attempts').get().n, 0);
  const invalid = await handlers.handle(ownedRequest('http://localhost/api/sessions', { method: 'POST', body: '{"processingPreset":"fallback"}' }));
  assert.equal(invalid.status, 400);
});

test('a paused session or changed consent during admission cannot dispatch or reserve another attempt', async t => {
  const h = setup(t), get = h.storage.get.bind(h.storage); let paused = false;
  h.storage.get = id => ({ ...get(id), paused });
  h.consent.coverage = async ({ scope, consentRevision }) => { paused = true; return { covered: true, ...scope, consentRevision, scope, checkedAt: Date.now(), expiresAt: Date.now() + 1000 }; };
  await assert.rejects(h.runtime.admit({ session: h.session, lane: 'reaction', operation: 'stream', request,
    options: { signal: new AbortController().signal, deadlineAt: Date.now() + 1000 } }), /Session changed/);
  assert.equal(h.storage.db.prepare('SELECT COUNT(*) AS n FROM budget_attempts').get().n, 0);
});

test('request token/rate ceiling is computed on the effective binding before budget claim', async t => {
  const h = setup(t);
  h.presets.best.bindings.reaction = { ...h.b, maxMicro: 10 };
  await assert.rejects(h.runtime.admit({ session: h.session, lane: 'reaction', operation: 'stream', request,
    options: { signal: new AbortController().signal, deadlineAt: Date.now() + 1000 } }), /cost ceiling/);
  assert.equal(h.storage.db.prepare('SELECT COUNT(*) AS n FROM budget_attempts').get().n, 0);
});

test('health failures disable features; consent expiring while health runs fails closed', async t => {
  const h = setup(t), entry = h.registry.get('openrouter');
  entry.bind = binding => ({ ...h.plugin.bind(binding), health: async () => ({ available: false }) });
  assert.equal((await h.runtime.matrix(h.session)).best.text.reason, 'plugin unhealthy');
  const instant = Date.now(); let clock = instant;
  const runtime = createPluginRuntime({ storage: h.storage, registry: h.registry, presets: h.presets,
    consent: { coverage: async ({ scope, consentRevision }) => ({ covered: true, ...scope, consentRevision, scope, checkedAt: instant, expiresAt: instant + 10 }) }, now: () => clock });
  entry.bind = binding => ({ ...h.plugin.bind(binding), health: async () => { clock = instant + 11; return { available: true }; } });
  assert.equal((await runtime.matrix(h.session)).best.text.reason, 'current processing consent required');
});

test('pause between admission and consume cancels for zero cost and preserves the refusal in both lanes', async t => {
  const fake = await chatServer(t), h = setup(t, fake.endpoint);
  h.presets.best.bindings = { reaction: { ...h.b, maxMicro: 50_000 }, understanding: { ...h.b, maxMicro: 50_000 } };
  h.storage.postTurn(h.session.id, 'first', Buffer.from('first'), 'Hello');
  const get = h.storage.get.bind(h.storage); let paused = false;
  h.storage.get = id => ({ ...get(id), paused });
  const lanes = new SessionLanes({ reasoning: h.plugin, getSession: h.storage.get,
    publish() { assert.fail('refused work must not publish'); },
    async admit(args) { const admitted = await h.runtime.admit(args); paused = true; return admitted; } });
  for (const lane of ['reaction', 'understanding']) {
    paused = false;
    await assert.rejects(lanes.run(h.session.id, lane), { code: 'not-admitted', message: 'Session changed before dispatch' });
  }
  assert.equal(fake.bodies.length, 0);
  const rows = h.storage.db.prepare('SELECT * FROM budget_attempts').all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.state === 'settled' && r.outcome === 'cancelled' && r.settled_micro === 0));
  assert.ok(rows.every(r => JSON.parse(r.usage).inputTokens === 0 && JSON.parse(r.usage).outputTokens === 0));
});

test('missing terminal before consume releases the claim; finish preserves a pending plugin error', async t => {
  const h = setup(t);
  const invocation = await h.runtime.admit({ session: h.session, lane: 'reaction', operation: 'stream', request, options: {} });
  assert.throws(() => invocation.finish(), /omitted its terminal report/);
  assert.equal(h.runtime.budget.used(h.session.id), 0);
  h.presets.best.bindings = { reaction: { ...h.b, maxMicro: 50_000 }, understanding: { ...h.b, maxMicro: 50_000 } };
  h.storage.postTurn(h.session.id, 'first', Buffer.from('first'), 'Hello');
  const original = new Error('original failure');
  const plugin = { ...h.plugin, async *stream() { throw original; }, async structured() { throw original; } };
  const lanes = new SessionLanes({ reasoning: plugin, getSession: id => h.storage.get(id), publish() { assert.fail(); },
    async admit(args) { const admitted = await h.runtime.admit(args); return { ...admitted, plugin }; } });
  for (const lane of ['reaction', 'understanding']) await assert.rejects(lanes.run(h.session.id, lane), error => error === original);
  assert.equal(h.runtime.budget.used(h.session.id), 0);
});

test('schema and provider option bytes must fit the cost ceiling before reserving', async t => {
  const h = setup(t);
  for (const oversized of [{ ...request, schema: { ...request.schema, description: 'x'.repeat(1500) } },
    { ...request, providerOptions: { hint: 'x'.repeat(1500) } }]) {
    await assert.rejects(h.runtime.admit({ session: h.session, lane: 'understanding', operation: 'structured', request: oversized, options: {} }), /cost ceiling/);
  }
  const routed = qualify({ ...h.b, routing: { order: ['x'.repeat(1500)] } });
  h.presets.best.bindings.reaction = routed;
  await assert.rejects(h.runtime.admit({ session: h.session, lane: 'reaction', operation: 'stream', request, options: {} }), /cost ceiling/);
  assert.equal(h.storage.db.prepare('SELECT COUNT(*) AS n FROM budget_attempts').get().n, 0);
});

test('only the nonbillable canonical mock identity is exempt from qualification and consent', async t => {
  const storage = new SQLiteStorage(), session = storage.create(); t.after(() => storage.close());
  const mock = createMockReasoning(), raw = { ...binding('mock', 'https://example.test'), maxMicro: 0, rates: { inputMicro: 0, outputMicro: 0 } };
  const presets = { best: { plugins: ['mock'], bindings: { reaction: raw } } };
  for (const fake of [{ ...mock, billable: true, binding: raw }, { ...mock, manifest: structuredClone(mockManifest), binding: raw },
    { ...mock, manifest: mockManifest, billable: false, binding: raw }]) {
    const runtime = createPluginRuntime({ storage, presets, registry: new PluginRegistry().register(fake) });
    assert.equal((await runtime.matrix(session)).best.text.reason, 'binding evidence unverified');
  }
  assert.equal((await createPluginRuntime({ storage }).matrix(session)).best.text.available, true);
});

test('consume inside plugin try/finally preserves runtime refusal and only identical cancelled-zero repeats are no-ops', async t => {
  const fake = await chatServer(t), h = setup(t, fake.endpoint);
  const get = h.storage.get.bind(h.storage); let paused = false;
  h.storage.get = id => ({ ...get(id), paused });
  const plugin = consumeInFinallyReasoning(h.plugin);
  for (const [lane, operation] of [['reaction', 'stream'], ['understanding', 'structured']]) {
    paused = false;
    const invocation = await h.runtime.admit({ session: h.session, lane, operation, request, options: {} });
    paused = true;
    const run = operation === 'stream' ? plugin.stream(request, invocation.options).next() : plugin.structured(request, invocation.options);
    await assert.rejects(run, { code: 'not-admitted', message: 'Session changed before dispatch' });
    invocation.finish({ failed: true });
    const terminal = { usage: { outputTokens: 0, inputTokens: 0 }, outcome: 'cancelled', attemptId: invocation.options.attempt.attemptId };
    assert.doesNotThrow(() => invocation.options.report(terminal));
    for (const conflicting of [{ ...terminal, attemptId: 'wrong' }, { ...terminal, outcome: 'uncertain' },
      { ...terminal, usage: { inputTokens: 1, outputTokens: 0 } }, { ...terminal, extra: true }]) {
      assert.throws(() => invocation.options.report(conflicting), { code: 'already-claimed' });
    }
    assert.throws(() => invocation.options.attempt.consume(), { code: 'already-claimed' });
  }
  paused = false;
  const dispatched = await h.runtime.admit({ session: h.session, lane: 'reaction', operation: 'stream', request, options: {} });
  await dispatched.options.attempt.consume();
  const terminal = { attemptId: dispatched.options.attempt.attemptId, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } };
  dispatched.options.report(terminal);
  assert.throws(() => dispatched.options.report(terminal), { code: 'already-claimed' }, 'ordinary plugin reports retain the one-terminal guard');
  assert.equal(fake.bodies.length, 0);
  const rows = h.storage.db.prepare('SELECT * FROM budget_attempts').all();
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.state === 'settled' && row.outcome === 'cancelled' && row.settled_micro === 0));
});

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const grantFor = ({ scope, consentRevision }) => ({ covered: true, ...scope, scope, consentRevision,
  checkedAt: Date.now(), expiresAt: Date.now() + 10_000 });

test('durable pause acknowledged during admission prevents reservation and survives cached reads', async t => {
  const h = setup(t), started = deferred(), gate = deferred();
  h.consent.coverage = async query => { started.resolve(); await gate.promise; return grantFor(query); };
  const handlers = createHandlers({ storage: h.storage, pluginRuntime: h.runtime });
  try {
    const admission = h.runtime.admit({ session: h.session, lane: 'reaction', operation: 'stream', request, options: {} });
    await started.promise;
    const response = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${h.session.id}/pause`, {
      method: 'POST', body: '{"paused":true}' }));
    assert.equal(response.status, 200); assert.equal((await response.json()).paused, true);
    assert.equal(h.storage.get(h.session.id).paused, true);
    gate.resolve(); await assert.rejects(admission, /Session changed during admission/);
    assert.equal(h.storage.db.prepare('SELECT COUNT(*) AS n FROM budget_attempts').get().n, 0);
    assert.equal((await h.runtime.matrix(h.storage.get(h.session.id))).best.text.reason, 'session paused');
    assert.equal((await handlers.handle(ownedRequest(`http://localhost/api/sessions/${h.session.id}`))).status, 200);
  } finally { gate.resolve(); await handlers.close(); }
});

test('consume asks the same consent port again and an external withdrawal releases an undispatched claim', async t => {
  const h = setup(t), queries = []; let granted = true;
  h.consent.coverage = async query => { queries.push(query); return { ...grantFor(query), covered: granted }; };
  const invocation = await h.runtime.admit({ session: h.session, lane: 'reaction', operation: 'stream', request, options: {} });
  granted = false;
  await assert.rejects(invocation.options.attempt.consume(), /current processing consent required/);
  invocation.finish({ failed: true });
  assert.equal(queries.length, 2); assert.deepEqual(queries[0], queries[1]);
  assert.equal(queries[0].sessionId, h.session.id);
  assert.deepEqual(queries[0].scope.recipients, ['fixture-provider']);
  assert.deepEqual(queries[0].scope.upstreamProcessors, ['fixture-processor']);
  assert.equal(queries[0].scope.itemVersion, 'v1');
  const row = h.runtime.budget.get(invocation.options.attempt.attemptId);
  assert.equal(row.state, 'settled'); assert.equal(row.outcome, 'cancelled'); assert.equal(row.settled_micro, 0);
});

test('pause while consume awaits fresh coverage cannot burn or dispatch the reserved claim', async t => {
  const h = setup(t), started = deferred(), gate = deferred(); let calls = 0;
  h.consent.coverage = async query => {
    if (++calls === 2) { started.resolve(); await gate.promise; }
    return grantFor(query);
  };
  const invocation = await h.runtime.admit({ session: h.session, lane: 'reaction', operation: 'stream', request, options: {} });
  const consumption = invocation.options.attempt.consume(); await started.promise;
  h.storage.pause(h.session.id, true); gate.resolve();
  await assert.rejects(consumption, /Session changed before dispatch/);
  invocation.finish({ failed: true });
  const row = h.runtime.budget.get(invocation.options.attempt.attemptId);
  assert.equal(row.state, 'settled'); assert.equal(row.outcome, 'cancelled'); assert.equal(row.settled_micro, 0);
  assert.throws(() => invocation.options.attempt.consume(), { code: 'already-claimed' });
});

test('ownership, revision and tombstone guards precede consent and budget admission', async t => {
  const h = setup(t); let calls = 0;
  h.consent.coverage = async query => { calls++; return grantFor(query); };
  const admit = session => h.runtime.admit({ session, lane: 'reaction', operation: 'stream', request, options: {} });
  await assert.rejects(admit({ ...h.session, ownerHash: 'another-owner' }), /Session changed/);
  h.storage.postTurn(h.session.id, 'new-input', Buffer.from('new-input'), 'New input');
  await assert.rejects(admit(h.session), /Session changed/);
  const current = h.storage.get(h.session.id); h.storage.erase(h.session.id);
  await assert.rejects(admit(current), /Session changed/);
  assert.equal(calls, 0);
  assert.equal(h.storage.db.prepare('SELECT COUNT(*) AS n FROM budget_attempts').get().n, 0);
});

for (const action of ['consent', 'withdraw', 'erase']) for (const lane of ['reaction', 'understanding']) {
  for (const knownUsage of [false, true]) test(`${action} during dispatched ${lane} settles ${knownUsage ? 'known usage as cancelled' : 'unknown usage as uncertain'} before a late result`, async t => {
    const { beginInvocation } = await import('@inspr/aithema-core');
    const h = setup(t), started = deferred(), gate = deferred();
    h.presets.best.bindings = { reaction: { ...h.b, maxMicro: 50_000 }, understanding: { ...h.b, maxMicro: 50_000 } };
    h.storage.postTurn(h.session.id, 'input', Buffer.from('withdrawn fixture'), 'Withdrawn fixture');
    const invoke = async options => {
      const invocation = await beginInvocation(options); invocation.dispatch();
      if (knownUsage) invocation.usage({ inputTokens: 3, outputTokens: 4 });
      started.resolve();
      try { await gate.promise; return { summary: 'late result' }; }
      finally { await invocation.finish(); }
    };
    h.registry.get('openrouter').bind = binding => ({ ...h.plugin.bind(binding),
      structured: (_, options) => invoke(options), async *stream(_, options) { await invoke(options); yield 'late reply'; } });
    const handlers = createHandlers({ storage: h.storage, pluginRuntime: h.runtime });
    try {
      const run = handlers.lanes.run(h.session.id, lane); run.catch(() => {}); await started.promise;
      const body = action === 'consent' ? { granted: false } : action === 'withdraw' ? { turnId: 'input' } : {};
      const response = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${h.session.id}/${action}`, {
        method: 'POST', body: JSON.stringify(body) }));
      assert.equal(response.status, 200);
      const rows = h.storage.db.prepare('SELECT * FROM budget_attempts').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].state, 'settled', 'acknowledgement leaves no open attempt');
      assert.equal(rows[0].outcome, knownUsage ? 'cancelled' : 'uncertain');
      assert.equal(rows[0].settled_micro, knownUsage ? 11 : 50_000);
      await run.catch(() => {}); await handlers.idle();
      const seq = h.storage.get(h.session.id).seq;
      gate.resolve(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.storage.get(h.session.id).seq, seq);
      assert.equal(h.storage.get(h.session.id).understanding.inputRevision, null);
      assert.equal(h.storage.get(h.session.id).transcript.some(turn => turn.content === 'late reply'), false);
      assert.equal(h.storage.db.prepare("SELECT COUNT(*) AS n FROM budget_attempts WHERE state!='settled'").get().n, 0);
    } finally { gate.resolve(); await handlers.close(); }
  });
}

for (const lane of ['reaction', 'understanding']) test(`withdrawal settles a dispatched ${lane} plugin that ignores abort and omits its terminal until later`, async t => {
  const h = setup(t), started = deferred(), gate = deferred();
  h.presets.best.bindings = { reaction: { ...h.b, maxMicro: 50_000 }, understanding: { ...h.b, maxMicro: 50_000 } };
  h.storage.postTurn(h.session.id, 'input', Buffer.from('held input'), 'Held input');
  const held = async options => {
    await options.attempt.consume(); started.resolve(); await gate.promise;
    options.report({ attemptId: options.attempt.attemptId, outcome: 'completed', usage: { inputTokens: 1, outputTokens: 1 } });
    return { summary: 'late' };
  };
  h.registry.get('openrouter').bind = binding => ({ ...h.plugin.bind(binding),
    structured: (_, options) => held(options), async *stream(_, options) { await held(options); yield 'late'; } });
  const handlers = createHandlers({ storage: h.storage, pluginRuntime: h.runtime });
  try {
    const run = handlers.lanes.run(h.session.id, lane); run.catch(() => {}); await started.promise;
    const response = await handlers.handle(ownedRequest(`http://localhost/api/sessions/${h.session.id}/withdraw`, {
      method: 'POST', body: '{"turnId":"input"}' }));
    assert.equal(response.status, 200);
    const row = h.storage.db.prepare('SELECT * FROM budget_attempts').get();
    assert.equal(row.state, 'settled'); assert.equal(row.outcome, 'uncertain'); assert.equal(row.settled_micro, 50_000);
    const seq = h.storage.get(h.session.id).seq;
    gate.resolve(); await run.catch(() => {}); await handlers.idle(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.storage.get(h.session.id).seq, seq);
    assert.equal(h.runtime.budget.get(row.attempt_id).outcome, 'uncertain', 'late usage cannot reduce settled uncertain spend');
  } finally { gate.resolve(); await handlers.close(); }
});

test('session handlers require one shared consent port even with a supplied canonical mock runtime', () => {
  const storage = new SQLiteStorage();
  try {
    const runtime = createPluginRuntime({ storage });
    assert.throws(() => createHandlers({ storage, pluginRuntime: runtime }), /same consent port/);
    const withConsent = createPluginRuntime({ storage, consent: mockConsent });
    assert.throws(() => createHandlers({ storage, pluginRuntime: withConsent, consent: { ...mockConsent } }), /same consent port/);
  } finally { storage.close(); }
});
