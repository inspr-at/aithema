import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers, createPluginRuntime, createFacadeSecrets, createLocalImages, localImageBinding, createLocalHTML, localHTMLBinding,
  normalizeChoices, mockPresets } from '../src/index.js';
import { createLocalVoiceProvider, localVoiceBinding } from '../src/local-voice.js';
import { PluginRegistry, createMockReasoning, inputRevision, reduceUnderstanding } from '@inspr/aithema-core';
import { createOpenRouterReasoning } from '../../../plugins/openrouter/src/index.js';
import { mockConsent, temporaryDb, unzip } from '../../../test/helpers.js';
import { binding, chatServer, openRouterPrices } from '../../../test/plugin-fixtures.js';

const test = (name, fn) => nodeTest(name, { timeout: 20_000 }, fn);
const price = { prompt: 1e-9, completion: 1e-9 };
const prices = { ...openRouterPrices, 'fixture/model-a': price, 'fixture/model-b': price, 'fixture/a': price, 'fixture/b': price };
const openRouter = b => createOpenRouterReasoning({ binding: b, prices, resolveSecret: () => 'local-fixture' });
const owner = 'settings-owner';
const mock = (model, effort = 'none') => ({ plugin: 'mock', model, effort, endpoint: 'https://example.test', accountRef: 'demo',
  secretRef: 'none', maxMicro: 0, maxTokens: 4096, rates: { inputMicro: 0, outputMicro: 0 } });
function qualify(b, recipient = 'fixture-provider', countries = ['FR']) {
  return { ...b, legal: { approved: true, countries, training: false, retention: 'host qualified', purpose: 'requirements', recipient,
    processors: ['fixture-processor'], dataCategories: ['conversation'], consentVersion: 'v1', evidence: { qualified: true,
      accountRef: b.accountRef, secretRef: b.secretRef, model: b.model, endpoint: b.endpoint, routing: b.routing ?? {},
      verifiedAt: Date.now() - 1000, expiresAt: Date.now() + 600_000 } } };
}
function mockPresetsWithChoices({ voice, images } = {}) {
  const models = [{ id: 'mock', label: 'Mock reasoning', binding: mock('mock'), efforts: ['none'] },
    { id: 'mock/deep', label: 'Deep (mock)', binding: mock('mock/deep', 'medium'), efforts: ['low', 'medium', 'high'], effort: 'medium' },
    { id: 'mock/too-deep', label: 'Unsupported effort', binding: mock('mock'), efforts: ['max'] },
    { id: 'openrouter/declared', label: 'Declared only' }];
  const voices = [{ id: 'fake-voice', label: 'Fake voice', ...(voice ? { binding: localVoiceBinding } : {}) }, { id: 'elevenlabs', label: 'ElevenLabs' }];
  const visuals = [{ id: 'fake-images', label: 'Fake images', ...(images ? { binding: localImageBinding } : {}) }];
  const plugins = ['mock', ...(voice ? ['fake-voice'] : []), ...(images ? ['fake-images'] : [])];
  return { best: { plugins, choices: { models, voices, visuals, defaults: { model: 'mock', voice: voice ? 'fake-voice' : 'off', visuals: 'off' } } },
    eu: { plugins: [], bindings: {} },
    custom: { plugins, choices: { models: models.slice(0, 2), voices, visuals, defaults: { model: 'mock/deep', effort: 'high', voice: 'off', visuals: 'off' } } } };
}
function host(t, { presets = mockPresetsWithChoices(), consent = mockConsent, registry, path, voice = false, images = false, admit } = {}) {
  const storage = new SQLiteStorage(path), secrets = createFacadeSecrets();
  registry ??= new PluginRegistry().register(createMockReasoning());
  if (voice && !registry.get('fake-voice')) registry.register(createLocalVoiceProvider({ storage, provisionFacade: () => {}, revokeFacade: secrets.revoke }));
  if (images && !registry.get('fake-images')) registry.register(createLocalImages({ delayMs: 1 }));
  const base = createPluginRuntime({ storage, registry, presets, consent });
  const runtime = admit ? { ...base, admit: args => admit(base, args) } : base;
  const handlers = createHandlers({ storage, pluginRuntime: runtime, consent, ...(voice ? { voice: { secrets } } : {}) });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await handlers.close(); storage.close(); };
  t.after(close);
  const call = async (path, body, token = owner) => handlers.handle(new Request(`http://localhost/api/sessions${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': token },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }));
  const create = async (body = {}, token = owner) => { const response = await call('', body, token); return { response, session: await response.json() }; };
  // A save on the current revision, as the settings dialog sends it.
  const save = (id, body, token = owner) => call(`/${id}/settings`, { baseRevision: storage.get(id).settings.revision, ...body }, token);
  return { storage, handlers, runtime: base, presets, registry, call, create, save, close };
}
const json = async response => ({ status: response.status, body: await response.json() });

test('the catalog shows only ids, labels and manifest facts with each option\'s verdict; private bindings stay on the server', async t => {
  const fixture = qualify(binding('openrouter', 'https://provider.test/v1/chat/completions', { maxMicro: 100_000 }));
  const presets = mockPresetsWithChoices();
  presets.custom.plugins.push('openrouter'); presets.custom.policy = { endpoints: [fixture.endpoint] };
  presets.custom.choices.models.push({ id: 'qualified', label: 'Qualified fixture', binding: fixture, efforts: ['none', 'high'] });
  const registry = new PluginRegistry().register(createMockReasoning()).register(openRouter(fixture));
  const h = host(t, { presets, registry }), { session } = await h.create();
  const { status, body: catalog } = await json(await h.call(`/${session.id}/settings`));
  assert.equal(status, 200); assert.equal(catalog.voiceCallActive, false);
  const serialized = JSON.stringify(catalog);
  for (const secret of ['FIXTURE_ONLY', 'fixture-account', 'provider.test', 'example.test', 'legal', 'rates', 'maxMicro', 'accountRef', 'secretRef']) {
    assert.equal(serialized.includes(secret), false, `catalog leaks ${secret}`);
  }
  const best = catalog.presets.best, custom = catalog.presets.custom;
  assert.deepEqual(best.models.map(o => [o.id, o.status, o.reason]), [['mock', 'available', null], ['mock/deep', 'available', null],
    ['mock/too-deep', 'unavailable', 'effort not supported'], ['openrouter/declared', 'unavailable', 'not configured']]);
  assert.deepEqual(best.models[1].efforts, ['low', 'medium', 'high']); assert.equal(best.models[1].effort, 'medium');
  assert.equal(best.models[1].facts.qualification, 'unverified', 'the mock manifest says unverified');
  assert.deepEqual(best.models[1].facts.efforts, ['low', 'medium', 'high']); assert.equal(best.models[1].facts.free, true);
  assert.deepEqual(best.voices.map(o => [o.id, o.status, o.reason]), [['fake-voice', 'unavailable', 'not configured'], ['elevenlabs', 'unavailable', 'not configured']]);
  assert.equal(catalog.presets.eu.status, 'unavailable'); assert.equal(catalog.presets.eu.reason, 'not configured');
  assert.equal(catalog.presets.device.status, 'available');
  const qualified = custom.models.find(o => o.id === 'qualified');
  assert.equal(qualified.status, 'consent', 'the mock grant does not cover an external provider');
  assert.equal(qualified.reason, 'current processing consent required'); assert.equal(qualified.facts.vendor, 'OpenRouter'); assert.equal(qualified.facts.free, false);
  assert.deepEqual(qualified.efforts, ['none', 'high']);
  assert.deepEqual(catalog.engine.model, { id: 'mock', label: 'Mock reasoning', vendor: 'Mock reasoning', offered: true });
  assert.equal((await h.call(`/${session.id}/settings`, undefined, 'other-owner')).status, 404, 'ownership guards the catalog');
});

test('the server admits only the host allowlist: unknown, crafted, unconfigured and policy-denied choices are refused with a reason', async t => {
  const presets = mockPresetsWithChoices();
  const usOnly = qualify(binding('openrouter', 'https://provider.test/v1/chat/completions', { maxMicro: 100_000 }), 'fixture-provider', ['US']);
  presets.eu = { plugins: ['openrouter'], policy: { endpoints: [usOnly.endpoint] }, choices: { models: [{ id: 'us-only', binding: usOnly }] } };
  const registry = new PluginRegistry().register(createMockReasoning()).register(openRouter(usOnly));
  const h = host(t, { presets, registry }), { session } = await h.create(), path = `/${session.id}/settings`;
  for (const [body, status, field, reason] of [
    [{ model: 'not/offered' }, 409, 'model', 'not offered'],
    [{ model: 'mock/deep', effort: 'max' }, 409, 'effort', 'effort not offered'],
    [{ model: 'mock/too-deep' }, 409, 'model', 'effort not supported'],
    [{ model: 'openrouter/declared' }, 409, 'model', 'not configured'],
    [{ voice: 'elevenlabs' }, 409, 'voice', 'not configured'],
    [{ voice: 'unknown-voice' }, 409, 'voice', 'not offered'],
    [{ visuals: 'fake-images' }, 409, 'visuals', 'not configured'],
    [{ processingPreset: 'eu' }, 409, 'model', 'processing residency denied'],
    [{ processingPreset: 'fallback' }, 400], [{ model: 'mock', binding: mock('mock') }, 400], [{ model: '../escape' }, 400],
    [{ processingPreset: 'device', model: 'mock' }, 409, 'model', 'unavailable on device'], ['[]', 400],
  ]) {
    const { status: actual, body: result } = await json(await h.call(path, typeof body === 'string' ? body : { baseRevision: 0, ...body }));
    assert.equal(actual, status, JSON.stringify(body));
    if (field) assert.deepEqual(result, { error: 'setting-not-allowed', field, reason }, JSON.stringify(body));
  }
  const current = h.storage.get(session.id);
  assert.equal(current.settings.revision, 0); assert.equal(current.processingPreset, 'best');
  assert.equal(h.storage.read(session.id).some(e => e.type === 'settings.changed'), false, 'refusals leave no durable trace');
  assert.throws(() => createPluginRuntime({ storage: h.storage, presets: { best: { plugins: [], choices: { models: [{ id: 'x', efforts: ['turbo'] }] } } } }), /Invalid model efforts/);
  assert.throws(() => normalizeChoices({ choices: { models: [{ id: 'a' }, { id: 'a' }] } }), /Invalid model choice/);
});

// A provider fixture whose structured output is a valid understanding, so both lanes complete.
const understandingFixture = { summary: 'Known', signals: [], openQuestions: [], constraints: { operations: null, data: null, systems: null, reach: null, requirements: null },
  progress: { talk: { value: 0.5, reasoning: 'fixture' }, build: { value: 0, reasoning: 'fixture' } }, actor: null, engagement: null, conceptIntent: null };
const completing = (body, res) => {
  const usage = { prompt_tokens: 3, completion_tokens: 4 };
  res.end(body.stream ? 'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\n' + `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`
    : JSON.stringify({ usage, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(understandingFixture) } }] }));
};
test('a saved model and effort are the bindings both lanes dispatch with; completed work stays cached', async t => {
  const fake = await chatServer(t, { handler: completing });
  const fixture = model => qualify(binding('openrouter', fake.endpoint, { model, maxMicro: 100_000, maxTokens: 400 }));
  const a = fixture('fixture/model-a'), b = fixture('fixture/model-b');
  const presets = { best: { plugins: ['openrouter'], policy: { endpoints: [fake.endpoint] }, choices: {
    models: [{ id: 'a', label: 'Model A', binding: a, efforts: ['none'] }, { id: 'b', label: 'Model B', binding: b, efforts: ['none', 'high'] }] } },
  eu: { plugins: [], bindings: {} }, custom: { plugins: [], bindings: {} } };
  const consent = { coverage({ scope, consentRevision }) { return { covered: true, ...scope, scope, consentRevision, checkedAt: Date.now(), expiresAt: Date.now() + 60_000 }; } };
  const registry = new PluginRegistry().register(openRouter(a));
  const h = host(t, { presets, registry, consent }), { session } = await h.create();
  assert.equal((await h.call(`/${session.id}/turns`, { clientEventId: 'first', content: 'Hello' })).status, 200);
  await h.handlers.idle();
  assert.deepEqual(fake.bodies.map(body => [body.model, body.reasoning]), [['fixture/model-a', { enabled: false }], ['fixture/model-a', { enabled: false }]]);
  const saved = await json(await h.save(session.id, { model: 'b', effort: 'high', baseRevision: 0 }));
  assert.equal(saved.status, 200); assert.equal(saved.body.settings.model, 'b'); assert.equal(saved.body.settings.origin, 'chosen');
  assert.equal(saved.body.event.type, 'settings.changed'); assert.deepEqual(saved.body.consent, { required: false, features: [] });
  await h.handlers.idle();
  assert.equal(fake.bodies.length, 2, 'an answered input is not re-answered just because the choice changed');
  assert.equal((await h.call(`/${session.id}/turns`, { clientEventId: 'second', content: 'More' })).status, 200);
  await h.handlers.idle();
  assert.deepEqual(fake.bodies.slice(2).map(body => [body.model, body.reasoning]), [['fixture/model-b', { effort: 'high' }], ['fixture/model-b', { effort: 'high' }]]);
  const reply = h.storage.get(session.id).transcript.filter(turn => turn.role === 'assistant').at(-1);
  assert.deepEqual(reply.engine, { preset: 'best', model: 'b', label: 'Model B', effort: 'high' });
  const files = unzip(await (await h.call(`/${session.id}/export`)).arrayBuffer());
  assert.match(files['transcript.md'], /## assistant · Model A\n\nHello[\s\S]*## assistant · Model B · high\n\nHello/u, 'the export names each reply\'s model');
  assert.deepEqual(JSON.parse(files['transcript.json']).processing, { preset: 'best', model: 'b', effort: 'high', voice: 'off', visuals: 'off' });
  assert.equal(JSON.stringify(h.storage.read(session.id)).includes('fixture/model-b'), false, 'events carry ids and labels, never bindings');
});

test('a choice saved while a lane runs supersedes it like new input and reruns it with the new binding', async t => {
  const held = Promise.withResolvers(), started = Promise.withResolvers(), calls = [];
  const h = host(t, { async admit(runtime, args) {
    const admitted = await runtime.admit(args);
    if (args.lane !== 'reaction') return admitted;
    calls.push({ model: admitted.engine.model, signal: args.options.signal });
    if (calls.length > 1) return admitted;
    return { ...admitted, plugin: { ...admitted.plugin, async *stream(request, options) {
      started.resolve(); await held.promise; yield* admitted.plugin.stream(request, options);
    } } };
  } });
  const { session } = await h.create(), failures = []; let text = '';
  const events = await h.call(`/${session.id}/events?after=0`);
  const reader = events.body.getReader(); void (async () => {
    const decoder = new TextDecoder();
    for (;;) { const { done, value } = await reader.read(); if (done) return; text += decoder.decode(value); if (text.includes('lane.failed')) failures.push(text); }
  })().catch(() => {});
  t.after(() => reader.cancel().catch(() => {}));
  await h.call(`/${session.id}/turns`, { clientEventId: 'first', content: 'Hello' }); await started.promise;
  const saved = await h.save(session.id, { model: 'mock/deep', effort: 'high' });
  assert.equal(saved.status, 200);
  assert.equal(calls[0].signal.aborted, true, 'work on the previous choice is cancelled');
  held.resolve(); await h.handlers.idle();
  const replies = h.storage.get(session.id).transcript.filter(turn => turn.role === 'assistant');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].content, 'Thinking it through (high effort): which outcome matters most, and what should improve first?');
  assert.equal(replies[0].engine.model, 'mock/deep'); assert.deepEqual(calls.map(call => call.model), ['mock', 'mock/deep']);
  const snapshot = await json(await h.call(`/${session.id}`));
  assert.equal(snapshot.body.operations.lastFailure, null); assert.deepEqual(failures, [], 'supersession is not a lane failure');
  await new Promise(resolve => setTimeout(resolve, 20));
  const partials = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).filter(e => e.type === 'turn.partial');
  assert.ok(partials.length > 0); assert.ok(partials.every(e => e.data.id === replies[0].id && e.data.settingsRevision === 1),
    'the replacement stream is tagged with the settings revision it started under');
  assert.equal(snapshot.body.understanding.inputRevision, inputRevision(snapshot.body));
});

test('a choice needing consent the visitor has not given is saved, refused at admission and grants exactly its scopes', async t => {
  const fake = await chatServer(t);
  const a = qualify(binding('openrouter', fake.endpoint, { model: 'fixture/a', maxMicro: 100_000, maxTokens: 400 }), 'provider-a');
  const b = qualify(binding('openrouter', fake.endpoint, { model: 'fixture/b', maxMicro: 100_000, maxTokens: 400 }), 'provider-b');
  const covered = new Set(['provider-a']), grants = [];
  const consent = {
    coverage({ scope, consentRevision }) {
      return scope.recipients.every(r => covered.has(r)) ? { covered: true, ...scope, scope, consentRevision, checkedAt: Date.now(), expiresAt: Date.now() + 60_000 } : { covered: false };
    },
    grant({ scopes }) { grants.push(scopes); for (const scope of scopes) for (const recipient of scope.recipients) covered.add(recipient); },
  };
  const presets = { best: { plugins: ['openrouter'], policy: { endpoints: [fake.endpoint] }, choices: { models: [{ id: 'a', binding: a }, { id: 'b', binding: b }] } },
    eu: { plugins: [], bindings: {} }, custom: { plugins: [], bindings: {} } };
  const registry = new PluginRegistry().register(openRouter(a));
  const h = host(t, { presets, registry, consent }), { session } = await h.create();
  const catalog = (await json(await h.call(`/${session.id}/settings`))).body;
  assert.deepEqual(catalog.presets.best.models.map(o => o.status), ['available', 'consent']);
  const saved = await json(await h.save(session.id, { model: 'b' }));
  assert.equal(saved.status, 200); assert.deepEqual(saved.body.consent, { required: true, features: ['text', 'analysis'] });
  assert.equal(saved.body.featureMatrix.best.text.reason, 'current processing consent required');
  await h.call(`/${session.id}/turns`, { clientEventId: 'first', content: 'Hello' }); await h.handlers.idle();
  assert.equal(fake.bodies.length, 0, 'nothing reaches the newly chosen provider before consent');
  assert.equal((await h.call(`/${session.id}/consent`, { granted: true })).status, 200); await h.handlers.idle();
  assert.deepEqual(grants.at(-1).map(scope => [scope.recipients, scope.operation, scope.model]),
    [[['provider-b'], 'stream', 'fixture/b'], [['provider-b'], 'structured', 'fixture/b']]);
  assert.deepEqual(fake.bodies.map(body => body.model), ['fixture/b', 'fixture/b']);
  assert.equal((await json(await h.call(`/${session.id}`))).body.featureMatrix.best.text.available, true);
});

test('a voice call keeps its choice: changes wait for the call to end and a recovery never continues under a new choice', async t => {
  const h = host(t, { presets: mockPresetsWithChoices({ voice: true }), voice: true }), { session } = await h.create();
  const voice = (suffix, body) => h.call(`/${session.id}/voice${suffix}`, body);
  const call = await json(await voice('', { callId: 'call-1' }));
  assert.equal(call.status, 201);
  const refused = await json(await h.save(session.id, { model: 'mock/deep' }));
  assert.deepEqual(refused, { status: 409, body: { error: 'voice-call-active' } });
  assert.equal((await json(await h.call(`/${session.id}/settings`))).body.voiceCallActive, true);
  assert.equal((await voice('/call-1/close', { providerSessionId: call.body.providerSessionId })).status, 200);
  await h.handlers.idle();
  assert.equal((await h.save(session.id, { model: 'mock/deep' })).status, 200);
  const recovered = await voice('/call-1/recover', { providerSessionId: call.body.providerSessionId });
  assert.equal(recovered.status, 403, 'a call started under the old choice is not continued');
  assert.equal(h.storage.voiceCalls(session.id)[0].settingsRevision, 0);
  const next = await json(await voice('', { callId: 'call-2' }));
  assert.equal(next.status, 201, 'an explicitly started call uses the new choice');
  assert.equal(h.storage.voiceCalls(session.id).find(c => c.callId === 'call-2').settingsRevision, 1);
  assert.equal((await voice('/call-2/close', { providerSessionId: next.body.providerSessionId })).status, 200);
  await h.handlers.idle();
  assert.equal((await h.save(session.id, { voice: 'off' })).status, 200);
  assert.equal((await voice('', { callId: 'call-3' })).status, 403, 'voice off refuses new calls server-side');
  assert.equal((await json(await h.call(`/${session.id}`))).body.featureMatrix.best.voice.reason, 'voice off');
});

test('choices persist, the owner\'s last confirmed choice is the next default, and erasure or a withdrawn offer removes it', async t => {
  const path = await temporaryDb();
  let h = host(t, { path });
  const first = (await h.create()).session;
  assert.equal(first.settings.origin, 'default'); assert.equal(first.settings.model, 'mock');
  assert.equal((await h.save(first.id, { processingPreset: 'custom', model: 'mock/deep', effort: 'low' })).status, 200);
  await h.close();
  h = host(t, { path });
  assert.deepEqual(h.storage.get(first.id).settings, { ...h.storage.get(first.id).settings, model: 'mock/deep', effort: 'low', origin: 'chosen', revision: 1 });
  const second = (await h.create()).session;
  assert.equal(second.processingPreset, 'custom');
  assert.deepEqual([second.settings.model, second.settings.effort, second.settings.origin, second.settings.revision], ['mock/deep', 'low', 'last', 0]);
  const stranger = (await h.create({}, 'another-owner')).session;
  assert.deepEqual([stranger.processingPreset, stranger.settings.origin], ['best', 'default'], 'choices never cross owners');
  assert.equal((await h.create({ processingPreset: 'best' })).session.settings.origin, 'default', 'an explicit other preset uses its defaults');
  h.presets.custom.choices.models = h.presets.custom.choices.models.filter(o => o.id !== 'mock/deep');
  assert.equal((await h.create()).session.settings.origin, 'default', 'a choice the host no longer offers is not offered again');
  h.presets.custom.choices.models.push(mockPresetsWithChoices().custom.choices.models[1]);
  assert.equal((await h.call(`/${first.id}/erase`, {})).status, 200);
  const third = (await h.create()).session;
  assert.deepEqual([third.processingPreset, third.settings.origin], ['best', 'default'], 'an erased conversation no longer supplies defaults');
});

test('every save names its base revision: A then B then a replay of A is refused with the current revision', async t => {
  const h = host(t), { session } = await h.create(), path = `/${session.id}/settings`;
  const a = { model: 'mock/deep', effort: 'high', baseRevision: 0 };
  const first = await json(await h.call(path, a));
  assert.equal(first.status, 200); assert.equal(first.body.settings.revision, 1);
  const second = await json(await h.call(path, { model: 'mock', baseRevision: 1 }));
  assert.equal(second.status, 200); assert.equal(second.body.settings.revision, 2);
  const replay = await json(await h.call(path, a));
  assert.equal(replay.status, 409); assert.equal(replay.body.error, 'settings-conflict');
  assert.deepEqual([replay.body.settings.model, replay.body.settings.revision], ['mock', 2], 'the refusal carries the current revision');
  for (const body of [{ model: 'mock/deep', effort: 'high' }, { model: 'mock/deep', effort: 'high', baseRevision: null }, { model: 'mock/deep', baseRevision: -1 }]) {
    const missing = await json(await h.call(path, body));
    assert.equal(missing.status, 400, JSON.stringify(body)); assert.equal(missing.body.error, 'base-revision-required');
    assert.equal(missing.body.settings.revision, 2);
  }
  assert.throws(() => h.storage.changeSettings(session.id, { processingPreset: 'best', settings: { model: 'mock/deep', effort: 'high', voice: 'off', visuals: 'off' } },
    { ownerToken: owner }), /base revision required/, 'storage has no optional path either');
  assert.throws(() => h.storage.changeSettings(session.id, { processingPreset: 'best', settings: { model: 'mock/deep', effort: 'high', voice: 'off', visuals: 'off' } },
    { ownerToken: owner, baseRevision: 1 }), /settings-conflict/);
  assert.deepEqual(h.storage.get(session.id).settings.model, 'mock', 'the stale writes left B in force');
  const resend = await json(await h.call(path, { model: 'mock', baseRevision: 2 }));
  assert.equal(resend.status, 200); assert.equal(resend.body.unchanged, true, 'resending the current choice on the current revision is idempotent');
  assert.equal(h.storage.read(session.id).filter(e => e.type === 'settings.changed').length, 2);
});

test('a started conversation cannot cross the device boundary in place, even after every turn is withdrawn', async t => {
  const h = host(t), { session } = await h.create(), path = `/${session.id}/settings`;
  const empty = (await h.create()).session;
  const device = await json(await h.save(empty.id, { processingPreset: 'device' }));
  assert.equal(device.status, 200, 'an unstarted conversation may become a device conversation');
  assert.deepEqual(device.body.featureMatrix.device.analysis, { available: false, reason: 'unavailable on device' });
  assert.equal((await h.call(`/${session.id}/turns`, { clientEventId: 'started', content: 'Hello' })).status, 200);
  const crossing = await json(await h.save(session.id, { processingPreset: 'device' }));
  assert.equal(crossing.status, 409); assert.equal(crossing.body.error, 'new-conversation-required');
  await h.handlers.idle();
  assert.equal((await h.call(`/${session.id}/withdraw`, { turnId: 'started' })).status, 200);
  assert.equal(h.storage.get(session.id).transcript.filter(t => !t.withdrawn).length, 0, 'no active turn remains');
  const afterWithdrawal = await json(await h.save(session.id, { processingPreset: 'device' }));
  assert.equal(afterWithdrawal.status, 409, 'withdrawal does not erase the evidence that the conversation started');
  assert.equal(afterWithdrawal.body.error, 'new-conversation-required');
  assert.equal(h.storage.get(session.id).processingPreset, 'best');
});

test('creation validates the requested preset like a save: a preset the host does not offer is refused, never created', async t => {
  const presets = mockPresetsWithChoices(); presets.custom = { plugins: [], bindings: {} }; delete presets.eu;
  const h = host(t, { presets });
  for (const processingPreset of ['custom', 'eu']) {
    const { response, session } = await h.create({ processingPreset });
    assert.equal(response.status, 409, processingPreset);
    assert.deepEqual(session, { error: 'setting-not-allowed', field: 'processingPreset',
      reason: processingPreset === 'eu' ? 'preset not configured' : 'not configured' }, processingPreset);
  }
  assert.equal((await h.create({ processingPreset: 'unknown' })).response.status, 400);
  const created = await h.create({ processingPreset: 'best' });
  assert.equal(created.response.status, 201); assert.deepEqual([created.session.settings.model, created.session.settings.origin], ['mock', 'default']);
  assert.equal(h.storage.list().length, 1, 'refused creations leave no conversation behind');
});

test('static validation covers the understanding lane too: a split binding refuses an effort only reaction supports', async t => {
  const presets = mockPresetsWithChoices();
  presets.best.choices.models.push({ id: 'split', label: 'Split', bindings: { reaction: mock('mock/deep', 'medium'), understanding: mock('mock/swift', 'low') },
    efforts: ['low', 'medium', 'high'], effort: 'low' });
  const h = host(t, { presets }), { session } = await h.create();
  const catalog = (await json(await h.call(`/${session.id}/settings`))).body;
  assert.deepEqual(catalog.presets.best.models.find(o => o.id === 'split').efforts, ['low'], 'only efforts both lanes support are offered');
  const refused = await json(await h.save(session.id, { model: 'split', effort: 'high' }));
  assert.deepEqual(refused, { status: 409, body: { error: 'setting-not-allowed', field: 'model', reason: 'effort not supported' } });
  assert.equal(h.storage.get(session.id).settings.revision, 0);
  presets.best.choices.models.push({ id: 'split-ops', label: 'No structured', bindings: { reaction: mock('mock'), understanding: { ...mock('mock'), plugin: 'absent' } } });
  const absent = await json(await h.save(session.id, { model: 'split-ops' }));
  assert.deepEqual(absent.body, { error: 'setting-not-allowed', field: 'model', reason: 'plugin not in preset' });
  assert.equal((await h.save(session.id, { model: 'split', effort: 'low' })).status, 200);
});

test('consent scopes cover only operations the selected manifest supports and the host admits', async t => {
  const paid = { ...localImageBinding, maxMicro: 400300, imageCost: { inputMicro: 2, outputMicro: 3, maxInputTokens: 200000, maxOutputTokens: 100 } };
  const qualified = { ...paid, legal: qualify(paid).legal };
  const images = createLocalImages({ delayMs: 1 }), manifest = { ...images.manifest, models: images.manifest.models.map(m => ({ ...m, operations: ['generate'] })) };
  const { imageCost, ...common } = qualified;
  const generateOnly = { ...images, manifest, binding: common, generate: (...args) => images.generate(...args) };
  const presets = mockPresetsWithChoices();
  presets.best.plugins.push('fake-images'); presets.best.policy = { endpoints: [qualified.endpoint] };
  presets.best.choices.visuals = [{ id: 'generate-only', label: 'Generate only', binding: qualified }];
  const registry = new PluginRegistry().register(createMockReasoning()).register(generateOnly);
  const h = host(t, { presets, registry }), { session } = await h.create({ settings: { visuals: 'generate-only' } });
  const scopes = h.runtime.scopes(h.storage.get(session.id));
  assert.deepEqual(scopes.filter(scope => scope.operation).map(scope => scope.operation), ['generate'], 'no image edit scope for a generate-only manifest');
  presets.best.plugins = presets.best.plugins.filter(id => id !== 'fake-images');
  assert.equal(h.runtime.scopes(h.storage.get(session.id)).some(scope => scope.operation === 'generate'), false, 'a plugin outside the preset is not admitted');
});

test('erasure removes the stored choice from the owner default, the snapshot and the journal', async t => {
  const h = host(t), { session } = await h.create();
  assert.equal((await h.save(session.id, { processingPreset: 'custom', model: 'mock/deep', effort: 'low' })).status, 200);
  assert.equal((await h.call(`/${session.id}/turns`, { clientEventId: 'first', content: 'Hello' })).status, 200); await h.handlers.idle();
  const raw = () => JSON.stringify([h.storage.db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(session.id),
    h.storage.db.prepare('SELECT event FROM events WHERE session_id=?').all(session.id),
    h.storage.db.prepare('SELECT bytes FROM content WHERE session_id=?').all(session.id)]);
  assert.ok(raw().includes('mock/deep'), 'the choice is stored before erasure');
  assert.equal(JSON.stringify(h.storage.db.prepare('SELECT event FROM events WHERE session_id=?').all(session.id)).includes('mock/deep'), false,
    'the journal keeps references only');
  assert.equal((await h.call(`/${session.id}/erase`, {})).status, 200);
  assert.equal(raw().includes('mock/deep'), false, 'no trace of the choice remains in snapshot, journal or content');
  const snapshot = JSON.parse(h.storage.db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(session.id).snapshot);
  assert.equal(snapshot.processingPreset, 'best', 'the chosen preset is forgotten in the durable snapshot');
  assert.equal(raw().includes('"processingPreset":"custom"'), false, 'no trace of the chosen preset remains');
  assert.equal(h.storage.lastSettings(owner), null);
  assert.deepEqual([(await h.create()).session.settings.origin], ['default']);
  const replayed = h.storage.read(session.id).find(e => e.type === 'settings.changed');
  assert.equal(replayed.data.erased, true, 'the journal entry replays as an erased tombstone');
});

test('visuals and voice choices drive the image and live-voice features; creation validates an explicit choice', async t => {
  const h = host(t, { presets: mockPresetsWithChoices({ voice: true, images: true }), voice: true, images: true });
  const created = await h.create({ processingPreset: 'custom', settings: { model: 'mock/deep', effort: 'high', visuals: 'fake-images', voice: 'off' } });
  assert.equal(created.response.status, 201);
  assert.deepEqual([created.session.settings.origin, created.session.settings.visuals, created.session.engine.visuals.label], ['chosen', 'fake-images', 'Fake images']);
  assert.equal(created.session.featureMatrix.custom.voice.reason, 'voice off');
  assert.equal(created.session.conceptCost.maxMicro, 0, 'the image quote follows the visitor\'s visuals choice');
  const id = created.session.id;
  assert.equal((await json(await h.call(`/${id}`))).body.featureMatrix.custom.images.available, true);
  const off = await json(await h.save(id, { visuals: 'off' })); assert.equal(off.status, 200, JSON.stringify(off.body));
  const snapshot = (await json(await h.call(`/${id}`))).body;
  assert.equal(snapshot.featureMatrix.custom.images.reason, 'visuals off'); assert.equal(snapshot.conceptCost, null);
  const concept = await h.call(`/${id}/concepts`, { clientEventId: 'wish', intent: true, sourceTurnId: 'none' });
  assert.equal(concept.status, 403, 'visual concepts are refused while visuals are off');
  for (const [body, status] of [[{ settings: { model: 'evil/model' } }, 409], [{ settings: 'deep' }, 400], [{ processingPreset: 'eu', settings: {} }, 409]]) {
    assert.equal((await h.create(body)).response.status, status, JSON.stringify(body));
  }
});

test('visuals off stops new concept renders without hiding earlier ones; each artifact is published under its own provider', async t => {
  const presets = mockPresetsWithChoices({ images: true });
  presets.custom.choices.visuals.push({ id: 'other-images', label: 'Other images', binding: { ...localImageBinding, maxTokens: 2 } });
  const h = host(t, { presets, images: true });
  const { session } = await h.create({ processingPreset: 'custom', settings: { model: 'mock/deep', effort: 'high', visuals: 'fake-images', voice: 'off' } });
  const id = session.id, content = 'We need a clear dashboard for our public API.';
  assert.equal((await h.call(`/${id}/turns`, { clientEventId: 'first', content })).status, 200); await h.handlers.idle();
  const current = h.storage.get(id);
  // Arm the concept milestone exactly as the concept tests do: a final, ready understanding.
  h.storage.append(id, 'understanding.updated', reduceUnderstanding(current.understanding, { summary: 'A public API dashboard', signals: [], openQuestions: [],
    constraints: Object.fromEntries(current.preset.requiredSlots.map(slot => [slot, { value: 'fixture answer', evidence: content }])),
    progress: { talk: { value: current.preset.talkThreshold }, build: { value: 0.6 } } }, { transcript: current.transcript, inputRevision: inputRevision(current), preset: current.preset }));
  assert.equal((await h.call(`/${id}/concepts`, { clientEventId: 'wish', intent: true, sourceTurnId: 'first' })).status, 202);
  await h.handlers.idle();
  const concept = h.storage.get(id).concepts.at(-1);
  assert.ok(concept, JSON.stringify(h.storage.get(id).conceptStatus)); assert.equal(concept.visuals, 'fake-images', 'the artifact records its producer');
  assert.equal((await h.save(id, { visuals: 'off' })).status, 200);
  assert.equal((await h.call(`/${id}/concepts/${concept.id}/image`)).status, 200, 'turning visuals off keeps earlier concepts readable');
  assert.equal((await h.call(`/${id}/concepts`, { clientEventId: 'again', intent: true, sourceTurnId: 'first' })).status, 403, 'but starts no new render');
  assert.ok(Object.keys(unzip(await (await h.call(`/${id}/export`)).arrayBuffer())).some(name => name.startsWith(`concepts/${concept.id}.`)));
  h.presets.custom.choices.visuals = h.presets.custom.choices.visuals.filter(option => option.id !== 'fake-images');
  assert.equal((await h.save(id, { visuals: 'other-images' })).status, 200);
  assert.equal((await h.call(`/${id}/concepts/${concept.id}/image`)).status, 403, 'another provider never vouches for this artifact');
  assert.equal(Object.keys(unzip(await (await h.call(`/${id}/export`)).arrayBuffer())).some(name => name.startsWith(`concepts/${concept.id}.`)), false);
});

test('a conversation keeps a bounded history of choices', async t => {
  const h = host(t), { session } = await h.create();
  for (let i = 0; i < 1000; i++) h.storage.changeSettings(session.id, { processingPreset: 'best', settings: { model: i % 2 ? 'mock' : 'mock/deep',
    effort: i % 2 ? 'none' : 'low', voice: 'off', visuals: 'off' } }, { ownerToken: owner, baseRevision: i });
  assert.equal(h.storage.get(session.id).settings.revision, 1000);
  assert.equal((await h.save(session.id, { model: 'mock/deep', effort: 'high' })).status, 413);
  assert.equal((await h.save(session.id, { model: 'mock' })).status, 200, 'resending the current choice stays idempotent');
});

test('a host can withhold On my device; it is then refused everywhere with a reason', async t => {
  const presets = { ...mockPresetsWithChoices(), device: false }, h = host(t, { presets }), { session } = await h.create();
  assert.deepEqual(session.featureMatrix.device.text, { available: false, reason: 'preset not configured' });
  const catalog = (await json(await h.call(`/${session.id}/settings`))).body;
  assert.deepEqual([catalog.presets.device.offered, catalog.presets.device.status], [false, 'unavailable']);
  assert.deepEqual((await json(await h.save(session.id, { processingPreset: 'device' }))).body,
    { error: 'setting-not-allowed', field: 'processingPreset', reason: 'preset not configured' });
  assert.equal((await h.create({ processingPreset: 'device' })).response.status, 409);
});

test('one Visuals choice governs HTML and images: the selected option names the kind, and the B1 preset preference still applies', async t => {
  const presets = mockPresetsWithChoices({ images: true });
  presets.best.plugins.push('fake-html');
  presets.best.choices.visuals = [{ id: 'html', label: 'HTML click-dummy', kind: 'html', binding: localHTMLBinding },
    { id: 'images', label: 'Image concepts', binding: localImageBinding }];
  presets.best.choices.defaults.visuals = 'html';
  const registry = new PluginRegistry().register(createMockReasoning()).register(createLocalHTML());
  const h = host(t, { presets, registry, images: true }), { session } = await h.create();
  const kinds = body => [body.conceptVisualKind, body.featureMatrix.best.html.available, body.featureMatrix.best.images.reason];
  assert.deepEqual(kinds(session), ['html', true, 'visual kind not selected']);
  assert.deepEqual(h.runtime.scopes(h.storage.get(session.id)).length, 1, 'the local demo needs only the mock grant');
  assert.equal((await h.save(session.id, { visuals: 'images' })).status, 200);
  const images = (await json(await h.call(`/${session.id}`))).body;
  assert.deepEqual([images.conceptVisualKind, images.featureMatrix.best.images.available, images.featureMatrix.best.html.reason], ['images', true, 'visual kind not selected']);
  assert.equal((await h.save(session.id, { visuals: 'off' })).status, 200);
  const off = (await json(await h.call(`/${session.id}`))).body;
  assert.deepEqual([off.featureMatrix.best.html.reason, off.featureMatrix.best.images.reason], ['visuals off', 'visuals off']);
  assert.throws(() => normalizeChoices({ choices: { visuals: [{ id: 'x', kind: 'video' }] } }), /Invalid visual choice/);
  assert.throws(() => normalizeChoices({ choices: { voices: [{ id: 'x', kind: 'html' }] } }), /Invalid voice choice/);
  // Legacy single bindings keep the B1 contract: HTML leads, `bindings.visuals` picks images explicitly.
  const legacy = mockPresets(); legacy.best.plugins.push('fake-html', 'fake-images');
  Object.assign(legacy.best.bindings, { html: localHTMLBinding, images: localImageBinding });
  assert.deepEqual(normalizeChoices(legacy.best).visuals.map(o => [o.id, o.kind]), [['default', 'html']]);
  legacy.best.bindings.visuals = 'images';
  assert.deepEqual(normalizeChoices(legacy.best).visuals.map(o => [o.id, o.kind, o.binding.plugin]), [['default', 'images', 'fake-images']]);
});
