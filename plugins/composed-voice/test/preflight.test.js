import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureComposedComponents } from '../src/configuration.js';
import { createComposedVoice } from '../src/server.js';
import { assertSTTComponent, assertTTSComponent } from '../../../packages/core/src/voice-components.js';
import { compositionFixture, invalidCompositions } from '../../../packages/core/test/voice-composition-fixtures.js';
import { fixtureBinding, fixtureConsent } from '../../elevenlabs/test/component-fixtures.js';

// These hooks sit on the actual dispatch path. Calling a factory's raw port is
// the negative control for bypassing configuration's preflight guard.
function observedPort(port, options) {
  if (!port) return port;
  const descriptors = {};
  const dispatch = () => { options.resolveSecret?.(); options.connect?.(); options.fetchImpl?.(); };
  for (const method of ['transcribe', 'stream', 'speak', 'speakAligned']) {
    if (typeof port[method] !== 'function') continue;
    descriptors[method] = { value: method === 'transcribe' ? async (...args) => {
      dispatch(); return port[method](...args);
    } : async function* (...args) { dispatch(); yield* port[method](...args); } };
  }
  const observed = Object.create(port, descriptors);
  return Object.isFrozen(port) ? Object.freeze(observed) : observed;
}

function configured(f) {
  const binding = { ...fixtureBinding('stt'), plugin: 'synthetic' };
  const reasoningBinding = { ...binding, plugin: 'openrouter', legal: { ...binding.legal, purpose: 'models-international', consentVersion: 1 } };
  return { enabled: true, config: { stt: 'synthetic', tts: 'synthetic' },
    componentFactories: { synthetic: { stt: options => observedPort(f.stt, options), tts: options => observedPort(f.tts, options) } },
    componentOptions: { synthetic: { stt: { binding }, tts: { binding } } },
    composition: f, reasoningBinding, consent: fixtureConsent(binding),
    authorize: () => { f.counters.claims++; return true; } };
}

for (const [label, code, mutate] of invalidCompositions) {
  test(`AIT-328: configured ${label} fails before authority, secrets or transport`, async () => {
    const f = compositionFixture(); mutate(f);
    const args = configured(f);
    // Independently observe the configured host hooks, including secret/transport access.
    const options = args.componentOptions.synthetic;
    for (const role of ['stt', 'tts']) Object.assign(options[role], {
      resolveSecret() { f.counters.secrets++; }, connect() { f.counters.transport++; }, fetchImpl() { f.counters.transport++; },
    });
    const ports = configureComposedComponents(args);
    await assert.rejects(ports.preflight, { code });
    await assert.rejects(ports.authorize({}, { deadlineAt: Date.now() + 1000 }), { code });
    if (typeof f.stt.transcribe === 'function') await assert.rejects(ports.stt.transcribe({}, {}), { code });
    if (typeof f.tts.speak === 'function') await assert.rejects(async () => { for await (const chunk of ports.tts.speak({}, {})) void chunk; }, { code });
    assert.deepEqual({ claims: f.counters.claims, secrets: f.counters.secrets, transport: f.counters.transport },
      { claims: 0, secrets: 0, transport: 0 });
  });
}

test('AIT-328: start waits for negotiation before consuming the parent claim', async () => {
  const f = compositionFixture(), pending = Promise.withResolvers();
  f.stt.negotiateAudioFormat = () => pending.promise;
  const plugin = createComposedVoice({ ...configured(f), storage: { saveVoiceCall() {} }, commitUtterance() {} });
  const starting = plugin.start({ callId: 'synthetic-call' }, { attempt: { maxMicro: 0, consume() { f.counters.claims++; } } });
  await Promise.resolve(); await Promise.resolve(); assert.equal(f.counters.claims, 0);
  pending.resolve({ ...f.capture, encoding: 'incompatible' });
  await assert.rejects(starting, { code: 'composition-capture-format' });
  assert.deepEqual({ claims: f.counters.claims, secrets: f.counters.secrets, transport: f.counters.transport },
    { claims: 0, secrets: 0, transport: 0 });
});


test('AIT-328: guarding preserves inherited component contract methods and declarations', async () => {
  const f = compositionFixture(); f.stt = Object.create(f.stt); f.tts = Object.create(f.tts);
  const ports = configureComposedComponents(configured(f));
  await ports.preflight;
  assertSTTComponent(ports.stt); assertTTSComponent(ports.tts);
  assert.deepEqual(await ports.stt.negotiateAudioFormat([f.capture], {}), f.capture);
  assert.deepEqual(await ports.tts.negotiateAudioFormat([f.playback], {}), f.playback);
});


for (const role of ['capture', 'playback']) for (const [key, value] of [
  ['encoding', 'pcm_f32le'], ['sampleRateHz', 48000], ['channels', 2],
]) {
  test(`AIT-328: multi-format ${role} ${key} cannot differ from runtime`, async () => {
    const f = compositionFixture(), args = configured(f), offers = [];
    // A future multi-format component accepts any offer. The runtime still uses
    // its fixed capture format and the TTS port's declared playback format.
    for (const component of [f.stt, f.tts]) component.negotiateAudioFormat = async formats => {
      offers.push(formats); return formats[0];
    };
    f[role] = { ...f[role], [key]: value };
    for (const options of Object.values(args.componentOptions.synthetic)) Object.assign(options, {
      resolveSecret() { f.counters.secrets++; }, connect() { f.counters.transport++; },
    });
    const ports = configureComposedComponents(args), code = `composition-${role}-format`;
    await assert.rejects(ports.preflight, { code });
    await assert.rejects(ports.authorize({}, {}), { code });
    await assert.rejects(ports.stt.transcribe({}, {}), { code });
    await assert.rejects(async () => { for await (const chunk of ports.tts.speak({}, {})) void chunk; }, { code });
    const plugin = createComposedVoice({ ...args, storage: { saveVoiceCall() {} }, commitUtterance() {} });
    await assert.rejects(plugin.start({ callId: 'format-mismatch' }, {
      attempt: { maxMicro: 0, attemptId: 'parent', claimId: 'parent', consume() { f.counters.claims++; } }, report() {},
    }), { code });
    assert.deepEqual({ claims: f.counters.claims, secrets: f.counters.secrets, transport: f.counters.transport },
      { claims: 0, secrets: 0, transport: 0 });
    assert.deepEqual(offers, [], 'runtime mismatch is rejected before negotiation');
  });
}

test('AIT-328: dispatch hooks fire when preflight is bypassed', async () => {
  const f = compositionFixture(), args = configured(f), observed = { secrets: 0, transport: 0 };
  f.voice = ''; // Invalid preflight, but deliberately exercise the unguarded ports.
  for (const role of ['stt', 'tts']) {
    const options = args.componentOptions.synthetic[role];
    Object.assign(options, {
      resolveSecret() { observed.secrets++; }, connect() { observed.transport++; }, fetchImpl() { observed.transport++; },
    });
    const raw = args.componentFactories.synthetic[role](options);
    if (role === 'stt') await raw.transcribe({}, {});
    else for await (const chunk of raw.speak({}, {})) void chunk;
  }
  assert.deepEqual(observed, { secrets: 2, transport: 4 });
  assert.deepEqual({ claims: f.counters.claims, secrets: f.counters.secrets, transport: f.counters.transport },
    { claims: 2, secrets: 2, transport: 2 });
});

test('AIT-328: frozen ports keep inherited format, cost, health and receiver', async () => {
  const f = compositionFixture();
  for (const role of ['stt', 'tts']) {
    const base = f[role];
    base.estimateCost = function () { assert.equal(this.capabilities, base.capabilities); return 17; };
    base.health = function () { assert.equal(this.capabilities, base.capabilities); return { available: true }; };
    f[role] = Object.freeze(Object.create(Object.freeze(base)));
  }
  const ports = configureComposedComponents(configured(f));
  await ports.preflight;
  for (const role of ['stt', 'tts']) {
    assert.equal(Object.isFrozen(ports[role]), true);
    assert.equal(ports[role].estimateCost(), 17);
    assert.deepEqual(ports[role].health(), { available: true });
    assert.equal(ports[role].format, f[role].format);
    assert.deepEqual(ports[role].capabilities, f[role].capabilities);
  }
});

for (const [role, method] of [['stt', 'transcribe'], ['stt', 'stream'], ['tts', 'speak'], ['tts', 'speakAligned']]) {
  test(`AIT-328: abort while ${method} waits rejects before port dispatch`, async () => {
    const f = compositionFixture(), negotiation = Promise.withResolvers(), controller = new AbortController();
    let dispatched = 0;
    f.stt.stream = async function* () { dispatched++; };
    f.tts.speakAligned = async function* () { dispatched++; };
    f.stt.negotiateAudioFormat = () => negotiation.promise;
    const ports = configureComposedComponents(configured(f));
    const options = { signal: controller.signal, deadlineAt: Date.now() + 1000 };
    const operation = method === 'transcribe' ? ports[role][method]({}, options)
      : ports[role][method]({}, options).next();
    const outcome = operation.then(() => ({ code: 'dispatched' }), error => ({ code: error.code }));
    try {
      await Promise.resolve(); await Promise.resolve();
      controller.abort();
      const result = await Promise.race([outcome, new Promise(resolve => setImmediate(() => resolve({ code: 'still-waiting' })))]);
      assert.deepEqual(result, { code: 'cancelled' });
      assert.equal(dispatched, 0);
      assert.deepEqual({ claims: f.counters.claims, secrets: f.counters.secrets, transport: f.counters.transport },
        { claims: 0, secrets: 0, transport: 0 });
    } finally {
      negotiation.resolve(f.capture);
      await ports.preflight; await outcome;
    }
    assert.equal(dispatched, 0, 'cancelled wait must never dispatch after readiness');
    assert.equal(f.counters.claims, 0);
    // Cancellation of one caller must not cancel shared readiness for others.
    await ports.stt.transcribe({}, {});
    assert.equal(f.counters.claims, 1);
  });
}
