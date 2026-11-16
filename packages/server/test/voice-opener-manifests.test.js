import { test } from 'node:test';
import assert from 'node:assert/strict';
const manifests = [
  ['../../../plugins/elevenlabs/src/manifest.js', true],
  ['../../../plugins/grok-voice/src/manifest.js', false],
  ['../../../plugins/voxtral/src/manifest.js', false],
  ['../../../plugins/composed-voice/src/manifest.js', false],
  ['../src/composed/manifest.js', false],
  ['../src/dev/local-voice-manifest.js', true],
  ['../../../plugins/fake-voice/src/manifest.js', true],
];
for (const [path, expected] of manifests) test(`AIT-537: first-party opener capability ${path}`, async () => {
  const { manifest } = await import(path);
  assert.equal(Object.hasOwn(manifest.liveVoice.capabilities, 'opener'), true);
  assert.equal(manifest.liveVoice.capabilities.opener, expected);
});
