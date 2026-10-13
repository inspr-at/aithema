import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { recordVoiceWire } from '../../../test/voice-wire-fixtures.js';

test('AIT-102: current callback, SSE, minting and reconciliation wire baseline', { timeout: 15_000 }, async () => {
  const actual = `${JSON.stringify(await recordVoiceWire(), null, 2)}\n`;
  const path = new URL('../../../test/fixtures/elevenlabs-wire.json', import.meta.url);
  let expected;
  try { expected = await readFile(path, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT' || !process.env.AITHEMA_EVIDENCE_DIR) throw error;
    await writeFile(`${process.env.AITHEMA_EVIDENCE_DIR}/elevenlabs-wire.json`, actual);
    return; // Initial capture commit only; removed once the remote baseline is saved.
  }
  assert.equal(actual, expected, 'wire bytes differ from main 550b4de');
});
