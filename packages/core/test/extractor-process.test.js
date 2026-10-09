import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { createTextExtractor } from '../../../plugins/extract-text/src/index.js';
import { activeExtractorProcessCount } from '../src/extractor-process.js';
import { EXTRACTOR_LIMITS, normalizeExtractorLimits } from '../src/extractor.js';
import { bytes, observeParsers } from '../../../test/extractor-fixtures.js';
const workerURL = new URL('../../../test/fixtures/extractor-failure-child.js', import.meta.url);

test('RSS limits default to 384 MiB and hosts can only lower them', () => {
  assert.equal(EXTRACTOR_LIMITS.maxRssMb, 384);
  assert.equal(normalizeExtractorLimits({ maxRssMb: 512 }).maxRssMb, 384);
  assert.equal(normalizeExtractorLimits({ maxRssMb: 16 }).maxRssMb, 16);
});
for (const mode of ['crash', 'signal', 'heap']) {
  test(`child ${mode} without a result is unreadable limit and releases the slot`, async t => {
    const observed = observeParsers(t);
    const plugin = createTextExtractor({ workerURL, limits: { maxHeapMb: 16 } });
    const result = await plugin.extract(bytes(mode));
    assert.equal(result.status, 'unreadable'); assert.equal(result.reason, 'limit');
    const { code, signal } = await observed.children[0].closed;
    assert.ok(code !== 0 || signal);
    if (mode === 'heap') assert.ok(signal === 'SIGABRT' || code === 134, 'actual V8 heap OOM');
    assert.equal(activeExtractorProcessCount(), 0);
    assert.equal((await createTextExtractor().extract(bytes('Next request'))).text, 'Next request');
  });
}
test('spawn error with no pid settles without close and releases the global slot exactly once', async t => {
  const original = childProcess.fork, child = new EventEmitter();
  child.pid = undefined; child.kill = () => false; child.send = () => {};
  let first = true, timer;
  t.mock.method(childProcess, 'fork', (...args) => {
    if (!first) return original(...args);
    first = false;
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn failed'), { code: 'EAGAIN' })));
    return child;
  });
  syncBuiltinESMExports();
  const work = createTextExtractor().extract(bytes('Spawn failure'));
  const outcome = work.then(() => null, error => error);
  try {
    const error = await Promise.race([outcome, new Promise(resolve => { timer = setTimeout(() => resolve(null), 150); })]);
    assert.equal(error?.code, 'unavailable');
    assert.equal(activeExtractorProcessCount(), 0);
    child.emit('close', null, null);
    assert.equal((await createTextExtractor().extract(bytes('Next request'))).text, 'Next request');
  } finally {
    clearTimeout(timer); child.emit('close', null, null); await outcome;
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});
test('async child exits when its parent IPC disconnects', { timeout: 3000 }, async t => {
  const child = childProcess.fork(workerURL, [], { env: { NODE_NO_WARNINGS: '1' }, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  await new Promise(resolve => {
    child.once('message', resolve); child.send({ type: 'extract', bytes: bytes('disconnect'), limits: {} });
  });
  child.disconnect();
  let timer;
  try {
    assert.deepEqual(await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve('still alive'), 500); })]),
      { code: 1, signal: null });
  } finally { clearTimeout(timer); }
});
