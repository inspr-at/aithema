import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryGuardEvent, watchMemoryGuard } from '../scripts/memory-guard.js';

test('OPS-341 classification requires SIGTERM and the exact browser PID and run', () => {
  const line = '2026-10-15 16:01:00 KILL free=9% SIGTERM chrome pid 123 (aithema-runs/abcdef1234-42)';
  const input = { signal: 'SIGTERM', pid: 123, run: 'aithema-runs/abcdef1234-42', lines: line };
  assert.equal(memoryGuardEvent(input), line);
  for (const change of [{ signal: 'SIGKILL' }, { signal: null }, { pid: 12 }, { pid: 1234 },
    { run: 'aithema-runs/abcdef1234-43' }, { run: 'abcdef1234-42' }, { run: undefined }, { lines: '' },
    { lines: line.replace('KILL free=9%', 'beat free=9%') }]) {
    assert.equal(memoryGuardEvent({ ...input, ...change }), null);
  }
});

test('a delayed OPS log append is reported, while a historical PID/run match is ignored', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ait199-guard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logPath = join(dir, 'mem-guard.log');
  const line = '2026-10-15 16:01:00 KILL free=9% SIGTERM chrome pid 123 (aithema-runs/abcdef1234-42)\n';
  await writeFile(logPath, line);
  const messages = [], child = Object.assign(new EventEmitter(), { pid: 123 });
  watchMemoryGuard({ logPath, report: message => messages.push(message) })(child, 'aithema-runs/abcdef1234-42');
  child.emit('exit', null, 'SIGTERM');
  assert.deepEqual(messages, [], 'the old identical PID/run must not classify this exit');
  await appendFile(logPath, line);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^Error: infra: memory guard/u);
});
