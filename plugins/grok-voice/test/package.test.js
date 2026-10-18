import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateManifest } from '@inspr/aithema-core/plugins';
import { config, operation } from './fixtures.js';

test('supported entrypoints import offline; manifest is strict; coordinator is public', async () => {
  const [{ manifest }, components, server, client, coordinator] = await Promise.all([
    import('@inspr/aithema-plugin-grok-voice/manifest'), import('@inspr/aithema-plugin-grok-voice/components'),
    import('@inspr/aithema-plugin-grok-voice/server'), import('@inspr/aithema-plugin-grok-voice/client'),
    import('@inspr/aithema-server/composed-voice'),
  ]);
  assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] });
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.deepEqual(manifest.kinds, ['stt', 'tts']); assert.equal(client.manifest, manifest);
  assert.equal(typeof components.createGrokSTT, 'function'); assert.equal(typeof components.createGrokTTS, 'function');
  assert.equal(typeof server.createGrokComponents, 'function');
  assert.equal(typeof coordinator.createComposedVoiceCoordinator, 'function');
  const pkg = JSON.parse(await readFile(new URL('../../../packages/server/package.json', import.meta.url)));
  assert.ok(!pkg.files.includes('!src/composed-voice.js'));
});
test('Grok STT + TTS preflight passes offline and blocks mismatches before claims', async () => {
  const { createGrokComponents } = await import('@inspr/aithema-plugin-grok-voice/server');
  let secrets = 0, transports = 0;
  const ports = { config, enabled: true, resolveSecret() { secrets++; }, connect() { transports++; } };
  const selected = createGrokComponents(ports);
  await selected.preflight;
  assert.equal(selected.outputFormat, 'pcm_s16le'); assert.equal(selected.outputAudioFormat.sampleRateHz, 24000);
  for (const [role, format] of [['capture', { encoding: 'pcm_s16le', sampleRateHz: 24000, channels: 1 }],
    ['playback', { encoding: 'mp3', sampleRateHz: 24000, channels: 1 }]]) {
    const bad = createGrokComponents({ ...ports, composition: { capture: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 },
      playback: selected.outputAudioFormat, languages: ['de', 'en'], voice: 'eve', [role]: format } });
    await assert.rejects(bad.preflight, { code: `composition-${role}-format` });
    const op = operation();
    await assert.rejects(async () => { for await (const bytes of bad.tts.speak({ text: 'Hello', voice: 'eve', format: 'pcm_s16le' }, op.options)) assert.fail(String(bytes)); }, { code: `composition-${role}-format` });
    assert.equal(op.consumed, 0); assert.equal(op.reports.length, 0);
  }
  assert.equal(secrets, 0); assert.equal(transports, 0);
});

test('package publication remains deferred to package 8 and imports use supported subpaths', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.private, true);
  assert.deepEqual(Object.keys(pkg.dependencies), ['@inspr/aithema-core']);
  for (const file of ['server', 'components', 'configuration', 'manifest', 'stt', 'tts', 'client']) {
    const source = await readFile(new URL(`../src/${file}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s+['"]\.\.\//u);
    assert.doesNotMatch(source, /composed-voice\/src|process\.env|fetch\(/u);
  }
  const coordinator = await readFile(new URL('../../../packages/server/src/voice-coordinator.js', import.meta.url), 'utf8');
  assert.doesNotMatch(coordinator, /plugins\/|aithema-plugin|\.\.\//u);
});
