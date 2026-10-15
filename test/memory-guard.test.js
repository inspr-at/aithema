import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryGuardEvent } from '../scripts/memory-guard.js';

test('OPS-341 classification requires SIGTERM and the exact browser PID and run', () => {
  const line = '2026-10-15 16:01:00 KILL free=9% SIGTERM chrome pid 123 (aithema-runs/abcdef1234-42)';
  const input = { signal: 'SIGTERM', pid: 123, run: 'aithema-runs/abcdef1234-42', lines: line };
  assert.equal(memoryGuardEvent(input), line);
  for (const change of [{ signal: 'SIGKILL' }, { signal: null }, { pid: 12 }, { pid: 1234 },
    { run: 'aithema-runs/abcdef1234-43' }, { run: undefined }, { lines: '' },
    { lines: line.replace('KILL free=9%', 'beat free=9%') }]) {
    assert.equal(memoryGuardEvent({ ...input, ...change }), null);
  }
});
