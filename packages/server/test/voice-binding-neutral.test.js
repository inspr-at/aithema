import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createDurationBinding, durationPluginMatches } from '../src/voice-binding.js';
import { PluginRegistry, publicReasoningManifest } from '@inspr/aithema-core';
import { SQLiteStorage } from '../src/storage.js';
import { createPluginRuntime } from '../src/plugin-runtime.js';

const raw = { plugin: 'neutral-voice', model: 'conversation-v2', effort: 'none', endpoint: 'https://voice.example.test',
  accountRef: 'fixture', secretRef: 'fixture-ref', maxMicro: 1200, maxTokens: 1,
  rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds: 3600, reservationSeconds: 30,
  upstreamMicroPerMinute: 600, visitorMicroPerMinute: 300, adapterConfig: { deployment: 'fixture' } };

test('AIT-102: generic duration bindings accept opaque config and match neutral fields', () => {
  const binding = createDurationBinding(raw);
  assert.equal(binding.minRunwaySeconds, 120);
  assert.ok(Object.isFrozen(binding.adapterConfig));
  const selected = { endpoint: raw.endpoint, secretRef: raw.secretRef, upstreamMicroPerMinute: 600,
    visitorMicroPerMinute: 300, reservationSeconds: 30, adapterConfig: raw.adapterConfig };
  assert.equal(durationPluginMatches({ binding: selected }, binding), true);
  for (const [key, value] of Object.entries({ endpoint: 'https://other.test', secretRef: 'other',
    upstreamMicroPerMinute: 601, visitorMicroPerMinute: 301, reservationSeconds: 31, adapterConfig: { deployment: 'other' } })) {
    assert.equal(durationPluginMatches({ binding: { ...selected, [key]: value } }, binding), false, key);
  }
  assert.equal(durationPluginMatches({}, binding), false);
  assert.throws(() => createDurationBinding({ ...raw, reservationSeconds: 3601 }), TypeError);
  assert.throws(() => createDurationBinding({ ...raw, minRunwaySeconds: 0 }), TypeError);
  assert.throws(() => createDurationBinding({ ...raw, maxMicro: 299 }), TypeError);
});

test('AIT-102: generic server source contains no ElevenLabs-specific binding fields', async () => {
  const root = new URL('../src/', import.meta.url);
  for (const name of await readdir(root)) {
    if (!name.endsWith('.js')) continue;
    assert.doesNotMatch(await readFile(new URL(name, root), 'utf8'), /\b(?:agentId|publicFacadeBaseUrl|usdPerCredit|apiBaseUrl)\b/u, name);
  }
});

test('AIT-102: another provider admits, discovers scope, extends and reconciles with neutral fields', async t => {
  const now = Date.now(), storage = new SQLiteStorage(); t.after(() => storage.close());
  const session = storage.create({ ownerToken: 'fixture-owner' });
  const binding = { ...raw, legal: { approved: true, countries: ['AT'], training: false, retention: 'fixture',
    purpose: 'conversation', recipient: 'fixture', processors: [], dataCategories: ['conversation'], consentVersion: 1,
    evidence: { qualified: true, accountRef: raw.accountRef, secretRef: raw.secretRef, model: raw.model,
      endpoint: raw.endpoint, routing: {}, verifiedAt: now - 1000, expiresAt: now + 100_000 } } };
  const base = publicReasoningManifest(raw.plugin, 'Neutral voice', raw.endpoint);
  const plugin = { binding: { endpoint: raw.endpoint, secretRef: raw.secretRef, upstreamMicroPerMinute: 600,
    visitorMicroPerMinute: 300, reservationSeconds: 30, adapterConfig: raw.adapterConfig },
    manifest: { ...base, kinds: ['live-voice'], entrypoints: { server: './server.js', browser: './browser.js' },
      models: [{ ...base.models[0], operations: ['start'], structured: false, cost: { ...base.models[0].cost, unit: 'minute' } }],
      liveVoice: { reasoning: 'native', transcript: { finality: 'turns', persistence: 'durable' },
        capabilities: Object.fromEntries(['sendText', 'updateContext', 'setInput', 'setOutput', 'pause', 'resume', 'interrupt', 'heard'].map(k => [k, 'unavailable'])),
        billing: { visitor: 'duration', upstream: 'duration' } } },
    health: async () => ({ available: true }), start() { throw new Error('Admission must not dispatch'); } };
  const consent = { coverage: async ({ scope, consentRevision }) => ({ covered: true, scope, ...scope,
    consentRevision, checkedAt: now, expiresAt: now + 100_000 }) };
  const runtime = createPluginRuntime({ storage, registry: new PluginRegistry().register(plugin), now: () => now, consent,
    presets: { best: { plugins: [raw.plugin], bindings: { voice: binding }, policy: { endpoints: [raw.endpoint] } } } });
  assert.equal((await runtime.matrix(session)).best.voice.available, true);
  const [scope] = runtime.scopes(session);
  assert.equal(scope.model, 'conversation-v2'); assert.equal(scope.plugin, 'neutral-voice');
  const admitted = await runtime.admitVoice({ session, request: { callId: 'fixture-call' } });
  const attempt = admitted.options.attempt;
  assert.equal(attempt.fundedSeconds, 120);
  assert.equal(attempt.maxMicro, 1200);
  assert.equal(attempt.exposureMicro, 36_000);
  await attempt.consume(); attempt.extend(150);
  assert.equal(attempt.fundedSeconds, 150); assert.equal(attempt.maxMicro, 1500);
  admitted.finish();
  const terminal = { attemptId: attempt.attemptId, outcome: 'completed', closureConfirmed: true, chargedMicro: 600,
    usage: { providerSeconds: 60, providerMinutes: 1, pausedSeconds: 0, visitorSeconds: 60, upstreamMicro: 600, visitorMicro: 300 } };
  runtime.reconcileVoice(attempt.attemptId, terminal);
  assert.equal(runtime.budget.used(session.id), 600);
  assert.equal(runtime.budget.visitorUsed(session.id), 300);
  runtime.reconcileVoice(attempt.attemptId, terminal);
  assert.equal(runtime.budget.used(session.id), 600);
  await assert.rejects(runtime.admitVoice({ session, request: { callId: 'short' },
    options: { spendDeadlineAt: now + 119_000 } }), { code: 'not-admitted', message: 'host-limit' });
});
