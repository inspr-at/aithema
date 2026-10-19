import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '@inspr/aithema-core/plugins';
import { checkBoundaries } from '../../../scripts/check-boundaries.mjs';

const config = { secretRef: 'private:voxtral/fixture', voiceId: 'fixture-voice' };
const collect = async source => { for await (const chunk of source) assert.fail(`Unexpected audio: ${chunk}`); };
function observed() {
  const counters = { claims: 0, secrets: 0, transport: 0, reports: 0 };
  return { counters, ports: { config, enabled: true,
    resolveSecret() { counters.secrets++; throw new Error('Unexpected secret read'); },
    connect() { counters.transport++; throw new Error('Unexpected transport'); },
    fetchImpl() { counters.transport++; throw new Error('Unexpected transport'); } },
  options: { deadlineAt: Date.now() + 1000,
    attempt: { attemptId: 'fixture', claimId: 'fixture', maxMicro: 10000, consume() { counters.claims++; } },
    report() { counters.reports++; } } };
}
const untouched = counters => assert.deepEqual(counters, { claims: 0, secrets: 0, transport: 0, reports: 0 });

test('AIT-329: supported entrypoints preserve component identity and separate live metadata', async () => {
  const [root, components, server, configuration, { manifest, componentManifest }, coordinator] = await Promise.all([
    import('@inspr/aithema-plugin-voxtral'), import('@inspr/aithema-plugin-voxtral/components'),
    import('@inspr/aithema-plugin-voxtral/server'), import('@inspr/aithema-plugin-voxtral/configuration'),
    import('@inspr/aithema-plugin-voxtral/manifest'), import('@inspr/aithema-server/composed-voice'),
  ]);
  assert.equal(root.createVoxtralComponents, server.createVoxtralComponents);
  assert.equal(typeof coordinator.createComposedVoiceCoordinator, 'function');
  assert.equal(typeof configuration.validateVoxtralConfiguration, 'function');
  assert.equal(typeof components.createVoxtralSTT, 'function');
  assert.equal(typeof components.createVoxtralTTS, 'function');
  assert.equal(components.manifest, componentManifest);
  assert.equal(components.createVoxtralSTT().manifest, componentManifest);
  assert.equal(components.createVoxtralTTS().manifest, componentManifest);
  assert.equal(componentManifest.id, 'voxtral');
  assert.deepEqual(componentManifest.kinds, ['stt', 'tts']);
  assert.equal(manifest.id, 'voxtral-voice');
  assert.deepEqual(manifest.kinds, ['live-voice']);
  for (const value of [manifest, componentManifest]) {
    assert.deepEqual(validateManifest(value), { ok: true, errors: [] });
    assert.match(value.presentation.label, /not yet qualified in live use/u);
    assert.ok(value.models.every(model => model.qualification === 'unverified'));
    assert.ok(value.models.every(model => JSON.stringify(model.processingLocations) === '["unverified"]'));
    assert.ok(Object.isFrozen(value));
  }
  assert.equal(manifest.liveVoice.capabilities.heard, 'unavailable');
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.equal(manifest.entrypoints.server, './src/server.js');
  assert.equal(manifest.entrypoints.browser, undefined, 'client assembly belongs to AIT-330');
});

test('AIT-329: private workspace has exact dependencies and keeps the boundary policy', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const version = JSON.parse(await readFile(new URL('../../../release/version.json', import.meta.url))).version;
  const lock = JSON.parse(await readFile(new URL('../../../package-lock.json', import.meta.url)));
  assert.equal(pkg.private, true, 'release inclusion belongs to AIT-339');
  assert.equal(pkg.version, version);
  assert.deepEqual(pkg.dependencies, { '@inspr/aithema-core': version, '@inspr/aithema-server': version });
  assert.deepEqual(lock.packages['plugins/voxtral'].dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages['node_modules/@inspr/aithema-plugin-voxtral'], { resolved: 'plugins/voxtral', link: true });
  assert.deepEqual(checkBoundaries(fileURLToPath(new URL('../../../', import.meta.url))), []);
  for (const file of ['index', 'configuration', 'server', 'manifest']) {
    const source = await readFile(new URL(`../src/${file}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s+['"]\.\.\//u, 'use public package imports for server-only entrypoints');
    assert.doesNotMatch(source, /elevenlabs|composed-voice\/src|process\.env|\bfetch\(/u);
  }
});

test('AIT-329: default preflight negotiates PCM16 capture and float32 playback without effects', async () => {
  const { createVoxtralComponents, STT_FORMAT, TTS_FORMAT } = await import('@inspr/aithema-plugin-voxtral');
  const f = observed(), selected = createVoxtralComponents(f.ports);
  const ready = await selected.preflight;
  assert.deepEqual(ready.capture, STT_FORMAT); assert.deepEqual(ready.playback, TTS_FORMAT);
  assert.equal(ready.voice, config.voiceId);
  assert.equal(selected.outputFormat, 'pcm_f32le'); assert.deepEqual(selected.outputAudioFormat, TTS_FORMAT);
  assert.equal(ready.capabilities.heardPrefix, 'unavailable');
  assert.ok(Object.isFrozen(selected)); untouched(f.counters);
});

for (const role of ['capture', 'playback']) for (const [key, value] of [
  ['encoding', 'mp3'], ['sampleRateHz', 48000], ['channels', 2],
]) test(`AIT-329: ${role} ${key} mismatch blocks every operation before claims and secrets`, async () => {
  const { createVoxtralComponents, STT_FORMAT, TTS_FORMAT } = await import('@inspr/aithema-plugin-voxtral');
  const f = observed(), composition = { capture: { ...STT_FORMAT }, playback: { ...TTS_FORMAT }, languages: ['de', 'en'], voice: config.voiceId };
  composition[role][key] = value;
  const selected = createVoxtralComponents({ ...f.ports, composition }), code = `composition-${role}-format`;
  await assert.rejects(selected.preflight, { code });
  await assert.rejects(selected.stt.transcribe({}, f.options), { code });
  await assert.rejects(collect(selected.stt.stream({}, f.options)), { code });
  await assert.rejects(collect(selected.tts.speak({}, f.options)), { code });
  untouched(f.counters);
});

for (const voice of ['', ' ', 'other-voice', 'fixture-voice\n', null]) test(`AIT-329: composition voice ${JSON.stringify(voice)} rejects before claims or secrets`, async () => {
  const { createVoxtralComponents, STT_FORMAT, TTS_FORMAT } = await import('@inspr/aithema-plugin-voxtral');
  const f = observed(), selected = createVoxtralComponents({ ...f.ports,
    composition: { capture: STT_FORMAT, playback: TTS_FORMAT, languages: ['de', 'en'], voice } });
  await assert.rejects(selected.preflight, { code: 'composition-voice-invalid' });
  await assert.rejects(selected.stt.transcribe({}, f.options), { code: 'composition-voice-invalid' });
  await assert.rejects(collect(selected.tts.speak({}, f.options)), { code: 'composition-voice-invalid' });
  untouched(f.counters);
});

for (const patch of [
  { secretRef: undefined }, { secretRef: 'literal-key' }, { apiKey: 'synthetic-forbidden' },
  { voiceId: '' }, { voiceId: ' voice ' }, { voiceId: 'voice\n' },
  { sttFormat: { encoding: 'mp3', sampleRateHz: 16000, channels: 1 } },
  { ttsFormat: { encoding: 'pcm_s16le', sampleRateHz: 24000, channels: 1 } },
  { languages: ['xx'] }, { languages: [] }, { languages: ['en', 'en'] },
  { endpoint: 'http://invalid.test' }, { endpoint: 'https://invalid.test/path' },
]) test(`AIT-329: invalid private configuration ${JSON.stringify(patch)} is pure`, async () => {
  const { createVoxtralComponents, validateVoxtralConfiguration } = await import('@inspr/aithema-plugin-voxtral');
  const f = observed(), input = { ...config, ...patch };
  assert.throws(() => validateVoxtralConfiguration(input), TypeError);
  assert.throws(() => createVoxtralComponents({ ...f.ports, config: input }), TypeError);
  untouched(f.counters);
});

for (const [role, input, code] of [
  ['stt', { audio: new Uint8Array(2), format: 'mp3' }, 'composition-capture-format'],
  ['tts', { text: 'Hello', voice: 'other-voice', format: 'pcm_f32le' }, 'composition-voice-invalid'],
  ['tts', { text: 'Hello', format: 'pcm_s16le' }, 'composition-playback-format'],
]) test(`AIT-329: invocation ${code} cannot bypass a successful preflight`, async () => {
  const { createVoxtralComponents } = await import('@inspr/aithema-plugin-voxtral');
  const f = observed(), selected = createVoxtralComponents(f.ports); await selected.preflight;
  if (role === 'stt') {
    await assert.rejects(selected.stt.transcribe(input, f.options), { code });
    await assert.rejects(collect(selected.stt.stream(input, f.options)), { code });
  } else await assert.rejects(collect(selected.tts.speak(input, f.options)), { code });
  untouched(f.counters);
});

test('AIT-329: configuration snapshots mutable input and rejects inline secrets', async () => {
  const { validateVoxtralConfiguration, STT_FORMAT, TTS_FORMAT } = await import('@inspr/aithema-plugin-voxtral');
  const input = { ...config, sttFormat: { ...STT_FORMAT }, ttsFormat: { ...TTS_FORMAT }, languages: ['de', 'en'] };
  const saved = validateVoxtralConfiguration(input);
  input.sttFormat.sampleRateHz = 48000; input.languages.pop();
  assert.deepEqual(saved.sttFormat, STT_FORMAT); assert.deepEqual(saved.languages, ['de', 'en']);
  assert.ok(Object.isFrozen(saved)); assert.ok(Object.isFrozen(saved.sttFormat)); assert.ok(Object.isFrozen(saved.languages));
});
