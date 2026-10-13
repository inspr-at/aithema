import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { recordVoiceWire, VOICE_WIRE_EPOCH } from '../../../test/voice-wire-fixtures.js';

test('AIT-102: current callback, SSE, minting and reconciliation wire baseline', { timeout: 15_000 }, async t => {
  // Keep actual operation deadlines on the same clock as the injected facade
  // timestamp; otherwise the fixed epoch eventually overflows a real timer.
  t.mock.method(Date, 'now', () => VOICE_WIRE_EPOCH);
  const actual = `${JSON.stringify(await recordVoiceWire(), null, 2)}\n`;
  const path = new URL('../../../test/fixtures/elevenlabs-wire.json', import.meta.url);
  const expected = await readFile(path, 'utf8');
  assert.equal(actual, expected, 'wire bytes differ from main 550b4de');
});
