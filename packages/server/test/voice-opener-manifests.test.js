import { test } from 'node:test';
import assert from 'node:assert/strict';
const manifests = [
  ['elevenlabs', () => import('../../../plugins/elevenlabs/src/manifest.js'), true],
  ['grok-voice', () => import('../../../plugins/grok-voice/src/manifest.js'), false],
  ['voxtral', () => import('../../../plugins/voxtral/src/manifest.js'), false],
  ['composed-voice', () => import('../../../plugins/composed-voice/src/manifest.js'), false],
  ['host-composed', () => import('../src/composed/manifest.js'), false],
  ['dev-local', () => import('../src/dev/local-voice-manifest.js'), true],
  ['fake-voice', () => import('../../../plugins/fake-voice/src/manifest.js'), true],
];
for (const [name, load, expected] of manifests) test(`AIT-537: first-party opener capability ${name}`, async () => {
  const { manifest } = await load();
  assert.equal(Object.hasOwn(manifest.liveVoice.capabilities, 'opener'), true);
  assert.equal(manifest.liveVoice.capabilities.opener, expected);
});
