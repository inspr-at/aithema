import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../src/server.js';
import { SQLiteStorage } from '../../../packages/server/src/storage.js';
import { createPluginRuntime } from '../../../packages/server/src/plugin-runtime.js';
import { componentManifest, manifest } from '../src/manifest.js';
import { PluginRegistry, publicReasoningManifest, bindingReason } from '@inspr/aithema-core';

import { fixture, at, origin, urls } from './fixtures.js';

test('AIT-331: synthetic complete EU chain admits without claims, secrets or dispatch', async () => {
  const f = fixture(), authority = f.create();
  const result = authority.evaluate(f.request);
  assert.equal(result.reason, null); assert.equal(result.euEligible, true);
  assert.deepEqual(Object.keys(result.links), ['stt', 'reasoning', 'tts', 'host:0']);
  assert.equal(await authority.admissionReason(f.request), null);
  assert.deepEqual(f.covered.map(scope => scope.operation), ['stream', 'stream', 'speak', 'process']);
  assert.equal(authority.ports.serverAdapter.admissionReason, authority.admissionReason);
  assert.equal(authority.processingDetail().code, 'eu-undertaking');
  assert.ok(Object.isFrozen(authority));
  assert.equal(authority.start, undefined, 'package 2 never assembles or dispatches transports');
});

for (const [name, mutate] of [
  ['missing', f => { delete f.config.accountEvidence; }],
  ['expired', f => { f.config.accountEvidence.expiresAt = '2026-10-19'; }],
  ['future', f => { f.config.accountEvidence.reviewedAt = '2026-10-20'; }],
  ['invalid date', f => { f.config.accountEvidence.expiresAt = '2026-02-30'; }],
  ['account mismatch', f => { f.config.accountEvidence.accountRef = 'private:other'; }],
  ['secret mismatch', f => { f.config.accountEvidence.secretRef = 'private:other'; }],
  ['endpoint mismatch', f => { f.config.accountEvidence.endpoint = 'https://api.mistral.ai'; }],
  ['DPA mismatch', f => { f.componentBindings.tts.legal.evidence.dpaRef = 'private:other'; }],
  ['training', f => { f.config.accountEvidence.trainingOptOut = false; }],
  ['missing realtime ZDR', f => { f.config.accountEvidence.zdrEndpoints = [urls.tts, urls.reasoning]; }],
  ['unverified realtime availability', f => { delete f.config.accountEvidence.availabilityRef; }],
  ['service fallback', f => { f.config.accountEvidence.services.stt.endpoint = urls.stt.replace('api.eu.', 'api.'); }],
  ['binding fallback', f => { f.componentBindings.stt.routing = { fallback: 'https://api.mistral.ai' }; }],
  ['no host', f => { f.args.hostProcessing = []; }],
  ['host outside EU', f => { f.hostProcessing[0].binding.legal.processingCountries = ['CH']; }],
  ['recipient outside EU', f => { f.componentBindings.tts.legal.countries = ['US']; }],
  ['understated processing countries', f => { f.componentBindings.tts.legal.processingCountries = ['FR']; }],
  ['policy excludes regional', f => { f.request.policy.endpoints = ['https://api.mistral.ai']; }],
]) test(`AIT-331: ${name} evidence/chain fails closed`, async () => {
  const f = fixture(); mutate(f); const authority = f.create();
  assert.notEqual(authority.evaluate(f.request).reason, null);
  assert.notEqual(await authority.admissionReason(f.request), null);
});

for (const region of ['EU/EFTA', 'uncommitted']) test(`AIT-331: ${region} undertaking never means literal EU`, async () => {
  const f = fixture(); f.config.accountEvidence.undertaking = { region, processingCountries: region === 'EU/EFTA' ? ['FR', 'CH'] : [], controlPlaneIncluded: false };
  const authority = f.create();
  assert.equal(authority.evaluate(f.request).euEligible, false);
  assert.notEqual(await authority.admissionReason(f.request), null);
  const best = { ...f.request, preset: 'best' };
  assert.equal(authority.evaluate(best).reason, null);
  assert.equal(authority.processingDetail().code, 'regional-inference');
  assert.match(authority.processingDetail().text, /EU\/EFTA.*account and control data may be processed elsewhere/u);
});

test('AIT-331: EU undertaking excluding control plane is ineligible', () => {
  const f = fixture(); f.config.accountEvidence.undertaking.controlPlaneIncluded = false;
  assert.equal(f.create().evaluate(f.request).euEligible, false);
});

for (const patch of [{ plugin: 'other' }, { endpoint: 'https://api.mistral.ai' }, { accountRef: 'private:other' }]) {
  test(`AIT-331: reasoning ${JSON.stringify(patch)} cannot qualify EU`, () => {
    const f = fixture(); Object.assign(f.componentBindings.reasoning, patch);
    assert.equal(f.create().evaluate(f.request).euEligible, false);
  });
}

test('AIT-331: globally routed evidence never qualifies EU, even with EU-looking legal facts', () => {
  const f = fixture(), global = 'https://api.mistral.ai';
  f.config.endpoint = global; f.config.accountEvidence.endpoint = global;
  for (const service of Object.values(f.config.accountEvidence.services)) service.endpoint = service.endpoint.replace('api.eu.', 'api.');
  f.config.accountEvidence.zdrEndpoints = Object.values(f.config.accountEvidence.services).map(service => service.endpoint);
  for (const part of Object.values(f.componentBindings)) { part.endpoint = global; part.legal.evidence.endpoint = global; }
  f.request.policy.endpoints.push(global);
  const authority = f.create();
  assert.equal(authority.evaluate(f.request).euEligible, false);
  assert.equal(authority.evaluate({ ...f.request, preset: 'best' }).reason, null);
  assert.equal(authority.processingDetail().code, 'global-uncommitted');
});

test('AIT-331: authority snapshots private inputs without freezing or exposing caller evidence', () => {
  const f = fixture(), authority = f.create();
  f.config.accountEvidence.undertaking.processingCountries.push('US');
  f.componentBindings.stt.legal.training = true; f.plugins.stt.manifest = {};
  assert.equal(authority.evaluate(f.request).reason, null);
  assert.doesNotMatch(JSON.stringify(authority.processingDetail()), /private:|synthetic\/|Synthetic Mistral/u);
});

for (const change of ['withdrawn', 'revision', 'expired', 'scope', 'host consent', 'stale grant']) test(`AIT-331: ${change} denies admission and late results`, async () => {
  const f = fixture(), original = f.consent.coverage;
  f.consent.coverage = async request => {
    const grant = await original(request);
    if (change === 'withdrawn') f.setSession({ ...f.request.session, consentWithdrawn: true });
    if (change === 'revision') f.setSession({ ...f.request.session, consentRevision: 2 });
    if (change === 'expired') f.setClock(at + 120000);
    if (change === 'scope') grant.scope = { ...grant.scope, endpoint: 'https://wrong.test' };
    if (change === 'host consent' && request.scope.operation === 'process') grant.covered = false;
    if (change === 'stale grant') grant.checkedAt = at - 1001;
    return grant;
  };
  assert.notEqual(await f.create().admissionReason(f.request, { existingCall: true }), null);
});

test('AIT-331: expiry is revalidated after construction and all link outcomes are reported', () => {
  const f = fixture(), authority = f.create(); f.setClock(at + 120000);
  const result = authority.evaluate(f.request);
  assert.notEqual(result.reason, null); assert.ok(result.links.stt); assert.ok(result.links.reasoning); assert.ok(result.links.tts);
});

test('AIT-331: exact endpoint allowlist rejects arbitrary origins and malformed endpoints', () => {
  assert.equal(typeof server.voxtralEndpoints, 'function');
  assert.deepEqual(server.voxtralEndpoints(origin), urls);
  for (const endpoint of ['https://evil.test', `${origin}/`, `${origin}/v1`, `${origin}?x=1`, 'http://api.eu.mistral.ai']) {
    assert.throws(() => server.voxtralEndpoints(endpoint), TypeError);
  }
});

test('AIT-331: account validation freezes its snapshot and rejects extra evidence/inline secrets', () => {
  assert.equal(typeof server.validateVoxtralAccountConfiguration, 'function');
  const f = fixture(), saved = server.validateVoxtralAccountConfiguration(f.config, { now: at });
  assert.ok(Object.isFrozen(saved.accountEvidence.services.stt));
  assert.ok(Object.isFrozen(saved.accountEvidence.undertaking.processingCountries));
  f.config.accountEvidence.undertaking.processingCountries.push('US');
  assert.deepEqual(saved.accountEvidence.undertaking.processingCountries, ['FR', 'DE']);
  for (const mutate of [
    config => { config.apiKey = 'synthetic-inline-forbidden'; },
    config => { config.accountEvidence.apiKey = 'synthetic-inline-forbidden'; },
    config => { config.accountEvidence.services.stt.fallback = 'https://api.mistral.ai'; },
    config => { config.accountEvidence.zdrEnabled = false; },
    config => { config.accountEvidence.dpaAccepted = false; },
  ]) {
    const input = fixture().config; mutate(input);
    assert.throws(() => server.validateVoxtralAccountConfiguration(input, { now: at }), TypeError);
  }
});

test('AIT-331: current grant cannot revive a withdrawn call or deliver its late result', async () => {
  const f = fixture(), authority = f.create();
  assert.equal(await authority.admissionReason(f.request), null);
  f.setSession({ ...f.request.session, consentWithdrawn: true, consentRevision: 2 });
  assert.notEqual(await authority.admissionReason(f.request, { existingCall: true }), null);
});

test('AIT-331: in-place revision mutation during coverage cannot bypass the captured revision', async () => {
  const f = fixture(), original = f.consent.coverage;
  f.consent.coverage = async request => { const grant = await original(request); f.request.session.consentRevision++; return grant; };
  assert.notEqual(await f.create().admissionReason(f.request), null);
});

test('AIT-331: earlier grants are rechecked after the final host coverage returns', async () => {
  const f = fixture(), original = f.consent.coverage;
  f.consent.coverage = async request => {
    if (request.scope.operation === 'process') f.setClock(at + 1001);
    return original(request);
  };
  assert.notEqual(await f.create().admissionReason(f.request), null);
});

test('AIT-331: missing authoritative session reader and cancelled coverage fail closed', async () => {
  const f = fixture(); delete f.args.getSession;
  assert.notEqual(await f.create().admissionReason(f.request), null);
  const other = fixture();
  assert.notEqual(await other.create().admissionReason(other.request, { signal: AbortSignal.abort() }), null);
});

test('AIT-331: independently qualified other-provider reasoning is non-EU under best too', () => {
  const f = fixture(), b = f.componentBindings.reasoning;
  b.plugin = 'other'; b.endpoint = 'https://reasoning.test'; b.legal.evidence.endpoint = b.endpoint;
  f.plugins.reasoning = { manifest: publicReasoningManifest('other', 'Other', b.endpoint) };
  f.request.policy.endpoints.push(b.endpoint);
  const authority = f.create(), result = authority.evaluate({ ...f.request, preset: 'best' });
  assert.equal(result.reason, null); assert.equal(result.euEligible, false);
  assert.equal(result.links.stt.available, true); assert.equal(result.links.tts.available, true);
  assert.notEqual(authority.evaluate(f.request).links.reasoning.reason, null);
});

for (const euOnly of [true, false]) test(`AIT-331: ordinary feature matrix uses complete-chain authority (EU undertaking ${euOnly})`, async t => {
  const f = fixture(), storage = new SQLiteStorage(); t.after(() => storage.close());
  const session = storage.create({ ownerToken: 'synthetic-owner' }), clock = Date.now();
  f.setClock(clock); f.args.getSession = id => storage.get(id);
  if (!euOnly) f.config.accountEvidence.undertaking.region = 'EU/EFTA';
  for (const b of [...Object.values(f.componentBindings), f.hostProcessing[0].binding]) {
    b.legal.evidence.verifiedAt = clock - 1000; b.legal.evidence.expiresAt = clock + 60000;
  }
  const authority = f.create(), parent = structuredClone(f.componentBindings.stt);
  parent.plugin = 'voxtral-voice'; parent.model = 'voxtral-voice';
  Object.assign(parent.legal.evidence, { model: parent.model });
  Object.assign(parent, { maxDurationSeconds: 120, upstreamMicroPerMinute: 0, visitorMicroPerMinute: 0 });
  let dispatchAttempts = 0;
  const noDispatch = () => { dispatchAttempts++; assert.fail('Feature matrix must never dispatch'); };
  const voice = { binding: parent, manifest, health: async () => ({ available: true }), start: noDispatch,
    ports: { serverAdapter: { ...authority.ports.serverAdapter, binding: parent,
      validateConfig() {}, startSegment: noDispatch, stopSegment: noDispatch, reconciliationEvidence: noDispatch } } };
  const reasoning = { ...f.plugins.reasoning, binding: f.componentBindings.reasoning,
    health: async () => ({ available: true }), stream: noDispatch, structured: noDispatch };
  const registry = new PluginRegistry().register(voice).register(reasoning);
  const settings = { plugins: ['voxtral-voice', 'mistral'], policy: f.request.policy,
    bindings: { voice: parent, reaction: f.componentBindings.reasoning } };
  const runtime = createPluginRuntime({ storage, registry, consent: f.consent, presets: { best: settings, eu: settings } });
  const matrix = await runtime.matrix(session);
  assert.equal(matrix.best.voice.available, true, matrix.best.voice.reason);
  assert.equal(matrix.eu.voice.available, euOnly, matrix.eu.voice.reason);
  assert.equal(dispatchAttempts, 0);
});

test('AIT-331: missing regional account evidence still exposes honest processing detail, never eligibility', () => {
  const f = fixture(); delete f.config.accountEvidence;
  const authority = f.create();
  assert.equal(authority.processingDetail().code, 'regional-inference');
  assert.match(authority.processingDetail().text, /account and control data may be processed elsewhere/u);
  assert.equal(authority.evaluate(f.request).euEligible, false);
});

// Duplicates cannot hide one of the guaranteed countries while retaining length.
test('AIT-331: duplicate binding countries cannot understate the account undertaking', () => {
  const f = fixture(); f.componentBindings.tts.legal.processingCountries = ['FR', 'FR'];
  assert.notEqual(f.create().evaluate(f.request).reason, null);
});

for (const routing of [true, 0, false, null, [], new Date(at)]) test(`AIT-331: non-object routing ${JSON.stringify(routing)} fails closed`, async () => {
  const f = fixture();
  f.componentBindings.stt.routing = routing;
  f.componentBindings.stt.legal.evidence.routing = routing ?? {};
  assert.equal(bindingReason({ binding: f.componentBindings.stt, plugin: f.plugins.stt,
    ...f.request, now: at }), null, 'generic qualification alone accepts this malformed routing');
  const authority = f.create();
  assert.notEqual(authority.evaluate(f.request).reason, null);
  assert.notEqual(await authority.admissionReason(f.request), null);
});

test('AIT-331: consent-scope construction failure denies admission instead of skipping coverage', async t => {
  const f = fixture(), authority = f.create(), clone = globalThis.structuredClone;
  t.mock.method(globalThis, 'structuredClone', value => {
    if (value?.operation && value?.dataCategories) throw new TypeError('synthetic scope construction failure');
    return clone(value);
  });
  assert.notEqual(await authority.admissionReason(f.request), null);
  assert.equal(f.covered.length, 0);
  assert.throws(() => authority.processingScopes(), /synthetic scope construction failure/u);
});

test('AIT-331: admission requires the actual reasoning selection', async () => {
  const f = fixture(), authority = f.create(); delete f.request.reasoningBinding;
  assert.equal(await authority.admissionReason(f.request), 'selected reasoning binding must match the Voxtral authority');
});

for (const mismatch of ['provider', 'endpoint', 'account', 'DPA']) test(`AIT-331: session-selected EU-qualified ${mismatch} mismatch denies voice at the matrix and admission`, async t => {
  const f = fixture(), storage = new SQLiteStorage(); t.after(() => storage.close());
  const session = storage.create({ ownerToken: 'synthetic-owner', processingPreset: 'eu',
    settings: { model: 'selected', voice: 'voice', visuals: 'off' } });
  const clock = Date.now(); f.setClock(clock); f.args.getSession = id => storage.get(id);
  for (const b of [...Object.values(f.componentBindings), f.hostProcessing[0].binding]) {
    b.legal.evidence.verifiedAt = clock - 1000; b.legal.evidence.expiresAt = clock + 60000;
  }
  const selected = structuredClone(f.componentBindings.reasoning);
  if (mismatch === 'provider') selected.plugin = 'other';
  if (mismatch === 'endpoint') selected.endpoint = selected.legal.evidence.endpoint = 'https://reasoning.test';
  if (mismatch === 'account') selected.accountRef = selected.legal.evidence.accountRef = 'private:synthetic/other-account';
  if (mismatch === 'DPA') selected.legal.evidence.dpaRef = 'private:synthetic/other-dpa';
  const selectedPlugin = { manifest: publicReasoningManifest(selected.plugin, 'Selected reasoning', selected.endpoint) };
  f.request.policy.endpoints.push(selected.endpoint);
  assert.equal(bindingReason({ binding: selected, plugin: selectedPlugin, preset: 'eu', policy: f.request.policy, now: clock }), null);
  const authority = f.create(), parent = structuredClone(f.componentBindings.stt);
  parent.plugin = 'voxtral-voice'; parent.model = 'voxtral-voice'; parent.legal.evidence.model = parent.model;
  Object.assign(parent, { maxDurationSeconds: 120, upstreamMicroPerMinute: 0, visitorMicroPerMinute: 0 });
  let voiceDispatches = 0, reasoningDispatches = 0;
  const noVoice = () => { voiceDispatches++; assert.fail('Denied voice must never dispatch'); };
  const noReasoning = () => { reasoningDispatches++; assert.fail('Matrix and admission must never dispatch reasoning'); };
  const voice = { binding: parent, manifest, health: async () => ({ available: true }), start: noVoice,
    ports: { serverAdapter: { ...authority.ports.serverAdapter, binding: parent,
      validateConfig() {}, startSegment: noVoice, stopSegment: noVoice, reconciliationEvidence: noVoice } } };
  const reasoning = { ...selectedPlugin, binding: selected, health: async () => ({ available: true }), stream: noReasoning, structured: noReasoning };
  const expected = { ...f.plugins.reasoning, binding: f.componentBindings.reasoning,
    health: async () => ({ available: true }), stream: noReasoning, structured: noReasoning };
  const registry = new PluginRegistry().register(voice).register(reasoning);
  if (selected.plugin !== expected.manifest.id) registry.register(expected);
  const settings = { plugins: ['voxtral-voice', 'mistral', selected.plugin], policy: f.request.policy,
    choices: { models: [{ id: 'expected', binding: f.componentBindings.reasoning }, { id: 'selected', binding: selected }],
      voices: [{ id: 'voice', binding: parent }], defaults: { model: 'expected', voice: 'voice' } } };
  const runtime = createPluginRuntime({ storage, registry, consent: f.consent, presets: { eu: settings } });
  const matrix = await runtime.matrix(session);
  assert.equal(matrix.eu.text.available, true, matrix.eu.text.reason);
  assert.equal(matrix.eu.voice.available, false, 'session-selected qualified reasoning must be tied to the Voxtral authority');
  assert.equal(matrix.eu.voice.reason, 'selected reasoning binding must match the Voxtral authority');
  const request = { ...f.request, session, reasoningBinding: selected };
  assert.equal(authority.evaluate(request).euEligible, false);
  assert.equal(await authority.admissionReason(request), 'selected reasoning binding must match the Voxtral authority');
  assert.notEqual(await authority.admissionReason(request, { existingCall: true }), null);
  assert.equal(voiceDispatches, 0); assert.equal(reasoningDispatches, 0);
});

test('AIT-330: selected reasoning effort is independent of binding identity', async () => {
  const f = fixture();
  delete f.componentBindings.reasoning.effort;
  f.request.reasoningBinding = { ...f.componentBindings.reasoning, effort: 'none' };
  const authority = f.create();
  assert.equal(authority.evaluate(f.request).reason, null);
  assert.equal(await authority.admissionReason(f.request), null);
});

test('AIT-330: failed voice scope construction preserves other consent scopes', async t => {
  const f = fixture(), storage = new SQLiteStorage(); t.after(() => storage.close());
  f.setClock(Date.now()); f.args.getSession = id => storage.get(id);
  for (const b of [...Object.values(f.componentBindings), f.hostProcessing[0].binding]) {
    b.legal.evidence.verifiedAt = Date.now() - 1000; b.legal.evidence.expiresAt = Date.now() + 60000;
  }
  const parent = structuredClone(f.componentBindings.stt);
  Object.assign(parent, { plugin: 'voxtral-voice', model: 'voxtral-voice', maxDurationSeconds: 120, upstreamMicroPerMinute: 0, visitorMicroPerMinute: 0 });
  parent.legal.evidence.model = parent.model;
  const voice = { binding: parent, manifest, health: async () => ({ available: true }), start() {},
    ports: { serverAdapter: { ...f.create().ports.serverAdapter, binding: parent, validateConfig() {}, startSegment() {}, stopSegment() {}, reconciliationEvidence() {},
      processingScopes() { throw new TypeError('synthetic bad voice scopes'); } } } };
  const reasoning = { ...f.plugins.reasoning, binding: f.componentBindings.reasoning, health: async () => ({ available: true }), stream() {}, structured() {} };
  const registry = new PluginRegistry().register(voice).register(reasoning);
  const settings = { plugins: ['voxtral-voice', 'mistral'], policy: f.request.policy, bindings: { voice: parent, reaction: f.componentBindings.reasoning } };
  const runtime = createPluginRuntime({ storage, registry, consent: f.consent, presets: { eu: settings } });
  const session = storage.create({ ownerToken: 'synthetic-owner', processingPreset: 'eu' });
  const text = runtime.scopes(session, { feature: 'text' }); assert.ok(text.length);
  const matrix = await runtime.matrix(session);
  assert.equal(matrix.eu.text.available, true, matrix.eu.text.reason);
  assert.equal(matrix.eu.voice.available, false, 'broken voice scopes fail closed for voice');
  assert.deepEqual(runtime.scopes(session), text);
  assert.deepEqual(runtime.scopes(session, { feature: 'voice' }), text, 'delegated reasoning still needs consent; broken voice scopes are omitted');
});

test('AIT-330: runtime effort choices admit the same reasoning identity', async t => {
  const f = fixture(), storage = new SQLiteStorage(); t.after(() => storage.close());
  const clock = Date.now(); f.setClock(clock); f.args.getSession = id => storage.get(id);
  for (const b of [...Object.values(f.componentBindings), f.hostProcessing[0].binding]) {
    b.legal.evidence.verifiedAt = clock - 1000; b.legal.evidence.expiresAt = clock + 60000;
  }
  const reasoningManifest = structuredClone(f.plugins.reasoning.manifest);
  reasoningManifest.models[0].efforts = ['none', 'low'];
  f.plugins.reasoning.manifest = reasoningManifest;
  const authority = f.create(), parent = structuredClone(f.componentBindings.stt);
  Object.assign(parent, { plugin: 'voxtral-voice', model: 'voxtral-voice', maxDurationSeconds: 120, upstreamMicroPerMinute: 0, visitorMicroPerMinute: 0 });
  parent.legal.evidence.model = parent.model;
  const session = storage.create({ ownerToken: 'owner', processingPreset: 'eu', settings: { model: 'mistral', effort: 'low', voice: 'voice', visuals: 'off' } });
  const noDispatch = () => assert.fail('Matrix cannot dispatch');
  const voice = { binding: parent, manifest, health: async () => ({ available: true }), start: noDispatch,
    ports: { serverAdapter: { ...authority.ports.serverAdapter, binding: parent, validateConfig() {}, startSegment: noDispatch, stopSegment: noDispatch, reconciliationEvidence: noDispatch } } };
  const reasoning = { ...f.plugins.reasoning, binding: f.componentBindings.reasoning,
    bind(binding) { return { ...this, binding }; },
    health: async () => ({ available: true }), stream: noDispatch, structured: noDispatch };
  const registry = new PluginRegistry().register(voice).register(reasoning);
  const settings = { plugins: ['voxtral-voice', 'mistral'], policy: f.request.policy,
    choices: { models: [{ id: 'mistral', binding: f.componentBindings.reasoning, efforts: ['none', 'low'], effort: 'none' }],
      voices: [{ id: 'voice', binding: parent }], defaults: { model: 'mistral', voice: 'voice', effort: 'none' } } };
  const runtime = createPluginRuntime({ storage, registry, consent: f.consent, presets: { eu: settings } });
  const matrix = await runtime.matrix(session);
  assert.equal(matrix.eu.text.available, true, matrix.eu.text.reason);
  assert.equal(matrix.eu.voice.available, true, matrix.eu.voice.reason);
  assert.equal((await authority.admissionReason({ ...f.request, session, reasoningBinding: { ...f.componentBindings.reasoning, effort: 'low' } })), null);
  assert.equal(authority.evaluate({ ...f.request, reasoningBinding: { ...f.componentBindings.reasoning, effort: 'unsupported' } }).reason, 'effort not supported');
});
