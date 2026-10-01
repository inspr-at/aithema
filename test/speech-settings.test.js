import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sha256Hex, canonicalJson, validate, canExecute, contractEntry, loadContractFile } from '../contracts/validate.js';
import { computeCapabilityMatrix, SPEECH_CANDIDATES, speechAdapterDescriptors } from '../runtime/settings/index.js';
import { createConfiguredSpeechAdapter } from '../runtime/speech/index.js';
import { barrier, events, host, server, sttRequest, ttsRequest } from './fixtures/speech/helpers.mjs';
import { NOW, settingsContext, speechSettings } from './fixtures/speech/settings.mjs';

function matrixFor(doc, preset, extra = {}) {
  const context = settingsContext(doc, preset);
  return computeCapabilityMatrix(doc, { ...context, adapters: [...context.adapters, ...speechAdapterDescriptors(doc.provider_templates)], ...extra });
}

it('additive speech settings use minor 1 and leave the existing fixture and canonical golden vector unchanged', () => {
  assert.equal(contractEntry('aithema.settings').minor, 1);
  const doc = speechSettings();
  doc.voice.vad = { adapter: 'pcm-energy-vad', threshold: 0.02, max_frame_ms: 20 };
  doc.min_reader = 1;
  assert.equal(validate('aithema.settings', doc).ok, true);
  assert.deepEqual(canExecute(doc), { ok: true });
  assert.deepEqual(canExecute(doc, { 'aithema.settings': { major: 1, minor: 0 } }), { ok: false, code: 'contract_too_new' });
  const original = JSON.parse(readFileSync(new URL('../contracts/fixtures/valid/settings.executable.json', import.meta.url))).doc;
  assert.equal(original.minor, 0); assert.equal(validate('aithema.settings', original).ok, true);
  assert.equal(sha256Hex(canonicalJson(original)), 'a3c2df8886decc10b2f71575a3c9659373685d89b78ec2776865069c881b986f');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(canonicalJson({ z: 1, a: 'de' }), '{"a":"de","z":1}');
  const table = loadContractFile('capabilities.json').speech;
  assert.deepEqual(table.lanes, ['stt', 'tts']); assert.equal(table.input.max_utterance_seconds, 30);
});

for (const vad of [{ adapter: 'other', threshold: 0.02, max_frame_ms: 20 }, { adapter: 'pcm-energy-vad', threshold: 0, max_frame_ms: 20 },
  { adapter: 'pcm-energy-vad', threshold: 0.02, max_frame_ms: 101 }, { adapter: 'pcm-energy-vad', threshold: 0.02, max_frame_ms: 20, extra: 1 }]) {
  it(`VAD settings reject unsupported/unbounded config ${JSON.stringify(vad)}`, () => {
    const doc = speechSettings(); doc.voice.vad = vad;
    assert.equal(validate('aithema.settings', doc).ok, false);
  });
}

for (const preset of ['local-l1', 'eu-e1', 'cloud-c1']) {
  it(`${preset}: speech lanes appear as enabled with synthetic, account-bound qualification`, () => {
    const doc = speechSettings(preset), matrix = matrixFor(doc, preset);
    assert.equal(validate('aithema.settings', doc).ok, true);
    for (const lane of ['stt', 'tts']) { assert.equal(matrix.lanes[lane].enabled, true); assert.deepEqual(matrix.lanes[lane].reasons, []); }
    assert.equal(matrix.voice.enabled, true);
    for (const candidate of SPEECH_CANDIDATES.filter((candidate) => candidate.preset === preset)) {
      assert.ok(matrix.lanes[candidate.lane].template_ref.includes(candidate.id)); assert.ok(candidate.reason);
    }
  });
}

for (const reason of ['evidence_expired', 'evidence_missing', 'account_mismatch', 'residency_denied', 'adapter_unhealthy', 'voice_disabled', 'budget_denied', 'authorization_withdrawn']) {
  it(`speech capability reports ${reason} without fallback`, () => {
    const doc = speechSettings(), extra = {};
    const evidence = doc.evidence.filter((record) => record.id === 'evidence-openai-stt' || record.id === 'evidence-openai-tts');
    if (reason === 'evidence_expired') evidence.forEach((record) => { record.expires_at = NOW; });
    if (reason === 'evidence_missing') doc.evidence = doc.evidence.filter((record) => !evidence.includes(record));
    if (reason === 'account_mismatch') evidence.forEach((record) => { record.account_ref = 'wrong-account'; });
    if (reason === 'residency_denied') evidence.forEach((record) => { record.countries.logs = ['US@2026-01']; });
    if (reason === 'voice_disabled') extra.preferences = { preset: 'eu-e1', voice: { enabled: false, tts_voice: 'fixture-voice' } };
    if (reason === 'budget_denied') extra.budget = { currency: 'EUR', spent_micro: { session: 10000, principal_day: 0, tenant_day: 0 } };
    if (reason === 'adapter_unhealthy') {
      const context = settingsContext(doc);
      extra.adapters = [...context.adapters, ...speechAdapterDescriptors(doc.provider_templates, { unhealthy: ['openai-stt', 'openai-tts'] })];
    }
    if (reason === 'authorization_withdrawn') {
      const context = settingsContext(doc); context.authorization.record.withdrawn_at = NOW; extra.authorization = context.authorization;
    }
    const matrix = matrixFor(doc, 'eu-e1', extra);
    for (const lane of ['stt', 'tts']) { assert.equal(matrix.lanes[lane].enabled, false); assert.ok(matrix.lanes[lane].reasons.includes(reason)); }
    assert.equal(matrix.voice.enabled, false); assert.ok(matrix.voice.reasons.includes(reason));
  });
}

it('OpenAI Europe evidence including CH is refused by an EEA-only policy', () => {
  const doc = speechSettings();
  for (const record of doc.evidence.filter((record) => record.id.startsWith('evidence-openai'))) record.countries.inference = ['EEA+CH@2026-01'];
  const matrix = matrixFor(doc, 'eu-e1');
  for (const lane of ['stt', 'tts']) assert.ok(matrix.lanes[lane].reasons.includes('residency_denied'));
});

it('ElevenLabs standard is international C1; EU-E1 requires Enterprise even when country evidence says FR', () => {
  const doc = speechSettings('cloud-c1');
  const cloud = doc.presets['cloud-c1'];
  for (const record of doc.evidence.filter((record) => record.id.startsWith('evidence-elevenlabs'))) {
    for (const key of ['inference', 'storage', 'logs']) record.countries[key] = ['FR@2026-01'];
  }
  const eu = doc.presets['eu-e1']; eu.lanes.stt = cloud.lanes.stt; eu.lanes.tts = cloud.lanes.tts; eu.egress = cloud.egress;
  let matrix = matrixFor(doc, 'eu-e1');
  for (const lane of ['stt', 'tts']) assert.ok(matrix.lanes[lane].reasons.includes('account_tier_denied'));
  for (const record of doc.evidence.filter((record) => record.id.startsWith('evidence-elevenlabs'))) record.account_tier = 'enterprise';
  matrix = matrixFor(doc, 'eu-e1');
  for (const lane of ['stt', 'tts']) assert.equal(matrix.lanes[lane].enabled, true);
});

it('configured VAD is required for voice readiness with missing/invalid/unhealthy reasons', () => {
  const doc = speechSettings(); doc.voice.vad = { adapter: 'pcm-energy-vad', threshold: 0.02, max_frame_ms: 20 };
  for (const [vad, reason] of [[undefined, 'vad_missing'], [{ id: 'other', healthy: true }, 'vad_invalid'], [{ id: 'pcm-energy-vad', healthy: false }, 'vad_unhealthy']]) {
    const matrix = matrixFor(doc, 'eu-e1', { vad }); assert.equal(matrix.voice.enabled, false); assert.ok(matrix.voice.reasons.includes(reason));
  }
  assert.equal(matrixFor(doc, 'eu-e1', { vad: { id: 'pcm-energy-vad', healthy: true } }).voice.enabled, true);
});

it('configured speech binds exact operator account and evidence, then dispatches through a loopback fake server', async (t) => {
  const { client, journal } = host(t);
  const doc = speechSettings(); const context = settingsContext(doc);
  const endpoint = await server(t, (req, res) => { req.resume(); res.end('{"text":"Synthetic configured speech"}'); });
  const template = doc.provider_templates.find((template) => template.adapter === 'openai-stt');
  const options = { lane: 'stt', settings: doc, context: () => context, budget: client, now: () => NOW,
    binding: { account_ref: template.account_ref, secret_ref: template.secret.ref, priceUsage: () => 100 },
    fetchImpl: (url, opts) => { assert.equal(url, template.endpoint); return fetch(endpoint, opts); } };
  for (const binding of [{}, { account_ref: 'wrong', secret_ref: template.secret.ref }]) {
    assert.throws(() => createConfiguredSpeechAdapter({ ...options, binding }), (error) => error.reason === 'secret_binding_invalid');
  }
  const port = createConfiguredSpeechAdapter(options);
  assert.deepEqual(await port.transcribe(sttRequest()), { text: 'Synthetic configured speech' });
  assert.equal(events(journal).at(-1).data.outcome, 'settled');
});

it('evidence expiry and withdrawal after construction disable speech before any admission/socket', async (t) => {
  const { client, journal } = host(t);
  const doc = speechSettings(), context = settingsContext(doc);
  const template = doc.provider_templates.find((template) => template.adapter === 'openai-stt');
  let clock = NOW;
  const port = createConfiguredSpeechAdapter({ lane: 'stt', settings: doc, context: () => context, budget: client,
    now: () => clock, binding: { account_ref: template.account_ref, secret_ref: template.secret.ref, priceUsage: () => 100 },
    fetchImpl: () => assert.fail('No socket allowed') });
  clock = '2026-10-01T00:00:00Z';
  assert.throws(() => port.transcribe(sttRequest()), (error) => error.reason === 'evidence_expired');
  clock = NOW; context.authorization.record.withdrawn_at = NOW;
  assert.throws(() => port.transcribe(sttRequest()), (error) => error.reason === 'authorization_withdrawn');
  assert.deepEqual(events(journal), []);
});

it('mid-stream evidence expiry prevents further audio and settles unknown at the maximum', { timeout: 5000 }, async (t) => {
  const { client, journal } = host(t);
  const doc = speechSettings(), context = settingsContext(doc), received = barrier();
  let resume, clock = NOW;
  const endpoint = await server(t, (req, res) => {
    req.resume(); res.writeHead(200, { 'content-type': 'audio/pcm' }); res.write(Buffer.from([1, 2]));
    resume = () => res.end(Buffer.from([3, 4])); received.resolve();
  });
  const template = doc.provider_templates.find((template) => template.adapter === 'openai-tts');
  const port = createConfiguredSpeechAdapter({ lane: 'tts', settings: doc, context: () => context, budget: client,
    now: () => clock, binding: { account_ref: template.account_ref, secret_ref: template.secret.ref, priceUsage: () => 100 }, fetchImpl: (url, opts) => fetch(endpoint, opts) });
  const stream = port.streamSynthesize(ttsRequest()); assert.deepEqual((await stream.next()).value, Buffer.from([1, 2]));
  await received.promise; clock = '2026-10-01T00:00:00Z'; resume();
  await assert.rejects(stream.next(), (error) => error.reason === 'authority_changed');
  assert.equal(events(journal).at(-1).data.outcome, 'unknown'); assert.equal(events(journal).at(-1).data.charged_micro, 100);
});
