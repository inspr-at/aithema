import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { INITIAL_ERROR_CAUSES, recordInitialErrorWire } from '../../../test/voice-initial-error-wire.js';

const callbacks = [];
for (const cause of INITIAL_ERROR_CAUSES) {
  test(`main 92dc507 capture: ${cause}`, async t => {
    const result = await recordInitialErrorWire(t, cause, (turns, context, execute) => turns.run(context, execute));
    assert.equal(result.wire.status, 200);
    assert.match(result.wire.body, /^data: \{"id":/u);
    assert.equal(result.operation.state, 'failed');
    assert.equal(result.finishes, 1);
    callbacks.push({ cause, response: result.wire });
  });
}
test('write main 92dc507 capture', async () => {
  assert.equal(callbacks.length, 5);
  await writeFile(`${process.env.AITHEMA_EVIDENCE_DIR}/elevenlabs-initial-errors-92dc507.json`,
    JSON.stringify({ baseline: '92dc507', sanitization: 'synthetic inputs; generated reply UUID only', callbacks }, null, 2) + '\n');
});
