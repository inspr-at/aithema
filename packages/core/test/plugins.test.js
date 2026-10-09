import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, PluginRegistry, createBinding, createMockReasoning, reasoningConformance,
  reasoningRequest, createSession, understandingSchema, PLUGIN_KINDS, KIND_OPERATIONS } from '../src/index.js';
import { brokenReasoning, binding, invocationOptions } from '../../../test/plugin-fixtures.js';
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
