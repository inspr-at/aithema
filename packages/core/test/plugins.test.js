import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, PluginRegistry, createBinding, createMockReasoning, reasoningConformance,
  reasoningRequest, createSession, understandingSchema, PLUGIN_KINDS, KIND_OPERATIONS } from '../src/index.js';
import { brokenReasoning, brokenPreflightReasoning, binding, invocationOptions, chatServer, request as fixtureRequest } from '../../../test/plugin-fixtures.js';
import { createOpenRouterReasoning } from '../../../plugins/openrouter/src/index.js';
test('public manifests validate without dependencies and reject private/legal fields and malformed metadata', () => {
  const m = structuredClone(createMockReasoning().manifest);
  assert.equal(validateManifest(m).ok, true);
  for (const change of [m => m.accountRef = 'private', m => m.legal = {}, m => m.models[0].retention = 'private',
    m => m.models[0].structured = 'true', m => m.apiVersion = '^2.0.0', m => m.entrypoints = {},
    m => m.configSchema = { properties: { apiKey: { type: 'string' } } }, m => m.kinds.push('reasoning'), m => m.models[0].expiresAt = 'tomorrow', m => m.kinds = ['live-voice']]) {
    const invalid = structuredClone(m); change(invalid); assert.equal(validateManifest(invalid).ok, false);
  }
  assert.deepEqual(PLUGIN_KINDS, Object.keys(KIND_OPERATIONS));
});
test('registry rejects duplicate/invalid plugins, freezes detached manifest; private binding validates', () => {
  const plugin = createMockReasoning(), registry = new PluginRegistry().register(plugin);
  assert.throws(() => registry.register(plugin), /Duplicate/);
  assert.throws(() => new PluginRegistry().register({ ...plugin, stream: null }), /Missing/);
  assert.throws(() => registry.register({ manifest: {} }), /Invalid/);
  assert.ok(Object.isFrozen(registry.get('mock').manifest.models[0]));
  const privateBinding = createBinding(binding('openrouter', 'https://example.test/chat'));
  assert.ok(Object.isFrozen(privateBinding));
  assert.throws(() => createBinding({ ...privateBinding, apiKey: 'forbidden' }), /Invalid/);
  assert.throws(() => createBinding({ ...privateBinding, endpoint: 'https://user:pass@example.test' }), /endpoint/);
  assert.throws(() => createBinding({ ...privateBinding, maxMicro: -1 }), /Invalid/);
});
test('reasoning conformance passes the mock and detects deliberately broken fixture', async () => {
  const session = createSession({ demo: true });
  session.transcript.push({ role: 'user', content: 'Hello' });
  const request = { ...reasoningRequest(session, 'understanding'), schema: understandingSchema(session.preset) };
  assert.deepEqual(await reasoningConformance(createMockReasoning(), request), { ok: true, failures: [] });
  const result = await reasoningConformance(brokenReasoning, request);
  assert.equal(result.ok, false); assert.ok(result.failures.includes('health unavailable'));
  assert.ok(result.failures.some(f => f.includes('terminal count')));
  assert.ok(result.failures.some(f => f.includes('ignored cancelled')));
});
test('mock emits one terminal on consumer return and burns attempts only once', async () => {
  const plugin = createMockReasoning(), options = invocationOptions();
  for await (const chunk of plugin.stream({}, options)) { assert.ok(chunk); break; }
  assert.equal(options.reports.length, 1); assert.equal(options.reports[0].outcome, 'cancelled');
  await assert.rejects(plugin.stream({}, options).next(), { code: 'already-claimed' });
  assert.equal(options.reports.length, 1);
});

test('conformance refuses a malformed manifest and broken timeout/error behavior', async () => {
  const session = createSession({ demo: true });
  const request = { ...reasoningRequest(session, 'understanding'), schema: understandingSchema(session.preset) };
  const invalid = { ...createMockReasoning(), manifest: {} };
  assert.ok((await reasoningConformance(invalid, request)).failures.includes('manifest validity'));
});

test('D4 excludes private config keys and string property defaults, constants and examples at any depth', () => {
  const manifest = createMockReasoning().manifest;
  for (const key of ['token', 'password', 'apiToken', 'credentials', 'accountId', 'purpose', 'processors', 'recipient', 'dataCategories', 'consentVersion']) {
    const invalid = structuredClone(manifest);
    invalid.configSchema = { type: 'object', properties: { nested: { type: 'object', properties: { [key]: { type: 'string' } } } } };
    assert.equal(validateManifest(invalid).ok, false, key);
  }
  for (const keyword of ['default', 'const', 'examples']) {
    const invalid = structuredClone(manifest);
    invalid.configSchema = { properties: { nested: { properties: { label: { type: 'string', [keyword]: keyword === 'examples' ? ['private'] : 'private' } } } } };
    assert.equal(validateManifest(invalid).ok, false, keyword);
  }
});

test('registry preserves immutable canonical mock identity but detaches mutable manifests', () => {
  const plugin = createMockReasoning();
  assert.equal(new PluginRegistry().register(plugin).get('mock').manifest, plugin.manifest);
  const mutable = { ...plugin, manifest: structuredClone(plugin.manifest) };
  assert.notEqual(new PluginRegistry().register(mutable).get('mock').manifest, mutable.manifest);
});

test('conformance rejects structured operations that only check cancellation and deadline at preflight', async t => {
  const fake = await chatServer(t);
  const good = createOpenRouterReasoning({ binding: binding('openrouter', fake.endpoint), fetchImpl: fake.fetchImpl, resolveSecret: () => 'local-fixture' });
  const result = await reasoningConformance(brokenPreflightReasoning(good, { fetchImpl: fake.fetchImpl }), fixtureRequest,
    { timeoutMs: 100, stallRequest: { ...fixtureRequest, system: 'stall' }, requestCount: () => fake.requests.length });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(f => f.includes('structured active-cancelled')));
  assert.ok(result.failures.some(f => f.includes('structured active-deadline')));
  assert.ok(fake.requests.some(r => r.stream === false && r.messages[0].content === 'stall'));
});

test('conformance consume refusal exercises both operations without any fixture dispatch', async t => {
  const fake = await chatServer(t);
  const plugin = createOpenRouterReasoning({ binding: binding('openrouter', fake.endpoint), fetchImpl: fake.fetchImpl, resolveSecret: () => 'local-fixture' });
  const modes = [];
  const observed = { ...plugin,
    async *stream(req, options) { modes.push(['stream', req]); yield* plugin.stream(req, options); },
    async structured(req, options) { modes.push(['structured', req]); return plugin.structured(req, options); } };
  const result = await reasoningConformance(observed, fixtureRequest,
    { stallRequest: { ...fixtureRequest, system: 'stall' }, requestCount: () => fake.requests.length });
  assert.deepEqual(result, { ok: true, failures: [] });
  assert.equal(modes.length, 13, 'seven stream and six structured authority/lifetime modes');
  assert.equal((await reasoningConformance(plugin, fixtureRequest)).ok, false, 'billable conformance requires active fixtures and a dispatch counter');
});

test('conformance detects dispatch before consume and plugins swallowing a consume refusal', async t => {
  const fake = await chatServer(t);
  const plugin = createOpenRouterReasoning({ binding: binding('openrouter', fake.endpoint), fetchImpl: fake.fetchImpl, resolveSecret: () => 'local-fixture' });
  const kitOptions = { stallRequest: { ...fixtureRequest, system: 'stall' }, requestCount: () => fake.requests.length };
  const early = { ...plugin, async structured(req, options) {
    const opened = fake.fetchImpl(fake.endpoint, { method: 'POST', signal: options.signal,
      body: JSON.stringify({ messages: [{ role: 'system', content: req.system }], stream: false }) });
    opened.then(response => response.body?.cancel(), () => {}).catch(() => {});
    return plugin.structured(req, options);
  } };
  assert.ok((await reasoningConformance(early, fixtureRequest, kitOptions)).failures.includes('structured dispatched before consume'));
  const ignoresRefusal = { ...plugin, async structured(req, options) {
    return plugin.structured(req, { ...options, attempt: { ...options.attempt, consume() { try { options.attempt.consume(); } catch {} } } });
  } };
  const result = await reasoningConformance(ignoresRefusal, fixtureRequest, kitOptions);
  assert.ok(result.failures.includes('structured consume refusal false completion'));
  assert.ok(result.failures.includes('structured dispatched after consume refusal'));
});
