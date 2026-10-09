import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers, createPluginRuntime, SQLiteStorage, SQLiteBudgetLedger } from '../src/index.js';
import { PluginRegistry, createMockReasoning, mockManifest, SessionLanes } from '@inspr/aithema-core';
import { createOpenRouterReasoning } from '../../../plugins/openrouter/src/index.js';
import { binding, chatServer, request } from '../../../test/plugin-fixtures.js';
function qualify(b) {
  return { ...b, legal: { approved: true, countries: ['FR'], training: false, retention: 'host qualified',
    purpose: 'requirements', recipient: 'fixture-provider', processors: ['fixture-processor'],
    dataCategories: ['conversation'], consentVersion: 'v1', evidence: { qualified: true,
      accountRef: b.accountRef, secretRef: b.secretRef, model: b.model, endpoint: b.endpoint,
      routing: b.routing ?? {}, verifiedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000 } } };
}
function setup(t, endpoint = 'http://127.0.0.1:1/chat', extra = {}) {
  const storage = new SQLiteStorage(), session = storage.create({ demo: true }); t.after(() => storage.close());
  const b = qualify(binding('openrouter', endpoint));
  const plugin = createOpenRouterReasoning({ binding: b, resolveSecret: () => 'local-fixture' });
  const registry = new PluginRegistry().register(plugin);
  const presets = Object.fromEntries(['best', 'eu', 'custom'].map(p => [p, { plugins: ['openrouter'],
    bindings: { reaction: b, understanding: b }, policy: { endpoints: [endpoint] } }]));
  const scopes = [], consent = { async coverage(_, scope) { scopes.push(scope); return { scope, checkedAt: Date.now(), expiresAt: Date.now() + 10000 }; } };
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
  h.consent.coverage = async (_, scope) => ({ scope, checkedAt: Date.now(), expiresAt: Date.now() + 1000, withdrawn: true });
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
  assert.equal(h.scopes.length, 2);
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
  invocation.options.attempt.consume(); assert.throws(() => invocation.finish(), /omitted its terminal report/);
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
  const s = await handlers.handle(new Request('http://localhost/api/sessions', { method: 'POST', body: '{"processingPreset":"device"}' })).then(r => r.json());
  assert.equal(s.processingPreset, 'device'); assert.equal(s.featureMatrix.device.voice.reason, 'unavailable on device');
  await handlers.handle(new Request(`http://localhost/api/sessions/${s.id}/turns`, { method: 'POST', body: '{"clientEventId":"x","content":"Hello"}' }));
  await handlers.idle(); assert.equal(calls, 0); assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM budget_attempts').get().n, 0);
  const invalid = await handlers.handle(new Request('http://localhost/api/sessions', { method: 'POST', body: '{"processingPreset":"fallback"}' }));
  assert.equal(invalid.status, 400);
});

test('a paused session or changed consent during admission cannot dispatch or reserve another attempt', async t => {
  const h = setup(t), get = h.storage.get.bind(h.storage); let paused = false;
  h.storage.get = id => ({ ...get(id), paused });
  h.consent.coverage = async (_, scope) => { paused = true; return { scope, checkedAt: Date.now(), expiresAt: Date.now() + 1000 }; };
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
    consent: { coverage: async (_, scope) => ({ scope, checkedAt: instant, expiresAt: instant + 10 }) }, now: () => clock });
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
  for (const fake of [{ ...mock, billable: true, binding: raw }, { ...mock, manifest: structuredClone(mockManifest), binding: raw }]) {
    const runtime = createPluginRuntime({ storage, presets, registry: new PluginRegistry().register(fake) });
    assert.equal((await runtime.matrix(session)).best.text.reason, 'binding evidence unverified');
  }
  assert.equal((await createPluginRuntime({ storage }).matrix(session)).best.text.available, true);
});
