import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runElevenLabsReply } from '../src/reply.js';
import { INITIAL_ERROR_CAUSES, recordInitialErrorWire } from '../../../test/voice-initial-error-wire.js';

// Captured on mbp2606 from main 92dc507, capture commit 02cd3f2.
// This is a separate error fixture; elevenlabs-wire.json is never regenerated.
const baseline = JSON.parse(await readFile(new URL('../../../test/fixtures/elevenlabs-initial-errors-92dc507.json', import.meta.url), 'utf8'));
for (const cause of INITIAL_ERROR_CAUSES) {
  test(`AIT-102: pinned main pre-first-frame ${cause} bytes`, async t => {
    const result = await recordInitialErrorWire(t, cause, runElevenLabsReply);
    assert.equal(result.admissions, 1);
    assert.equal(result.finishes, 1);
    assert.equal(result.reports.length, 1);
    assert.equal(result.completions, 0);
    assert.equal(result.operation.state, 'failed');
    assert.equal(result.operation.replyRef, undefined);
    assert.deepEqual(result.wire, baseline.callbacks.find(c => c.cause === cause).response);
  });
}
