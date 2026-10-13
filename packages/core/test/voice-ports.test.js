import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertVoicePorts, assertVoiceEvent, assertVoiceMediaGrant, assertComponentUsage, LIVE_VOICE_EVENTS } from '../src/live-voice.js';
import { validateManifest, PluginRegistry } from '../src/plugins.js';
import { manifest } from '../../../plugins/elevenlabs/src/manifest.js';

test('AIT-102: legacy and composition declarations typecheck, including waiting', { timeout: 30_000 }, async () => {
  const compiler = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));
  const fixture = fileURLToPath(new URL('../../../test/types/voice-ports.ts', import.meta.url));
  await promisify(execFile)(process.execPath, [compiler, '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', fixture], { timeout: 25_000 });
});

test('AIT-102: waiting and optional ports preserve legacy plugin registration', () => {
  assert.ok(LIVE_VOICE_EVENTS.includes('waiting'));
  assert.doesNotThrow(() => assertVoiceEvent({ type: 'waiting', callId: 'call' }));
  const old = structuredClone(manifest); delete old.liveVoice.ownership;
  assert.equal(validateManifest(old).ok, true);
  assert.equal(validateManifest(manifest).ok, true);
  assert.doesNotThrow(() => new PluginRegistry().register({ manifest: old, start() {}, health() {} }));
  assert.deepEqual(assertVoicePorts({}), {});
  for (const ports of [{ serverAdapter: {} }, { browserMedia: {} }, { replyExecutor: {} }, { components: { stt: {} } }, { components: { tts: {} } }]) {
    assert.throws(() => assertVoicePorts(ports), TypeError);
    assert.throws(() => new PluginRegistry().register({ manifest: old, start() {}, health() {}, ports }), TypeError);
  }
  const invalid = structuredClone(manifest); invalid.liveVoice.ownership.stt = 'native';
  assert.equal(validateManifest(invalid).ok, false);
  invalid.liveVoice.ownership.stt = 'provider'; invalid.liveVoice.optionalCapabilities = { transport: 'native' };
  assert.equal(validateManifest(invalid).ok, false);
});

test('AIT-102: grants expire and component usage records actual units', () => {
  assert.doesNotThrow(() => assertVoiceMediaGrant({ callId: 'call', providerSessionId: 'generation', expiresAt: 200, opaque: {} }, 100));
  assert.throws(() => assertVoiceMediaGrant({ callId: 'call', providerSessionId: 'generation', expiresAt: 100, opaque: {} }, 100), { code: 'deadline' });
  assert.throws(() => assertVoiceMediaGrant({ callId: 'call', expiresAt: 200 }, 100), { code: 'invalid-output' });
  const usage = { attemptId: 'attempt', role: 'stt', unit: 'seconds', quantity: 1.5, upstreamMicro: 20, source: 'provider', estimated: false };
  assert.equal(assertComponentUsage(usage), usage);
  for (const override of [{ quantity: NaN }, { quantity: -1 }, { unit: 'invented' }, { upstreamMicro: 0.5 }, { estimated: null }, { attemptId: '' }]) {
    assert.throws(() => assertComponentUsage({ ...usage, ...override }), { code: 'invalid-output' });
  }
});
