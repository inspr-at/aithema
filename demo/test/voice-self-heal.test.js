import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { SQLiteStorage } from '../../packages/server/src/storage.js';
import { createVoiceProvider } from '../../packages/server/src/voice-provider.js';
import { PluginRegistry, createMockReasoning } from '@inspr/aithema-core';
import { prepareVoiceRuntime, voiceRuntimePorts } from '../voice-availability.js';
import { demoPresets } from '../choices.js';
import { registerDemoExtractors } from '../uploads.js';
import { ensureAgent } from '../../plugins/elevenlabs/src/ensure-agent.js';
import { createVoiceHost } from '../start2-voice-host.js';
import { stubAgentApi } from '../../test/fixtures/voice-self-heal-host.js';
import { startChild, temporaryDb, post } from '../../test/helpers.js';

const options = (storage, api) => ({ storage, templateAgentId: 'template-agent', publicOrigin: 'https://fixture.test',
  apiBaseUrl: api.endpoint, fetchImpl: api.fetchImpl, resolveSecret: () => 'fixture-secret', values: {}, log() {} });
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const storage = new SQLiteStorage(), api = stubAgentApi();
  t.after(() => storage.close());
  return { storage, api, opts: options(storage, api) };
}
const failures = [
  ['timeout', () => { throw new DOMException('secret URL', 'TimeoutError'); }, 'agent-api-unavailable', true],
  ['abort', () => { throw new DOMException('secret URL', 'AbortError'); }, 'agent-api-unavailable', true],
  ['network', () => { throw new TypeError('secret URL'); }, 'agent-api-unavailable', true],
  ...[500, 503, 429, 401, 403, 400, 404, 422].map(status => [String(status), () => new Response('secret response', { status }),
    `agent-api-get-${status}`, status === 429 || status >= 500]),
];
for (const [name, fail, reason, transient] of failures) test(`AIT-161 classifies ${name} without changing its reason`, async t => {
  const { opts } = fixture(t);
  await assert.rejects(ensureAgent({ ...opts, fetchImpl: async () => fail() }), error => {
    assert.equal(error.message, reason); assert.equal(error.transient, transient); return true;
  });
});

for (const [name, fail, reason] of failures.filter(([, , , transient]) => transient)) {
  test(`AIT-161 ${name}: starts off and retries through read-back without restart`, async t => {
    const { opts, api } = fixture(t), logs = []; let attempts = 0;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const host = await createVoiceHost({ ...opts, random: () => 0.5, log: entry => logs.push(entry), fetchImpl: async (url, init) => {
      if (++attempts === 1) return fail();
      return api.fetchImpl(url, init);
    } });
    t.after(() => host.close?.());
    assert.equal(host.binding, undefined); assert.equal(host.disabledReason, reason);
    t.mock.timers.tick(29_999); await flush(); assert.equal(attempts, 1);
    t.mock.timers.tick(1); await flush();
    assert.ok(host.binding); assert.equal(host.disabledReason, null);
    assert.equal(api.requests.at(-1).path, '/v1/convai/agents/owned-agent');
    assert.equal(api.requests.at(-1).method, 'GET');
    assert.equal(api.agents[0].conversation_config.turn.silence_end_call_timeout, 120);
    assert.equal(api.agents[0].conversation_config.conversation.max_duration_seconds, 3600);
    assert.deepEqual(logs.filter(entry => entry.event === 'voice-availability'), [
      { event: 'voice-availability', from: 'starting', to: 'off', reason },
      { event: 'voice-availability', from: 'off', to: 'available', reason: null },
    ]);
    assert.ok(api.requests.filter(r => r.path.endsWith('/template-agent')).every(r => r.method === 'GET'));
    const calls = attempts; t.mock.timers.tick(3_600_000); await flush(); assert.equal(attempts, calls);
  });
}

for (const mode of ['401', 'mismatch', 'invalid-config']) test(`AIT-161 ${mode}: stays off without retrying`, async t => {
  const { opts, api } = fixture(t), logs = []; let calls = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await createVoiceHost({ ...opts, ...(mode === 'invalid-config' ? { templateAgentId: '' } : {}), log: entry => logs.push(entry),
    fetchImpl: async (url, init) => {
      calls++;
      if (mode === '401') return new Response(null, { status: 401 });
      const response = await api.fetchImpl(url, init);
      if (new URL(url).pathname.endsWith('/agents/owned-agent')) {
        const remote = await response.json(); remote.conversation_config.turn.silence_end_call_timeout = 20;
        return Response.json(remote);
      }
      return response;
    } });
  t.after(() => host.close?.());
  const reason = mode === '401' ? 'agent-api-get-401' : mode === 'mismatch' ? 'agent-readback-mismatch' : 'template-agent-required';
  assert.equal(host.disabledReason, reason); assert.equal(host.binding, undefined);
  assert.deepEqual(logs.filter(entry => entry.event === 'voice-availability'), [{ event: 'voice-availability', from: 'starting', to: 'off', reason }]);
  const initial = calls; t.mock.timers.tick(3_600_000); await flush(); assert.equal(calls, initial);
});

for (const random of [0, 0.5, 1]) test(`AIT-161 bounded exponential backoff has jitter (${random}) and continues at cap`, async t => {
  const { opts } = fixture(t), delays = [], logs = []; let calls = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const setTimer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => { delays.push(delay); return setTimer(fn, delay, ...args); });
  const host = await createVoiceHost({ ...opts, random: () => random, log: entry => logs.push(entry),
    fetchImpl: async () => { calls++; return new Response(null, { status: 503 }); } });
  t.after(() => host.close?.());
  for (let retry = 0; retry < 12; retry++) {
    const nominal = Math.min(30_000 * 2 ** retry, 600_000), delay = delays.at(-1);
    assert.equal(delays.length, retry + 1, 'exactly one retry timer');
    const expected = { 0: [24_000, 48_000, 96_000, 192_000, 384_000, 480_000],
      0.5: [30_000, 60_000, 120_000, 240_000, 480_000, 600_000],
      1: [36_000, 72_000, 144_000, 288_000, 576_000, 600_000] }[random];
    assert.equal(delay, expected[Math.min(retry, 5)]);
    assert.ok(delay >= nominal * 0.8 && delay <= Math.min(nominal * 1.2, 600_000));
    t.mock.timers.tick(delay); await flush();
  }
  assert.equal(calls, 13); assert.equal(logs.length, 1, 'repeated failures do not repeat state logs');
});

test('AIT-161 no second ensure starts while a retry is waiting on the provider', async t => {
  const { opts, api } = fixture(t), gate = Promise.withResolvers(); let lists = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await createVoiceHost({ ...opts, random: () => 0.5, fetchImpl: async (url, init) => {
    if (new URL(url).pathname === '/v1/convai/agents') {
      lists++;
      if (lists === 1) return new Response(null, { status: 503 });
      await gate.promise;
    }
    return api.fetchImpl(url, init);
  } });
  t.after(() => host.close?.());
  t.mock.timers.tick(30_000); await flush(); assert.equal(lists, 2);
  t.mock.timers.tick(6_000_000); await flush(); assert.equal(lists, 2);
  gate.resolve(); await flush(); assert.ok(host.binding);
});

test('AIT-161 shutdown cancels pending retries', async t => {
  const { opts } = fixture(t); let calls = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await createVoiceHost({ ...opts, fetchImpl: async () => { calls++; return new Response(null, { status: 503 }); } });
  await host.close(); t.mock.timers.tick(6_000_000); await flush();
  assert.equal(calls, 1); assert.equal(host.binding, undefined);
});

test('AIT-161 shutdown during a retry suppresses late activation and waits for the ensure', async t => {
  const { opts, api } = fixture(t), gate = Promise.withResolvers(); let lists = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await createVoiceHost({ ...opts, random: () => 0.5, fetchImpl: async (url, init) => {
    if (new URL(url).pathname === '/v1/convai/agents') {
      if (++lists === 1) return new Response(null, { status: 503 });
      await gate.promise;
    }
    return api.fetchImpl(url, init);
  } });
  t.mock.timers.tick(30_000); await flush();
  const closing = host.close(); gate.resolve(); await closing;
  t.mock.timers.tick(6_000_000); await flush();
  assert.equal(lists, 2); assert.equal(host.binding, undefined);
});

test('AIT-161 a non-transient retry failure stops the loop', async t => {
  const { opts } = fixture(t); let calls = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await createVoiceHost({ ...opts, random: () => 0.5,
    fetchImpl: async () => new Response(null, { status: ++calls === 1 ? 503 : 401 }) });
  t.after(() => host.close?.());
  t.mock.timers.tick(30_000); await flush(); assert.equal(host.disabledReason, 'agent-api-get-401');
  t.mock.timers.tick(6_000_000); await flush(); assert.equal(calls, 2);
});

test('AIT-161 healthy startup has the same ensure calls and no retry', async t => {
  const { opts, api } = fixture(t), logs = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = await createVoiceHost({ ...opts, log: entry => logs.push(entry) });
  t.after(() => host.close?.());
  assert.ok(host.binding);
  assert.deepEqual(api.requests.map(r => [r.method, r.path]), [
    ['GET', '/v1/convai/agents'], ['GET', '/v1/convai/agents/template-agent'], ['GET', '/v1/convai/secrets'],
    ['POST', '/v1/convai/secrets'], ['POST', '/v1/convai/agents/create'], ['GET', '/v1/convai/agents/owned-agent'],
  ]);
  assert.deepEqual(logs.filter(entry => entry.event === 'voice-availability'), [{ event: 'voice-availability', from: 'starting', to: 'available', reason: null }]);
  t.mock.timers.tick(6_000_000); await flush(); assert.equal(api.requests.length, 6);
});

for (const failure of ['timeout', '503', 'network', '401']) test(`AIT-161 server ${failure}: config and new requests reflect availability`, { timeout: 15_000 }, async t => {
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb(), {
    AITHEMA_VOICE_MODE: 'elevenlabs', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
    AITHEMA_ELEVENLABS_TEMPLATE_AGENT_ID: 'template-agent',
    AITHEMA_VOICE_HOST_MODULE: fileURLToPath(new URL('../../test/fixtures/voice-self-heal-host.js', import.meta.url)),
    AITHEMA_TEST_VOICE_FAILURE: failure, ELEVENLABS_API_KEY: 'fixture-key', AITHEMA_VOICE_FACADE_SECRET: 'fixture-bearer',
  });
  t.after(() => running.kill());
  const config = () => fetch(running.url + '/demo/config').then(r => r.json());
  const before = await config(); assert.equal(before.voiceMode, 'off'); assert.ok(before.voiceDisabledReason);
  const advanced = once(running.child, 'message'); running.child.send({ event: 'advance-voice-clock', ms: 30_000 }); await advanced;
  const after = await config();
  if (failure === '401') {
    assert.equal(after.voiceMode, 'off'); assert.equal(after.voiceDisabledReason, 'agent-api-get-401'); return;
  }
  assert.equal(after.voiceMode, 'elevenlabs'); assert.equal(after.voiceDisabledReason, null);
  assert.ok(after.processingConsent.items.some(item => item.id === 'voice-elevenlabs'));
  const created = await post(running.url + '/api/sessions', {}), session = await created.json();
  const headers = { cookie: created.headers.get('set-cookie').split(';')[0] };
  const consent = await post(running.url + `/api/sessions/${session.id}/consent`, { granted: true,
    processing: { contract: after.processingConsent.contract, items: ['voice-elevenlabs'] } }, headers);
  assert.equal(consent.status, 200);
  const updated = await fetch(running.url + `/api/sessions/${session.id}`, { headers }).then(r => r.json());
  assert.equal(updated.featureMatrix.best.voice.available, true, updated.featureMatrix.best.voice.reason);
  const voice = await post(running.url + `/api/sessions/${session.id}/voice`, { callId: 'fixture-call', tabId: 'fixture-tab' }, headers);
  assert.equal(voice.status, 201, await voice.text());
});


for (const path of ['/v1/convai/secrets', '/v1/convai/agents/create']) {
  test(`AIT-161 fix1 shutdown preserves ownership while ${path} POST is in flight`, async t => {
    const { opts, api, storage } = fixture(t), gate = Promise.withResolvers(); let lists = 0, writeSignal;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const host = await createVoiceHost({ ...opts, random: () => 0.5, fetchImpl: async (url, init) => {
      if (new URL(url).pathname === '/v1/convai/agents' && ++lists === 1) return new Response(null, { status: 503 });
      const response = await api.fetchImpl(url, init);
      if (init.method !== 'POST' || new URL(url).pathname !== path) return response;
      writeSignal = init.signal;
      // The upstream write succeeded; its JSON response is still in flight.
      const body = await response.text();
      return new Response(new ReadableStream({ start(controller) {
        const aborted = () => controller.error(init.signal.reason);
        init.signal.addEventListener('abort', aborted, { once: true });
        gate.promise.then(() => {
          init.signal.removeEventListener('abort', aborted);
          if (!init.signal.aborted) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); }
        });
      } }));
    } });
    t.mock.timers.tick(30_000); await flush(); assert.ok(writeSignal);
    const closing = host.close(); gate.resolve(); await closing;
    assert.equal(host.binding, undefined, 'shutdown never activates voice');
    const receipt = path.endsWith('/create') ? storage.db.prepare('SELECT * FROM host_agents').get()
      : storage.db.prepare('SELECT * FROM host_voice_secrets').get();
    assert.ok(receipt, 'a completed upstream write must retain its local ownership receipt');
    const restarted = await createVoiceHost(opts); t.after(() => restarted.close());
    assert.ok(restarted.binding, restarted.disabledReason);
    assert.equal(api.secrets.length, 1); assert.equal(api.agents.length, 1);
  });
}

for (const fail of [false, true]) test(`AIT-161 fix1 prepares recovery before publishing (failure=${fail})`, async t => {
  const { opts, api } = fixture(t); let lists = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logs = [], host = await createVoiceHost({ ...opts, log: entry => logs.push(entry), random: () => 0.5,
    fetchImpl: async (url, init) => {
      if (new URL(url).pathname === '/v1/convai/agents' && ++lists === 1) return new Response(null, { status: 503 });
      return api.fetchImpl(url, init);
    } });
  t.after(() => host.close());
  let observed, prepared;
  host.onAvailable(candidate => {
    observed = { binding: host.binding, reason: host.disabledReason };
    prepared = { runtime: { registry: 'prepared', endpoint: candidate.binding.endpoint } };
    return prepared;
  });
  if (fail) host.onAvailable(() => { throw new Error('injected preparation failure'); });
  t.mock.timers.tick(30_000); await flush();
  assert.deepEqual(observed, { binding: undefined, reason: 'agent-api-get-503' }, 'preparation cannot expose the new binding');
  if (fail) {
    assert.equal(host.binding, undefined); assert.equal(host.runtime, undefined);
    assert.equal(host.disabledReason, 'voice-host-unavailable');
    assert.deepEqual(logs.filter(entry => entry.event === 'voice-availability').at(-1),
      { event: 'voice-availability', from: 'off', to: 'off', reason: 'voice-host-unavailable' });
  } else {
    assert.ok(host.binding); assert.equal(host.runtime, prepared.runtime); assert.equal(host.disabledReason, null);
  }
});

for (const provider of ['mock', 'openrouter']) test(`AIT-161 fix1 ${provider}: outage grants and the configured contract survive recovery`, { timeout: 15_000 }, async t => {
  const settings = {
    AITHEMA_PROVIDER: provider, AITHEMA_VOICE_MODE: 'elevenlabs', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
    AITHEMA_ELEVENLABS_TEMPLATE_AGENT_ID: 'template-agent',
    AITHEMA_VOICE_HOST_MODULE: fileURLToPath(new URL('../../test/fixtures/voice-self-heal-host.js', import.meta.url)),
    ELEVENLABS_API_KEY: 'fixture-key', AITHEMA_VOICE_FACADE_SECRET: 'fixture-bearer', OPENROUTER_API_KEY: 'fixture-key',
    OPENROUTER_MODEL: 'openai/fixture', OPENROUTER_SPEECH_MODEL: 'openai/fixture',
    AITHEMA_OPENROUTER_PRICES: JSON.stringify({ 'openai/fixture': { prompt: 1e-7, completion: 5e-7 } }),
  };
  const healthy = await startChild(new URL('../server.js', import.meta.url), await temporaryDb(), { ...settings, AITHEMA_TEST_VOICE_FAILURE: 'none' });
  t.after(() => healthy.kill());
  const expected = await fetch(healthy.url + '/demo/config').then(r => r.json());
  assert.equal(expected.voiceMode, 'elevenlabs');
  await healthy.kill();
  const running = await startChild(new URL('../server.js', import.meta.url), await temporaryDb(), { ...settings, AITHEMA_TEST_VOICE_FAILURE: '503' });
  t.after(() => running.kill());
  const before = await fetch(running.url + '/demo/config').then(r => r.json());
  assert.equal(before.voiceMode, 'off');
  assert.equal(before.processingConsent?.contract, expected.processingConsent.contract, 'configured contract is independent of availability');
  assert.ok(before.processingConsent.items.some(item => item.id === 'voice-elevenlabs'), 'consent page lists configured voice during the outage');
  const created = await post(running.url + '/api/sessions', {}), session = await created.json();
  const headers = { cookie: created.headers.get('set-cookie').split(';')[0] };
  const decision = { contract: before.processingConsent.contract, items: before.processingConsent.items.map(item => item.id) };
  assert.equal((await post(running.url + `/api/sessions/${session.id}/consent`, { granted: true, processing: decision }, headers)).status, 200);
  const sessionUrl = running.url + `/api/sessions/${session.id}`;
  const granted = await fetch(sessionUrl, { headers }).then(r => r.json());
  assert.equal(granted.featureMatrix.best.text.available, true);
  assert.equal(granted.featureMatrix.best.voice.available, false);
  const advanced = once(running.child, 'message'); running.child.send({ event: 'advance-voice-clock', ms: 30_000 }); await advanced;
  const after = await fetch(running.url + '/demo/config').then(r => r.json());
  assert.equal(after.voiceMode, 'elevenlabs');
  assert.equal(after.processingConsent.contract, before.processingConsent.contract);
  const recovered = await fetch(sessionUrl, { headers }).then(r => r.json());
  assert.equal(recovered.consentRevision, granted.consentRevision, 'recovery does not revise consent');
  assert.equal(recovered.featureMatrix.best.text.available, true, recovered.featureMatrix.best.text.reason);
  assert.deepEqual(recovered.settings, granted.settings, 'recovery preserves the existing page\'s settings');
  const saved = await fetch(sessionUrl + '/consent', { headers }).then(r => r.json());
  assert.equal(saved.contract, decision.contract); assert.deepEqual(saved.selected, decision.items);
  const selection = await post(sessionUrl + '/settings', { voice: 'elevenlabs', baseRevision: recovered.settings.revision }, headers);
  assert.equal(selection.status, 200, await selection.text());
  const enabled = await fetch(sessionUrl, { headers }).then(r => r.json());
  assert.equal(enabled.consentRevision, granted.consentRevision, 'selecting voice needs no replacement grant');
  assert.equal(enabled.featureMatrix.best.voice.available, true, enabled.featureMatrix.best.voice.reason);
  assert.equal((await post(running.url + `/api/sessions/${session.id}/voice`, { callId: 'outage-grant-call', tabId: 'fixture-tab' }, headers)).status, 201);
});


for (const failure of ['binding', 'plugin', 'registration', 'endpoint', 'presets', 'none']) {
  test(`AIT-161 fix1 transactional recovery ${failure}: no partial registry, endpoint or preset publication`, async t => {
    const { opts, api } = fixture(t); let lists = 0;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const logs = [], host = await createVoiceHost({ ...opts, random: () => 0.5, log: entry => logs.push(entry),
      fetchImpl: async (url, init) => {
        if (new URL(url).pathname === '/v1/convai/agents' && ++lists === 1) return new Response(null, { status: 503 });
        return api.fetchImpl(url, init);
      } });
    t.after(() => host.close());
    const reasoning = createMockReasoning(), registry = new PluginRegistry().register(reasoning), policy = { endpoints: [] };
    const presets = demoPresets({ policy }); registerDemoExtractors(registry, presets);
    const initial = { registry, policy, presets }, ports = voiceRuntimePorts(() => host.runtime ?? initial);
    const before = structuredClone({ policy, presets }), entries = registry.list(); let reached;
    const observe = () => {
      assert.equal(host.binding, undefined); assert.equal(host.disabledReason, 'agent-api-get-503');
      assert.equal(ports.registry.get('elevenlabs'), undefined);
      assert.equal(ports.presets.best, initial.presets.best);
    };
    host.onAvailable(candidate => {
      if (failure === 'binding') reached = 'binding';
      return prepareVoiceRuntime({ current: initial,
        binding: failure === 'binding' ? { ...candidate.binding, agentId: 'wrong-agent' } : candidate.binding,
        createPlugin(binding) {
          reached = 'plugin'; observe();
          if (failure === 'plugin') throw new Error('injected plugin failure');
          const plugin = createVoiceProvider({ storage: opts.storage, staticFacade: true,
            binding: { agentId: binding.agentId, secretRef: binding.secretRef, apiBaseUrl: binding.endpoint,
              upstreamMicroPerMinute: binding.upstreamMicroPerMinute, visitorMicroPerMinute: binding.visitorMicroPerMinute,
              reservationSeconds: binding.reservationSeconds, usdPerCredit: binding.usdPerCredit },
            fetchImpl: api.fetchImpl, resolveSecret: opts.resolveSecret });
          if (failure === 'registration') { reached = 'registration'; return { ...plugin, health: null }; }
          return plugin;
        },
        extendPolicy(before, binding) {
          reached = 'endpoint'; observe();
          const prepared = { ...before, endpoints: [...before.endpoints, binding.endpoint] };
          if (failure === 'endpoint') throw new Error('injected endpoint failure');
          return prepared;
        },
        createPresets({ binding, plugin, policy }) {
          reached = 'presets'; observe();
          const prepared = demoPresets({ voicePlugin: plugin, voiceBinding: binding, policy });
          if (failure === 'presets') throw new Error('injected presets failure');
          return prepared;
        },
      });
    });
    t.mock.timers.tick(30_000); await flush();
    assert.deepEqual({ policy, presets }, before, 'preparation leaves the exact previous objects intact');
    assert.deepEqual(registry.list(), entries); assert.equal(registry.get('elevenlabs'), undefined);
    const transitions = logs.filter(entry => entry.event === 'voice-availability');
    assert.equal(transitions.length, 2, 'one availability log per state change');
    if (failure !== 'none') {
      assert.equal(reached, failure); assert.equal(host.binding, undefined); assert.equal(host.runtime, undefined);
      assert.equal(host.disabledReason, 'voice-host-unavailable');
      assert.equal(ports.registry.get('elevenlabs'), undefined); assert.equal(ports.presets.best, initial.presets.best);
      t.mock.timers.tick(6_000_000); await flush(); assert.equal(lists, 2, 'preparation failures do not retry');
    } else {
      assert.equal(host.disabledReason, null); assert.equal(host.binding, host.runtime.binding);
      assert.ok(ports.registry.get('elevenlabs')); assert.equal(ports.registry.get('mock'), entries[0]);
      assert.equal(ports.registry.isCanonicalMock(entries[0]), true, 'retain canonical mock identity');
      assert.ok(ports.presets.best.policy.endpoints.includes(host.binding.endpoint));
      assert.equal(ports.presets.best.choices.voices.find(v => v.id === 'elevenlabs').binding, host.binding);
      assert.deepEqual(ports.presets.best.extractors, initial.presets.best.extractors);
      assert.equal(ports.presets.best.choices.defaults.voice, 'elevenlabs');
    }
  });
}

for (const table of ['host_voice_secrets', 'host_agents']) {
  test(`AIT-161 fix1 shutdown while inserting ${table} ownership receipt finishes the insert`, async t => {
    const { opts, api, storage } = fixture(t); let lists = 0, closing;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const host = await createVoiceHost({ ...opts, random: () => 0.5, fetchImpl: async (url, init) => {
      if (new URL(url).pathname === '/v1/convai/agents' && ++lists === 1) return new Response(null, { status: 503 });
      return api.fetchImpl(url, init);
    } });
    const prepare = storage.db.prepare.bind(storage.db);
    t.mock.method(storage.db, 'prepare', sql => {
      const statement = prepare(sql);
      if (sql.startsWith(`INSERT INTO ${table} `)) {
        const run = statement.run.bind(statement);
        t.mock.method(statement, 'run', (...args) => { if (!closing) closing = host.close(); return run(...args); });
      }
      return statement;
    });
    t.mock.timers.tick(30_000); await flush(); await closing;
    assert.ok(closing); assert.ok(prepare(`SELECT * FROM ${table}`).get());
    assert.equal(host.binding, undefined);
    const restarted = await createVoiceHost(opts); t.after(() => restarted.close());
    assert.ok(restarted.binding, restarted.disabledReason);
    assert.equal(api.agents.length, 1); assert.equal(api.secrets.length, 1);
  });
}
