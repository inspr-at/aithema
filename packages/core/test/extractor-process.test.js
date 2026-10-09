import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { createTextExtractor } from '../../../plugins/extract-text/src/index.js';
import { activeExtractorProcessCount } from '../src/extractor-process.js';
import { EXTRACTOR_LIMITS, normalizeExtractorLimits } from '../src/extractor.js';
import { bytes, observeParsers } from '../../../test/extractor-fixtures.js';
const workerURL = new URL('../../../test/fixtures/extractor-failure-child.js', import.meta.url);

async function linuxSampler(t, suffix) {
  // Simulate a systemd unit without getconf; no real command may run in these tests.
  const original = childProcess.execFile;
  const commands = t.mock.fn((...args) => {
    queueMicrotask(() => args.at(-1)(Object.assign(new Error('Command unavailable'), { code: 'ENOENT' })));
    return new EventEmitter();
  });
  // A plain replacement avoids execFile's custom promisify wrapper retaining the real command.
  childProcess.execFile = commands;
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFile = original; t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { residentBytes } = await import(`../src/extractor-process.js?${suffix}`);
  return { sample: (pid, readProc) => residentBytes(pid, { platform: 'linux', readProc }), commands };
}

test('Linux RSS uses only VmRSS from proc status in kB without executing commands', async t => {
  const { sample, commands } = await linuxSampler(t, 'linux-status'), reads = [];
  const rss = await sample(421, async (path, encoding) => {
    reads.push([path, encoding]);
    return 'Name:\tparser\nVmSize:\t999999 kB\nVmHWM:\t65536 kB\nVmRSS:\t12345 kB\nRssAnon:\t12000 kB\n';
  });
  assert.equal(rss, 12345 * 1024);
  assert.deepEqual(reads, [['/proc/421/status', 'utf8']]);
  assert.equal(commands.mock.callCount(), 0);
});

test('Linux RSS recovers on the next sample after the first proc read rejects', async t => {
  const { sample, commands } = await linuxSampler(t, 'linux-recovery');
  const reads = [];
  const readProc = async path => {
    reads.push(path);
    if (reads.length === 1) throw Object.assign(new Error('Temporary proc failure'), { code: 'EACCES' });
    return 'VmRSS:\t8192 kB\n';
  };
  await assert.rejects(sample(422, readProc), { code: 'EACCES' });
  assert.equal(await sample(422, readProc), 8 * 1024 * 1024);
  assert.deepEqual(reads, ['/proc/422/status', '/proc/422/status']);
  assert.equal(commands.mock.callCount(), 0);
});

test('Linux RSS rejects missing, malformed and unsafe VmRSS values', async t => {
  const { sample } = await linuxSampler(t, 'linux-invalid');
  for (const status of ['VmSize: 1024 kB\n', 'VmRSS: -1 kB\n', 'VmRSS: 1.5 kB\n',
    'VmRSS: 1024 MB\n', 'VmRSS: 9007199254740992 kB\n']) {
    await assert.rejects(sample(423, async () => status), /Invalid RSS/u);
  }
  assert.equal(await sample(423, async () => 'VmRSS: 0 kB\n'), 0);
});

test('macOS watchdog skips ticks while ps is pending and resumes after completion', { timeout: 3000 }, async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalExecFile = childProcess.execFile;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const child = new EventEmitter(), callbacks = [];
  Object.assign(child, { pid: 424, exitCode: null, signalCode: null, killed: false, send() {},
    kill() {
      child.killed = true; child.signalCode = 'SIGKILL';
      queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      return true;
    } });
  t.mock.method(childProcess, 'fork', () => child);
  const execFile = (command, args, options, callback) => {
    assert.equal(command, '/bin/ps');
    assert.deepEqual(args, ['-o', 'rss=', '-p', '424']);
    callbacks.push(callback);
    return new EventEmitter();
  };
  execFile[promisify.custom] = (...args) => new Promise((resolve, reject) => {
    execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  childProcess.execFile = execFile;
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let outcome;
  try {
    const { runExtractorProcess } = await import('../src/extractor-process.js?macos-pending');
    outcome = runExtractorProcess(workerURL, bytes('pending'), 'text/plain', normalizeExtractorLimits(),
      { signal: new AbortController().signal, deadlineAt: Date.now() + 60_000 })
      .then(result => ({ result }), error => ({ error }));
    await Promise.resolve();
    assert.equal(callbacks.length, 1, 'initial sample starts immediately');
    t.mock.timers.tick(100);
    assert.equal(callbacks.length, 1, 'pending ps prevents overlapping samples');
    callbacks[0](null, '1024\n', '');
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(25);
    assert.equal(callbacks.length, 2, 'sampling resumes once ps completes');
    callbacks[1](new Error('ps failed'));
    assert.equal((await outcome).error?.code, 'unavailable');
    assert.equal(child.killed, true, 'a failed sample still fails closed');
  } finally {
    child.emit('close', 0, null);
    for (const callback of callbacks) callback(null, '1024\n', '');
    await outcome;
    childProcess.execFile = originalExecFile;
    t.mock.restoreAll(); syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', descriptor);
  }
});

test('RSS limits default to 384 MiB and hosts can only lower them', () => {
  assert.equal(EXTRACTOR_LIMITS.maxRssMb, 384);
  assert.equal(normalizeExtractorLimits({ maxRssMb: 512 }).maxRssMb, 384);
  assert.equal(normalizeExtractorLimits({ maxRssMb: 16 }).maxRssMb, 16);
});
for (const mode of ['crash', 'signal', 'heap']) {
  test(`child ${mode} without a result is unreadable limit and releases the slot`, async t => {
    const observed = observeParsers(t);
    const warnings = t.mock.method(console, 'warn', () => {});
    const plugin = createTextExtractor({ workerURL, limits: { maxHeapMb: 16 } });
    const result = await plugin.extract(bytes(mode));
    assert.equal(result.status, 'unreadable'); assert.equal(result.reason, 'limit');
    const { code, signal } = await observed.children[0].closed;
    assert.ok(code !== 0 || signal);
    if (mode === 'heap') assert.ok(signal === 'SIGABRT' || code === 134, 'actual V8 heap OOM');
    assert.deepEqual(warnings.mock.calls.map(call => call.arguments), [
      ['Extractor child exited without a result; treating as limit', { code, signal }],
    ]);
    assert.equal(activeExtractorProcessCount(), 0);
    assert.equal((await createTextExtractor().extract(bytes('Next request'))).text, 'Next request');
    assert.equal(warnings.mock.callCount(), 1, 'normal result cleanup does not log a crash');
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
