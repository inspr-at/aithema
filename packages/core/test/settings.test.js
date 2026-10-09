import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsGauges, normalizeSettings, defaultSettings, preferredEffort, sortEfforts, isDynamicReason, isConsentReason,
  sameSelection, createSession, applyEvent, inputRevision, SessionLanes, createMockReasoning, isCanonicalMockReasoning,
  mockManifest, validateManifest } from '../src/index.js';

const facts = (overrides = {}) => ({ vendor: 'Fixture', qualification: 'unverified', processingLocations: ['unverified'], streaming: true,
  structured: true, efforts: ['none', 'low', 'high'], operations: ['stream', 'structured'], formats: [], free: false,
  cost: { unit: 'token', inputMicro: null, outputMicro: null, reviewedAt: null }, ...overrides });
const option = (id, f) => ({ id, label: id, facts: facts(f) });

test('gauges follow manifest facts: unverified stays unverified, ratings need a source, speed follows effort and streaming', () => {
  const plain = option('plain');
  let g = settingsGauges({ preset: 'best', info: { models: [plain] }, model: plain, effort: 'none' });
  assert.deepEqual(g.quality, { state: 'unverified', fill: 0 });
  assert.equal(g.speed.state, 'index'); assert.equal(g.speed.index, 5); assert.equal(g.speed.fill, 100);
  assert.deepEqual(g.cost, { state: 'unverified', fill: 0 });
  assert.equal(g.privacy.state, 'unverified'); assert.equal(g.voice.state, 'off'); assert.equal(g.images.state, 'off');
  g = settingsGauges({ preset: 'best', info: {}, model: option('slow', { streaming: false }), effort: 'high' });
  assert.equal(g.speed.index, 2, 'a non-streaming model loses one preference step');
  const qualified = option('q', { qualification: 'qualified' });
  assert.equal(settingsGauges({ preset: 'best', model: qualified, effort: 'low' }).quality.state, 'qualified');
  const rated = { ...option('r'), facts: facts({ quality: { score: 82, source: { name: 'Index', url: 'https://index.example', asOf: '2026-09-01' } } }) };
  assert.deepEqual(settingsGauges({ preset: 'best', model: rated, effort: 'low' }).quality,
    { state: 'rated', fill: 82, score: 82, source: { name: 'Index', url: 'https://index.example', asOf: '2026-09-01' } });
  const unsourced = { ...option('u'), facts: facts({ quality: { score: 99 } }) };
  assert.equal(settingsGauges({ preset: 'best', model: unsourced, effort: 'low' }).quality.state, 'unverified', 'a score without a source is not shown');
});

test('cost and privacy gauges combine every selected binding; host policy guarantees outrank declared locations', () => {
  const free = option('free', { free: true }), freeVoice = { ...option('v', { free: true }), facts: facts({ free: true, capabilities: { a: 'native' } }) };
  assert.deepEqual(settingsGauges({ preset: 'best', model: free, effort: 'none', voice: freeVoice }).cost, { state: 'free', fill: 0 });
  const paidVoice = { ...freeVoice, facts: { ...freeVoice.facts, free: false } };
  assert.equal(settingsGauges({ preset: 'best', model: free, effort: 'none', voice: paidVoice }).cost.state, 'unverified');
  const reviewed = cost => option('c' + cost, { cost: { unit: 'token', inputMicro: cost, outputMicro: cost, reviewedAt: '2026-09-01T00:00:00Z' } });
  const cheap = reviewed(1), dear = reviewed(4);
  assert.deepEqual(settingsGauges({ preset: 'best', info: { models: [cheap, dear] }, model: cheap, effort: 'none' }).cost, { state: 'reviewed', fill: 25, unit: 'token' });
  const eu = option('eu', { processingLocations: ['DE', 'FR'] }), us = option('us', { processingLocations: ['US'] });
  assert.equal(settingsGauges({ preset: 'best', model: eu, effort: 'none' }).privacy.state, 'eu');
  assert.equal(settingsGauges({ preset: 'best', model: us, effort: 'none' }).privacy.state, 'declared');
  assert.equal(settingsGauges({ preset: 'best', model: eu, effort: 'none', visuals: us }).privacy.state, 'declared', 'the least private selection wins');
  const enforced = settingsGauges({ preset: 'eu', info: { policy: { residency: 'eu' } }, model: option('x'), effort: 'none' }).privacy;
  assert.equal(enforced.state, 'eu'); assert.equal(enforced.enforced, true);
  assert.equal(settingsGauges({ preset: 'custom', info: { policy: { countries: ['US', 'DE'] } }, model: option('x'), effort: 'none' }).privacy.state, 'restricted');
  assert.equal(settingsGauges({ preset: 'device' }).privacy.state, 'device');
});

test('voice and image gauges are computed from manifest capabilities and operations, never per option', () => {
  const voice = { ...option('voice'), facts: facts({ capabilities: { sendText: 'native', pause: 'emulated', resume: 'emulated', heard: 'unavailable' } }) };
  const g = settingsGauges({ preset: 'best', model: option('m'), effort: 'none', voice,
    visuals: { ...option('img'), facts: facts({ operations: ['generate'], formats: ['image/png'], qualification: 'qualified' }) } });
  assert.deepEqual(g.voice, { state: 'unverified', fill: 50, native: 1, emulated: 2, total: 4 });
  assert.deepEqual(g.images, { state: 'qualified', fill: 50, operations: ['generate'], formats: ['image/png'] });
  const device = settingsGauges({ preset: 'device', voice, visuals: voice });
  assert.deepEqual([device.voice.state, device.images.state, device.quality.state], ['device', 'device', 'local']);
});

test('durable settings normalize strictly; efforts keep their canonical order and START preference', () => {
  assert.deepEqual(normalizeSettings(), defaultSettings());
  assert.deepEqual(normalizeSettings({ model: 'mock/deep', effort: 'high', voice: 'off', visuals: 'fake-images', revision: 2, origin: 'chosen', at: '2026-10-09T10:00:00.000Z' }),
    { revision: 2, model: 'mock/deep', effort: 'high', voice: 'off', visuals: 'fake-images', origin: 'chosen', at: '2026-10-09T10:00:00.000Z' });
  for (const invalid of [null, [], { model: '' }, { model: '../x' }, { effort: 'turbo' }, { voice: 5 }, { origin: 'browser' },
    { revision: -1 }, { at: 'yesterday' }, { binding: {} }]) assert.throws(() => normalizeSettings(invalid), TypeError);
  assert.deepEqual(sortEfforts(['max', 'low', 'none', 'high']), ['none', 'low', 'high', 'max']);
  assert.equal(preferredEffort(['low', 'medium', 'high'], 'low'), 'low');
  assert.equal(preferredEffort(['low', 'medium', 'high'], 'max'), 'high');
  assert.equal(preferredEffort(['none', 'low'], 'xhigh'), 'low');
  assert.equal(sameSelection({ model: 'a', effort: 'low', voice: 'off' }, { model: 'a', effort: 'low', voice: 'off', visuals: null }), true);
  for (const reason of ['session paused', 'budget denied', 'delegated reasoning: plugin unhealthy']) assert.equal(isDynamicReason(reason), true);
  for (const reason of ['not configured', 'binding evidence unverified', 'processing residency denied', 'delegated reasoning: not configured']) assert.equal(isDynamicReason(reason), false);
  assert.equal(isConsentReason('delegated reasoning: current processing consent required'), true);
});

test('settings.changed changes the processing choice without touching input, consent or cached understanding', () => {
  let session = createSession({ demo: true });
  session = applyEvent(session, { seq: 1, type: 'turn.final', data: { id: 't', role: 'user', content: 'Hello' } });
  const revision = inputRevision(session), understanding = session.understanding;
  const next = applyEvent(session, { seq: 2, type: 'settings.changed', data: { processingPreset: 'custom',
    settings: { revision: 1, model: 'mock/deep', effort: 'high', voice: 'off', visuals: 'off', origin: 'chosen', at: '2026-10-09T10:00:00.000Z' } } });
  assert.equal(next.processingPreset, 'custom'); assert.equal(next.settings.model, 'mock/deep'); assert.equal(next.seq, 2);
  assert.equal(inputRevision(next), revision); assert.deepEqual(next.understanding, understanding);
  assert.throws(() => applyEvent(session, { seq: 2, type: 'settings.changed', data: { processingPreset: 'fallback', settings: {} } }), TypeError);
  assert.throws(() => applyEvent(session, { seq: 2, type: 'settings.changed', data: { processingPreset: 'best', settings: { effort: 'turbo' } } }), TypeError);
});

test('a changed lane selection supersedes in-flight work like new input; an unchanged one is joined', async () => {
  let session = applyEvent(createSession({ demo: true }), { seq: 1, type: 'turn.final', data: { id: 't', role: 'user', content: 'Hello' } });
  session.ownerHash = 'owner';
  let selection = 'model-a', release; const signals = [];
  const gate = new Promise(resolve => { release = resolve; });
  const mock = createMockReasoning();
  const reasoning = { ...mock, async *stream(request, options) { signals.push(options.signal); await gate; yield* mock.stream(request, options); } };
  const published = [];
  const lanes = new SessionLanes({ reasoning, getSession: () => session, selection: (_, lane) => `${lane}:${selection}`,
    publish(id, type, data) { published.push({ type, data }); return true; }, admit: async ({ options }) => ({ plugin: reasoning, options, finish() {} }) });
  const first = lanes.run(session.id, 'reaction');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lanes.run(session.id, 'reaction'), first, 'the same choice joins the running flight');
  selection = 'model-b'; lanes.supersede(session.id);
  assert.equal(signals[0].aborted, true, 'the old choice is cancelled');
  const second = lanes.run(session.id, 'reaction');
  assert.notEqual(second, first);
  release();
  await first.catch(() => {}); assert.equal(await second, 'completed');
  assert.equal(published.length, 1, 'only the current choice publishes');
});

test('the canonical mock binds to demo models, keeps its identity and answers in each model\'s own words', async () => {
  assert.equal(validateManifest(mockManifest).ok, true);
  assert.deepEqual(mockManifest.models.map(m => [m.id, m.efforts]), [['*', ['none']], ['mock/swift', ['none', 'low']], ['mock/deep', ['low', 'medium', 'high']]]);
  const base = createMockReasoning(), deep = base.bind({ model: 'mock/deep', effort: 'high' });
  assert.equal(isCanonicalMockReasoning(deep), true); assert.equal(isCanonicalMockReasoning({ ...deep }), false);
  const read = async plugin => { let text = ''; for await (const delta of plugin.stream({ locale: 'en', messages: [] }, {})) text += delta; return text; };
  assert.equal(await read(base), 'What should improve first?');
  assert.equal(await read(deep), 'Thinking it through (high effort): which outcome matters most, and what should improve first?');
  assert.equal(await read(base.bind({ model: 'mock/swift', effort: 'none' })), 'Briefly: what should improve first?');
});
